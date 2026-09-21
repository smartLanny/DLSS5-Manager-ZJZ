'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const routing = require('../src/product/experimental-core-routing');
const core = require('../src/product/unified5-core');
const route = (api = 'dx11', architecture = 'x64', hostRequired = false) => ({ api, architecture, hostRequired,
  hardwareFamilies: ['RTX40', 'RTX50'], loadingBackend: 'local', proxyEntries: ['auto', 'dxgi'] });
const pkg = (id, version, routes) => ({ id, version, selectable: true, routeDescriptors: routes });
test('experimental routing requires the exact Unified5 identity, never a similar version label', () => {
  assert.equal(routing.isUnified5(core.ID, core.HASHES['zh-CN']), true);
  assert.equal(routing.isUnified5('0.5-dline21', core.HASHES['zh-CN']), false);
  assert.equal(routing.isUnified5(core.ID, '0'.repeat(64)), false);
});
test('automatic provider selection respects API, architecture, hardware and backend without selecting untrusted packages', () => {
  const rows = [pkg('local-new', '1.2', [route()]), pkg('local-old', '1.1', [route()]),
    pkg('untrusted', '9.9', [route()]), pkg('legacy', '1.3', [route('dx9', 'x86', true)])];
  const trusted = new Set(['local-new', 'local-old', 'legacy']);
  const wanted = { api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'local' };
  assert.equal(routing.selectProvider(rows, wanted, trusted).provider.id, 'local-new');
  assert.equal(routing.selectProvider(rows, { ...wanted, loadingBackend: 'hoyoshade' }, trusted), null);
  assert.equal(routing.selectProvider(rows, { ...wanted, hardwareFamily: 'RTX30' }, trusted), null);
  assert.equal(routing.selectProvider(rows, { ...wanted, api: 'vulkan' }, trusted), null);
  assert.equal(routing.selectProvider(rows, { ...wanted, api: 'dx9', architecture: 'x86' }, trusted).provider.id, 'legacy');
  rows[0].selectable = false;
  assert.equal(routing.selectProvider(rows, wanted, trusted).provider.id, 'local-old');
});
