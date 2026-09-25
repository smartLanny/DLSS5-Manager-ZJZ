'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildLegacyRuntime } = require('../scripts/stage-manager-distribution.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-stage-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stageRoot: path.join(root, 'stage'), manifestFile: path.join(root, 'staging.json'), manifest: {} };
}

test('omitting the optional legacy pool preserves ordinary and native HoYo packaging without claiming Feeder readiness', async t => {
  const input = fixture(t), report = await buildLegacyRuntime(input);
  assert.equal(report.declared, false); assert.equal(report.bundled, false); assert.equal(report.ready, false);
  assert.equal(report.status, 'not-bundled'); assert.deepEqual(report.files, []);
  assert.match(report.reason, /Feeder/); assert.match(report.reason, /HoYo/);
  assert.equal(fs.existsSync(input.stageRoot), false, 'an absent optional pool creates no placeholder payload');
  const runtime = require('../src/product/legacy-runtime').createLegacyRuntime({ root: path.join(input.stageRoot, 'resources/legacy-runtime') });
  assert.throws(() => runtime.load({ api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'hoyoshade' }),
    { code: 'LEGACY_PACKAGE_MISSING' }, 'omission does not authorize a missing Feeder route at runtime');
});

test('an explicitly declared legacy pool must have a valid root and its original pinned manifest', async t => {
  const input = fixture(t), { root } = input;
  for (const invalid of [null, {}, { root: '' }]) {
    input.manifest.legacyRuntime = invalid;
    await assert.rejects(buildLegacyRuntime(input), /legacyRuntime.root/);
  }
  input.manifest.legacyRuntime = { root: path.join(root, 'pool') }; fs.mkdirSync(input.manifest.legacyRuntime.root);
  await assert.rejects(buildLegacyRuntime(input), { code: 'LEGACY_PACKAGE_MISSING' });
  fs.writeFileSync(path.join(input.manifest.legacyRuntime.root, 'manifest.json'), JSON.stringify({ schema: 1, assets: [] }));
  await assert.rejects(buildLegacyRuntime(input), { code: 'LEGACY_PACKAGE_UNTRUSTED' });
  assert.equal(fs.existsSync(input.stageRoot), false);
});

test('declaring the authentic legacy manifest still rejects missing files and same-size changed payload bytes', async t => {
  const input = fixture(t), pool = path.join(input.root, 'pool'); fs.mkdirSync(pool);
  input.manifest.legacyRuntime = { root: pool };
  fs.copyFileSync(path.resolve(__dirname, '../resources/legacy-runtime/manifest.json'), path.join(pool, 'manifest.json'));
  await assert.rejects(buildLegacyRuntime(input), /不存在/);
  const catalog = require('../src/product/legacy-runtime-catalog'), selection = catalog.list()[0];
  const runtime = require('../src/product/legacy-runtime').createLegacyRuntime({ root: pool });
  const first = runtime.load({ api: selection.gameApi, architecture: selection.architecture,
    hardwareFamily: selection.hardwareFamily, loadingBackend: selection.loadingBackend }).recipe.files[0];
  const file = path.join(pool, first.source); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(first.bytes));
  await assert.rejects(buildLegacyRuntime(input), /SHA-256 不符/);
  assert.equal(fs.existsSync(input.stageRoot), false, 'unverified bytes never enter the stage');
});
