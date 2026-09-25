'use strict';

// The standard 0.4.7 artifact exports NRExternalProvider_{Query,ClaimOwnership,
// SubmitFrame,ReleaseOwnership}V1. Early Manager catalogs omitted the interface
// while retaining the capability. Reconcile only this exact artifact and chain;
// normal payload/Provider byte verification still runs before any deployment.
const STANDARD_047 = Object.freeze({
  id: '0.4.7beta',
  core: '93011d9283615ea9dc8e92955f5ca6aeff01435925f63e941dc1eea1128a372c',
  chain: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'
});

function reconcileBundle(bundle) {
  if (bundle?.version !== 4) return bundle;
  const entry = bundle.versions?.[STANDARD_047.id];
  if (entry?.files?.['nr-before-sr.zh-CN.addon64'] !== STANDARD_047.core ||
      entry.files['nrchain_nvngx.dll'] !== STANDARD_047.chain) return bundle;
  entry.inputInterfaces = [...new Set([...(Array.isArray(entry.inputInterfaces) ? entry.inputInterfaces : []), 'NRExternalProviderV1'])];
  entry.capabilities = [...new Set([...(Array.isArray(entry.capabilities) ? entry.capabilities : []), 'external-provider-v1'])];
  return bundle;
}

module.exports = { STANDARD_047, reconcileBundle };
