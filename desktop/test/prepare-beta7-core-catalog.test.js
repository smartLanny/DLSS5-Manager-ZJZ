'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PAYLOAD_FILES } = require('../src/product/constants');
const { TARGETS, prepareBeta7CoreCatalog, readConfigBlob, sha256 } = require('../scripts/prepare-beta7-core-catalog');

const root = path.resolve(__dirname, '..');
const deliveryRoot = path.resolve(root, '..', 'deliveries');
const dline13Zip = process.env.BETA7_DLINE13_ZIP || path.join(deliveryRoot, 'DLSS5-0.5-D13-OTA-20260911-r2', 'DLSS5-0.5-D13-zh-CN-OTA.zip');
const corefix8Zip = process.env.BETA7_COREFIX8_ZIP || path.join(deliveryRoot, 'corefix8-047beta-20260911', 'packages', 'DLSS5-0.4.7beta-corefix.8-zh-CN-D3D12-Core-Acceptance.zip');
const sourceRepo = process.env.BETA7_CORE_REPO || root;

function pinnedInputsAvailable() {
  return fs.existsSync(dline13Zip) && fs.existsSync(corefix8Zip) && fs.existsSync(path.join(sourceRepo, '.git'));
}

function payloadFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beta7-core-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const versions = path.join(dir, 'versions');
  fs.mkdirSync(versions);
  const bundle = {
    version: 4,
    generatedAt: 'fixture',
    defaultVersion: '0.4.7beta',
    fixed: { RTX40: { files: {} }, RTX50: { files: {} } },
    versions: {
      '0.4.7beta': {
        label: 'old default',
        notes: 'must remain byte-for-byte represented',
        source: 'old source',
        compatibility: 'dx11',
        ota: true,
        files: {
          [PAYLOAD_FILES.addon]: 'a'.repeat(64),
          [PAYLOAD_FILES.bridge]: 'b'.repeat(64),
          [PAYLOAD_FILES.config]: 'c'.repeat(64)
        }
      }
    },
    catalogNote: 'preserve me'
  };
  const bundleFile = path.join(dir, 'bundle.json');
  fs.writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  return { dir, bundleFile, versions };
}

function runArgs(fixture) {
  return { dline13Zip, corefix8Zip, repoPath: sourceRepo, payloadRoot: fixture.dir };
}

test('real D13 and Corefix8 inputs add independent slots and repeat byte-for-byte', async t => {
  if (!pinnedInputsAvailable()) return t.skip('pinned local release inputs unavailable');
  const fixture = payloadFixture(t);
  const beforeDefault = JSON.parse(fs.readFileSync(fixture.bundleFile, 'utf8')).defaultVersion;
  const first = await prepareBeta7CoreCatalog(runArgs(fixture));
  const afterFirst = fs.readFileSync(fixture.bundleFile);
  assert.equal(first.defaultVersion, beforeDefault);
  assert.deepEqual(first.ids, ['0.5-dline13', '0.4.7beta-corefix.8']);
  const catalog = JSON.parse(afterFirst);
  assert.equal(catalog.defaultVersion, '0.4.7beta');
  assert.equal(catalog.catalogNote, 'preserve me');
  for (const target of TARGETS) {
    const entry = catalog.versions[target.id];
    assert.equal(entry.label, target.label);
    assert.equal(entry.compatibility, null);
    assert.equal(entry.comparisonOnly, false);
    assert.equal(entry.coreUpdateOnly, true);
    assert.equal(entry.ota, true);
    assert.equal(entry.api, 'D3D12-x64');
    assert.equal(entry.carrierIncluded, false);
    assert.equal(Object.hasOwn(entry.files, 'dlss5-native-carrier-045-dx11-compat.addon64'), false);
    assert.equal(entry.provenance.sourceZipSha256, target.sourceZipSha256);
    assert.equal(entry.provenance.sourceCommit, target.sourceCommit);
    assert.equal(entry.provenance.configSourceCommit, target.sourceCommit);
    const slot = path.join(fixture.versions, target.id);
    assert.equal(sha256(fs.readFileSync(path.join(slot, PAYLOAD_FILES.addon))), target.sourceAddonSha256);
    assert.equal(sha256(fs.readFileSync(path.join(slot, PAYLOAD_FILES.bridge))), target.bridgeSha256);
    assert.equal(sha256(fs.readFileSync(path.join(slot, PAYLOAD_FILES.config))), entry.provenance.configSha256);
    assert.equal(fs.existsSync(path.join(slot, 'dlss5-native-carrier-045-dx11-compat.addon64')), false);
    assert.deepEqual(fs.readdirSync(slot).sort(), ['core-import-receipt.json', PAYLOAD_FILES.addon, PAYLOAD_FILES.bridge, PAYLOAD_FILES.config].sort());
  }
  const second = await prepareBeta7CoreCatalog(runArgs(fixture));
  assert.equal(second.changed, false);
  assert.deepEqual(second.bundle, first.bundle);
  assert.deepEqual(fs.readFileSync(fixture.bundleFile), afterFirst);
});

test('wrong ZIP hash is rejected before catalog or slots change', async t => {
  const fixture = payloadFixture(t);
  const bad = path.join(fixture.dir, 'bad.zip');
  fs.writeFileSync(bad, Buffer.from('not the pinned ZIP'));
  const before = fs.readFileSync(fixture.bundleFile);
  await assert.rejects(prepareBeta7CoreCatalog({ ...runArgs(fixture), dline13Zip: bad }), error => error.code === 'ERR_BETA_CORE_ZIP_HASH');
  assert.deepEqual(fs.readFileSync(fixture.bundleFile), before);
  assert.deepEqual(fs.readdirSync(fixture.versions), []);
});

test('missing or wrong config source is rejected before writing', async t => {
  const fixture = payloadFixture(t);
  const missingRepo = path.join(fixture.dir, 'missing-repo');
  fs.mkdirSync(missingRepo);
  assert.throws(() => readConfigBlob(missingRepo, TARGETS[0]), error => error.code === 'ERR_BETA_CORE_CONFIG_SOURCE');

  const wrongRepo = path.join(fixture.dir, 'wrong-repo');
  fs.mkdirSync(wrongRepo);
  const init = spawnSync('git', ['init', '-q', wrongRepo], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  assert.throws(() => readConfigBlob(wrongRepo, TARGETS[0]), error => error.code === 'ERR_BETA_CORE_CONFIG_SOURCE');
  assert.deepEqual(fs.readdirSync(fixture.versions), []);
});

test('different pre-existing slot bytes reject without rewriting catalog', async t => {
  if (!pinnedInputsAvailable()) return t.skip('pinned local release inputs unavailable');
  const fixture = payloadFixture(t);
  const slot = path.join(fixture.versions, '0.5-dline13');
  fs.mkdirSync(slot);
  fs.writeFileSync(path.join(slot, PAYLOAD_FILES.addon), 'foreign bytes');
  const before = fs.readFileSync(fixture.bundleFile);
  await assert.rejects(prepareBeta7CoreCatalog(runArgs(fixture)), error => error.code === 'ERR_BETA_CORE_SLOT_CONFLICT');
  assert.deepEqual(fs.readFileSync(fixture.bundleFile), before);
  assert.equal(fs.readFileSync(path.join(slot, PAYLOAD_FILES.addon), 'utf8'), 'foreign bytes');
});

test('catalog publish failure preserves the old catalog and old slots', async t => {
  if (!pinnedInputsAvailable()) return t.skip('pinned local release inputs unavailable');
  const fixture = payloadFixture(t);
  const oldSlot = path.join(fixture.versions, '0.4.7beta');
  fs.mkdirSync(oldSlot);
  fs.writeFileSync(path.join(oldSlot, 'keep.txt'), 'old slot');
  const before = fs.readFileSync(fixture.bundleFile);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(to) === path.resolve(fixture.bundleFile)) throw Object.assign(new Error('injected catalog publish failure'), { code: 'EIO' });
    return originalRename(from, to);
  });
  await assert.rejects(prepareBeta7CoreCatalog(runArgs(fixture)), { code: 'EIO' });
  assert.deepEqual(fs.readFileSync(fixture.bundleFile), before);
  assert.equal(fs.readFileSync(path.join(oldSlot, 'keep.txt'), 'utf8'), 'old slot');
  assert.deepEqual(fs.readdirSync(fixture.versions), ['0.4.7beta']);
});
