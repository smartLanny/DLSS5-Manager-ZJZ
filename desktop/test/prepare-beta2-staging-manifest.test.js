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
    runtime40:'D:/rtx40.dll', runtime50:'D:/rtx50.dll', mfg10:'D:/mfg-1.0.addon64', mfg09:'D:/mfg-0.9.addon64' });

  assert.equal(manifest.packageVersion, '0.5.0-beta.2');
  assert.deepEqual(manifest.core.versions, ['0.2.0-beta.2','0.4.2','0.4.7beta','0.5-dline21']);
  assert.deepEqual(manifest.components.map(row => row.id), ['bridge-safe']);
  assert.equal(manifest.components[0].files[0].path, 'component-manifest.json');
  assert.equal(manifest.components[0].sourceRoot, path.join(resourcesRoot, 'components', 'bridge-safe'));
  assert.equal(manifest.resources[0].path, 'hoyoshade/component.json');
  assert.equal(manifest.resources[0].source, path.join(resourcesRoot, 'hoyoshade', 'component.json'));
  assert.equal(manifest.mfg.defaultProvider, 'mfgunlock-1.0');
  assert.deepEqual(manifest.mfg.providers.map(row => row.id), ['mfgunlock-1.0', 'mfgunlock-0.9']);
});

test('beta2 staging manifest refuses the superseded pre7 bridge candidate', () => {
  const prior = { stage: { components: { packages: [{
    id:'bridge-1.4.13-pre7-manager-core-compat-20260912', kind:'bridge', version:'1.4.13-pre7', architecture:'x64', interface:'bridge', files:[
      { path:'components/bridge-1.4.13-pre7-manager-core-compat-20260912/component-manifest.json', bytes:3, sha256:'a'.repeat(64) }
    ]
  }] }, resources: { files:[] } } };

  assert.throws(() => createManifest({ prior, resourcesRoot:'D:/verified/resources',
    selectedIds:['bridge-1.4.13-pre7-manager-core-compat-20260912'], payloadRoot:'D:/core',
    runtime40:'D:/rtx40.dll', runtime50:'D:/rtx50.dll', mfg10:'D:/mfg-1.0.addon64', mfg09:'D:/mfg-0.9.addon64' }), /pre7.*已被官方 pre8 取代/);
});

test('official Bridge fragment replaces historical Bridge rows but preserves Feeder packages', () => {
  const prior={stage:{components:{packages:[
    {id:'old-bridge',kind:'bridge',version:'old',architecture:'x64',interface:'bridge',files:[{path:'components/old-bridge/component-manifest.json',bytes:1,sha256:'a'.repeat(64)}]},
    {id:'keep-feeder',kind:'feeder',version:'1',architecture:'x64',interface:'NRExternalProviderV1',files:[{path:'components/keep-feeder/component-manifest.json',bytes:1,sha256:'b'.repeat(64)}]}
  ]},resources:{files:[]}}};
  const bridge=id=>({id,kind:'bridge',version:id.endsWith('pre8')?'1.4.13-pre8':'1.4.12',architecture:'x64',interface:'NGX-D3D12-Feature1',
    sourceRoot:path.resolve(`D:/official/${id}`),files:[{path:'component-manifest.json',source:'component-manifest.json',bytes:1,sha256:'c'.repeat(64)}]});
  const officialBridges={schemaVersion:1,components:[bridge('bridge-pre8'),bridge('bridge-stable')]};
  const manifest=createManifest({prior,resourcesRoot:'D:/verified/resources',selectedIds:['old-bridge','keep-feeder'],payloadRoot:'D:/core',
    runtime40:'D:/rtx40.dll',runtime50:'D:/rtx50.dll',mfg10:'D:/mfg10',mfg09:'D:/mfg09',officialBridges});
  assert.deepEqual(manifest.components.map(row=>row.id),['keep-feeder','bridge-pre8','bridge-stable']);
});
