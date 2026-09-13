'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyGpu, detectGpu, detectGpuAsync } = require('../src/product/gpu');

test('maps RTX 20/30/40 to the compatible RTX40 payload and keeps RTX50 separate', () => {
  assert.equal(classifyGpu('NVIDIA GeForce RTX 2060'), 'RTX40');
  assert.equal(classifyGpu('NVIDIA GeForce RTX 3080 Ti'), 'RTX40');
  assert.equal(classifyGpu('NVIDIA GeForce RTX 4090 Laptop GPU'), 'RTX40');
  assert.equal(classifyGpu('NVIDIA GeForce RTX 5090 Laptop GPU'), 'RTX50');
  assert.equal(classifyGpu('Intel(R) Graphics'), null);
  assert.deepEqual(detectGpu({ run: () => 'Intel(R) Graphics\nNVIDIA GeForce RTX 5090 Laptop GPU\n' }), {
    family: 'RTX50', families: ['RTX50'], series: ['RTX50'], names: ['Intel(R) Graphics', 'NVIDIA GeForce RTX 5090 Laptop GPU'],
    source: 'Win32_VideoController', supported: true
  });
  assert.deepEqual(detectGpu({ run: () => 'NVIDIA GeForce RTX 3060\n' }).family, 'RTX40');
});

test('async GPU probe preserves classification and leaves the event loop responsive', async () => {
  let ticked = false;
  const probe = detectGpuAsync({ run: () => new Promise(resolve => setTimeout(() => resolve('NVIDIA GeForce RTX 4090\n'), 30)) });
  setTimeout(() => { ticked = true; }, 5);
  const result = await probe;
  assert.equal(result.family, 'RTX40'); assert.deepEqual(result.series, ['RTX40']); assert.equal(ticked, true);
  assert.equal((await detectGpuAsync({ run: async () => { throw new Error('CIM unavailable'); } })).family, 'unknown');
});
