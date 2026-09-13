'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCompactBundle, sha256 } = require('../src/product/payload');
const { PAYLOAD_FILES, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const { rebuildBundle, main } = require('../scripts/verify-payload');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-rebuild-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function put(dir, rel, contents = rel) {
  const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file;
}
function store(dir, bundle) { put(dir, 'bundle.json', `${JSON.stringify(bundle, null, 2)}\n`); }
function fixture(t) {
  const dir = temporary(t);
  for (const family of ['RTX40', 'RTX50']) for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) put(dir, `fixed/${family}/${name}`);
  const ids = ['0.2.0-beta.2', '0.3.3.5', '0.4.2', '0.4.2-dx11-native-bridge-exp1-r1', 'custom-reviewed', '0.4.5-ota', '0.4.6-hotfix.1'];
  for (const id of ids) for (const name of [PAYLOAD_FILES.addon, PAYLOAD_FILES.config]) put(dir, `versions/${id}/${name}`);
  for (const id of ['custom-reviewed', '0.4.5-ota', '0.4.6-hotfix.1']) for (const name of [PAYLOAD_FILES.bridge, DX11_COMPAT_CARRIER]) put(dir, `versions/${id}/${name}`);
  const bundle = createCompactBundle(dir, ids.map(id => ({ id, label: `reviewed ${id}`, notes: `paired notes ${id}`, source: `original source ${id}`, compatibility: ['custom-reviewed', '0.4.5-ota', '0.4.6-hotfix.1'].includes(id) ? 'dx11' : null })), '0.4.6-hotfix.1');
  const companion = put(dir, 'versions/custom-reviewed/reviewed-helper.dll');
  bundle.versions['custom-reviewed'].files['reviewed-helper.dll'] = sha256(companion);
  bundle.versions['0.4.2'].review = { provenance: 'regular D3D12 historical release', untouched: true };
  bundle.versions['0.4.2-dx11-native-bridge-exp1-r1'].review = { provenance: 'different experimental release' };
  bundle.supersededVersions = { '0.4.6': '0.4.6-hotfix.1' };
  bundle.catalogNote = 'preserve the reviewed catalog';
  store(dir, bundle);
  return { dir, bundle };
}

test('rebuilding preserves validated 0.2, 0.3, regular 0.4.2 and custom metadata without promoting directory names', t => {
  const { dir, bundle } = fixture(t);
  const unknown = put(dir, 'versions/unreviewed-history/keep.txt', 'unreviewed');
  const retired = put(dir, 'versions/0.4.6/unrelated.txt', 'retired unlisted directory');
  put(dir, 'versions/0.4.5/unrelated.txt', 'unlisted older slot');
  assert.deepEqual(rebuildBundle(dir), bundle);
  const result = main(['--write', '--dir', dir], () => {});
  assert.deepEqual(result.bundle, bundle);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8')), bundle);
  assert.notEqual(result.bundle.versions['0.4.2'].source, result.bundle.versions['0.4.2-dx11-native-bridge-exp1-r1'].source);
  assert.equal(result.bundle.versions['unreviewed-history'], undefined);
  assert.equal(result.bundle.versions['0.4.6'], undefined, 'retired directories are not reintroduced into the catalog');
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'unreviewed');
  assert.equal(fs.readFileSync(retired, 'utf8'), 'retired unlisted directory');
  assert.ok(fs.existsSync(path.join(dir, 'versions/0.4.2-dx11-native-bridge-exp1-r1', PAYLOAD_FILES.addon)));
});

test('CLI writes only the explicit temporary root and keeps its complete historical manifest', t => {
  const { dir, bundle } = fixture(t);
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/verify-payload.js'), '--write', '--dir', dir], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8')), bundle);
  assert.ok(result.stdout.includes(path.join(dir, 'bundle.json')));
});

test('changed historical core or fixed runtime cannot receive a newly stamped hash', t => {
  for (const rel of [`versions/0.4.2/${PAYLOAD_FILES.addon}`, 'fixed/RTX40/nvngx_dlssnr.dll']) {
    const { dir } = fixture(t), manifest = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
    put(dir, rel, 'hash drift');
    assert.throws(() => main(['--write', '--dir', dir], () => {}), /verification|hash/i);
    assert.equal(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'), manifest);
    assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), 'hash drift');
  }
});

test('declared extra companions and DX11 pairs must survive before metadata is retained', t => {
  for (const rel of ['versions/custom-reviewed/reviewed-helper.dll', `versions/custom-reviewed/${DX11_COMPAT_CARRIER}`]) {
    const { dir } = fixture(t), manifest = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
    put(dir, rel, 'unreviewed replacement');
    assert.throws(() => main(['--write', '--dir', dir], () => {}), /verification|hash/i);
    assert.equal(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'), manifest);
  }
  const { dir, bundle } = fixture(t);
  delete bundle.versions['custom-reviewed'].files[DX11_COMPAT_CARRIER]; store(dir, bundle);
  const before = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
  assert.throws(() => main(['--write', '--dir', dir], () => {}), /DX11.*recorded/);
  assert.equal(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'), before);
});

test('missing or linked historical files do not rewrite the original manifest', t => {
  for (const kind of ['missing', 'linked']) {
    const { dir } = fixture(t), manifest = fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8');
    const version = path.join(dir, 'versions/0.4.2');
    if (kind === 'missing') fs.unlinkSync(path.join(version, PAYLOAD_FILES.config));
    else {
      const moved = path.join(dir, 'original-042'); fs.renameSync(version, moved);
      fs.symlinkSync(moved, version, process.platform === 'win32' ? 'junction' : 'dir');
    }
    assert.throws(() => main(['--write', '--dir', dir], () => {}));
    assert.equal(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'), manifest);
  }
});

test('absent or invalid old manifests never turn arbitrary historical directories into catalog entries', t => {
  const dir = temporary(t);
  for (const name of Object.values(PAYLOAD_FILES)) put(dir, name);
  put(dir, `versions/0.4.2/${PAYLOAD_FILES.addon}`, 'unreviewed historical-looking bytes');
  put(dir, `versions/0.4.2/${PAYLOAD_FILES.config}`);
  const built = rebuildBundle(dir);
  assert.equal(built.version, 1); assert.equal(built.versions, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'bundle.json')), false, 'pure reconstruction does not create a manifest');
  put(dir, 'bundle.json', '{invalid old manifest');
  assert.throws(() => main(['--write', '--dir', dir], () => {}));
  assert.equal(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8'), '{invalid old manifest');
  assert.equal(fs.readFileSync(path.join(dir, `versions/0.4.2/${PAYLOAD_FILES.addon}`), 'utf8'), 'unreviewed historical-looking bytes');
});
