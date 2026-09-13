'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { spawn } = require('node:child_process');
const pe = require('../core/pe');
const { noLinks, inside, digestFile, assertLaunchNotCancelled } = require('./launch-safety');
const { addonValues } = require('./reshade-layout');
const { same } = require('./game-processes');
const { INSTALLED_NAMES } = require('./constants');
const { resolveAddonLoadState, readRegisteredName } = require('./addon-loading-layout');
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REQUIRED_NAMES = { core: INSTALLED_NAMES.addon, chain: INSTALLED_NAMES.bridge, 'nr-runtime': INSTALLED_NAMES.runtime,
  carrier: INSTALLED_NAMES.carrier, reshade: 'ReShade64.dll' };
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: `HELPER_${code}`, details }); };

async function inspectModules({ directory, configPath, modules, api, inputRoute = 'native', getBitness = pe.getBitness }) {
  if (!path.isAbsolute(directory || '') || !path.isAbsolute(configPath || '') || !inside(directory, configPath)) fail('CONFIG_PATH', '活跃配置不在受管外置目录中。');
  await noLinks(configPath);
  const bytes = await fs.readFile(configPath);
  if (bytes.length > 1024 * 1024) fail('CONFIG_INVALID', 'ReShade 配置过大。');
  let config; try { config = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('CONFIG_INVALID', 'ReShade 配置不是有效 UTF-8。'); }
  const values = addonValues(config), disabledValues = values.get('DisabledAddons') || [];
  const addonPath = values.get('AddonPath')?.[0] || '.';
  const active = path.resolve(path.dirname(configPath), addonPath);
  const early = (values.get('LoadFromDllMain') || []).map(name => path.resolve(active, name));
  if (early.length > 128 || !inside(directory, active) || early.some(file => !inside(directory, file))) fail('CONFIG_PATH', '插件搜索或显式加载路径离开受管配置目录。');
  const requiredRoles = ['core', 'chain', 'nr-runtime', 'reshade', ...(inputRoute === 'feeder' ? ['provider'] : api === 'dx11' ? ['carrier'] : [])];
  const rows = [], seen = new Set();
  for (const module of modules || []) {
    if (!module || typeof module.path !== 'string' || !path.isAbsolute(module.path) || !inside(directory, module.path) || !HASH.test(module.sha256 || ''))
      fail('MODULE_MANIFEST', '组件清单含未验证的路径或摘要。');
    const name = path.basename(module.path);
    if (!/\.(?:dll|addon64)$/i.test(name) || seen.has(name.toLowerCase())) fail('MODULE_MANIFEST', '组件允许清单含重复或无效模块名称。');
    seen.add(name.toLowerCase());
    const row = { name, path: module.path, role: module.role, expectedSha256: module.sha256, expectedArchitecture: 'x64', required: requiredRoles.includes(module.role) };
    try {
      await noLinks(module.path);
      row.sha256 = await digestFile(module.path);
      row.architecture = ['x64', 64].includes(getBitness(module.path)) ? 'x64' : 'unknown';
      const explicit = early.some(file => same(file, module.path));
      const searched = same(path.dirname(module.path), active) && ['.addon', '.addon64'].includes(path.extname(name));
      const registeredName = searched || explicit ? await readRegisteredName(module.path) : null;
      const loading = resolveAddonLoadState({ name, registeredName, searched, explicit, architecture: row.architecture, disabledValues });
      Object.assign(row, loading, { registeredName });
      if (module.name && name !== module.name || module.role === 'reshade' && name !== 'ReShade64.dll') row.status = 'path-mismatch';
      else if (!row.sha256) row.status = 'missing';
      else if (!searched && !explicit && /\.addon(?:64)?$/i.test(name)) row.status = 'path-mismatch';
      else if (row.sha256 !== module.sha256 || row.architecture !== 'x64' || module.architecture != null && !['x64', 64].includes(module.architecture)) row.status = 'version-mismatch';
      else if (loading.registrationDisabled || loading.filenameDisabled && !explicit) row.status = 'disabled';
      else row.status = 'enabled';
    } catch (error) { row.status = 'unavailable'; row.reason = error.message; }
    rows.push(row);
  }
  // ReShade discovers every Add-on in the active directory, so a newly added
  // file must first become part of an explicitly applied deployment record.
  for (const entry of await fs.readdir(active, { withFileTypes: true }).catch(() => [])) {
    if (['.addon', '.addon64'].includes(path.extname(entry.name)) && !seen.has(entry.name.toLowerCase())) rows.push({ name: entry.name,
      path: path.join(active, entry.name), role: 'unlisted-addon', status: 'path-mismatch', required: true, reason: '插件未包含在本次受管允许清单中。' });
  }
  for (const file of early) if (!(modules || []).some(row => same(row.path, file))) rows.push({ name: path.basename(file), path: file,
    role: 'unlisted-explicit', status: 'path-mismatch', required: true, reason: '显式早期加载项未包含在本次受管允许清单中。' });
  const missingRoles = requiredRoles.filter(role => !rows.some(row => row.role === role));
  return { modules: rows, missingRoles, configHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    ready: missingRoles.length === 0 && rows.every(row => row.status === 'enabled' || !row.required && row.status === 'disabled') };
}

function createLoadingHelper(options) {
  const startProcess = options.spawn || spawn, getBitness = options.getBitness || pe.getBitness;
  const sessions = new Set();
  const resources = options.resourcesPath || path.join(options.appDir || path.resolve(__dirname, '../..'), 'resources');
  const directory = path.join(resources, 'loading-helper');
  const timeoutMs = options.readyTimeoutMs || 30000;
  async function moduleManifest(id, layout, inspection = {}) {
    const base = layout.moduleManifest || inspection.moduleManifest || [], additional = options.additionalModules ? await options.additionalModules(id) : [];
    if (!Array.isArray(base) || !Array.isArray(additional) || base.length + additional.length > 256) fail('MODULE_MANIFEST', '组件所有者没有提供有效的有界允许清单。');
    const merged = new Map();
    for (const row of [...base, ...additional]) {
      if (!row || !path.isAbsolute(row.path || '') || !HASH.test(row.sha256 || '')) fail('MODULE_MANIFEST', '组件所有者的路径或摘要无效。');
      const key = path.resolve(row.path).toLowerCase(), current = merged.get(key);
      if (current && (current.sha256 !== row.sha256 || current.name && row.name && current.name.toLowerCase() !== row.name.toLowerCase()))
        fail('MODULE_OWNER_CONFLICT', '多个组件所有者对同一文件记录了不同身份；未选用磁盘现值覆盖记录。', { path: row.path });
      if (!current) merged.set(key, { ...row });
      else if (row.role === 'mfgunlock') merged.set(key, { ...current, role: row.role, owner: row.owner });
    }
    return [...merged.values()];
  }
  async function prepare(input) {
    if (!UUID.test(input?.sessionId || '') || !path.isAbsolute(input?.targetExe || '')) fail('REQUEST', '助手请求缺少本次会话与目标 EXE。');
    const layout = await options.getLayout(input.gameId), inspection = await options.inspectDeployment(input.gameId);
    if (layout.mode !== 'external' || layout.loadingMode !== 'helper' || layout.verified !== true || layout.needsRecovery || inspection.needsRecovery || inspection.ready === false)
      fail('DEPLOYMENT', '请先应用完整的外置助手部署，并恢复未完成操作。');
    if (!same(layout.exe, input.targetExe) || !path.isAbsolute(layout.loaderPath || '') || !inside(layout.runtimeDir, layout.loaderPath) || !same(path.basename(layout.loaderPath), 'ReShade64.dll'))
      fail('DEPLOYMENT_IDENTITY', '助手目标与受管外置部署不一致。');
    const manifestPath = path.join(directory, 'component.json'); await noLinks(manifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest?.version !== 1 || manifest.id !== 'dlss5-loading-helper' || manifest.file !== 'dlss5-load-helper.exe' || !HASH.test(manifest.sha256 || '') ||
        manifest.protocol !== 1 || manifest.architecture !== 'x64' || !['ordinary-user', 'ordinary-default/explicit-same-user-admin'].includes(manifest.policy?.privilege) ||
        manifest.policy?.privilege !== 'ordinary-user' && manifest.policy?.elevatedRoute !== 'hoyoshade-only' ||
        manifest.policy?.terminateGame !== false || manifest.policy?.cleanupGameFiles !== false || manifest.policy?.protectionBypass !== false) fail('RESOURCE', '助手组件清单无效。');
    const executable = path.join(directory, manifest.file); await noLinks(executable);
    if (await digestFile(executable) !== manifest.sha256 || !['x64', 64].includes(getBitness(executable))) fail('RESOURCE', '助手文件与固定配套摘要或位数不一致。');
    const modules = await moduleManifest(input.gameId, layout, inspection);
    const allowed = await inspectModules({ directory: layout.runtimeDir, configPath: layout.activeConfigPath, modules, api: layout.api, inputRoute: layout.inputRoute || layout.hoyoProfile?.inputRoute, getBitness });
    if (!allowed.ready) fail('MODULES_BLOCKED', '所需插件被禁用、缺失或身份不符；请核对插件允许清单后应用。', allowed);
    const loader = allowed.modules.find(row => same(row.path, layout.loaderPath));
    if (!loader || loader.role !== 'reshade' || loader.status !== 'enabled') fail('LOADER_UNVERIFIED', '加载器没有受管摘要记录。');
    await noLinks(input.targetExe);
    const targetHash = await digestFile(input.targetExe);
    if (!targetHash || !['x64', 64].includes(getBitness(input.targetExe))) fail('TARGET', '助手只支持已经确认的 x64 游戏程序。');
    const elevatedTarget = layout.loadingBackend === 'hoyoshade' &&
      ['requireAdministrator', 'highestAvailable'].includes(require('./game-launch-broker').executionLevel(input.targetExe));
    if (elevatedTarget && (manifest.policy?.privilege !== 'ordinary-default/explicit-same-user-admin' || !require('./hoyoshade-profiles').validHoYoProfile(layout.hoyoProfile, input.targetExe) ||
        !options.isAdministrator || await options.isAdministrator() !== true)) fail('ELEVATED_ROUTE', '此米哈游客户端需要同权限助手，请使用本次专用管理员启动。');
    const session = { gameId: input.gameId, sessionId: input.sessionId, targetExe: input.targetExe, executable, helperSha256: manifest.sha256, targetHash,
      loaderPath: layout.loaderPath, loaderHash: loader.sha256, configPath: layout.activeConfigPath, configHash: allowed.configHash,
      modules: allowed.modules, moduleManifest: modules, api: layout.api, inputRoute: layout.inputRoute || layout.hoyoProfile?.inputRoute,
      directory: layout.runtimeDir, elevatedTarget, waitTimeoutMs: layout.loadingBackend === 'hoyoshade' ? 300000 : 90000,
      state: 'prepared', child: null, error: null, callback: null };
    sessions.add(session); return session;
  }
  function valid(session, event) {
    return event?.version === 1 && event.sessionId === session.sessionId && same(event.targetExe || '.', session.targetExe) &&
      event.configHash === session.configHash && event.helperPid === session.child?.pid && (event.elevatedTarget === true) === session.elevatedTarget;
  }
  async function start(session, controls = {}) {
    assertLaunchNotCancelled(controls);
    if (!sessions.has(session) || session.state !== 'prepared') fail('SESSION', '助手会话无效。');
    // Revalidate immediately before spawn. Ready is accepted solely from this
    // child's private pipe and must carry every bound identity.
    await noLinks(session.executable); await noLinks(session.targetExe);
    const layout = await options.getLayout(session.gameId);
    if (layout.verified !== true || layout.needsRecovery || !same(layout.exe, session.targetExe) || !same(layout.runtimeDir, session.directory) ||
        !same(layout.activeConfigPath, session.configPath) || !same(layout.loaderPath, session.loaderPath)) fail('IDENTITY_CHANGED', '部署布局在助手启动前改变。');
    const modules = await moduleManifest(session.gameId, layout);
    const allowed = await inspectModules({ directory: session.directory, configPath: session.configPath, modules, api: session.api, inputRoute: session.inputRoute, getBitness });
    if (await digestFile(session.executable) !== session.helperSha256 || await digestFile(session.targetExe) !== session.targetHash || !allowed.ready || allowed.configHash !== session.configHash)
      fail('IDENTITY_CHANGED', '助手、目标程序或配置在就绪前改变。');
    assertLaunchNotCancelled(controls);
    const args = ['--session', session.sessionId, '--target', session.targetExe, '--target-sha', session.targetHash,
      '--loader', session.loaderPath, '--loader-sha', session.loaderHash, '--config', session.configPath, '--config-sha', session.configHash, '--timeout', String(session.waitTimeoutMs)];
    if (session.elevatedTarget) args.push('--elevated-target', '1');
    return new Promise((resolve, reject) => {
      let pending = '', bytes = 0, ready = false, settled = false;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const clear = () => { clearTimeout(timer); clearInterval(cancelTimer); };
      const finish = error => {
        if (session.error || session.state === 'stopped') return;
        session.error = error; session.state = 'failed';
        clear();
        if (!settled) { settled = true; reject(error); }
        if (ready) notifyFailure(session);
      };
      const makeError = (code, message) => Object.assign(new Error(message), { code });
      const timer = setTimeout(() => finish(makeError('HELPER_READY_TIMEOUT', '助手未在限定时间内报告就绪。')), timeoutMs);
      const cancelTimer = setInterval(() => { if (controls.cancelled?.() && !ready) finish(makeError('LAUNCH_CANCELLED', '已取消助手等待。')); }, 100);
      session.abort = () => { clear(); if (!settled) { settled = true; reject(makeError('LAUNCH_CANCELLED', '已回收本次等待助手。')); } };
      let child;
      try { child = startProcess(session.executable, args, { cwd: session.directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { finish(makeError('HELPER_START_FAILED', error.message)); return; }
      session.child = child; session.state = 'starting';
      child.stdout.on('data', chunk => {
        if (session.error || session.state === 'stopped') return;
        bytes += chunk.length; if (bytes > 65536) { finish(makeError('HELPER_PROTOCOL', '助手输出超过协议限制。')); return; }
        try { pending += decoder.decode(chunk, { stream: true }); } catch { finish(makeError('HELPER_PROTOCOL', '助手返回无效 UTF-8。')); return; }
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) {
          let event; try { event = JSON.parse(line); } catch { finish(makeError('HELPER_PROTOCOL', '助手返回无效事件。')); return; }
          if (!valid(session, event)) { finish(makeError('HELPER_IDENTITY', '助手事件与本次目标或配置不一致。')); return; }
          if (event.event === 'ready') {
            if (ready || session.state !== 'starting') { finish(makeError('HELPER_PROTOCOL', '助手重复报告就绪。')); return; }
            ready = true; settled = true; session.state = 'ready'; clear();
            resolve({ sessionId: session.sessionId, targetExe: session.targetExe, configHash: session.configHash, helperPid: child.pid });
          } else if (event.event === 'attached' && ready && session.state === 'ready' && Number.isInteger(event.gamePid) && event.gamePid > 0) {
            if (session.expectedGamePid && session.expectedGamePid !== event.gamePid) { finish(makeError('HELPER_PROCESS_IDENTITY', '助手确认的进程与本次启动不一致。')); return; }
            session.state = 'attached'; session.gamePid = event.gamePid;
          } else if (event.event === 'failed') { finish(makeError('HELPER_LOAD_FAILED', `助手加载未完成（Windows ${event.error}）；已保留游戏与外置组件。`)); return; }
          else { finish(makeError('HELPER_PROTOCOL', '助手事件顺序无效。')); return; }
        }
      });
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) finish(makeError('HELPER_PROTOCOL', '助手输出超过协议限制。')); });
      child.on('error', error => finish(makeError('HELPER_START_FAILED', error.message)));
      child.on('close', code => {
        clear();
        if (session.state === 'stopped' || session.error) return;
        try { pending += decoder.decode(); } catch { finish(makeError('HELPER_PROTOCOL', '助手返回不完整 UTF-8。')); return; }
        if (pending.trim()) { finish(makeError('HELPER_PROTOCOL', '助手事件未完整结束。')); return; }
        if (session.state !== 'attached' && session.state !== 'stopped') finish(makeError('HELPER_EXITED', `助手提前退出（${code}），未确认加载完成。`));
        else if (code !== 0) finish(makeError('HELPER_EXITED', `助手加载后异常退出（${code}）。`));
      });
    });
  }
  function alive(session) { return !session || ['ready', 'attached'].includes(session.state); }
  function notifyFailure(session) {
    if (!session.callback || !session.error || session.failureNotified) return;
    session.failureNotified = true;
    return Promise.resolve().then(() => session.callback?.(session.error)).catch(error => { session.notificationError = error.message; });
  }
  async function watch(session, optionsForWatch) {
    if (!session) return;
    session.callback = optionsForWatch.onFailure;
    session.expectedGamePid = optionsForWatch.process?.pid;
    if (session.gamePid && optionsForWatch.process?.pid !== session.gamePid && !session.error) {
      session.error = Object.assign(new Error('助手确认的进程与本次启动不一致。'), { code: 'HELPER_PROCESS_IDENTITY' }); session.state = 'failed';
    }
    await notifyFailure(session);
  }
  async function stop(session, reason) {
    if (!sessions.has(session)) fail('SESSION', '不能回收不属于本次管理器的助手。');
    const child = session.child;
    session.abort?.();
    session.state = 'stopped'; session.callback = null;
    if (child && child.exitCode === null && !child.killed) child.kill();
    return { status: 'stopped', reason, helperPid: child?.pid || null, gamePreserved: true, filesRetained: true };
  }
  async function detach() {
    for (const session of sessions) {
      session.callback = null;
      if (session.state !== 'attached') await stop(session, 'manager-closed');
      else session.child?.unref();
    }
  }
  async function inspect(id) {
    const layout = await options.getLayout(id);
    if (!layout.moduleManifest?.length) return { ready: false, modules: [], detail: '当前没有外置组件允许清单。' };
    const modules = await moduleManifest(id, layout);
    return inspectModules({ directory: layout.runtimeDir, configPath: layout.activeConfigPath, modules, api: layout.api, inputRoute: layout.inputRoute || layout.hoyoProfile?.inputRoute, getBitness });
  }
  return { prepare, start, alive, watch, stop, detach, inspect };
}
module.exports = { createLoadingHelper, inspectHelperModules: inspectModules };
