'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nr = require('../src/product/nr-config');
const { UNIFORM_SOURCE, PUBLIC_NR_KEYS } = require('../src/product/nr-config-contract');
const UNIFORM = { version: 'imported-0123456789ab', sourceCommit: UNIFORM_SOURCE };

test('enum edits remove an invalid inline suffix instead of writing a value Core cannot select', t => {
  const updated = nr.updateSection('[NRBeforeSR]\nProcessingStart=Before ; stale note\n', { ProcessingStart: 'Present' }, UNIFORM);
  assert.equal(nr.parseSection(updated).ProcessingStart, 'Present');
});

test('lighting preset edits publish concrete values; custom edits keep color independent', async t => {
  const f = fixture(t, '[NRBeforeSR]\nUniformChainVersion=1\nColorStrength=0.625\n');
  const natural = await nr.writeConfig(f.file, { LightPreset: 1 }, UNIFORM);
  assert.equal(natural.LightDark, .85); assert.equal(natural.LightReflection, 1.1);
  assert.equal(natural.effective.LightPreset, 1); assert.equal(natural.ColorStrength, .625);
  const custom = await nr.writeConfig(f.file, { LightGlow: .4111 }, UNIFORM);
  assert.equal(custom.LightPreset, 3); assert.equal(custom.LightDark, .85); assert.equal(custom.ColorStrength, .625);
});

test('an explicit previous fingerprint rejects an already changed file and preserves external bytes', async t => {
  const f = fixture(t), previous = f.read().fingerprint;
  fs.writeFileSync(f.file, '[NRBeforeSR]\nIntensity=1.777\n'); const external = f.text();
  await assert.rejects(nr.writeConfig(f.file, { Intensity: 1.2 }, UNIFORM, { expectedFingerprint: previous }), { code: 'ERR_NR_CONFIG_CHANGED' });
  assert.equal(f.text(), external);
});

function fixture(t, text = '[NRBeforeSR]\nUniformChainVersion=1\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-nr-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'nr_before_sr.ini');
  if (text !== null) fs.writeFileSync(file, text);
  return { root, file, read: (version = UNIFORM) => nr.readConfig(file, version), text: () => fs.readFileSync(file, 'utf8') };
}

test('inspection retains saved precision and range separately from Core resolution', t => {
  const original = '[NRBeforeSR]\nUniformChainVersion=1\nIntensity=1.23456789\nLocalToneStrength=2.75\nAutoMask=1\nSkinStructureStrength=-1\n';
  const f = fixture(t, original), value = f.read();
  assert.equal(value.status, 'ready'); assert.equal(value.Intensity, 1.23456789);
  assert.equal(value.LocalToneStrength, 2.75); assert.equal(value.effective.LocalToneStrength, 2);
  assert.equal(value.SkinStructureStrength, -1); assert.equal(value.effective.SkinStructureStrength, 0);
  assert.equal(value.fields.LocalToneStrength.adjusted, true);
  assert.equal(value.fields.Intensity.source, 'saved'); assert.equal(value.fields.ColorStrength.source, 'default');
  assert.equal(value.defaults.Intensity, 1.5); assert.equal(value.defaults.SkinStructureStrength, .4);
  assert.equal(value.defaults.AutoMask, 1); assert.equal(value.defaults.UICorrection, 1);
  assert.equal(value.runtimeVerified, false); assert.equal(f.text(), original);
});

test('first section/key, case-insensitive keys, quotes and numeric suffixes retain their raw representation', t => {
  const original = '[nrbefOREsr]\r\n intensity = "1.2345"\r\nIntensity=1.8\r\nStyle=0x2\r\nColorStrength=0.6 ; keep note\r\n[NRBeforeSR]\r\nIntensity=1.9\r\nLocalToneStrength=1.8\r\n';
  const f = fixture(t, original), value = f.read();
  assert.equal(value.Intensity, 1.2345); assert.equal(value.Style, 2); assert.equal(value.ColorStrength, .6);
  assert.equal(value.raw.Intensity, '"1.2345"'); assert.equal(value.raw.ColorStrength, '0.6 ; keep note');
  assert.equal(value.fields.LocalToneStrength.present, false); assert.equal(value.warnings.length, 2);
  const edited = nr.updateSection(original, { Intensity: 1.27, ColorStrength: .4 }, UNIFORM);
  assert.match(edited, / intensity = 1.27\r\nIntensity=1.8/);
  assert.match(edited, /ColorStrength=0.4 ; keep note/);
  assert.ok(edited.endsWith('[NRBeforeSR]\r\nIntensity=1.9\r\nLocalToneStrength=1.8\r\n'));
  assert.equal(nr.parseSection(edited).Intensity, 1.27);
});

test('an invalid or missing value is distinguished from an explicit default', t => {
  const f = fixture(t, '[NRBeforeSR]\nUniformChainVersion=1\nIntensity=garbage\nAutoMask=0\nStyle=-1\n');
  const value = f.read();
  assert.equal(value.Intensity, 'garbage'); assert.equal(value.fields.Intensity.status, 'invalid');
  assert.equal(value.effective.Intensity, 1.5); assert.equal(value.effective.Style, 2);
  assert.equal(value.AutoMask, 0); assert.equal(value.fields.AutoMask.source, 'saved');
  assert.equal(value.fields.UICorrection.source, 'default'); assert.equal(value.UICorrection, 1);
  assert.equal(value.layers[0].modelSkinStructureStrength, -1);
});

test('missing, unreadable and malformed files never masquerade as saved defaults', t => {
  const missing = fixture(t, null).read();
  assert.equal(missing.status, 'missing'); assert.equal(missing.readable, false); assert.equal(missing.Intensity, undefined);
  assert.deepEqual(missing.saved, {}); assert.deepEqual(missing.capabilities, {}); assert.equal(missing.defaults.Intensity, 1.5);
  const f = fixture(t); const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    if (file === f.file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  });
  const denied = f.read(); assert.equal(denied.status, 'error'); assert.equal(denied.error.code, 'EACCES'); assert.equal(denied.Intensity, undefined);
  t.mock.restoreAll();
  fs.writeFileSync(f.file, Buffer.from([0xff, 0xfe, 0x5b]));
  assert.equal(f.read().status, 'error');
});

for (const encoding of ['utf8', 'utf8-bom', 'utf16le', 'ansi']) test(`${encoding} editing preserves encoding, comments, unrelated keys and trailing bytes`, async t => {
  const plain = '[NRBeforeSR]\r\nUniformChainVersion=1\r\nIntensity=1.23456789\r\nMysteryExperiment=keep\r\n[Other]\r\nValue=unchanged';
  let bytes = Buffer.from(plain);
  if (encoding === 'utf8-bom') bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
  if (encoding === 'utf16le') bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('; 中文注释\r\n' + plain, 'utf16le')]);
  if (encoding === 'ansi') bytes = Buffer.concat([Buffer.from([0x3b, 0xff, 0xa1, 0x0d, 0x0a]), bytes]);
  const f = fixture(t, bytes), before = f.read();
  assert.equal(before.Intensity, 1.23456789);
  if (encoding === 'utf8-bom') { assert.equal(before.effective.Intensity, null); assert.equal(before.fields.Intensity.effectiveKnown, false); assert.equal(before.warnings[0].code, 'UTF8_BOM_PROFILE_UNVERIFIED'); }
  const value = await nr.writeConfig(f.file, { Intensity: 1.87654321 }, UNIFORM);
  const expected = encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('; 中文注释\r\n' + plain.replace('1.23456789', '1.87654321'), 'utf16le')]) :
    Buffer.from(bytes.toString('latin1').replace('1.23456789', '1.87654321'), 'latin1');
  assert.deepEqual(fs.readFileSync(f.file), expected); assert.equal(value.Intensity, 1.87654321); assert.equal(value.readbackVerified, true);
});

test('unknown Core identities show saved values without inventing an effective/default contract', t => {
  const f = fixture(t, '[NRBeforeSR]\nIntensity=2.75\nTransferStrength=.25\n');
  const value = f.read('imported-aabbccddeeff');
  assert.equal(value.Intensity, 2.75); assert.equal(value.effective.Intensity, null);
  assert.equal(value.fields.Intensity.effectiveKnown, false); assert.deepEqual(value.defaults, {});
  assert.equal(value.capabilities.Layer2Enabled, false);
});

test('identity descriptors and version aliases select a contract without treating every D21 as uniform', () => {
  for (const version of ['0.5-dline21', '0.5D21', '0.5beta-D21', 'beta0.5-dline13']) {
    assert.equal(nr.resolveContract(version).dline, true); assert.equal(nr.resolveContract(version).uniform, false);
    assert.equal(nr.configLimits(version).CustomWorkScale.min, .5);
  }
  for (const identity of [UNIFORM, { version: '0.5-dline21', configContract: 'nr-uniform-v1' }, 'beta0.5-dline21-uniform3', nr.resolveContract(UNIFORM)])
    assert.equal(nr.resolveContract(identity).uniform, true);
  assert.equal(nr.defaultPatch('0.4.7beta').Intensity, nr.defaultPatch('0.4.7').Intensity);
});

test('historical versions keep saved values and preserve absent capabilities', t => {
  const f = fixture(t, '[NRBeforeSR]\nMode=2\nIntensity=2.75\nTransferStrength=0.2\nColorStrength=0\n');
  for (const version of ['0.2.0', '0.3.3.4', '0.4.7beta']) {
    const value = f.read(version); assert.equal(value.Intensity, 2.75); assert.equal(value.TransferStrength, .2);
    assert.equal(value.capabilities.WorkMode, false); assert.equal(value.capabilities.Layer2Enabled, false);
  }
  assert.equal(nr.defaultPatch('0.4.6-hotfix.1').Intensity, 1);
  assert.equal(nr.defaultPatch('0.4.7beta').Intensity, 1.2);
});

test('malformed work requests expose dependency on the previous runtime value instead of silently raising to 50%', t => {
  const f = fixture(t, '[NRBeforeSR]\nUniformChainVersion=1\nWorkMode=5\nCustomWorkScale=.25\nPostWorkPercent=42\n');
  const value = f.read(); assert.equal(value.CustomWorkScale, .25); assert.equal(value.PostWorkPercent, 42);
  assert.equal(value.effective.CustomWorkScale, null); assert.equal(value.effective.PostWorkPercent, null);
  assert.equal(value.fields.CustomWorkScale.reason, 'previous-valid-work-request-required');
  fs.writeFileSync(f.file, '[NRBeforeSR]\nUniformChainVersion=1\nWorkMode=5\nCustomWorkScale=0\n');
  const disabled = f.read(); assert.equal(disabled.effective.Enabled, 0); assert.equal(disabled.effective.CustomWorkScale, null);
});

test('processing-order strings and shared final strength round-trip their compatibility fields together', async t => {
  const f = fixture(t, '[NRBeforeSR]\nUniformChainVersion=1\nMode=1\nTransferStrength=1\nPostTransferStrength=.4\n');
  assert.equal(f.read().effective.TransferStrength, 1, 'one-time policy raises legacy fractional transfer');
  const value = await nr.writeConfig(f.file, { ProcessingStart: 'after', TransferStrength: 2.375 }, UNIFORM);
  assert.equal(value.ProcessingStart, 'After'); assert.equal(value.Mode, 1); assert.equal(value.ConfigVersion, 4);
  assert.equal(value.TransferStrength, 2.375); assert.equal(value.PostTransferStrength, 2.375);
  assert.equal(value.StrengthConfigVersion, 1); assert.equal(value.ExtraStrengthPolicyVersion, 1);
  await assert.rejects(nr.writeConfig(f.file, { TransferStrength: 2, PostTransferStrength: 3 }, UNIFORM), { code: 'ERR_BAD_REQUEST' });
});

test('every uniform layer retains independent values through reduce/re-enable and targeted reset', async t => {
  const f = fixture(t), request = nr.layerCountPatch(5, f.read(), UNIFORM);
  for (let layer = 1; layer <= 5; layer++) {
    const prefix = layer === 1 ? '' : `Layer${layer}`;
    Object.assign(request, { [prefix + 'Intensity']: 1 + layer / 100, [prefix + 'LocalToneStrength']: layer / 10,
      [prefix + 'LocalStructureStrength']: 2 - layer / 10, [prefix + 'SkinStructureStrength']: layer / 10,
      [prefix + 'AutoMask']: layer % 2, [prefix + 'Style']: layer % 3, [prefix + 'UICorrection']: (layer + 1) % 2 });
  }
  const five = await nr.writeConfig(f.file, request, UNIFORM); assert.equal(five.layerCount, 5);
  await nr.writeConfig(f.file, nr.layerCountPatch(2, five, UNIFORM), UNIFORM);
  assert.equal(f.read().Layer5Intensity, 1.05); assert.equal(f.read().layerCount, 2);
  const restored = await nr.writeConfig(f.file, nr.layerCountPatch(5, f.read(), UNIFORM), UNIFORM);
  assert.equal(restored.layerCount, 5); assert.equal(restored.Layer5Intensity, 1.05);
  const before = { ...restored.saved }, reset = await nr.writeConfig(f.file, nr.resetLayerPatch(3, UNIFORM), UNIFORM);
  assert.equal(reset.layerCount, 5); assert.equal(reset.Layer3Intensity, 1.5); assert.equal(reset.Layer3SkinStructureStrength, .4);
  for (const [key, value] of Object.entries(before)) if (!key.startsWith('Layer3')) assert.equal(reset.saved[key], value, key);
});

test('first enable uses saved auxiliary values, and a missing schema migration preserves currently effective old layers', async t => {
  const f = fixture(t, '[NRBeforeSR]\nUniformChainVersion=1\nLayer2Enabled=0\nLayer2Configured=0\nLayer2Intensity=1.83\n');
  const first = await nr.writeConfig(f.file, nr.layerCountPatch(2, f.read(), UNIFORM), UNIFORM);
  assert.equal(first.Layer2Intensity, 1.83); assert.equal(first.Layer2Configured, 1);
  fs.writeFileSync(f.file, '[NRBeforeSR]\nNRLayerControlsVersion=2\nNRPasses=2\nNRFullReference=1\nNRFullPasses=3\nNRSecondScaleNumerator=1\nNRSecondScaleDenominator=2\nIntensity=1.27\n');
  const old = f.read(); assert.equal(old.layerCount, 3); assert.equal(old.layers[2].values.Intensity, Math.fround(1.27));
  const changed = await nr.writeConfig(f.file, { Layer3Style: 2 }, UNIFORM);
  assert.equal(changed.layerCount, 3); assert.equal(changed.Layer2Intensity, Math.fround(1.27)); assert.equal(changed.Layer3Style, 2);
  assert.equal(changed.UniformChainVersion, 1); assert.equal(changed.UniformChainMigrated, 1);
  assert.match(f.text(), /NRSecondScaleNumerator=1\nNRSecondScaleDenominator=2/);
});

test('public keys reject unknown/invalid edits without discarding unrelated experiments', async t => {
  const f = fixture(t, '[NRBeforeSR]\nUniformChainVersion=1\nIntensity=1.2\nPrivateExperiment=1\nLightBroad=.65\n');
  const before = f.text();
  for (const patch of [{ Unknown: 1 }, { Intensity: NaN }, { AutoMask: 'false' }, { WorkMode: .5 }, { CustomWorkScale: .25 }, { ProcessingStart: 'invalid' }, { constructor: 1 }])
    await assert.rejects(nr.writeConfig(f.file, patch, UNIFORM), { code: 'ERR_BAD_REQUEST' });
  assert.equal(f.text(), before);
  await nr.writeConfig(f.file, nr.resetLayerPatch(1, UNIFORM), UNIFORM);
  assert.match(f.text(), /PrivateExperiment=1\nLightBroad=.65/);
  assert.ok(PUBLIC_NR_KEYS.includes('ProcessingStart')); assert.ok(PUBLIC_NR_KEYS.includes('Layer5UICorrection'));
});

test('concurrent different-field writes serialize without losing either edit', async t => {
  const f = fixture(t);
  await Promise.all([nr.writeConfig(f.file, { Intensity: 1.27 }, UNIFORM), nr.writeConfig(f.file, { ColorStrength: .63 }, UNIFORM)]);
  const value = f.read(); assert.equal(value.Intensity, 1.27); assert.equal(value.ColorStrength, .63);
  assert.deepEqual(fs.readdirSync(f.root), ['nr_before_sr.ini']);
});

test('an external INI change while a write is prepared wins, and the temporary file is removed', async t => {
  const f = fixture(t), original = fs.promises.writeFile;
  t.mock.method(fs.promises, 'writeFile', async function(file, ...args) {
    const result = await original.call(this, file, ...args);
    if (String(file).startsWith(f.file + '.xiaofeng-')) await original.call(this, f.file, '[NRBeforeSR]\nIntensity=1.91\n');
    return result;
  });
  await assert.rejects(nr.writeConfig(f.file, { Intensity: 1.2 }, UNIFORM), { code: 'ERR_NR_CONFIG_CHANGED' });
  assert.equal(f.read().Intensity, 1.91); assert.deepEqual(fs.readdirSync(f.root), ['nr_before_sr.ini']);
});

test('write failures propagate and cannot turn a directory/read error into a new default INI', async t => {
  const f = fixture(t), before = f.text();
  t.mock.method(fs.promises, 'rename', async () => { throw Object.assign(new Error('read-only'), { code: 'EACCES' }); });
  await assert.rejects(nr.writeConfig(f.file, { Intensity: 1.7 }, UNIFORM), { code: 'EACCES' });
  assert.equal(f.text(), before); assert.deepEqual(fs.readdirSync(f.root), ['nr_before_sr.ini']);
  await assert.rejects(nr.writeConfig(f.root, { Intensity: 1.7 }, UNIFORM));
});
