'use strict';

// The 0.6.1 and 0.7 providers share these exact configuration keys.
// Its SetOptions hook raises a lower game request, never lowers a higher one,
// and never enables a game whose DLSSG mode is off. Config is read at attach.
const crypto = require('node:crypto');
const ini = require('./launch-ini');
const SOURCE = 'ffe6169b5e98ad578fcf2c30614d06a567790fe1';
const SECTION = 'RenoDX.MFGUnlock';
const KEYS = Object.freeze(['Enabled', 'ForceMultiplier']);
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function validateText(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || /\0|\uFFFD/.test(text))
    fail('INVALID_TEXT', 'ReShade.ini 必须是有效 UTF-8 文本且不超过 1 MiB。');
  let section = '', sections = 0; const found = new Set();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = ini.sectionHeader(line);
    if (header !== null) { section = header; if (header === SECTION.toLowerCase() && ++sections > 1) fail('AMBIGUOUS_INI', 'MFG Unlock 配置节重复，保留原文件。'); continue; }
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
function current(text) {
  const raw = values(text);
  const enabled = raw.Enabled === null ? 1 : Number(raw.Enabled), force = raw.ForceMultiplier === null ? 0 : Number(raw.ForceMultiplier);
  if (raw.Enabled !== null && !/^[01]$/.test(raw.Enabled) || raw.ForceMultiplier !== null && !/^(?:0|[2-6])$/.test(raw.ForceMultiplier) ||
      ![0, 1].includes(enabled) || ![0, 2, 3, 4, 5, 6].includes(force))
    fail('SETTINGS_MFG_CONFIG_INVALID', '当前 MFG 配置值无效，请在游戏内核对；管理器保留原文件。');
  return { enabled: enabled === 1, values: { Enabled: enabled, ForceMultiplier: force }, raw,
    present: Boolean(ini.sectionBounds(text.replace(/^\uFEFF/, '').split(/\r?\n/), SECTION)),
    request: { backend: 'mfgunlock', mode: force === 0 ? 'follow' : 'fixed', ...(force ? { multiplier: force } : {}) },
    experimental: force > 4, multiplierSemantics: 'raise-only', runtimeVerified: false };
}
function compile(text, request) {
  validateText(text);
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['mode', 'multiplier'].includes(key)))
    fail('SETTINGS_INPUT', '新 MFG 只支持跟随游戏或请求提高倍率；不接受旧动态目标参数。');
  if (!['follow', 'fixed'].includes(request.mode)) fail('SETTINGS_INPUT', '请选择跟随游戏或请求提高倍率；关闭游戏补帧请使用游戏设置。');
  if (request.mode === 'follow' && request.multiplier !== undefined) fail('SETTINGS_INPUT', '跟随游戏时不指定倍率。');
  if (request.mode === 'fixed' && (!Number.isInteger(request.multiplier) || request.multiplier < 2 || request.multiplier > 6))
    fail('SETTINGS_INPUT', '请求总倍率须为 2–6；实际倍率由游戏与运行库决定。');
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  let content = ini.setIni(text, SECTION, 'Enabled', '1');
  content = bom + ini.setIni(content, SECTION, 'ForceMultiplier', String(request.mode === 'follow' ? 0 : request.multiplier));
  const warnings = ['设置需完全退出并重启游戏后读取；文件读回不证明已经补帧。',
    '该插件只提高较低的游戏请求，不会降低已有更高倍率，也不会打开游戏中已关闭的帧生成。'];
  if (request.mode === 'fixed' && request.multiplier > 2) warnings.push('提高至 3× 以上时，上游可能尝试软件帧节奏兼容补丁；请按游戏验证。');
  if (request.mode === 'fixed' && request.multiplier > 4) warnings.push('5× / 6× 是试验请求；不会自动提高 Streamline 硬上限，拒绝时由插件回退游戏原请求。');
  if (ini.getIni(text, SECTION, 'TemporalFix') === '0') warnings.push('现有配置关闭了时间插值修正，已保留；请在游戏内 MFG Unlock 面板核对。');
  return { schema: 1, backend: 'mfgunlock', sourceRef: SOURCE, phase: 'preview-only', destination: 'ReShade.ini',
    beforeSha256: sha256(text), afterSha256: sha256(content), content, warnings, applied: false, runtimeVerified: false,
    requiresRestart: true, multiplierSemantics: 'raise-only', requestOnly: true };
}
function restore(current, original, ownedValues) {
  const actual = values(current), before = values(original);
  for (const [key, expected] of Object.entries(ownedValues)) {
    if (!KEYS.includes(key) || actual[key] !== expected) fail('SETTINGS_EXTERNAL_CHANGE', '本工具修改的 MFG 配置键已被外部改变，保留当前文件与备份。');
  }
  const newline = current.includes('\r\n') ? '\r\n' : '\n', bom = current.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = current;
  for (const key of Object.keys(ownedValues)) {
    if (before[key] !== null) { text = bom + ini.setIni(text, SECTION, key, before[key]); continue; }
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), bounds = ini.sectionBounds(lines, SECTION);
    text = bom + lines.filter((line, index) => !(bounds && index > bounds.start && index < bounds.end &&
      line.match(/^\s*([^;#][^=]*?)\s*=/)?.[1].trim().toLowerCase() === key.toLowerCase())).join(newline);
  }
  // Remove only a section we introduced and which has no remaining content.
  // New unrelated keys/comments and every other ReShade section survive.
  if (!ini.sectionBounds(original.replace(/^\uFEFF/, '').split(/\r?\n/), SECTION)) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/), bounds = ini.sectionBounds(lines, SECTION);
    if (bounds && lines.slice(bounds.start + 1, bounds.end).every(line => !line.trim())) {
      lines.splice(bounds.start, bounds.end - bounds.start);
      text = bom + lines.join(newline);
    }
  }
  return text;
}
module.exports = { SOURCE, SECTION, KEYS, validateText, values, current, compile, restore };
