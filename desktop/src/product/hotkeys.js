'use strict';

const fs = require('fs');
const path = require('path');
const { appError } = require('./errors');

const DEFAULT_RESHADE_KEY = 36;
const PREVIOUS_RESHADE_DEFAULT_KEY = 187;
const MANAGED_RESHADE_DEFAULT_KEYS = Object.freeze([36, 187]);
// KeyOverlay stores [Windows virtual key, Ctrl, Shift, Alt]. OEM punctuation
// stays numeric here (e.g. '=' is VK_OEM_PLUS 0xBB, not character code 0x3D).
// Reference: https://github.com/crosire/reshade/blob/main/source/input.hpp
const DEFAULT_RESHADE_VALUES = [DEFAULT_RESHADE_KEY, 0, 0, 0];
const DEFAULT_RESHADE_BINDING = Object.freeze({ key: DEFAULT_RESHADE_KEY, ctrl: false, shift: false, alt: false });

function hasKeyOverlay(text) {
  let active = false;
  for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const section = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) { active = section[1].trim().toLowerCase() === 'input'; continue; }
    if (active && /^\s*KeyOverlay\s*=/i.test(raw)) return true;
  }
  return false;
}
function ensureDefaultReShadeHotkey(text, defaultKey = DEFAULT_RESHADE_KEY) {
  // An explicit key, including 0 (disabled), belongs to the user or runtime.
  // Do not normalize or replace it while preparing unrelated components.
  const current = String(text || '');
  return hasKeyOverlay(current) ? current : updateKeyOverlay(current, { ...DEFAULT_RESHADE_BINDING, key: defaultKey });
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object') throw appError('ERR_BAD_REQUEST');
  const key = Number(binding.key);
  if (!Number.isInteger(key) || key < 1 || key > 255) throw appError('ERR_BAD_REQUEST');
  return {
    key,
    ctrl: binding.ctrl === true,
    shift: binding.shift === true,
    alt: binding.alt === true
  };
}

function bindingFromValues(values, present = true) {
  const list = Array.isArray(values) ? values : DEFAULT_RESHADE_VALUES;
  const key = Number(list[0]);
  return {
    key: Number.isInteger(key) && key > 0 && key <= 255 ? key : DEFAULT_RESHADE_KEY,
    ctrl: Number(list[1]) === 1,
    shift: Number(list[2]) === 1,
    alt: Number(list[3]) === 1,
    present
  };
}

function parseKeyOverlay(text) {
  let active = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const section = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      active = section[1].trim().toLowerCase() === 'input';
      continue;
    }
    if (!active || /^\s*[;#]/.test(raw)) continue;
    const pair = raw.match(/^\s*KeyOverlay\s*=\s*(.*?)\s*$/i);
    if (!pair) continue;
    const values = pair[1].split(',').map(value => Number(value.trim()));
    if (values.length < 4 || values.slice(0, 4).some(value => !Number.isFinite(value))) continue;
    return bindingFromValues(values, true);
  }
  return bindingFromValues(DEFAULT_RESHADE_VALUES, false);
}

function updateKeyOverlay(text, binding) {
  const normalized = normalizeBinding(binding);
  const value = [
    normalized.key,
    normalized.ctrl ? 1 : 0,
    normalized.shift ? 1 : 0,
    normalized.alt ? 1 : 0
  ].join(',');
  const newline = String(text || '').includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text || '').split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const section = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (!section) continue;
    if (section[1].trim().toLowerCase() === 'input') {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\[[^\]]+\]\s*$/.test(lines[j])) { end = j; break; }
      }
      break;
    }
  }

  if (start < 0) {
    if (lines.length && lines[lines.length - 1].trim()) lines.push('');
    lines.push('[INPUT]', `KeyOverlay=${value}`);
    return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
  }

  for (let i = start + 1; i < end; i++) {
    const pair = lines[i].match(/^(\s*)(KeyOverlay)(\s*=\s*)(.*)$/i);
    if (!pair) continue;
    lines[i] = `${pair[1]}${pair[2]}${pair[3]}${value}`;
    return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
  }

  let insertAt = end;
  while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt--;
  lines.splice(insertAt, 0, `KeyOverlay=${value}`);
  return lines.join(newline).replace(/(?:\r?\n)*$/, newline);
}

function readReShadeHotkey(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return parseKeyOverlay(text);
}

async function writeReShadeHotkey(file, binding) {
  let current = '';
  try { current = await fs.promises.readFile(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const next = updateKeyOverlay(current, binding);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.xiaofeng-hotkey.tmp`;
  await fs.promises.writeFile(temp, next, 'utf8');
  await fs.promises.rename(temp, file);
  return readReShadeHotkey(file);
}

module.exports = {
  DEFAULT_RESHADE_KEY,
  PREVIOUS_RESHADE_DEFAULT_KEY,
  MANAGED_RESHADE_DEFAULT_KEYS,
  DEFAULT_RESHADE_BINDING,
  hasKeyOverlay,
  ensureDefaultReShadeHotkey,
  parseKeyOverlay,
  updateKeyOverlay,
  readReShadeHotkey,
  writeReShadeHotkey,
  normalizeBinding
};
