'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_NR_CONFIG, PUBLIC_NR_KEYS } = require('./constants');
const { appError } = require('./errors');

const SECTION = 'NRBeforeSR';

function isDline05(version = '') {
  return /(?:^|[-+])(?:beta)?0\.5(?:[.-]|$)/i.test(String(version));
}

function configLimits(version = '') {
  return isDline05(version) ? {
    CustomWorkScale: { min: 0.5, max: 1 },
    TransferStrength: { min: 1, max: 4 },
    PostTransferStrength: { min: 1, max: 4 }
  } : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeValue(key, value, version = '') {
  const limit = configLimits(version)?.[key];
  if (limit) value = clamp(Number(value) || 0, limit.min, limit.max);
  if (key === 'Enabled' || key === 'AutoMask' || key === 'UICorrection') return value ? 1 : 0;
  if (key === 'Mode') return Number(value) === 1 ? 1 : 2;
  if (key === 'WorkMode') return Math.round(clamp(Number(value) || 0, 0, 5));
  if (key === 'CustomWorkScale') return Number(clamp(Number(value) || 0, 0.25, 1).toFixed(2));
  if (key === 'Style') return Math.round(clamp(Number(value) || 0, 0, 2));
  if (key === 'Intensity') return Number(clamp(Number(value) || 0, 0, 2).toFixed(2));
  if (key === 'SkinStructureStrength') return Number(clamp(Number(value), -1, 2).toFixed(2));
  if (key === 'LocalToneStrength' || key === 'LocalStructureStrength') {
    return Number(clamp(Number(value) || 0, 0, 2).toFixed(2));
  }
  if (key === 'TransferStrength' || key === 'PostTransferStrength') {
    return Number(clamp(Number(value) || 0, 0, 4).toFixed(2));
  }
  if (key === 'ColorStrength') {
    return Number(clamp(Number(value) || 0, 0, 2).toFixed(2));
  }
  throw appError('ERR_BAD_REQUEST', { key });
}

function parseSection(text) {
  const result = {};
  let active = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const section = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      active = section[1].trim().toLowerCase() === SECTION.toLowerCase();
      continue;
    }
    if (!active || /^\s*[;#]/.test(raw)) continue;
    const pair = raw.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (!pair) continue;
    const key = pair[1].trim();
    if (!(key in DEFAULT_NR_CONFIG)) continue;
    const number = Number(pair[2]);
    if (Number.isFinite(number)) result[key] = normalizeValue(key, number);
  }
  return result;
}

function readConfig(file, version = '') {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {}
  const parsed = parseSection(text);
  const full = { ...DEFAULT_NR_CONFIG, ...parsed };
  return {
    ...(configLimits(version) ? { limits: configLimits(version) } : {}),
    Enabled: full.Enabled,
    Intensity: full.Intensity,
    WorkMode: full.WorkMode,
    CustomWorkScale: full.CustomWorkScale,
    Style: full.Style,
    AutoMask: full.AutoMask,
    ColorStrength: full.ColorStrength,
    SkinStructureStrength: full.SkinStructureStrength,
    LocalToneStrength: full.LocalToneStrength,
    LocalStructureStrength: full.LocalStructureStrength,
    TransferStrength: full.TransferStrength,
    PostTransferStrength: full.PostTransferStrength,
    capabilities: {
      WorkMode: Object.prototype.hasOwnProperty.call(parsed, 'WorkMode'),
      CustomWorkScale: Object.prototype.hasOwnProperty.call(parsed, 'CustomWorkScale'),
      ColorStrength: Object.prototype.hasOwnProperty.call(parsed, 'ColorStrength'),
      SkinStructureStrength: Object.prototype.hasOwnProperty.call(parsed, 'SkinStructureStrength'),
      LocalToneStrength: Object.prototype.hasOwnProperty.call(parsed, 'LocalToneStrength'),
      LocalStructureStrength: Object.prototype.hasOwnProperty.call(parsed, 'LocalStructureStrength'),
      TransferStrength: Object.prototype.hasOwnProperty.call(parsed, 'TransferStrength'),
      PostTransferStrength: Object.prototype.hasOwnProperty.call(parsed, 'PostTransferStrength')
    }
  };
}

function updateSection(text, patch, version = '') {
  const normalized = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (!PUBLIC_NR_KEYS.includes(key)) {
      throw appError('ERR_BAD_REQUEST', { key });
    }
    normalized[key] = normalizeValue(key, value, version);
  }

  const newline = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const section = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (!section) continue;
    if (section[1].trim().toLowerCase() === SECTION.toLowerCase()) {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\[[^\]]+\]\s*$/.test(lines[j])) { end = j; break; }
      }
      break;
    }
  }

  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push(`[${SECTION}]`);
    for (const [key, value] of Object.entries(normalized)) lines.push(`${key}=${value}`);
    return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
  }

  const seen = new Set();
  for (let i = start + 1; i < end; i++) {
    const pair = lines[i].match(/^(\s*)([^=;#]+?)(\s*=\s*)(.*)$/);
    if (!pair) continue;
    const key = pair[2].trim();
    if (!(key in normalized)) continue;
    lines[i] = `${pair[1]}${key}${pair[3]}${normalized[key]}`;
    seen.add(key);
  }
  const missing = Object.keys(normalized).filter(key => !seen.has(key));
  let insertAt = end;
  while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt--;
  lines.splice(insertAt, 0, ...missing.map(key => `${key}=${normalized[key]}`));
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}

async function writeConfig(file, patch, version = '') {
  let current = '';
  try { current = await fs.promises.readFile(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = updateSection(current, patch, version);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.xiaofeng.tmp`;
  await fs.promises.writeFile(temp, next, 'utf8');
  await fs.promises.rename(temp, file);
  return readConfig(file, version);
}

function defaultPatch(version = '') {
  const currentBeta = /^0\.4\.7(?:beta|-beta)(?:$|[.-])/.test(String(version)) || isDline05(version);
  return {
    Enabled: 1,
    Intensity: currentBeta ? 1.2 : 1.0,
    WorkMode: 0,
    CustomWorkScale: 1.0,
    Style: 0,
    AutoMask: 0,
    ColorStrength: currentBeta ? 1.0 : 0.75,
    SkinStructureStrength: -1,
    LocalToneStrength: 1.0,
    LocalStructureStrength: 1.0,
    TransferStrength: 1.0,
    PostTransferStrength: 1.0
  };
}

// Kept as a compatibility alias for older renderer builds. The product UI calls
// this “恢复默认”; it is deliberately a neutral product default.
const recommendedPatch = defaultPatch;

module.exports = {
  SECTION,
  readConfig,
  parseSection,
  updateSection,
  writeConfig,
  defaultPatch,
  recommendedPatch,
  normalizeValue,
  configLimits
};
