'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const journalDefault = require('../core/file-journal');
const policy = require('./launch-settings-policy');
const { createNvapiProfileAdapter } = require('./nvapi-profile');
const { fail, inside, noLinks, digestFile, atomicJson } = require('./launch-safety');
const { detectGpuAsync: detectGpu } = require('./gpu');
const { createInstallGuards } = require('../core/install-guards');
const pe = require('../core/pe');
const { assessEnhancementState, NVIDIA_FG_DRIVER } = require('./game-enhancement-capabilities');
const { createNativeEnhancementProbe } = require('./native-enhancement-probe');
const mfgConfig = require('./mfgunlock-config');

const DRIVER_IDS = [...policy.IDS.sr, ...policy.IDS.fg];
const clone = value => structuredClone(value);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const subset = (snapshot, ids) => Object.fromEntries(ids.map(id => [id, snapshot.settings[id]]));
const stateEmpty = () => ({ version: 1, games: {} });

function createLaunchSettingsService(options = {}) {
  const { userData, appDir, resourcesPath, legacySrModel = null } = options;
  if (!userData || !appDir || typeof options.gameDirectory !== 'function' || typeof options.gameExecutable !== 'function')
    fail('SETTINGS_INIT', '启动设置服务缺少游戏路径依赖。');
  const journal = options.journal || journalDefault;
  const detectHardware = options.detectHardware || detectGpu;
  const environment = options.environment || null;
  const assertGameClosed = options.assertGameClosed || createInstallGuards().assertGameClosed;
  const peBitness = options.peBitness || pe.getBitness;
  const scriptPath = resourcesPath && fs.existsSync(path.join(resourcesPath, 'nvapi-profile.ps1'))
    ? path.join(resourcesPath, 'nvapi-profile.ps1') : path.join(appDir, 'src', 'product', 'nvapi-profile.ps1');
  const driver = options.driver || createNvapiProfileAdapter({ scriptPath });
  const requestFile = path.join(userData, 'launch-settings-requests.json');
  const plans = new Map();
  const mfgObservations = new WeakMap(), MFG_COMPENSATION = Symbol('observed-mfg-compensation');
  const scopeReads = new Map();
  const featureProbe = typeof options.getFeatureEvidence === 'function' ? null : createNativeEnhancementProbe(options);
  let serial = Promise.resolve();
  const serialize = work => { const next = serial.then(work, work); serial = next.catch(() => {}); return next; };

  function target(id) {
    const dir = options.gameDirectory(id), exe = options.gameExecutable(id);
    if (typeof dir !== 'string' || typeof exe !== 'string' || !path.isAbsolute(dir) || !path.isAbsolute(exe) ||
        !inside(dir, exe) || path.extname(exe).toLowerCase() !== '.exe') fail('ERR_UNKNOWN_GAME', '游戏 EXE 绑定无效。');
    return { id, dir: path.resolve(dir), exe: path.resolve(exe), key: path.resolve(dir).toLowerCase() };
  }
  async function featureEvidence(id, domain) {
    const t = target(id);
    const supplied = typeof options.getFeatureEvidence === 'function' ? await options.getFeatureEvidence(id, domain) : await featureProbe.inspect(id, domain);
    let metadata = supplied.driver;
    if (!metadata) {
      try { metadata = typeof driver.inspectSettings === 'function' ? await driver.inspectSettings(t.exe) : { available: false }; }
      catch (error) { metadata = { available: false, source: 'unavailable', code: error.code }; }
    }
    return { staticEvidence: null, support: { status: 'unknown', source: null, staticOnly: true, evidence: [] },
      gameSetting: { state: 'unknown', source: null }, ...supplied, driver: metadata };
  }
  async function assessEligibility(id, domain, input) {
    const t = target(id), evidence = await featureEvidence(id, domain), hardware = await detectHardware();
    const request = input || { backend: domain === 'sr' ? 'native' : hardware.series?.includes('RTX40') ? 'mfgunlock' : 'nvidia' };
    let requiredSettingIds = domain === 'sr' ? [policy.IDS.sr[0], policy.IDS.sr[3]] : policy.IDS[domain], minimumDriverVersion = 57216;
    if (domain === 'sr' && request.quality && request.quality !== 'game') {
      const compiled = policy.nativeSr(request, hardware);
      requiredSettingIds = compiled.operations.map(row => row.id);
      const preset = compiled.operations.find(row => row.id === policy.IDS.sr[3])?.value;
      // 595.97 is the verified March 2026 baseline for the current 4.5 choices.
      if (preset === 12 || preset === 13) minimumDriverVersion = 59597;
    }
    if (domain === 'fg' && (request.mode === 'dynamic' || request.multiplier > 4)) minimumDriverVersion = NVIDIA_FG_DRIVER.advanced;
    const context = { domain, request: { ...request, requiredSettingIds, minimumDriverVersion },
      game: { ...evidence, exe: t.exe }, hardware, driver: evidence.driver };
    const result = assessEnhancementState(context);
    if (domain === 'sr') {
      const available = evidence.driver?.available === true && Number.isInteger(evidence.driver.version);
      const ids = new Set(evidence.driver?.settingIds || []), modelKeys = [policy.IDS.sr[0], policy.IDS.sr[3]].every(id => ids.has(id));
      result.availablePresets = available && modelKeys && evidence.driver.version >= 57216
        ? ['K', ...(evidence.driver.version >= 59597 ? ['M', 'L'] : [])] : [];
      result.availableQualities = available && modelKeys ? ['preserve', 'game', ...(policy.IDS.sr.every(id => ids.has(id))
        ? ['dlaa', 'quality', 'balanced', 'performance', 'ultraPerformance', 'custom'] : [])] : ['game'];
    }
    // An optional host assessor may add constraints, never erase this boundary.
    if (typeof options.assessEligibility === 'function') {
      const additional = await options.assessEligibility(id, domain, request, context);
      if (additional?.blockers?.length) { result.blockers.push(...additional.blockers); result.eligible = false; result.canConfirm = false; }
    }
    return result;
  }
  async function confirmGameFeature(id, domain, input) {
    fail('SETTINGS_CONFIRMATION_RETIRED', '此版本已改为自动检查支持条件，请重新检查游戏；用户自述不再解锁功能。');
  }
  async function inspectGameFeatureConfirmation(id, domain) {
    target(id);
    return { domain, confirmation: null, retired: true, runtimeVerified: false };
  }
  function receiptFile(t) { return path.join(t.dir, '_DLSS5_Backup', 'xiaofeng-launch-settings.json'); }
  function driverPendingFile(t) { return path.join(t.dir, '_DLSS5_Backup', 'launch-driver-pending.json'); }
  function externalPendingFile(t) { return path.join(t.dir, '_DLSS5_Backup', 'launch-external-config-pending.json'); }
  function configuration(t, backend, row = null) {
    if (backend !== 'mfgunlock' || typeof options.getLayout !== 'function') {
      const file = path.join(path.dirname(t.exe), row?.name || policy.FILES[backend]);
      if (row?.configFile && !samePath(row.configFile, file)) fail('SETTINGS_LAYOUT_CHANGED', '配置位置已改变，请先恢复原布局中的设置。');
      return { file, external: false, root: t.dir };
    }
    const layout = options.getLayout(t.id);
    if (layout?.verified !== true || layout.needsRecovery || layout.blockers?.length || !samePath(layout.exe, t.exe) ||
        typeof layout.activeConfigPath !== 'string' || !path.isAbsolute(layout.activeConfigPath) ||
        typeof layout.reshadeConfigDir !== 'string' || !samePath(path.dirname(layout.activeConfigPath), layout.reshadeConfigDir) ||
        path.basename(layout.activeConfigPath).toLowerCase() !== 'reshade.ini') fail('SETTINGS_LAYOUT_UNVERIFIED', '尚未确认此游戏实际使用的 ReShade 配置位置。');
    if (row?.configFile && !samePath(row.configFile, layout.activeConfigPath)) fail('SETTINGS_LAYOUT_CHANGED', '当前活动配置与已应用记录不一致，请先恢复原布局。');
    // Historical local receipts must not be silently rebound to an external INI.
    if (row && !row.configFile && !samePath(layout.activeConfigPath, path.join(path.dirname(t.exe), row.name)))
      fail('SETTINGS_LAYOUT_CHANGED', '请先恢复旧本地 MFG 设置，再切换外置配置。');
    return { file: layout.activeConfigPath, external: !inside(t.dir, layout.activeConfigPath), root: layout.reshadeConfigDir };
  }
  function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return clone(fallback); } }
  function requests() {
    if (!fs.existsSync(requestFile)) return stateEmpty();
    let value; try { value = JSON.parse(fs.readFileSync(requestFile, 'utf8')); } catch { fail('SETTINGS_REQUESTS_INVALID', '保存的启动设置无法解析。'); }
    if (!value || value.version !== 1 || !value.games || typeof value.games !== 'object' || Array.isArray(value.games)) fail('SETTINGS_REQUESTS_INVALID', '保存的启动设置结构无效。');
    for (const [key, game] of Object.entries(value.games)) {
      if (!path.isAbsolute(key) || !game || typeof game !== 'object' || Array.isArray(game) || Object.keys(game).some(name => !['sr', 'fg', '_srManaged'].includes(name))) fail('SETTINGS_REQUESTS_INVALID', '保存的游戏设置范围无效。');
      for (const domain of ['sr', 'fg']) if (game[domain] && (typeof game[domain].exe !== 'string' || !path.isAbsolute(game[domain].exe) || !game[domain].request)) fail('SETTINGS_REQUESTS_INVALID', '保存的 EXE 请求无效。'); else if (game[domain]) policy.validateRequest(domain, game[domain].request);
      if (game._srManaged && (typeof game._srManaged.exe !== 'string' || !path.isAbsolute(game._srManaged.exe))) fail('SETTINGS_REQUESTS_INVALID', 'SR 接管标记无效。');
    }
    return value;
  }
  function validProfile(value, t) {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.appName !== 'string' || typeof value.owned !== 'boolean') return false;
    if (value.exclusive === true) return samePath(value.appName,t.exe);
    const scope=value.scope, rule=value.appName.replace(/\\/g,'/').toLowerCase(), exe=t.exe.replace(/\\/g,'/').toLowerCase();
    return value.exclusive === false && value.owned === false && scope?.predefined === true &&
      /^[a-f0-9]{64}$/.test(scope.fingerprint || '') && Array.isArray(scope.applications) && scope.applications.length > 0 && scope.applications.length <= 512 &&
      scope.applications.every(name => typeof name === 'string' && name.length > 0 && name.length <= 2048 && !name.includes('\0')) &&
      scope.applications.includes(value.appName) && !rule.split('/').some(part=>part==='.'||part==='..') &&
      (exe === rule || !/^(?:[a-z]:|\/)/.test(rule) && exe.endsWith('/'+rule));
  }
  function validSetting(value) { return value && typeof value === 'object' && ['explicit', 'inherited', 'absent'].includes(value.kind) &&
    (value.kind === 'absent' ? value.value === null && value.location === null && value.predefined === null : Number.isInteger(value.value) && value.value >= 0 && value.value <= 0xffffffff && Number.isInteger(value.location) && value.location >= 0 && value.location <= 3 && typeof value.predefined === 'boolean' && (value.kind !== 'explicit' || value.location === 0 && value.predefined === false)); }
  function validSnapshot(value, t) { return value && typeof value === 'object' && validProfile(value.profile, t) && value.settings &&
    Object.keys(value.settings).length === DRIVER_IDS.length && DRIVER_IDS.every(id => validSetting(value.settings[id])); }
  function receipt(t, { allowEmptyRebind = false } = {}) {
    const file = receiptFile(t); journal.safePath(t.dir, path.relative(t.dir, file));
    let value;
    if (!fs.existsSync(file)) return { version: 1, exe: t.exe, applied: {}, driverOriginalProfile: null, lastTransaction: null };
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('SETTINGS_RECEIPT_INVALID', '启动设置恢复记录无法解析。'); }
    if (value?.version === 1 && typeof value.exe === 'string' && path.isAbsolute(value.exe) && !samePath(value.exe, t.exe) &&
        value.applied && typeof value.applied === 'object' && !Array.isArray(value.applied) && Object.keys(value.applied).length === 0 &&
        (allowEmptyRebind || !fs.existsSync(journal.pendingPath(t.dir))) && !fs.existsSync(driverPendingFile(t))) {
      return { version: 1, exe: t.exe, applied: {}, driverOriginalProfile: null, lastTransaction: null };
    }
    if (value.version !== 1 || !samePath(value.exe, t.exe) || !value.applied || typeof value.applied !== 'object' || !validProfile(value.driverOriginalProfile ?? null, t) || Object.keys(value.applied).some(domain => !['sr', 'fg'].includes(domain)) ||
        value.lastTransaction != null && (!value.lastTransaction || !/^[a-f0-9-]{36}$/.test(value.lastTransaction.id || '') || !['sr', 'fg'].includes(value.lastTransaction.domain) || typeof value.lastTransaction.restoring !== 'boolean'))
      fail('SETTINGS_RECEIPT_INVALID', '启动设置恢复记录与当前 EXE 不一致。');
    for (const [domain, row] of Object.entries(value.applied)) {
      const allowed = domain === 'sr' ? ['native', 'optiscaler'] : ['nvidia', 'rtx40', 'mfgunlock'];
      if (!row || !allowed.includes(row.backend) || !samePath(row.exe, t.exe) || !row.request || typeof row.request !== 'object') fail('SETTINGS_RECEIPT_INVALID', '启动设置域记录无效。');
      policy.validateRequest(domain, row.request);
      if (['native', 'nvidia'].includes(row.backend)) {
        if (!Array.isArray(row.ids) || !row.ids.length || row.ids.some(id => !policy.IDS[domain].includes(id)) || new Set(row.ids).size !== row.ids.length || !validSnapshot(row.baseline, t) || !validProfile(row.profile, t) ||
            !row.lastValues || Object.keys(row.lastValues).length !== row.ids.length || row.ids.some(id => !validSetting(row.lastValues[id]))) fail('SETTINGS_RECEIPT_INVALID', '驱动设置恢复范围无效。');
      } else {
        if (!policy.validConfigName(row.name, row.backend) || typeof row.baselineText !== 'string' || Buffer.byteLength(row.baselineText) > 1024 * 1024 || !row.lastValues || typeof row.lastValues !== 'object') fail('SETTINGS_RECEIPT_INVALID', '配置文件恢复范围无效。');
        if (row.baselineMissing !== undefined && (typeof row.baselineMissing !== 'boolean' || row.backend !== 'mfgunlock')) fail('SETTINGS_RECEIPT_INVALID', '配置文件初始状态无效。');
        if (row.configFile !== undefined && (row.backend !== 'mfgunlock' || typeof row.configFile !== 'string' || !path.isAbsolute(row.configFile))) fail('SETTINGS_RECEIPT_INVALID', '配置文件绑定无效。');
        const allowedKeys = Object.keys(policy.values(row.baselineText, row.backend));
        if (Object.keys(row.lastValues).some(key => !allowedKeys.includes(key))) fail('SETTINGS_RECEIPT_INVALID', '配置文件恢复键无效。');
      }
    }
    return value;
  }
  async function saveRequests(value) { await noLinks(requestFile); await atomicJson(requestFile, value); }
  async function writeReceipt(t, value) { await noLinks(receiptFile(t)); await atomicJson(receiptFile(t), value); }
  async function pending(id) {
    const t = target(id), rows = [];
    if (fs.existsSync(journal.pendingPath(t.dir))) rows.push({ kind: 'file-journal', file: journal.pendingPath(t.dir) });
    if (fs.existsSync(driverPendingFile(t))) rows.push({ kind: 'driver-receipt', file: driverPendingFile(t) });
    if (fs.existsSync(externalPendingFile(t))) rows.push({ kind: 'external-config', file: externalPendingFile(t) });
    return rows;
  }
  async function assertReady(id) { const rows = await pending(id); if (rows.length) fail('SETTINGS_RECOVERY_FIRST', '上次文件或驱动设置尚未恢复，请先完成恢复。', { pending: rows }); return true; }
  async function inspectLaunchReadiness(id, observed = null) {
    const t = target(id), blockers = [];
    const add = (domain, code, message, details = {}) => {
      const { action, ...rest } = details;
      blockers.push({ domain, code, message, ...rest, action: typeof action === 'string' ? { kind: action } : action || null });
    };
    let rows = {}, requestError = null;
    try { rows = requests().games[t.key] || {}; }
    catch (error) { requestError = { code: error.code || 'SETTINGS_REQUESTS_INVALID', message: error.message || '保存的启动设置无法读取。' }; }
    const pendingRows = await pending(id);
    if (requestError) add('settings', requestError.code, requestError.message, { known: false, recovery: true, action: 'open-settings' });
    if (pendingRows.length) add('settings', 'SETTINGS_RECOVERY_FIRST', '上次文件或驱动设置尚未恢复，请先完成恢复。', { recovery: true, action: 'recover', pending: pendingRows });

    let legacy = null, legacyError = null;
    if (legacySrModel?.migrationInfo) {
      try { legacy = await legacySrModel.migrationInfo(id); }
      catch (error) { legacyError = { code: error.code || 'SETTINGS_LEGACY_MIGRATION', message: error.message || '旧 SR 状态无法确认。' }; }
    }
    const srOwned = Boolean(rows.sr || rows._srManaged);
    if (!srOwned && legacyError) add('sr', legacyError.code, legacyError.message, { known: false, recovery: true, action: 'open-settings' });
    else if (!srOwned && (legacy?.configured === true || legacy?.baselineCaptured === true))
      add('sr', 'SETTINGS_LEGACY_APPLY_REQUIRED', '仍有旧版 SR 选择或恢复记录；请先在增强设置中预览并应用或恢复。', { recovery: true, action: 'open-settings' });

    let stored = null, storedError = null;
    if (rows.sr || rows.fg) {
      try { stored = receipt(t).applied; }
      catch (error) { storedError = { code: error.code || 'SETTINGS_RECEIPT_INVALID', message: error.message || '启动设置恢复记录无法读取。' }; }
    }
    if (storedError) add('settings', storedError.code, storedError.message, { known: false, recovery: true, action: 'recover' });
    let readbackUnknown = false;
    for (const domain of ['sr', 'fg']) {
      const requestRow = rows[domain], request = requestRow?.request;
      if (!request) continue;
      if (domain === 'fg' && request.backend === 'rtx40') {
        add('fg', 'SETTINGS_FG_MIGRATION_REQUIRED', '旧补帧设置只保留恢复能力，请先迁移或撤销后再启动。', { recovery: true, action: 'migrate' });
        continue;
      }
      const saved = stored?.[domain], inspected = observed?.applied?.[domain];
      const applied = inspected || saved;
      if (!applied || !policy.same(applied.request, request)) {
        add(domain, 'SETTINGS_REQUIRE_APPLY', '存在尚未应用的设置，请在增强设置中确认并应用。', { action: 'open-settings' });
        continue;
      }
      if (inspected) {
        if (domain === 'fg' && request.backend === 'mfgunlock') {
          const current = observed?.current?.fg;
          if (!current?.valid) {
            add(domain, current?.error?.code || 'SETTINGS_MFG_CONFIG_UNAVAILABLE',
              current?.error?.message || '无法读取当前 MFG 配置。', { action: 'open-settings' });
            continue;
          }
          let exeUnchanged = true;
          if (inspected.exeHash) {
            try { exeUnchanged = inspected.exeHash === await digestFile(t.exe); } catch { exeUnchanged = false; }
          }
          if (!exeUnchanged) {
            add(domain, 'SETTINGS_EXE_CHANGED', '游戏程序已变化，请重新检查原补帧绑定。', { action: 'reapply' });
            continue;
          }
          try {
            const eligibility = await assessEligibility(id, domain, current.request);
            const blockers = (eligibility.blockers || []).filter(item => !(current.experimental && item.code === 'SETTINGS_MULTIPLIER_UNCONFIRMED'));
            if (blockers.length) add(domain, 'SETTINGS_BLOCKED', blockers.map(item => item.message).join('\n'), { action: 'open-settings' });
          } catch (error) {
            add(domain, error.code || 'SETTINGS_EVIDENCE_UNAVAILABLE', error.message || '当前 MFG 支持条件无法确认。', { known: false, action: 'open-settings' });
          }
          continue;
        }
        if (inspected.requiresReapply === true || inspected.readbackVerified === false || inspected.configVerified === false)
          add(domain, 'SETTINGS_REQUIRE_REAPPLY', '当前设置已被其他程序改变，请重新预览并明确应用。', { action: 'reapply' });
      } else readbackUnknown = true;
    }
    let visibleRequests = {};
    try { visibleRequests = savedRequests(id); } catch {}
    const state = blockers.length ? 'blocked' : readbackUnknown ? 'unknown' : 'ready';
    return { state, known: state !== 'unknown' && !blockers.some(row => row.known === false), blockers,
      source: observed ? 'settings-inspection' : 'metadata', pending: pendingRows, requests: visibleRequests, legacy: legacy || (legacyError ? { error: legacyError } : null) };
  }
  async function hasOwnedState(id) {
    const dir = options.gameDirectory(id);
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('ERR_UNKNOWN_GAME', '游戏目录无效。');
    const meta = journal.safePath(dir, '_DLSS5_Backup/xiaofeng-launch-settings.json');
    if (fs.existsSync(journal.pendingPath(dir)) || fs.existsSync(path.join(dir, '_DLSS5_Backup/launch-driver-pending.json')) || fs.existsSync(path.join(dir, '_DLSS5_Backup/launch-external-config-pending.json'))) return true;
    if (!fs.existsSync(meta)) return false;
    let value; try { value = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { fail('SETTINGS_RECEIPT_INVALID', '启动设置恢复记录无法解析。'); }
    if (!value || value.version !== 1 || !value.applied || typeof value.applied !== 'object') fail('SETTINGS_RECEIPT_INVALID', '启动设置恢复记录无效。');
    return Object.keys(value.applied).length > 0;
  }
  function requestRow(id, domain) { const t = target(id), state = requests(), row = state.games[t.key]?.[domain]; return row && samePath(row.exe, t.exe) ? row : null; }
  function savedRequests(id) { return Object.fromEntries(['sr','fg'].map(domain=>[domain,requestRow(id,domain)]).filter(([,row])=>row)); }
  // Once the new editor owns a game directory, never revive the old directory-
  // based model writer, including after a safe EXE change. Requests stay EXE-bound.
  async function hasSrRequest(id) { const t = target(id), row = requests().games[t.key]; return Boolean(row?.sr || row?._srManaged); }
  async function markSrManaged(t) { const state = requests(); state.games[t.key] = { ...(state.games[t.key] || {}), _srManaged: { exe: t.exe, managedAt: new Date().toISOString() } }; await saveRequests(state); }
  async function save(id, domain, input) {
    return serialize(async () => { const t = target(id), request = policy.validateRequest(domain, input), state = requests();
      if (request.backend === 'rtx40' && request.mode !== 'restore' && options.allowLegacyControl !== true)
        fail('SETTINGS_FG_MIGRATION_REQUIRED', '旧补帧方案只保留恢复能力，请先迁移到 MFG Unlock，再重新选择倍率。');
      state.games[t.key] = { ...(state.games[t.key] || {}), [domain]: { exe: t.exe, request, savedAt: new Date().toISOString() } };
      if (domain === 'sr') state.games[t.key]._srManaged = { exe: t.exe, managedAt: new Date().toISOString() };
      await saveRequests(state); return { saved: true, applied: false, nextLaunch: true };
    });
  }
  async function currentMfg(t, old = null) {
    try {
      const location = configuration(t, 'mfgunlock', old?.backend === 'mfgunlock' ? old : null);
      const text = await policy.readText(location.file, true);
      if (text === null) return old?.backend === 'mfgunlock' ? { backend: 'mfgunlock', source: 'active-ini', configFile: location.file,
        valid: false, error: { code: 'SETTINGS_BACKEND_MISSING', message: '当前 MFG 配置文件缺失，原恢复记录仍保留。' } } : null;
      const value = mfgConfig.current(text);
      if (!value.present && old?.backend !== 'mfgunlock') return null;
      const differsFromLastApplied = old?.backend === 'mfgunlock' && Object.keys(old.lastValues).some(key => !policy.same(value.raw[key], old.lastValues[key]));
      const observed = { ...value, backend: 'mfgunlock', source: 'active-ini', configFile: location.file, valid: true,
        sha256: policy.hash(text), differsFromLastApplied: Boolean(differsFromLastApplied),
        requiresRestart: true, readOnlyObserved: true, lastAppliedRequest: old?.backend === 'mfgunlock' ? clone(old.request) : null };
      if (old?.backend === 'mfgunlock') mfgObservations.set(observed, { exe: t.exe, exeHash: await digestFile(t.exe), configFile: location.file,
        request: clone(value.request), raw: clone(value.raw), beforeText: text, receipt: clone(old) });
      return observed;
    } catch (error) { return { backend: 'mfgunlock', source: 'active-ini', valid: false,
      error: { code: error.code || 'SETTINGS_MFG_CONFIG_UNAVAILABLE', message: error.message }, runtimeVerified: false }; }
  }
  async function inspect(id) {
    const t = target(id), row = requests().games[t.key] || {}, pendingRows = await pending(id), applied = {};
    let stored = {}, receiptError = null;
    try { stored = receipt(t).applied; }
    catch (error) {
      if (!pendingRows.length) throw error;
      receiptError = { code: error.code || 'SETTINGS_RECEIPT_INVALID', message: error.message };
    }
    let driverCurrent = null;
    for (const [domain, value] of Object.entries(stored)) {
      let readbackVerified = false;
      try {
        if (['native', 'nvidia'].includes(value.backend)) { driverCurrent ||= await driver.read(t.exe, DRIVER_IDS); readbackVerified = policy.same(driverCurrent.profile, value.profile) && policy.same(subset(driverCurrent, value.ids), value.lastValues); }
        else { const file = value.backend === 'mfgunlock' ? configuration(t, value.backend, value).file : path.join(path.dirname(t.exe), value.name); const text = await policy.readText(file); const now = policy.values(text, value.backend); readbackVerified = Object.keys(value.lastValues).every(key => policy.same(now[key], value.lastValues[key])); }
      } catch {}
      if (value.exeHash && value.exeHash !== await digestFile(t.exe)) readbackVerified = false;
      applied[domain] = { ...value, readbackVerified, requiresReapply: !readbackVerified, runtimeVerified: false };
    }
    const currentFg = await currentMfg(t, stored.fg);
    if (applied.fg?.backend === 'mfgunlock' && currentFg?.valid && (!applied.fg.exeHash || applied.fg.exeHash === await digestFile(t.exe))) {
      applied.fg.requiresReapply = false;
      applied.fg.configurationChanged = currentFg.differsFromLastApplied;
    }
    let legacy = null;
    if (legacySrModel?.migrationInfo) {
      try { legacy = { ...await legacySrModel.migrationInfo(id), managed: await hasSrRequest(id) }; }
      catch (error) { legacy = { managed: await hasSrRequest(id), error: { code: error.code || 'SETTINGS_LEGACY_MIGRATION', message: error.message } }; }
    }
    const visibleRequests = Object.fromEntries(['sr', 'fg'].filter(domain => row[domain]).map(domain => [domain, row[domain]]));
    const notice = receiptError ? '检测到未完成事务，当前启动设置记录需要先恢复。' : legacy?.error ? '旧 SR 设置需要核对；FG 状态和恢复功能仍可使用。' : null;
    let driverScope;
    if (driverCurrent?.profile?.scope) driverScope={name:driverCurrent.profile.name,...driverCurrent.profile.scope,shared:true};
    else if (typeof driver.inspectScope === 'function') {
      const cached=scopeReads.get(t.exe);
      if (!cached || Date.now()-cached.at > 1000) {
        if (scopeReads.size >= 64) scopeReads.delete(scopeReads.keys().next().value);
        scopeReads.set(t.exe,{at:Date.now(),promise:Promise.resolve().then(()=>driver.inspectScope(t.exe)).catch(error=>({error:error.code||'NVAPI_SCOPE_UNAVAILABLE',message:'暂时无法读取 NVIDIA 游戏配置范围；原样启动不受影响。'}))});
      }
      driverScope=await scopeReads.get(t.exe).promise;
    }
    const featureStates = Object.fromEntries(await Promise.all(['sr', 'fg'].map(async domain => {
      try { return [domain, await assessEligibility(id, domain)]; }
      catch (error) { return [domain, { domain, eligible: false, state: 'unavailable', blockers: [{ code: error.code || 'SETTINGS_EVIDENCE_UNAVAILABLE', message: error.message }], runtimeVerified: false }]; }
    })));
    return { hardware: await detectHardware(), requests: visibleRequests, applied, legacy, driverScope, featureStates, pending: pendingRows, notice, receiptError, runtimeVerified: false,
      current: { ...(currentFg ? { fg: currentFg } : {}) },
      note: '配置读回只证明文件或驱动请求已保存，不代表游戏实际采用。' };
  }
  async function assertStopped(t) {
    if (!environment) { await assertGameClosed(t.dir, t.exe); return; }
    const env = await environment(t.dir, t.exe);
    if (!env || env.verified !== true) fail('PROCESS_UNKNOWN', '无法确认游戏已退出，暂不写入启动设置。');
    if (Array.isArray(env.running) && env.running.length) fail('GAME_RUNNING', '游戏仍在运行，请完全退出后重试。');
  }
  async function preview(id, domain, input, previewOptions = {}) {
    const t = target(id); await assertReady(id); await noLinks(t.exe);
    const compensation = previewOptions[MFG_COMPENSATION] || null;
    const saved = requestRow(id, domain), request = policy.validateRequest(domain, input || saved?.request);
    const currentReceipt = receipt(t), old = currentReceipt.applied[domain] || null, restoring = policy.isRestore(domain, request);
    if (request.backend === 'rtx40' && !restoring && options.allowLegacyControl !== true)
      fail('SETTINGS_FG_MIGRATION_REQUIRED', '旧补帧方案只保留恢复能力，请先迁移并重新选择设置。');
    let preparation = null;
    if (domain === 'fg' && !restoring && !compensation && options.assertComponents) {
      try { await options.assertComponents(id, request.backend); }
      catch (error) {
        if (previewOptions.allowComponentPreparation === true && request.backend === 'mfgunlock' &&
            ['SETTINGS_COMPONENTS_NOT_READY', 'SETTINGS_FG_COMPONENTS_REQUIRED'].includes(error.code))
          preparation = { required: true, backend: 'mfgunlock', code: error.code, message: error.message };
        else throw error;
      }
    }
    if (old && !samePath(old.exe, t.exe)) fail('SETTINGS_EXE_CHANGED', '请先恢复原 EXE 的启动设置。');
    if (old && old.backend !== request.backend && !restoring) fail('SETTINGS_RESTORE_FIRST', '请先恢复当前设置后端。');
    const plan = { id: crypto.randomUUID(), expires: Date.now() + 120000, gameId: id, domain, request, backend: restoring && old ? old.backend : request.backend,
      target: t, exeHash: await digestFile(t.exe), restoring, compensation, old: clone(old), receipt: currentReceipt, preparation, warnings: [], blockers: [], externalChanges: [], driver: null, change: null, operations: [], noOp: false, requiresReview: false };
    const hardware = await detectHardware();
    const series = [...new Set(Array.isArray(hardware?.series) ? hardware.series : [])];
    if (!restoring && !compensation) {
      plan.eligibility = await assessEligibility(id, domain, request);
      plan.blockers.push(...plan.eligibility.blockers.map(row => row.message));
      plan.warnings.push(...(plan.eligibility.warnings || []).map(row => row.message));
    }
    if (restoring && !old) plan.noOp = true;
    else if (['native', 'nvidia'].includes(plan.backend)) {
      if (plan.backend === 'nvidia' && !restoring && !(series.length === 1 && series[0] === 'RTX50')) plan.blockers.push('未唯一确认 RTX 50，官方 FG 请求不会写入。');
      const before = await driver.read(t.exe, DRIVER_IDS), after = clone(before);
      const operations = restoring ? [] : (plan.backend === 'native' ? policy.nativeSr(request, hardware) : policy.nativeFg(request)).operations;
      plan.operations = clone(operations);
      const ids = restoring ? old.ids : [...new Set([...(old?.ids || []), ...operations.map(row => row.id)])];
      if (old && !policy.same(before.profile, old.profile)) fail('SETTINGS_EXTERNAL_CHANGE', '驱动配置身份或关联范围已被其他工具改变，不能沿用原恢复记录。');
      const changed = old ? old.ids.filter(id => !policy.same(before.settings[id], old.lastValues[id])) : [];
      if (changed.length && (restoring || previewOptions.reapplyExternalChanges !== true)) fail('SETTINGS_EXTERNAL_CHANGE', '驱动设置已被其他工具改变，请显式重新预览当前值后应用。');
      const baseline = clone(old?.baseline || before);
      for (const id of changed) {
        baseline.settings[id] = clone(before.settings[id]);
        plan.externalChanges.push({ kind: 'driver-setting', id, previousApplied: clone(old.lastValues[id]), current: clone(before.settings[id]) });
      }
      for (const settingId of ids) if (!old?.ids.includes(settingId)) baseline.settings[settingId] = clone(before.settings[settingId]);
      if (restoring) {
        for (const settingId of ids) after.settings[settingId] = clone(baseline.settings[settingId]);
        const other = Object.entries(currentReceipt.applied).some(([name, value]) => name !== domain && ['native', 'nvidia'].includes(value.backend));
        if (!other && !currentReceipt.driverOriginalProfile && !Object.values(after.settings).some(value => value.kind === 'explicit')) after.profile = null;
      } else for (const operation of operations) after.settings[operation.id] = { kind: 'explicit', value: operation.value, location: 0, predefined: false };
      plan.driver = { before, after, ids, baseline };
      plan.noOp = !restoring && policy.same(subset(before, ids), subset(after, ids));
      if (!plan.noOp && before.profile && !validProfile(before.profile, t))
        plan.blockers.push('当前 NVIDIA 配置不是可确认的游戏官方配置或独立 EXE 配置，未修改参数；原样启动游戏不受影响。');
    } else {
      if (['rtx40', 'mfgunlock'].includes(plan.backend) && !restoring && !compensation && !(series.length === 1 && series[0] === 'RTX40')) plan.blockers.push('未唯一确认 RTX 40，社区 FG 请求不会写入。');
      const controlRoot = path.dirname(t.exe);
      const name = old?.name || await policy.controlPath(controlRoot, plan.backend);
      const location = plan.backend === 'mfgunlock' ? configuration(t, plan.backend, old) : { file: path.join(controlRoot, name), external: false };
      const file = location.file;
      const beforeFile = await policy.readText(file, true);
      if (beforeFile === null && (plan.backend !== 'mfgunlock' || old || restoring)) fail('SETTINGS_BACKEND_MISSING', '没有找到该后端的现有配置。');
      const before = beforeFile ?? '';
      const currentValues = policy.values(before, plan.backend);
      const changed = old ? Object.keys(old.lastValues).filter(key => !policy.same(currentValues[key], old.lastValues[key])) : [];
      if (compensation && changed.length && !policy.same(currentValues, compensation.raw))
        fail('SETTINGS_EXTERNAL_CHANGE', '本次 MFG 应用后配置又被外部修改，未覆盖新值。');
      if (plan.backend === 'mfgunlock') mfgConfig.current(before);
      if (changed.length && plan.backend !== 'mfgunlock' && (restoring || previewOptions.reapplyExternalChanges !== true)) fail('SETTINGS_EXTERNAL_CHANGE', '本工具接管的配置键已被外部修改，请显式重新预览当前值后应用。');
      let content, baselineText = old?.baselineText ?? before;
      if (changed.length) {
        if (plan.backend !== 'mfgunlock') {
          const priorBaseline = policy.values(baselineText, plan.backend);
          baselineText = policy.restoreText(baselineText, before, Object.fromEntries(changed.map(key => [key, priorBaseline[key]])), plan.backend);
        }
        plan.externalChanges.push(...changed.map(key => ({ kind: 'config-key', key, previousApplied: old.lastValues[key], current: currentValues[key] })));
      }
      const baselineMissing = old?.baselineMissing === true || !old && beforeFile === null;
      if (restoring) content = policy.restoreText(before, baselineText, plan.backend === 'mfgunlock'
        ? Object.fromEntries(Object.keys(old.lastValues).map(key => [key, currentValues[key]])) : old.lastValues, plan.backend);
      else if (compensation) content = mfgConfig.restore(before, compensation.beforeText, currentValues);
      else { const result = policy.compileFile(before, request); content = result.content; plan.warnings.push(...result.warnings); plan.requiresReview = result.requiresReview === true; }
      const afterValues = policy.values(content, plan.backend), keys = Object.keys(afterValues).filter(key => !policy.same(currentValues[key], afterValues[key]));
      if (old && !restoring) {
        const newlyOwned = keys.filter(key => !Object.hasOwn(old.lastValues, key));
        if (newlyOwned.length) {
          // A key first changed by this request belongs to its current value,
          // not to an unrelated value captured when another key was acquired.
          const baselineValues = policy.values(baselineText, plan.backend);
          baselineText = policy.restoreText(baselineText, before,
            Object.fromEntries(newlyOwned.map(key => [key, baselineValues[key]])), plan.backend);
        }
      }
      plan.operations = keys.map(key => ({ action: restoring ? 'restore-config-key' : 'set-config-key', key }));
      const owned = [...new Set([...Object.keys(old?.lastValues || {}), ...keys])];
      const deleteAfter = restoring && baselineMissing && content.trim() === '';
      plan.change = { name, file, external: location.external, beforeText: beforeFile, beforeHash: beforeFile === null ? null : policy.hash(before), afterHash: deleteAfter ? null : policy.hash(content), content, baselineText,
        baselineMissing, deleteAfter,
        lastValues: Object.fromEntries(owned.map(key => [key, afterValues[key]])) };
      plan.noOp = !restoring && plan.change.beforeHash === plan.change.afterHash;
    }
    if (plan.externalChanges.length) {
      if (plan.backend !== 'mfgunlock') plan.requiresReview = true;
      plan.noOp = false;
      plan.warnings.push(plan.backend === 'mfgunlock'
        ? '预览已包含活动 MFG 配置中的新值；只有本次明确应用才会修改，最初恢复基线保持不变。'
        : '已按本次明确重应用请求更新被外部修改的键；以后恢复将保留这些外部新值。');
    }
    // Explicit Apply may validate values already installed by another tool.
    // Record that exact baseline without issuing redundant backend writes, so
    // a subsequent read-only launch can distinguish this from an unapproved draft.
    if (!restoring && plan.noOp && (!old || !policy.same(old.request, request) || old.exeHash !== plan.exeHash)) {
      plan.recordOnly = true; plan.noOp = false;
      if (plan.change && !Object.keys(plan.change.lastValues).length) plan.change.lastValues = policy.values(plan.change.content, plan.backend);
    }
    if (compensation) { plan.recordOnly = plan.change.beforeHash === plan.change.afterHash; plan.noOp = false; }
    plans.set(plan.id, plan);
    return { id: plan.id, gameId: id, domain, backend: plan.backend, request, exe: t.exe,
      destination: plan.driver ? 'NVIDIA 每游戏配置' : plan.change ? path.relative(t.dir, plan.change.file) : null,
      operations: clone(plan.operations), externalChanges: clone(plan.externalChanges), warnings: plan.warnings, blockers: plan.blockers,
      noOp: plan.noOp, recordOnly: plan.recordOnly === true, requiresReview: plan.requiresReview, preparation, eligibility: plan.eligibility || null, driverSettings: plan.driver?.ids || [], runtimeVerified: false };
  }
  function sameOwned(actual, expected, ids) { return ids.every(id => expected.settings[id].kind === 'explicit'
    ? policy.same(actual.settings[id], expected.settings[id]) : actual.settings[id].kind !== 'explicit'); }
  async function publishExternalConfig(t, configFile, content, expectedBefore) {
    const bound = { name: 'ReShade.ini', configFile }, location = configuration(t, 'mfgunlock', bound);
    if (!location.external) fail('SETTINGS_LAYOUT_CHANGED', '外置配置提交范围与当前布局不一致。');
    const expectedAfter = content === null ? null : policy.hash(content);
    const temporary = path.join(path.dirname(location.file), `.ReShade.ini.mfg-${crypto.randomUUID()}.tmp`);
    let handle, created = false;
    try {
      await noLinks(location.file);
      if (content !== null) {
        await noLinks(temporary); handle = await fsp.open(temporary, 'wx', 0o600); created = true;
        await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close(); handle = null;
        await noLinks(temporary);
        if (await digestFile(temporary) !== expectedAfter) fail('WRITE_VERIFY_FAILED', '外置配置暂存内容校验失败，原配置未修改。');
      }
      // Finish all asynchronous preparation before the final target check.
      // A failed or interrupted temporary write never truncates the active INI.
      await assertStopped(t);
      const fresh = configuration(t, 'mfgunlock', bound);
      if (!fresh.external || !samePath(fresh.file, location.file)) fail('SETTINGS_LAYOUT_CHANGED', '外置配置位置在提交前改变。');
      await noLinks(location.file);
      if (await digestFile(location.file) !== expectedBefore) fail('SETTINGS_EXTERNAL_CHANGE', '外置配置在提交前被其他程序修改，未覆盖。');
      if (content === null) { if (expectedBefore !== null) await fsp.unlink(location.file); }
      else await fsp.rename(temporary, location.file);
      if (await digestFile(location.file) !== expectedAfter) fail('WRITE_VERIFY_FAILED', '外置配置提交后校验失败。');
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) await fsp.unlink(temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    }
  }
  async function previewMfgCompensation(id, observed) {
    const snapshot = mfgObservations.get(observed), t = target(id);
    // Only an object actually issued to this in-process workflow can authorize
    // compensation. Renderer JSON cannot manufacture this observation token.
    if (!snapshot || !samePath(snapshot.exe, t.exe) || await digestFile(t.exe) !== snapshot.exeHash ||
        !samePath(configuration(t, 'mfgunlock', snapshot.receipt).file, snapshot.configFile))
      fail('SETTINGS_MFG_COMPENSATION_INVALID', '本轮 MFG 原设置快照无效或目标已改变。');
    return preview(id, 'fg', snapshot.request, { [MFG_COMPENSATION]: snapshot });
  }
  async function restoreExternalPending(t, forceRestore = false) {
    const file = externalPendingFile(t); await noLinks(file); if (!fs.existsSync(file)) return false;
    if (fs.statSync(file).size > 2 * 1024 * 1024) fail('SETTINGS_RECEIPT_INVALID', '外置配置恢复记录过大。');
    const row = readJson(file, null);
    if (row?.version !== 1 || row.owner !== 'launch-mfg-config' || !samePath(row.exe, t.exe) || row.domain !== 'fg' ||
        !/^[a-f0-9-]{36}$/.test(row.transactionId || '') || typeof row.restoring !== 'boolean' ||
        !(row.beforeText === null || typeof row.beforeText === 'string' && Buffer.byteLength(row.beforeText) <= 1024 * 1024) ||
        row.beforeHash !== (row.beforeText === null ? null : policy.hash(row.beforeText)) ||
        !(row.afterHash === null || /^[a-f0-9]{64}$/.test(row.afterHash))) fail('SETTINGS_RECEIPT_INVALID', '外置 MFG 配置恢复记录无效。');
    const location = configuration(t, 'mfgunlock', { name: 'ReShade.ini', configFile: row.configFile });
    if (!location.external) fail('SETTINGS_LAYOUT_CHANGED', '外置恢复范围与当前布局不一致。');
    const actual = await digestFile(location.file); await noLinks(location.file);
    if (actual !== row.beforeHash && actual !== row.afterHash) fail('SETTINGS_EXTERNAL_CHANGE', '外置配置在操作中断后被其他程序修改，已保留恢复记录。');
    const state = receipt(t);
    const committed = !forceRestore && !fs.existsSync(journal.pendingPath(t.dir)) && state.lastTransaction?.id === row.transactionId &&
      state.lastTransaction?.domain === 'fg' && state.lastTransaction?.restoring === row.restoring && actual === row.afterHash;
    if (!committed && actual !== row.beforeHash) {
      await publishExternalConfig(t, location.file, row.beforeText, actual);
      if (await digestFile(location.file) !== row.beforeHash) fail('WRITE_VERIFY_FAILED', '外置配置恢复后校验失败。');
    }
    await fsp.unlink(file); return !committed;
  }
  async function restoreDriverPending(t, forceRestore = false) {
    const file = driverPendingFile(t); if (!fs.existsSync(file)) return false;
    const row = readJson(file, null);
    // dev.7/8 could persist a read-only shared-profile snapshot before the
    // native adapter refused the write. Retire that record only when all eight
    // settings AND the profile still match its exact pre-write state. Never use
    // this compatibility branch to write or restore a shared application profile.
    const sharedSnapshot = value => value?.profile && value.profile.exclusive === false && value.profile.owned === false &&
      typeof value.profile.name === 'string' && value.profile.name.length <= 2048 &&
      typeof value.profile.appName === 'string' && value.profile.appName.length <= 2048 &&
      value.settings && Object.keys(value.settings).length === DRIVER_IDS.length && DRIVER_IDS.every(id => validSetting(value.settings[id]));
    if (row?.version === 1 && /^[a-f0-9-]{36}$/.test(row.transactionId || '') && samePath(row.exe,t.exe) &&
        ['sr','fg'].includes(row.domain) && row.restoring === false && row.after === null &&
        Array.isArray(row.ids) && row.ids.length && new Set(row.ids).size === row.ids.length && row.ids.every(id => policy.IDS[row.domain].includes(id)) &&
        sharedSnapshot(row.before) && sharedSnapshot(row.desired) && !row.before.profile.scope && !row.desired.profile.scope && policy.same(row.before.profile,row.desired.profile) &&
        DRIVER_IDS.filter(id => !row.ids.includes(id)).every(id => policy.same(row.before.settings[id],row.desired.settings[id]))) {
      const actual = await driver.read(t.exe, DRIVER_IDS);
      const originalProfile=Object.fromEntries(['name','appName','exclusive','owned'].map(key=>[key,actual.profile?.[key]]));
      if (!policy.same(originalProfile,row.before.profile) || !policy.same(actual.settings,row.before.settings)) fail('SETTINGS_EXTERNAL_CHANGE','旧失败记录对应的驱动配置已有变化，不能按“未写入”清理；已保留恢复记录。');
      await fsp.unlink(file); return true;
    }
    if (!row || row.version !== 1 || !/^[a-f0-9-]{36}$/.test(row.transactionId || '') || !samePath(row.exe, t.exe) || !['sr', 'fg'].includes(row.domain) || typeof row.restoring !== 'boolean' ||
        !Array.isArray(row.ids) || !row.ids.length || new Set(row.ids).size !== row.ids.length || row.ids.some(id => !policy.IDS[row.domain].includes(id)) || !validSnapshot(row.before, t) || !validSnapshot(row.desired, t) || row.after != null && !validSnapshot(row.after, t)) fail('SETTINGS_RECEIPT_INVALID', '驱动恢复记录无效。');
    const current = await driver.read(t.exe, DRIVER_IDS);
    if (!forceRestore && !fs.existsSync(journal.pendingPath(t.dir))) {
      const state = receipt(t), applied = state.applied[row.domain];
      const committed = state.lastTransaction?.id === row.transactionId && state.lastTransaction?.domain === row.domain &&
        (row.restoring ? !applied : applied && samePath(applied.exe, t.exe) && sameOwned(current, row.after || row.desired, row.ids));
      if (committed) { await fsp.unlink(file); return false; }
    }
    if (!sameOwned(current, row.before, row.ids) && !sameOwned(current, row.after || row.desired, row.ids)) fail('SETTINGS_EXTERNAL_CHANGE', '驱动设置在中断后被外部修改。');
    if (!sameOwned(current, row.before, row.ids)) { const desired = clone(current); for (const id of row.ids) desired.settings[id] = clone(row.before.settings[id]); desired.profile = clone(row.before.profile); if (desired.profile === null && Object.values(desired.settings).some(value => value.kind === 'explicit')) desired.profile = clone(current.profile); await driver.write(t.exe, current, desired); }
    await fsp.unlink(file); return true;
  }
  async function recover(id) {
    return serialize(async () => { const t = target(id); await assertStopped(t);
      const pendingFile = journal.pendingPath(t.dir);
      if (fs.existsSync(pendingFile)) {
        await noLinks(pendingFile);
        if (fs.statSync(pendingFile).size > 2 * 1024 * 1024) fail('SETTINGS_RECEIPT_INVALID', '文件恢复记录大小无效。');
        const pending = JSON.parse(await fsp.readFile(pendingFile, 'utf8'));
        if (pending.files?.some(row => String(row.rel || '').replace(/\\/g, '/').toLowerCase() === '_dlss5_backup/reframework-preparation.json'))
          fail('REF_RECOVERY_REQUIRED', 'REFramework 有未完成操作，请在“RE 引擎兼容”区域恢复，以保留外部新出现的文件。');
        if (pending.files?.some(row => {
          const rel = String(row.rel || '').replace(/\\/g, '/').toLowerCase();
          return rel === '_dlss5_backup/xiaofeng-feeder.json' || /(?:^|\/)_dlss5_feeder\//.test(rel) || rel.startsWith('_dlss5_backup/feeder-settings/');
        })) fail('FEEDER_RECOVERY_REQUIRED', 'Feeder 有未完成操作，请在游戏卡片中选择“恢复并卸载 Feeder”，保留外部修改检查。');
        if (pending.owner && pending.owner.product !== 'xiaofeng-fg-components')
          fail('SETTINGS_RECOVERY_OWNER', '此文件事务属于其他组件，请使用对应的专用恢复入口。');
        if (pending.owner?.product === 'xiaofeng-fg-components' || pending.files?.some(row => {
          const rel = String(row.rel || '').replace(/\\/g, '/').toLowerCase();
          return ['_dlss5_backup/xiaofeng-fg-components.json', '_dlss5_backup/xiaofeng-fg-migration.json'].includes(rel) ||
            rel.startsWith('_dlss5_backup/.fg-migration/') ||
            ['renodx-mfgunlock.addon64', 'rtx40mfgcore.dll', 'rtx40mfg.asi', 'rtx40mfg-ui.addon64', 'rtx40mfg-universal.json'].includes(path.posix.basename(rel));
        })) fail('SETTINGS_FG_FILE_RECOVERY_REQUIRED', '补帧组件文件操作未完成，请在 FG 区域选择“恢复未完成组件操作”。');
      }
      const driverRestored = await restoreDriverPending(t);
      const externalRestored = await restoreExternalPending(t);
      const filesRestored = fs.existsSync(journal.pendingPath(t.dir)) ? await journal.recover(t.dir) : false;
      return { recovered: driverRestored || externalRestored || filesRestored, driverRestored, externalRestored, filesRestored };
    });
  }
  async function apply(planId, consent = {}) {
    return serialize(async () => {
      let plan = plans.get(planId); plans.delete(planId);
      if (!plan || plan.expires < Date.now()) fail('PLAN_EXPIRED', '预览已过期。');
      if (plan.preparation) fail('SETTINGS_PREPARATION_REQUIRED', '请先准备组件，再重新预览并应用设置。');
      if (consent.confirm !== true) fail('CONFIRM_REQUIRED', '请确认预览后再应用。');
      if (consent.automatic === true && plan.requiresReview && !plan.noOp) fail('SETTINGS_REVIEW_REQUIRED', '兼容补帧组件已启用“仅显示生成帧”调试模式。请先在组件中关闭此模式，再重试；当前配置与备份已保留。');
      if (plan.blockers.length) fail('SETTINGS_BLOCKED', plan.blockers.join('\n'));
      await assertReady(plan.gameId); const t = target(plan.gameId);
      if (!samePath(t.exe, plan.target.exe)) fail('SETTINGS_EXE_CHANGED', '游戏 EXE 已改变。');
      await noLinks(t.exe);
      if (!plan.restoring && peBitness(t.exe) !== 64) fail('SETTINGS_EXE_INVALID', '启动设置只支持当前绑定的 Windows x64 游戏 EXE。');
      if (!plan.restoring && (!plan.exeHash || await digestFile(t.exe) !== plan.exeHash)) fail('SETTINGS_EXE_CHANGED', '游戏 EXE 在预览后改变。');
      if (plan.change && plan.backend === 'mfgunlock' && !samePath(configuration(t, plan.backend, plan.old).file, plan.change.file))
        fail('SETTINGS_LAYOUT_CHANGED', '活动配置在预览后改变，请重新核对。');
      if (!plan.restoring && !plan.compensation) {
        const eligibility = await assessEligibility(plan.gameId, plan.domain, plan.request);
        if (!eligibility.eligible) fail('SETTINGS_BLOCKED', eligibility.blockers.map(row => row.message).join('\n'), { eligibility });
      }
      await assertStopped(t);
      if (plan.domain === 'fg' && !plan.restoring && !plan.compensation && options.assertComponents) await options.assertComponents(plan.gameId, plan.request.backend);
      if (plan.domain === 'sr' && legacySrModel?.migrationInfo) {
        const info = await legacySrModel.migrationInfo(plan.gameId);
        if (info?.baselineCaptured) {
          await legacySrModel.prepareMigration(plan.gameId);
          const replacement = await preview(plan.gameId, plan.domain, plan.request);
          plan = plans.get(replacement.id); plans.delete(replacement.id);
        }
      }
      // A no-op is a claim about current state, not just the old preview.
      // Recheck before reporting a successful skip; never overwrite a newer
      // external change or silently launch with a request no longer in effect.
      // An empty restore has no backend snapshot and remains a true no-op.
      if (plan.noOp) {
        if (plan.driver && !policy.same(await driver.read(t.exe, DRIVER_IDS), plan.driver.before))
          fail('SETTINGS_EXTERNAL_CHANGE', '驱动配置在预览后改变，请重新核对后应用。');
        if (plan.change && await digestFile(plan.change.file) !== plan.change.beforeHash)
          fail('FILE_CHANGED', '配置在预览后改变，请重新核对后应用。');
      }
      if (plan.domain === 'sr') await markSrManaged(t);
      if (plan.noOp) return { applied: false, skipped: true, noOp: true, runtimeVerified: false };
      const transactionId = crypto.randomUUID(); let result;
      try { result = await journal.transaction(t.dir, async () => {
        const metaFile = receiptFile(t); await journal.capture(t.dir, metaFile);
        const currentReceipt = receipt(t, { allowEmptyRebind: !plan.old && Object.keys(plan.receipt.applied).length === 0 });
        if (plan.compensation && !policy.same(currentReceipt.applied.fg, plan.old))
          fail('SETTINGS_EXTERNAL_CHANGE', 'MFG 收据在补偿预览后改变，保留当前设置。');
        if (plan.change && plan.recordOnly) {
          await noLinks(plan.change.file);
          if (await digestFile(plan.change.file) !== plan.change.beforeHash) fail('FILE_CHANGED', '配置在预览后改变。');
        } else if (plan.change) {
          if (plan.change.external) {
            const row = { version: 1, owner: 'launch-mfg-config', transactionId, domain: 'fg', restoring: plan.restoring, exe: t.exe,
              configFile: plan.change.file, beforeText: plan.change.beforeText, beforeHash: plan.change.beforeHash, afterHash: plan.change.afterHash };
            await noLinks(plan.change.file); await atomicJson(externalPendingFile(t), row);
          } else await journal.capture(t.dir, plan.change.file);
          if (await digestFile(plan.change.file) !== plan.change.beforeHash) fail('FILE_CHANGED', '配置在预览后改变。');
          await noLinks(plan.change.file);
          if (plan.change.external) await publishExternalConfig(t, plan.change.file, plan.change.deleteAfter ? null : plan.change.content, plan.change.beforeHash);
          else if (plan.change.deleteAfter) await fsp.unlink(plan.change.file);
          else await fsp.writeFile(plan.change.file, plan.change.content, 'utf8');
          if (await digestFile(plan.change.file) !== plan.change.afterHash) fail('WRITE_VERIFY_FAILED', '配置写入后校验失败。');
        }
        let driverAfter = null;
        if (plan.driver) {
          const current = await driver.read(t.exe, DRIVER_IDS);
          if (!policy.same(current, plan.driver.before)) fail('SETTINGS_EXTERNAL_CHANGE', '驱动配置在预览后改变。');
          if (plan.recordOnly) driverAfter = current;
          else {
          const pendingFile = driverPendingFile(t), row = { version: 1, transactionId, domain: plan.domain, restoring: plan.restoring, exe: t.exe, ids: plan.driver.ids, before: current, desired: plan.driver.after, after: null };
          await noLinks(pendingFile); await atomicJson(pendingFile, row);
          try { driverAfter = await driver.write(t.exe, current, plan.driver.after); row.after = driverAfter; await atomicJson(pendingFile, row); }
          catch (error) {
            try { await restoreDriverPending(t); } catch (recoveryError) { throw Object.assign(new Error('驱动设置恢复未完成。'), { code: 'SETTINGS_RECOVERY_FIRST', cause: error, recoveryError }); }
            throw error;
          }
          }
        }
        const next = clone(currentReceipt.applied);
        if (plan.restoring) delete next[plan.domain];
        else if (plan.compensation) next[plan.domain] = clone(plan.compensation.receipt);
        else if (plan.driver) next[plan.domain] = { exe: t.exe, exeHash: plan.exeHash, backend: plan.backend, request: plan.request, profile: driverAfter.profile, ids: plan.driver.ids,
          baseline: plan.driver.baseline, lastValues: subset(driverAfter, plan.driver.ids), runtimeVerified: false };
        else next[plan.domain] = { exe: t.exe, exeHash: plan.exeHash, backend: plan.backend, request: plan.request, name: plan.change.name,
          ...(plan.backend === 'mfgunlock' ? { configFile: plan.change.file } : {}),
          baselineText: plan.change.baselineText, ...(plan.backend === 'mfgunlock' ? { baselineMissing: plan.change.baselineMissing } : {}),
          lastValues: plan.change.lastValues, runtimeVerified: false };
        if (plan.driver && !Object.values(currentReceipt.applied).some(value => ['native', 'nvidia'].includes(value.backend)))
          currentReceipt.driverOriginalProfile = clone(plan.driver.before.profile);
        currentReceipt.applied = next; currentReceipt.lastTransaction = { id: transactionId, domain: plan.domain, restoring: plan.restoring }; await writeReceipt(t, currentReceipt);
        return { applied: true, transaction: 'file-journal', configurationUnchanged: plan.recordOnly === true, runtimeVerified: false };
      }); } catch (error) {
        if (plan.change?.external && fs.existsSync(externalPendingFile(t))) {
          try { await restoreExternalPending(t, true); }
          catch (recoveryError) { throw Object.assign(new Error('外置配置恢复未完成，请先恢复。'), { code: 'SETTINGS_RECOVERY_FIRST', cause: error, recoveryError }); }
        }
        if (plan.driver && fs.existsSync(driverPendingFile(t))) {
          try { await restoreDriverPending(t, true); }
          catch (recoveryError) { throw Object.assign(new Error('驱动设置恢复未完成。'), { code: 'SETTINGS_RECOVERY_FIRST', cause: error, recoveryError }); }
        }
        throw error;
      }
      if (plan.driver && !plan.recordOnly) await fsp.unlink(driverPendingFile(t));
      if (plan.change?.external && !plan.recordOnly) await fsp.unlink(externalPendingFile(t));
      return result;
    });
  }
  async function restore(id, domain) {
    const t = target(id), current = receipt(t).applied[domain];
    const backend = current?.backend || (domain === 'sr' ? 'native' : 'nvidia');
    const request = domain === 'sr' ? { backend, quality: 'game' } : { backend, mode: 'restore' };
    const plan = await preview(id, domain, request), result = await apply(plan.id, { confirm: true });
    const state = requests();
    if (state.games[t.key]) { delete state.games[t.key][domain]; if (!Object.keys(state.games[t.key]).length) delete state.games[t.key]; await saveRequests(state); }
    return result;
  }
  async function beforeLaunch(id) {
    const t = target(id), rows = requests().games[t.key] || {}, outcomes = [], state = await inspect(id);
    for (const domain of ['sr', 'fg']) {
      const row = rows[domain]; if (!row) continue;
      if (!samePath(row.exe, t.exe)) { outcomes.push({ domain, applied: false, code: 'SETTINGS_EXE_CHANGED', reason: '请求属于另一个 EXE。' }); continue; }
      try {
        const applied = state.applied[domain];
        if (!applied || !policy.same(applied.request, row.request)) fail('SETTINGS_REQUIRE_APPLY', '存在尚未应用的设置，请在统一应用页确认后应用。');
        if (row.request.backend === 'mfgunlock') {
          if (applied.exeHash && applied.exeHash !== await digestFile(t.exe)) fail('SETTINGS_EXE_CHANGED', '游戏程序已变化，请重新检查原补帧绑定。');
          const current = state.current?.fg;
          if (!current?.valid) fail(current?.error?.code || 'SETTINGS_MFG_CONFIG_UNAVAILABLE', current?.error?.message || '无法读取当前 MFG 配置。');
          const eligibility = await assessEligibility(id, domain, current.request);
          // A valid experimental value saved in the in-game panel is existing
          // state, not a new Manager request. Observe it without promoting it to
          // a supported Manager option or silently rewriting it at launch.
          const blockers = eligibility.blockers.filter(item => !(current.experimental && item.code === 'SETTINGS_MULTIPLIER_UNCONFIRMED'));
          if (blockers.length) fail('SETTINGS_BLOCKED', blockers.map(item => item.message).join('\n'));
          outcomes.push({ domain, applied: false, skipped: true, noOp: true, source: 'active-ini', currentRequest: clone(current.request),
            configurationChanged: current.differsFromLastApplied, readbackVerified: true, runtimeVerified: false,
            warnings: current.experimental ? ['当前游戏内配置使用实验倍率；管理器未写入或确认其支持。'] : [] });
          continue;
        }
        if (!applied.readbackVerified) fail('SETTINGS_REQUIRE_REAPPLY', '配置已被 NVIDIA App 或其他程序改变，请核对当前值并明确重新应用；启动时不会自动覆盖。');
        const eligibility = await assessEligibility(id, domain, row.request);
        if (!eligibility.eligible) fail('SETTINGS_BLOCKED', eligibility.blockers.map(row => row.message).join('\n'));
        outcomes.push({ domain, applied: false, skipped: true, noOp: true, readbackVerified: true, runtimeVerified: false });
      }
      catch (error) { outcomes.push({ domain, applied: false, code: error.code || 'SETTINGS_FAILED', reason: error.message }); }
    }
    return outcomes;
  }
  return Object.freeze({ inspect, savedRequests, save, preview, previewMfgCompensation, apply, beforeLaunch, recover, restore, pending, assertReady, inspectLaunchReadiness, hasSrRequest, hasOwnedState,
    assessEligibility, confirmGameFeature, inspectGameFeatureConfirmation,
    requestFile, receiptFile: id => receiptFile(target(id)), driverPendingFile: id => driverPendingFile(target(id)) });
}

module.exports = { createLaunchSettingsService };
