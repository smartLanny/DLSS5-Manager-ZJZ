'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/product/app-service');
const { createCompactBundle } = require('../src/product/payload');
const { newManifest, manifestPath } = require('../src/product/manifest');
const { PAYLOAD_FILES } = require('../src/product/constants');

const PACKAGE_ID = 'nr-vulkan-external-e7df0fc';
const CORE_VERSION = '0.4.6-hotfix.1-vulkan-provider';

function createPayload(root) {
  const payload = path.join(root, 'resources', 'payload', 'nr-before-sr');
  const version = path.join(payload, 'versions', '0.3.3.5'); fs.mkdirSync(version, { recursive: true });
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(payload, 'fixed', family); fs.mkdirSync(fixed, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll']) fs.writeFileSync(path.join(fixed, name), `${family}:${name}`);
  }
  fs.writeFileSync(path.join(version, PAYLOAD_FILES.addon), 'addon');
  fs.writeFileSync(path.join(version, PAYLOAD_FILES.config), 'config');
  fs.writeFileSync(path.join(payload, 'bundle.json'), JSON.stringify(createCompactBundle(payload, [{ id: '0.3.3.5', label: 'stable' }], '0.3.3.5')));
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-app-vulkan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createPayload(root);
  const gameDir = path.join(root, 'game'), exeDir = path.join(gameDir, 'bin'), exe = path.join(exeDir, 'Game.exe');
  fs.mkdirSync(exeDir, { recursive: true }); fs.writeFileSync(exe, 'fixture-exe');
  const configDir = path.join(root, 'vulkan-profile'), addons = path.join(configDir, 'addons');
  fs.mkdirSync(addons, { recursive: true });
  fs.writeFileSync(path.join(addons, 'nr_before_sr.ini'), '[NRBeforeSR]\nStyle=1\nIntensity=1\n');
  fs.writeFileSync(path.join(configDir, 'ReShade.ini'), '[INPUT]\nKeyOverlay=36,0,0,0\n');
  let normalInstalled = options.normalInstalled === true;
  const owned = new Set(options.vulkanInstalled ? [exe.toLowerCase()] : []);
  let restoreFailure = null, diagnosisComplete = options.diagnosisComplete !== false;
  const calls = { vulkan: [], installer: [], scans: [] };
  let feederInstalled = options.feederInstalled === true;
  const feeder = options.feeder === true ? {
    summary() { return { available: true, installed: feederInstalled, coreVersion: '0.4.7beta', packageId: 'nr-feeder-dx12-047-sdr-20260909', api: 'dx12', provenance: 'Synthetic', ready: false }; },
    configDir(_game, kind) { return kind === 'nr' ? addons : configDir; },
    async inspect() { return { ...this.summary(), ready: feederInstalled, loaded: 'unknown', processed: 'unknown', runtimeVerified: false }; },
    async install(game, value) { (calls.feeder ||= []).push(['install', game.id, value]); feederInstalled = true; return { installed: true }; },
    async restore(game) { (calls.feeder ||= []).push(['restore', game.id]); feederInstalled = false; return { restored: true }; },
    async launch(game) { (calls.feeder ||= []).push(['launch', game.id]); return { pid: 45, elevated: false }; }
  } : undefined;
  const vulkan = {
    summary(game) {
      return { available: options.vulkanAvailable !== false, installed: owned.has(game.scan.chosen.path.toLowerCase()),
        coreVersion: CORE_VERSION, packageId: PACKAGE_ID, reason: options.vulkanAvailable === false ? '固定 Vulkan 包缺失' : null, experimental: true };
    },
    configDir() { return configDir; },
    async previewInstall(game) { return { route: 'vulkan', api: 'vulkan', mode: 'external', version: CORE_VERSION, packageId: PACKAGE_ID,
      changes: [{ path: path.join(configDir, 'core.addon64'), name: 'core.addon64', role: 'vulkan-runtime', action: 'create', beforeSha256: null,
        afterSha256: 'a'.repeat(64) }], runtimeVerified: false }; },
    async previewRestore() { return { changes: [{ path: path.join(configDir, 'core.addon64'), name: 'core.addon64', role: 'vulkan-runtime', action: 'archive' }] }; },
    async install(game, installOptions) { calls.vulkan.push(['install', game.id, structuredClone(installOptions)]); owned.add(game.scan.chosen.path.toLowerCase()); return { installed: true, packageId: PACKAGE_ID }; },
    async diagnose(game) { calls.vulkan.push(['diagnose', game.id]); return { ready: diagnosisComplete,
      components: { profile: { ready: diagnosisComplete }, deployment: { ready: diagnosisComplete }, activation: { active: diagnosisComplete } },
      loaded: 'unknown', processed: 'unknown', runtimeVerified: false, blockers: diagnosisComplete ? [] : ['profile incomplete'] }; },
    async restore(game) { calls.vulkan.push(['restore', game.id]); if (restoreFailure) throw restoreFailure; owned.delete(game.scan.chosen.path.toLowerCase()); return { restored: true }; },
    async launch(game) {
      calls.vulkan.push(['launch-check', game.id]);
      if (!diagnosisComplete) throw Object.assign(new Error('Vulkan profile incomplete'), { code: 'VULKAN_NOT_READY' });
      calls.vulkan.push(['broker-launch', game.id]); return { pid: 1234, elevated: false };
    }
  };
  const installer = {
    async install(input) { calls.installer.push(['install', input]); normalInstalled = true; return { installed: true }; },
    async repair(input) { calls.installer.push(['repair', input]); return { repaired: true }; },
    async upgradeAddon(input) { calls.installer.push(['upgrade', input]); return { upgraded: true }; },
    async disableCarrier(input) { calls.installer.push(['disableCarrier', input]); return { disabled: true }; },
    async diagnose(input) { calls.installer.push(['diagnose', input]); return { complete: true, routeMismatch: false, components: [] }; },
    async uninstall(input) { calls.installer.push(['uninstall', input]); normalInstalled = false; return { removed: true }; }
  };
  const detectedApi = options.detectedApi || 'vulkan';
  const gameId = 'fixture-game';
  const library = {
    async scanAll(state) {
      calls.scans.push(structuredClone(state.gameOverrides));
      const override = Object.values(state.gameOverrides || {}).find(row => !row.apiExecutable || path.resolve(row.apiExecutable).toLowerCase() === exe.toLowerCase());
      const api = override?.api && override.api !== 'auto' ? override.api : detectedApi;
      const chosen = { path: exe, rel: path.relative(gameDir, exe), name: 'Game.exe', bitness: 64,
        api, apiLabel: api === 'vulkan' ? 'Vulkan' : api === 'dx11' ? 'DirectX 11' : 'DirectX 12',
        detectedApi, detectedApiResolution: { api: detectedApi, source: 'fixture', evidence: [] },
        apiResolution: { api, source: override?.api && override.api !== 'auto' ? 'override' : 'fixture', evidence: [] } };
      const excluded = (state.excludedGames || []).some(row => path.resolve(row.dir || '').toLowerCase() === gameDir.toLowerCase());
      if (excluded) return [];
      return [{ id: gameId, name: 'Fixture Game', launcher: 'manual', dir: gameDir, installed: normalInstalled,
        supported: api === 'dx12' && !options.noDlss, supportCode: options.noDlss ? 'ERR_NO_DLSS' : null, chosen, scan: { gameDir, chosen, exeCandidates: [chosen],
          primaryDlss: api === 'dx12' && !options.noDlss ? { name: 'nvngx_dlss.dll', path: path.join(gameDir, 'nvngx_dlss.dll') } : null,
          dlssFiles: [], reshade: { installed: false } } }];
    },
    dispose() {}
  };
  const service = createAppService({ userData: path.join(root, 'user-data'), resourcesPath: path.join(root, 'resources'), appDir: root,
    overrides: { library, installer, vulkan, feeder, nativeLaunchBroker: { async launch(input) { calls.native ||= []; calls.native.push(input);
      if (options.nativeLaunchError) throw options.nativeLaunchError; return { pid: 22, elevated: false }; } },
      detectGpu: () => ({ family: 'RTX50', series: ['RTX50'] }) } });
  return { root, gameDir, exe, configDir, addons, gameId, service, calls, vulkan, installer, owned,
    failRestore(error) { restoreFailure = error; }, setDiagnosis(value) { diagnosisComplete = value; } };
}

function writeNativeManifest(f, api = 'dx12') {
  const value = newManifest(f.gameDir, f.exe, api);
  fs.mkdirSync(path.dirname(manifestPath(f.gameDir)), { recursive: true });
  fs.writeFileSync(manifestPath(f.gameDir), JSON.stringify(value));
}

test('unified Vulkan deployment preview dispatches the fixed package and apply never calls the native installer', async t => {
  const f = fixture(t); await f.service.boot(); const before = f.service.store.read();
  const preview = await f.service.previewDeployment(f.gameId, { mode: 'external', api: 'vulkan', version: PACKAGE_ID });
  assert.equal(preview.api, 'vulkan'); assert.equal(preview.packageId, PACKAGE_ID);
  assert.ok(preview.changes.some(row => row.role === 'manager-api-preference'));
  assert.deepEqual(f.service.store.read(), before); assert.deepEqual(f.calls.installer, []);
  assert.equal((await f.service.applyDeployment(preview.planId)).installed, true);
  assert.deepEqual(f.calls.vulkan.filter(row => row[0] === 'install').map(row => row[2]), [{ api: 'vulkan', version: PACKAGE_ID, allowAntiCheat: false }]);
  assert.deepEqual(f.calls.installer, []);
  const removal = await f.service.previewUninstall(f.gameId, { mode: 'restore' });
  assert.deepEqual(removal.phases, ['vulkan-restore']); assert.equal(removal.changes[0].action, 'archive');
  await assert.rejects(f.service.previewDeployment(f.gameId, { mode: 'external', api: 'vulkan', loadingMode: 'helper' }), { code: 'SPECIAL_LOADING_MODE_LOCKED' });
});

test('Vulkan install, repair and upgrade keep the exact package route away from native installer and carrier', async t => {
  const f = fixture(t); await f.service.boot();
  await f.service.install(f.gameId, { version: PACKAGE_ID, allowAntiCheat: true });
  await f.service.repair(f.gameId, { version: PACKAGE_ID });
  await f.service.upgradeAddon(f.gameId, PACKAGE_ID, { allowAntiCheat: true });
  assert.deepEqual(f.calls.vulkan.filter(row => row[0] === 'install').map(row => row[2]), [
    { version: PACKAGE_ID, allowAntiCheat: true }, { version: PACKAGE_ID }, { allowAntiCheat: true, version: PACKAGE_ID }
  ]);
  assert.deepEqual(f.calls.installer, []);
});

test('native and Vulkan receipts require restore before route changes, while a saved Vulkan EXE binding survives refresh', async t => {
  for (const api of ['dx11', 'dx12']) {
    const f = fixture(t, { detectedApi: api, normalInstalled: true }); writeNativeManifest(f, api); await f.service.boot();
    const before = f.service.store.read();
    await assert.rejects(f.service.setGameApi(f.gameId, 'vulkan'), { code: 'VULKAN_RESTORE_FIRST' });
    assert.deepEqual(f.service.store.read().gameOverrides, before.gameOverrides);
  }
  const installed = fixture(t, { vulkanInstalled: true }); await installed.service.boot();
  await assert.rejects(installed.service.setGameApi(installed.gameId, 'dx12'), { code: 'VULKAN_RESTORE_FIRST' });

  const saved = fixture(t, { detectedApi: 'dx12' }); await saved.service.boot();
  await saved.service.setGameApi(saved.gameId, 'vulkan'); await saved.service.refresh();
  const state = saved.service.store.read(), binding = state.gameOverrides[path.resolve(saved.gameDir).toLowerCase()];
  assert.equal(binding.api, 'vulkan'); assert.equal(path.resolve(binding.apiExecutable), path.resolve(saved.exe));
  const visible = (await saved.service.listGames())[0]; assert.equal(visible.chosen.apiResolution.api, 'vulkan');
});

test('Vulkan uninstall and list removal restore first and never hide a failed recovery', async t => {
  const f = fixture(t, { vulkanInstalled: true }); await f.service.boot();
  f.failRestore(Object.assign(new Error('restore failed'), { code: 'VULKAN_RESTORE_FAILED' }));
  await assert.rejects(f.service.dismissGame(f.gameId), { code: 'VULKAN_RESTORE_FAILED' });
  assert.equal((await f.service.listGames()).length, 1);
  f.failRestore(null); await f.service.dismissGame(f.gameId);
  assert.equal((await f.service.listGames()).length, 0);
  assert.deepEqual(f.calls.installer, []);

  const uninstall = fixture(t, { vulkanInstalled: true }); await uninstall.service.boot();
  const result = await uninstall.service.uninstall(uninstall.gameId);
  assert.equal(result.restored, true); assert.equal(uninstall.owned.size, 0);
  assert.deepEqual(uninstall.calls.installer, []);
});

test('Vulkan launch uses its broker service only after diagnosis is complete', async t => {
  const f = fixture(t, { vulkanInstalled: true }); await f.service.boot();
  const diagnostic = await f.service.diagnose(f.gameId);
  assert.equal(diagnostic.complete, true);
  assert.equal(diagnostic.runtimeVerified, false);
  assert.equal(diagnostic.components.slice(0, 3).every(row => row.ok === true), true);
  assert.deepEqual(diagnostic.components.slice(3).map(row => row.ok), [null, null], 'unknown runtime evidence stays informational rather than damaged');
  assert.equal(await f.service.launch(f.gameId), true);
  assert.equal(f.calls.vulkan.filter(row => row[0] === 'broker-launch').length, 1);
  f.setDiagnosis(false);
  await assert.rejects(f.service.launch(f.gameId), { code: 'VULKAN_NOT_READY' });
  assert.equal(f.calls.vulkan.filter(row => row[0] === 'broker-launch').length, 1);
});

test('Vulkan NR settings and ReShade shortcut use the external profile instead of the game directory', async t => {
  const f = fixture(t, { vulkanInstalled: true }); await f.service.boot();
  assert.equal((await f.service.readNrSettings(f.gameId)).Style, 1);
  await f.service.writeNrSettings(f.gameId, { Style: 2 });
  assert.match(fs.readFileSync(path.join(f.addons, 'nr_before_sr.ini'), 'utf8'), /Style=2/);
  await f.service.writeGameHotkey(f.gameId, 'reshade', { key: 187, ctrl: true, shift: false, alt: false });
  assert.match(fs.readFileSync(path.join(f.configDir, 'ReShade.ini'), 'utf8'), /KeyOverlay=187,1,0,0/);
  assert.equal((await f.service.readGameHotkeys(f.gameId)).reshade.key, 187);
  // This route-only fixture intentionally has no Core/recipe receipt; a menu
  // version alone cannot authorize inferred defaults for an unknown binary.
  await assert.rejects(f.service.applyDefault(f.gameId), { code: 'ERR_BAD_REQUEST' });
  assert.equal((await f.service.readNrSettings(f.gameId)).contract.known, false);
  assert.equal(fs.existsSync(path.join(f.gameDir, 'nr_before_sr.ini')), false);
  assert.equal(fs.existsSync(path.join(f.gameDir, 'ReShade.ini')), false);
});

test('ordinary DX12 install and launch do not depend on a Vulkan package', async t => {
  const f = fixture(t, { detectedApi: 'dx12', vulkanAvailable: false }); await f.service.boot();
  await f.service.install(f.gameId, { version: '0.3.3.5' });
  assert.equal(f.calls.installer.filter(row => row[0] === 'install').length, 1);
  assert.equal(f.calls.vulkan.filter(row => row[0] === 'install').length, 0);
  assert.equal(await f.service.launch(f.gameId), true);
  assert.deepEqual(f.calls.native, [{ exe: f.exe, args: [], cwd: path.dirname(f.exe) }]);
  assert.equal(f.calls.vulkan.filter(row => row[0] === 'broker-launch').length, 0);
});

test('native launch never silently elevates a requires-administrator game', async t => {
  const f = fixture(t, { detectedApi: 'dx12', nativeLaunchError: Object.assign(new Error('Vulkan-specific old message'), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' }) });
  await f.service.boot();
  await assert.rejects(f.service.launch(f.gameId), error => error.code === 'GAME_LAUNCH_REQUIRES_ELEVATION' && /游戏明确要求管理员权限/.test(error.message) && !/Vulkan/.test(error.message));
});

test('broken Vulkan binding still exports the failure when its configuration path cannot be read', async t => {
  const f=fixture(t,{vulkanInstalled:true});await f.service.boot();
  const broken=()=>{throw Object.assign(new Error('Vulkan 绑定损坏，请保留恢复记录'),{code:'VULKAN_BINDING_INVALID'});};
  f.vulkan.configDir=broken;f.vulkan.diagnose=broken;
  const report=await f.service.collectFeedback(f.gameId);
  assert.match(report.text,/Vulkan 绑定损坏/);assert.match(report.text,/反馈日志/);
});

test('no-DLSS preparation, repair, settings, diagnosis, launch and restore keep their independent Feeder owner', async t => {
  const f = fixture(t, { detectedApi: 'dx12', noDlss: true, feeder: true }); await f.service.boot();
  const before = (await f.service.listGames())[0]; assert.equal(before.supportCode, 'ERR_NO_DLSS'); assert.equal(before.nativeDlssAvailable, false); assert.equal(before.nativeFgAvailable, false);
  await f.service.installFeeder(f.gameId, { allowAntiCheat: true }); await f.service.repair(f.gameId);
  const after = (await f.service.listGames())[0]; assert.equal(after.enhancementRoute, 'feeder-dx12'); assert.equal(after.installed, true); assert.equal(after.supportCode, 'ERR_NO_DLSS');
  await f.service.writeNrSettings(f.gameId, { Style: 2 }); assert.match(fs.readFileSync(path.join(f.addons, 'nr_before_sr.ini'), 'utf8'), /Style=2/);
  const diagnosis = await f.service.diagnose(f.gameId); assert.equal(diagnosis.enhancementRoute, 'feeder-dx12'); assert.equal(diagnosis.complete, true); assert.equal(diagnosis.runtimeVerified, false);
  assert.equal((await f.service.inspectFeeder(f.gameId)).processed, 'unknown');
  for (const change of [() => f.service.setGameApi(f.gameId, 'vulkan'), () => f.service.upgradeAddon(f.gameId, '0.3.3.5'), () => f.service.toggleD3D12(f.gameId, true)])
    await assert.rejects(change(), { code: 'FEEDER_RESTORE_FIRST' });
  await f.service.launch(f.gameId); assert.equal(f.calls.feeder.filter(row => row[0] === 'launch').length, 1);
  assert.deepEqual(f.calls.installer, []); assert.deepEqual(f.calls.vulkan, []); assert.equal(f.calls.native, undefined);
  await f.service.uninstall(f.gameId); assert.equal((await f.service.listGames())[0].installed, false);
});

test('the Feeder entry rejects unsupported options and preserves existing Vulkan/native ownership', async t => {
  const f = fixture(t, { detectedApi: 'dx12', noDlss: true, feeder: true }); await f.service.boot();
  for (const options of [{ version: 'other' }, { allowAntiCheat: 'yes' }, []]) await assert.rejects(f.service.installFeeder(f.gameId, options), { code: 'ERR_BAD_REQUEST' });
  writeNativeManifest(f); await assert.rejects(f.service.installFeeder(f.gameId), { code: 'FEEDER_ROUTE_CONFLICT' }); assert.equal(f.calls.feeder, undefined);
  const vk = fixture(t, { detectedApi: 'dx12', noDlss: true, feeder: true, vulkanInstalled: true }); await vk.service.boot();
  await assert.rejects(vk.service.installFeeder(vk.gameId), { code: 'VULKAN_RESTORE_FIRST' }); assert.equal(vk.calls.feeder, undefined);
});
