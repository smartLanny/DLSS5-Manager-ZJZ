'use strict';

// Presentation only: these names neither create payloads nor grant compatibility.
// IDs always remain the identity from the inventory; display labels are not aliases.
const CORE_CHOICES = Object.freeze([
  { key: 'initial', label: '0.2 初版', ids: ['0.2.0-beta.2', '0.2.0'] },
  { key: 'stable', label: '0.3.3.4 稳定版', ids: ['0.3.3-dev-r4', '0.3.3.4'] },
  { key: '042', label: '0.4.2', ids: ['0.4.2'] },
  { key: '047', label: '0.4.7', ids: ['0.4.7beta', '0.4.7'] },
  { key: 'd21', label: '0.5D21 多层叠加版', ids: ['0.5-dline21', '0.5D21', '0.5beta-D21'] }
].map(row => Object.freeze({ ...row, ids: Object.freeze(row.ids) })));

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
      const suffix = choice.key === '047' && !installedVersion && item.id === defaultVersion
        ? existingUnmanaged ? '（可选替换目标）' : '（新安装推荐）' : choice.key === 'd21' ? '（测试）' : '';
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

function preferredBundleDefault(bundle) {
  const matches = CORE_CHOICES.find(choice => choice.key === '047').ids.filter(id => Object.hasOwn(bundle.versions || {}, id));
  if (matches.length !== 1) return null;
  const id = matches[0], entry = bundle.versions[id];
  // Public installs stay on the complete 0.4.7 package. D21 is deliberately a
  // user-selected candidate until its game/hardware acceptance gates are met.
  const fullPackage = entry && entry.coreUpdateOnly !== true && entry.comparisonOnly !== true &&
    (entry.compatibility === 'dx11' || entry.supportsPresent === true &&
      Array.isArray(entry.inputInterfaces) && entry.inputInterfaces.includes('NGX-D3D12-Feature1'));
  return fullPackage ? id : null;
}

module.exports = { CORE_CHOICES, choiceFor, coreMenu, preferredBundleDefault };
