'use strict';

// Public configuration contract of MFGAdaUnlock-RenoDx 0.9.
// Source tag 0.9, commit 4a7b7bcd5f4e951c0cae9ffa7db7e5bdf5f8d40b.
// A fixed ForceMultiplier is an absolute override in 0.9. Dynamic MFG is a
// separate mode and is release-supported only by the exact stack named below.
const crypto = require('node:crypto');
const ini = require('./launch-ini');

const SOURCE = '4a7b7bcd5f4e951c0cae9ffa7db7e5bdf5f8d40b';
const PROVIDER_VERSION = '0.9';
const SECTION = 'RenoDX.MFGUnlock';
const KEYS = Object.freeze([
  'Enabled', 'MaxCount', 'ForceFlipMeteringOff', 'TemporalFix',
  'BlackwellFrameworkKernels', 'ThinGeometryIntermediateScatter',
  'ThinGeometryValidatedWarpBlend', 'ThinGeometryPreviousScatter',
  'ForceMultiplier', 'DynamicMFG', 'DynamicTargetFPS',
  'DynamicReflexSourceCap', 'RaiseFrameCeiling', 'RuntimeSelectionMode',
  'HDRCompatibilityMode', 'DepthEdgeGuardLevel'
]);
const BOOLEAN_KEYS = Object.freeze([
  'Enabled', 'ForceFlipMeteringOff', 'TemporalFix', 'BlackwellFrameworkKernels',
  'ThinGeometryIntermediateScatter', 'ThinGeometryValidatedWarpBlend',
  'ThinGeometryPreviousScatter', 'DynamicMFG', 'DynamicReflexSourceCap',
  'RaiseFrameCeiling'
]);
const REQUEST_KEYS = Object.freeze([
  'mode', 'multiplier', 'targetFps', 'runtimeMode', 'hdrMode',
  'depthEdgeGuard', 'freezeFallback', 'reflexSourceCap', 'maxCount',
  'temporalFix', 'blackwellFrameworkKernels',
  'thinGeometryIntermediateScatter', 'thinGeometryValidatedWarpBlend',
  'thinGeometryPreviousScatter', 'raiseFrameCeiling'
]);
const RUNTIME_MODES = Object.freeze({ game: 0, local: 1, ota: 2 });
const HDR_MODES = Object.freeze({ native: 0, 'ui-composition': 1, automatic: 2, 'final-color': 3 });
const DEFAULTS = Object.freeze({
  Enabled: 1, MaxCount: 4, ForceFlipMeteringOff: 0, TemporalFix: 1,
  BlackwellFrameworkKernels: 1, ThinGeometryIntermediateScatter: 1,
  ThinGeometryValidatedWarpBlend: 1, ThinGeometryPreviousScatter: 0,
  ForceMultiplier: 0, DynamicMFG: 0, DynamicTargetFPS: 0,
  DynamicReflexSourceCap: 0, RaiseFrameCeiling: 0,
  RuntimeSelectionMode: 0, HDRCompatibilityMode: 0, DepthEdgeGuardLevel: 0
});

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function validateText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || /\0|\uFFFD/.test(text))
    fail('INVALID_TEXT', 'ReShade.ini 必须是有效 UTF-8 文本且不超过 1 MiB。');
  let section = '', sections = 0; const found = new Set();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = ini.sectionHeader(line);
    if (header !== null) {
      section = header;
      if (header === SECTION.toLowerCase() && ++sections > 1) fail('AMBIGUOUS_INI', 'MFG Unlock 配置节重复，保留原文件。');
      continue;
    }
    if (section !== SECTION.toLowerCase()) continue;
    const key = line.match(/^\s*([^;#][^=]*?)\s*=/)?.[1].trim().toLowerCase();
    if (!key) continue;
    if (found.has(key)) fail('AMBIGUOUS_INI', 'MFG Unlock 配置键重复，保留原文件。');
    found.add(key);
  }
  return text;
}

function values(text) {
  validateText(text);
  return Object.fromEntries(KEYS.map(key => [key, ini.getIni(text, SECTION, key)]));
}

function integer(raw, key, allowed) {
  if (raw[key] === null) return DEFAULTS[key];
  if (!/^-?\d+$/.test(raw[key])) fail('SETTINGS_MFG_CONFIG_INVALID', `当前 MFG 0.9 配置 ${key} 无效，管理器保留原文件。`);
  const value = Number(raw[key]);
  if (!allowed(value)) fail('SETTINGS_MFG_CONFIG_INVALID', `当前 MFG 0.9 配置 ${key} 超出范围，管理器保留原文件。`);
  return value;
}

function boolValue(raw, key) { return integer(raw, key, value => value === 0 || value === 1); }

function current(text) {
  const raw = values(text);
  for (const key of BOOLEAN_KEYS) boolValue(raw, key);
  const resolved = {
    Enabled: boolValue(raw, 'Enabled'),
    MaxCount: integer(raw, 'MaxCount', value => value >= 2 && value <= 5),
    ForceMultiplier: integer(raw, 'ForceMultiplier', value => value === 0 || value >= 2 && value <= 6),
    DynamicTargetFPS: integer(raw, 'DynamicTargetFPS', value => value >= 0 && value <= 1000),
    RuntimeSelectionMode: integer(raw, 'RuntimeSelectionMode', value => value >= 0 && value <= 2),
    HDRCompatibilityMode: integer(raw, 'HDRCompatibilityMode', value => value >= 0 && value <= 3),
    DepthEdgeGuardLevel: integer(raw, 'DepthEdgeGuardLevel', value => value >= 0 && value <= 4),
    DynamicMFG: boolValue(raw, 'DynamicMFG')
  };
  const request = { backend: 'mfgunlock', mode: resolved.DynamicMFG ? 'dynamic' : resolved.ForceMultiplier ? 'fixed' : 'follow' };
  if (request.mode === 'dynamic') request.targetFps = resolved.DynamicTargetFPS;
  if (request.mode === 'fixed') request.multiplier = resolved.ForceMultiplier;
  const optional = (key, name, value) => { if (raw[key] !== null) request[name] = value; };
  optional('RuntimeSelectionMode', 'runtimeMode', Object.keys(RUNTIME_MODES).find(key => RUNTIME_MODES[key] === resolved.RuntimeSelectionMode));
  optional('HDRCompatibilityMode', 'hdrMode', Object.keys(HDR_MODES).find(key => HDR_MODES[key] === resolved.HDRCompatibilityMode));
  optional('DepthEdgeGuardLevel', 'depthEdgeGuard', resolved.DepthEdgeGuardLevel);
  optional('ForceFlipMeteringOff', 'freezeFallback', boolValue(raw, 'ForceFlipMeteringOff') === 1);
  optional('DynamicReflexSourceCap', 'reflexSourceCap', boolValue(raw, 'DynamicReflexSourceCap') === 1);
  optional('MaxCount', 'maxCount', resolved.MaxCount);
  for (const [key, name] of [
    ['TemporalFix', 'temporalFix'], ['BlackwellFrameworkKernels', 'blackwellFrameworkKernels'],
    ['ThinGeometryIntermediateScatter', 'thinGeometryIntermediateScatter'],
    ['ThinGeometryValidatedWarpBlend', 'thinGeometryValidatedWarpBlend'],
    ['ThinGeometryPreviousScatter', 'thinGeometryPreviousScatter'],
    ['RaiseFrameCeiling', 'raiseFrameCeiling']
  ]) optional(key, name, boolValue(raw, key) === 1);
  return {
    enabled: resolved.Enabled === 1,
    values: Object.fromEntries(KEYS.map(key => [key, raw[key] === null ? DEFAULTS[key] : Number(raw[key])])),
    raw,
    present: Boolean(ini.sectionBounds(text.replace(/^\uFEFF/, '').split(/\r?\n/), SECTION)),
    request,
    providerVersion: PROVIDER_VERSION,
    experimental: resolved.ForceMultiplier > 4 || request.raiseFrameCeiling === true || request.thinGeometryPreviousScatter === true,
    multiplierSemantics: 'absolute',
    runtimeVerified: false
  };
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !REQUEST_KEYS.includes(key)))
    fail('SETTINGS_INPUT', 'MFG 0.9 设置请求包含未知字段。');
  if (!['follow', 'fixed', 'dynamic'].includes(request.mode)) fail('SETTINGS_INPUT', '请选择跟随游戏、固定倍率或 Dynamic MFG。');
  if (request.mode === 'fixed') {
    if (!Number.isInteger(request.multiplier) || request.multiplier < 2 || request.multiplier > 6) fail('SETTINGS_INPUT', '固定总倍率须为 2–6。');
  } else if (request.multiplier !== undefined) fail('SETTINGS_INPUT', '只有固定倍率模式可以指定倍率。');
  if (request.mode === 'dynamic') {
    if (!Number.isInteger(request.targetFps) || request.targetFps < 0 || request.targetFps > 1000) fail('SETTINGS_INPUT', 'Dynamic 目标须为 0（跟随刷新率）或 1–1000 FPS。');
  } else if (request.targetFps !== undefined || request.reflexSourceCap !== undefined) fail('SETTINGS_INPUT', 'Dynamic 目标和 Reflex 源帧限制只能用于 Dynamic MFG。');
  if (request.runtimeMode !== undefined && !Object.hasOwn(RUNTIME_MODES, request.runtimeMode)) fail('SETTINGS_INPUT', '运行库策略须为跟随游戏、优先本地或强制 OTA。');
  if (request.hdrMode !== undefined && !Object.hasOwn(HDR_MODES, request.hdrMode)) fail('SETTINGS_INPUT', 'HDR 兼容模式无效。');
  if (request.depthEdgeGuard !== undefined && (!Number.isInteger(request.depthEdgeGuard) || request.depthEdgeGuard < 0 || request.depthEdgeGuard > 4)) fail('SETTINGS_INPUT', '边缘保护等级须为 0–4。');
  if (request.maxCount !== undefined && (!Number.isInteger(request.maxCount) || request.maxCount < 2 || request.maxCount > 5)) fail('SETTINGS_INPUT', '运行库报告上限须为 2–5。');
  for (const key of ['freezeFallback', 'reflexSourceCap', 'temporalFix', 'blackwellFrameworkKernels', 'thinGeometryIntermediateScatter', 'thinGeometryValidatedWarpBlend', 'thinGeometryPreviousScatter', 'raiseFrameCeiling'])
    if (request[key] !== undefined && typeof request[key] !== 'boolean') fail('SETTINGS_INPUT', `${key} 必须为开或关。`);
  return structuredClone(request);
}

function compile(text, input) {
  validateText(text);
  const request = validateRequest(input);
  const before = values(text), changes = [];
  // Preserve an intentionally small game-owned section. Missing 0.9 keys use
  // the provider defaults, so materialising the same default is not a change.
  const change = (key, value) => {
    if (before[key] === null && DEFAULTS[key] === value) return;
    changes.push([key, value]);
  };
  change('Enabled', 1);
  change('ForceMultiplier', request.mode === 'fixed' ? request.multiplier : 0);
  change('DynamicMFG', request.mode === 'dynamic' ? 1 : 0);
  if (request.mode === 'dynamic') change('DynamicTargetFPS', request.targetFps);
  const optional = (name, key, convert = value => value) => { if (request[name] !== undefined) change(key, convert(request[name])); };
  optional('runtimeMode', 'RuntimeSelectionMode', value => RUNTIME_MODES[value]);
  optional('hdrMode', 'HDRCompatibilityMode', value => HDR_MODES[value]);
  optional('depthEdgeGuard', 'DepthEdgeGuardLevel');
  optional('freezeFallback', 'ForceFlipMeteringOff', value => value ? 1 : 0);
  optional('reflexSourceCap', 'DynamicReflexSourceCap', value => value ? 1 : 0);
  optional('maxCount', 'MaxCount');
  for (const [name, key] of [
    ['temporalFix', 'TemporalFix'], ['blackwellFrameworkKernels', 'BlackwellFrameworkKernels'],
    ['thinGeometryIntermediateScatter', 'ThinGeometryIntermediateScatter'],
    ['thinGeometryValidatedWarpBlend', 'ThinGeometryValidatedWarpBlend'],
    ['thinGeometryPreviousScatter', 'ThinGeometryPreviousScatter'], ['raiseFrameCeiling', 'RaiseFrameCeiling']
  ]) optional(name, key, value => value ? 1 : 0);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let content = text;
  for (const [key, value] of changes) content = ini.setIni(content, SECTION, key, String(value));
  content = bom + content.replace(/^\uFEFF/, '');
  const warnings = [
    'MFG 0.9 的固定值是绝对倍率，可以提高或降低游戏请求；请在游戏内确认实际倍率。',
    '配置写入和读回不代表运行时已经采用；完全退出并重启游戏后再验证。'
  ];
  if (request.mode === 'dynamic') warnings.push('Dynamic MFG 仅支持 D3D12、DLSS-G 310.9.1、Streamline 2.14.1、驱动 595.41 或更新且运行库报告支持的完整组合。');
  if (request.mode === 'fixed' && request.multiplier > 4) warnings.push('5× / 6× 属于高级请求；管理器不会自动打开可能破坏旧游戏的 RaiseFrameCeiling。');
  if (request.freezeFallback) warnings.push('已启用 3×/4× 卡死救援的软件节奏模式；仅在确实卡死的游戏中使用。');
  return {
    schema: 2,
    backend: 'mfgunlock',
    providerVersion: PROVIDER_VERSION,
    sourceRef: SOURCE,
    phase: 'preview-only',
    destination: 'ReShade.ini',
    beforeSha256: sha256(text),
    afterSha256: sha256(content),
    content,
    warnings,
    applied: false,
    runtimeVerified: false,
    requiresRestart: true,
    multiplierSemantics: 'absolute',
    requestOnly: true
  };
}

function restore(currentText, original, ownedValues) {
  const actual = values(currentText), before = values(original);
  for (const [key, expected] of Object.entries(ownedValues)) {
    if (!KEYS.includes(key) || actual[key] !== expected) fail('SETTINGS_EXTERNAL_CHANGE', '本工具修改的 MFG 配置键已被外部改变，保留当前文件与备份。');
  }
  const newline = currentText.includes('\r\n') ? '\r\n' : '\n', bom = currentText.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = currentText;
  for (const key of Object.keys(ownedValues)) {
    if (before[key] !== null) { text = bom + ini.setIni(text, SECTION, key, before[key]); continue; }
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), bounds = ini.sectionBounds(lines, SECTION);
    text = bom + lines.filter((line, index) => !(bounds && index > bounds.start && index < bounds.end &&
      line.match(/^\s*([^;#][^=]*?)\s*=/)?.[1].trim().toLowerCase() === key.toLowerCase())).join(newline);
  }
  if (!ini.sectionBounds(original.replace(/^\uFEFF/, '').split(/\r?\n/), SECTION)) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), bounds = ini.sectionBounds(lines, SECTION);
    if (bounds && lines.slice(bounds.start + 1, bounds.end).every(line => !line.trim())) {
      lines.splice(bounds.start, bounds.end - bounds.start);
      text = bom + lines.join(newline);
    }
  }
  return text;
}

module.exports = { SOURCE, PROVIDER_VERSION, SECTION, KEYS, DEFAULTS, validateText, values, current, compile, restore };
