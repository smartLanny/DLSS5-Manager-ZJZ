'use strict';
// Keep the v1/UAL implementation for old receipt recovery. New selection never
// falls back to installing it when MFG Unlock resources are unavailable.
const legacy = require('./fg-legacy-components');
const { createMfgUnlockComponents } = require('./fg-mfgunlock-components');
const { createSm86Components, BACKEND, ID } = require('./fg-sm86-components');
const { detectGpuAsync, fgBackend } = require('./gpu');
const fs = require('node:fs');
const path = require('node:path');
function createFgComponents(options = {}) {
  const mfg = createMfgUnlockComponents(options), sm86 = createSm86Components(options);
  const hardware = options.detectHardware || detectGpuAsync;
  function oldOwnership(id) {
    const layout = options.getLayout?.(id), roots = [options.gameDirectory(id), layout?.runtimeDir, layout?.addonDirectory].filter(Boolean);
    return roots.some(root => {
      if (['xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json'].some(name => fs.existsSync(path.join(root, '_DLSS5_Backup', name)))) return true;
      try {
        const file = path.join(root, '_DLSS5_Backup', 'pending-switch.json');
        if (fs.statSync(file).size > 2 * 1024 * 1024) return false;
        const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
        return pending.owner?.product === 'xiaofeng-fg-components' || !pending.owner && pending.files?.some(row =>
          /(?:^|[\\/])(?:renodx-mfgunlock\.addon64|xiaofeng-fg-components\.json|xiaofeng-fg-migration\.json)$/i.test(row.rel || ''));
      } catch { return false; }
    });
  }
  async function owner(id) {
    // Recovery follows existing ownership even after a GPU or layout change.
    if (sm86.hasOwnership(id)) return sm86;
    if (fgBackend(await hardware()) !== BACKEND) return mfg;
    if (oldOwnership(id)) return mfg;
    return sm86;
  }
  const routed = Object.fromEntries(['inspect', 'prepare', 'restore', 'rollbackPrepare', 'commitPrepare', 'inspectPending',
    'recoverPending', 'inspectMigration', 'ownedModuleManifest'].map(name => [name, async (id, ...args) => (await owner(id))[name](id, ...args)]));
  return Object.freeze({ ...mfg, ...routed,
    previewProvider: async (id, providerId) => providerId === ID ? sm86.previewProvider(id, providerId) : providerId ? mfg.previewProvider(id, providerId) : (await owner(id)).previewProvider(id),
    receiptFile: id => sm86.hasOwnership(id) ? sm86.receiptFile(id) : mfg.receiptFile(id),
    catalog: backend => backend === BACKEND ? sm86.catalog() : mfg.catalog()
  });
}
module.exports = {
  createFgComponents,
  mergeUalConfig: legacy.mergeUalConfig,
  validControl: legacy.validControl,
  DEFAULT_CONTROL: legacy.DEFAULT_CONTROL
};
