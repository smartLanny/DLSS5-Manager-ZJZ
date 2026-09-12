'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { addonValues } = require('./reshade-layout');

const HASH = /^[a-f0-9]{64}$/;
const key = file => path.resolve(file).toLowerCase();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fingerprint = value => hash(Buffer.from(JSON.stringify(value)));
const PROTECTED = /^(?:dxgi|d3d9|d3d10(?:_1)?|d3d11|d3d12|opengl32|dinput8|version|winmm|dsound|nvngx_dlss(?:g|d|nr)?|nrchain_nvngx|_nvngx)\.dll$/i;

function sourceBinding(snapshot) {
  const p = snapshot.profile;
  const value = { version: 1, exeDir: snapshot.exeDir, architecture: snapshot.architecture,
    configured: p.configured, environment: snapshot.environment, rootConfig: p.rootConfig, config: p.config,
    identities: p.identities, sourceFingerprint: snapshot.fingerprint,
    files: snapshot.files.filter(row => row.moduleMayLoad && !PROTECTED.test(row.name)).map(row => ({ path: row.path, sha256: row.sha256, searched: row.searched, explicit: row.explicit })) };
  return { ...value, fingerprint: fingerprint(value) };
}

function validSourceBinding(binding, exeDir) {
  try {
    if (!binding || binding.version !== 1 || !path.isAbsolute(binding.exeDir || '') || key(binding.exeDir) !== key(exeDir) ||
        ![32, 64].includes(binding.architecture) || !HASH.test(binding.sourceFingerprint || '') || !HASH.test(binding.fingerprint || '') ||
        typeof binding.rootConfig !== 'string' || typeof binding.config !== 'string' ||
        Buffer.byteLength(binding.rootConfig) > 1024 * 1024 || Buffer.byteLength(binding.config) > 1024 * 1024 ||
        !Array.isArray(binding.files) || binding.files.length > 128 || !Array.isArray(binding.identities) || binding.identities.length > 2) return false;
    const { fingerprint: ignored, ...body } = binding;
    if (fingerprint(body) !== binding.fingerprint) return false;
    const resolve = (base, input) => {
      const value = String(input).replace(/%([^%]+)%/g, (all, name) => binding.environment?.[name] || all);
      if (/%[^%]+%/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^\\\\/.test(value)) throw new Error('path');
      return path.resolve(base, value);
    };
    const configured = binding.configured;
    if (!configured || ![configured.loaderDir, configured.baseDir, configured.addonDir, configured.activeConfigPath].every(path.isAbsolute) ||
        key(configured.loaderDir) !== key(exeDir)) return false;
    const roots = addonValues(binding.rootConfig, 'INSTALL').get('BasePath') || [];
    if (roots.length > 1 && new Set(roots).size > 1) return false;
    const bases = [exeDir, ...roots.map(value => resolve(exeDir, value)),
      ...(binding.environment?.RESHADE_BASE_PATH_OVERRIDE ? [resolve(exeDir, binding.environment.RESHADE_BASE_PATH_OVERRIDE)] : [])];
    if (!bases.some(base => key(base) === key(configured.baseDir)) || key(configured.activeConfigPath) !== key(path.join(configured.baseDir, 'ReShade.ini'))) return false;
    const values = addonValues(binding.config), dirs = values.get('AddonPath') || ['.'];
    if (dirs.length > 1 && new Set(dirs).size > 1 || key(resolve(configured.baseDir, dirs[0])) !== key(configured.addonDir)) return false;
    const rootConfigPath = path.join(exeDir, 'ReShade.ini'), configs = new Map([[key(rootConfigPath), binding.rootConfig], [key(configured.activeConfigPath), binding.config]]);
    if (binding.identities.length !== configs.size) return false;
    const configSeen = new Set();
    for (const row of binding.identities) {
      if (!row || !path.isAbsolute(row.file || '') || !configs.has(key(row.file)) || configSeen.has(key(row.file)) ||
          row.sha256 !== null && !HASH.test(row.sha256 || '') ||
          row.sha256 !== null && row.sha256 !== hash(Buffer.from(configs.get(key(row.file)))) ||
          row.sha256 === null && configs.get(key(row.file)) !== '') return false;
      configSeen.add(key(row.file));
    }
    const early = new Set((values.get('LoadFromDllMain') || []).map(value => key(resolve(configured.addonDir, value)))), seen = new Set();
    for (const row of binding.files) {
      if (!row || !path.isAbsolute(row.path || '') || /^\\\\/.test(row.path) || !HASH.test(row.sha256 || '') || seen.has(key(row.path)) ||
          typeof row.searched !== 'boolean' || typeof row.explicit !== 'boolean' || PROTECTED.test(path.basename(row.path))) return false;
      const searched = key(path.dirname(row.path)) === key(configured.addonDir) && ['.addon', binding.architecture === 32 ? '.addon32' : '.addon64'].includes(path.extname(row.path));
      const explicit = early.has(key(row.path)) && /\.(?:dll|addon(?:32|64)?)$/i.test(row.path);
      if (row.searched !== searched || row.explicit !== explicit || !searched && !explicit) return false;
      seen.add(key(row.path));
    }
    return true;
  } catch { return false; }
}

function sourceAllows(binding, file, exeDir) {
  return validSourceBinding(binding, exeDir) && binding.files.some(row => key(row.path) === key(file));
}

module.exports = { sourceBinding, validSourceBinding, sourceAllows };
