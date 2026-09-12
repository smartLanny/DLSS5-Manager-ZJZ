'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ARCHIVE_SHA256, ENTRY, FILES, SOURCE, loadSource, prepare
} = require('../scripts/prepare-release-042');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REAL_ZIP = path.resolve(PROJECT_ROOT, '..', '交付', 'beta0.4.2-完整压缩包',
  'DLSS5-beta0.4.2-RTX50-中文完整包.zip');
const EXPERIMENT_ZIP = path.resolve(PROJECT_ROOT, '..', 'deliveries',
  'beta0.4.2-native-bridge-exp1-r1', 'beta0.4.2-DX11兼容-exp1-windows-x64.zip');
const FIXED_BRIDGE = '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb';

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-042-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'versions'), { recursive: true });
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(root, 'fixed', family);
    fs.mkdirSync(fixed, { recursive: true });
    fs.copyFileSync(
      path.join(PROJECT_ROOT, 'payload', 'nr-before-sr', 'fixed', family, 'nrchain_nvngx.dll'),
      path.join(fixed, 'nrchain_nvngx.dll')
    );
  }
  const keep = {
    '0.3.3.5': {
      label: 'keep 0.3.3.5', notes: 'keep notes', source: 'keep source',
      compatibility: null, ota: false, files: { 'nr-before-sr.zh-CN.addon64': 'old-addon', 'nr_before_sr.ini': 'old-ini' }
    },
    '0.4.6-hotfix.1': {
      label: 'keep latest', notes: 'keep latest notes', source: 'keep latest source',
      compatibility: 'dx11', ota: true, files: { 'nr-before-sr.zh-CN.addon64': 'latest-addon', 'nr_before_sr.ini': 'latest-ini' }
    }
  };
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({
    version: 4,
    generatedAt: '2026-09-07T23:23:19.537Z',
    defaultVersion: '0.4.6-hotfix.1',
    fixed: {
      RTX40: { files: { 'nrchain_nvngx.dll': FIXED_BRIDGE } },
      RTX50: { files: { 'nrchain_nvngx.dll': FIXED_BRIDGE } }
    },
    versions: keep
  }, null, 2) + '\n');
  return { root, keep };
}

test('real beta0.4.2 Chinese ZIP is paired, D3D12-only, carrier-free, and idempotent',
  { skip: !fs.existsSync(REAL_ZIP) }, async t => {
    const source = await loadSource(REAL_ZIP);
    assert.equal(source.archiveHash, ARCHIVE_SHA256.RTX50);
    assert.equal(source.family, 'RTX50');
    assert.equal(SOURCE, '15909ef10914fcdf151ee193460451667fbf31dc');
    assert.equal(source.files.addon.length, FILES.addon.bytes);
    assert.equal(source.files.config.length, FILES.config.bytes);
    assert.equal(source.files.bridge.length, FILES.bridge.bytes);

    const fixture = makeFixture(t);
    await prepare(REAL_ZIP, { root: fixture.root });
    const firstBundle = fs.readFileSync(path.join(fixture.root, 'bundle.json'), 'utf8');
    const bundle = JSON.parse(firstBundle);
    assert.deepEqual(bundle.versions['0.3.3.5'], fixture.keep['0.3.3.5']);
    assert.deepEqual(bundle.versions['0.4.6-hotfix.1'], fixture.keep['0.4.6-hotfix.1']);
    assert.equal(bundle.defaultVersion, '0.4.6-hotfix.1');
    assert.equal(bundle.versions['0.4.2'].compatibility, null);
    assert.equal(bundle.versions['0.4.2'].ota, false);
    assert.match(bundle.versions['0.4.2'].label, /Beta.*D3D12/);
    assert.match(bundle.versions['0.4.2'].notes, /D3D12/);
    assert.match(bundle.versions['0.4.2'].notes, /carrier/);
    assert.deepEqual(Object.keys(bundle.versions['0.4.2'].files).sort(), [
      'nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini'
    ]);
    const target = path.join(fixture.root, 'versions', '0.4.2');
    assert.equal(fs.existsSync(path.join(target, 'nrchain_nvngx.dll')), false);
    assert.equal(fs.existsSync(path.join(target, 'dlss5-native-carrier-exp1.addon64')), false);

    await prepare(REAL_ZIP, { root: fixture.root });
    assert.equal(fs.readFileSync(path.join(fixture.root, 'bundle.json'), 'utf8'), firstBundle);

    if (fs.existsSync(EXPERIMENT_ZIP)) {
      const beforeRejected = fs.readFileSync(path.join(fixture.root, 'bundle.json'));
      await assert.rejects(prepare(EXPERIMENT_ZIP, { root: fixture.root }), /unreviewed beta0\.4\.2 source ZIP/);
      assert.deepEqual(fs.readFileSync(path.join(fixture.root, 'bundle.json')), beforeRejected);
    }
  });

test('ordinary validation fixture rejects an unreviewed source before writing', async t => {
  const fixture = makeFixture(t);
  await assert.rejects(prepare(path.join(PROJECT_ROOT, 'package.json'), { root: fixture.root }),
    /unreviewed beta0\.4\.2 source ZIP/);
  assert.equal(fs.existsSync(path.join(fixture.root, 'versions', '0.4.2')), false);
  assert.equal(fs.readFileSync(path.join(fixture.root, 'bundle.json'), 'utf8').includes('"0.4.2"'), false);
});

test('entry contract keeps the ordinary 0.4.2 source distinct from the DX11 experiment', () => {
  assert.equal(ENTRY.id, '0.4.2');
  assert.equal(ENTRY.compatibility, null);
  assert.equal(ENTRY.ota, false);
  assert.equal(FILES.bridge.targetName, null);
  assert.match(ENTRY.source, new RegExp(SOURCE));
  assert.match(ENTRY.notes, /不配旧 native-bridge-exp1 carrier/);
});
