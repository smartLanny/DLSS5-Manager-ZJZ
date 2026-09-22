'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { PUBLIC_NR_KEYS, FIELD_DEFINITIONS, MODEL_DEFAULTS, LEGACY_DEFAULTS, resolveContract, definition } = require('./nr-config-contract');
const SECTION = 'NRBeforeSR', MAX_BYTES = 1024 * 1024;
const canonical = new Map(PUBLIC_NR_KEYS.map(key => [key.toLowerCase(), key]));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };

function configLimits(input = '') {
  const contract = resolveContract(input);
  if (!contract.known) return null;
  return Object.fromEntries(contract.keys.flatMap(key => {
    const row = definition(key, input);
    return row?.min === undefined ? [] : [[key, { min: row.min, max: row.max, ...(row.special ? { special: row.special } : {}) }]];
  }));
}

// Validate edits only: reading must never clamp or round a stored number.
function normalizeValue(key, value, input = '') {
  const row = definition(key, input), contract = resolveContract(input);
  if (!row || contract.known && !contract.keys.includes(key)) fail('ERR_BAD_REQUEST', `当前 Core 未提供 NR 参数 ${key}。`, { key });
  if (row.type === 'enum') {
    const selected = typeof value === 'string' && row.values.find(item => item.toLowerCase() === value.toLowerCase());
    if (!selected) fail('ERR_BAD_REQUEST', `${key} 的值无效。`, { key });
    return selected;
  }
  if (!['number', 'boolean'].includes(typeof value) || !Number.isFinite(Number(value))) fail('ERR_BAD_REQUEST', `${key} 必须为有限数值。`, { key });
  const number = Number(value);
  if (row.type !== 'float' && !Number.isInteger(number) || !row.special?.includes(number) && (number < row.min || number > row.max))
    fail('ERR_BAD_REQUEST', `${key} 超出当前 Core 支持的范围。`, { key, min: row.min, max: row.max });
  return number;
}

function decode(bytes) {
  if (bytes.length > MAX_BYTES) fail('ERR_NR_CONFIG_SIZE', 'NR 配置文件超过 1 MiB，未读取或修改。');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) fail('ERR_NR_CONFIG_ENCODING', 'NR 配置使用不支持的 UTF-16 BE 编码，原文件已保留。');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    if (bytes.length % 2) fail('ERR_NR_CONFIG_ENCODING', 'NR UTF-16 配置长度无效，原文件已保留。');
    const text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    if (text.includes('\0')) fail('ERR_NR_CONFIG_ENCODING', 'NR 配置包含空字符，原文件已保留。');
    return { text, encoding: 'utf16le', bom: true };
  }
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), body = bom ? bytes.subarray(3) : bytes;
  if (body.includes(0)) fail('ERR_NR_CONFIG_ENCODING', 'NR 配置编码无法确定，原文件已保留。');
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf8', bom }; }
  catch {
    // Public names/values are ASCII. Preserve ANSI comment bytes without
    // guessing the owner's machine codepage or transcoding the whole file.
    if (bom) fail('ERR_NR_CONFIG_ENCODING', 'NR UTF-8 配置损坏，原文件已保留。');
    return { text: bytes.toString('latin1'), encoding: 'ansi', bom: false };
  }
}
function encode(document, text) {
  const body = Buffer.from(text, document.encoding === 'utf16le' ? 'utf16le' : document.encoding === 'ansi' ? 'latin1' : 'utf8');
  return document.bom ? Buffer.concat([document.encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}
function profileString(raw) {
  let value = raw.trim();
  if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) value = value.slice(1, -1);
  return value;
}
function documentOf(text) {
  const lines = [], entries = new Map(), duplicates = [];
  let start = -1, end = -1, active = false;
  for (const match of String(text).matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const line = { text: match[1], newline: match[2] }, index = lines.push(line) - 1;
    const section = line.text.match(/^\s*\[([^\]]+)\]/);
    if (section) {
      if (active) { end = index; active = false; }
      if (section[1].toLowerCase() === SECTION.toLowerCase()) {
        if (start < 0) { start = index; active = true; }
        else duplicates.push({ kind: 'section', line: index + 1 });
      }
      continue;
    }
    if (!active || /^\s*;/.test(line.text)) continue;
    const pair = line.text.match(/^(\s*)([^=]+?)(\s*=\s*)(.*)$/);
    if (!pair) continue;
    const key = pair[2].trim().toLowerCase();
    if (entries.has(key)) { duplicates.push({ kind: 'key', key: canonical.get(key) || key, line: index + 1 }); continue; }
    entries.set(key, { key: canonical.get(key) || pair[2].trim(), index, raw: pair[4], value: profileString(pair[4]), prefix: pair[1] + pair[2] + pair[3] });
  }
  return { lines, entries, duplicates, start, end: end < 0 ? lines.length : end, newline: lines.find(line => line.newline)?.newline || '\n' };
}
function parsedNumber(value, integer = false) {
  const trimmed = value.trimStart();
  if (integer) {
    const match = trimmed.match(/^[+-]?(?:0x[\da-f]+|\d+)/i);
    if (!match) return null;
    const sign = match[0][0] === '-' ? -1 : 1, digits = match[0].replace(/^[+-]/, '');
    return sign * parseInt(digits, /^0x/i.test(digits) ? 16 : 10);
  }
  const match = trimmed.match(/^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i);
  return match && Number.isFinite(Number(match[0])) ? Number(match[0]) : null;
}
function savedValue(entry, key) {
  if (FIELD_DEFINITIONS[key].type === 'enum') return entry.value;
  if (/^[+-]?0x[\da-f]+$/i.test(entry.value)) return parsedNumber(entry.value, true);
  const value = parsedNumber(entry.value);
  return value === null ? entry.value : value;
}
function parseSection(text) {
  return Object.fromEntries([...documentOf(String(text || '').replace(/^\uFEFF/, '')).entries.values()]
    .filter(entry => canonical.has(entry.key.toLowerCase())).map(entry => [entry.key, savedValue(entry, entry.key)]));
}

function inspectText(text, input = '') {
  const contract = resolveContract(input), doc = documentOf(text), saved = {}, raw = {}, effective = {}, fields = {}, capabilities = {};
  const defaults = { ...contract.defaults }, readRaw = key => doc.entries.get(key.toLowerCase());
  const nativeInt = (key, fallback) => {
    const entry = readRaw(key); if (!entry) return fallback;
    const value = parsedNumber(entry.value, true); return value === null ? 0 : value | 0;
  };
  const nativeFloat = (key, fallback) => {
    const entry = readRaw(key); if (!entry) return fallback;
    const number = parsedNumber(entry.value.slice(0, 63));
    return number === null || !Number.isFinite(Math.fround(number)) ? fallback : Math.fround(number);
  };
  for (const key of PUBLIC_NR_KEYS) {
    const entry = readRaw(key), row = definition(key, input), supported = contract.known
      ? contract.keys.includes(key) && (contract.id !== 'nr-legacy' || Boolean(entry) || ['Enabled', 'Mode', 'Intensity', 'Style', 'AutoMask'].includes(key)) : Boolean(entry);
    capabilities[key] = supported;
    if (entry) { raw[key] = entry.raw; saved[key] = savedValue(entry, key); }
    if (!supported) continue;
    const fallback = own(defaults, key) ? defaults[key] : null;
    let value = null;
    if (contract.known) {
      if (row.type === 'enum') value = entry ? row.values.find(v => v.toLowerCase() === entry.value.slice(0, 31).toLowerCase()) || fallback : fallback;
      else {
        value = row.type === 'float' ? nativeFloat(key, fallback) : nativeInt(key, fallback);
        if (row.type === 'boolean') value = Number(value !== 0);
        else if (value !== null) {
          if (key === 'Style' || /^Layer[2-5]Style$/.test(key) || key === 'CompatPostPercent') value >>>= 0;
          value = key === 'Mode' ? value === 1 ? 1 : 2 : clamp(value, row.min, row.max);
        }
      }
    }
    effective[key] = value;
    const invalid = Boolean(entry && (row.type === 'enum' ? !row.values.some(v => v.toLowerCase() === entry.value.toLowerCase()) : parsedNumber(entry.value, row.type !== 'float') === null));
    fields[key] = { present: Boolean(entry), source: entry ? 'saved' : fallback === null ? 'unknown' : 'default', status: invalid ? 'invalid' : entry ? 'saved' : fallback === null ? 'missing' : 'default',
      raw: entry?.raw ?? null, saved: entry ? saved[key] : null, defaultValue: fallback, effective: value, effectiveKnown: contract.known, ...(entry ? { line: entry.index + 1 } : {}) };
  }
  const reasons = {};
  if (contract.colourMemory) {
    // Match the delivered Core's Win32 parser and two independent colour banks.
    const mode = nativeInt('ColourLabMode', 2);
    effective.ColourLabMode = !readRaw('ColourLabMode')?.value && readRaw('AllowUnverifiedHdrColor')?.value ? 0 : mode === 0 || mode === 1 ? mode : 2;
    const priority = effective.ColourLabMode === 1 || effective.ColourLabMode === 0 && effective.AllowUnverifiedHdrColor !== 0;
    const old = nativeFloat('ColorStrength', null);
    effective.ColourPriorityStrength = clamp(nativeFloat('ColourPriorityStrength', priority && old !== null ? old : .7), 0, 2);
    effective.ColourConservativeStrength = clamp(nativeFloat('ColourConservativeStrength', !priority && old !== null ? old : 1), 0, 2);
    effective.ColorStrength = priority ? effective.ColourPriorityStrength : effective.ColourConservativeStrength;
  }
  if (contract.dline) {
    const mode = readRaw('WorkMode'), scale = readRaw('CustomWorkScale'), modeValue = mode ? Number(mode.value) : 0, scaleValue = scale ? Number(scale.value) : 1;
    const exact = (entry, integer) => !entry || (integer ? /^[+-]?\d+$/.test(entry.value) : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(entry.value));
    const rejected = !exact(mode, true) || !exact(scale, false) || !Number.isInteger(modeValue) || modeValue < 0 || modeValue > 5 ||
      !Number.isFinite(scaleValue) || !(scaleValue >= 0.5 && scaleValue <= 1 || modeValue === 5 && scaleValue === 0);
    if (rejected || modeValue === 5 && scaleValue === 0) {
      effective.WorkMode = effective.CustomWorkScale = null;
      reasons.WorkMode = reasons.CustomWorkScale = rejected ? 'previous-valid-work-request-required' : 'disable-and-retain-previous-work-request';
      if (!rejected) effective.Enabled = 0;
    } else { effective.WorkMode = modeValue; effective.CustomWorkScale = scaleValue; }
  }
  let migration = null, layers = [];
  if (contract.dualLayer) {
    // D13 shares model parameters across its two passes; it has no Layer2/3 banks.
    effective.NRPasses = nativeInt('NRPasses', 1) === 2 ? 2 : 1;
    let numerator = nativeInt('NRSecondScaleNumerator', 1) >>> 0, denominator = nativeInt('NRSecondScaleDenominator', 2) >>> 0;
    if (!numerator || !denominator || denominator > 10000 || numerator > denominator || numerator * 4 < denominator) {
      numerator = 1; denominator = 2;
    }
    const gcd = (a, b) => b ? gcd(b, a % b) : a, divisor = gcd(numerator, denominator);
    effective.NRSecondScaleNumerator = numerator / divisor; effective.NRSecondScaleDenominator = denominator / divisor;
    for (let index = 1; index <= 2; index++) layers.push({ index, enabled: index <= effective.NRPasses,
      active: index <= effective.NRPasses, configured: true, sharedModel: true,
      values: Object.fromEntries(Object.keys(MODEL_DEFAULTS).map(key => [key, effective[key]])),
      saved: Object.fromEntries(Object.keys(MODEL_DEFAULTS).filter(key => own(saved, key)).map(key => [key, saved[key]])),
      modelSkinStructureStrength: effective.AutoMask ? Math.max(0, effective.SkinStructureStrength) : -1 });
  }
  if (contract.uniform) {
    const originalMode = nativeInt('Mode', 2), pre = nativeFloat('TransferStrength', null), post = nativeFloat('PostTransferStrength', null);
    const preSelected = nativeInt('StrengthConfigVersion', 0) >= 1 || originalMode !== 1;
    let strength = clamp((preSelected ? pre ?? post : post ?? pre) ?? 1, 0, 4);
    if (nativeInt('ExtraStrengthPolicyVersion', 0) < 1) { if (strength === 0) effective.Enabled = 0; strength = Math.max(1, strength); }
    effective.TransferStrength = effective.PostTransferStrength = strength;
    const start = readRaw('ProcessingStart')?.value;
    effective.ProcessingStart = FIELD_DEFINITIONS.ProcessingStart.values.find(v => v.toLowerCase() === start?.toLowerCase()) || (originalMode === 1 ? 'After' : 'Before');
    effective.Mode = effective.ProcessingStart === 'Before' ? 2 : effective.ProcessingStart === 'After' ? 1 : originalMode === 1 ? 1 : 2;
    const postPercent = nativeInt('PostWorkPercent', 100);
    if (postPercent < 50 || postPercent > 100) {
      effective.PostWorkPercent = null; reasons.PostWorkPercent = postPercent === 0 ? 'disable-and-retain-previous-work-request' : 'previous-valid-work-request-required';
      if (postPercent === 0) effective.Enabled = 0;
    }
    effective.SkinStructureStrength = Math.max(effective.AutoMask ? 0 : -1, effective.SkinStructureStrength);
    effective.LightControlMode = Math.min(nativeInt('LightControlMode', 1) >>> 0, 1);
    effective.LightPresetColor = clamp(nativeFloat('LightPresetColor', effective.ColorStrength), 0, 2);
    const lighting = ['LightBroad', 'LightDark', 'LightReflection', 'LightStructure', 'LightGlow'];
    const presets = [[1, 1, 1, 1, 0], [1, .85, 1.1, 1.05, .3], [1, 1, 1, 1, .7]];
    const samePreset = index => presets[index]?.every((value, i) => effective[lighting[i]] === Math.fround(value));
    const styleVersion = nativeInt('LightStyleVersion', 0) >>> 0, preset = nativeInt('LightPreset', 0) >>> 0;
    if (styleVersion === 0 && samePreset(0)) { effective.LightPreset = 0; effective.LightPresetColor = effective.ColorStrength; }
    else effective.LightPreset = styleVersion === 1 && samePreset(preset) ? preset : 3;
    effective.LightStyleVersion = 1;
    const migrated = nativeInt('UniformChainVersion', 0) < 1;
    let legacyCount = 1;
    if (migrated) {
      let passes = nativeInt('NRPasses', 1), full = nativeInt('NRFullReference', 0) !== 0;
      const oldControls = nativeInt('NRLayerControlsVersion', 0) < 2;
      let fullPasses = nativeInt('NRFullPasses', oldControls ? 2 : 3);
      if (oldControls) { if (full) passes = 2; if (full && fullPasses <= 2) full = false; fullPasses = clamp(fullPasses, 3, 5); }
      legacyCount = passes === 2 ? full ? clamp(fullPasses, 3, 5) : 2 : 1;
      migration = { pending: true, layerCount: legacyCount, source: 'legacy-layer-settings', workScaleArchived: legacyCount > 1 && nativeInt('NRSecondScaleNumerator', 1) !== nativeInt('NRSecondScaleDenominator', 2) };
    }
    let active = true;
    for (let layer = 1; layer <= 5; layer++) {
      const prefix = layer === 1 ? '' : `Layer${layer}`;
      if (layer > 1 && migrated) {
        effective[`${prefix}Enabled`] = Number(layer <= legacyCount); effective[`${prefix}Configured`] = Number(layer <= legacyCount);
        for (const key of Object.keys(MODEL_DEFAULTS)) effective[prefix + key] = layer <= legacyCount ? effective[key] : MODEL_DEFAULTS[key];
      }
      if (layer > 1) effective[prefix + 'SkinStructureStrength'] = Math.max(effective[prefix + 'AutoMask'] ? 0 : -1, effective[prefix + 'SkinStructureStrength']);
      const enabled = layer === 1 || effective[prefix + 'Enabled'] === 1; active = active && enabled;
      layers.push({ index: layer, enabled, active, configured: layer === 1 || effective[prefix + 'Configured'] === 1,
        values: Object.fromEntries(Object.keys(MODEL_DEFAULTS).map(key => [key, effective[prefix + key]])),
        saved: Object.fromEntries(Object.keys(MODEL_DEFAULTS).filter(key => own(saved, prefix + key)).map(key => [key, saved[prefix + key]])),
        modelSkinStructureStrength: effective[prefix + 'AutoMask'] ? effective[prefix + 'SkinStructureStrength'] : -1 });
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    field.effective = effective[key]; field.effectiveKnown = contract.known && effective[key] !== null;
    if (migration?.pending && /^Layer[2-5]/.test(key)) { field.reason = 'legacy-layer-migration'; if (!field.present) { field.source = 'migration'; field.status = 'migrated'; } }
    field.adjusted = field.present && field.effectiveKnown && typeof field.saved === 'number' && Math.abs(field.saved - effective[key]) > 1e-6;
    if (reasons[key]) field.reason = reasons[key];
  }
  // Flat values retain the old API, but a saved value always wins over a
  // separately resolved effective/default value. No silent precision changes.
  const flat = Object.fromEntries(Object.keys(fields).filter(key => own(saved, key) || own(defaults, key)).map(key => [key, own(saved, key) ? saved[key] : fields[key].effectiveKnown ? effective[key] : defaults[key]]));
  return { ...flat, saved, raw, defaults, effective, fields, capabilities, contract, ...(configLimits(input) ? { limits: configLimits(input) } : {}), layers,
    layerCount: layers.length ? layers.filter(layer => layer.active).length : null, migration,
    warnings: doc.duplicates.map(row => ({ ...row, code: 'DUPLICATE_INI_ENTRY', message: '按首个配置节和首个同名键读取；后续重复项保持原样。' })), runtimeVerified: false, source: 'active-ini' };
}

function readConfig(file, input = '') {
  try {
    const bytes = fs.readFileSync(file), document = decode(bytes), value = inspectText(document.text, input);
    if (document.encoding === 'utf8' && document.bom) {
      // Windows profile APIs document ANSI/UTF-16 input; UTF-8 BOM recognition
      // is not established for this Core. Preserve bytes/saved values without
      // presenting the Manager's text decode as a verified runtime result.
      for (const [key, field] of Object.entries(value.fields)) { value.effective[key] = null; field.effective = null; field.effectiveKnown = false; field.adjusted = false; field.reason = 'utf8-bom-profile-semantics-unverified'; }
      value.layers = []; value.layerCount = null;
      value.warnings.push({ code: 'UTF8_BOM_PROFILE_UNVERIFIED', message: '文件含 UTF-8 BOM；保存值可读取，但当前 Core 的实际采用值尚未确认。' });
    }
    return { ...value, status: 'ready', exists: true, readable: true, file, encoding: document.encoding, bom: document.bom, fingerprint: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    const missing = error.code === 'ENOENT';
    return { status: missing ? 'missing' : 'error', exists: !missing, readable: false, file,
      error: { code: missing ? 'ERR_NR_CONFIG_MISSING' : error.code || 'ERR_NR_CONFIG_READ', message: missing ? '当前 NR 配置文件不存在。' : `无法读取当前 NR 配置：${error.message}` },
      saved: {}, raw: {}, effective: {}, fields: {}, capabilities: {}, defaults: resolveContract(input).defaults,
      contract: resolveContract(input), layers: [], layerCount: null, warnings: [], runtimeVerified: false, source: 'active-ini' };
  }
}
function normalizePatch(patch, input) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) fail('ERR_BAD_REQUEST', 'NR 修改必须是键值对象。');
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, normalizeValue(key, value, input)]));
}
function preparedPatch(text, patch, input) {
  const normalized = normalizePatch(patch || {}, input), contract = resolveContract(input);
  if (contract.dualLayer && ['NRSecondScaleNumerator', 'NRSecondScaleDenominator'].some(key => own(normalized, key))) {
    const current = inspectText(text, input).effective;
    const numerator = normalized.NRSecondScaleNumerator ?? current.NRSecondScaleNumerator;
    const denominator = normalized.NRSecondScaleDenominator ?? current.NRSecondScaleDenominator;
    if (numerator > denominator || numerator * 4 < denominator) fail('ERR_BAD_REQUEST', 'D13 第二层比例须在 25%–100% 之间。');
    normalized.NRSecondScaleNumerator = numerator; normalized.NRSecondScaleDenominator = denominator;
  }
  if (!contract.uniform) return normalized;
  if (contract.colourMemory && ['ColourLabMode', 'AllowUnverifiedHdrColor', 'ColorStrength', 'ColourPriorityStrength', 'ColourConservativeStrength'].some(key => own(normalized, key))) {
    const current = inspectText(text, input).effective;
    const mode = normalized.ColourLabMode ?? current.ColourLabMode;
    const priority = mode === 1 || mode === 0 && (normalized.AllowUnverifiedHdrColor ?? current.AllowUnverifiedHdrColor) !== 0;
    const bank = priority ? 'ColourPriorityStrength' : 'ColourConservativeStrength';
    for (const key of ['ColourPriorityStrength', 'ColourConservativeStrength']) normalized[key] ??= current[key];
    if (own(normalized, 'ColorStrength')) normalized[bank] = normalized.ColorStrength;
    normalized.ColorStrength = normalized[bank];
  }
  if (own(normalized, 'TransferStrength') || own(normalized, 'PostTransferStrength')) {
    if (own(normalized, 'TransferStrength') && own(normalized, 'PostTransferStrength') && normalized.TransferStrength !== normalized.PostTransferStrength)
      fail('ERR_BAD_REQUEST', '当前 Core 的前后置最终强度共享一个值。');
    normalized.TransferStrength = normalized.PostTransferStrength = normalized.TransferStrength ?? normalized.PostTransferStrength;
    normalized.StrengthConfigVersion = normalized.ExtraStrengthPolicyVersion = 1;
  }
  if (own(normalized, 'ProcessingStart')) {
    if (normalized.ProcessingStart !== 'Present') normalized.Mode = normalized.ProcessingStart === 'Before' ? 2 : 1;
    normalized.ConfigVersion = 4;
  }
  const lighting = ['LightBroad', 'LightDark', 'LightReflection', 'LightStructure', 'LightGlow'];
  if (own(normalized, 'LightPreset') && normalized.LightPreset < 3) {
    const values = [[1, 1, 1, 1, 0], [1, .85, 1.1, 1.05, .3], [1, 1, 1, 1, .7]][normalized.LightPreset];
    for (let index = 0; index < lighting.length; index++) if (!own(normalized, lighting[index])) normalized[lighting[index]] = values[index];
  } else if (lighting.some(key => own(normalized, key))) normalized.LightPreset = 3;
  if (lighting.some(key => own(normalized, key)) || own(normalized, 'LightPreset')) {
    normalized.LightStyleVersion = 1;
    if (!own(normalized, 'LightPresetColor')) normalized.LightPresetColor = normalized.ColorStrength ?? inspectText(text, input).effective.ColorStrength;
  }
  if (Object.keys(normalized).some(key => /^Layer[2-5]/.test(key))) {
    const current = inspectText(text, input);
    if (current.migration?.pending) {
      for (const layer of current.layers.slice(1)) {
        const prefix = `Layer${layer.index}`;
        for (const [key, value] of Object.entries({ Enabled: Number(layer.enabled), Configured: Number(layer.configured), ...layer.values }))
          if (!own(normalized, prefix + key)) normalized[prefix + key] = value;
      }
      normalized.UniformChainMigrated = Number(current.migration.workScaleArchived);
    }
    for (let layer = 2; layer <= 5; layer++) if (Object.keys(normalized).some(key => key.startsWith(`Layer${layer}`) && !['Enabled', 'Configured'].includes(key.slice(6)))) normalized[`Layer${layer}Configured`] = 1;
    normalized.UniformChainVersion = 1;
  }
  return normalized;
}
function replaceValue(entry, value) {
  // Win32 profile strings include inline comments; preserving one on an enum
  // would change the requested value. Keep numeric comments and whitespace.
  const suffix = (typeof value === 'number' && entry.raw.match(/\s+[;#].*$/)?.[0]) || entry.raw.match(/\s+$/)?.[0] || '';
  return entry.prefix + String(value) + suffix;
}
function applyTextPatch(text, normalized) {
  const doc = documentOf(text), lines = doc.lines.map(line => ({ ...line })), missing = [];
  for (const [key, value] of Object.entries(normalized)) {
    const entry = doc.entries.get(key.toLowerCase());
    if (entry) lines[entry.index].text = replaceValue(entry, value); else missing.push(`${key}=${value}`);
  }
  if (!Object.keys(normalized).length) return text;
  if (doc.start < 0) {
    if (lines.length && !lines.at(-1).newline) lines.at(-1).newline = doc.newline;
    lines.push({ text: `[${SECTION}]`, newline: doc.newline }, ...missing.map(value => ({ text: value, newline: doc.newline })));
  } else if (missing.length) {
    let index = doc.end;
    while (index > doc.start + 1 && !lines[index - 1].text.trim()) index--;
    if (index > 0 && !lines[index - 1].newline) lines[index - 1].newline = doc.newline;
    lines.splice(index, 0, ...missing.map(value => ({ text: value, newline: doc.newline })));
  }
  return lines.map(line => line.text + line.newline).join('');
}
function updateSection(text, patch, input = '') {
  const bom = String(text || '').startsWith('\uFEFF') ? '\uFEFF' : '', content = String(text || '').replace(/^\uFEFF/, '');
  return bom + applyTextPatch(content, preparedPatch(content, patch, input));
}

const writes = new Map();
async function writeConfig(file, patch, input = '', options = {}) {
  const identity = path.resolve(file).toLowerCase();
  const task = (writes.get(identity) || Promise.resolve()).catch(() => {}).then(async () => {
    let before = null;
    try { before = await fs.promises.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (own(options, 'expectedFingerprint') && options.expectedFingerprint !== (before === null ? null : crypto.createHash('sha256').update(before).digest('hex')))
      fail('ERR_NR_CONFIG_CHANGED', 'NR 配置已被外部修改，请按当前值重新应用。');
    const document = before === null ? { text: '', encoding: 'utf8', bom: false } : decode(before), normalized = preparedPatch(document.text, patch, input);
    const next = encode(document, applyTextPatch(document.text, normalized));
    if (next.length > MAX_BYTES) fail('ERR_NR_CONFIG_SIZE', '修改后的 NR 配置超过 1 MiB。');
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.xiaofeng-${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temp, next, { flag: 'wx' });
      let now = null;
      try { now = await fs.promises.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Boolean(before) !== Boolean(now) || before && !before.equals(now)) fail('ERR_NR_CONFIG_CHANGED', 'NR 配置已被外部修改，请按当前值重新应用。');
      await fs.promises.rename(temp, file);
      const result = readConfig(file, input);
      if (result.status !== 'ready' || result.fingerprint !== crypto.createHash('sha256').update(next).digest('hex') || Object.entries(normalized).some(([key, value]) => result.saved[key] !== value))
        fail('ERR_NR_CONFIG_READBACK', 'NR 配置写入后的读回不一致，请重新读取当前设置。');
      return { ...result, readbackVerified: true };
    } finally { await fs.promises.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
  writes.set(identity, task);
  try { return await task; } finally { if (writes.get(identity) === task) writes.delete(identity); }
}
function layerCountPatch(count, current, input = '') {
  if (resolveContract(input).dualLayer && Number.isInteger(count) && count >= 1 && count <= 2) return { NRPasses: count };
  if (!resolveContract(input).uniform || !Number.isInteger(count) || count < 1 || count > 5) fail('ERR_BAD_REQUEST', '当前 Core 的模型层数须为 1–5。');
  const patch = { UniformChainVersion: 1 };
  for (let layer = 2; layer <= 5; layer++) { patch[`Layer${layer}Enabled`] = Number(layer <= count); if (layer <= count) patch[`Layer${layer}Configured`] = 1; }
  return patch;
}
function resetLayerPatch(layer, input = '') {
  if (!resolveContract(input).uniform || !Number.isInteger(layer) || layer < 1 || layer > 5) fail('ERR_BAD_REQUEST', '当前 Core 未提供这一个模型层。');
  const prefix = layer === 1 ? '' : `Layer${layer}`;
  return { ...Object.fromEntries(Object.entries(MODEL_DEFAULTS).map(([key, value]) => [prefix + key, value])), ...(layer === 1 ? {} : { [`${prefix}Configured`]: 1 }) };
}
function defaultPatch(input = '') {
  const contract = resolveContract(input);
  if (contract.uniform) return { ...resetLayerPatch(1, input), ...layerCountPatch(1, null, input), ProcessingStart: 'Before', WorkMode: 0, CustomWorkScale: 1,
    TransferStrength: 1, PostTransferStrength: 1, ColorStrength: 1,
    ...(contract.colourMemory ? { ColourLabMode: 2, ColourPriorityStrength: .7, ColourConservativeStrength: 1 } : {}),
    LightingLock: 0, EdgeGuard: 0, DetailStability: 0, NRInputFilter: 0, HighStrengthProtection: 1, ColorProtection: 1 };
  return Object.fromEntries(Object.entries(contract.known ? contract.defaults : LEGACY_DEFAULTS).filter(([key]) => !['Mode', 'UICorrection'].includes(key)));
}

module.exports = { SECTION, readConfig, parseSection, updateSection, writeConfig, defaultPatch, recommendedPatch: defaultPatch,
  normalizeValue, configLimits, resolveContract, layerCountPatch, resetLayerPatch };
