'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, peBytes, put, sha, PROJECT } = require('./helpers/operation-integration-fixture');
const { createCompactBundle } = require('../src/product/payload');
const { createExternalRuntime, RECEIPT: PROFILE_RECEIPT } = require('../src/product/external-runtime');
const { createHoYoProfileService } = require('../src/product/hoyoshade-profile');
const { createLegacyService, RECEIPT: LEGACY_RECEIPT } = require('../src/product/legacy-service');
const { createFeederRoutingService } = require('../src/product/feeder-routing-service');
const { createLegacyRuntime } = require('../src/product/legacy-runtime');
const { UPSTREAM } = require('../src/product/legacy-runtime-catalog');
const { fingerprint } = require('../src/product/feeder-runtime');
const { getIni } = require('../src/product/launch-ini');
const { createHoYoDiscovery } = require('../src/product/hoyo-discovery');
const { createHoYoWorkflow } = require('../src/product/hoyo-workflow');
const { createHoYoLauncher } = require('../src/product/hoyo-launcher');
const { createLaunchSessions } = require('../src/product/launch-session');
const { emptyVerification } = require('../src/product/runtime-verification');
const confirm = plan => ({ confirm: true, fingerprint: plan.fingerprint });

function runtimeFixture(root, pe, loader) {
  const assets = [], pool = path.join(root, 'fixture-legacy-pool');
  const add = (id, name, role, content, mutable = false, target) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content); put(path.join(pool, name), bytes);
    assets.push({ id, source: name, role, sha256: sha(bytes), bytes: bytes.length, mutable,
      architecture: /\.(?:dll|addon64)$/.test(name) ? 'x64' : null, ...(target ? { target } : {}) });
  };
  add('loader-x64', 'ReShade64.dll', 'game-loader', loader);
  add('provider-x64', 'dlss5-feed.addon64', 'provider', peBytes('fixed Feeder provider'));
  add('core', 'fixture-feeder-core.addon64', 'core', peBytes('fixed Feeder Core NRBeforeSR'));
  add('chain', 'nrchain_nvngx.dll', 'chain', peBytes('fixed Feeder chain'));
  for (const family of ['rtx40', 'rtx50']) add('runtime-' + family, family + '.dll', 'nr-runtime', peBytes('runtime ' + family));
  add('core-config', 'nr_before_sr.ini', 'core-config', '[NRBeforeSR]\nEnabled=1\nIntensity=1.2\nR8OutputEncoding=2\n', true);
  add('preset', 'ReShadePreset.ini', 'preset', 'Techniques=vort_MotionEffects@vort_Motion.fx,DLSS5_Feed@DLSS5_Feed.fx\n', true);
  add('shader-feed', 'Feed.fx', 'shader', 'fixture shader', false, 'reshade-shaders/Shaders/DLSS5_Feed.fx');
  add('shader-motion', 'Motion.fx', 'shader', 'fixture motion', false, 'reshade-shaders/Shaders/vort_Motion.fx');
  add('texture', 'fixture.png', 'texture', 'fixture texture', false, 'reshade-shaders/Textures/fixture.png');
  add('license', 'LICENSE.txt', 'license', 'fixture license', false, 'LICENSE.txt');
  const manifest = { schema: 1, upstream: UPSTREAM, coreInterface: 'NRExternalProviderV1', coreVersion: 'fixture-feeder-core',
    coreFileName: 'fixture-feeder-core.addon64', coreVariant: { requiredInterface: 'NRExternalProviderV1', genericCoreInterchangeable: false }, assets };
  put(path.join(pool, 'manifest.json'), JSON.stringify(manifest));
  const lock = { manifestFingerprint: fingerprint(manifest), restorableRecipeFingerprints: [] };
  const runtime = createLegacyRuntime({ appDir: root, root: pool, pe, lock,
    // Exercise the explicitly constructed 0.15.1 owner, independent of any
    // external-provider selection that AppService may import for other tests.
    externalProviders: { selectedId: () => null } });
  for (const loadingBackend of ['local', 'hoyoshade']) lock.restorableRecipeFingerprints.push(runtime.load({ api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend }).fingerprint);
  return runtime;
}
async function jointFixture(t, mode, { existingHotkey = true, nativeIntegration = false } = {}) {
  return fixture(t, { api: 'dx11', family: 'RTX50', noDlss: !nativeIntegration, exeName: mode === 'hoyoshade' ? 'YuanShen.exe' : 'Game.exe',
    specialSetup: async ({ root, userData, resourcesPath, hardware, guards, pe, gameRoot, exeDir, exe }) => {
      const loader = fs.readFileSync(path.join(PROJECT, 'payload/nr-before-sr/fixed/RTX50/ReShade64.dll'));
      const payload = path.join(resourcesPath, 'payload/nr-before-sr');
      for (const family of ['RTX40', 'RTX50']) put(path.join(payload, 'fixed', family, 'ReShade64.dll'), loader);
      put(path.join(payload, 'bundle.json'), JSON.stringify(createCompactBundle(payload,
        ['fixture-core-1', 'fixture-core-2'].map(id => ({ id, label: id, compatibility: 'dx11' })), 'fixture-core-1')));
      put(path.join(resourcesPath, 'hoyoshade/component.json'), fs.readFileSync(path.join(PROJECT, 'resources/hoyoshade/component.json')));
      const runtime = runtimeFixture(root, pe, loader), events = [], launcher = path.join(root, 'HYP.exe'); put(launcher, peBytes('fixture HYP; never launched'));
      const external = createExternalRuntime({ userData, pe, guards, afterWrite: ({ row }) => {
        if (row.role === 'profile-loader' && row.after === null) {
          assert.equal(fs.existsSync(path.join(gameRoot, LEGACY_RECEIPT)), false, 'legacy restore completes before the profile loader is removed');
          events.push('profile-remove');
        }
      } });
      let modern;
      const known = async game => modern ? modern.ownedModuleManifest(game) : [];
      const hoyo = createHoYoProfileService({ userData, resourcesPath, appDir: root, externalRuntime: external, pe, getKnownComponents: known });
      modern = createLegacyService({ appDir: root, userData, resourcesPath, runtime, hardware, pe, guards, getLayout: game => hoyo.profile(game), getKnownComponents: known,
        broker: { inspect: async () => ({ elevated: false, launchable: true }), launch: async () => { throw new Error('fixture never launches a game'); } },
        afterWrite: ({ row }) => { if (row.role === 'receipt' && row.after === null) events.push('legacy-remove'); } });
      const feeder = createFeederRoutingService({ appDir: root, userData, resourcesPath, runtime, modern, hardware });
      const original = '; personal INI\r\n[ADDON]\r\nAddonPath=.\\personal-addons\r\n[GENERAL]\r\nPresetPath=.\\PersonalPreset.ini\r\n[STYLE]\r\nHdrOverlayBrightness=178\r\n' +
        (existingHotkey ? '[INPUT]\r\nKeyOverlay=36,0,0,0\r\n' : '');
      put(path.join(exeDir, 'ReShade.ini'), original); put(path.join(exeDir, 'PersonalPreset.ini'), 'Techniques=UserEffect');
      return { overrides: { feeder, hoyo, externalDeployment: external }, runtime, modern, hoyo, external, feeder, events, launcher, original, exe };
    } });
}
async function stablePreview(f, request) {
  const first = await f.plans.preview(f.id, request), second = await f.plans.preview(f.id, request);
  assert.deepEqual(first.blockers, []); assert.deepEqual(second.blockers, []); assert.equal(first.fingerprint, second.fingerprint);
  return first;
}

test('real AppService and OperationPlan keep local Feeder previews stable, route NR and hotkeys correctly, and restore the owner', async t => {
  const f = await jointFixture(t, 'local'), request = { route: 'feeder', api: 'dx11', loadingBackend: 'local', deployment: 'local' };
  const preview = await stablePreview(f, request); assert.equal(fs.existsSync(path.join(f.gameRoot, LEGACY_RECEIPT)), false);
  assert.equal((await f.plans.apply(preview.planId, confirm(preview))).applied, true);
  const game = (await f.service.listGames())[0], layout = f.service.getLayout(f.id);
  assert.equal((await f.special.modern.inspect(game)).ready, true); assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
  assert.equal(layout.source, 'feeder'); assert.ok(layout.nrConfigDir.includes('_DLSS5_Feeder15'));
  const settings = await stablePreview(f, { nr: { Intensity: 1.65 }, hotkeys: { reshade: { key: 121, ctrl: true, shift: false, alt: false } } });
  await f.plans.apply(settings.planId, confirm(settings));
  assert.equal((await f.service.readNrSettings(f.id)).Intensity, 1.65); assert.equal((await f.service.readGameHotkeys(f.id)).reshade.key, 121);
  assert.match(fs.readFileSync(path.join(layout.nrConfigDir, 'nr_before_sr.ini'), 'utf8'), /Intensity=1\.65/);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'nr_before_sr.ini')), false);
  assert.equal(getIni(fs.readFileSync(layout.activeConfigPath, 'utf8'), 'INPUT', 'KeyOverlay'), '121,1,0,0');
  assert.equal((await f.special.modern.inspect(game)).ready, true);
  const restore = await stablePreview(f, { uninstall: 'restore' }); await f.plans.apply(restore.planId, confirm(restore));
  assert.equal(fs.existsSync(path.join(f.gameRoot, LEGACY_RECEIPT)), false); assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
  assert.match(fs.readFileSync(path.join(f.exeDir, 'ReShade.ini'), 'utf8'), /HdrOverlayBrightness=178/);
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'PersonalPreset.ini'), 'utf8'), 'Techniques=UserEffect');
  assert.equal((await f.plans.inspect(f.id)).pending, false);
});

test('real AppService and OperationPlan bind HoYo and legacy owners, retain pins across rebind and repair, then restore legacy before profile', async t => {
  const f = await jointFixture(t, 'hoyoshade'), request = { route: 'feeder', api: 'dx11', loadingBackend: 'hoyoshade',
    hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.special.launcher } } };
  const preview = await stablePreview(f, request); assert.equal((await f.plans.apply(preview.planId, confirm(preview))).applied, true);
  let game = (await f.service.listGames())[0];
  assert.equal((await f.special.hoyo.inspect(game)).ready, true); assert.equal((await f.special.modern.inspect(game)).ready, true);
  assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
  const record = f.special.modern.receipt(game), core = record.files.find(row => row.role === 'core'), coreBytes = fs.readFileSync(core.path);
  const rebound = await stablePreview(f, request); await f.plans.apply(rebound.planId, confirm(rebound));
  const repaired = await stablePreview(f, { repair: true }); await f.plans.apply(repaired.planId, confirm(repaired));
  game = (await f.service.listGames())[0]; assert.equal(f.special.modern.receipt(game).recipeFingerprint, record.recipeFingerprint); assert.deepEqual(fs.readFileSync(core.path), coreBytes);
  assert.equal((await f.special.hoyo.inspect(game)).ready, true); assert.equal((await f.special.modern.inspect(game)).ready, true);
  const layout = f.service.getLayout(f.id); assert.notEqual(layout.activeConfigPath, path.join(f.exeDir, 'ReShade.ini'));
  const edited = await stablePreview(f, { nr: { Intensity: 1.55 }, hotkeys: { reshade: { key: 120, ctrl: false, shift: true, alt: false } } });
  await f.plans.apply(edited.planId, confirm(edited)); assert.match(fs.readFileSync(path.join(layout.nrConfigDir, 'nr_before_sr.ini'), 'utf8'), /Intensity=1\.55/);
  assert.equal(getIni(fs.readFileSync(layout.activeConfigPath, 'utf8'), 'INPUT', 'KeyOverlay'), '120,0,1,0');
  assert.equal((await f.special.modern.inspect(game)).ready, true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'nr_before_sr.ini')), false);
  const restore = await stablePreview(f, { uninstall: 'restore' }); await f.plans.apply(restore.planId, confirm(restore));
  assert.ok(f.special.events.indexOf('legacy-remove') >= 0); assert.ok(f.special.events.indexOf('legacy-remove') < f.special.events.indexOf('profile-remove'));
  assert.equal(fs.existsSync(path.join(f.gameRoot, LEGACY_RECEIPT)), false); assert.equal(JSON.parse(fs.readFileSync(path.join(f.gameRoot, PROFILE_RECEIPT))).removed, true);
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'ReShade.ini'), 'utf8'), f.special.original); assert.equal(fs.readFileSync(path.join(f.exeDir, 'PersonalPreset.ini'), 'utf8'), 'Techniques=UserEffect');
  assert.equal((await f.plans.inspect(f.id)).pending, false);
});

test('official AppService hotkey edits keep a fresh Feeder default-key installation ready and preserve the edited key on restore', async t => {
  const f = await jointFixture(t, 'local', { existingHotkey: false });
  const preview = await stablePreview(f, { route: 'feeder', api: 'dx11', loadingBackend: 'local', deployment: 'local' });
  await f.plans.apply(preview.planId, confirm(preview));
  const game = (await f.service.listGames())[0], layout = f.service.getLayout(f.id);
  assert.equal(getIni(fs.readFileSync(layout.activeConfigPath, 'utf8'), 'INPUT', 'KeyOverlay'), '36,0,0,0');
  await f.service.writeGameHotkey(f.id, 'reshade', { key: 121, ctrl: true, shift: false, alt: false });
  assert.equal((await f.special.modern.inspect(game)).ready, true); assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
  const repair = await stablePreview(f, { repair: true }); await f.plans.apply(repair.planId, confirm(repair));
  assert.equal(getIni(fs.readFileSync(layout.activeConfigPath, 'utf8'), 'INPUT', 'KeyOverlay'), '121,1,0,0');
  const restore = await stablePreview(f, { uninstall: 'restore' }); await f.plans.apply(restore.planId, confirm(restore));
  assert.equal(getIni(fs.readFileSync(path.join(f.exeDir, 'ReShade.ini'), 'utf8'), 'INPUT', 'KeyOverlay'), '121,1,0,0');
});

test('restored HoYo receipts keep the public game in its dedicated page without presenting the old profile as active', async t => {
  const f = await jointFixture(t, 'hoyoshade');
  const initial = (await f.service.boot()).games.find(row => row.id === f.id);
  assert.equal(initial.hoyoManaged, true, 'first boot classifies a recognized formal client before opening discovery');
  assert.equal(initial.hoyo.installed, false);
  const request = { route: 'feeder', api: 'dx11', loadingBackend: 'hoyoshade',
    hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.special.launcher } } };
  const install = await stablePreview(f, request); await f.plans.apply(install.planId, confirm(install));
  assert.equal(f.service.getLayout(f.id).loadingBackend, 'hoyoshade');
  const restore = await stablePreview(f, { uninstall: 'restore' }); await f.plans.apply(restore.planId, confirm(restore));
  const receiptFile = path.join(f.gameRoot, PROFILE_RECEIPT), receiptBytes = fs.readFileSync(receiptFile), receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.mode, 'local'); assert.equal(receipt.removed, true); assert.ok(receipt.hoyoProfile, 'restore retains the historical launcher binding');
  const layout = f.service.getLayout(f.id), deployment = await f.service.inspectDeployment(f.id);
  assert.equal(layout.mode, 'local'); assert.equal(layout.loadingBackend, 'local'); assert.notEqual(layout.needsRecovery, true);
  assert.equal(deployment.installed, false); assert.notEqual(deployment.needsRecovery, true);
  const restored = (await f.service.boot()).games.find(row => row.id === f.id);
  assert.equal(restored.hoyoManaged, true); assert.equal(restored.installed, false);
  assert.equal(restored.hoyo.installed, false, 'a saved inactive profile is not an active HoYo installation');
  assert.equal(restored.hoyo.selected.launcher.path, f.special.launcher, 'the previous launcher remains available for rebinding');
  assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes);
});

test('historical launch sessions after a real HoYo restore do not resolve the inactive launcher or block a new installation preview', async t => {
  const f = await jointFixture(t, 'hoyoshade');
  const install = await stablePreview(f, { route: 'feeder', api: 'dx11', loadingBackend: 'hoyoshade',
    hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.special.launcher } } });
  await f.plans.apply(install.planId, confirm(install));
  const restore = await stablePreview(f, { uninstall: 'restore' }); await f.plans.apply(restore.planId, confirm(restore));
  const receiptFile = path.join(f.gameRoot, PROFILE_RECEIPT), receiptBytes = fs.readFileSync(receiptFile), receipt = JSON.parse(receiptBytes);
  const historical = { version: 1, sessionId: 'old-hoyo-session', gameId: f.id, targetExe: f.exe, mode: 'hoyoplay', status: 'failed',
    requestedAt: '2026-09-10T10:00:00.000Z', error: { code: 'OLD_HELPER_FAILURE', message: 'Previous installation failure' } };
  put(path.join(f.userData, 'launch-sessions', sha(f.id) + '.json'), JSON.stringify(historical));
  let inactiveResolutions = 0;
  const launcher = createHoYoLauncher({ broker: { launch: async () => { throw Error('never launch in this test'); } } });
  const sessions = createLaunchSessions({ userData: f.userData,
    game: async id => {
      const layout = f.service.getLayout(id);
      // This is the same ownership branch used by main's launch-session adapter.
      if (layout.loadingBackend === 'hoyoshade') { inactiveResolutions++; return launcher.resolve(layout); }
      return { exe: f.service.gameExecutable(id), launchMode: 'exe' };
    }, broker: {}, processes: { find: async () => [] } });
  const old = await sessions.inspect(f.id); assert.equal(old.historical, true); assert.equal(old.status, 'failed'); assert.equal(inactiveResolutions, 0);
  const discovery = createHoYoDiscovery({ appData: path.join(f.root, 'no-appdata'), programFiles: [],
    readRegistry: async () => ({ launchers: [], gameRoots: [], starwardUserData: [] }),
    knownGames: () => f.service.listGames(), savedBindings: [receipt.hoyoProfile] });
  const flow = createHoYoWorkflow({ userData: f.userData, service: f.service, operations: f.plans, launches: sessions, discovery,
    verification: { assess: async () => emptyVerification(null, null) }, launch: async () => { throw Error('never launch in this test'); } });
  const current = (await flow.discover()).games[0];
  assert.equal(current.gameId, f.id); assert.equal(current.phase, 'install'); assert.equal(current.error, null); assert.equal(current.installation.installed, false);
  assert.equal(current.binding.status, 'confirmed'); assert.equal(current.binding.launcher.path, f.special.launcher);
  assert.equal(current.session.historical, true); assert.equal(inactiveResolutions, 0);
  const retiredShaders = path.join(f.special.external.location((await f.service.listGames())[0]).runtimeDir, 'reshade-shaders');
  assert.equal(fs.existsSync(retiredShaders), true);
  assert.equal(fs.readdirSync(retiredShaders, { recursive: true, withFileTypes: true }).filter(row => !row.isDirectory()).length, 0,
    'legacy restore has removed every owned shader/texture file; any remaining directory tree is empty');
  const unknown = path.join(retiredShaders, 'Shaders', 'unknown.fx'), unknownBytes = Buffer.from('unowned user shader; preserve byte for byte');
  put(unknown, unknownBytes);
  await assert.rejects(flow.preview(current.id, 'install'), { code: 'DEPLOYMENT_PROFILE_EXISTS' });
  assert.deepEqual(fs.readFileSync(unknown), unknownBytes); assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes);
  fs.unlinkSync(unknown);
  const plan = await flow.preview(current.id, 'install'); assert.deepEqual(plan.blockers, []);
  assert.equal(plan.gameId, f.id); assert.equal(plan.request.hoyo.launcher.path, f.special.launcher);
  assert.deepEqual(fs.readFileSync(receiptFile), receiptBytes, 'discovery and preview preserve the restored receipt');
});

test('new native HoYo previews use the bundle default while explicit selections and installed Core pins take priority', async t => {
  const f = await jointFixture(t, 'hoyoshade', { nativeIntegration: true });
  const bundleFile = path.join(f.payload, 'bundle.json'), bundle = JSON.parse(fs.readFileSync(bundleFile));
  bundle.defaultVersion = 'fixture-core-2'; put(bundleFile, JSON.stringify(bundle));
  await f.service.store.write({ addonVersion: 'fixture-core-1' });
  const request = { route: 'native', api: 'dx12', loadingBackend: 'hoyoshade',
    hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.special.launcher } } };
  const fresh = await stablePreview(f, request);
  assert.equal(fresh.request.version, undefined); assert.equal(fresh.resolved.version, 'fixture-core-2'); assert.equal(fresh.deployment.version, 'fixture-core-2');
  assert.equal(fs.existsSync(path.join(f.gameRoot, PROFILE_RECEIPT)), false, 'preview does not install the new default');
  const explicit = await stablePreview(f, { ...request, version: 'fixture-core-1' });
  assert.equal(explicit.resolved.version, 'fixture-core-1'); await f.plans.apply(explicit.planId, confirm(explicit));
  await f.service.store.write({ addonVersion: 'fixture-core-2' });
  const pinned = await stablePreview(f, request);
  assert.equal(f.service.getLayout(f.id).version, 'fixture-core-1'); assert.equal(pinned.resolved.version, 'fixture-core-1');
  assert.equal(pinned.deployment.version, 'fixture-core-1'); assert.equal(pinned.request.version, undefined);
});

test('a confirmed HoYo launcher change reaches the actual launch adapter only after applying a new profile', async t => {
  const f = await jointFixture(t, 'hoyoshade');
  const request = { route: 'feeder', api: 'dx11', loadingBackend: 'hoyoshade',
    hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.special.launcher } } };
  const initialPlan = await stablePreview(f, request); await f.plans.apply(initialPlan.planId, confirm(initialPlan));
  const oldLayout = f.service.getLayout(f.id), oldReceipt = fs.readFileSync(path.join(f.gameRoot, PROFILE_RECEIPT));
  const nextLauncher = path.join(f.root, 'Starward', 'Starward.exe'); put(nextLauncher, peBytes('inert replacement launcher'));
  const adapter = createHoYoLauncher({ broker: {}, readProtocol: async () => ({ enabled: true, command: `"${nextLauncher}" "%1"` }) });
  assert.equal((await adapter.resolve(oldLayout)).launcher.path, f.special.launcher);
  const discovery = createHoYoDiscovery({ appData: path.join(f.root, 'no-appdata'), programFiles: [], readRegistry: async () => ({}),
    knownGames: () => f.service.listGames(), savedBindings: [oldLayout.hoyoProfile], knownLaunchers: [{ kind: 'starward', path: nextLauncher }] });
  let launched = null, finishLaunch;
  const launchCompleted = new Promise(resolve => { finishLaunch = resolve; });
  const flow = createHoYoWorkflow({ userData: f.userData, service: f.service, operations: f.plans, discovery,
    launches: { inspect: async () => null }, verification: { assess: async () => emptyVerification(null, null) },
    launch: async id => { launched = await adapter.resolve(f.service.getLayout(id)); finishLaunch(); } });
  const current = (await flow.discover()).games[0], picked = await flow.pickLauncher(current.id, nextLauncher);
  const bound = await flow.bind(current.id, { launcherId: picked.binding.launcher.id });
  assert.equal(bound.phase, 'install'); assert.equal(bound.installation.bindingChangePending, true); assert.equal(bound.installation.ready, false);
  await assert.rejects(flow.start(current.id), { code: 'HOYO_NOT_READY' }); assert.equal(launched, null);
  assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, PROFILE_RECEIPT)), oldReceipt);
  assert.equal((await adapter.resolve(f.service.getLayout(f.id))).launcher.path, f.special.launcher, 'the installed profile remains unchanged before Apply');
  const nextPlan = await flow.preview(current.id, 'install'); assert.deepEqual(nextPlan.blockers, []);
  assert.equal(nextPlan.deployment.route, 'feeder'); assert.equal(nextPlan.deployment.version, initialPlan.deployment.version, 'rebinding keeps the Feeder package id');
  const applied = await flow.apply(current.id, nextPlan.planId, confirm(nextPlan));
  assert.equal(applied.phase, 'ready'); assert.equal(applied.installation.bindingChangePending, false);
  const resolved = await adapter.resolve(f.service.getLayout(f.id));
  assert.equal(resolved.launcher.path, nextLauncher); assert.equal(resolved.launchMode, 'starward'); assert.equal(resolved.launcher.gameBiz, 'hk4e_cn');
  const beforeUpdateReceipt = fs.readFileSync(path.join(f.gameRoot, PROFILE_RECEIPT));
  fs.appendFileSync(nextLauncher, 'verified same-path launcher update');
  await assert.rejects(adapter.resolve(f.service.getLayout(f.id)), { code: 'HOYO_LAUNCH_CHANGED' });
  const updated = await flow.bind(current.id, { launcherId: applied.binding.launcher.id });
  assert.equal(updated.phase, 'install'); assert.equal(updated.error, null); assert.equal(updated.installation.bindingChangePending, true);
  assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, PROFILE_RECEIPT)), beforeUpdateReceipt, 'reconfirming updated bytes does not rewrite the installed profile');
  const updatePlan = await flow.preview(current.id, 'install'); assert.deepEqual(updatePlan.blockers, []);
  const updatedApplied = await flow.apply(current.id, updatePlan.planId, confirm(updatePlan));
  assert.equal(updatedApplied.phase, 'ready'); assert.equal(updatedApplied.installation.bindingChangePending, false);
  assert.equal((await adapter.resolve(f.service.getLayout(f.id))).launcher.sha256, sha(fs.readFileSync(nextLauncher)));
  await flow.start(current.id); await launchCompleted;
  assert.equal(launched.launcher.path, nextLauncher); assert.equal(launched.launchMode, 'starward');
});
