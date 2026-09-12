'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recommendSrPreset,
  effectiveSrPreset,
  hasFp8Penalty,
  presetValue
} = require('../src/product/sr-model-policy');

test('auto policy recommends K for RTX 20/30 and M for RTX 40/50', () => {
  assert.equal(recommendSrPreset({ family: 'RTX40', series: ['RTX20'] }), 'k');
  assert.equal(recommendSrPreset({ family: 'RTX40', series: ['RTX30'] }), 'k');
  assert.equal(recommendSrPreset({ family: 'RTX40', series: ['RTX40'] }), 'm');
  assert.equal(recommendSrPreset({ family: 'RTX50', series: ['RTX50'] }), 'm');
});

test('auto policy fails safe for unknown or mixed GPU sets', () => {
  assert.equal(recommendSrPreset({ family: 'unknown', series: [] }), 'default');
  assert.equal(recommendSrPreset({ family: 'mixed', series: ['RTX40', 'RTX50'] }), 'default');
  assert.equal(recommendSrPreset({ family: 'RTX40', series: ['RTX30', 'RTX40'] }), 'default');
});

test('manual choices override auto policy and old GPUs warn on L/M FP8 cost', () => {
  const oldGpu = { family: 'RTX40', series: ['RTX30'] };
  assert.equal(effectiveSrPreset('m', oldGpu), 'm');
  assert.equal(effectiveSrPreset('default', oldGpu), 'default');
  assert.equal(hasFp8Penalty(oldGpu, 'm'), true);
  assert.equal(hasFp8Penalty(oldGpu, 'l'), true);
  assert.equal(hasFp8Penalty(oldGpu, 'k'), false);
  assert.equal(presetValue('k'), 11);
  assert.equal(presetValue('l'), 12);
  assert.equal(presetValue('m'), 13);
});
