'use strict';

const catalog = require('../shared/core-catalog');

// Presentation only: these names neither create payloads nor grant compatibility.
// IDs always remain the identity from the inventory; display labels are not aliases.
// Historical Cores are fixed here; the unified line comes from the Core catalog.
const CORE_CHOICES = Object.freeze([
  { key: 'initial', label: '0.2 初版', ids: ['0.2.0-beta.2', '0.2.0'] },
  { key: 'stable', label: '0.3.3.4 稳定版', ids: ['0.3.3-dev-r4', '0.3.3.4'] },
  { key: '037', label: '0.3.7 · 历史版', ids: ['0.3.7'] },
  { key: '042', label: '0.4.2', ids: ['0.4.2'] },
  { key: '047', label: '0.4.7', ids: ['0.4.7beta', '0.4.7'] },
  { key: 'd13', label: '0.5 D13 · 双层版', ids: ['0.5-dline13'] },
  { key: 'd21', label: '0.5D21 多层叠加版', ids: ['0.5-dline21', '0.5D21', '0.5beta-D21'] },
  ...catalog.CORES.map(core => ({ key: core.menuKey, label: core.menuLabel, ids: [core.id] }))
].map(row => Object.freeze({ ...row, ids: Object.freeze(row.ids) })));
const TEST_KEYS = new Set(['d13', 'd21', ...catalog.CORES.filter(core => core.id !== catalog.RECOMMENDED).map(core => core.menuKey)]);

function choiceFor(id) {
  return CORE_CHOICES.find(choice => choice.ids.includes(id)) || null;
}

function coreMenu(rows, { installedVersion = null, defaultVersion = null, existingUnmanaged = false } = {}) {
  const inventory = Array.isArray(rows) ? rows : [];
  const keep = new Set([installedVersion, defaultVersion].filter(Boolean));
  const selected = new Set(), result = [];
  for (const choice of CORE_CHOICES) {
    const matches = inventory.filter(row => choice.ids.includes(row.id) && row.comparisonOnly !== true);
    // Prefer a retained identity. Never collapse ambiguous variants onto another ID.
    const item = matches.find(row => row.id === installedVersion) || matches.find(row => row.id === defaultVersion) ||
      (matches.length === 1 ? matches[0] : null);
    if (item) {
      // Only 0.4.7 or the catalog's recommended Core may carry the new-install mark.
      const defaultEligible = choice.key === '047' || item.id === catalog.RECOMMENDED;
      const suffix = defaultEligible && !installedVersion && item.id === defaultVersion
        ? existingUnmanaged ? '（可选替换目标）' : '（新安装推荐）'
        : item.id === catalog.RECOMMENDED ? '（推荐）' : TEST_KEYS.has(choice.key) ? '（测试）' : '';
      result.push({ ...item, label: `${choice.label}${suffix}` });
      selected.add(item.id);
    } else {
      result.push({ id: `unavailable-core-${choice.key}`, label: `${choice.label}（${matches.length ? '请在组件管理中确认版本' : '组件未准备'}）`,
        ready: false, source: 'menu-placeholder', verification: 'unavailable', comparisonOnly: false });
      for (const row of matches) keep.add(row.id);
    }
  }
  // Older installed/default identities and explicit imports remain usable. Merely
  // shortening a menu must not delete sources, hide repair identity or break rollback.
  for (const row of inventory) if (!selected.has(row.id) &&
      (keep.has(row.id) || row.source === 'imported' || row.deletable === true || row.comparisonOnly === true)) {
    result.push({ ...row }); selected.add(row.id);
  }
  return result;
}

function fullPackage(entry) {
  return Boolean(entry && entry.coreUpdateOnly !== true && entry.comparisonOnly !== true &&
    (entry.compatibility === 'dx11' || entry.supportsPresent === true &&
      Array.isArray(entry.inputInterfaces) && entry.inputInterfaces.includes('NGX-D3D12-Feature1')));
}

function preferredBundleDefault(bundle) {
  // The catalog's recommended Core becomes the new-install default only when its
  // exact bytes are staged as a complete package; a label or ID alone is not enough.
  const recommended = bundle.versions?.[catalog.RECOMMENDED];
  if (fullPackage(recommended) && catalog.isProviderCore(catalog.RECOMMENDED, recommended.files?.['nr-before-sr.zh-CN.addon64']))
    return catalog.RECOMMENDED;
  const matches = CORE_CHOICES.find(choice => choice.key === '047').ids.filter(id => Object.hasOwn(bundle.versions || {}, id));
  if (matches.length !== 1) return null;
  // Otherwise public installs stay on the complete 0.4.7 package. D21 and older
  // unified builds remain user-selected candidates.
  return fullPackage(bundle.versions[matches[0]]) ? matches[0] : null;
}

module.exports = { CORE_CHOICES, choiceFor, coreMenu, preferredBundleDefault };
