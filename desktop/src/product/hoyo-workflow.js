'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks, atomicJson, assertLaunchNotCancelled } = require('./launch-safety');
const { HOYO_CLIENTS, validHoYoProfile } = require('./hoyoshade-profiles');
const { emptyVerification } = require('./runtime-verification');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const issue = error => ({ code: error?.code || 'HOYO_WORKFLOW', message: error?.message || '米哈游流程未完成。' });
const fail = (code, message) => { throw Object.assign(new Error(message), { code: 'HOYO_' + code }); };
const waiting = new Set(['preflight', 'waiting-helper', 'request-sending', 'waiting-launcher', 'waiting-game']);

async function readRecord(file) {
  await noLinks(file);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) fail('BINDING_RECORD', '客户端绑定记录不可读取，原文件已保留。');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function createHoYoWorkflow({ userData, service, operations, launches, verification, launch, elevatedApply,
  requiresElevation = async () => false, discovery: suppliedDiscovery, discoveryOptions = {}, beforeMutation = async () => {},
  inspectLaunchReadiness: inspectLaunchReadinessMetadata = null }) {
  const file = path.join(userData, 'hoyo-bindings.json'), clients = new Map(), errors = new Map(), starts = new Map(), starting = new Map(), installs = new Map(), acknowledged = new Map();
  let launchers = [], warnings = [];
  async function saved() {
    const value = await readRecord(file);
    if (!value) return [];
    if (value.version !== 1 || !Array.isArray(value.bindings) || value.bindings.length > 128 || value.bindings.some(row =>
      !row || typeof row.id !== 'string' || !path.isAbsolute(row.exePath || '') || !path.isAbsolute(row.gameRoot || '')))
      fail('BINDING_RECORD', '客户端绑定记录格式无效，原文件已保留。');
    return value.bindings;
  }
  async function remember(row) {
    const rows = await saved(), at = rows.findIndex(item => same(item.exePath, row.exePath));
    if (at < 0) rows.push(row); else rows[at] = row;
    await atomicJson(file, { version: 1, bindings: rows });
  }
  async function oldProfiles() {
    const result = [];
    for (const game of await service.listGames()) {
      const exe = game.chosen?.path || game.scan?.chosen?.path;
      if (!exe || !HOYO_CLIENTS.some(row => row.exeName.toLowerCase() === path.basename(exe).toLowerCase())) continue;
      try {
        const record = await readRecord(path.join(game.dir, '_DLSS5_Backup/xiaofeng-external.json'));
        if (validHoYoProfile(record?.hoyoProfile, exe)) result.push(record.hoyoProfile);
      } catch { /* Inspection retains the original ownership error in its flow. */ }
    }
    return result;
  }
  const discovery = suppliedDiscovery || require('./hoyo-discovery').createHoYoDiscovery({ ...discoveryOptions,
    knownGames: () => service.listGames(), savedBindings: oldProfiles,
    knownLaunchers: async () => (await saved()).map(row => row.launcher).filter(Boolean) });
  const target = id => { const row = clients.get(id); if (!row) fail('CLIENT_MISSING', '客户端已不在发现结果中，请重新发现。'); return row; };
  const choices = row => HOYO_CLIENTS.filter(item => item.family === row.family && item.exeName.toLowerCase() === path.basename(row.exePath).toLowerCase());
  const launcherChoices = row => [...new Map([...(row.launchers || []), ...launchers, ...(row.binding?.launcher ? [row.binding.launcher] : [])]
    .filter(item => item?.id && item.path).map(item => [item.id, item])).values()];
  async function register(row, games) {
    let game = games.find(item => same(item.chosen?.path || item.scan?.chosen?.path, row.exePath));
    if (!game) {
      games = await service.addManualSelection({ root: row.gameRoot, executable: row.exePath, name: row.familyLabel || row.family });
      game = games.find(item => same(item.chosen?.path || item.scan?.chosen?.path, row.exePath));
    }
    if (!game) fail('REGISTRATION', '正式游戏程序未能加入管理器，请重新选择游戏程序。');
    row.gameId = game.id;
    service.markHoYoGame?.(game.id);
    return games;
  }
  async function selectedBinding(row, records, profiles) {
    const previous = records.find(item => same(item.exePath, row.exePath));
    const profile = profiles.find(item => same(item.exePath, row.exePath));
    const auto = row.automaticBinding;
    const candidate = previous || (auto ? { ...auto, api: null } : profile ? {
      family: profile.family, channel: profile.channel, launcher: { kind: profile.launcher.kind, path: profile.launcher.path }, api: null } : null);
    row.binding = { family: row.family, channel: candidate?.channel || row.channel || null, launcher: candidate?.launcher || null,
      api: previous?.api || null, confirmed: false };
    if (row.binding.launcher) {
      // Keep a remembered path visible even when it no longer exists.
      const inspected = await discovery.inspectLauncher(row.binding.launcher.path, row.binding.launcher.kind).catch(() => null);
      const sameFiles = previous?.confirmed === true && /^[a-f0-9]{64}$/.test(previous.exeSha256 || '') &&
        previous.exeSha256 === row.exeSha256 && /^[a-f0-9]{64}$/.test(previous.launcher?.sha256 || '') && previous.launcher.sha256 === inspected?.sha256;
      // New unique evidence can refresh a binding after an update. Preserve an
      // explicit launcher/channel preference when the unique default differs.
      const currentAuto = auto?.family === row.family && auto?.channel === row.binding.channel &&
        auto?.launcher?.kind === inspected?.kind && same(auto?.launcher?.path, inspected?.path) &&
        /^[a-f0-9]{64}$/.test(row.exeSha256 || '') && /^[a-f0-9]{64}$/.test(inspected?.sha256 || '');
      row.binding.launcher = inspected || row.binding.launcher;
      row.binding.confirmed = Boolean(inspected && (sameFiles || currentAuto));
    }
    if (!choices(row).some(item => item.channel === row.binding.channel)) row.binding.confirmed = false;
    if (row.binding.confirmed) await persist(row);
  }
  async function persist(row) {
    await remember({ id: row.id, exePath: row.exePath, gameRoot: row.gameRoot, family: row.family,
      exeSha256: row.exeSha256, channel: row.binding.channel, launcher: row.binding.launcher, api: row.binding.api, confirmed: row.binding.confirmed === true });
  }
  async function discover() {
    const records = await saved(), profiles = await oldProfiles();
    const result = await discovery.discover(); launchers = result.launchers || []; warnings = result.warnings || [];
    let games = await service.listGames();
    const found = new Set();
    for (const input of result.games || []) {
      const row = { ...input }; found.add(row.id);
      await selectedBinding(row, records, profiles); games = await register(row, games); clients.set(row.id, row);
    }
    for (const id of clients.keys()) if (!found.has(id) && !starts.has(id)) clients.delete(id);
    return { games: await Promise.all([...clients.keys()].map(id => inspect(id))), launchers, warnings };
  }
  async function inspect(id, options = {}) {
    const row = target(id);
    if (options.retry === true) errors.delete(id);
    const binding = row.binding || {}, channels = choices(row), choice = channels.find(item => item.channel === binding.channel);
    let error = errors.get(id) || null, deployment = null, pending = null, session = null;
    try { pending = await operations.inspect(row.gameId); } catch (cause) { error = issue(cause); pending = { pending: true }; }
    try { session = await launches.inspect(row.gameId); } catch (cause) { if (!error) error = issue(cause); }
    if (options.retry === true && session && ['failed', 'enhancement-failed'].includes(session.status)) acknowledged.set(id, session.sessionId);
    const active = session && !session.historical && !['failed', 'enhancement-failed', 'cancelled', 'game-exited', 'stale'].includes(session.status);
    try {
      deployment = !options.force && (active || starts.has(id)) && installs.get(id) || await service.inspectDeployment(row.gameId);
      installs.set(id, deployment);
    } catch (cause) { error = issue(cause); installs.delete(id); }
    const seed = service.assessmentSeed(row.gameId), apiEvidence = seed.scan?.chosen?.apiResolution || seed.chosen?.apiResolution;
    const selectedApi = binding.api || (['dx11', 'dx12'].includes(apiEvidence?.api) ? { api: apiEvidence.api, source: apiEvidence.source, evidence: apiEvidence.evidence || [] } : null);
    const needsRecovery = Boolean(pending?.pending || deployment?.needsRecovery || deployment?.pending || !deployment && error);
    const installed = Boolean(deployment?.loadingBackend === 'hoyoshade' && deployment.installed === true);
    const apiChangePending = installed && ['dx11', 'dx12'].includes(binding.api?.api) && binding.api.api !== deployment.api;
    const installedBinding = deployment?.hoyoProfile, installedLauncher = deployment?.launcher || installedBinding?.launcher;
    const bindingChangePending = installed && (!validHoYoProfile(installedBinding, row.exePath) ||
      installedBinding.exeSha256 !== row.exeSha256 || deployment.bindingId !== installedBinding.bindingId ||
      binding.family !== installedBinding.family || binding.channel !== installedBinding.channel ||
      binding.launcher?.kind !== installedLauncher?.kind || !same(binding.launcher?.path, installedLauncher?.path) ||
      binding.launcher?.sha256 !== installedLauncher?.sha256);
    const ready = installed && deployment.ready === true && !apiChangePending && !bindingChangePending && !needsRecovery && !error;
    let launchReadiness;
    if (installed && typeof inspectLaunchReadinessMetadata === 'function') {
      try {
        launchReadiness = await inspectLaunchReadinessMetadata(row.gameId);
        if (!launchReadiness || typeof launchReadiness !== 'object' || Array.isArray(launchReadiness)) {
          throw Object.assign(new Error('启动设置就绪状态返回无效。'), { code: 'HOYO_LAUNCH_READINESS_INVALID' });
        }
      } catch (cause) {
        launchReadiness = {
          state: 'unknown', known: false, source: 'metadata', pending: [],
          blockers: [{ domain: 'settings', code: cause?.code || 'HOYO_LAUNCH_READINESS_UNKNOWN',
            message: cause?.message || '启动设置就绪状态暂时无法确认。', known: false, action: { kind: 'open-settings' } }]
        };
      }
    }
    // A newly verified preference can replace the old game's/launcher's hash
    // through a fresh owner plan. Other ownership or file failures stay visible.
    const blockers = (deployment?.blockers || []).filter(item => !(bindingChangePending && binding.confirmed &&
      item === '游戏或启动器已更新，请重新确认客户端绑定。'));
    if (installed && !ready && !error && blockers.length) error = { code: 'HOYO_DEPLOYMENT_NOT_READY', message: blockers.map(item => item.message || item).join('；') };
    const verified = await (session && !session.historical ? verification.assess(row.gameId, session) : Promise.resolve(emptyVerification(null, null)))
      .catch(cause => ({ ...emptyVerification(null, null), nr: { status: 'unverified', detail: cause.message } }));
    let phase = !binding.confirmed || !choice || !binding.launcher ? 'binding' : !['dx11', 'dx12'].includes(selectedApi?.api) ? 'api' : apiChangePending || bindingChangePending ? 'install' : installed ? ready ? 'ready' : 'failed' : 'install';
    if ((starts.has(id) || starting.has(id)) && !active && !options.preparingStart) phase = 'waiting-helper';
    if (active) phase = ['preflight', 'waiting-helper', 'request-sending'].includes(session.status) ? 'waiting-helper' :
      ['waiting-launcher', 'waiting-game'].includes(session.status) ? session.status : session.process ? 'running' : phase;
    if (session && !session.historical && acknowledged.get(id) !== session.sessionId && ['failed', 'enhancement-failed'].includes(session.status)) { error = session.error || error || { code: 'HOYO_LAUNCH_FAILED', message: session.helper?.reason || '本次加载未完成。' }; phase = 'failed'; }
    if (error && phase !== 'recovery') phase = 'failed';
    if (needsRecovery) phase = 'recovery';
    const nextAction = ({ binding: 'bind', api: 'select-api', install: 'preview-install', ready: 'start', recovery: 'recover',
      'waiting-helper': 'wait', 'waiting-launcher': 'wait', 'waiting-game': 'wait', running: 'wait', failed: 'inspect' })[phase];
    return { id, gameId: row.gameId, name: seed.name || row.familyLabel, exePath: row.exePath, gameRoot: row.gameRoot,
      family: row.family, channel: binding.channel, channelLabel: choice?.channelLabel || null, gameVersion: row.gameVersion,
      api: { api: selectedApi?.api || 'unknown', source: selectedApi?.source || 'unconfirmed', requiresConfirmation: !selectedApi,
        evidence: selectedApi?.evidence || seed.scan?.chosen?.apiAssessment?.evidence || [] },
      binding: { status: binding.confirmed ? 'confirmed' : binding.launcher ? 'needs-confirmation' : 'missing', launcher: binding.launcher,
        launchers: launcherChoices(row), channels: channels.map(({ channel, channelLabel }) => ({ channel, channelLabel })) },
      installation: { installed, ready: ready && !error, needsRecovery, error, apiChangePending, bindingChangePending, installedApi: deployment?.api || null, hasRecord: Boolean(deployment?.installed || needsRecovery) },
      phase, nextAction, session, verification: Object.fromEntries(Object.entries(verified).map(([name, value]) => [name, { ...value, state: value?.status || 'unverified' }])),
      error, busy: false, evidence: row.evidence || [], warnings: row.warnings || [],
      ...(launchReadiness ? { launchReadiness } : {}) };
  }
  async function assertIdle(row, allowStarting = false) {
    const session = await launches.inspect(row.gameId);
    if (starts.has(row.id) || !allowStarting && starting.has(row.id) || session && !session.historical && waiting.has(session.status)) fail('LAUNCH_BUSY', '本次启动仍在等待，请先取消等待再修改配置。');
    await beforeMutation(row.gameId);
  }
  async function bind(id, input = {}) {
    const row = target(id); await assertIdle(row);
    if (!input || typeof input !== 'object' || Object.keys(input).some(name => !['channel', 'launcherId', 'api'].includes(name))) fail('BINDING_INPUT', '绑定选项无效。');
    const channel = input.channel || row.binding.channel;
    if (!choices(row).some(item => item.channel === channel)) fail('CHANNEL', '请选择与正式游戏程序对应的客户端。');
    const selected = input.launcherId ? launcherChoices(row).find(item => item.id === input.launcherId) : row.binding.launcher;
    if (!selected) fail('LAUNCHER', '请选择这个客户端使用的启动器。');
    const launcher = await discovery.inspectLauncher(selected.path, selected.kind);
    if (!launcher) fail('LAUNCHER', '启动器程序不可读取，请重新选择。');
    if (input.api !== undefined && !['dx11', 'dx12'].includes(input.api)) fail('API', '请选择游戏实际使用的 DirectX 11 或 DirectX 12。');
    row.binding = { family: row.family, channel, launcher, confirmed: true,
      api: input.api ? { api: input.api, source: 'user-selection', evidence: ['用户在米哈游专页选择的游戏 API。'] } : row.binding.api };
    await persist(row); return inspect(id);
  }
  async function pickGame(exe) {
    if (!exe) return { cancelled: true };
    const result = await discovery.inspectGame(exe);
    if (result.games?.length !== 1) fail('GAME_SELECTION', '请选择唯一的正式米哈游游戏 EXE。');
    const row = result.games[0]; await selectedBinding(row, await saved(), await oldProfiles());
    await register(row, await service.listGames()); clients.set(row.id, row); await persist(row);
    return { cancelled: false, discovery: await inspect(row.id) };
  }
  async function pickLauncher(id, exe) {
    if (!exe) return inspect(id);
    const row = target(id); await assertIdle(row);
    const launcher = await discovery.inspectLauncher(exe, /starward\.exe$/i.test(exe) ? 'starward' : 'hoyoplay');
    if (!launcher) fail('LAUNCHER', '所选文件不是有效的 HoYoPlay 或 Starward 启动器。');
    row.binding = { ...row.binding, launcher, confirmed: false }; await persist(row); return inspect(id);
  }
  async function preview(id, action = 'install', options = {}) {
    if (!options || Array.isArray(options) || Object.keys(options).some(key => !['adoption', 'version'].includes(key)) ||
        action !== 'install' && Object.keys(options).length || options.version !== undefined &&
        (typeof options.version !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(options.version)))
      fail('ACTION', '接管选项仅用于安装预览。');
    require('./installation-adoption').validateAdoptionChoice(options.adoption);
    const row = target(id); await assertIdle(row); const flow = await inspect(id, { force: true });
    if (!['install', 'restore', 'repair'].includes(action)) fail('ACTION', '预览操作无效。');
    if (flow.installation.needsRecovery) fail('RECOVERY_REQUIRED', '请先恢复未完成操作。');
    if (action === 'install' && (flow.binding.status !== 'confirmed' || flow.api.requiresConfirmation)) fail('BINDING_REQUIRED', '请先完成客户端、启动器和图形 API 绑定。');
    const request = action === 'restore' ? { uninstall: 'restore' } : action === 'repair' ? { repair: true } : {
      loadingBackend: 'hoyoshade', deployment: 'external', loadingMode: 'helper', api: flow.api.api,
      hoyo: { family: row.family, channel: row.binding.channel, launcher: { kind: row.binding.launcher.kind, path: row.binding.launcher.path } },
      ...(options.adoption ? { adoption: options.adoption } : {}), ...(options.version ? { version: options.version } : {}) };
    const plan = await operations.preview(row.gameId, request);
    return { ...plan, requiresElevation: await requiresElevation(plan), flow };
  }
  async function apply(id, planId, consent = {}) {
    const row = target(id); await assertIdle(row);
    try {
      if (consent.confirm !== true || !consent.fingerprint) fail('CONSENT', '请确认本次预览后再应用。');
      const plan = await operations.loadPlan(planId, consent.fingerprint);
      if (plan.gameId !== row.gameId) fail('PLAN_TARGET', '预览属于另一个客户端。');
      if (await requiresElevation(plan)) await elevatedApply(row.gameId, planId, consent);
      else await operations.apply(planId, consent);
      await service.refresh(); installs.delete(id); errors.delete(id);
    } catch (cause) { errors.set(id, issue(cause)); }
    return inspect(id, { clearError: false, force: true });
  }
  async function recover(id) {
    const row = target(id); await assertIdle(row);
    try { await operations.recover(row.gameId); await service.recoverDeployment(row.gameId); errors.delete(id); installs.delete(id); }
    catch (cause) { errors.set(id, issue(cause)); }
    return inspect(id, { clearError: false, force: true });
  }
  async function start(id) {
    const row = target(id);
    if (starting.has(id) || starts.has(id)) fail('LAUNCH_BUSY', '本次启动仍在等待，请先取消等待再修改配置。');
    const request = { cancelled: false }, controls = { cancelled: () => request.cancelled };
    starting.set(id, request);
    try {
      await assertIdle(row, true);
      assertLaunchNotCancelled(controls);
      const flow = await inspect(id, { force: true, preparingStart: true });
      assertLaunchNotCancelled(controls);
      if (!flow.installation.ready || !['ready', 'failed'].includes(flow.phase)) fail('NOT_READY', flow.error?.message || '配置尚未就绪，请完成当前步骤。');
      await operations.assertReady(row.gameId); assertLaunchNotCancelled(controls); errors.delete(id);
      request.work = Promise.resolve().then(() => { assertLaunchNotCancelled(controls); return launch(row.gameId, controls); })
        .catch(cause => { if (!request.cancelled) errors.set(id, issue(cause)); })
        .finally(() => { if (starts.get(id) === request) starts.delete(id); });
      starts.set(id, request);
      return { ...flow, error: null, phase: 'waiting-helper', nextAction: 'wait' };
    } finally { if (starting.get(id) === request) starting.delete(id); }
  }
  async function cancel(id) {
    const row = target(id), request = starting.get(id) || starts.get(id);
    if (request) request.cancelled = true;
    await launches.cancel(row.gameId);
    if (starting.get(id) === request) starting.delete(id);
    if (starts.get(id) === request) starts.delete(id);
    return inspect(id, { clearError: false });
  }
  return { discover, inspect, bind, pickGame, pickLauncher, preview, apply, recover, start, cancel };
}
module.exports = { createHoYoWorkflow };
