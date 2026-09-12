'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createVulkanService } = require('../src/product/vulkan-service');
const { createVulkanRuntimeProfile } = require('../src/product/vulkan-runtime-profile');
const { createReshadeVulkanActivation } = require('../src/product/reshade-vulkan-activation');
const { atomicJson } = require('../src/product/launch-safety');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-vulkan-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, options.userFolder || 'user'), appDir = path.join(root, 'app'), resourcesPath = path.join(root, 'resources');
  const runtimeRoot = path.join(resourcesPath, 'vulkan-runtime'), layerRoot = path.join(resourcesPath, 'vulkan-reshade');
  fs.mkdirSync(runtimeRoot, { recursive: true }); fs.mkdirSync(layerRoot, { recursive: true });
  const bindingPath = path.join(userData, 'vulkan-bindings.json');
  const runtime = { version: 1, id: 'nr-vulkan-e7df0fc', coreVersion: '0.4.6-hotfix.1-vulkan', sourceRevision: 'e7df0fc', architecture: 64,
    acceptance: { status: 'processed', hardwareFamily: 'RTX50' }, files: [
      { source: 'core.addon64', target: 'core.addon64', sha256: hash('pe64-core'), mutable: false },
      { source: 'nr_before_sr.ini', target: 'nr_before_sr.ini', sha256: hash('[NRBeforeSR]\nEnabled=1\n'), mutable: true }
    ] };
  fs.writeFileSync(path.join(runtimeRoot, 'core.addon64'), 'pe64-core');
  fs.writeFileSync(path.join(runtimeRoot, 'nr_before_sr.ini'), '[NRBeforeSR]\nEnabled=1\n');
  const manifest = JSON.stringify({ file_format_version: '1.2.0', layer: { name: 'VK_LAYER_reshade', type: 'GLOBAL', library_path: '.\\ReShade64.dll', disable_environment: { DISABLE_RESHADER: '1' } } });
  fs.writeFileSync(path.join(layerRoot, 'ReShade64.dll'), 'pe64-layer'); fs.writeFileSync(path.join(layerRoot, 'ReShade64.json'), manifest);
  const layer = { version: 1, id: 'reshade-vulkan-6.8', release: '6.8.0', architecture: 64,
    layer: { manifest: 'ReShade64.json', library: 'ReShade64.dll', manifestSha256: hash(manifest), librarySha256: hash('pe64-layer'), name: 'VK_LAYER_reshade' },
    activation: { interface: 'reshade-ini-v1' } };
  const writeRecipes = () => { fs.writeFileSync(path.join(runtimeRoot, 'recipe.json'), JSON.stringify(runtime)); fs.writeFileSync(path.join(layerRoot, 'recipe.json'), JSON.stringify(layer)); };
  writeRecipes();
  const hardware = { family: 'RTX50', families: ['RTX50'], series: ['RTX50'] }, calls = [], values = new Map();
  let antiCheat = false, running = false, activationFailure = false, archiveFailure = false, bindingClearFailure = false, archivedSaveFailure = false, firstBindingFailure = false;
  const pe = { getBitness: file => fs.readFileSync(file, 'utf8').startsWith('pe64') ? 64 : 32 };
  const realProfile = createVulkanRuntimeProfile({ userData, pe });
  const profile = { ...realProfile,
    async prepare(input) { calls.push('profile-start'); const result = await realProfile.prepare(input); calls.push('profile-published'); return result; },
    async inspect(input) { calls.push('profile-inspect'); return realProfile.inspect(input); },
    async archive(input) { calls.push('profile-archive'); if (archiveFailure) { archiveFailure = false; throw Object.assign(new Error('archive denied'), { code: 'EACCES' }); } return realProfile.archive(input); }
  };
  const actualActivation = createReshadeVulkanActivation({ userData, resolveBasePath(exe) {
    return read(bindingPath).bindings.find(row => row.exe.toLowerCase() === exe.toLowerCase())?.basePath;
  } });
  const activation = { ...actualActivation, async write(exe, expected, desired) {
    calls.push(desired.active ? 'activate' : 'deactivate');
    if (desired.active) {
      assert.equal(read(bindingPath).bindings.find(row => row.exe === exe).phase, 'prepared');
      assert.ok(fs.existsSync(read(bindingPath).bindings.find(row => row.exe === exe).basePath));
      if (activationFailure) { activationFailure = false; throw Object.assign(new Error('activation denied'), { code: 'EACCES' }); }
    }
    return actualActivation.write(exe, expected, desired);
  } };
  const registry = { identity: { scope: 'HKCU', view: '64', key: 'Software\\Khronos\\Vulkan\\ImplicitLayers' },
    async read(name) { return structuredClone(values.get(name.toLowerCase()) || { exists: false }); },
    async list() { return [...values].map(([name, row]) => ({ name, type: row.type, data: row.data })); },
    async listMachine() { return []; },
    async write(name, expected, desired) { calls.push(desired.exists ? 'registry-add' : 'registry-remove'); assert.deepEqual(await this.read(name), expected); if (desired.exists) values.set(name.toLowerCase(), structuredClone(desired)); else values.delete(name.toLowerCase()); }
  };
  const guards = { antiCheatPresent: () => antiCheat, async assertGameClosed() { calls.push('closed'); if (running) throw Object.assign(new Error('game running'), { code: 'ERR_GAME_RUNNING' }); } };
  const broker = { async inspect() { calls.push('broker-inspect'); if (options.launchInspectionError) throw options.launchInspectionError; return { elevated: false, launchable: true }; },
    async launch(input) { calls.push(['launch', input]); return { pid: 1234, elevated: false }; } };
  const create = extra => createVulkanService({ userData, appDir, resourcesPath, hardware,
    overrides: { pe, profile, activation, registry, guards, broker, executionLevel: () => options.executionLevel || 'asInvoker', async writeBinding(file, state) {
      if (firstBindingFailure) { firstBindingFailure = false; throw Object.assign(new Error('binding write denied'), { code: 'EACCES' }); }
      if (bindingClearFailure && !state.bindings.length) { bindingClearFailure = false; throw Object.assign(new Error('binding delete denied'), { code: 'EACCES' }); }
      if (archivedSaveFailure && state.bindings.some(row => row.phase === 'archived')) { archivedSaveFailure = false; throw Object.assign(new Error('archive receipt denied'), { code: 'EACCES' }); }
      return atomicJson(file, state);
    } }, ...extra });
  const game = (name, directory) => {
    const dir = directory || path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, name + '.exe'); fs.writeFileSync(exe, 'pe64-game');
    return { id: name, dir, scan: { chosen: { path: exe, bitness: 64, apiResolution: { api: 'vulkan', source: 'manual' } } } };
  };
  return { root, userData, appDir, resourcesPath, runtimeRoot, layerRoot, bindingPath, runtime, layer, hardware, calls, values, profile, activation, game, create, writeRecipes,
    setAntiCheat() { antiCheat = true; }, setRunning() { running = true; }, failActivation() { activationFailure = true; }, failArchive() { archiveFailure = true; },
    failClear() { bindingClearFailure = true; }, failArchivedSave() { archivedSaveFailure = true; }, failFirstBinding() { firstBindingFailure = true; } };
}

test('summary only reads metadata and missing/unaccepted packages stay unavailable', t => {
  const f = fixture(t), game = f.game('metadata'), service = f.create();
  assert.equal(service.summary(game).available, true);
  for (let n = 0; n < 20; n++) service.summary(game);
  assert.deepEqual(f.calls, []); assert.equal(f.values.size, 0); assert.equal(fs.existsSync(f.bindingPath), false);
  f.runtime.acceptance.status = 'loaded'; f.writeRecipes();
  assert.equal(service.summary(game).available, false); assert.match(service.summary(game).reason, /实际处理验收/);
  fs.unlinkSync(path.join(f.runtimeRoot, 'recipe.json'));
  assert.equal(service.summary(game).available, false); assert.match(service.summary(game).reason, /尚未提供/);
});

test('Vulkan previews list concrete runtime, layer, registry and activation effects without publishing any state', async t => {
  const f = fixture(t), game = f.game('preview'), service = f.create();
  const preview = await service.previewInstall(game);
  assert.equal(preview.api, 'vulkan'); assert.equal(preview.packageId, f.runtime.id);
  assert.ok(preview.changes.some(row => row.path.endsWith('core.addon64') && row.afterSha256 === hash('pe64-core')));
  assert.ok(preview.changes.some(row => row.role === 'vulkan-registry' && row.action === 'create' && row.after.data === 0));
  assert.ok(preview.changes.some(row => row.path === path.join(game.dir, 'ReShade.ini') && row.action === 'create'));
  assert.equal(fs.existsSync(f.userData), false); assert.equal(f.values.size, 0);
  assert.equal(f.calls.some(call => ['profile-start', 'profile-published', 'registry-add', 'activate'].includes(call)), false);
  await service.install(game);
  const basePath = service.configDir(game), settings = path.join(basePath, 'nr_before_sr.ini');
  fs.writeFileSync(settings, 'personal setting');
  const before = read(f.bindingPath), values = [...f.values], config = fs.readFileSync(path.join(game.dir, 'ReShade.ini'));
  const removal = await service.previewRestore(game);
  assert.ok(removal.changes.some(row => row.path === settings && row.action === 'archive' && row.beforeSha256 === hash('personal setting')));
  assert.ok(removal.changes.some(row => row.role === 'vulkan-registry' && row.after.exists === false));
  assert.deepEqual(read(f.bindingPath), before); assert.deepEqual([...f.values], values);
  assert.deepEqual(fs.readFileSync(path.join(game.dir, 'ReShade.ini')), config);
  assert.equal(fs.existsSync(path.join(f.userData, 'vulkan-runtime-archive')), false);
  assert.equal(fs.existsSync(path.join(f.userData, 'vulkan-deployment', 'pending.json')), false);
  assert.equal(fs.existsSync(path.join(f.userData, 'vulkan-deployment', 'operation.lock')), false);
});

test('Vulkan package selection is independent of the saved API and retains real blockers', t => {
  const f = fixture(t), game = f.game('draft-selection'), service = f.create();
  for (const api of ['unknown', 'mixed', 'dx12']) {
    game.scan.chosen.apiResolution.api = api;
    const result = service.summary(game);
    assert.equal(result.available, false, 'unsaved route is not active');
    assert.match(result.reason, /路线不是已确认/);
    assert.equal(result.selectionAvailable, true, 'the fixed package can be selected before applying Vulkan');
    assert.equal(result.selectionReason, null);
  }
  f.hardware.family = 'RTX40'; f.hardware.series = ['RTX40'];
  assert.equal(service.summary(game).selectionAvailable, false);
  assert.match(service.summary(game).selectionReason, /RTX 50/);
  f.hardware.family = 'RTX50'; f.hardware.series = ['RTX50']; game.scan.chosen.bitness = 32;
  assert.equal(service.summary(game).selectionAvailable, false);
  assert.match(service.summary(game).selectionReason, /x64/);
  game.scan.chosen.bitness = 64;
  fs.unlinkSync(path.join(f.runtimeRoot, 'core.addon64'));
  assert.equal(service.summary(game).selectionAvailable, false);
  assert.match(service.summary(game).selectionReason, /缺少文件/);
  assert.deepEqual(f.calls, []); assert.equal(f.values.size, 0); assert.equal(fs.existsSync(f.bindingPath), false);
});

test('administrator-required EXEs are unavailable before selecting the Vulkan package', t => {
  const f = fixture(t, { executionLevel: 'requireAdministrator' }), game = f.game('elevated-summary');
  for (const api of ['mixed', 'vulkan']) {
    game.scan.chosen.apiResolution.api = api;
    const info = f.create().summary(game);
    assert.equal(info.available, false); assert.equal(info.selectionAvailable, false);
    assert.match(info.selectionReason, /管理员权限/);
  }
  assert.deepEqual(f.calls, []); assert.equal(fs.existsSync(f.bindingPath), false);
});

test('launch preflight rejection leaves no profile, binding, activation or registry state', async t => {
  for (const code of ['GAME_LAUNCH_REQUIRES_ELEVATION', 'GAME_LAUNCH_TOKEN_MISMATCH']) {
    const options = { launchInspectionError: Object.assign(new Error('launch preflight rejected'), { code }) };
    const f = fixture(t, options), game = f.game('preflight-' + code), service = f.create();
    await assert.rejects(service.install(game), { code });
    assert.equal(f.calls.includes('profile-start'), false);
    assert.equal(fs.existsSync(f.profile.runtimeRoot), false);
    assert.equal(fs.existsSync(f.bindingPath), false);
    assert.equal(fs.existsSync(path.join(f.userData, 'vulkan-deployment')), false);
    assert.equal(fs.existsSync(path.join(game.dir, 'ReShade.ini')), false); assert.equal(f.values.size, 0);
    options.launchInspectionError = null;
    assert.equal((await service.install(game)).installed, true, 'a corrected launch context can retry without recovery');
    assert.ok(f.calls.indexOf('broker-inspect') < f.calls.indexOf('profile-published'));
  }
});

test('install publishes profile and binding before activation; real diagnosis distinguishes configuration from runtime', async t => {
  const f = fixture(t), game = f.game('ordered'), service = f.create();
  const result = await service.install(game);
  assert.equal(result.installed, true); assert.equal(result.runtimeVerified, false);
  assert.ok(f.calls.indexOf('profile-published') < f.calls.indexOf('registry-add'));
  assert.ok(f.calls.indexOf('registry-add') < f.calls.indexOf('activate'));
  const binding = read(f.bindingPath).bindings[0]; assert.equal(binding.phase, 'installed');
  assert.match(path.basename(path.dirname(binding.basePath)), /^[a-f0-9]{16}$/);
  assert.match(path.basename(binding.basePath), /^[a-f0-9]{16}$/);
  assert.equal(binding.exeId.length, 64); assert.equal(binding.fingerprint.length, 64);
  assert.equal(service.configDir(game), binding.basePath);
  const diagnostic = await service.diagnose(game);
  assert.equal(diagnostic.ready, true); assert.equal(diagnostic.status, 'installed');
  assert.equal(diagnostic.loaded, 'unknown'); assert.equal(diagnostic.processed, 'unknown');
  const launched = await service.launch(game, ['--vulkan', 'value with spaces']);
  assert.equal(launched.elevated, false); assert.equal(launched.processed, 'unknown');
  assert.deepEqual(f.calls.find(row => Array.isArray(row))[1], { exe: game.scan.chosen.path, args: ['--vulkan', 'value with spaces'], cwd: game.dir });
});

test('restore retains old profile identity without the package, RTX50 hardware, EXE or a new scan result', async t => {
  const f = fixture(t), game = f.game('old-package'), service = f.create(); await service.install(game);
  const original = service.configDir(game);
  fs.writeFileSync(path.join(original, 'nr_before_sr.ini'), 'user-edited config');
  f.runtime.id = 'new-package'; f.runtime.coreVersion = '0.4.6-hotfix.2-vulkan'; f.writeRecipes();
  const restart = f.create();
  assert.equal(restart.configDir(game), original); assert.equal(restart.summary(game).coreVersion, '0.4.6-hotfix.1-vulkan');
  await assert.rejects(restart.install(game), { code: 'VULKAN_PACKAGE_LOCKED' });
  assert.equal((await restart.diagnose(game)).ready, true);
  fs.rmSync(f.resourcesPath, { recursive: true }); f.hardware.family = 'RTX40'; f.hardware.series = ['RTX40'];
  fs.unlinkSync(game.scan.chosen.path); game.scan.chosen = null;
  assert.equal(restart.summary(game).available, false); assert.equal(restart.summary(game).installed, true);
  const restored = await restart.restore(game);
  assert.equal(restored.restored, true); assert.equal(fs.existsSync(original), false);
  assert.equal(fs.readFileSync(path.join(restored.archivePath, 'nr_before_sr.ini'), 'utf8'), 'user-edited config');
  assert.equal(fs.existsSync(path.join(game.dir, 'ReShade.ini')), false); assert.equal(f.values.size, 0);
  assert.equal(restart.configDir(game), null); assert.deepEqual(read(f.bindingPath).bindings, []);
});

test('route, hardware, bitness, running game and anti-cheat checks reject before mutation', async t => {
  for (const [type, expected] of [['api','VULKAN_API_REQUIRED'],['gpu','VULKAN_GPU_UNSUPPORTED'],['x86','VULKAN_GAME_ARCH'],['running','ERR_GAME_RUNNING'],['anti','ERR_ANTI_CHEAT_CONFIRM']]) {
    const f = fixture(t), game = f.game(type), service = f.create();
    if (type === 'api') game.scan.chosen.apiResolution.api = 'dx12';
    if (type === 'gpu') { f.hardware.family = 'RTX40'; f.hardware.series = ['RTX40']; }
    if (type === 'x86') game.scan.chosen.bitness = 32;
    if (type === 'running') f.setRunning();
    if (type === 'anti') f.setAntiCheat();
    await assert.rejects(service.install(game), { code: expected });
    assert.equal(f.calls.includes('profile-start'), false); assert.equal(f.values.size, 0);
    assert.equal(fs.existsSync(f.bindingPath), false);
  }
  const f = fixture(t), game = f.game('confirmed'), service = f.create();f.setAntiCheat();
  await service.install(game, { allowAntiCheat: true }); assert.equal((await service.launch(game)).pid, 1234);
});

test('native receipt, unknown ReShade and same-directory different EXE never get taken over', async t => {
  const f = fixture(t), one = f.game('one'), service = f.create();
  fs.mkdirSync(path.join(one.dir, '_DLSS5_Backup'));fs.writeFileSync(path.join(one.dir, '_DLSS5_Backup', 'xiaofeng-manager.json'), '{}');
  await assert.rejects(service.install(one), { code: 'VULKAN_NATIVE_INSTALL_PRESENT' });
  const unknown = f.game('unknown');fs.writeFileSync(path.join(unknown.dir, 'ReShade.ini'), '[GENERAL]\nexternal=keep');
  await assert.rejects(service.install(unknown), { code: 'VULKAN_EXTERNAL_RESHADE' });
  assert.equal(fs.readFileSync(path.join(unknown.dir, 'ReShade.ini'), 'utf8'), '[GENERAL]\nexternal=keep');
  const first = f.game('first'), second = f.game('second', first.dir); await service.install(first);
  await assert.rejects(service.install(second), { code: 'VULKAN_DIRECTORY_BOUND' });
  assert.equal(read(f.bindingPath).bindings.length, 1);
  assert.equal((await service.install({ ...first, id: 'alias' })).unchanged, true);
});

test('activation failure retains binding plus deployment WAL; same-game restore recovers then archives', async t => {
  const f = fixture(t), game = f.game('failure'), service = f.create();f.failActivation();
  await assert.rejects(service.install(game), error => error.code === 'EACCES' && error.details.phase === 'deployment');
  assert.equal(read(f.bindingPath).bindings[0].phase, 'prepared');
  assert.equal(service.summary(game).installed, true); assert.equal(service.summary(game).needsRecovery, true);
  assert.equal((await service.diagnose(game)).status, 'pending');
  assert.equal((await service.restore(game)).restored, true);
  assert.equal(fs.existsSync(path.join(f.userData, 'vulkan-deployment', 'pending.json')), false);
  assert.equal(f.values.size, 0);assert.deepEqual(read(f.bindingPath).bindings, []);
});

test('pending from another game is not recovered by the wrong restore action', async t => {
  const f = fixture(t), first = f.game('first-pending'), second = f.game('second-pending'), service = f.create();
  await service.install(first);f.failActivation();await assert.rejects(service.install(second));
  await assert.rejects(service.restore(first), { code: 'VULKAN_RECOVERY_OTHER_GAME' });
  assert.equal((await f.activation.read(first.scan.chosen.path)).active, true);
  assert.ok(fs.existsSync(service.configDir(first)));
  await service.restore(second);await service.restore(first);
});

test('archive failure and crash after archive remain retryable without reactivating', async t => {
  const f = fixture(t), game = f.game('archive'), service = f.create();await service.install(game);
  f.failArchive();await assert.rejects(service.restore(game), { code: 'EACCES' });
  assert.equal(read(f.bindingPath).bindings[0].phase, 'deactivated');assert.equal((await f.activation.read(game.scan.chosen.path)).active, false);
  const previous = await service.restore(game);assert.equal(previous.archived, true);
  await service.install(game);
  f.failArchivedSave();await assert.rejects(service.restore(game), { code: 'EACCES' });
  assert.equal(read(f.bindingPath).bindings[0].phase, 'deactivated');assert.equal(fs.existsSync(service.configDir(game)), false);
  const restart = f.create();const final = await restart.restore(game);
  assert.equal(final.archived, true);assert.notEqual(final.archivePath, previous.archivePath);
  assert.deepEqual(read(f.bindingPath).bindings, []);
});

test('profile drift blocks launch and invalid binding cannot redirect activation', async t => {
  const f = fixture(t), game = f.game('drift'), service = f.create();await service.install(game);
  fs.writeFileSync(path.join(service.configDir(game), 'core.addon64'), 'pe64-foreign');
  const diagnostic = await service.diagnose(game);assert.equal(diagnostic.ready, false);assert.equal(diagnostic.processed, 'unknown');
  await assert.rejects(service.launch(game), { code: 'VULKAN_NOT_READY' });
  assert.equal(f.calls.some(row => Array.isArray(row)), false);
  const state = read(f.bindingPath);state.bindings[0].basePath = f.root;fs.writeFileSync(f.bindingPath, JSON.stringify(state));
  await assert.rejects(service.restore(game), { code: 'VULKAN_BINDING_INVALID' });
  assert.equal(service.summary(game).available, false);
  assert.equal(service.summary(game).installed, true); assert.equal(service.summary(game).needsRecovery, true);
});

test('install accepts the exact fixed package ID or core version and rejects arbitrary core selection', async t => {
  const f = fixture(t), game = f.game('fixed-package'), service = f.create();
  await assert.rejects(service.install(game, { version: '0.3.3.5' }), { code: 'VULKAN_PACKAGE_LOCKED' });
  assert.equal(f.calls.includes('profile-start'), false); assert.equal(fs.existsSync(f.bindingPath), false);
  assert.equal((await service.install(game, { version: f.runtime.id })).installed, true);
  assert.equal((await service.install(game, { version: f.runtime.coreVersion })).unchanged, true);
});

test('malformed or lost bindings preserve a visible recovery state and cannot become a successful no-op restore', async t => {
  const f = fixture(t), game = f.game('orphan'), service = f.create(); await service.install(game);
  const original = fs.readFileSync(f.bindingPath), ini = fs.readFileSync(path.join(game.dir, 'ReShade.ini'));
  fs.writeFileSync(f.bindingPath, '{invalid');
  assert.equal(service.summary(game).installed, true); assert.equal(service.summary(game).needsRecovery, true);
  assert.equal(service.summary(game).available, false);
  assert.throws(() => service.configDir(game), { code: 'VULKAN_RECORD_INVALID' });
  await assert.rejects(service.restore(game), error => error.code === 'VULKAN_RECORD_INVALID' && error.details.needsRecovery);
  const other = f.game('unrelated'); assert.equal(service.summary(other).installed, false);
  assert.equal(service.summary(other).needsRecovery, true); // unreadable global scope requires the caller's guard
  fs.unlinkSync(f.bindingPath);
  assert.equal(service.summary(game).installed, true); assert.equal((await service.diagnose(game)).pending, true);
  await assert.rejects(service.restore(game), { code: 'VULKAN_BINDING_MISSING' });
  await assert.rejects(service.install(game), { code: 'VULKAN_BINDING_MISSING' });
  assert.deepEqual(fs.readFileSync(path.join(game.dir, 'ReShade.ini')), ini); assert.equal(f.values.size, 1);
  assert.equal(service.summary(other).needsRecovery, false); // valid absent state does not taint unrelated games
  fs.writeFileSync(f.bindingPath, original); assert.equal((await service.restore(game)).restored, true);
});

test('binding clear failure after a successful archive is retryable and remains installed for recovery routing', async t => {
  const f = fixture(t), game = f.game('clear-binding'), service = f.create(); await service.install(game);
  f.failClear(); await assert.rejects(service.restore(game), { code: 'EACCES' });
  assert.equal(read(f.bindingPath).bindings[0].phase, 'archived');
  assert.equal(service.summary(game).installed, true); assert.equal(service.summary(game).needsRecovery, true);
  assert.equal((await f.activation.read(game.scan.chosen.path)).active, false);
  assert.equal((await f.create().restore(game)).restored, true); assert.deepEqual(read(f.bindingPath).bindings, []);
});

test('failed first binding write never activates a layer and accurately reports only the retained profile', async t => {
  const f = fixture(t), game = f.game('binding-write'), service = f.create(); f.failFirstBinding();
  await assert.rejects(service.install(game), error => error.code === 'EACCES' && error.details.phase === 'binding' &&
    error.details.bindingRetained === false && error.details.profileRetained === true);
  assert.equal(fs.existsSync(f.bindingPath), false); assert.equal(f.values.size, 0);
  assert.equal(fs.existsSync(path.join(game.dir, 'ReShade.ini')), false);
  assert.equal((await service.install(game)).installed, true); // verified complete published profile is reusable
});

test('long userData is blocked before profile publication, binding or registry activity', async t => {
  const f = fixture(t, { userFolder: 'user-' + 'x'.repeat(180) }), game = f.game('path-budget'), service = f.create();
  assert.equal(service.summary(game).available, false); assert.match(service.summary(game).reason, /路径上限/);
  await assert.rejects(service.install(game), { code: 'VULKAN_RUNTIME_PATH_TOO_LONG' });
  assert.equal(f.calls.includes('profile-start'), false); assert.equal(fs.existsSync(f.bindingPath), false); assert.equal(f.values.size, 0);
});

test('launch rechecks canonical physical AppData paths and never calls the broker when the mapping is now too long', async t => {
  const f = fixture(t), game = f.game('mapped-path'), originalRealpath = fs.realpathSync.native;
  let expanded = false;
  const physicalRoot = path.join(f.root, 'MSIX-LocalCache-Roaming-' + 'x'.repeat(160));
  t.mock.method(fs.realpathSync, 'native', (file, ...args) => {
    const original = originalRealpath(file, ...args);
    return expanded && original.toLowerCase().startsWith(f.userData.toLowerCase()) ? physicalRoot + original.slice(f.userData.length) : original;
  });
  const service = f.create(); await service.install(game); expanded = true;
  await assert.rejects(service.launch(game), { code: 'VULKAN_RUNTIME_PATH_TOO_LONG' });
  assert.equal(f.calls.some(row => Array.isArray(row) && row[0] === 'launch'), false);
  const summary = service.summary(game); assert.equal(summary.available, false);
  assert.equal((await service.restore(game)).restored, true); assert.equal(f.values.size, 0);
});

test('an overlong legacy binding accepts full identity for recovery, refuses launch, and archives settings with no current package', async t => {
  const f = fixture(t), game = f.game('legacy-layout'); f.runtime.id = 'legacy-' + 'r'.repeat(63); f.writeRecipes();
  const prepared = await f.profile.prepare({ exe: game.scan.chosen.path, recipe: f.runtime, packageRoot: f.runtimeRoot });
  const receiptFile = path.join(prepared.basePath, '.xiaofeng-vulkan-runtime.json'), receipt = read(receiptFile);
  receipt.packageId = `${receipt.recipe.id}-${receipt.recipe.fingerprint.slice(0, 16)}`;
  const legacy = path.join(f.userData, 'vulkan-runtime', receipt.exeId, receipt.packageId);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt)); fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.renameSync(prepared.basePath, legacy);
  fs.writeFileSync(path.join(legacy, 'nr_before_sr.ini'), 'preserve legacy user config');
  fs.writeFileSync(f.bindingPath, JSON.stringify({ version: 1, product: 'xiaofeng-vulkan-bindings', bindings: [{
    gameId: game.id, dir: game.dir, exe: game.scan.chosen.path, basePath: legacy,
    coreVersion: f.runtime.coreVersion, packageId: f.runtime.id, phase: 'installed', acceptance: { status: 'processed', hardwareFamily: 'RTX50' }
  }] }));
  let active = true, launched = false, restored = false;
  const service = createVulkanService({ userData: f.userData, appDir: f.appDir, resourcesPath: f.resourcesPath, hardware: f.hardware,
    overrides: { profile: f.profile, pe: { getBitness: () => 64 }, guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
      activation: { read: async () => ({ active }) },
      deployment: { inspect: async () => ({ status: active ? 'installed' : 'absent', ready: active }), restore: async () => { active = false; restored = true; } },
      broker: { launch: async () => { launched = true; return { pid: 999 }; } }
    } });
  const summary = service.summary(game); assert.equal(summary.installed, true); assert.equal(summary.available, false); assert.equal(summary.needsRecovery, true);
  assert.match(summary.reason, /卸载插件.*新版管理器重新安装/);
  const diagnosis = await service.diagnose(game); assert.equal(diagnosis.ready, false); assert.equal(diagnosis.components.profile.restoreOnly, true);
  await assert.rejects(service.launch(game), { code: 'VULKAN_NOT_READY' }); assert.equal(launched, false);
  fs.unlinkSync(path.join(f.runtimeRoot, 'recipe.json'));
  const result = await service.restore(game);
  assert.equal(restored, true); assert.equal(result.restored, true); assert.equal(active, false);
  assert.equal(fs.readFileSync(path.join(result.archivePath, 'nr_before_sr.ini'), 'utf8'), 'preserve legacy user config');
  assert.deepEqual(read(f.bindingPath).bindings, []); assert.equal(f.values.size, 0);
});

test('short binding prefixes cannot hide changed full identities or an arbitrary package folder', async t => {
  const f = fixture(t), game = f.game('full-binding-id'), service = f.create(); await service.install(game);
  const original = read(f.bindingPath);
  for (const change of [row => { row.exeId = row.exeId.slice(0, 16) + '0'.repeat(48); },
    row => { row.fingerprint = row.fingerprint.slice(0, 16) + '0'.repeat(48); },
    row => { row.basePath = path.join(path.dirname(row.basePath), 'arbitrary-folder'); }]) {
    const state = structuredClone(original); change(state.bindings[0]); fs.writeFileSync(f.bindingPath, JSON.stringify(state));
    await assert.rejects(service.launch(game), { code: 'VULKAN_BINDING_INVALID' });
  }
  assert.equal(f.calls.some(row => Array.isArray(row) && row[0] === 'launch'), false);
  fs.writeFileSync(f.bindingPath, JSON.stringify(original)); await service.restore(game);
});
