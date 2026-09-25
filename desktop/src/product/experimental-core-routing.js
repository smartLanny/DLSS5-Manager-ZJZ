'use strict';
const unified5 = require('./unified5-core');
// Implemented by the pinned external consumer; not a claim of in-game acceptance.
const CAPABILITIES = Object.freeze(['same-frame-output', 'source-frame-claims',
  'external-exact-fence-completion', 'present-color-depth-motion', 'multi-pass-nr']);
function isUnified5(id, hash) { return id === unified5.ID && Object.values(unified5.HASHES).includes(hash); }
function selectProvider(packages, selection, trustedIds) {
  const matches = packages.filter(row => trustedIds.has(row.id) && row.selectable === true)
    .flatMap(provider => (provider.routeDescriptors || []).filter(route => route.api === selection.api &&
      route.architecture === selection.architecture && route.hardwareFamilies.includes(selection.hardwareFamily) &&
      (!selection.loadingBackend || route.loadingBackend === selection.loadingBackend) &&
      (!route.proxyEntries.length || route.proxyEntries.includes(selection.proxyEntry || 'auto')))
      .map(route => ({ provider, route })));
  matches.sort((a, b) => Number(a.route.hostRequired) - Number(b.route.hostRequired) ||
    Number(/legacy/.test(a.provider.id)) - Number(/legacy/.test(b.provider.id)) ||
    b.provider.version.localeCompare(a.provider.version, undefined, { numeric: true }));
  return matches[0] || null;
}
module.exports = { CAPABILITIES, isUnified5, selectProvider };
