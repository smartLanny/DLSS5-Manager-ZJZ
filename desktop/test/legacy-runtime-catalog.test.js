'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const catalog = require('../src/product/legacy-runtime-catalog');

test('legacy recipe keeps DX9 input, system D3D9On12 and host architecture distinct', () => {
  const value = catalog.resolve({ api: 'dx9', architecture: 'x86', hardwareFamily: 'RTX40', loadingBackend: 'local' });
  assert.equal(value.gameApi, 'dx9'); assert.equal(value.renderApi, 'dx9');
  assert.equal(value.wrapper.entry, 'd3d9.dll'); assert.equal(value.proxyEntry, 'd3d9');
  assert.equal(value.wrapper.systemRuntime, true); assert.equal(value.wrapper.privateRuntimeBundled, false);
  assert.equal(value.hostRequired, true); assert.equal(value.upstream.ipcVersion, 9);
  assert.deepEqual(value.componentRoles.filter(row => ['core', 'nr-runtime', 'host'].includes(row.role)).map(row => row.architecture), ['x64', 'x64', 'x64']);
  assert.equal(value.srInjected, false); assert.equal(value.fgInjected, false);
  assert.equal(value.acceptance.realGameVerified, false);
});

test('proxy entry choices do not change the actual game API', () => {
  const input = { api: 'dx12', architecture: 'x64', hardwareFamily: 'RTX50' };
  assert.equal(catalog.resolve({ ...input, proxyEntry: 'd3d12' }).gameApi, 'dx12');
  assert.equal(catalog.resolve({ ...input, proxyEntry: 'dxgi' }).gameApi, 'dx12');
  assert.throws(() => catalog.resolve({ ...input, proxyEntry: 'd3d11' }), { code: 'LEGACY_PROXY_UNSUPPORTED' });
  assert.throws(() => catalog.resolve({ ...input, loadingBackend: 'hoyoshade', proxyEntry: 'dxgi' }), { code: 'LEGACY_PROXY_UNSUPPORTED' });
  assert.equal(catalog.resolve({ ...input, loadingBackend: 'hoyoshade' }).proxyEntry, null);
});

test('catalog enumerates unique independently pinned architecture/GPU/backend recipes', () => {
  const list = catalog.list(); assert.equal(list.length, 24); assert.equal(new Set(list.map(row => row.id)).size, 24);
  assert.throws(() => catalog.resolve({ api: 'dx9', architecture: 'x86', hardwareFamily: 'RTX50', loadingBackend: 'hoyoshade' }), { code: 'LEGACY_RECIPE_UNSUPPORTED' });
  assert.ok(list.every(row => Object.isFrozen(row) && row.upstream.commit.length === 40 && row.motionVectors.provider === 2));
  assert.equal(list.filter(row => row.gameApi === 'dx10' && row.architecture === 'x64').length, 4);
  assert.ok(list.filter(row => row.gameApi === 'dx10').every(row => row.wrapper === null && row.relay === 'd3d10-to-d3d11'));
  assert.throws(() => catalog.resolve({ api: 'dx9', architecture: 32, hardwareFamily: 'RTX50' }), { code: 'LEGACY_RECIPE_UNSUPPORTED' });
  assert.throws(() => catalog.resolve({ api: 'dx12', architecture: 'x86', hardwareFamily: 'RTX50' }), { code: 'LEGACY_RECIPE_UNSUPPORTED' });
  assert.throws(() => catalog.resolve({ api: 'dx12', architecture: 'x64', hardwareFamily: 'RTX50', runtimeRoot: '/tmp' }), { code: 'LEGACY_RECIPE_BAD_REQUEST' });
});

test('internal layouts require verified exact EXE binding and contained runtime paths', () => {
  const root = path.resolve('fixture-game'), runtime = path.join(root, '_DLSS5_Feeder');
  const game = { dir: root, scan: { chosen: { path: path.join(root, 'Game.exe') } } };
  const layout = { gameDir: root, exePath: game.scan.chosen.path, runtimeDir: runtime,
    addonDirectory: path.join(runtime, 'addons'), nrConfigDir: path.join(runtime, 'addons'), activeConfigPath: path.join(runtime, 'ReShade.ini'), generation: 1, source: 'local', verified: true };
  assert.equal(catalog.validateLayout(game, layout), layout);
  assert.throws(() => catalog.validateLayout(game, { ...layout, verified: false }), { code: 'LEGACY_LAYOUT_UNVERIFIED' });
  assert.throws(() => catalog.validateLayout(game, { ...layout, exePath: path.join(root, 'Other.exe') }), { code: 'LEGACY_LAYOUT_UNVERIFIED' });
  assert.throws(() => catalog.validateLayout(game, { ...layout, nrConfigDir: path.dirname(runtime) }), { code: 'LEGACY_LAYOUT_UNVERIFIED' });
});
