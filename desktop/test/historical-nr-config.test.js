'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nr = require('../src/product/nr-config');
const D13 = '0.5-dline13';
function fixture(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-nr-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'nr_before_sr.ini'); fs.writeFileSync(file, text); return file;
}
test('0.3.7 uses its own original defaults and supported keys/ranges', t => {
  const file = fixture(t, '[NRBeforeSR]\n'), value = nr.readConfig(file, '0.3.7');
  assert.equal(value.contract.id, 'nr-037'); assert.equal(value.defaults.ColorStrength, .5);
  assert.equal(value.defaults.TransferStrength, 1.2); assert.equal(value.defaults.Intensity, 1);
  assert.equal(value.capabilities.WorkMode, false); assert.equal(value.capabilities.Layer2Enabled, false);
  assert.equal(nr.configLimits('0.3.7').TransferStrength.max, 2); assert.equal(nr.configLimits('0.3.7').ColorStrength.max, 1);
  assert.throws(() => nr.updateSection('[NRBeforeSR]\n', { ColorStrength: 1.5 }, '0.3.7'), { code: 'ERR_BAD_REQUEST' });
});
test('D13 reads its two shared-model passes and exact rational without changing saved bytes', t => {
  const original = '[NRBeforeSR]\nNRPasses=2\nNRSecondScaleNumerator=2\nNRSecondScaleDenominator=3\nIntensity=1.27\n';
  const file = fixture(t, original), value = nr.readConfig(file, D13);
  assert.equal(value.contract.id, 'nr-dline13'); assert.equal(value.contract.uniform, false);
  assert.equal(value.layerCount, 2); assert.equal(value.layers.length, 2); assert.equal(value.layers[1].sharedModel, true);
  assert.equal(value.effective.NRSecondScaleNumerator, 2); assert.equal(value.effective.NRSecondScaleDenominator, 3);
  assert.equal(value.capabilities.Layer2Enabled, false); assert.equal(value.capabilities.Layer3Intensity, false);
  assert.equal(value.layers[0].values.Intensity, value.layers[1].values.Intensity); assert.equal(fs.readFileSync(file, 'utf8'), original);
});
test('D13 invalid persisted ratio/pass count resolves like its source but raw values stay visible', t => {
  const file = fixture(t, '[NRBeforeSR]\nNRPasses=7\nNRSecondScaleNumerator=1\nNRSecondScaleDenominator=0\n');
  const value = nr.readConfig(file, D13);
  assert.equal(value.saved.NRPasses, 7); assert.equal(value.effective.NRPasses, 1);
  assert.equal(value.saved.NRSecondScaleDenominator, 0); assert.equal(value.effective.NRSecondScaleDenominator, 2);
});
test('D13 writes only its own second-pass settings and rejects invalid/newer layer controls', async t => {
  const file = fixture(t, '[NRBeforeSR]\nNRPasses=1\nNRSecondScaleNumerator=1\nNRSecondScaleDenominator=2\nPrivateSetting=keep\n');
  const patch = nr.layerCountPatch(2, nr.readConfig(file, D13), D13);
  assert.deepEqual(patch, { NRPasses: 2 });
  const result = await nr.writeConfig(file, { ...patch, NRSecondScaleNumerator: 2, NRSecondScaleDenominator: 3 }, D13);
  assert.equal(result.layerCount, 2); assert.equal(result.saved.NRSecondScaleNumerator, 2); assert.equal(result.saved.NRSecondScaleDenominator, 3);
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of [{ NRSecondScaleNumerator: 1, NRSecondScaleDenominator: 5 }, { Layer3Enabled: 1 }, { UniformChainVersion: 1 }])
    await assert.rejects(nr.writeConfig(file, invalid, D13), { code: 'ERR_BAD_REQUEST' });
  assert.equal(fs.readFileSync(file, 'utf8'), before); assert.match(before, /PrivateSetting=keep/); assert.doesNotMatch(before, /Layer[2-5]|UniformChain/);
  assert.throws(() => nr.layerCountPatch(3, result, D13), { code: 'ERR_BAD_REQUEST' });
});
