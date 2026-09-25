'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/product/mfgunlock-config');
const policy = require('../src/product/launch-settings-policy');

test('0.9 compiles absolute fixed and Dynamic requests while preserving unselected settings', () => {
  const original = '\uFEFF[GENERAL]\r\nEffectSearchPaths=Shaders\\**\r\n[RenoDX.MFGUnlock]\r\nEnabled=0\r\nForceMultiplier=4\r\nDynamicMFG=1\r\nDynamicTargetFPS=144\r\nMaxCount=5\r\nRuntimeSelectionMode=2\r\nHDRCompatibilityMode=2\r\nForceFlipMeteringOff=0\r\nThinGeometryIntermediateScatter=1\r\nUnknownFutureKey=keep\r\n[User]\r\nKeep=值\r\n';
  const fixed = config.compile(original, { mode: 'fixed', multiplier: 2 });
  assert.equal(fixed.providerVersion, '0.9'); assert.equal(fixed.multiplierSemantics, 'absolute');
  assert.equal(fixed.content, original.replace('Enabled=0', 'Enabled=1').replace('ForceMultiplier=4', 'ForceMultiplier=2').replace('DynamicMFG=1', 'DynamicMFG=0'));
  assert.match(fixed.warnings.join(' '), /绝对倍率/);
  const request = { backend: 'mfgunlock', mode: 'dynamic', targetFps: 120, runtimeMode: 'local', hdrMode: 'automatic',
    depthEdgeGuard: 3, freezeFallback: true, reflexSourceCap: true };
  assert.deepEqual(policy.validateRequest('fg', request), request);
  const dynamic = config.compile(original, { mode: 'dynamic', targetFps: 120, runtimeMode: 'local', hdrMode: 'automatic',
    depthEdgeGuard: 3, freezeFallback: true, reflexSourceCap: true });
  assert.match(dynamic.content, /DynamicMFG=1/); assert.match(dynamic.content, /DynamicTargetFPS=120/);
  assert.match(dynamic.content, /RuntimeSelectionMode=1/); assert.match(dynamic.content, /HDRCompatibilityMode=2/);
  assert.match(dynamic.content, /DepthEdgeGuardLevel=3/); assert.match(dynamic.content, /ForceFlipMeteringOff=1/);
  assert.match(dynamic.content, /DynamicReflexSourceCap=1/); assert.match(dynamic.content, /UnknownFutureKey=keep/);
  assert.match(dynamic.warnings.join(' '), /310\.9\.1.*2\.14\.1.*595\.41/);
  for (const bad of [{ mode: 'off' }, { mode: 'fixed', multiplier: 1 }, { mode: 'fixed', multiplier: 7 }, { mode: 'follow', multiplier: 3 },
    { mode: 'dynamic', targetFps: -1 }, { mode: 'dynamic', targetFps: 120, runtimeMode: 'download' }, { mode: 'follow', mystery: true }])
    assert.throws(() => config.compile(original, bad), { code: 'SETTINGS_INPUT' });
});

test('restore touches only manager-owned 0.9 keys and retains panel changes and unrelated sections', () => {
  const before = '[RenoDX.MFGUnlock]\nEnabled=0\nForceMultiplier=0\nMaxCount=3\n[GENERAL]\nPresetPath=original.ini\n';
  const after = config.compile(before, { mode: 'fixed', multiplier: 4 }).content;
  const edited = after.replace('MaxCount=3', 'MaxCount=5').replace('PresetPath=original.ini', 'PresetPath=player.ini');
  const owned = { Enabled: '1', ForceMultiplier: '4' };
  assert.equal(config.restore(edited, before, owned), before.replace('MaxCount=3', 'MaxCount=5').replace('PresetPath=original.ini', 'PresetPath=player.ini'));
  assert.throws(() => config.restore(edited.replace('ForceMultiplier=4', 'ForceMultiplier=3'), before, owned), { code: 'SETTINGS_EXTERNAL_CHANGE' });
  for (const text of ['[RenoDX.MFGUnlock]\nEnabled=1\nENABLED=0\n', '[RenoDX.MFGUnlock]\n[RenoDX.MFGUnlock]\n', '[RenoDX.MFGUnlock] trailing\n'])
    assert.throws(() => config.compile(text, { mode: 'follow' }), { code: 'AMBIGUOUS_INI' });
});

test('a newly introduced empty section can be removed, but a player-added field is preserved', () => {
  assert.equal(config.compile('', { mode: 'follow' }).content, '');
  const after = config.compile('', { mode: 'fixed', multiplier: 3 }).content;
  const owned = { ForceMultiplier: '3' };
  assert.equal(config.restore(after, '', owned).trim(), '');
  const edited = after + 'TemporalFix=0\n';
  assert.match(config.restore(edited, '', owned), /\[RenoDX.MFGUnlock\]\n+TemporalFix=0/);
});
