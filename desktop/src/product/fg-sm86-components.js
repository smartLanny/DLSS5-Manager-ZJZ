'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const journalDefault = require('../core/file-journal');
const peDefault = require('../core/pe');
const { createInstallGuards } = require('../core/install-guards');
const { detectGpuAsync, fgBackend } = require('./gpu');
const { noLinks, atomicJson } = require('./launch-safety');
const { createFgPendingRecovery, hashFile, jsonHash } = require('./fg-pending-recovery');
const { createNativeEnhancementProbe } = require('./native-enhancement-probe');
const config = require('./fg-sm86-config');
const { copyNewFile } = require('./fg-migration-components');

const BACKEND = config.BACKEND, ID = 'dlssg-sm86-0.3.5', PROXY = 'version.dll';
const SOURCE = '9621db573e07ed54f50c15bbb585ed9a7bdfac28';
const PIN = Object.freeze({
  proxy: { name: PROXY, bytes: 30021920, sha256: 'c3934a09399f022504227c72df0bf8c0de55f9a08880dddde898c5262cefa838' },
  config: { name: config.FILE, bytes: 3548, sha256: '2616857ee29ec61e33c8b52e1b50f4c93cb5339adbb13b73f0ae71a722427a43' },
  notices: { name: 'THIRD_PARTY_NOTICES.txt', bytes: 3349, sha256: 'ac3b44ab30a4235edd18feca1ab4f802d57c8d3d0ee4878dc77b81a6b127155f' },
  readme: { name: 'README.md', bytes: 13484, sha256: 'b0dd100acc69f4908bdaa135f97eb15da474c6ed89d74dfccc2481fbe5771b9c' }
});
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const validSupport = support => support?.status === 'supported' && ['native-integration', 'catalog', 'trusted-mod', 'runtime'].includes(support.source);
function supportedMultipliers(evidence) {
  if (!validSupport(evidence?.support)) return [];
  const capability = evidence.support.capabilities?.dlssgSm86;
  return [2, 3, 4, ...(capability?.sixXSupported === true && capability?.gamePluginSupportsSixX === true ? [5, 6] : [])];
}
function createSm86Components(options = {}) {
  const journal = options.journal || journalDefault, pe = options.pe || peDefault;
  const guards = options.guards || createInstallGuards(), assertClosed = options.assertGameClosed || guards.assertGameClosed;
  const antiCheatPresent = options.antiCheatPresent || guards.antiCheatPresent;
  const detectHardware = options.detectHardware || detectGpuAsync, scan = options.scan || (async () => ({}));
  const probe = options.getFeatureEvidence ? null : createNativeEnhancementProbe({ ...options, scan });
  const getEvidence = options.getFeatureEvidence || ((id, domain) => probe.inspect(id, domain));
  // Dependency injection is only a local test seam; IPC never accepts resource pins.
  const pins = options.sm86Definition || PIN;
  const resources = options.sm86ResourcesPath || (fs.existsSync(path.join(options.resourcesPath || '', 'fg-sm86', 'manifest.json'))
    ? path.join(options.resourcesPath, 'fg-sm86') : path.join(options.appDir || '', 'resources', 'fg-sm86'));
  const recovery = createFgPendingRecovery({ journal, assertGameClosed: assertClosed, backend: BACKEND,
    providerLibrary: { knownProviderForHash: hash => hash === pins.proxy.sha256 ? { id: ID, sha256: hash } : null,
      providers: () => [{ id: ID, sha256: pins.proxy.sha256 }] } });
  const undos = new Map();
  const catalog = () => [{ id: ID, version: '0.3.5', backend: BACKEND, label: 'RTX 20/30 DLSS-G 0.3.5', sha256: pins.proxy.sha256 }];
  function target(id) {
    const game = options.gameDirectory(id), exe = options.gameExecutable(id);
    if (!path.isAbsolute(game || '') || !path.isAbsolute(exe || '') || path.extname(exe).toLowerCase() !== '.exe') fail('SETTINGS_FG_TARGET', '游戏 EXE 绑定无效。');
    const relative = path.relative(game, exe);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('SETTINGS_FG_TARGET', '游戏程序不在所选目录内。');
    return { id, game: path.resolve(game), exe: path.resolve(exe), dir: path.dirname(path.resolve(exe)) };
  }
  const receiptFile = t => journal.safePath(t.game, '_DLSS5_Backup/xiaofeng-fg-sm86.json');
  function hasOwnership(id) {
    const t = target(id);
    if (fs.existsSync(receiptFile(t))) return true;
    try { const file = journal.pendingPath(t.game); if (fs.statSync(file).size <= 2 * 1024 * 1024)
      return JSON.parse(fs.readFileSync(file, 'utf8')).owner?.product === 'xiaofeng-fg-sm86'; } catch {}
    return false;
  }
  async function readResources() {
    const file = path.join(resources, 'manifest.json'); await noLinks(file);
    if ((await fsp.stat(file)).size > 64 * 1024) fail('SETTINGS_SM86_RESOURCES', 'SM86 资源清单大小无效。');
    const manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.id !== ID || manifest.backend !== BACKEND || manifest.version !== '0.3.5' ||
        manifest.source?.repository !== 'sdli1995/dlssg_for_sm86' || manifest.source?.commit !== SOURCE)
      fail('SETTINGS_SM86_RESOURCES', 'SM86 资源清单不是固定的 0.3.5 来源。');
    const files = {};
    for (const [role, pin] of Object.entries(pins)) {
      const row = manifest.files?.[role], source = path.join(resources, pin.name);
      if (!row || row.name !== pin.name || row.bytes !== pin.bytes || row.sha256 !== pin.sha256 ||
          (await fsp.stat(source)).size !== pin.bytes || await hashFile(source) !== pin.sha256)
        fail('SETTINGS_SM86_RESOURCES', `SM86 ${pin.name} 与固定分发摘要不符。`);
      files[role] = { ...pin, source };
    }
    if (pe.getBitness(files.proxy.source) !== 64) fail('SETTINGS_SM86_RESOURCES', 'SM86 代理不是 x64。');
    config.values(await fsp.readFile(files.config.source, 'utf8'));
    return { ...manifest, files };
  }
  async function receipt(t) {
    const file = receiptFile(t); await noLinks(file);
    if (!fs.existsSync(file)) return null;
    if ((await fsp.stat(file)).size > 64 * 1024) fail('SETTINGS_SM86_RECEIPT', 'SM86 恢复记录大小无效。');
    const row = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (row.version !== 1 || row.backend !== BACKEND || row.id !== ID || !same(row.exe, t.exe) ||
        !['created', 'adopted'].includes(row.proxy?.mode) || row.proxy.sha256 !== pins.proxy.sha256 ||
        row.proxy.rel !== path.relative(t.game, path.join(t.dir, PROXY)) ||
        !['created', 'existing'].includes(row.config?.mode) || row.config.rel !== path.relative(t.game, path.join(t.dir, config.FILE)) ||
        !/^[a-f0-9]{64}$/.test(row.config.sha256 || '')) fail('SETTINGS_SM86_RECEIPT', 'SM86 恢复记录身份无效。');
    return row;
  }
  async function inspect(id) {
    const t = target(id), hardware = await detectHardware(), observed = await scan(id), blockers = [], conflicts = [];
    const pending = await recovery.inspect(t); let owned = null, resource = null, evidence = null;
    await noLinks(t.exe);
    try { owned = await receipt(t); } catch (error) { conflicts.push(error.message); }
    try { resource = await readResources(); } catch (error) { blockers.push(error.message); }
    if (fgBackend(hardware) !== BACKEND) blockers.push('此配套仅用于已确认的 RTX 20 或 RTX 30。');
    if (pe.getBitness(t.exe) !== 64) blockers.push('此配套需要 x64 游戏程序。');
    if (observed.api !== 'dx12') blockers.push('此配套需要游戏使用 DirectX 12。');
    try { evidence = await getEvidence(id, 'fg'); } catch {}
    if (!validSupport(evidence?.support) || observed.streamlineFg !== true)
      blockers.push('尚未确认所选游戏已有原生 DLSS 帧生成集成；SM86 不会为没有 FG 的游戏添加此功能。');
    const layout = options.getLayout?.(id);
    if (['feeder', 'vulkan'].includes(layout?.source) || layout?.inputRoute === 'feeder') blockers.push('当前输入路线不能与此帧生成配套同时部署。');
    const legacyRoots = [...new Set([t.game, ...(layout?.runtimeDir && path.isAbsolute(layout.runtimeDir) ? [layout.runtimeDir] : [])])];
    for (const root of legacyRoots) for (const name of ['xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json'])
      if (fs.existsSync(path.join(root, '_DLSS5_Backup', name))) conflicts.push('仍有旧补帧组件归属，请先按原后端恢复。');
    for (const name of ['renodx-mfgunlock.addon64', 'RTX40MFGCore.dll', 'RTX40MFG.asi', 'dlssg_to_fsr3_amd_is_better.dll', 'dlssg_to_fsr3.dll'])
      if (fs.existsSync(path.join(t.dir, name))) conflicts.push(`检测到另一帧生成组件 ${name}，未叠加安装。`);
    const proxyFile = path.join(t.dir, PROXY), configFile = path.join(t.dir, config.FILE);
    const proxyHash = await hashFile(proxyFile), configHash = await hashFile(configFile);
    if (proxyHash !== null && proxyHash !== pins.proxy.sha256) conflicts.push('version.dll 已被未知或修改后的文件占用，未覆盖。');
    if (configHash !== null) { try { config.values(await fsp.readFile(configFile, 'utf8')); } catch (error) { conflicts.push(error.message); } }
    const ready = Boolean(owned && proxyHash === pins.proxy.sha256 && configHash !== null && !blockers.length && !conflicts.length && !pending.fileRecoveryPending && !pending.fileOperationActive);
    const canPrepare = !blockers.length && !conflicts.length && !pending.fileRecoveryPending && !pending.fileOperationActive;
    return { backend: BACKEND, id: ID, installedProvider: owned ? ID : null, providerId: ID, route: 'compatibility', hardware,
      ready, installed: Boolean(owned), managed: Boolean(owned), receipt: Boolean(owned), canPrepare,
      needsCleanup: Boolean(owned && fgBackend(hardware) !== BACKEND), legacyNeedsMigration: false, migrationPending: false,
      blockers, conflicts, missing: [proxyHash === null && PROXY, configHash === null && config.FILE].filter(Boolean),
      components: [{ role: 'proxy', name: PROXY, status: proxyHash === pins.proxy.sha256 ? 'ready' : proxyHash ? 'external' : 'missing', owned: owned?.proxy.mode === 'created' }],
      featureEvidence: evidence, availableMultipliers: supportedMultipliers(evidence), defaultMultiplier: 4, optimized: 1,
      catalog: catalog(), defaultProvider: ID, installedProviderDetails: owned ? catalog()[0] : null, canUpgrade: false,
      resourceReady: Boolean(resource), exe: t.exe, api: observed.api, ...pending, runtimeVerified: false };
  }
  async function prepare(id, prepareOptions = {}) {
    const t = target(id), status = await inspect(id);
    if (prepareOptions.providerId && prepareOptions.providerId !== ID) fail('SETTINGS_SM86_PROVIDER', 'SM86 配套版本无效。');
    if (!status.canPrepare) fail('SETTINGS_SM86_BLOCKED', [...status.blockers, ...status.conflicts, status.fileRecoveryBlocker].filter(Boolean).join('\n'), status);
    if (antiCheatPresent(t.game) && prepareOptions.allowAntiCheat !== true) fail('ERR_ANTI_CHEAT_CONFIRM', '请先确认当前游戏的兼容提示。');
    await assertClosed(t.game, t.exe);
    if (status.ready) return { prepared: true, changed: false, backend: BACKEND, runtimeVerified: false };
    const resource = await readResources(), prior = await receipt(t), receiptBefore = await hashFile(receiptFile(t));
    const files = [path.join(t.dir, PROXY), path.join(t.dir, config.FILE)];
    const before = await Promise.all(files.map(hashFile));
    const priorText = receiptBefore ? await fsp.readFile(receiptFile(t), 'utf8') : null;
    const next = { version: 1, backend: BACKEND, id: ID, exe: t.exe,
      proxy: prior?.proxy || { rel: path.relative(t.game, files[0]), mode: before[0] === null ? 'created' : 'adopted', sha256: pins.proxy.sha256 },
      config: prior?.config || { rel: path.relative(t.game, files[1]), mode: before[1] === null ? 'created' : 'existing', sha256: before[1] || pins.config.sha256 } };
    const token = crypto.randomUUID(), expected = [pins.proxy.sha256, before[1] || pins.config.sha256];
    const result = await recovery.transaction(t, 'prepare', async () => {
      await assertClosed(t.game, t.exe);
      if (await hashFile(receiptFile(t)) !== receiptBefore) fail('SETTINGS_SM86_CHANGED', 'SM86 收据在准备前改变。');
      for (let i = 0; i < files.length; i++) {
        if (await hashFile(files[i]) !== before[i]) fail('SETTINGS_SM86_CHANGED', 'SM86 文件在准备前改变。');
        if (before[i] !== null) continue;
        const source = resource.files[i === 0 ? 'proxy' : 'config'].source;
        await recovery.capture(t, files[i], expected[i]);
        await copyNewFile({ journal, game: t.game, source, dest: files[i], copyFile: options.copyFile });
        if (await hashFile(files[i]) !== expected[i]) fail('SETTINGS_SM86_WRITE', 'SM86 文件复制校验失败。');
      }
      await recovery.capture(t, receiptFile(t), jsonHash(next)); await (options.writeReceipt || atomicJson)(receiptFile(t), next);
      if (await hashFile(receiptFile(t)) !== jsonHash(next)) fail('SETTINGS_SM86_WRITE', 'SM86 收据写入校验失败。');
      return { prepared: true, changed: true, backend: BACKEND, id: ID, providerId: ID, route: 'compatibility',
        created: files.filter((_file, i) => before[i] === null).map(file => path.basename(file)), undoToken: token, requiresRestart: true, runtimeVerified: false };
    });
    undos.set(token, { t, files, before, expected, priorText, receiptAfter: jsonHash(next) }); return result;
  }
  async function rollbackPrepare(id, token) {
    const t = target(id), undo = undos.get(token);
    if (!undo || !same(undo.t.exe, t.exe)) fail('SETTINGS_FG_UNDO_TOKEN', 'SM86 撤销凭据无效。');
    await assertClosed(t.game, t.exe);
    const check = async () => {
      if (await hashFile(receiptFile(t)) !== undo.receiptAfter) fail('SETTINGS_SM86_CHANGED', 'SM86 收据已改变，未撤销。');
      for (let i = 0; i < undo.files.length; i++) if (await hashFile(undo.files[i]) !== undo.expected[i]) fail('SETTINGS_SM86_CHANGED', 'SM86 文件已被外部修改，保留原件。');
    };
    await check();
    const result = await recovery.transaction(t, 'undo-prepare', async () => {
      await check(); await assertClosed(t.game, t.exe);
      for (let i = 0; i < undo.files.length; i++) if (undo.before[i] === null) { await recovery.capture(t, undo.files[i], null); await fsp.unlink(undo.files[i]); }
      const after = undo.priorText === null ? null : crypto.createHash('sha256').update(undo.priorText).digest('hex');
      await recovery.capture(t, receiptFile(t), after);
      if (undo.priorText === null) await fsp.unlink(receiptFile(t)); else await fsp.writeFile(receiptFile(t), undo.priorText);
      return { restored: true, runtimeVerified: false };
    }); undos.delete(token); return result;
  }
  async function restore(id) {
    const t = target(id), owned = await receipt(t); if (!owned) return { restored: false, unchanged: true };
    await assertClosed(t.game, t.exe);
    const files = [path.join(t.dir, PROXY), path.join(t.dir, config.FILE)], before = await Promise.all(files.map(hashFile));
    const receiptHash = await hashFile(receiptFile(t));
    if (owned.proxy.mode === 'created' && before[0] !== null && before[0] !== owned.proxy.sha256)
      fail('SETTINGS_SM86_CHANGED', 'SM86 代理已被外部修改，未删除。');
    const remove = [owned.proxy.mode === 'created' && before[0] !== null, owned.config.mode === 'created' && before[1] === owned.config.sha256];
    return recovery.transaction(t, 'restore', async () => {
      await assertClosed(t.game, t.exe);
      if (await hashFile(receiptFile(t)) !== receiptHash) fail('SETTINGS_SM86_CHANGED', 'SM86 收据在恢复前改变。');
      for (let i = 0; i < files.length; i++) {
        if (await hashFile(files[i]) !== before[i]) fail('SETTINGS_SM86_CHANGED', 'SM86 文件在恢复前改变。');
        if (remove[i]) { await recovery.capture(t, files[i], null); await fsp.unlink(files[i]); }
      }
      await recovery.capture(t, receiptFile(t), null); await fsp.unlink(receiptFile(t));
      return { restored: true, retained: files.filter((_file, i) => before[i] !== null && !remove[i]).map(file => path.basename(file)), runtimeVerified: false };
    });
  }
  async function previewProvider(id, providerId = ID) {
    if (providerId !== ID) fail('SETTINGS_SM86_PROVIDER', 'SM86 配套版本无效。');
    const state = await inspect(id), t = target(id);
    return { ...state, files: [PROXY, config.FILE].map(name => ({ path: path.join(t.dir, name), name, role: 'fg-component', action: state.ready ? 'keep' : 'prepare' })),
      blockers: [...state.blockers, ...state.conflicts, ...(state.fileRecoveryPending ? [state.fileRecoveryBlocker] : [])] };
  }
  return Object.freeze({ inspect, prepare, restore, rollbackPrepare, previewProvider, hasOwnership,
    receiptFile: id => receiptFile(target(id)),
    commitPrepare: (id, token) => { const undo = undos.get(token); if (undo && !same(undo.t.exe, target(id).exe)) fail('SETTINGS_FG_UNDO_TOKEN', 'SM86 撤销凭据属于另一游戏。'); undos.delete(token); return { committed: true }; },
    inspectPending: id => recovery.inspect(target(id)), recoverPending: id => recovery.recover(target(id)),
    inspectMigration: async id => ({ migrationPending: false, migrationToken: null, ...await recovery.inspect(target(id)) }),
    ownedModuleManifest: async id => { const t = target(id), owned = await receipt(t); if (!owned) return [];
      const pending = await recovery.inspect(t); if (pending.fileRecoveryPending || pending.fileOperationActive || await hashFile(path.join(t.dir, PROXY)) !== pins.proxy.sha256)
        fail('SETTINGS_SM86_CHANGED', 'SM86 模块身份尚未确认。');
      return [{ path: path.join(t.dir, PROXY), name: PROXY, role: 'fg-sm86', sha256: pins.proxy.sha256, architecture: 64, owner: 'fg-sm86' }]; },
    catalog
  });
}
module.exports = { createSm86Components, supportedMultipliers, BACKEND, ID, PIN, SOURCE };
