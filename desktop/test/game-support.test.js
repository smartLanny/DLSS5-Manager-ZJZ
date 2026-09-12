'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, isDx11Only, classifyApi } = require('../src/product/game-support');

const base = {
  chosen: { bitness: 64, api: 'dxgi', apiLabel: 'DirectX 12', emulator: null },
  primaryDlss: { name: 'nvngx_dlss.dll' },
  emulator: null
};

test('accepts only native x64 DX12 DLSS games for the current addon path', () => {
  assert.deepEqual(assess(base), { supported: true, code: null });
  assert.equal(assess({ ...base, chosen: { ...base.chosen, apiLabel: 'DirectX 11' } }).code, 'ERR_UNSUPPORTED_API');
  assert.deepEqual(assess({ ...base, chosen: { ...base.chosen, apiLabel: 'DirectX 11' } }, { allowDx11: true }), { supported: true, code: null });
  assert.equal(assess({ ...base, chosen: { ...base.chosen, apiLabel: 'DirectX 11/12', dx12: true } }).code, 'ERR_API_SELECTION_REQUIRED');
  assert.equal(assess({ ...base, chosen: { ...base.chosen, bitness: 32 } }).code, 'ERR_UNSUPPORTED_BITNESS');
  assert.equal(assess({ ...base, chosen: { ...base.chosen, api: 'vulkan', apiLabel: 'Vulkan' } }).code, 'ERR_UNSUPPORTED_API');
  assert.equal(assess({ ...base, primaryDlss: null }).code, 'ERR_NO_DLSS');
});

test('combined labels and dx12 flags never become pure DX11', () => {
  for (const chosen of [
    { apiLabel: 'DirectX 11/12' }, { apiLabel: 'DirectX 11 / DirectX 12' },
    { apiLabel: 'DirectX 11', dx12: true }, { apiLabel: 'DX11 / DX12' },
    { api: 'dx11', dx12: true }, { api: 'd3d12', dx11: true }
  ]) {
    assert.equal(isDx11Only(chosen), false);
    assert.equal(classifyApi(chosen), 'mixed');
  }
  assert.equal(isDx11Only({ apiLabel: 'DirectX 11', via: 'imports' }), true);
  assert.equal(isDx11Only({ api: 'dx11', via: 'imports' }), true);
  assert.equal(classifyApi({ api: 'dx11', via: 'imports' }), 'dx11');
});

test('an explicit resolved route wins over static hints without bypassing DLSS or x64 checks', () => {
  const chosen = { ...base.chosen, apiLabel: 'DirectX 11/12', apiResolution: { api: 'dx12', source: 'manual' } };
  assert.equal(classifyApi(chosen), 'dx12');
  assert.equal(assess({ ...base, chosen }).supported, true);
  assert.equal(assess({ ...base, chosen, primaryDlss: null }).code, 'ERR_NO_DLSS');
  assert.equal(assess({ ...base, chosen: { ...chosen, bitness: 32 } }).code, 'ERR_UNSUPPORTED_BITNESS');
});

test('known non-installable APIs remain selectable but assess as incompatible', () => {
  for (const api of ['dx9', 'dx10', 'vulkan', 'opengl']) {
    const chosen = { ...base.chosen, apiResolution: { api, source: 'override' } };
    assert.equal(classifyApi(chosen), api); assert.equal(assess({ ...base, chosen }).code, 'ERR_UNSUPPORTED_API');
  }
});
