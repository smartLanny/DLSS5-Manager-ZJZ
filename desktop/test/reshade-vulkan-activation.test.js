'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReshadeVulkanActivation } = require('../src/product/reshade-vulkan-activation');
const { createVulkanDeployment } = require('../src/product/vulkan-deployment');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function tempRoot(t, prefix = 'xiaofeng-reshade-activation-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('absent activation is explicit, owned bytes archive on disable, and archive restores full runtime bytes', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const activation = createReshadeVulkanActivation({ userData });
  assert.deepEqual(await activation.read(exe), { active: false, token: 'absent' });
  const token = `xiaofeng-vulkan-deployment:${crypto.randomUUID()}`;
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  const first = fs.readFileSync(path.join(dir, 'ReShade.ini'));
  assert.equal((await activation.read(exe)).token, token);

  fs.appendFileSync(path.join(dir, 'ReShade.ini'), '\r\n[GENERAL]\r\nRuntimeUserSetting=7\r\n');
  const runtimeBytes = fs.readFileSync(path.join(dir, 'ReShade.ini'));
  await activation.write(exe, { active: true, token }, { active: false, token: 'absent' });
  assert.equal(fs.existsSync(path.join(dir, 'ReShade.ini')), false);
  const archiveDir = path.join(userData, 'vulkan-deployment', 'activation-archives');
  const archives = fs.readdirSync(archiveDir).filter(name => name.endsWith('.ini')); assert.equal(archives.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(archiveDir, archives[0])), runtimeBytes);
  assert.notDeepEqual(runtimeBytes, first);

  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'ReShade.ini')), runtimeBytes);
});

test('controlled profile mode binds BasePath, scope and activation token to the userData profile', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), profile = path.join(userData, 'vulkan-profile'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const activation = createReshadeVulkanActivation({ userData, resolveBasePath: () => profile });
  const marker = `xiaofeng-vulkan-deployment:${crypto.randomUUID()}`, token = await activation.bindToken(exe, marker);
  assert.match(token, /@[a-f0-9]{32}$/);
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  const ini = fs.readFileSync(path.join(dir, 'ReShade.ini'), 'utf8');
  assert.ok(ini.includes(`BasePath=${profile}\r\n`));
  assert.match(ini, new RegExp(`^XiaofengVulkanMarker=${marker}$`, 'm'));
  assert.equal((await activation.read(exe)).token, token);
  fs.appendFileSync(path.join(dir, 'ReShade.ini'), '\r\n[GENERAL]\r\nProfileValue=4\r\n');
  const archivedBytes = fs.readFileSync(path.join(dir, 'ReShade.ini'));
  await activation.write(exe, { active: true, token }, { active: false, token: 'absent' });
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'ReShade.ini')), archivedBytes);
  const latest = fs.readdirSync(path.join(userData, 'vulkan-deployment', 'activation-archives')).find(name => name.endsWith('.latest.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'vulkan-deployment', 'activation-archives', latest), 'utf8')).basePath, path.resolve(profile).toLowerCase());
  fs.mkdirSync(path.join(userData, 'other-profile'), { recursive: true });
  const wrong = createReshadeVulkanActivation({ userData, resolveBasePath: () => path.join(userData, 'other-profile') });
  await assert.rejects(wrong.read(exe), { code: 'VULKAN_ACTIVATION_BASE_PATH_UNSUPPORTED' });
  const outside = createReshadeVulkanActivation({ userData, resolveBasePath: () => path.join(root, 'outside') });
  await assert.rejects(outside.bindToken(exe, marker), { code: 'VULKAN_ACTIVATION_PROFILE_INVALID' });
});

test('safe external ReShade.ini uses a location token and is never treated as Manager-owned', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const ini = path.join(dir, 'ReShade.ini');
  fs.writeFileSync(ini, '[GENERAL]\r\nPreset=custom.ini\r\n\r\n[ADDON]\r\nAddonPath=.\\\r\n');
  const activation = createReshadeVulkanActivation({ userData });
  const before = await activation.read(exe), bytes = fs.readFileSync(ini);
  assert.equal(before.active, true); assert.match(before.token, /^external:[0-9a-f]{32}$/);
  fs.appendFileSync(ini, '\r\n[GENERAL]\r\nRuntime=changed\r\n');
  const after = await activation.read(exe);
  assert.equal(after.token, before.token);
  await assert.rejects(activation.write(exe, after, { active: false, token: 'absent' }), { code: 'VULKAN_ACTIVATION_EXTERNAL' });
  assert.deepEqual(fs.readFileSync(ini), Buffer.concat([bytes, Buffer.from('\r\n[GENERAL]\r\nRuntime=changed\r\n')]));
});

test('unknown locations and invalid Manager scope are explicit blockers', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const activation = createReshadeVulkanActivation({ userData });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[INSTALL]\r\nBasePath=C:\\Other\\ReShade\r\n');
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_BASE_PATH_UNSUPPORTED' });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=.\\other\r\n');
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_ADDON_PATH_UNSUPPORTED' });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[INSTALL]\r\nXiaofengVulkanMarker=xiaofeng-vulkan-deployment:00000000-0000-0000-0000-000000000000\r\nXiaofengVulkanScope=wrong\r\n');
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_SCOPE' });
});

test('activation parsing follows ReShade case-sensitive first-value and escaped-comma semantics', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const activation = createReshadeVulkanActivation({ userData });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[INSTALL]\r\nBasePath=C:\\external\r\nBasePath=.\\\r\n');
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_BASE_PATH_UNSUPPORTED' });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=C:\\external\r\nAddonPath=.\\\r\n');
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_ADDON_PATH_UNSUPPORTED' });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[install]\r\nBasePath=C:\\external\r\n[ADDON]\r\naddonpath=C:\\external\r\nAddonPath=.\\\r\n');
  assert.equal((await activation.read(exe)).active, true, 'lowercase section/key is not ReShade configuration');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[INSTALL]\r\nxiaofengVulkanMarker=xiaofeng-vulkan-deployment:00000000-0000-0000-0000-000000000000\r\nxiaofengVulkanScope=wrong\r\n[ADDON]\r\nAddonPath=.\\\r\n');
  assert.match((await activation.read(exe)).token, /^external:/, 'Manager marker names stay exact-case');
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), '[ADDON]\r\nAddonPath=C:\\external,,dir,.\\\r\n');
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_ADDON_PATH_UNSUPPORTED' });
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[ADDON]\r\nAddonPath=.\\\r\n', 'utf16le')]));
  await assert.rejects(activation.read(exe), { code: 'VULKAN_ACTIVATION_INVALID' });
});

test('activation refuses INI hardlinks through the shared path safety contract', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const ini = path.join(dir, 'ReShade.ini'); fs.writeFileSync(ini, '[ADDON]\r\nAddonPath=.\\\r\n');
  fs.linkSync(ini, path.join(dir, 'ReShade-alias.ini'));
  await assert.rejects(createReshadeVulkanActivation({ userData }).read(exe), { code: 'SETTINGS_LINK_BLOCKED' });
});

function deploymentFixture(t) {
  const root = tempRoot(t, 'xiaofeng-reshade-deployment-'), userData = path.join(root, 'user'), sourceRoot = path.join(root, 'recipe');
  fs.mkdirSync(sourceRoot, { recursive: true });
  const manifest = path.join(sourceRoot, 'ReShade64.json'), library = path.join(sourceRoot, 'ReShade64.dll');
  fs.writeFileSync(library, 'synthetic x64 ReShade layer');
  fs.writeFileSync(manifest, JSON.stringify({ layer: { name: 'VK_LAYER_reshade', type: 'GLOBAL', library_path: '.\\ReShade64.dll', disable_environment: { DISABLE_VK_LAYER_reshade_1: '1' } } }));
  const recipe = { version: 1, id: 'reshade-shared-test', release: '6.8.0-test', architecture: 64, sourceRoot,
    layer: { manifest: 'ReShade64.json', library: 'ReShade64.dll', manifestSha256: hash(manifest), librarySha256: hash(library), name: 'VK_LAYER_reshade' },
    activation: { interface: 'reshade-ini-v1' } };
  const values = new Map(), machineRows = []; let failRegistryWrite = false;
  const registry = {
    identity: { scope: 'HKCU', view: '64', key: 'Software\\XiaofengShared\\VulkanLayers' },
    async read(name) { const value = values.get(name.toLowerCase()); return value ? structuredClone(value) : { exists: false }; },
    async list() { return [...values.entries()].map(([name, value]) => ({ name, type: value.type, data: value.data })); },
    async listMachine() { return structuredClone(machineRows); },
    async write(name, expected, desired) {
      if (failRegistryWrite) { failRegistryWrite = false; throw Object.assign(new Error('injected registry failure'), { code: 'ACCESS_DENIED' }); }
      assert.deepEqual(await this.read(name), expected); if (desired.exists) values.set(name.toLowerCase(), { ...desired }); else values.delete(name.toLowerCase());
    }
  };
  const activation = createReshadeVulkanActivation({ userData });
  const makeGame = id => { const exe = path.join(root, 'same-dir', `${id}.exe`); fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, id); return { id, exe }; };
  const create = extra => createVulkanDeployment({ userData, registry, activation, pe: { getBitness: () => 64 }, inspectLaunchContext: async () => ({ elevated: false }), ...extra });
  return { root, userData, sourceRoot, manifest, library, recipe, makeGame, create, activation, values, machineRows, failRegistry() { failRegistryWrite = true; } };
}

test('same-directory EXEs share ReShade.ini and ownership transfers before final disable', async t => {
  const fixture = deploymentFixture(t), first = fixture.makeGame('first'), second = fixture.makeGame('second'), service = fixture.create();
  await service.prepare(first, fixture.recipe); const ini = path.join(path.dirname(first.exe), 'ReShade.ini');
  const firstBytes = fs.readFileSync(ini);
  const prepared = await service.prepare(second, fixture.recipe);
  assert.equal(prepared.refs, 2);
  assert.equal((await fixture.activation.read(second.exe)).active, true);
  const one = await service.restore(first);
  assert.equal(one.layerRemoved, false); assert.deepEqual(fs.readFileSync(ini), firstBytes);
  assert.equal((await fixture.activation.read(second.exe)).active, true);
  assert.equal(fs.existsSync(service.receiptPath), true);
  const last = await service.restore(second);
  assert.equal(last.layerRemoved, true); assert.equal(fs.existsSync(ini), false); assert.equal(fixture.values.size, 0);
  assert.equal(fs.readdirSync(path.join(fixture.userData, 'vulkan-deployment', 'activation-archives')).filter(name => name.endsWith('.ini')).length, 1);
});

test('a restored marker can be disabled again after ReShade changes settings, retaining both immutable archives', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const activation = createReshadeVulkanActivation({ userData });
  const token = `xiaofeng-vulkan-deployment:${crypto.randomUUID()}`;
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  await activation.write(exe, { active: true, token }, { active: false, token: 'absent' });
  const archiveDir = path.join(userData, 'vulkan-deployment', 'activation-archives');
  const firstArchive = fs.readdirSync(archiveDir).find(name => name.endsWith('.ini'));
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  fs.appendFileSync(path.join(dir, 'ReShade.ini'), '\r\n[GENERAL]\r\nChangedAfterRestore=1\r\n');
  const secondBytes = fs.readFileSync(path.join(dir, 'ReShade.ini'));
  await activation.write(exe, { active: true, token }, { active: false, token: 'absent' });
  const archives = fs.readdirSync(archiveDir).filter(name => name.endsWith('.ini'));
  assert.equal(archives.length, 2); assert.ok(archives.includes(firstArchive));
  assert.deepEqual(fs.readFileSync(path.join(archiveDir, archives.find(name => name !== firstArchive))), secondBytes);
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  assert.deepEqual(fs.readFileSync(path.join(dir, 'ReShade.ini')), secondBytes);
});

test('an externally changed latest archive is rejected before restoration', async t => {
  const root = tempRoot(t), userData = path.join(root, 'user'), dir = path.join(root, 'game'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'game');
  const activation = createReshadeVulkanActivation({ userData }), token = `xiaofeng-vulkan-deployment:${crypto.randomUUID()}`;
  await activation.write(exe, { active: false, token: 'absent' }, { active: true, token });
  await activation.write(exe, { active: true, token }, { active: false, token: 'absent' });
  const archiveDir = path.join(userData, 'vulkan-deployment', 'activation-archives');
  const archive = fs.readdirSync(archiveDir).find(name => name.endsWith('.ini'));
  fs.appendFileSync(path.join(archiveDir, archive), '\r\nexternal drift\r\n');
  await assert.rejects(activation.write(exe, { active: false, token: 'absent' }, { active: true, token }), { code: 'VULKAN_ACTIVATION_ARCHIVE_CHANGED' });
  assert.equal(fs.existsSync(path.join(dir, 'ReShade.ini')), false);
});

test('interrupted final restore recovers the complete ReShade.ini archive', async t => {
  const fixture = deploymentFixture(t), game = fixture.makeGame('interrupted'), service = fixture.create();
  await service.prepare(game, fixture.recipe);
  const ini = path.join(path.dirname(game.exe), 'ReShade.ini');
  fs.appendFileSync(ini, '\r\n[GENERAL]\r\nRuntimeUserSetting=9\r\n');
  const before = fs.readFileSync(ini);
  fixture.failRegistry();
  await assert.rejects(service.restore(game), error => error.code === 'ACCESS_DENIED' && error.details?.recoveryRequired === true);
  assert.equal(fs.existsSync(service.pendingPath), true); assert.equal(fs.existsSync(ini), false);
  const recovered = await service.recover();
  assert.equal(recovered.recovered, true); assert.equal(recovered.rolledBack, true);
  assert.deepEqual(fs.readFileSync(ini), before); assert.equal(fs.existsSync(service.pendingPath), false);
});

test('an existing HKLM ReShade layer blocks an unverified HKCU duplicate and supports verified reuse', async t => {
  const fixture = deploymentFixture(t), game = fixture.makeGame('machine-layer');
  fixture.machineRows.push({ name: fixture.manifest, type: 'REG_DWORD', data: 0 });
  await assert.rejects(fixture.create().prepare(game, fixture.recipe), { code: 'VULKAN_MACHINE_LAYER_CONFLICT' });
  assert.equal(fs.existsSync(path.join(fixture.userData, 'vulkan-deployment', 'receipt.json')), false);
  const service = fixture.create({ externalLayer: {
    verifyMachine: async ({ manifestPath, registryScope }) => ({ valid: registryScope === 'HKLM' && manifestPath === fixture.manifest, library: fixture.library, identity: 'machine-reshade' })
  } });
  const prepared = await service.prepare(game, fixture.recipe);
  assert.equal(prepared.reused, true);
  const receipt = JSON.parse(fs.readFileSync(service.receiptPath, 'utf8'));
  assert.equal(receipt.layer.registryScope, 'HKLM'); assert.equal(fixture.values.size, 0);
  await service.restore(game);
  assert.equal(fixture.machineRows.length, 1); assert.equal(fixture.values.size, 0);
});
