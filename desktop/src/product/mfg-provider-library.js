'use strict';
const fs = require('node:fs');
const path = require('node:path');
const bundled = require('./fg-mfgunlock-resources');
const { readCachedComponents, relativeName } = require('./component-library');
const { sha256 } = require('./streaming-digest-sync');

// The inventory retains every imported identity so an older receipt can still
// restore its own bytes after a different provider is selected.
function createMfgProviderLibrary(options = {}) {
  const root = options.componentLibraryRoot || options.userData && path.join(options.userData, 'component-library');
  function providers() {
    const rows = root ? readCachedComponents(root) : [];
    const external = rows.filter(row => row.kind === 'mfg' && row.interface === 'Streamline-DLSSG' && row.architecture === 'x64')
      .flatMap(row => {
        const addons = (row.files || []).filter(file => /\.addon64$/i.test(file.name || ''));
        if (!/^[a-z0-9][a-z0-9._+-]{0,127}$/i.test(row.id || '') || typeof row.version !== 'string' || addons.length !== 1) return [];
        const addon = addons[0];
        if (!bundled.HASH.test(addon.sha256 || '') || !Number.isSafeInteger(addon.bytes) || addon.bytes < 1 || addon.bytes > 64 * 1024 * 1024 ||
            addon.file !== `objects/${addon.sha256}/${path.basename(addon.name)}`) return [];
        return [{ id: row.id, version: row.version, label: `MFG Unlock ${row.version} · ${row.variant || '外部'}`, sha256: addon.sha256,
          origin: row.source, addonOnly: true, external: true, validation: row.validation, file: addon, hardwareFamilies: row.hardwareFamilies || [] }];
      });
    return [...bundled.PROVIDERS, ...external.filter(row => !bundled.PROVIDERS.some(pin => pin.id === row.id))];
  }
  const providerById = id => providers().find(row => row.id === id) || null;
  const recoveryProviderById = id => providerById(id) || bundled.recoveryProviderById(id);
  const knownProviderForHash = hash => providers().find(row => row.sha256 === hash) || bundled.knownProviderForHash(hash);
  function readMfgUnlockResources(resourceRoot, id = bundled.ID) {
    const row = providerById(id);
    if (!row?.external) return bundled.readMfgUnlockResources(resourceRoot, id);
    const fail = message => { throw Object.assign(new Error(message), { code: 'SETTINGS_FG_RESOURCES' }); };
    if (row.validation === 'blocked' || !row.hardwareFamilies.includes('RTX40')) fail('这个 MFG 组件未声明 RTX40 配套或已被阻止。');
    const file = path.join(root, relativeName(row.file.file));
    for (let current = file;;) {
      if (fs.lstatSync(current).isSymbolicLink()) fail('MFG 组件缓存路径不能含链接。');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.file.bytes || require('../core/pe').getBitness(file) !== 64 || sha256(file) !== row.sha256)
      fail('MFG 组件缓存与导入身份不一致，请重新导入。');
    return { version: 3, id: row.id, backend: bundled.BACKEND, releaseVersion: row.version, source: { origin: row.origin },
      sources: [], files: { addon: { file: bundled.ADDON, source: file, sha256: row.sha256 } } };
  }
  function readMfgUnlockCatalog(resourceRoot) {
    return providers().map(row => {
      try { readMfgUnlockResources(resourceRoot, row.id); return { ...row, available: true, ready: true, runtimeVerified: false }; }
      catch (error) { return { ...row, available: false, ready: false, blocker: error.message }; }
    });
  }
  return { providers, providerById, recoveryProviderById, knownProviderForHash, readMfgUnlockResources, readMfgUnlockCatalog };
}
module.exports = { createMfgProviderLibrary };
