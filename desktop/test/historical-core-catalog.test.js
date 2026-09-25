'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HISTORY, historicEntry, assertHistoricalEntry, readHistoricalInputs, prepareHistoricalCatalog } = require('../scripts/prepare-historical-core-catalog');
const { coreMenu } = require('../src/product/core-menu');
const { sha256 } = require('../scripts/prepare-beta7-core-catalog');

test('historical choices remain separate, explicit and unsupported by newer external routes', () => {
  const entries = Object.keys(HISTORY).map(id => ({ id, ...historicEntry(id), ready: true }));
  for (const entry of entries) {
    assert.doesNotThrow(() => assertHistoricalEntry(entry.id, entry));
    for (const patch of [{ sourceCommit: '0'.repeat(40) }, { supportsPresent: true }, { compatibility: 'dx11' },
      { inputInterfaces: ['NRExternalProviderV1'] }, { capabilities: ['same-frame-output'] }, { files: { ...entry.files, 'nrchain_nvngx.dll': '0'.repeat(64) } }])
      assert.throws(() => assertHistoricalEntry(entry.id, { ...entry, ...patch }), /身份或能力声明/);
  }
  const menu = coreMenu([...entries, { id: '0.4.7beta', ready: true }, { id: '0.5-dline21-unified5', ready: true }], { defaultVersion: '0.4.7beta' });
  assert.equal(menu.find(row => row.id === '0.3.7').ready, true);
  assert.match(menu.find(row => row.id === '0.5-dline13').label, /双层/);
  assert.equal(menu.filter(row => row.label.includes('新安装推荐')).length, 1);
  assert.match(menu.find(row => row.id === '0.4.7beta').label, /推荐/);
});

const input = { source037: process.env.BETA9_SOURCE_037, d13Zip: process.env.BETA9_D13_ZIP, repoPath: process.env.BETA9_CORE_REPO };
const realInputs = Object.values(input).every(Boolean);
test('pinned existing 0.3.7/D13 inputs retain exact Core, chain and version-specific configuration', { skip: !realInputs }, async () => {
  const read = await readHistoricalInputs(input);
  for (const [id, target] of Object.entries(HISTORY)) for (const [name, digest] of Object.entries(target.files)) assert.equal(sha256(read[id][name]), digest);
  assert.match(read['0.3.7']['nr_before_sr.ini'].toString(), /ConfigVersion=3/);
  assert.match(read['0.5-dline13']['nr_before_sr.ini'].toString(), /NRSecondScaleDenominator=2/);
  assert.doesNotMatch(read['0.5-dline13']['nr_before_sr.ini'].toString(), /UniformChainVersion|Layer3Enabled/);
});

test('external catalog preparation preserves original files/default and refuses an existing output', { skip: !realInputs || !process.env.BETA9_BASE_CATALOG }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-core-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseRoot = process.env.BETA9_BASE_CATALOG, outputRoot = path.join(root, 'catalog');
  const before = fs.readFileSync(path.join(baseRoot, 'bundle.json'));
  const result = await prepareHistoricalCatalog({ ...input, baseRoot, outputRoot });
  assert.equal(result.defaultVersion, '0.4.7beta');
  assert.ok(result.versions.includes('0.5-dline21-unified5'));
  assert.deepEqual(fs.readFileSync(path.join(baseRoot, 'bundle.json')), before);
  await assert.rejects(prepareHistoricalCatalog({ ...input, baseRoot, outputRoot }), /拒绝覆盖/);
  const bundle = JSON.parse(fs.readFileSync(path.join(outputRoot, 'bundle.json')));
  for (const [id, entry] of Object.entries(bundle.versions)) for (const [name, hash] of Object.entries({ ...entry.files, ...entry.companions }))
    assert.equal(sha256(fs.readFileSync(path.join(outputRoot, 'versions', id, name))), hash);
});
