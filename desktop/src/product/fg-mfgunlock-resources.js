'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PIN_CATALOG = require('./fg-mfgunlock-providers.json');

const HASH = /^[a-f0-9]{64}$/;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (PIN_CATALOG.schemaVersion !== 2 || typeof PIN_CATALOG.backend !== 'string' || typeof PIN_CATALOG.defaultProvider !== 'string' ||
    typeof PIN_CATALOG.addon !== 'string' || !Array.isArray(PIN_CATALOG.providers) || PIN_CATALOG.providers.length < 1 || !Array.isArray(PIN_CATALOG.legacyProviders))
  throw new Error('MFG Unlock provider pin catalog is invalid.');
const BACKEND = PIN_CATALOG.backend;
const ID = PIN_CATALOG.defaultProvider;
const ADDON = PIN_CATALOG.addon;
const PROVIDERS = Object.freeze(PIN_CATALOG.providers.map(row => {
  const source = row.source || {}, files = row.files || {}, addon = files.addon || {};
  return Object.freeze({ id: row.id, version: row.version, label: row.label, language: row.language, recommended: row.recommended === true,
    directory: row.directory || '', sha256: addon.sha256, commit: source.commit, readmeSha256: files.readme?.sha256,
    licenseSha256: files.license?.sha256, origin: row.origin || source.origin, addonOnly: Object.keys(files).length === 1,
    sourceRepository: source.repository, sourceUrl: source.url });
}));
const LEGACY_PROVIDERS = Object.freeze(PIN_CATALOG.legacyProviders.map(row => Object.freeze({
  id: row.id, version: row.version, sha256: row.sha256, recoveryOnly: true
})));
if (!PROVIDERS.every(row => typeof row.id === 'string' && typeof row.version === 'string' && row.sha256 && HASH.test(row.sha256) &&
    row.origin && row.directory !== undefined) || new Set(PROVIDERS.map(row => row.id)).size !== PROVIDERS.length || !PROVIDERS.some(row => row.id === ID))
  throw new Error('MFG Unlock provider pin catalog contains an invalid provider.');
if (!LEGACY_PROVIDERS.every(row => typeof row.id === 'string' && typeof row.version === 'string' && HASH.test(row.sha256)) ||
    new Set([...PROVIDERS, ...LEGACY_PROVIDERS].map(row => row.id)).size !== PROVIDERS.length + LEGACY_PROVIDERS.length)
  throw new Error('MFG Unlock legacy recovery catalog contains an invalid provider.');
const DEFAULT_PROVIDER = PROVIDERS.find(row => row.id === ID);
const SOURCE_BUILD_PROVIDER = PROVIDERS.find(row => row.origin === 'source-build') || null;
const SHA256 = DEFAULT_PROVIDER.sha256;
const SOURCE_BUILD_ID = SOURCE_BUILD_PROVIDER?.id || null;
const SOURCE_BUILD_SHA256 = SOURCE_BUILD_PROVIDER?.sha256 || null;
const LICENSE_SHA256 = PROVIDERS.find(row => row.licenseSha256)?.licenseSha256 || null;
const knownProviderForHash = hash => [...PROVIDERS, ...LEGACY_PROVIDERS].find(row => row.sha256 === hash) || null;
const providerById = id => PROVIDERS.find(row => row.id === id) || null;
const recoveryProviderById = id => providerById(id) || LEGACY_PROVIDERS.find(row => row.id === id) || null;
function readMfgUnlockResources(root, providerId = ID) {
  const fail = message => { throw Object.assign(new Error(message), { code: 'SETTINGS_FG_RESOURCES' }); };
  const selected = providerById(providerId); if (!selected) fail('未知 MFG Unlock 版本。');
  const manifestFile = path.join(root, 'manifest.json'); let catalog;
  try {
    if (fs.statSync(manifestFile).size > 65536) fail('MFG Unlock 资源清单过大。');
    catalog = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch { fail('MFG Unlock 资源清单缺失或损坏。'); }
  if (catalog.version !== 3 || catalog.backend !== BACKEND || catalog.defaultProvider !== ID || !Array.isArray(catalog.providers) ||
      catalog.providers.length !== PROVIDERS.length || new Set(catalog.providers.map(row => row?.id)).size !== PROVIDERS.length)
    fail('MFG Unlock 资源目录身份无效。');
  // The catalog cannot authorize new bytes. Optional missing fallbacks do not
  // make the selected pinned provider unusable.
  for (const row of catalog.providers) {
    const pin = providerById(row.id);
    const files = row?.files && typeof row.files === 'object' && !Array.isArray(row.files) ? row.files : null;
    const source = row?.source && typeof row.source === 'object' ? row.source : null;
    const names = files ? Object.keys(files).sort() : [];
    const sourceIdentity = Boolean(pin && source && source.tag === pin.version && source.origin === pin.origin &&
      (!pin.commit || source.commit === pin.commit) && (!pin.sourceRepository || source.repository === pin.sourceRepository) &&
      (!pin.sourceUrl || source.url === pin.sourceUrl));
    const filesIdentity = Boolean(files && files.addon?.file === ADDON && files.addon.sha256 === pin?.sha256 &&
      (pin?.addonOnly
        ? names.length === 1 && names[0] === 'addon'
        : names.length === 3 && names.includes('addon') && files.license?.file === 'LICENSE' && files.license.sha256 === pin.licenseSha256 &&
          files.readme?.file === 'README.md' && files.readme.sha256 === pin.readmeSha256));
    if (!pin || row.releaseVersion !== pin.version || row.directory !== pin.directory || row.license !== 'MIT' ||
        !sourceIdentity || !filesIdentity)
      fail('MFG Unlock 资源清单身份无效。');
  }
  const row = catalog.providers.find(value => value.id === providerId);
  const manifest = { ...structuredClone(row), version: 3, backend: BACKEND, sources: [row.source] };
  for (const item of Object.values(manifest.files)) {
    const file = path.join(root, selected.directory, item.file); let bytes;
    try {
      let current = file;
      while (true) { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(); const parent = path.dirname(current); if (parent === current) break; current = parent; }
      const stat = fs.statSync(file); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error(); bytes = fs.readFileSync(file);
    } catch { fail('MFG Unlock 资源缺失或路径不安全：' + selected.id + '/' + item.file); }
    if (!bytes.length || sha256(bytes) !== item.sha256) fail('MFG Unlock 资源校验失败：' + selected.id + '/' + item.file);
    item.source = file;
  }
  return manifest;
}
function readMfgUnlockCatalog(root) {
  return PROVIDERS.map(row => {
    try { readMfgUnlockResources(root, row.id); return { ...row, available: true, ready: true }; }
    catch (error) { return { ...row, available: false, ready: false, blocker: error.message }; }
  });
}
module.exports = { ID, BACKEND, ADDON, SHA256, SOURCE_BUILD_ID, SOURCE_BUILD_SHA256, HASH, PROVIDERS, LEGACY_PROVIDERS, sha256,
  providerById, recoveryProviderById, knownProviderForHash, readMfgUnlockResources, readMfgUnlockCatalog };
