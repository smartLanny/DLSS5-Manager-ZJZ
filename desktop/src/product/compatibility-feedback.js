'use strict';
// Presentation/reporting only. Installation, launch, restoration and NR owners stay in the existing services.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSession, digest, safeText, UUID, HASH, fail } = require('../compatibility/model.cjs');
const { createFeedbackService } = require('../compatibility/feedback-service.cjs');
const { collectDrivers } = require('../compatibility/drivers.cjs');
const NR_KEYS = ['Enabled', 'Mode', 'WorkMode', 'CustomWorkScale', 'Style', 'Intensity', 'AutoMask', 'ColorStrength',
  'SkinStructureStrength', 'LocalToneStrength', 'LocalStructureStrength', 'TransferStrength', 'PostTransferStrength'];
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const identityPath = value => typeof value === 'string' && value ? path.resolve(value).toLowerCase() : null;
function scalarSettings(value) {
  const source = value?.config || value?.settings || value || {};
  return Object.fromEntries(NR_KEYS.filter(k => typeof source[k] === 'number' && Number.isFinite(source[k])).map(k => [k, source[k]]));
}
function enhancementSettings(data) {
  const output = {};
  for (const domain of ['sr', 'fg']) {
    const request = data?.current?.[domain]?.valid ? data.current[domain].request : data?.applied?.[domain]?.request;
    output[domain] = request ? Object.fromEntries(['backend','mode','quality','preset','renderPercent','multiplier','targetFps'].filter(k => ['string','number','boolean'].includes(typeof request[k])).map(k => [k, request[k]])) : null;
  }
  return output;
}
function normalizeModules(rows, coreVersion) {
  const roles = { core: 'nr', reshade: 'loader', carrier: 'transport', nrchain: 'transport', feeder: 'provider',
    dlss: 'sr', dlssg: 'fg', dlssd: 'rr', hdr: 'hdr', mfgunlock: 'fg' };
  return (Array.isArray(rows) ? rows : []).slice(0, 32).filter(row => roles[row?.role]).map(row => ({
    role: roles[row.role], id: row.role === 'core' ? 'xiaofeng-core' : row.role === 'dlssg' || row.role === 'mfgunlock' ? 'configured-fg-chain' : row.role,
    version: typeof row.version === 'string' ? row.version : row.role === 'core' ? coreVersion : null,
    sha256: HASH.test(row.sha256 || '') ? row.sha256 : null,
    // The manifest is a declaration; only the existing runtime verifier proves a module actually loaded.
    identity: 'declared'
  }));
}
function snapshotInput(data, modules, environment, version, build) {
  const game = data.game || {}, layout = data.layout || {}, nr = scalarSettings(data.nr);
  const source = layout.inputRoute || layout.source || 'unknown';
  const components = normalizeModules(modules, layout.version || game.addonVersion);
  const configuration = { requested: { nrScale: nr.WorkMode === 5 ? nr.CustomWorkScale : null },
    settingsFingerprint: digest({ nr, layoutGeneration: layout.generation ?? null, inputRoute: source,
      loadingBackend: layout.loadingBackend || null, loadingMode: layout.loadingMode || null,
      // Do not guess an active SR/FG request from GPU generation or defaults.
      enhancements: enhancementSettings(data.enhancements) }),
    generation: Number.isSafeInteger(layout.generation) ? layout.generation : null };
  return { contextSource: 'manual-snapshot', scope: 'game',
    game: { name: game.name || '未命名游戏', launcher: game.launcher || data.launch?.effective,
      storeId: game.verifiedSteamAppId || game.steamAppId || null,
      client: layout.hoyo?.channel || game.hoyo?.selected?.channel || null,
      version: game.version || null, exeName: layout.exe || game.executable || game.chosen?.path,
      exeSha256: game.exeSha256 || game.chosen?.exeHash || null, api: data.api?.effectiveApi },
    manager: { version, build }, components, configuration, environment,
    recipe: { id: String(source), name: layout.loadingBackend === 'hoyoshade' ? '米哈游外置加载 · 当前已配置方案' : '当前已配置方案',
      version: layout.version || game.addonVersion || null, nrOwner: components.some(c => c.id === 'xiaofeng-core') ? 'xiaofeng-core' : null,
      providerQuality: source === 'native' ? 'native' : source === 'feeder' ? 'synthetic' : 'unknown' } };
}
function contextIdentity(data, input, native, unavailable = []) {
  return digest({ gameId: data.gameId, exe: data.layout?.exe || data.game?.executable || data.game?.chosen?.path || null,
    bindingId: data.layout?.bindingId || null, recipe: input.recipe, components: input.components,
    configuration: input.configuration, unavailable,
    gameIdentity: input.game, layoutIdentity: { mode: data.layout?.mode, loadingMode: data.layout?.loadingMode,
      activeConfigPath: data.layout?.activeConfigPath, runtimeDir: data.layout?.runtimeDir }, historical: native?.historical === true, nativeSessionId: UUID.test(native?.sessionId || '') ? native.sessionId : null,
    nativeTargetExe: identityPath(native?.targetExe),
    requestedAt: native?.requestedAt || null });
}
function verificationObservations(verification, snapshot, native, observedAt) {
  if (!native || native.historical || native.sessionId !== snapshot.sessionId || !native.process ||
      !samePath(native.targetExe, native.process.exe)) return [];
  const result = [];
  for (const [field, stage, source] of [['core','loaded','process-modules'], ['nr','nr','core-runtime-verifier']]) {
    const entry = verification?.[field];
    if (entry?.status !== 'passed' || !Array.isArray(entry.evidence) || !entry.evidence.length) continue;
    result.push({ stage, state: 'observed', source, observedAt, sessionId: snapshot.sessionId,
      recipeFingerprint: snapshot.recipeFingerprint, configurationGeneration: snapshot.configuration.generation,
      reason: field === 'nr' ? '本次进程内观察到 NR 成功与提交；具体处理帧的参数代次、最终显示和画质仍未认证。' : '现有验证器核对了本次进程中的 Core 身份。' });
  }
  // No success is inferred for SR/RR/FG/display, nor is bypass counted as a crash.
  return result;
}
function createCompatibilityFeedback({ assessment, sessions, modules = async () => [], collectReport = async () => null,
  writePackage, managerVersion, managerBuild = '1cc34bf5+compatibility-ux', drivers = collectDrivers, now = () => new Date() }) {
  if (!assessment?.assess || !sessions?.inspect || typeof writePackage !== 'function') throw new TypeError('缺少现有管理器接口');
  const launchSnapshots = new Map(), contexts = new Map(), captureGenerations = new Map();
  let driverPromise = null, disposed = false, opening = false;
  // Driver queries are bounded and only run at a launch snapshot / explicit feedback request, never while rendering cards.
  async function inventory() {
    if (!driverPromise) driverPromise = Promise.resolve().then(() => drivers()).catch(() => ({ gpus: [], renderAdapter: null,
      os: { platform: process.platform }, capturedAt: now().toISOString() })).finally(() => { driverPromise = null; });
    return driverPromise;
  }
  async function facts(id, knownEnvironment) {
    if (typeof id !== 'string' || !id || id.length > 200) fail('目标游戏无效', 'COMPATIBILITY_TARGET');
    const optional = async (fn, code, fallback, valid = () => true) => {
      try {
        const value = await fn();
        return valid(value) ? { value, unavailable: null } : { value: fallback, unavailable: code };
      } catch { return { value: fallback, unavailable: code }; }
    };
    const [data, sessionResult, moduleResult] = await Promise.all([
      assessment.assess(id, { sections: ['installation', 'enhancements'] }),
      optional(() => sessions.inspect(id), 'SESSION_RECORD_UNAVAILABLE', null,
        value => value === null || value?.status !== 'record-unavailable'),
      optional(() => modules(id), 'COMPONENT_INVENTORY_UNAVAILABLE', [], Array.isArray)
    ]);
    if (data.gameId !== id) fail('检查结果属于另一游戏', 'COMPATIBILITY_TARGET');
    const native = sessionResult.value;
    const unavailable = [sessionResult.unavailable, moduleResult.unavailable,
      data.failures?.length ? 'ASSESSMENT_PARTIAL' : null].filter(Boolean).sort();
    const input = snapshotInput(data, moduleResult.value, knownEnvironment || await inventory(), managerVersion, managerBuild);
    return { data, native, input, unavailable, identity: contextIdentity(data, input, native, unavailable) };
  }
  async function captureLaunch(id, native, controls = {}) {
    const generation = (captureGenerations.get(id) || 0) + 1;
    captureGenerations.set(id, generation);
    const cancelled = () => typeof controls?.cancelled === 'function' && controls.cancelled() === true;
    if (disposed || cancelled() || !UUID.test(native?.sessionId || '') || !Number.isFinite(Date.parse(native.requestedAt))) return;
    const f = await facts(id);
    if (disposed || cancelled() || captureGenerations.get(id) !== generation) return;
    if (f.unavailable.length) { launchSnapshots.delete(id); return; }
    if (!samePath(native.targetExe, f.data.layout?.exe || f.data.game?.executable || f.data.game?.chosen?.path) ||
        !samePath(native.targetExe, f.native?.targetExe) || f.native?.sessionId !== native.sessionId || f.native.historical) return;
    const snapshot = createSession({ ...f.input, contextSource: 'launch-snapshot' },
      { uuid: () => native.sessionId, now: () => new Date(native.requestedAt) });
    if (disposed || cancelled() || captureGenerations.get(id) !== generation) return;
    launchSnapshots.set(id, { snapshot, identity: f.identity });
    while (launchSnapshots.size > 64) launchSnapshots.delete(launchSnapshots.keys().next().value);
  }
  function entry(token) {
    const value = contexts.get(token);
    if (disposed || !value || now().getTime() - value.created > 15 * 60 * 1000) {
      if (value) { value.service.dispose(); contexts.delete(token); }
      fail('反馈上下文已过期，请重新打开', 'COMPATIBILITY_EXPIRED');
    }
    return value;
  }
  async function open(id) {
    if (disposed) fail('反馈服务已经关闭', 'COMPATIBILITY_CLOSED');
    if (opening) fail('正在整理游戏信息，请稍后再试', 'BUSY');
    opening = true;
    try {
      for (const [key, c] of contexts) if (now().getTime() - c.created > 15 * 60 * 1000) { c.service.dispose(); contexts.delete(key); }
      if (contexts.size >= 8) fail('请先关闭旧反馈窗口', 'COMPATIBILITY_LIMIT');
      const frozen = launchSnapshots.get(id), f = await facts(id, frozen?.snapshot.environment);
      const matched = !f.unavailable.length && frozen && frozen.identity === f.identity && f.native?.sessionId === frozen.snapshot.sessionId && !f.native.historical;
      // A changed/manual context needs a fresh inventory, not the prior launch's driver snapshot.
      if (!matched && frozen) f.input.environment = await inventory();
      const snapshot = matched ? frozen.snapshot : createSession({ ...f.input, parentSessionId: f.native?.sessionId }, { now });
      const token = randomUUID();
      const c = { id, identity: f.identity, snapshot, unavailable: f.unavailable, created: now().getTime(), busy: false, closeRequested: false };
      const validateCurrent = async () => {
        const current = await facts(id, snapshot.environment);
        if (current.identity !== c.identity) fail('配套、设置或启动会话已经变化，请重新打开反馈', 'SESSION_CHANGED');
        return snapshot;
      };
      c.service = createFeedbackService({ getSession: validateCurrent, now,
        getEvidence: async () => {
          let data, native;
          try { [data, native] = await Promise.all([assessment.assess(id, { sections: ['diagnostics'] }), sessions.inspect(id)]); }
          catch { return { observations: [], limitations: [...c.unavailable, 'RUNTIME_INSPECTION_UNAVAILABLE'] }; }
          if (data.gameId !== id) fail('运行检查属于另一游戏', 'COMPATIBILITY_TARGET');
          return { observations: verificationObservations(data.verification, snapshot, native, now().toISOString()),
            limitations: c.unavailable };
        },
        collectLogs: async () => {
          const report = await collectReport(id, { includePaths: false });
          // The existing collector can contain history. Never promote the whole text to current-session proof.
          return report?.text ? [{ source: 'existing-manager-feedback', text: report.text, sessionId: null }] : [];
        }, writePackage });
      contexts.set(token, c);
      return { token, contextKey: snapshot.sessionId, game: snapshot.game.name, recipe: snapshot.recipe.name,
        contextSource: snapshot.contextSource,
        contextNote: matched ? '本次启动前配套快照。技术状态与体验评价分别记录。' : f.unavailable.includes('COMPONENT_INVENTORY_UNAVAILABLE') ?
          '组件清单暂不可读：仅记录当前配置，技术状态保持未知。' :
          '未取得匹配的启动前快照：仅记录当前配置，不会把它当成上次游玩的确切配套。',
        driverInventory: snapshot.environment.gpus.map(row => ({ name: row.name, driver: row.driverDisplay || row.driverRaw })),
        driverNote: '显卡清单不等于实际渲染设备；无法绑定时明确保留未知。' };
    } finally { opening = false; }
  }
  async function operation(token, fn) {
    const c = entry(token);
    if (c.busy) fail('反馈操作正在进行', 'BUSY');
    c.busy = true;
    try { return await fn(c); } finally {
      c.busy = false;
      if (c.closeRequested) { c.service.dispose(); contexts.delete(token); }
    }
  }
  return { captureLaunch, open,
    preview: (token, request) => operation(token, c => c.service.preview(request)),
    save: (token, request) => operation(token, c => c.service.save(request)),
    discard: (token, previewId) => entry(token).service.discard(previewId),
    close(token) { const c = contexts.get(token); if (!c) return false; if (c.busy) c.closeRequested = true; else { c.service.dispose(); contexts.delete(token); } return true; },
    dispose() { disposed = true; for (const c of contexts.values()) c.service.dispose(); contexts.clear(); launchSnapshots.clear(); captureGenerations.clear(); }
  };
}
module.exports = { createCompatibilityFeedback, snapshotInput, scalarSettings, verificationObservations, contextIdentity };
