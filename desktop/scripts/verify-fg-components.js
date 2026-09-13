'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '../resources/fg-components');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || manifest.protocol !== 11 || Object.keys(manifest.files || {}).sort().join(',') !== 'asi,core,overlay,ual,ualConfig') throw new Error('Incomplete FG resource manifest');
for (const [role, entry] of Object.entries(manifest.files)) {
  if (path.basename(entry.file) !== entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid FG resource entry');
  const file = path.join(root, entry.file);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== entry.sha256) throw new Error(`FG component hash mismatch: ${role}`);
}
for (const name of ['LICENSE', 'MINHOOK-LICENSE.txt', 'UAL-LICENSE']) {
  if (!fs.statSync(path.join(root, name)).size) throw new Error(`Missing FG license: ${name}`);
}
if (require('../src/product/conflicts').classifyAddon('RTX40MFG-UI.addon64', path.join(root, manifest.files.overlay.file)) !== null) throw new Error('Verified FG menu would be quarantined by NR installation');
console.log(`FG compatibility components verified: ${manifest.id}`);
