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
    id: 'bridge-1.4.13-pre7-official', kind: 'bridge', version: '1.4.13-pre7', variant: 'official',
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
