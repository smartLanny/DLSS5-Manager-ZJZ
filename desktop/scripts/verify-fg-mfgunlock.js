'use strict';
const path = require('path');
const { PROVIDERS, readMfgUnlockResources } = require('../src/product/fg-mfgunlock-resources');
for (const provider of PROVIDERS) {
  const manifest = readMfgUnlockResources(path.resolve(__dirname, '../resources/fg-mfgunlock'), provider.id);
  console.log(`MFG Unlock resources verified: ${manifest.id}; SHA-256 ${manifest.files.addon.sha256}.`);
}
console.log('Resource verification is read-only; no Add-on was loaded by this command.');
