'use strict';

const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const { classifyAddon } = require('./conflicts');
const { appError } = require('./errors');

// ReShade ini_file vector semantics: repeated keys append and ',,' escapes
// a comma. A scalar path reads only the first element. Keys are case-sensitive.
function addonValues(text, wantedSection = 'ADDON') {
  const values = new Map(); let section = '';
  for (const physical of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = physical.trim();
    if (!line || /^[;\/#]/.test(line)) continue;
    if (line.startsWith('[')) { section = line.slice(1, line.indexOf(']') < 0 ? undefined : line.indexOf(']')).trim(); continue; }
    const equals = line.indexOf('=');
    if (section !== wantedSection || equals < 0) continue;
    const key = line.slice(0, equals).trim(), value = line.slice(equals + 1).trim();
    if (!value) continue;
    const entries = []; let current = '';
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== ',') current += value[index];
      else if (value[index + 1] === ',') { current += ','; index++; }
      else { entries.push(current); current = ''; }
    }
    entries.push(current); values.set(key, [...(values.get(key) || []), ...entries]);
  }
  return values;
}

function inspectAddonLayout(exeDir, environment = process.env) {
  const ini = path.join(exeDir, 'ReShade.ini'); let values = new Map(), text = '';
  try {
    if (fs.existsSync(ini)) {
      const stat = fs.lstatSync(ini);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid INI');
      text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(ini));
      values = addonValues(text);
    }
  } catch { return { ok: false, code: 'ERR_RESHADE_CONFIG', addonDir: exeDir }; }
  // ReShade 6.8 resolves BasePath before reading its global ReShade.ini.
  // Do not apply edits to an inactive local INI while the active one is elsewhere.
  for (const base of [addonValues(text, 'INSTALL').get('BasePath')?.[0], environment.RESHADE_BASE_PATH_OVERRIDE]) {
    if (!base) continue;
    const expanded = base.replace(/%([^%]+)%/g, (whole, name) => environment[name] || whole);
    const resolved = path.resolve(exeDir, expanded);
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
      if (resolved.toLowerCase() !== path.resolve(exeDir).toLowerCase()) return { ok: false, code: 'ERR_ADDON_SEARCH_PATH', addonDir: resolved };
      break;
    } catch (error) { if (error.code !== 'ENOENT') return { ok: false, code: 'ERR_RESHADE_CONFIG', addonDir: exeDir }; }
  }
  const configured = values.get('AddonPath')?.[0] || '.';
  const addonDir = path.resolve(exeDir, configured);
  if (addonDir.toLowerCase() !== path.resolve(exeDir).toLowerCase()) {
    return { ok: false, code: 'ERR_ADDON_SEARCH_PATH', addonDir };
  }
  const direct = values.get('LoadFromDllMain') || [];
  if (direct.some(file => classifyAddon(path.win32.basename(file)) || /carrier.*[.](?:dll|addon64)$/i.test(file))) {
    return { ok: false, code: 'ERR_ADDON_DIRECT_LOAD', addonDir };
  }
  return { ok: true, code: null, addonDir };
}

function requireAddonLayout(exeDir) {
  const layout = inspectAddonLayout(exeDir);
  if (!layout.ok) throw appError(layout.code);
  return layout;
}

module.exports = { inspectAddonLayout, requireAddonLayout, addonValues };
