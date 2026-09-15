'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CORE_CHOICES, coreMenu, preferredBundleDefault } = require('../src/product/core-menu');
const { prepareCoreCatalog } = require('../scripts/prepare-core-catalog');
const { resolveVersion } = require('../src/product/version-selection');
const complete = { supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1'] };

test('five primary choices carry actual identities, not display-name aliases', () => {
  const input = CORE_CHOICES.map(row => ({ id: row.ids[0], ready: true, source: 'external', compatibility: 'dx12' }));
  const original = structuredClone(input), result = coreMenu(input, { defaultVersion: '0.5-dline21' });
  assert.deepEqual(result.map(row => row.id), input.map(row => row.id));
  assert.equal(result.length, 5); assert.match(result[4].label, /D21.*新安装默认/);
  assert.deepEqual(input, original); assert.equal(result[4].compatibility, 'dx12');
});
test('missing sources are visible but cannot be installed', () => {
  const rows = coreMenu([]);
  assert.equal(rows.length, 5); assert.ok(rows.every(row => row.ready === false && row.verification === 'unavailable'));
  assert.ok(rows.every(row => !row.label.includes('新安装默认')));
});
test('installed D12 and imported updates survive a five-choice menu without upgrading', () => {
  const rows = [{ id: '0.5-dline12', ready: true }, { id: 'imported-1234', source: 'imported', ready: true },
    { id: '0.5-dline21', ready: true }, { id: 'unrelated-test-core', ready: true }];
  const result = coreMenu(rows, { installedVersion: '0.5-dline12', defaultVersion: '0.5-dline21' });
  assert.ok(result.some(row => row.id === '0.5-dline12'));
  assert.ok(result.some(row => row.id === 'imported-1234'));
  assert.ok(!result.some(row => row.id === 'unrelated-test-core'));
  assert.equal(resolveVersion({ game: { addonVersion: '0.5-dline12' }, globalVersion: '0.5-dline21' }), '0.5-dline12');
});
test('an unrecognized saved default is retained and never converted into D21', () => {
  const rows = coreMenu([{ id: 'signed-core-d12-abc', ready: true, label: 'D21' }], { defaultVersion: 'signed-core-d12-abc' });
  assert.ok(rows.some(row => row.id === 'signed-core-d12-abc' && row.label === 'D21'));
  assert.equal(rows.find(row => row.id === 'unavailable-core-d21').ready, false);
});
test('ambiguous identities are not silently coalesced', () => {
  const input = [{ id: '0.4.7beta', ready: true }, { id: '0.4.7', ready: true }];
  const result = coreMenu(input);
  for (const row of input) assert.ok(result.some(candidate => candidate.id === row.id));
  assert.equal(result.find(row => row.id === 'unavailable-core-047').ready, false);
});
test('metadata-only and failed verification remain distinct from runtime success', () => {
  const input = [{ id: '0.5-dline21', ready: false, verification: 'metadata-only', coreUpdateOnly: true,
    compatibilityEvidence: { actualNrVerified: false } }];
  const row = coreMenu(input, { defaultVersion: input[0].id }).find(row => row.id === input[0].id);
  assert.equal(row.ready, false); assert.equal(row.coreUpdateOnly, true);
  assert.equal(row.verification, 'metadata-only'); assert.equal(row.compatibilityEvidence.actualNrVerified, false);
});
test('preparing a validated complete D21 source preserves it as default over 0.4.7', () => {
  const input = { version: 4, defaultVersion: '0.5-dline21', versions: {
    '0.5-dline21': { ...complete }, '0.4.7beta': { compatibility: 'dx11' }, '0.3.3-dev-r4': {} } };
  assert.equal(prepareCoreCatalog(input).bundle.defaultVersion, '0.5-dline21');
  assert.deepEqual(input.versions['0.5-dline21'], complete);
});
test('D12, D20, mislabeled files and core-only D21 cannot become the D21 default', () => {
  for (const versions of [{ '0.5-dline12': complete }, { '0.5-dline20': { ...complete, label: '0.5D21' } },
    { '0.5-dline21': { ...complete, coreUpdateOnly: true } }, { '0.5-dline21': {} },
    { '0.5-dline21': complete, '0.5D21': complete }]) assert.equal(preferredBundleDefault({ versions }), null);
});

test('without a complete D21 source the existing full D12 default is not downgraded', () => {
  const input = { version: 4, defaultVersion: '0.5-dline12', versions: {
    '0.5-dline12': { ...complete }, '0.4.7beta': { compatibility: 'dx11' } } };
  assert.equal(prepareCoreCatalog(input).bundle.defaultVersion, '0.5-dline12');
  const rows = coreMenu([{ id: '0.5-dline12', ready: true }], { installedVersion: '0.5-dline12', defaultVersion: '0.5-dline12' });
  assert.ok(rows.every(row => !String(row.label).includes('新安装默认')));
});
