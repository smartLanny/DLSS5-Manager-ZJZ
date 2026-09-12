'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createVulkanDeployment } = require('../src/product/vulkan-deployment');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-vulkan-deployment-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user'), sourceRoot = path.join(root, 'recipe'); fs.mkdirSync(sourceRoot);
  const manifest = path.join(sourceRoot, 'ReShade64.json'), library = path.join(sourceRoot, 'ReShade64.dll');
  fs.writeFileSync(library, 'synthetic x64 ReShade layer');
  fs.writeFileSync(manifest, JSON.stringify({ file_format_version: '1.2.0', layer: { name: 'VK_LAYER_reshade', type: 'GLOBAL', library_path: '.\\ReShade64.dll', disable_environment: { DISABLE_RESHADER: '1' } } }));
  const recipe = { version: 1, id: 'reshade-vulkan-test', release: '6.8.0-test', architecture: 64, sourceRoot,
    layer: { manifest: 'ReShade64.json', library: 'ReShade64.dll', manifestSha256: hash(manifest), librarySha256: hash(library), name: 'VK_LAYER_reshade' },
    activation: { interface: 'reshade-apps-v1' } };
  const reg = new Map(), activations = new Map(); let failRegistryWrite = false, failActivationWrite = false;
  const registry = {
    identity: { scope: 'HKCU', view: '64', key: 'Software\\XiaofengTests\\VulkanLayers' },
    async read(name) { const row = reg.get(name.toLowerCase()); return row ? { exists: row.exists, type: row.type, data: row.data } : { exists: false }; },
    async list() { return [...reg.entries()].map(([name, row]) => ({ name: row.name || name, type: row.type, data: row.data })); },
    async write(name, expected, desired) {
      if (failRegistryWrite) { failRegistryWrite = false; throw Object.assign(new Error('injected registry failure'), { code: 'ACCESS_DENIED' }); }
      const current = await this.read(name); assert.deepEqual(current, expected);
      if (desired.exists) reg.set(name.toLowerCase(), { ...structuredClone(desired), name }); else reg.delete(name.toLowerCase());
    }
  };
  const activation = {
    id: 'reshade-apps-v1',
    async read(exe) { return structuredClone(activations.get(exe.toLowerCase()) || { active: false, token: 'absent' }); },
    async write(exe, expected, desired) {
      if (failActivationWrite) { failActivationWrite = false; throw Object.assign(new Error('injected activation failure'), { code: 'WRITE_FAILED' }); }
      assert.deepEqual(await this.read(exe), expected); activations.set(exe.toLowerCase(), structuredClone(desired));
    }
  };
  const makeGame = id => { const exe = path.join(root, id, `${id}.exe`); fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, id); return { id, exe }; };
  const create = extra => createVulkanDeployment({ userData, registry, activation, pe: { getBitness: () => 64 }, inspectLaunchContext: async () => ({ elevated: false }), ...extra });
  return { root, userData, sourceRoot, manifest, library, recipe, registry, activation, reg, activations, makeGame, create,
    failRegistry() { failRegistryWrite = true; }, failActivation() { failActivationWrite = true; } };
}

test('owned x64 layer uses one global receipt and removes it only after the final EXE reference', async t => {
  const f = fixture(t), first = f.makeGame('first'), second = f.makeGame('second'), service = f.create();
  const a = await service.prepare(first, f.recipe); assert.equal(a.prepared, true); assert.equal(a.owned, true);
  const b = await service.prepare(second, f.recipe); assert.equal(b.refs, 2); assert.equal(f.reg.size, 1);
  assert.equal((await service.inspect(first)).ready, true); assert.equal((await service.inspect(second)).ready, true);
  const one = await service.restore(first); assert.equal(one.refs, 1); assert.equal(one.layerRemoved, false); assert.equal(f.reg.size, 1);
  assert.equal((await f.activation.read(first.exe)).active, false); assert.equal((await f.activation.read(second.exe)).active, true);
  const last = await service.restore(second); assert.equal(last.layerRemoved, true); assert.equal(f.reg.size, 0);
  assert.equal(fs.existsSync(service.receiptPath), false);
});

test('the same EXE has one reference even when callers use different game labels', async t => {
  const f = fixture(t), game = f.makeGame('same-exe'), service = f.create(); await service.prepare(game, f.recipe);
  const alias = { id: 'store-alias', exe: game.exe }; const duplicate = await service.prepare(alias, f.recipe);
  assert.equal(duplicate.unchanged, true); assert.equal(JSON.parse(fs.readFileSync(service.receiptPath, 'utf8')).refs.length, 1);
  const restored = await service.restore(alias); assert.equal(restored.layerRemoved, true);
  assert.equal((await f.activation.read(game.exe)).active, false); assert.equal(f.reg.size, 0);
});

test('last-reference restore removes owned files and receipt while preserving original activation bytes', async t => {
  const f = fixture(t), game = f.makeGame('game'), service = f.create();
  await service.prepare(game, f.recipe); const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8'));
  assert.equal(fs.existsSync(receipt.layer.manifest), true); assert.equal(fs.existsSync(receipt.layer.library), true);
  await service.restore(game);
  assert.equal(fs.existsSync(receipt.layer.manifest), false); assert.equal(fs.existsSync(receipt.layer.library), false);
  assert.equal(fs.existsSync(service.receiptPath), false); assert.deepEqual(await f.activation.read(game.exe), { active: false, token: 'absent' });
});

test('last restore leaves only an empty layer directory and a later prepare recreates it', async t => {
  const f = fixture(t), game = f.makeGame('retry-after-restore'), service = f.create();
  await service.prepare(game, f.recipe); await service.restore(game);
  const targetDir = path.join(f.userData, 'vulkan-deployment', 'layers', f.recipe.id);
  assert.equal(fs.existsSync(targetDir), true);
  assert.deepEqual(fs.readdirSync(targetDir), []);
  const retried = await service.prepare(game, f.recipe);
  assert.equal(retried.prepared, true); assert.equal(f.reg.size, 1);
  assert.equal(fs.existsSync(path.join(targetDir, f.recipe.layer.manifest)), true);
});

test('prepare never takes over a layer directory containing an external file', async t => {
  const f = fixture(t), game = f.makeGame('occupied-layer'), service = f.create();
  const targetDir = path.join(f.userData, 'vulkan-deployment', 'layers', f.recipe.id);
  fs.mkdirSync(targetDir, { recursive: true }); fs.writeFileSync(path.join(targetDir, 'foreign.txt'), 'keep me');
  await assert.rejects(service.prepare(game, f.recipe), { code: 'VULKAN_FILE_CHANGED' });
  assert.equal(fs.readFileSync(path.join(targetDir, 'foreign.txt'), 'utf8'), 'keep me');
  assert.equal(f.reg.size, 0); assert.equal(fs.existsSync(service.pendingPath), false);
});

test('external verified layer and pre-existing EXE activation are reused and never deleted', async t => {
  const f = fixture(t), game = f.makeGame('external-game');
  const externalRoot = path.join(f.root, 'external'); fs.mkdirSync(externalRoot); const externalManifest = path.join(externalRoot, 'ExternalReShade.json'), externalLibrary = path.join(externalRoot, 'ExternalReShade.dll');
  fs.writeFileSync(externalLibrary, 'external layer'); fs.writeFileSync(externalManifest, JSON.stringify({ layer: { name: 'VK_LAYER_reshade', library_path: '.\\ExternalReShade.dll', disable_environment: { DISABLE_RESHADER: '1' } } }));
  f.reg.set(externalManifest.toLowerCase(), { exists: true, name: externalManifest, type: 'REG_DWORD', data: 0 });
  f.activations.set(game.exe.toLowerCase(), { active: true, token: 'external-app-list-entry' });
  const service = f.create({ externalLayer: { verify: async ({ manifestPath }) => ({ valid: manifestPath === externalManifest, library: externalLibrary, identity: 'external-reshade' }) } });
  const result = await service.prepare(game, f.recipe); assert.equal(result.reused, true); assert.equal(f.reg.size, 1);
  const restored = await service.restore(game); assert.equal(restored.externalPreserved, true); assert.equal(f.reg.size, 1);
  assert.equal(fs.existsSync(externalManifest), true); assert.equal(fs.existsSync(externalLibrary), true);
  assert.deepEqual(await f.activation.read(game.exe), { active: true, token: 'external-app-list-entry' });
});

test('recipe hashes, x64 bitness, manifest shape and per-EXE activation interface are mandatory', async t => {
  const f = fixture(t), game = f.makeGame('bad-recipe');
  await assert.rejects(f.create({ inspectLaunchContext: async () => ({ elevated: true }) }).prepare(game, f.recipe), { code: 'VULKAN_ELEVATED_HKCU' });
  assert.equal(f.reg.size, 0);
  await assert.rejects(f.create({ pe: { getBitness: file => file === game.exe ? 64 : 32 } }).prepare(game, f.recipe), { code: 'VULKAN_RECIPE_ARCH' });
  await assert.rejects(f.create().prepare(game, { ...f.recipe, activation: { interface: 'unverified' } }), { code: 'VULKAN_RECIPE_INVALID' });
  await assert.rejects(f.create().prepare(game, { ...f.recipe, layer: { ...f.recipe.layer, library: path.join('subdir', 'ReShade64.dll') } }), { code: 'VULKAN_RECIPE_INVALID' });
  const originalManifest = fs.readFileSync(f.manifest);
  fs.writeFileSync(f.manifest, JSON.stringify({ file_format_version: '1.2.0', layer: { name: 'VK_LAYER_reshade', type: 'GLOBAL', library_path: 'subdir\\ReShade64.dll', disable_environment: { DISABLE_RESHADER: '1' } } }));
  await assert.rejects(f.create().prepare(game, { ...f.recipe, layer: { ...f.recipe.layer, manifestSha256: hash(f.manifest) } }), { code: 'VULKAN_RECIPE_INVALID' });
  fs.writeFileSync(f.manifest, originalManifest);
  fs.writeFileSync(f.library, 'changed'); await assert.rejects(f.create().prepare(game, f.recipe), { code: 'VULKAN_RECIPE_HASH' });
  assert.equal(fs.existsSync(path.join(f.userData, 'vulkan-deployment', 'receipt.json')), false);
});

test('registry failure leaves a strict pending record and recover rolls back copied files', async t => {
  const f = fixture(t), game = f.makeGame('registry-failure'), service = f.create(); f.failRegistry();
  await assert.rejects(service.prepare(game, f.recipe), error => error.code === 'ACCESS_DENIED' && error.details?.recoveryRequired === true);
  assert.equal(fs.existsSync(service.pendingPath), true); assert.equal((await service.inspect(game)).status, 'pending');
  const pending = JSON.parse(fs.readFileSync(service.pendingPath, 'utf8')), copied = pending.files.map(row => row.target); assert.ok(copied.every(fs.existsSync));
  assert.deepEqual(await service.recover(), { recovered: true, rolledBack: true }); assert.ok(copied.every(file => !fs.existsSync(file)));
  assert.equal(fs.existsSync(service.pendingPath), false); assert.equal(f.reg.size, 0);
});

test('activation failure recovers the already-written registry value without claiming success', async t => {
  const f = fixture(t), game = f.makeGame('activation-failure'), service = f.create(); f.failActivation();
  await assert.rejects(service.prepare(game, f.recipe), error => error.code === 'WRITE_FAILED' && error.details?.recoveryRequired === true);
  assert.equal(f.reg.size, 1); assert.equal(fs.existsSync(service.receiptPath), false);
  const result = await service.recover(); assert.equal(result.rolledBack, true); assert.equal(f.reg.size, 0); assert.equal(fs.existsSync(service.receiptPath), false);
});

test('prepare failure recovery leaves a clean target for the next prepare', async t => {
  const f = fixture(t), game = f.makeGame('retry-after-recovery'), service = f.create(); f.failRegistry();
  await assert.rejects(service.prepare(game, f.recipe), error => error.code === 'ACCESS_DENIED' && error.details?.recoveryRequired === true);
  assert.deepEqual(await service.recover(), { recovered: true, rolledBack: true });
  const retried = await service.prepare(game, f.recipe);
  assert.equal(retried.prepared, true); assert.equal(f.reg.size, 1);
});

test('prepare refuses to overwrite a file created between missing check and copy', async t => {
  const f = fixture(t), game = f.makeGame('copy-race'), service = f.create();
  const target = path.join(f.userData, 'vulkan-deployment', 'layers', f.recipe.id, f.recipe.layer.manifest);
  const originalCopyFile = fsp.copyFile; let raced = false;
  fsp.copyFile = async (source, destination, flags) => {
    if (!raced && path.resolve(destination).toLowerCase() === path.resolve(target).toLowerCase()) {
      raced = true; fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, 'external race');
    }
    return originalCopyFile.call(fsp, source, destination, flags);
  };
  try { await assert.rejects(service.prepare(game, f.recipe), { code: 'VULKAN_FILE_CHANGED' }); }
  finally { fsp.copyFile = originalCopyFile; }
  assert.equal(raced, true); assert.equal(fs.readFileSync(target, 'utf8'), 'external race');
  assert.equal(f.reg.size, 0); assert.equal(fs.existsSync(service.pendingPath), true);
  fs.unlinkSync(target); assert.deepEqual(await service.recover(), { recovered: true, rolledBack: true });
  assert.equal((await service.prepare(game, f.recipe)).prepared, true);
});

test('failed final-reference registry removal retains recovery data and restores EXE activation', async t => {
  const f = fixture(t), game = f.makeGame('restore-failure'), service = f.create(); await service.prepare(game, f.recipe); f.failRegistry();
  await assert.rejects(service.restore(game), error => error.code === 'ACCESS_DENIED' && error.details?.recoveryRequired === true);
  assert.equal(fs.existsSync(service.pendingPath), true); assert.equal((await f.activation.read(game.exe)).active, false, 'activation changed before the injected registry failure');
  const recovered = await service.recover(); assert.equal(recovered.rolledBack, true);
  assert.equal((await f.activation.read(game.exe)).active, true); assert.equal(f.reg.size, 1); assert.equal(fs.existsSync(service.receiptPath), true);
  assert.equal((await service.restore(game)).restored, true);
});

test('restore recovery recreates files before registry and EXE activation', async t => {
  const f = fixture(t), game = f.makeGame('ordered-recovery'), service = f.create(); await service.prepare(game, f.recipe);
  const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8')), ref = receipt.refs[0], transactionId = crypto.randomUUID();
  const backupRoot = path.join(f.userData, 'vulkan-deployment', 'recovery', transactionId); fs.mkdirSync(backupRoot, { recursive: true });
  const files = [[receipt.layer.manifest, receipt.recipe.manifestSha256], [receipt.layer.library, receipt.recipe.librarySha256]].map(([target, sha256]) => {
    const backup = path.join(backupRoot, path.basename(target)); fs.copyFileSync(target, backup); fs.unlinkSync(target);
    return { target, backup, before: { exists: true, sha256 }, after: { exists: false } };
  });
  f.reg.clear(); f.activations.set(game.exe.toLowerCase(), structuredClone(ref.activation.before));
  fs.writeFileSync(service.pendingPath, JSON.stringify({ version: 1, product: 'xiaofeng-vulkan-deployment', transactionId, operation: 'restore', stage: 'planned',
    beforeReceipt: receipt, targetReceipt: null, activation: { exe: game.exe, before: ref.activation.before, after: ref.activation.after },
    registry: { name: receipt.layer.manifest, before: receipt.layer.registryBefore, after: receipt.layer.registryAfter }, files }));
  const registryWrite = f.registry.write.bind(f.registry), activationWrite = f.activation.write.bind(f.activation);
  f.registry.write = async (...args) => { assert.ok(files.every(row => fs.existsSync(row.target)), 'files exist before registry is restored'); return registryWrite(...args); };
  f.activation.write = async (...args) => { assert.equal(f.reg.size, 1, 'registry exists before activation is restored'); return activationWrite(...args); };
  assert.deepEqual(await service.recover(), { recovered: true, rolledBack: true }); assert.equal((await service.inspect(game)).ready, true);
});

test('restore recovery refuses to overwrite an external file before re-registering the layer', async t => {
  const f = fixture(t), game = f.makeGame('changed-recovery'), service = f.create(); await service.prepare(game, f.recipe);
  const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8')), ref = receipt.refs[0], transactionId = crypto.randomUUID();
  const backupRoot = path.join(f.userData, 'vulkan-deployment', 'recovery', transactionId); fs.mkdirSync(backupRoot, { recursive: true });
  const files = [[receipt.layer.manifest, receipt.recipe.manifestSha256], [receipt.layer.library, receipt.recipe.librarySha256]].map(([target, sha256]) => {
    const backup = path.join(backupRoot, path.basename(target)); fs.copyFileSync(target, backup); fs.unlinkSync(target);
    return { target, backup, before: { exists: true, sha256 }, after: { exists: false } };
  });
  fs.writeFileSync(receipt.layer.library, 'external replacement after interrupted restore');
  f.reg.clear(); f.activations.set(game.exe.toLowerCase(), structuredClone(ref.activation.before));
  fs.writeFileSync(service.pendingPath, JSON.stringify({ version: 1, product: 'xiaofeng-vulkan-deployment', transactionId, operation: 'restore', stage: 'planned',
    beforeReceipt: receipt, targetReceipt: null, activation: { exe: game.exe, before: ref.activation.before, after: ref.activation.after },
    registry: { name: receipt.layer.manifest, before: receipt.layer.registryBefore, after: receipt.layer.registryAfter }, files }));
  await assert.rejects(service.recover(), { code: 'VULKAN_FILE_CHANGED' });
  assert.equal(fs.readFileSync(receipt.layer.library, 'utf8'), 'external replacement after interrupted restore');
  assert.equal(f.reg.size, 0); assert.equal((await f.activation.read(game.exe)).active, false);
});

test('corrupt receipt and pending state fail closed instead of becoming an empty reference list', async t => {
  const f = fixture(t), game = f.makeGame('corrupt'), service = f.create(); await service.prepare(game, f.recipe);
  fs.writeFileSync(service.receiptPath, '{bad'); await assert.rejects(service.inspect(game), { code: 'VULKAN_STATE_INVALID' });
  fs.writeFileSync(service.receiptPath, JSON.stringify({})); await assert.rejects(service.restore(game), { code: 'VULKAN_STATE_INVALID' });
  fs.writeFileSync(service.pendingPath, '{bad'); await assert.rejects(service.recover(), { code: 'VULKAN_STATE_INVALID' });
  assert.equal(f.reg.size, 1, 'invalid ownership state cannot remove the registered layer');
});

test('a pending record cannot inject registry state that is absent from its bound receipt', async t => {
  const f = fixture(t), game = f.makeGame('pending-injection'), service = f.create(); f.failActivation();
  await assert.rejects(service.prepare(game, f.recipe));
  const pending = JSON.parse(fs.readFileSync(service.pendingPath, 'utf8')); pending.registry.after.data = 1;
  fs.writeFileSync(service.pendingPath, JSON.stringify(pending));
  await assert.rejects(service.recover(), { code: 'VULKAN_STATE_INVALID' });
  assert.equal(f.reg.size, 1, 'tampered recovery state cannot change the registered value');
});

test('recover retains pending when prepare receipt matches but final files drift', async t => {
  const f = fixture(t), game = f.makeGame('recover-target-file-drift'), service = f.create(); await service.prepare(game, f.recipe);
  const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8'));
  fs.writeFileSync(receipt.layer.library, 'external final-state drift');
  fs.writeFileSync(service.pendingPath, JSON.stringify({ version: 1, product: 'xiaofeng-vulkan-deployment', transactionId: crypto.randomUUID(), operation: 'prepare', stage: 'committed', beforeReceipt: null, targetReceipt: receipt, files: [] }));
  await assert.rejects(service.recover(), { code: 'VULKAN_RECOVERY_BLOCKED' });
  assert.equal(fs.existsSync(service.pendingPath), true); assert.equal(f.reg.size, 1);
});

test('recover does not treat a deleted restore receipt as complete while registry and activation remain applied', async t => {
  const f = fixture(t), game = f.makeGame('recover-deleted-receipt'), service = f.create(); await service.prepare(game, f.recipe);
  const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8')), ref = receipt.refs[0], transactionId = crypto.randomUUID();
  const backupRoot = path.join(f.userData, 'vulkan-deployment', 'recovery', transactionId); fs.mkdirSync(backupRoot, { recursive: true });
  const files = [[receipt.layer.manifest, receipt.recipe.manifestSha256], [receipt.layer.library, receipt.recipe.librarySha256]].map(([target, sha256]) => {
    const backup = path.join(backupRoot, path.basename(target)); fs.copyFileSync(target, backup);
    return { target, backup, before: { exists: true, sha256 }, after: { exists: false } };
  });
  fs.writeFileSync(service.pendingPath, JSON.stringify({ version: 1, product: 'xiaofeng-vulkan-deployment', transactionId, operation: 'restore', stage: 'planned',
    beforeReceipt: receipt, targetReceipt: null, activation: { exe: game.exe, before: ref.activation.before, after: ref.activation.after },
    registry: { name: receipt.layer.manifest, before: receipt.layer.registryBefore, after: receipt.layer.registryAfter }, files }));
  fs.unlinkSync(service.receiptPath);
  await assert.rejects(service.recover(), { code: 'VULKAN_RECOVERY_BLOCKED' });
  assert.equal(fs.existsSync(service.pendingPath), true); assert.equal(f.reg.size, 1);
  assert.deepEqual(await f.activation.read(game.exe), ref.activation.after);
  assert.equal(fs.existsSync(receipt.layer.library), true);
});

test('registry CAS drift blocks restore and retains the receipt and layer files', async t => {
  const f = fixture(t), game = f.makeGame('registry-drift'), service = f.create(); await service.prepare(game, f.recipe);
  const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8'));
  f.reg.set(receipt.layer.manifest.toLowerCase(), { exists: true, name: receipt.layer.manifest, type: 'REG_DWORD', data: 1 });
  await assert.rejects(service.restore(game), { code: 'VULKAN_REGISTRY_CHANGED' });
  assert.equal(fs.existsSync(service.receiptPath), true); assert.equal(fs.existsSync(receipt.layer.library), true);
});

test('an existing owned layer must read back cleanly before another game reference is added', async t => {
  const f = fixture(t), first = f.makeGame('clean-first'), second = f.makeGame('blocked-second'), service = f.create();
  await service.prepare(first, f.recipe); const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8'));
  fs.writeFileSync(receipt.layer.library, 'external replacement');
  await assert.rejects(service.prepare(second, f.recipe), error => error.code === 'VULKAN_STATE_CHANGED' && error.details.blockers.some(row => /ReShade64\.dll/.test(row)));
  assert.equal(JSON.parse(fs.readFileSync(service.receiptPath, 'utf8')).refs.length, 1);
  assert.deepEqual(await f.activation.read(second.exe), { active: false, token: 'absent' });
});

test('process-wide lock rejects a concurrent mutation', async t => {
  const f = fixture(t), first = f.makeGame('lock-a'), second = f.makeGame('lock-b'); let release;
  const blocked = new Promise(resolve => { release = resolve; }); let entered;
  const activation = { ...f.activation, async write(exe, expected, desired) { entered?.(); await blocked; return f.activation.write(exe, expected, desired); } };
  const serviceA = f.create({ activation }), serviceB = f.create({ activation });
  const started = new Promise(resolve => { entered = resolve; }); const running = serviceA.prepare(first, f.recipe); await started;
  await assert.rejects(serviceB.prepare(second, f.recipe), { code: 'VULKAN_BUSY' }); release(); await running;
});

test('two independent processes cannot steal a dead-PID lock from each other', async t => {
  const f = fixture(t), game = f.makeGame('stale-lock'), service = f.create(); fs.mkdirSync(path.dirname(service.lockPath), { recursive: true });
  const stale = `${JSON.stringify({ version: 1, pid: 2147483647, nonce: 'stale-owner', createdAt: 1 })}\n`; fs.writeFileSync(service.lockPath, stale);
  const moduleFile = path.resolve(__dirname, '../src/product/vulkan-deployment.js');
  const script = `const {createVulkanDeployment}=require(${JSON.stringify(moduleFile)});const s=createVulkanDeployment({userData:${JSON.stringify(f.userData)},registry:{identity:{scope:'HKCU',view:'64',key:'Software\\\\XiaofengTests\\\\VulkanLayers'},read:async()=>({exists:false}),write:async()=>{},list:async()=>[]},activation:{id:'reshade-apps-v1',read:async()=>({active:false,token:'absent'}),write:async()=>{}},pe:{getBitness:()=>64}});s.inspect({id:'child',exe:${JSON.stringify(game.exe)}}).then(()=>console.log('unexpected')).catch(e=>console.log(e.code));`;
  const run = () => promisify(execFile)(process.execPath, ['-e', script], { windowsHide: true });
  const results = await Promise.all([run(), run()]); assert.deepEqual(results.map(row => row.stdout.trim()), ['VULKAN_STALE_LOCK', 'VULKAN_STALE_LOCK']);
  assert.equal(fs.readFileSync(service.lockPath, 'utf8'), stale);
});
