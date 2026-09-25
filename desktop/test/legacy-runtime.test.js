'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createLegacyRuntime } = require('../src/product/legacy-runtime');
const { fingerprint } = require('../src/product/feeder-runtime');
const runtime = createLegacyRuntime({ appDir: path.resolve(__dirname, '..') });

test('missing packaged legacy metadata reports a missing component and forged metadata remains untrusted', t => {
  const fs = require('node:fs'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-package-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = createLegacyRuntime({ root }), selection = { api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'hoyoshade' };
  assert.throws(() => local.load(selection), { code: 'LEGACY_PACKAGE_MISSING' });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ schema: 1, assets: [] }));
  assert.throws(() => local.load(selection), { code: 'LEGACY_PACKAGE_UNTRUSTED' });
});

test('legacy host recipes keep the x86 provider separate from x64 Core and runtime', () => {
  const pkg = runtime.load({ api: 'dx11', architecture: 'x86', hardwareFamily: 'RTX40' });
  assert.equal(pkg.recipe.schema, 2); assert.equal(pkg.recipe.hostRequired, true);
  const file = role => pkg.recipe.files.find(row => row.role === role);
  assert.equal(file('provider').architecture, 'x86'); assert.equal(file('provider').target, 'dlss5-feed.addon32');
  assert.equal(file('core').architecture, 'x64'); assert.ok(file('core').target.startsWith('host64/addons/'));
  assert.equal(file('nr-runtime').target, 'host64/addons/nvngx_dlssnr.dll');
  assert.equal(pkg.recipe.srInjected, false); assert.equal(pkg.recipe.fgInjected, false);
});

test('both D3D10 architectures use the shared-texture host route without an external wrapper', () => {
  for (const architecture of ['x86', 'x64']) {
    const pkg = runtime.load({ api: 'dx10', architecture, hardwareFamily: 'RTX50' });
    assert.equal(pkg.recipe.hostRequired, true); assert.equal(pkg.recipe.wrapper, null);
    assert.equal(pkg.recipe.files.find(row => row.role === 'provider').id, architecture === 'x86' ? 'provider-x86' : 'provider-relay-x64');
  }
});

test('HoYo package delegates its loader and keeps runtime choices independently pinned', () => {
  const load = hardwareFamily => runtime.load({ api: 'dx12', architecture: 'x64', hardwareFamily, loadingBackend: 'hoyoshade' });
  const a = load('RTX40'), b = load('RTX50');
  assert.ok(a.recipe.files.every(row => row.role !== 'game-loader'));
  assert.equal(a.recipe.files.find(row => row.role === 'core').sha256, b.recipe.files.find(row => row.role === 'core').sha256);
  assert.notEqual(a.recipe.files.find(row => row.role === 'nr-runtime').sha256, b.recipe.files.find(row => row.role === 'nr-runtime').sha256);
  assert.equal(a.recipe.coreVersion, b.recipe.coreVersion); assert.equal(a.recipe.coreVariant.genericCoreInterchangeable, false);
});

test('a receipt cannot replace the fixed Core or downgrade its variant identity', () => {
  const pkg = runtime.load({ api: 'dx12', architecture: 'x64', hardwareFamily: 'RTX50' });
  assert.equal(fingerprint(runtime.validate(pkg.recipe)), pkg.fingerprint);
  const changed = structuredClone(pkg.recipe); changed.files.find(row => row.role === 'core').sha256 = 'a'.repeat(64);
  assert.throws(() => runtime.validate(changed), { code: 'LEGACY_RECEIPT_INVALID' });
  const downgraded = structuredClone(pkg.recipe); downgraded.coreVariant.requiredInterface = null;
  assert.throws(() => runtime.validate(downgraded), { code: 'LEGACY_RECEIPT_INVALID' });
});

test('DX9 uses only the source-owned shim and Windows runtime, with an x64 host for both architectures', () => {
  for (const architecture of ['x86', 'x64']) {
    const recipe = runtime.load({ api: 'dx9', architecture, hardwareFamily: 'RTX50' }).recipe;
    assert.equal(recipe.hostRequired, true); assert.equal(recipe.wrapper.privateRuntimeBundled, false);
    assert.equal(recipe.files.find(row => row.role === 'api-wrapper').target, 'd3d9.dll');
    assert.ok(recipe.files.every(row => !/dgvoodoo/i.test(row.source)));
    assert.equal(recipe.files.find(row => row.role === 'game-loader').base, 'runtime');
  }
});

test('code-pinned receipts remain restorable with their resource pool absent', () => {
  const pkg = runtime.load({ api: 'dx10', architecture: 'x86', hardwareFamily: 'RTX40' });
  const offline = createLegacyRuntime({ appDir: path.resolve(__dirname, '..'), root: path.join(__dirname, 'missing-legacy-pool'), lock: runtime.lock });
  assert.equal(offline.validateStored(pkg.recipe), pkg.recipe);
  const forged = structuredClone(pkg.recipe); forged.files[0].target = '../outside.dll';
  assert.throws(() => offline.validateStored(forged));
  const changed = structuredClone(pkg.recipe); changed.selection.hardwareFamily = 'RTX50';
  assert.throws(() => offline.validateStored(changed));
});
test('adapter inventory exposes only the pinned host and fixed read-only argument', () => {
  const probe = runtime.adapterProbe();
  const host = runtime.load({ api: 'dx10', architecture: 'x86', hardwareFamily: 'RTX50' }).recipe.files.find(row => row.role === 'host');
  assert.equal(probe.sha256, host.sha256); assert.equal(probe.file, path.join(runtime.root, host.source));
  assert.deepEqual(probe.args, ['--list-adapters-json']); assert.ok(Object.isFrozen(probe) && Object.isFrozen(probe.args));
});

test('repair verifies every historical pinned byte even when the current pool identity differs', async t => {
  const fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pinned-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = runtime.load({ api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50' });
  const recipe = structuredClone(pkg.recipe);
  recipe.poolFingerprint = 'a'.repeat(64);
  // Small inert bytes exercise file validation without distributing runtime DLLs.
  for (const item of recipe.files) {
    const bytes = Buffer.from(item.source);
    item.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); item.bytes = bytes.length;
    const file = path.join(root, item.source); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const pinned = createLegacyRuntime({ root, lock: { ...runtime.lock, restorableRecipeFingerprints: [fingerprint(recipe)] },
    pe: { getBitness: () => 64 } });
  assert.equal((await pinned.verify({ root, recipe })).recipe, recipe);
  const file = path.join(root, recipe.files[0].source); fs.appendFileSync(file, 'changed');
  await assert.rejects(pinned.verify({ root, recipe }), { code: 'LEGACY_PACKAGE_HASH' });
  fs.unlinkSync(file);
  await assert.rejects(pinned.verify({ root, recipe }));
});

test('thin legacy recipes reuse only the exact NR DLC and reject altered, wrong-family or non-runtime substitutions', async t => {
  const fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-shared-runtime-')), pool = path.join(root, 'pool'), library = path.join(root, 'library');
  fs.mkdirSync(pool); fs.mkdirSync(library); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const recipe = structuredClone(runtime.load({ api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'hoyoshade' }).recipe);
  let shared;
  for (const item of recipe.files) {
    const bytes = Buffer.from(item.source); item.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); item.bytes = bytes.length;
    const file = item.role === 'nr-runtime' ? path.join(library, 'objects/runtime.dll') : path.join(pool, item.source);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    if (item.role === 'nr-runtime') shared = { file: 'objects/runtime.dll', bytes: item.bytes, sha256: item.sha256, family: 'RTX50' };
  }
  const pinned = createLegacyRuntime({ root: pool, componentLibraryRoot: library, getCurrentRuntime: () => shared,
    lock: { ...runtime.lock, restorableRecipeFingerprints: [fingerprint(recipe)] }, pe: { getBitness: () => 64 } });
  const value = { root: pool, recipe, fingerprint: fingerprint(recipe) }, item = recipe.files.find(row => row.role === 'nr-runtime');
  assert.equal((await pinned.verify(value)).sources[item.source], path.join(library, shared.file));
  assert.equal(recipe.files.find(row => row.role === 'nr-runtime').source, item.source, 'receipt identity stays independent of the source location');
  shared.family = 'RTX40'; await assert.rejects(pinned.verify(value)); shared.family = 'RTX50';
  const source = path.join(library, shared.file), bytes = fs.readFileSync(source); fs.appendFileSync(source, 'changed');
  await assert.rejects(pinned.verify(value), { code: 'LEGACY_PACKAGE_HASH' }); fs.writeFileSync(source, bytes);
  const badPool = path.join(pool, item.source); fs.mkdirSync(path.dirname(badPool), { recursive: true }); fs.writeFileSync(badPool, 'corrupted pool runtime');
  await assert.rejects(pinned.verify(value), { code: 'LEGACY_PACKAGE_HASH' }); fs.unlinkSync(badPool);
  const provider = recipe.files.find(row => row.role === 'provider'); fs.unlinkSync(path.join(pool, provider.source));
  await assert.rejects(pinned.verify(value), 'missing Provider bytes cannot be borrowed from the runtime DLC');
});
