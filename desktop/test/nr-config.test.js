'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSection, updateSection, writeConfig, readConfig } = require('../src/product/nr-config');

test('parses and normalizes public NR settings', () => {
  const value = parseSection('[NRBeforeSR]\nEnabled=1\nMode=9\nIntensity=9\nWorkMode=7\nCustomWorkScale=0.1\nStyle=2\nAutoMask=0\nColorStrength=2\nSkinStructureStrength=3\n');
  assert.deepEqual(value, { Enabled: 1, Mode: 2, Intensity: 2, WorkMode: 5, CustomWorkScale: 0.25, Style: 2, AutoMask: 0, ColorStrength: 2, SkinStructureStrength: 2 });
});

test('updates only the target section and preserves comments/other sections', () => {
  const input = '; keep\r\n[Other]\r\nEnabled=9\r\n[NRBeforeSR]\r\n; note\r\nIntensity=1.0\r\n';
  const output = updateSection(input, { Intensity: 1.2, WorkMode: 2 });
  assert.match(output, /\[Other\]\r\nEnabled=9/);
  assert.match(output, /; note\r\nIntensity=1.2\r\nWorkMode=2/);
});

test('atomically writes and reads a new config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-ini-'));
  const file = path.join(dir, 'nr_before_sr.ini');
  await writeConfig(file, { Enabled: 1, Intensity: 1.2, WorkMode: 2, CustomWorkScale: 0.75, Style: 1, AutoMask: 1, ColorStrength: 0.5, SkinStructureStrength: 0.8, TransferStrength: 2.5, PostTransferStrength: 0.66 });
  assert.deepEqual(readConfig(file), {
    Enabled: 1, Intensity: 1.2, WorkMode: 2, CustomWorkScale: 0.75,
    Style: 1, AutoMask: 1, ColorStrength: 0.5, SkinStructureStrength: 0.8,
    LocalToneStrength: 1, LocalStructureStrength: 1,
    TransferStrength: 2.5, PostTransferStrength: 0.66,
    capabilities: {
      WorkMode: true, CustomWorkScale: true, ColorStrength: true,
      SkinStructureStrength: true, LocalToneStrength: false, LocalStructureStrength: false, TransferStrength: true, PostTransferStrength: true
    }
  });
});

test('keeps legacy 0.2 and 0.3 configs readable while clamping old intensity above the current core range', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-legacy-ini-'));
  const file = path.join(dir, 'nr_before_sr.ini');
  fs.writeFileSync(file, '[NRBeforeSR]\nMode=2\nIntensity=2.75\nTransferStrength=1\nPostTransferStrength=1\nColorStrength=0\n');

  const value = readConfig(file);
  assert.equal(value.Intensity, 2);
  assert.equal(value.TransferStrength, 1);
  assert.equal(value.PostTransferStrength, 1);
  assert.deepEqual(value.capabilities, {
    WorkMode: false,
    CustomWorkScale: false,
    ColorStrength: true,
    SkinStructureStrength: false,
    LocalToneStrength: false,
    LocalStructureStrength: false,
    TransferStrength: true,
    PostTransferStrength: true
  });
});

test('local tone and structure round-trip independently, and disabling face keeps its previous strength', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-face-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nr_before_sr.ini');
  await writeConfig(file, { LocalToneStrength: 0.45, LocalStructureStrength: 1.65, SkinStructureStrength: 0.8 });
  await writeConfig(file, { AutoMask: 0 });
  const current = readConfig(file);
  assert.equal(current.LocalToneStrength, 0.45);
  assert.equal(current.LocalStructureStrength, 1.65);
  assert.equal(current.SkinStructureStrength, 0.8);
  assert.equal(current.AutoMask, 0);
  await writeConfig(file, { AutoMask: 1 });
  assert.equal(readConfig(file).SkinStructureStrength, 0.8);
  assert.equal(readConfig(file).AutoMask, 1);
});

test('writing model strength or shared effect strength preserves color strength', () => {
  const original = '[NRBeforeSR]\nIntensity=1.25\nTransferStrength=3.25\nPostTransferStrength=0.66\nColorStrength=0.2\n';
  const edited = updateSection(original, {
    Intensity: 1.75,
    TransferStrength: 2.5,
    PostTransferStrength: 2.5
  });
  const value = parseSection(edited);

  assert.equal(value.Intensity, 1.75);
  assert.equal(value.TransferStrength, 2.5);
  assert.equal(value.PostTransferStrength, 2.5);
  assert.equal(value.ColorStrength, 0.2);
});


test('recommended reset sets both final blend routes to one without confusing model or color strength', () => {
  const { defaultPatch } = require('../src/product/nr-config');
  const original = '[NRBeforeSR]\nTransferStrength=3.25\nPostTransferStrength=0.66\nColorStrength=0.2\nIntensity=2\nOtherValue=keep\n';
  const editedColor = updateSection(original, { ColorStrength: 0.6 });
  assert.match(editedColor, /TransferStrength=3.25/);
  assert.match(editedColor, /PostTransferStrength=0.66/);
  assert.equal(parseSection(editedColor).TransferStrength, 3.25, 'reading does not pretend an explicit high blend is one');
  const restored = parseSection(updateSection(original, defaultPatch()));
  assert.equal(restored.TransferStrength, 1);
  assert.equal(restored.PostTransferStrength, 1);
  assert.equal(restored.ColorStrength, 0.75);
  assert.match(updateSection(original, defaultPatch()), /OtherValue=keep/);
  assert.equal(defaultPatch('0.4.7beta').Intensity, 1.2);
  assert.equal(defaultPatch('0.4.7beta').ColorStrength, 1);
  assert.equal(defaultPatch('0.4.6-hotfix.1').Intensity, 1);
});

test('D13 edits obey its public ranges and preserve second-pass and lighting preferences', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-d13-ini-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nr_before_sr.ini');
  const original = '[NRBeforeSR]\r\nWorkMode=5\r\nCustomWorkScale=0.75\r\nTransferStrength=0.4\r\nPostTransferStrength=2\r\nNRPasses=2\r\nNRSecondScaleNumerator=2\r\nNRSecondScaleDenominator=3\r\nLightBroad=0.65\r\n';
  fs.writeFileSync(file, original);
  const current = readConfig(file, '0.5-dline13');
  assert.equal(current.TransferStrength, 0.4, 'inspection retains explicit saved values until an edit');
  assert.equal(current.limits.TransferStrength.min, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), original, 'reading never migrates the game config');
  const edited = await writeConfig(file, { CustomWorkScale: 0.25, TransferStrength: 0, PostTransferStrength: 9 }, '0.5-dline13');
  assert.equal(edited.CustomWorkScale, 0.5);
  assert.equal(edited.TransferStrength, 1);
  assert.equal(edited.PostTransferStrength, 4);
  const { defaultPatch } = require('../src/product/nr-config');
  const restored = await writeConfig(file, defaultPatch('0.5-dline13'), '0.5-dline13');
  assert.equal(restored.Intensity, 1.2); assert.equal(restored.ColorStrength, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /NRPasses=2\r\nNRSecondScaleNumerator=2\r\nNRSecondScaleDenominator=3\r\nLightBroad=0.65/);
  assert.equal(readConfig(file, '0.4.7beta-corefix.8').limits, undefined);
  const legacy = parseSection(updateSection(original, { TransferStrength: 0.4 }, '0.4.7beta-corefix.8'));
  assert.equal(legacy.TransferStrength, 0.4, 'Corefix8 keeps its own public range');
});
