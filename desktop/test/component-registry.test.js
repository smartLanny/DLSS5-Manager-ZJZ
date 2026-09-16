'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const registry = require('../src/product/component-registry');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'component-registry-'));
  const componentRoot = path.join(root, 'component-library');
  const payloadDir = path.join(root, 'payload');
  fs.mkdirSync(componentRoot, { recursive: true });
  fs.mkdirSync(payloadDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const addon = Buffer.from('candidate bridge fixture');
  const notice = Buffer.from('fixture notice');
  const addonSha = hash(addon);
  const addonFile = `objects/${addonSha}/dlss5-bridge.addon64`;
  fs.mkdirSync(path.dirname(path.join(componentRoot, addonFile)), { recursive: true });
  fs.writeFileSync(path.join(componentRoot, addonFile), addon);
  fs.writeFileSync(path.join(componentRoot, 'objects', addonSha, 'THIRD_PARTY_NOTICES.md'), notice);
  const candidate = {
    id: 'bridge-1.4.13-pre8-official', kind: 'bridge', version: '1.4.13-pre8', variant: 'official',
    architecture: 'x64', interface: 'NGX-D3D12-Feature1', gameApis: ['dx11', 'vulkan'],
    validation: 'candidate', source: 'user-imported', files: [
      { file: addonFile, name: 'dlss5-bridge.addon64', sha256: addonSha, bytes: addon.length },
      { file: `objects/${addonSha}/THIRD_PARTY_NOTICES.md`, name: 'THIRD_PARTY_NOTICES.md', sha256: hash(notice), bytes: notice.length }
    ]
  };
  fs.writeFileSync(path.join(componentRoot, 'inventory.json'), JSON.stringify({ schemaVersion: 1, packages: [candidate] }));
  const versionInfo = { id: '0.4.7', inputInterfaces: ['NGX-D3D12-Feature1'] };
  return { componentRoot, payloadDir, candidate, addonSha, versionInfo };
}

function payload(versionInfo, carrier) {
  return { versionInfo, ...(carrier ? { carrier } : {}) };
}

test('no bridgeId preserves a verified payload carrier and never adopts an unowned candidate', t => {
  const f = fixture(t);
  const oldCarrier = { name: 'legacy-carrier.addon64', file: 'payload/legacy-carrier.addon64', actual: 'a'.repeat(64), expected: 'a'.repeat(64) };
  const old = payload(f.versionInfo, oldCarrier);
  const oldResult = registry.selectNativeComponents(f.payloadDir, old, { api: 'dx11', componentRoot: f.componentRoot });
  assert.equal(oldResult, old);
  assert.equal(oldResult.carrier, oldCarrier);
  assert.equal(oldResult.components, undefined);

  const fresh = payload(f.versionInfo);
  const freshResult = registry.selectNativeComponents(f.payloadDir, fresh, { api: 'dx11', componentRoot: f.componentRoot });
  assert.equal(freshResult, fresh);
  assert.equal(freshResult.carrier, undefined);
  assert.equal(freshResult.components, undefined);
});

test('the public 0.4.7 Core resolves to its fixed Bridge 1.4.12 pair', () => {
  const rows = registry.bridgeCatalog('missing-payload-root', {
    coreHash: '93011d9283615ea9dc8e92955f5ca6aeff01435925f63e941dc1eea1128a372c',
    chainHash: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'
  });
  assert.equal(rows[0].id, 'nigos-1.4.12-nr');
  assert.equal(rows[0].compatible, true);
  assert.equal(rows[0].default, true);
});

test('explicit candidate selection remains a dry-run candidate and carries no runtime verification', t => {
  const f = fixture(t);
  const result = registry.selectNativeComponents(f.payloadDir, payload(f.versionInfo), {
    api: 'dx11', bridgeId: f.candidate.id, componentRoot: f.componentRoot
  });
  assert.equal(result.components.bridge, f.candidate.id);
  assert.equal(result.carrier.actual, f.addonSha);
  assert.equal(result.componentMetadata.bridge.contract.state, 'candidate');
  assert.equal(result.componentMetadata.bridge.contract.dryRun, true);
  assert.equal(result.componentMetadata.bridge.contract.installAuthorized, false);
  assert.equal(result.componentMetadata.bridge.runtimeVerified, false);
});

test('an installed imported candidate is selected only through its existing hash ownership', t => {
  const f = fixture(t);
  const result = registry.selectNativeComponents(f.payloadDir, payload(f.versionInfo), {
    api: 'dx11', installedHash: f.addonSha, componentRoot: f.componentRoot
  });
  assert.equal(result.components.bridge, f.candidate.id);
  assert.equal(result.carrier.actual, f.addonSha);
  assert.equal(result.componentMetadata.bridge.runtimeVerified, false);
});

test('BG3 rejects an imported candidate whose pin is not the fixed 1.4.11 bridge', t => {
  const f = fixture(t);
  const rows = registry.importedBridges(f.componentRoot, f.versionInfo, null, 'bg3');
  assert.equal(rows[0].contract.code, 'BRIDGE_GAME_PIN');
  assert.throws(() => registry.selectNativeComponents(f.payloadDir, payload(f.versionInfo), {
    api: 'dx11', bridgeId: f.candidate.id, componentRoot: f.componentRoot, gameId: 'bg3'
  }), { code: 'COMPONENT_BRIDGE_CORE' });
});

test('a new DX11 install automatically selects the newest exact bundled official Bridge', t => {
  const f=fixture(t), data=JSON.parse(fs.readFileSync(path.join(f.componentRoot,'inventory.json'),'utf8'));
  Object.assign(data.packages[0],{source:'bundled',sourceType:'official-release',verifiedSource:true,immutable:true,defaultEligible:true});
  fs.writeFileSync(path.join(f.componentRoot,'inventory.json'),JSON.stringify(data));
  const trusted=new Map([[f.candidate.id,{id:f.candidate.id,kind:'bridge',version:f.candidate.version,architecture:'x64',
    gameApis:['dx11','vulkan'],sourceType:'official-release',immutable:true,sha256:f.addonSha}]]);
  const result=registry.selectNativeComponents(f.payloadDir,payload(f.versionInfo),{
    api:'dx11',componentRoot:f.componentRoot,trustedComponents:trusted
  });
  assert.equal(result.components.bridge,f.candidate.id);
  assert.equal(result.carrier.actual,f.addonSha);
  assert.equal(result.componentMetadata.bridge.verifiedSource,true);
});

test('imported official Bridge exposes a Vulkan candidate through the same interface contract', t => {
  const f = fixture(t);
  const rows = registry.importedBridges(f.componentRoot, f.versionInfo, null, 'manual-component', 'vulkan');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].api, 'vulkan');
  assert.deepEqual(rows[0].gameApis, ['dx11', 'vulkan']);
  assert.equal(rows[0].contract.state, 'candidate');
});
