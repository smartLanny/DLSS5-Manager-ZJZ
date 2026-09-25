'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/product/unified5-core');
const nr = require('../src/product/nr-config');
const { createNrCoreIdentity, pinnedConfigContract, UNIFORM_CORE_HASHES } = require('../src/product/nr-core-identity');
const identity = { version: core.ID, configContract: core.CONTRACT, sourceCommit: core.SOURCE };
test('waiting-source contracts use the same pinned identity as installed settings', () => {
  for (const hash of Object.values(core.HASHES)) {
    const contract = { version: core.ID, ...pinnedConfigContract(hash) };
    assert.equal(nr.resolveContract(contract).colourMemory, true);
    assert.equal(nr.normalizeValue('ColourLabMode', 1, contract), 1);
    assert.equal(nr.normalizeValue('Layer2Enabled', 1, contract), 1);
  }
  assert.equal(pinnedConfigContract(UNIFORM_CORE_HASHES[0]).configContract, 'nr-uniform-v1');
  assert.equal(pinnedConfigContract('0'.repeat(64)), null);
});
function fixture(t, text = '[NRBeforeSR]\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified5-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nr_before_sr.ini'); fs.writeFileSync(file, text);
  return { file, read: () => nr.readConfig(file, identity), write: patch => nr.writeConfig(file, patch, identity) };
}
test('both pinned languages expose the new contract; a display name does not grant it', async t => {
  const { file } = fixture(t);
  for (const hash of Object.values(core.HASHES)) {
    const result = await createNrCoreIdentity({ digest: async () => hash })({ version: 'custom', files: [{ path: file, sha256: hash }] });
    assert.equal(result.configContract, core.CONTRACT); assert.equal(result.sourceCommit, core.SOURCE);
    assert.equal(nr.resolveContract(result).colourMemory, true);
  }
  const hash = 'a'.repeat(64);
  const result = await createNrCoreIdentity({ digest: async () => hash })({ version: core.ID, files: [{ path: file, sha256: hash }] });
  assert.equal(result.configContract, 'unknown');
  assert.equal(nr.resolveContract({ configContract: 'nr-uniform-v1' }).colourMemory, false);
});
test('fresh settings match conservative 1.0 and independent priority 0.7 defaults', t => {
  const f = fixture(t), value = f.read();
  assert.equal(value.effective.ColourLabMode, 2); assert.equal(value.effective.ColorStrength, 1);
  assert.equal(value.effective.ColourPriorityStrength, .7);
  assert.deepEqual(value.saved, {}); // inspection never rewrites first-install preferences
});
test('switch, edit, switch back remembers each bank without overwriting legacy permission', async t => {
  const f = fixture(t, '[NRBeforeSR]\nColourLabMode=2\nColorStrength=1.2\nAllowUnverifiedHdrColor=0\nOtherExperiment=keep\n');
  await f.write({ ColourLabMode: 1 }); assert.ok(Math.abs(f.read().effective.ColorStrength - .7) < 1e-6);
  await f.write({ ColorStrength: .85 });
  await f.write({ ColourLabMode: 2 }); assert.ok(Math.abs(f.read().effective.ColorStrength - 1.2) < 1e-6);
  await f.write({ ColourLabMode: 1 }); assert.ok(Math.abs(f.read().effective.ColorStrength - .85) < 1e-6);
  assert.match(fs.readFileSync(f.file, 'utf8'), /OtherExperiment=keep/);
  assert.equal(f.read().saved.AllowUnverifiedHdrColor, 0);
});
test('an older explicit permission selects legacy policy; explicit banks override the old strength', t => {
  for (const permission of [0, 1]) {
    const f = fixture(t, `[NRBeforeSR]\nAllowUnverifiedHdrColor=${permission}\nColorStrength=.3\n`);
    assert.equal(f.read().effective.ColourLabMode, 0);
    assert.ok(Math.abs(f.read().effective.ColorStrength - .3) < 1e-6);
  }
  const f = fixture(t, '[NRBeforeSR]\nColourLabMode=1\nColorStrength=1\nColourPriorityStrength=.4\n');
  assert.ok(Math.abs(f.read().effective.ColorStrength - .4) < 1e-6);
});
test('reset restores both new defaults, preserving unrelated experiment settings', async t => {
  const f = fixture(t, '[NRBeforeSR]\nColourLabMode=1\nColourPriorityStrength=2\nColourConservativeStrength=0\nFaceProtection=1\n');
  await f.write(nr.defaultPatch(identity)); const value = f.read();
  assert.equal(value.effective.ColourLabMode, 2); assert.equal(value.effective.ColorStrength, 1);
  assert.ok(Math.abs(value.effective.ColourPriorityStrength - .7) < 1e-6);
  assert.match(fs.readFileSync(f.file, 'utf8'), /FaceProtection=1/);
});
test('Unified5 full installation cannot omit a face-backend resource', () => {
  const policy = require('../src/product/payload-companions');
  assert.equal(policy.required(core.ID), true); assert.throws(() => policy.validateMap(undefined, core.ID));
});
