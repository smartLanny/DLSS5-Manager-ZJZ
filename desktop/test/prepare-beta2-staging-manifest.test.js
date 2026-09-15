'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createManifest } = require('../scripts/prepare-beta2-staging-manifest');

test('beta2 staging manifest reuses only explicitly selected, previously verified component files', () => {
  const resourcesRoot = path.resolve('D:/verified/resources');
  const prior = { stage: { components: { packages: [
    { id:'bridge-safe', kind:'bridge', version:'1.4.12', architecture:'x64', interface:'bridge', files:[
      { path:'components/bridge-safe/component-manifest.json', bytes:3, sha256:'a'.repeat(64) }
    ] },
    { id:'preview-old', kind:'feeder', version:'old', architecture:'x64', interface:'provider', files:[
      { path:'components/preview-old/component-manifest.json', bytes:4, sha256:'b'.repeat(64) }
    ] }
  ] }, resources: { files:[
    { path:'resources/hoyoshade/component.json', bytes:5, sha256:'c'.repeat(64) }
  ] } } };
  const manifest = createManifest({ prior, resourcesRoot, selectedIds:['bridge-safe'], payloadRoot:'D:/core',
    runtime40:'D:/rtx40.dll', runtime50:'D:/rtx50.dll', mfg:'D:/mfg.addon64' });

  assert.equal(manifest.packageVersion, '0.5.0-beta.2');
  assert.deepEqual(manifest.core.versions, ['0.2.0-beta.2','0.4.2','0.4.7beta','0.5-dline21']);
  assert.deepEqual(manifest.components.map(row => row.id), ['bridge-safe']);
  assert.equal(manifest.components[0].files[0].path, 'component-manifest.json');
  assert.equal(manifest.components[0].sourceRoot, path.join(resourcesRoot, 'components', 'bridge-safe'));
  assert.equal(manifest.resources[0].path, 'hoyoshade/component.json');
  assert.equal(manifest.resources[0].source, path.join(resourcesRoot, 'hoyoshade', 'component.json'));
});

test('beta2 staging manifest refuses the superseded pre7 bridge candidate', () => {
  const prior = { stage: { components: { packages: [{
    id:'bridge-1.4.13-pre7-manager-core-compat-20260912', kind:'bridge', version:'1.4.13-pre7', architecture:'x64', interface:'bridge', files:[
      { path:'components/bridge-1.4.13-pre7-manager-core-compat-20260912/component-manifest.json', bytes:3, sha256:'a'.repeat(64) }
    ]
  }] }, resources: { files:[] } } };

  assert.throws(() => createManifest({ prior, resourcesRoot:'D:/verified/resources',
    selectedIds:['bridge-1.4.13-pre7-manager-core-compat-20260912'], payloadRoot:'D:/core',
    runtime40:'D:/rtx40.dll', runtime50:'D:/rtx50.dll', mfg:'D:/mfg.addon64' }), /pre7.*已被官方 pre8 取代/);
});
