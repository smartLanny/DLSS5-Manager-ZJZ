'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../src/shared/core-catalog');
const { inspectPayload } = require('../src/product/payload');
const { readCorePackage } = require('../src/product/core-package');
const { createComponentLibrary } = require('../src/product/component-library');
const { zip, tempZip } = require('./helpers/ota-fixture');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const BETA13 = catalog.byId('0.5.2-beta13');
const FACE = require('../src/product/payload-companions').NAMES;

function temp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A v4 payload with the shared runtime, 0.4.7 and a Beta 13 slot (Core, chain, INI, faces; no paired model).
function payload(root) {
  const write = (rel, data) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return sha(data); };
  const fixed = {};
  for (const family of ['RTX40', 'RTX50']) fixed[family] = { files: {
    'ReShade64.dll': write(`fixed/${family}/ReShade64.dll`, 'reshade'), 'nrchain_nvngx.dll': write(`fixed/${family}/nrchain_nvngx.dll`, 'chain'),
    'nvngx_dlssnr.dll': write(`fixed/${family}/nvngx_dlssnr.dll`, `shared runtime ${family}`) } };
  const slot = (id, extra = {}) => ({ files: { 'nr-before-sr.zh-CN.addon64': write(`versions/${id}/nr-before-sr.zh-CN.addon64`, `core ${id}`),
    'nr_before_sr.ini': write(`versions/${id}/nr_before_sr.ini`, '[NRBeforeSR]\n'), ...extra } });
  const beta13 = slot(BETA13.id, { 'nrchain_nvngx.dll': write(`versions/${BETA13.id}/nrchain_nvngx.dll`, 'chain') });
  beta13.companions = Object.fromEntries(FACE.map(name => [name, write(`versions/${BETA13.id}/${name}`, `face ${name}`)]));
  fs.writeFileSync(path.join(root, 'bundle.json'), JSON.stringify({ version: 4, defaultVersion: BETA13.id, fixed,
    versions: { '0.4.7beta': slot('0.4.7beta'), [BETA13.id]: beta13 } }));
  return root;
}

test('Beta 13 runs on the shared runtime and prefers the imported model paired for this GPU series', t => {
  const dir = payload(temp(t, 'paired-payload-'));
  const runtime = result => result.files.find(row => row.kind === 'runtime');
  const inspect = (series, version = BETA13.id) =>
    inspectPayload(dir, { hardwareFamily: series === 'RTX50' ? 'RTX50' : 'RTX40', hardwareSeries: series, version, selectedOnly: true });
  for (const [series, variant] of [['RTX50', 'RTX40-50'], ['RTX40', 'RTX40-50'], ['RTX30', 'RTX20-30'], ['RTX20', 'RTX20-30']]) {
    const family = series === 'RTX50' ? 'RTX50' : 'RTX40', result = inspect(series);
    assert.equal(result.ready, true, `${series}: no paired model imported, the shared runtime is used`);
    assert.equal(result.versions[BETA13.id].runtimeSource, 'shared');
    assert.equal(result.versions[BETA13.id].pairedRuntime.variant, variant, 'the optional upgrade is still named');
    assert.equal(runtime(result).actual, sha(`shared runtime ${family}`));
    assert.equal(path.relative(dir, runtime(result).file), path.join('fixed', family, 'nvngx_dlssnr.dll'));
  }
  const unknown = inspect(null);
  assert.equal(unknown.ready, true); assert.equal(unknown.versions[BETA13.id].pairedRuntime, null);
  assert.equal(inspect('RTX30', '0.4.7beta').versions['0.4.7beta'].runtimeSource, undefined, 'older Cores have no paired model');
});

test('an imported paired model is used only when its digest matches this GPU series', t => {
  const dir = payload(temp(t, 'paired-present-'));
  const model = path.join(dir, 'versions', BETA13.id, 'nvngx_dlssnr.dll'); fs.writeFileSync(model, 'not the cataloged model');
  const result = inspectPayload(dir, { hardwareFamily: 'RTX40', hardwareSeries: 'RTX40', version: BETA13.id, selectedOnly: true });
  const runtime = result.files.find(row => row.kind === 'runtime');
  assert.equal(result.versions[BETA13.id].runtimeSource, 'paired');
  assert.equal(path.relative(dir, runtime.file), path.join('versions', BETA13.id, 'nvngx_dlssnr.dll'));
  assert.equal(runtime.expected, BETA13.packages['RTX40-50'].runtime, 'a tampered paired model is reported, never deployed');
  assert.equal(result.ready, false); assert.deepEqual(result.invalid, ['nvngx_dlssnr.dll']);
});

test('a ZIP with the package layout but an unregistered digest is refused', async t => {
  const file = zip(tempZip(), [{ name: 'manifest.json', data: JSON.stringify({ schema: 'dlss5-local-two-runtime-handoff/v1' }) },
    { name: 'install/nr-before-sr.zh-CN.addon64', data: 'core' }, { name: 'install/nvngx_dlssnr.dll', data: 'model' }]);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const out = path.join(temp(t, 'package-out-'), 'nvngx_dlssnr.dll');
  await assert.rejects(readCorePackage(file, { runtimeFile: out }), /未在 src\/shared\/core-catalog\.js 登记/);
  assert.equal(fs.existsSync(out), false);
});

// Real files: DLSS5_TEST_CORE_PACKAGE_DIR=<folder with both Beta 13 ZIPs>. Never committed.
const realDir = process.env.DLSS5_TEST_CORE_PACKAGE_DIR;
const skip = !realDir && '设置 DLSS5_TEST_CORE_PACKAGE_DIR 指向两个 Beta 13 ZIP 所在目录才运行';
const realFile = variant => path.join(realDir, `DLSS5-${BETA13.displayVersion}-${variant}.zip`);

test('the delivered Beta 13 packages match the catalog and stream their model to disk', { skip }, async t => {
  for (const variant of ['RTX40-50', 'RTX20-30']) {
    const out = path.join(temp(t, 'package-real-'), 'nvngx_dlssnr.dll');
    const pkg = await readCorePackage(realFile(variant), { runtimeFile: out });
    assert.equal(pkg.variant, variant); assert.equal(pkg.core.id, BETA13.id);
    assert.equal(pkg.addonSha256, BETA13.addon['zh-CN']); assert.equal(pkg.bridgeSha256, BETA13.chain);
    assert.equal(pkg.companions.length, FACE.length);
    assert.equal(sha(fs.readFileSync(out)), BETA13.packages[variant].runtime);
    const staging = await readCorePackage(realFile(variant));
    assert.equal(staging.runtime.file, null, 'without a target the model is not extracted');
  }
});

test('importing a Beta 13 package pairs its model with Beta 13 only', { skip }, async t => {
  const userData = temp(t, 'paired-library-'), bundled = payload(path.join(userData, 'bundled'));
  let series = 'RTX30';
  const library = createComponentLibrary({ userData, hardwareSeries: () => series });
  const imported = await library.importComponent(realFile('RTX20-30'));
  assert.deepEqual(imported.packages.map(row => row.id), ['nr-runtime-beta13-rtx20-30']);
  assert.deepEqual(imported.packages[0].hardwareSeries, ['RTX20', 'RTX30']);
  const activated = await library.activateRuntime('nr-runtime-beta13-rtx20-30', bundled);
  const inventory = await library.inventory();
  assert.equal(inventory.selected.RTX40, undefined, 'the shared runtime for older Cores is untouched');
  const inspect = (version, value) => inspectPayload(activated.payloadDir, { hardwareFamily: 'RTX40', hardwareSeries: value, version, selectedOnly: true });
  assert.equal(inspect(BETA13.id, 'RTX30').ready, true);
  assert.equal(inspect('0.4.7beta', 'RTX30').files.find(row => row.kind === 'runtime').actual, sha('shared runtime RTX40'));
  series = 'RTX40';
  await library.activateRuntime('nr-runtime-beta13-rtx20-30', bundled);
  const rtx40 = inspect(BETA13.id, 'RTX40');
  assert.equal(rtx40.ready, true); assert.equal(rtx40.versions[BETA13.id].runtimeSource, 'shared', 'an RTX 40 card never receives the RTX 20/30 model');
});
