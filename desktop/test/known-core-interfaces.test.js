'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { STANDARD_047, reconcileBundle } = require('../src/product/known-core-interfaces');
const { readBundle, inspectPayload } = require('../src/product/payload');

function oldBundle() {
  const files = { 'nr-before-sr.zh-CN.addon64': STANDARD_047.core, 'nrchain_nvngx.dll': STANDARD_047.chain,
    'nr_before_sr.ini': '1'.repeat(64) };
  return { version: 4, defaultVersion: STANDARD_047.id,
    fixed: Object.fromEntries(['RTX40', 'RTX50'].map(family => [family, { files: {
      'ReShade64.dll': '2'.repeat(64), 'nrchain_nvngx.dll': STANDARD_047.chain, 'nvngx_dlssnr.dll': '3'.repeat(64) } }])),
    versions: { [STANDARD_047.id]: { files, supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1'], capabilities: ['same-frame-output', 'external-provider-v1'] } } };
}

test('old standard Core metadata is corrected without changing any payload byte or accepting a different Core', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'known-core-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'bundle.json'), before = JSON.stringify(oldBundle()); fs.writeFileSync(file, before);
  const loaded = readBundle(root);
  assert.deepEqual(loaded.versions[STANDARD_047.id].inputInterfaces, ['NGX-D3D12-Feature1', 'NRExternalProviderV1']);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'old component overlays remain read-only');
  const inspect = inspectPayload(root, { hardwareFamily: 'RTX50' });
  assert.equal(inspect.ready, false, 'a metadata repair never substitutes for verification of missing payload bytes');
  const once = JSON.stringify(loaded); assert.equal(JSON.stringify(reconcileBundle(loaded)), once);
  for (const key of ['nr-before-sr.zh-CN.addon64', 'nrchain_nvngx.dll']) {
    const other = oldBundle(); other.versions[STANDARD_047.id].files[key] = 'a'.repeat(64);
    assert.deepEqual(reconcileBundle(other).versions[STANDARD_047.id].inputInterfaces, ['NGX-D3D12-Feature1']);
  }
  const renamed = oldBundle(); renamed.versions.other = renamed.versions[STANDARD_047.id]; delete renamed.versions[STANDARD_047.id];
  assert.deepEqual(reconcileBundle(renamed).versions.other.inputInterfaces, ['NGX-D3D12-Feature1']);
});
