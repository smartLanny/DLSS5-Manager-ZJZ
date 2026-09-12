'use strict';
// Pure data helpers. No renderer, game-file writer, automatic installer or GPU hook.
const { createHash, randomUUID } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const ROLES = ['loader', 'transport', 'provider', 'nr', 'sr', 'rr', 'fg', 'hdr'];
const STAGES = ['loaded', 'nr', 'sr', 'rr', 'fg', 'presented'];
const STATES = ['unknown', 'not-applicable', 'observed', 'failed'];
const RATINGS = {
  playability: ['unknown', 'normal', 'cannot-start', 'crash-or-freeze'],
  image: ['unknown', 'improved', 'unchanged', 'artifacts'],
  fluidity: ['unknown', 'smooth', 'acceptable', 'unacceptable']
};
const TAGS = ['flicker', 'ghosting', 'brightness', 'hud', 'other'];
const LABELS = {
  normal: '正常游玩', 'cannot-start': '无法启动', 'crash-or-freeze': '闪退或卡死',
  improved: '画面有改善', unchanged: '画面看不出变化', artifacts: '有画面异常',
  smooth: '流畅', acceptable: '勉强可用', unacceptable: '不能接受', unknown: '不确定 / 未测试'
};
function fail(message, code = 'INVALID_REPORT') { throw Object.assign(new Error(message), { code }); }
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value, max = 160) {
  return typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max) : null;
}
function redact(value, max = 4096) {
  let s = text(value, max) || '';
  s = s.replace(/https?:\/\/[^\s<>"']+/gi, '<链接>')
    .replace(/\b[A-Z]:[\\/][^\r\n\t"<>|]*/gi, '<路径>')
    .replace(/\\\\[^\s"<>|]+/g, '<路径>')
    .replace(/\/(?:home|Users|mnt|tmp)\/[^\s"<>|]+/g, '<路径>')
    .replace(/\b(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]+/g, '<令牌>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<令牌>')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization|cookie|username|account|qq)\s*[:=]\s*[^\r\n]+/gi, '$1=<已移除>');
  if (s.includes('@')) s = s.replace(/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b/gi, '<邮箱>');
  return s;
}
function safeText(value, max = 160) { const t = text(value, max); return t === null ? null : redact(t, max); }
function hash(value) { return HASH.test(value || '') ? value.toLowerCase() : null; }
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}
function digest(value) { return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value)).digest('hex'); }
function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function dimension(value) { return Number.isInteger(value) && value > 0 && value <= 65536 ? value : null; }
function extent(value) { return plain(value) && dimension(value.width) && dimension(value.height) ? { width: value.width, height: value.height } : null; }
function configSnapshot(input = {}) {
  // Only agreed scalar fields; never copy arbitrary INI/command-line data to public JSON.
  const numeric = (x, min, max) => Number.isFinite(x) && x >= min && x <= max ? x : null;
  return {
    requested: {
      nrPlacement: ['before-sr', 'after-sr', 'after-rr', 'off'].includes(input.requested?.nrPlacement) ? input.requested.nrPlacement : null,
      nrScale: numeric(input.requested?.nrScale, 0, 1),
      srMode: safeText(input.requested?.srMode, 64),
      fgMode: safeText(input.requested?.fgMode, 64),
      fgMultiplier: numeric(input.requested?.fgMultiplier, 1, 16),
      hdr: typeof input.requested?.hdr === 'boolean' ? input.requested.hdr : null
    },
    actual: { render: extent(input.actual?.render), captured: extent(input.actual?.captured), neural: extent(input.actual?.neural), output: extent(input.actual?.output) },
    settingsFingerprint: hash(input.settingsFingerprint),
    generation: Number.isSafeInteger(input.generation) && input.generation >= 0 ? input.generation : null
  };
}
function normalizeComponents(rows) {
  if (!Array.isArray(rows) || rows.length > 32) fail('组件清单无效。');
  const result = rows.map(row => {
    if (!plain(row) || !ROLES.includes(row.role) || !text(row.id)) fail('组件角色或身份无效。');
    return { role: row.role, id: safeText(row.id), version: safeText(row.version), sha256: hash(row.sha256),
      identity: ['installed', 'loaded'].includes(row.identity) ? row.identity : 'declared' };
  }).sort((a,b) => stable(a).localeCompare(stable(b)));
  for (const role of ['nr', 'fg']) {
    if (new Set(result.filter(r => r.role === role).map(r => r.id)).size > 1) fail('检测到多个 ' + role.toUpperCase() + ' 处理者，不能生成单一路线报告。', 'MULTIPLE_OWNERS');
  }
  return result;
}
function environmentSnapshot(input = {}) {
  const rows = Array.isArray(input.gpus) ? input.gpus.slice(0, 8) : [];
  const gpus = rows.map(row => ({
    id: safeText(row.id, 100), name: safeText(row.name), vendorId: /^[a-f0-9]{4}$/i.test(row.vendorId || '') ? row.vendorId.toLowerCase() : null,
    deviceId: /^[a-f0-9]{4}$/i.test(row.deviceId || '') ? row.deviceId.toLowerCase() : null,
    driverRaw: safeText(row.driverRaw, 80), driverDisplay: safeText(row.driverDisplay, 80),
    source: safeText(row.source, 80)
  }));
  // Never choose the first GPU, nor infer the active adapter from payloadFamily.
  const binding = input.renderAdapter;
  const match = plain(binding) && ['runtime-dxgi', 'runtime-vulkan', 'runtime-adapter'].includes(binding.source)
    ? gpus.filter(row => row.id && row.id === binding.id) : [];
  return { gpus, renderAdapter: match.length === 1 ? { ...match[0], bindingSource: binding.source } : null,
    os: { platform: safeText(input.os?.platform, 40), release: safeText(input.os?.release, 80), build: safeText(input.os?.build, 80) },
    capturedAt: iso(input.capturedAt) };
}
function createSession(input, { now = () => new Date(), uuid = randomUUID } = {}) {
  if (!plain(input) || !text(input.game?.name)) fail('缺少目标游戏。', 'MISSING_GAME');
  if (!plain(input.recipe) || !text(input.recipe.id)) fail('缺少当前组件方案。', 'MISSING_RECIPE');
  const sessionId = uuid(); if (!UUID.test(sessionId)) fail('会话 ID 无效。');
  const startedAt = now().toISOString();
  const components = normalizeComponents(input.components || []);
  const configuration = configSnapshot(input.configuration);
  const game = { name: safeText(input.game.name), storeId: safeText(input.game.storeId), launcher: safeText(input.game.launcher),
    client: safeText(input.game.client), version: safeText(input.game.version), exeName: safeText((text(input.game.exeName) || '').split(/[\\/]/).pop()),
    exeSha256: hash(input.game.exeSha256), api: ['dx9','dx10','dx11','dx12','vulkan','opengl'].includes(input.game.api) ? input.game.api : 'unknown' };
  const recipe = { id: safeText(input.recipe.id), version: safeText(input.recipe.version), name: safeText(input.recipe.name),
    providerQuality: ['native','extracted','synthetic'].includes(input.recipe.providerQuality) ? input.recipe.providerQuality : 'unknown',
    nrOwner: safeText(input.recipe.nrOwner) };
  const environment = environmentSnapshot(input.environment);
  const recipeFingerprint = digest({ recipe, components, requested: configuration.requested, settingsFingerprint: configuration.settingsFingerprint });
  return frozen({ schemaVersion: 1, sessionId, startedAt,
    contextSource: input.contextSource === 'launch-snapshot' ? 'launch-snapshot' : 'manual-snapshot',
    scope: ['game','controlled-host','upstream-report','demo'].includes(input.scope) ? input.scope : 'game',
    parentSessionId: UUID.test(input.parentSessionId || '') ? input.parentSessionId : null,
    testerId: input.testerConsent === true && UUID.test(input.testerId || '') ? input.testerId : null,
    game, manager: { version: safeText(input.manager?.version), build: safeText(input.manager?.build, 80) },
    recipe, recipeFingerprint, components, configuration, environment });
}
function normalizeRatings(input = {}) {
  if (!plain(input)) fail('评分格式无效', 'INVALID_RATING');
  const result = {};
  for (const [key, values] of Object.entries(RATINGS)) {
    const value = input[key] === undefined ? 'unknown' : input[key];
    if (!values.includes(value)) fail('评分选项无效：' + key, 'INVALID_RATING');
    result[key] = value;
  }
  result.tags = result.image === 'artifacts' ? [...new Set((Array.isArray(input.tags) ? input.tags : []).filter(t => TAGS.includes(t)))] : [];
  result.note = safeText(input.note, 600) || '';
  return result;
}
function observationsFor(session, rows = [], now = new Date()) {
  const result = Object.fromEntries(STAGES.map(stage => [stage, { state: 'unknown', source: null, observedAt: null, reason: null }]));
  let ignored = 0;
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows.slice(0, 128) : []) {
    const stamp = iso(row?.observedAt);
    if (!row || !STAGES.includes(row.stage) || !STATES.includes(row.state) || row.state === 'unknown' ||
      row.sessionId !== session.sessionId || row.recipeFingerprint !== session.recipeFingerprint ||
      (row.configurationGeneration ?? null) !== session.configuration.generation ||
      !text(row.source) || !stamp || Date.parse(stamp) < Date.parse(session.startedAt) || Date.parse(stamp) > now.getTime()) { ignored++; continue; }
    if (!grouped.has(row.stage)) grouped.set(row.stage, []);
    grouped.get(row.stage).push(row);
  }
  for (const [stage, items] of grouped) {
    const lastTime = Math.max(...items.map(row => Date.parse(row.observedAt)));
    const latest = items.filter(row => Date.parse(row.observedAt) === lastTime);
    const states = [...new Set(latest.map(row => row.state))];
    result[stage] = states.length === 1
      ? { state: states[0], source: safeText(latest[0].source), observedAt: iso(latest[0].observedAt), reason: safeText(latest[0].reason, 240) }
      : { state: 'unknown', source: 'conflicting-evidence', observedAt: new Date(lastTime).toISOString(), reason: '同一时间存在冲突证据' };
  }
  return { stages: result, ignored };
}
function createReport(session, ratings, evidence = {}, { now = () => new Date(), uuid = randomUUID } = {}) {
  validateSession(session);
  const time = now();
  if (time.getTime() < Date.parse(session.startedAt)) fail('报告时间早于会话开始。');
  const reportId = uuid(); if (!UUID.test(reportId)) fail('报告 ID 无效。');
  const normalized = normalizeRatings(ratings);
  const observed = observationsFor(session, evidence.observations, time);
  // A disappearing process is not sufficient evidence to label a crash.
  const end = iso(evidence.endedAt);
  const endedAt = end && Date.parse(end) >= Date.parse(session.startedAt) && Date.parse(end) <= time.getTime() ? end : null;
  const exitKind = ['clean-exit','process-disappeared','launch-failed','confirmed-crash'].includes(evidence.exitKind) ? evidence.exitKind : 'unknown';
  const warnings = [...new Set((Array.isArray(evidence.limitations) ? evidence.limitations : []).filter(code =>
    ['RUNTIME_INSPECTION_UNAVAILABLE', 'SESSION_RECORD_UNAVAILABLE', 'COMPONENT_INVENTORY_UNAVAILABLE', 'ASSESSMENT_PARTIAL'].includes(code)))];
  if (normalized.image === 'unchanged' && observed.stages.nr.state === 'observed') warnings.push('USER_SEES_NO_CHANGE_AFTER_NR');
  if (normalized.image === 'artifacts') warnings.push('USER_REPORTED_IMAGE_ARTIFACTS');
  if (!session.environment.renderAdapter) warnings.push('RENDER_ADAPTER_UNBOUND');
  if (!session.environment.renderAdapter?.driverRaw && !session.environment.renderAdapter?.driverDisplay) warnings.push('RENDER_DRIVER_UNKNOWN');
  if (observed.ignored) warnings.push('UNBOUND_OR_OLD_EVIDENCE_IGNORED');
  return frozen({ schemaVersion: 1, reportId, createdAt: time.toISOString(), session: JSON.parse(JSON.stringify(session)),
    outcome: { endedAt, durationSeconds: endedAt ? Math.round((Date.parse(endedAt) - Date.parse(session.startedAt)) / 1000) : null,
      exitKind, scene: ['gameplay','menu','startup','unknown'].includes(evidence.scene) ? evidence.scene : 'unknown',
      stages: observed.stages, ignoredObservationCount: observed.ignored },
    ratings: normalized, warnings, attachments: [], privacy: { kind: 'private-diagnostic', automaticUpload: false, logsIncluded: false,
      warning: '白名单元数据；可选日志经过基础遮蔽，但不能保证清除全部隐私。公开前请检查。' } });
}
function validateSession(s) {
  if (!plain(s) || s.schemaVersion !== 1 || !UUID.test(s.sessionId || '') || !iso(s.startedAt) || !plain(s.game) || !plain(s.recipe) ||
    !plain(s.configuration) || !plain(s.environment) || !Array.isArray(s.components) || !HASH.test(s.recipeFingerprint || '')) fail('会话格式无效。');
  if (s.recipeFingerprint !== digest({ recipe: s.recipe, components: s.components, requested: s.configuration.requested, settingsFingerprint: s.configuration.settingsFingerprint })) fail('组件指纹不匹配。');
  normalizeComponents(s.components);
}
function assertKeys(object, keys, label) {
  if (!plain(object) || Object.keys(object).some(k => !keys.includes(k))) fail('未知字段：' + label);
}
function nullableStrings(row, keys, limit=180) { for (const k of keys) if (row[k] !== null && (typeof row[k] !== 'string' || row[k].length > limit)) fail('无效文本字段：' + k); }
function validateReport(r) {
  assertKeys(r, ['schemaVersion','reportId','createdAt','session','outcome','ratings','warnings','attachments','privacy'], 'report');
  if (r.schemaVersion !== 1 || !UUID.test(r.reportId || '') || !iso(r.createdAt)) fail('报告格式无效。');
  validateSession(r.session);
  const s = r.session;
  assertKeys(s, ['schemaVersion','sessionId','startedAt','contextSource','scope','parentSessionId','testerId','game','manager','recipe','recipeFingerprint','components','configuration','environment'], 'session');
  assertKeys(s.game, ['name','storeId','launcher','client','version','exeName','exeSha256','api'], 'game');
  nullableStrings(s.game, ['name','storeId','launcher','client','version','exeName','exeSha256','api']);
  if (!s.game.name || !['unknown','dx9','dx10','dx11','dx12','vulkan','opengl'].includes(s.game.api) ||
      s.game.exeSha256 !== null && !HASH.test(s.game.exeSha256)) fail('游戏身份无效');
  if (!['game','controlled-host','upstream-report','demo'].includes(s.scope) || !['launch-snapshot','manual-snapshot'].includes(s.contextSource)) fail('报告来源范围无效');
  assertKeys(s.manager, ['version','build'], 'manager');
  nullableStrings(s.manager, ['version','build']);
  assertKeys(s.recipe, ['id','version','name','providerQuality','nrOwner'], 'recipe');
  nullableStrings(s.recipe, ['id','version','name','providerQuality','nrOwner']);
  if (stable(configSnapshot(s.configuration)) !== stable(s.configuration)) fail('配置快照无效');
  assertKeys(s.configuration, ['requested','actual','generation','settingsFingerprint'], 'configuration');
  assertKeys(s.configuration.requested, ['nrPlacement','nrScale','srMode','fgMode','fgMultiplier','hdr'], 'requested');
  assertKeys(s.configuration.actual, ['render','captured','neural','output'], 'actual');
  for (const e of Object.values(s.configuration.actual)) if (e !== null) { assertKeys(e, ['width','height'], 'extent'); if (!extent(e)) fail('无效尺寸'); }
  assertKeys(s.environment, ['gpus','renderAdapter','os','capturedAt'], 'environment');
  assertKeys(s.environment.os, ['platform','release','build'], 'os');
  nullableStrings(s.environment.os, ['platform','release','build']);
  if (s.environment.capturedAt !== null && !iso(s.environment.capturedAt)) fail('环境时间无效');
  const gpuKeys = ['id','name','vendorId','deviceId','driverRaw','driverDisplay','source'];
  if (!Array.isArray(s.environment.gpus) || s.environment.gpus.length > 8) fail('显卡清单无效');
  s.environment.gpus.forEach(gpu => { assertKeys(gpu, gpuKeys, 'gpu'); nullableStrings(gpu, gpuKeys); });
  if (s.environment.renderAdapter) {
    const adapter=s.environment.renderAdapter; assertKeys(adapter, [...gpuKeys,'bindingSource'], 'renderAdapter'); nullableStrings(adapter,[...gpuKeys,'bindingSource']);
    if (!['runtime-dxgi','runtime-vulkan','runtime-adapter'].includes(adapter.bindingSource)) fail('显卡绑定来源无效');
    const found=s.environment.gpus.filter(g=>g.id===adapter.id);
    if(found.length!==1 || gpuKeys.some(k=>found[0][k]!==adapter[k])) fail('渲染显卡与清单不一致');
  }
  s.components.forEach(c => assertKeys(c, ['role','id','version','sha256','identity'], 'component'));
  if (stable(normalizeComponents(s.components)) !== stable(s.components)) fail('组件身份未规范化');
  assertKeys(r.outcome, ['endedAt','durationSeconds','exitKind','scene','stages','ignoredObservationCount'], 'outcome');
  assertKeys(r.outcome.stages, STAGES, 'stages');
  for (const stage of STAGES) {
    const row = r.outcome.stages[stage]; assertKeys(row, ['state','source','observedAt','reason'], stage);
    if (!STATES.includes(row.state)) fail('运行状态无效');
    nullableStrings(row, ['source','observedAt','reason'], 240);
    if (row.state !== 'unknown' && (!iso(row.observedAt) || !row.source || Date.parse(row.observedAt) < Date.parse(s.startedAt) || Date.parse(row.observedAt) > Date.parse(r.createdAt))) fail('状态缺少有效会话证据');
  }
  assertKeys(r.ratings, ['playability','image','fluidity','tags','note'], 'ratings');
  if (stable(normalizeRatings(r.ratings)) !== stable(r.ratings)) fail('评分字段未规范化');
  if (!Array.isArray(r.attachments) || r.attachments.length > 20 || !Array.isArray(r.warnings) || r.warnings.length > 32) fail('附件或警告清单无效');
  if (r.warnings.some(code => typeof code !== 'string' || code.length > 100) ||
      !Number.isSafeInteger(r.outcome.ignoredObservationCount) || r.outcome.ignoredObservationCount < 0) fail('诊断摘要无效');
  for (const a of r.attachments) { assertKeys(a, ['path','sha256','bytes','scope','source'], 'attachment'); if (!HASH.test(a.sha256 || '') || !Number.isInteger(a.bytes) || a.bytes < 0 || a.bytes > 2 * 1024 * 1024) fail('附件摘要无效'); }
  assertKeys(r.privacy, ['kind','automaticUpload','logsIncluded','warning'], 'privacy');
  if (r.privacy.automaticUpload !== false || r.privacy.kind !== 'private-diagnostic') fail('不支持此隐私协议');
  if (Date.parse(r.createdAt) < Date.parse(s.startedAt)) fail('报告时间早于会话');
  if (!['unknown','clean-exit','process-disappeared','launch-failed','confirmed-crash'].includes(r.outcome.exitKind) || !['unknown','startup','menu','gameplay'].includes(r.outcome.scene)) fail('运行结果无效');
  if(r.outcome.endedAt!==null && (!iso(r.outcome.endedAt) || Date.parse(r.outcome.endedAt)<Date.parse(s.startedAt) || Date.parse(r.outcome.endedAt)>Date.parse(r.createdAt))) fail('结束时间无效');
  const duration=r.outcome.endedAt===null?null:Math.round((Date.parse(r.outcome.endedAt)-Date.parse(s.startedAt))/1000);
  if(r.outcome.durationSeconds!==duration) fail('运行时长不一致');
  // Whole document bound is also enforced by ZIP importer. No arbitrary nested objects/commands.
  if (Buffer.byteLength(JSON.stringify(r)) > 256 * 1024) fail('报告过大');
  return r;
}
function exactGroup(report) {
  const s = report.session, gpu = s.environment.renderAdapter;
  const gpuCondition = row => ({ name: row.name, vendorId: row.vendorId, deviceId: row.deviceId,
    driverRaw: row.driverRaw, driverDisplay: row.driverDisplay });
  // Unknown is not a wildcard: keep available driver inventories separate even
  // before a runtime adapter can be bound. Inventory order/temporary IDs are not identity.
  const inventory = gpu ? null : s.environment.gpus.map(gpuCondition)
    .sort((a, b) => stable(a).localeCompare(stable(b)));
  const conditions = {
    game: { storeId: s.game.storeId, launcher: s.game.launcher, client: s.game.client,
      version: s.game.version, exeSha256: s.game.exeSha256, api: s.game.api,
      fallbackIdentity: s.game.exeSha256 ? null : { name: s.game.name, exeName: s.game.exeName } },
    contextSource: s.contextSource, recipeFingerprint: s.recipeFingerprint, manager: s.manager,
    gpu: gpu ? gpuCondition(gpu) : null,
    gpuBinding: gpu ? 'runtime-bound' : 'inventory-only', gpuInventory: inventory,
    scope: s.scope, os: s.environment.os
  };
  return { key: digest(conditions), conditions, complete: Boolean(s.contextSource === 'launch-snapshot' &&
    s.configuration.settingsFingerprint && s.game.exeSha256 && s.game.version && s.game.api !== 'unknown' &&
    s.components.length && s.components.every(c => c.sha256 && c.version) && gpu && (gpu.driverRaw || gpu.driverDisplay)) };
}
function summary(report) {
  const {session:s, ratings:r, outcome:o} = report;
  const driver = s.environment.renderAdapter;
  const stageNames = {loaded:'组件加载',nr:'NR 处理',sr:'超分',rr:'光线重建',fg:'帧生成',presented:'最终显示'};
  const stateNames = {unknown:'未确认','not-applicable':'不适用',observed:'已有证据',failed:'失败'};
  return ['兼容反馈（不是性能基准或自动兼容认证）', `游戏：${s.game.name} / ${s.game.version || '版本未知'}`,
    `方案：${s.recipe.name || s.recipe.id}`, `API：${s.game.api}`, `显卡：${driver?.name || '尚未绑定实际渲染显卡'}`,
    `驱动：${driver?.driverDisplay || driver?.driverRaw || '未知'}`,
    ...(!driver ? s.environment.gpus.map(g => `检测到的设备（未绑定游戏）：${g.name || '未知'} · 驱动 ${g.driverDisplay || g.driverRaw || '未知'}`) : []),
    `配置来源：${s.contextSource === 'launch-snapshot' ? '启动前快照' : '当前配置快照；不证明上次运行配套'}`,  `管理器：${s.manager.version || '未知'}`,
    `场景：${o.scene}；运行时长：${o.durationSeconds === null ? '未知' : o.durationSeconds + ' 秒'}`,
    `游玩：${LABELS[r.playability]}`, `画面：${LABELS[r.image]}`, `流畅度：${LABELS[r.fluidity]}`,
    ...STAGES.map(k => `${stageNames[k]}：${stateNames[o.stages[k].state]}`),
    `备注：${r.note || '无'}`, `报告编号：${report.reportId}`, '文件仅保存在本地；发送前请检查隐私。'].join('\n');
}
module.exports = { createSession, createReport, normalizeRatings, observationsFor, environmentSnapshot, validateReport, validateSession,
  exactGroup, summary, redact, digest, stable, frozen, RATINGS, TAGS, STAGES, UUID, HASH, safeText, fail };
