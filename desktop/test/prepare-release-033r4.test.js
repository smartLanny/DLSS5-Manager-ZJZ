'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ENTRY, FILES, SOURCE, SOURCE_BUILD, VERSION, loadSource, prepare
} = require('../scripts/prepare-release-033r4');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REAL_ADDON = path.resolve(PROJECT_ROOT, '..', '..', 'dlss5-lab', 'nr-before-sr', 'github-staging', 'release',
  'beta0.3.3-dev-r4-2869', 'RTX50-DLSS5-AI渲染超分版-beta0.3.3-dev-r4-@野生的装机宅-Bilibili-完整包', FILES.addon.sourceName);
const BETA_036_ZIP = path.resolve(PROJECT_ROOT, '..', '..', 'dlss5-lab', 'nr-before-sr', 'github-staging', 'release',
  'beta0.3.3.6-small-9b10', 'DLSS5-beta0.3.3.6-中文轻量更新包.zip');
const BRIDGE = '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb';
const RTX40_RUNTIME = '6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927';
const RTX50_RUNTIME = 'e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hardlinkOrCopy(source, target) {
  try { fs.linkSync(source, target); }
  catch { fs.copyFileSync(source, target); }
}

function makeFixture(t, { pinnedFixed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-033r4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  const fixedRoot = path.join(PROJECT_ROOT, 'payload', 'nr-before-sr', 'fixed');
  const fixedManifest = {};
  for (const [family, runtime] of [['RTX40', RTX40_RUNTIME], ['RTX50', RTX50_RUNTIME]]) {
    const fixed = path.join(root, 'fixed', family);
    fs.mkdirSync(fixed, { recursive: true });
    const bridgeFile = path.join(fixed, 'nrchain_nvngx.dll'), runtimeFile = path.join(fixed, 'nvngx_dlssnr.dll');
    if (pinnedFixed) {
      hardlinkOrCopy(path.join(fixedRoot, family, 'nrchain_nvngx.dll'), bridgeFile);
      hardlinkOrCopy(path.join(fixedRoot, family, 'nvngx_dlssnr.dll'), runtimeFile);
      assert.equal(sha256(bridgeFile), BRIDGE);
      assert.equal(sha256(runtimeFile), runtime);
    } else {
      fs.writeFileSync(bridgeFile, `fixture-${family}-bridge`);
      fs.writeFileSync(runtimeFile, `fixture-${family}-runtime`);
    }
    fixedManifest[family] = { files: { 'nrchain_nvngx.dll': sha256(bridgeFile), 'nvngx_dlssnr.dll': sha256(runtimeFile) } };
  }
  const keep = {
    '0.3.3.5': { label: 'keep stable', notes: 'keep stable', source: 'keep stable', compatibility: null, ota: false,
      files: { 'nr-before-sr.zh-CN.addon64': 'old-addon', 'nr_before_sr.ini': 'old-ini' } },
    '0.4.6-hotfix.1': { label: 'keep latest', notes: 'keep latest', source: 'keep latest', compatibility: 'dx11', ota: true,
      files: { 'nr-before-sr.zh-CN.addon64': 'latest-addon', 'nr_before_sr.ini': 'latest-ini' } }
  };
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({
    version: 4,
    generatedAt: 'fixture',
    defaultVersion: '0.4.6-hotfix.1',
    fixed: fixedManifest,
    versions: keep
  }, null, 2) + '\n');
  return { root, keep };
}

test('reviewed r4 source is the real 0.3.3.4 build and has the complete Chinese pair', { skip: !fs.existsSync(REAL_ADDON) }, async t => {
  const source = loadSource(REAL_ADDON);
  assert.equal(SOURCE, '9085a4d67e32b8a6c83bc184b80ebe26b59c207d');
  assert.equal(SOURCE_BUILD, 'beta0.3.3-dev-r4');
  assert.equal(source.hashes.addon, FILES.addon.hash);
  assert.equal(source.hashes.config, FILES.config.hash);
  assert.equal(source.hashes.bridge, FILES.bridge.hash);
  assert.equal(source.hashes.runtime, FILES.runtime.hash);
  assert.match(fs.readFileSync(path.join(source.dir, FILES.config.sourceName), 'utf8'), /TransferStrength=1\.00/);
  assert.match(fs.readFileSync(path.join(source.dir, FILES.config.sourceName), 'utf8'), /PostTransferStrength=1\.00/);
  assert.equal(source.addon.length, FILES.addon.bytes);
  assert.equal(source.config.length, FILES.config.bytes);
});

test('r4 preparation adds only the true 0.3.3-dev-r4 slot, preserves the default and is idempotent', { skip: !fs.existsSync(REAL_ADDON) }, async t => {
  const fixture = makeFixture(t);
  await prepare(REAL_ADDON, { root: fixture.root });
  const bundleFile = path.join(fixture.root, 'bundle.json');
  const firstBundle = fs.readFileSync(bundleFile, 'utf8');
  const bundle = JSON.parse(firstBundle);
  assert.equal(bundle.defaultVersion, '0.4.6-hotfix.1');
  assert.deepEqual(bundle.versions['0.3.3.5'], fixture.keep['0.3.3.5']);
  assert.deepEqual(bundle.versions['0.4.6-hotfix.1'], fixture.keep['0.4.6-hotfix.1']);
  assert.equal(bundle.versions[VERSION].compatibility, null);
  assert.equal(bundle.versions[VERSION].ota, false);
  assert.match(bundle.versions[VERSION].source, new RegExp(SOURCE));
  assert.match(bundle.versions[VERSION].notes, /D3D12/);
  assert.match(bundle.versions[VERSION].notes, /carrier/);

  const target = path.join(fixture.root, 'versions', VERSION);
  assert.deepEqual(fs.readdirSync(target).sort(), [FILES.addon.targetName, FILES.config.targetName].sort());
  assert.equal(fs.existsSync(path.join(target, FILES.bridge.sourceName)), false);
  assert.equal(fs.existsSync(path.join(target, FILES.runtime.sourceName)), false);

  await prepare(REAL_ADDON, { root: fixture.root });
  assert.equal(fs.readFileSync(bundleFile, 'utf8'), firstBundle);
  assert.equal(sha256(path.join(target, FILES.addon.targetName)), FILES.addon.hash);
  assert.equal(sha256(path.join(target, FILES.config.targetName)), FILES.config.hash);
});

test('an unreviewed or wrong source is rejected before the target or bundle is touched', async t => {
  const fixture = makeFixture(t, { pinnedFixed: false });
  const bundleFile = path.join(fixture.root, 'bundle.json');
  const before = fs.readFileSync(bundleFile);
  assert.throws(() => prepare(path.join(PROJECT_ROOT, 'package.json'), { root: fixture.root }), /exact Chinese addon/);
  assert.equal(fs.existsSync(path.join(fixture.root, 'versions', VERSION)), false);
  assert.deepEqual(fs.readFileSync(bundleFile), before);
});

test('the later beta0.3.3.6 lightweight ZIP is not accepted as the r4 source', { skip: !fs.existsSync(BETA_036_ZIP) }, async () => {
  const fixture = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'manager-033r4-unreviewed-')) };
  try {
    assert.throws(() => loadSource(BETA_036_ZIP), /exact Chinese addon/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('entry contract keeps the PE version separate from the development build label', () => {
  assert.equal(ENTRY.id, '0.3.3-dev-r4');
  assert.equal(ENTRY.compatibility, null);
  assert.equal(ENTRY.ota, false);
  assert.match(ENTRY.source, /beta0\.3\.3-dev-r4@9085a4d67e32b8a6c83bc184b80ebe26b59c207d/);
  assert.match(ENTRY.label, /0\.3\.3-dev-r4/);
  assert.deepEqual(Object.keys(ENTRY).sort(), ['compatibility', 'id', 'label', 'notes', 'ota', 'source'].sort());
});
