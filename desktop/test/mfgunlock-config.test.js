'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/product/mfgunlock-config');
const policy = require('../src/product/launch-settings-policy');

test('0.6.1 compiles follow and raise requests without activating unsupported legacy or pacing controls', () => {
  const original = '\uFEFF[GENERAL]\r\nEffectSearchPaths=Shaders\\**\r\n[RenoDX.MFGUnlock]\r\nEnabled=0\r\nForceMultiplier=4\r\nMaxCount=3\r\nRaiseFrameCeiling=0\r\nForceFlipMeteringOff=0\r\nForceOTAPlugins=0\r\nTemporalFix=1\r\n[User]\r\nKeep=值\r\n';
  for (const request of [{ mode: 'follow' }, ...[2, 3, 4, 5, 6].map(multiplier => ({ mode: 'fixed', multiplier }))]) {
    const result = config.compile(original, request);
    assert.equal(result.runtimeVerified, false); assert.equal(result.requiresRestart, true); assert.equal(result.multiplierSemantics, 'raise-only');
    assert.equal(result.content, original.replace('Enabled=0', 'Enabled=1').replace('ForceMultiplier=4', `ForceMultiplier=${request.multiplier || 0}`));
    assert.deepEqual(policy.validateRequest('fg', { backend: 'mfgunlock', ...request }), { backend: 'mfgunlock', ...request });
    assert.match(result.warnings.join(' '), /不会降低.*更高倍率/);
    if ((request.multiplier || 0) > 4) assert.match(result.warnings.join(' '), /不会自动提高.*硬上限/);
  }
  for (const request of [{ mode: 'dynamic', targetFps: 120 }, { mode: 'off' }, { mode: 'fixed', multiplier: 4, experimental56: false },
    { mode: 'fixed', multiplier: 1 }, { mode: 'fixed', multiplier: 7 }, { mode: 'follow', multiplier: 3 }]) {
    assert.throws(() => config.compile(original, request), { code: 'SETTINGS_INPUT' });
  }
});

test('restore touches only the two owned keys and retains menu changes and unrelated sections', () => {
  const before = '[RenoDX.MFGUnlock]\nEnabled=0\nForceMultiplier=0\nMaxCount=3\n[GENERAL]\nPresetPath=original.ini\n';
  const after = config.compile(before, { mode: 'fixed', multiplier: 4 }).content;
  const edited = after.replace('MaxCount=3', 'MaxCount=5').replace('PresetPath=original.ini', 'PresetPath=player.ini');
  assert.equal(config.restore(edited, before, config.values(after)), before.replace('MaxCount=3', 'MaxCount=5').replace('PresetPath=original.ini', 'PresetPath=player.ini'));
  assert.throws(() => config.restore(edited.replace('ForceMultiplier=4', 'ForceMultiplier=3'), before, config.values(after)), { code: 'SETTINGS_EXTERNAL_CHANGE' });
  for (const text of ['[RenoDX.MFGUnlock]\nEnabled=1\nENABLED=0\n', '[RenoDX.MFGUnlock]\n[RenoDX.MFGUnlock]\n', '[RenoDX.MFGUnlock] trailing\n'])
    assert.throws(() => config.compile(text, { mode: 'follow' }), { code: 'AMBIGUOUS_INI' });
});

test('a newly introduced empty section can be removed, but a player-added field is preserved', () => {
  const after = config.compile('', { mode: 'follow' }).content;
  assert.equal(config.restore(after, '', config.values(after)).trim(), '');
  const edited = after + 'TemporalFix=0\n';
  assert.match(config.restore(edited, '', config.values(after)), /\[RenoDX.MFGUnlock\]\n+TemporalFix=0/);
});
