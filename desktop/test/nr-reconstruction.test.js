'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const catalog = require('../src/shared/core-catalog');
const nr = require('../src/product/nr-config');
const { pinnedConfigContract } = require('../src/product/nr-core-identity');

const KEYS = ['ReconstructionMode', 'NearBlackChromaGuard'];
const identityOf = core => ({ version: core.id, ...pinnedConfigContract(core.addon['zh-CN']) });
const current = identityOf(catalog.byId('0.5.1-beta-ui1'));
const unified5 = identityOf(catalog.byId('0.5-dline21-unified5'));

function fixture(t, text, identity = current) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-reconstruction-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nr_before_sr.ini'); fs.writeFileSync(file, text);
  return { file, read: () => nr.readConfig(file, identity), write: patch => nr.writeConfig(file, patch, identity) };
}

test('only the exact 0.5.1 Core bytes expose detail enhancement and dark-noise reduction', () => {
  assert.equal(nr.resolveContract(current).reconstruction, true);
  for (const key of KEYS) assert.ok(nr.resolveContract(current).keys.includes(key));
  // Same colour contract, older Core: the keys stay hidden and edits are refused.
  assert.equal(unified5.configContract, current.configContract);
  assert.equal(nr.resolveContract(unified5).reconstruction, false);
  for (const key of KEYS) {
    assert.ok(!nr.resolveContract(unified5).keys.includes(key));
    assert.throws(() => nr.normalizeValue(key, 1, unified5), { code: 'ERR_BAD_REQUEST' });
  }
  // A display name or contract name alone never grants them.
  assert.equal(nr.resolveContract({ version: '0.5.1-beta-ui1', configContract: current.configContract }).reconstruction, false);
});

test('fresh settings read both options as off without writing the INI', t => {
  const f = fixture(t, '[NRBeforeSR]\n'), value = f.read();
  assert.equal(value.capabilities.ReconstructionMode, true); assert.equal(value.capabilities.NearBlackChromaGuard, true);
  assert.equal(value.effective.ReconstructionMode, 0); assert.equal(value.effective.NearBlackChromaGuard, 0);
  assert.equal(value.fields.ReconstructionMode.source, 'default');
  assert.equal(fs.readFileSync(f.file, 'utf8'), '[NRBeforeSR]\n');
});

test('saved values follow the Core: 1 and 2 are kept, anything else reads as off', t => {
  for (const [saved, effective] of [[1, 1], [2, 2], [3, 0], [-1, 0]]) {
    const f = fixture(t, `[NRBeforeSR]\nReconstructionMode=${saved}\nNearBlackChromaGuard=${saved}\n`), value = f.read();
    assert.equal(value.effective.ReconstructionMode, effective, `ReconstructionMode=${saved}`);
    assert.equal(value.effective.NearBlackChromaGuard, saved !== 0 ? 1 : 0);
    assert.equal(value.saved.ReconstructionMode, saved); // inspection never rewrites the stored value
  }
});

test('edits change only their own keys and keep the rest of a player INI', async t => {
  const f = fixture(t, '[NRBeforeSR]\nIntensity=1.3\nOtherExperiment=keep\n');
  await f.write({ ReconstructionMode: 2 });
  await f.write({ NearBlackChromaGuard: 1 });
  const text = fs.readFileSync(f.file, 'utf8');
  assert.match(text, /^ReconstructionMode=2$/m); assert.match(text, /^NearBlackChromaGuard=1$/m);
  assert.match(text, /^Intensity=1\.3$/m); assert.match(text, /^OtherExperiment=keep$/m);
  await assert.rejects(f.write({ ReconstructionMode: 3 }), { code: 'ERR_BAD_REQUEST' });
  await assert.rejects(f.write({ ReconstructionMode: 1.5 }), { code: 'ERR_BAD_REQUEST' });
  assert.equal(f.read().effective.ReconstructionMode, 2);
});

test('restoring defaults turns both options off only for the Core that reads them', () => {
  assert.equal(nr.defaultPatch(current).ReconstructionMode, 0);
  assert.equal(nr.defaultPatch(current).NearBlackChromaGuard, 0);
  for (const key of KEYS) assert.ok(!Object.hasOwn(nr.defaultPatch(unified5), key));
});
