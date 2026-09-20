'use strict';
// sdli1995/dlssg_for_sm86 0.3.5, 9621db573e07ed54f50c15bbb585ed9a7bdfac28.
// MaxGeneratedFrames is a ceiling; the game's FG integration selects the count.
const ini = require('./launch-ini');
const BACKEND = 'dlssg-sm86';
const FILE = 'dlssg_sm86.ini';
const FIELDS = Object.freeze({ 'General.Enabled': ['General', 'Enabled'],
  'FrameGeneration.Optimized': ['FrameGeneration', 'Optimized'],
  'FrameGeneration.MaxGeneratedFrames': ['FrameGeneration', 'MaxGeneratedFrames'],
  'Runtime.Mode': ['Runtime', 'Mode'] });
const fail = message => { throw Object.assign(new Error(message), { code: 'SETTINGS_SM86_CONFIG' }); };
function values(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || /\0|\uFFFD/.test(text)) fail('SM86 配置不是可处理的 UTF-8 文本。');
  let section = ''; const sections = new Set(), keys = new Set();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = ini.sectionHeader(line);
    if (header !== null) { section = header; if (['general', 'framegeneration', 'runtime'].includes(header)) {
      if (sections.has(header)) fail('SM86 配置节重复，保留原文件。'); sections.add(header);
    } continue; }
    const key = line.match(/^\s*([^;#][^=]*?)\s*=/)?.[1].trim().toLowerCase();
    if (key && ['general', 'framegeneration', 'runtime'].includes(section)) {
      const identity = `${section}.${key}`; if (keys.has(identity)) fail('SM86 配置键重复，保留原文件。'); keys.add(identity);
    }
  }
  return Object.fromEntries(Object.entries(FIELDS).map(([key, [section, name]]) => [key, ini.getIni(text, section, name)]));
}
function compile(text, request) {
  values(text);
  if (Object.keys(request).some(key => !['mode', 'multiplier'].includes(key)) || !['off', 'follow', 'fixed'].includes(request.mode)) fail('SM86 仅支持关闭、跟随游戏和倍率上限。');
  if (request.mode === 'fixed' ? !Number.isInteger(request.multiplier) || request.multiplier < 2 || request.multiplier > 6 : request.multiplier !== undefined)
    fail('请选择 2–6 倍上限；超过 4 倍还需游戏支持证据。');
  const desired = { 'General.Enabled': request.mode === 'off' ? 0 : 1,
    'FrameGeneration.Optimized': 1, 'FrameGeneration.MaxGeneratedFrames': request.mode === 'fixed' ? request.multiplier - 1 : 3,
    'Runtime.Mode': 'Bundled' };
  let content = text; const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  for (const [key, value] of Object.entries(desired)) content = ini.setIni(content, ...FIELDS[key], value);
  return { content: bom + content.replace(/^\uFEFF/, ''), warnings: ['倍率是上限，实际生成帧数由游戏请求决定；配置需重启游戏后生效。'], requiresReview: false, runtimeVerified: false };
}
function restore(current, original, afterValues) {
  const now = values(current), before = values(original);
  let result = current;
  for (const key of Object.keys(afterValues)) {
    if (!Object.hasOwn(FIELDS, key) || now[key] !== afterValues[key]) fail('SM86 受管配置已被外部修改，保留当前配置与恢复记录。');
    const [section, name] = FIELDS[key];
    if (before[key] !== null) result = ini.setIni(result, section, name, before[key]);
    else {
      const newline = result.includes('\r\n') ? '\r\n' : '\n', bom = result.startsWith('\uFEFF') ? '\uFEFF' : '';
      const lines = result.replace(/^\uFEFF/, '').split(/\r?\n/), bounds = ini.sectionBounds(lines, section);
      result = bom + lines.filter((line, index) => !(bounds && index > bounds.start && index < bounds.end &&
        line.match(/^\s*([^;#][^=]*?)\s*=/)?.[1].trim().toLowerCase() === name.toLowerCase())).join(newline);
    }
  }
  // Preserve exact original bytes when no independent edits remain.
  const stripped = text => text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).join('\n');
  if (stripped(result) === stripped(original)) return original;
  return (current.startsWith('\uFEFF') ? '\uFEFF' : '') + result.replace(/^\uFEFF/, '');
}
function current(text) {
  const raw = values(text), enabled = raw['General.Enabled'], max = raw['FrameGeneration.MaxGeneratedFrames'];
  if (enabled !== null && !['0', '1'].includes(enabled) || max !== null && !/^[1-5]$/.test(max)) fail('SM86 当前开关或倍率上限无效。');
  return { backend: BACKEND, valid: true, raw, request: enabled === '0' ? { backend: BACKEND, mode: 'off' }
    : { backend: BACKEND, mode: 'fixed', multiplier: max === null ? 4 : Number(max) + 1 }, runtimeVerified: false };
}
module.exports = { BACKEND, FILE, FIELDS, values, compile, restore, current };
