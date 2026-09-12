'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/product/app-service');
const { createLibraryService } = require('../src/product/library-service');
const { createInstaller } = require('../src/product/installer');
const { createCompactBundle } = require('../src/product/payload');
const { PAYLOAD_FILES, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const journal = require('../src/core/file-journal');

const OLD = '0.4.6-hotfix.1';
const CURRENT = '0.4.7beta';
const VK_PACKAGE = 'rdr2-vulkan-package-r5';

function xml(api) {
  return `<rage__fwuiSystemSettingsCollection><advancedGraphics><API>kSettingAPI_${api}</API></advancedGraphics></rage__fwuiSystemSettingsCollection>`;
}

function makePayload(root) {
  const payloadRoot = path.join(root, 'resources', 'payload', 'nr-before-sr');
  for (const family of ['RTX40', 'RTX50']) {
    const fixed = path.join(payloadRoot, 'fixed', family);
    fs.mkdirSync(fixed, { recursive: true });
    fs.writeFileSync(path.join(fixed, PAYLOAD_FILES.reshade), 'ReShade Searching for add-ons');
    fs.writeFileSync(path.join(fixed, PAYLOAD_FILES.bridge), `${family}:shared-bridge`);
    fs.writeFileSync(path.join(fixed, PAYLOAD_FILES.runtime), `${family}:runtime`);
  }
  for (const version of [OLD, CURRENT]) {
    const dir = path.join(payloadRoot, 'versions', version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.addon), `${version}:core`);
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.config), `${version}:config`);
    fs.writeFileSync(path.join(dir, DX11_COMPAT_CARRIER), `${version}:carrier`);
  }
  const bundle = createCompactBundle(payloadRoot, [
    { id: OLD, label: 'native 046', compatibility: 'dx11' },
    { id: CURRENT, label: 'native 047', compatibility: 'dx11' }
  ], CURRENT);
  fs.writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify(bundle));
  return payloadRoot;
}

function makeVulkan(options = {}) {
  const calls = [];
  return {
    calls,
    summary(game) {
      return { installed: options.installed === true, available: true, needsRecovery: false,
        packageId: VK_PACKAGE, coreVersion: 'vulkan-core-r5', status: options.installed ? 'installed' : 'absent' };
    },
    async install(game, request) {
      calls.push({ game, request: { ...request } });
      if (options.installError) throw options.installError;
      return { installed: true, packageId: VK_PACKAGE, coreVersion: 'vulkan-core-r5' };
    },
    async restore() { return { restored: true }; },
    async diagnose() { return { installed: options.installed === true, ready: true, components: {} }; },
    configDir() { return null; }
  };
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-route-apply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  makePayload(root);
  const gameDir = path.join(root, options.rdr2 ? 'Steam-RDR2' : 'GenericGame');
  const exeDir = options.rdr2 ? gameDir : path.join(gameDir, 'Binaries', 'Win64');
  const exe = path.join(exeDir, options.rdr2 ? 'RDR2.exe' : 'Game.exe');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(exe, 'x64 fixture executable');
  const documentsDir = path.join(root, 'KnownDocuments');
  const settingsFile = path.join(documentsDir, 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  if (options.rdr2) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, xml(options.initialApi || 'Vulkan'));
  }
  const candidate = {
    path: exe, rel: path.relative(gameDir, exe), name: path.basename(exe), size: fs.statSync(exe).size,
    api: 'dxgi', apiLabel: options.rdr2 ? 'DirectX 12 / Vulkan' : 'DirectX 11/12', bitness: 64,
    dx12: false
  };
  const rawScan = {
    gameDir, exeCandidates: [candidate], chosen: candidate,
    dlssFiles: [{ path: path.join(gameDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 }],
    primaryDlss: { path: path.join(gameDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 },
    emulator: null, reshade: { installed: false }
  };
  const scanModule = {
    async scanGame() { return structuredClone(rawScan); },
    selectPrimaryDlss(files) { return files[0] || null; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file)
        ? { installed: true, file: 'dxgi.dll', addonSupport: true }
        : { installed: false, file: null, addonSupport: false };
    }
  };
  const discovered = options.rdr2
    ? { launcher: 'Steam', id: '1174180', name: 'Red Dead Redemption 2', dir: gameDir, poster: null }
    : { launcher: 'Local', id: 'generic', name: 'Generic Game', dir: gameDir, poster: null };
  const library = createLibraryService({ documentsDir, scan: scanModule,
    library: { discover: () => ({ games: [discovered], roots: [] }), dedupe: rows => rows } });
  const realInstaller = createInstaller({ journal, scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} }, pe: { getBitness: () => 64 } });
  const vulkan = options.vulkan || makeVulkan();
  const service = createAppService({
    userData: path.join(root, 'user-data'), resourcesPath: path.join(root, 'resources'), appDir: root, documentsDir,
    overrides: { library, installer: options.installer || realInstaller, vulkan,
      assertGameClosed: options.assertGameClosed || (async () => {}),
      detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' }) }
  });
  return { root, gameDir, exeDir, exe, documentsDir, settingsFile, rawScan, library, realInstaller, vulkan, service };
}

async function bootOne(f) {
  const boot = await f.service.boot();
  assert.equal(boot.games.length, 1);
  return boot.games[0];
}

test('one apply installs the explicitly selected 047 core and follows the DX12/DX11 carrier route', async t => {
  const f = fixture(t);
  const game = await bootOne(f);
  const core = path.join(f.exeDir, PAYLOAD_FILES.addon);
  const carrier = path.join(f.exeDir, DX11_COMPAT_CARRIER);

  const dx12 = await f.service.applyGameRoute(game.id, { api: 'dx12', version: CURRENT });
  assert.deepEqual(dx12.appliedRoute, { api: 'dx12', version: CURRENT, gameSettingsSynced: false });
  assert.equal(fs.readFileSync(core, 'utf8'), `${CURRENT}:core`);
  assert.equal(fs.existsSync(carrier), false);

  const dx11 = await f.service.applyGameRoute(game.id, { api: 'dx11', version: CURRENT });
  assert.deepEqual(dx11.appliedRoute, { api: 'dx11', version: CURRENT, gameSettingsSynced: false });
  assert.equal(fs.readFileSync(core, 'utf8'), `${CURRENT}:core`);
  assert.equal(fs.readFileSync(carrier, 'utf8'), `${CURRENT}:carrier`);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json')));
  assert.equal(manifest.payloadVersion, CURRENT);
  assert.equal(manifest.deploymentApi, 'dx11');
});

test('changing API on an installed native 046 receipt passes the requested 047 payload into repair', async t => {
  const f = fixture(t);
  const game = await bootOne(f);
  await f.service.applyGameRoute(game.id, { api: 'dx11', version: OLD });
  const calls = [];
  const repair = f.realInstaller.repair;
  f.realInstaller.repair = async request => { calls.push({ version: request.payload.version, api: request.scan.chosen.apiResolution.api }); return repair(request); };

  await f.service.applyGameRoute(game.id, { api: 'dx12', version: CURRENT });
  assert.deepEqual(calls, [{ version: CURRENT, api: 'dx12' }]);
  assert.equal(fs.readFileSync(path.join(f.exeDir, PAYLOAD_FILES.addon), 'utf8'), `${CURRENT}:core`);
  assert.equal(fs.existsSync(path.join(f.exeDir, DX11_COMPAT_CARRIER)), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json')));
  assert.equal(manifest.payloadVersion, CURRENT);
  assert.equal(manifest.deploymentApi, 'dx12');
});

test('RDR2 route and XML commit together; install and transient store failures restore both', async t => {
  const successfulCalls = [];
  const successInstaller = { async install(request) { successfulCalls.push(request); return { complete: true }; } };
  const success = fixture(t, { rdr2: true, initialApi: 'Vulkan', installer: successInstaller });
  const successGame = await bootOne(success);
  assert.equal(successGame.chosen.apiSettings.canSync, true, JSON.stringify(success.service.gameScan(successGame.id).chosen.apiSettings));
  const applied = await success.service.applyGameRoute(successGame.id, { api: 'dx12', version: CURRENT });
  assert.equal(applied.appliedRoute.gameSettingsSynced, true);
  assert.match(fs.readFileSync(success.settingsFile, 'utf8'), /kSettingAPI_DX12/);
  assert.equal((await bootOne(success)).apiOverride, 'dx12');
  assert.equal(successfulCalls[0].scan.chosen.apiResolution.api, 'dx12');

  const installFailure = fixture(t, { rdr2: true, initialApi: 'Vulkan', installer: {
    async install() { throw Object.assign(new Error('injected install failure'), { code: 'INSTALL_FAILED' }); }
  } });
  const failedGame = await bootOne(installFailure);
  const failedState = installFailure.service.store.read();
  await assert.rejects(installFailure.service.applyGameRoute(failedGame.id, { api: 'dx12', version: CURRENT }), { code: 'INSTALL_FAILED' });
  assert.match(fs.readFileSync(installFailure.settingsFile, 'utf8'), /kSettingAPI_Vulkan/);
  assert.deepEqual(installFailure.service.store.read().gameOverrides, failedState.gameOverrides);

  const storeFailure = fixture(t, { rdr2: true, initialApi: 'Vulkan', installer: successInstaller });
  const storeGame = await bootOne(storeFailure);
  const originalWrite = storeFailure.service.store.write;
  let writes = 0;
  storeFailure.service.store.write = patch => ++writes === 1
    ? Promise.reject(Object.assign(new Error('transient settings failure'), { code: 'SETTINGS_STORE_WRITE_FAILED' }))
    : originalWrite(patch);
  await assert.rejects(storeFailure.service.applyGameRoute(storeGame.id, { api: 'dx12', version: CURRENT }), { code: 'SETTINGS_STORE_WRITE_FAILED' });
  assert.match(fs.readFileSync(storeFailure.settingsFile, 'utf8'), /kSettingAPI_Vulkan/);
  assert.deepEqual(storeFailure.service.store.read().gameOverrides, {});
});

test('rollback retains an externally edited RDR2 XML while restoring the saved API preference', async t => {
  let settingsFile;
  const installer = { async install() {
    fs.writeFileSync(settingsFile, '<external-editor-owned/>');
    throw Object.assign(new Error('failure after external edit'), { code: 'INSTALL_FAILED' });
  } };
  const f = fixture(t, { rdr2: true, initialApi: 'Vulkan', installer });
  settingsFile = f.settingsFile;
  const game = await bootOne(f);
  await assert.rejects(f.service.applyGameRoute(game.id, { api: 'dx12', version: CURRENT }), error => {
    assert.equal(error.code, 'INSTALL_FAILED');
    assert.equal(error.details.gameApiRollbackFailed, true);
    assert.equal(error.details.gameApiExternalChangeRetained, true);
    return true;
  });
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '<external-editor-owned/>');
  assert.deepEqual(f.service.store.read().gameOverrides, {});
});

test('a running RDR2 blocks synchronization before XML, preference, or plugin installation changes', async t => {
  let installs = 0;
  const f = fixture(t, { rdr2: true, initialApi: 'Vulkan',
    assertGameClosed: async () => { throw Object.assign(new Error('game is running'), { code: 'ERR_GAME_RUNNING' }); },
    installer: { async install() { installs++; return { complete: true }; } } });
  const game = await bootOne(f);
  const beforeXml = fs.readFileSync(f.settingsFile);
  const beforePreferences = f.service.store.read().gameOverrides;

  await assert.rejects(f.service.applyGameRoute(game.id, { api: 'dx12', version: CURRENT }), { code: 'ERR_GAME_RUNNING' });
  assert.deepEqual(fs.readFileSync(f.settingsFile), beforeXml);
  assert.deepEqual(f.service.store.read().gameOverrides, beforePreferences);
  assert.equal(installs, 0);
  assert.equal(fs.existsSync(path.join(f.exeDir, PAYLOAD_FILES.addon)), false);
});

test('existing native and Vulkan ownership reject cross-route apply before preferences or RDR2 XML change', async t => {
  const native = fixture(t, { rdr2: true, initialApi: 'Vulkan' });
  const nativeGame = await bootOne(native);
  await native.service.applyGameRoute(nativeGame.id, { api: 'dx12', version: CURRENT });
  const nativeXml = fs.readFileSync(native.settingsFile);
  const nativePrefs = native.service.store.read().gameOverrides;
  await assert.rejects(native.service.applyGameRoute(nativeGame.id, { api: 'vulkan', version: VK_PACKAGE }), { code: 'VULKAN_RESTORE_FIRST' });
  assert.deepEqual(fs.readFileSync(native.settingsFile), nativeXml);
  assert.deepEqual(native.service.store.read().gameOverrides, nativePrefs);

  const ownedVulkan = makeVulkan({ installed: true });
  const vk = fixture(t, { rdr2: true, initialApi: 'Vulkan', vulkan: ownedVulkan });
  const vkGame = await bootOne(vk);
  const key = path.resolve(vk.gameDir).toLowerCase();
  await vk.service.store.write({ gameOverrides: { [key]: { api: 'vulkan', apiExecutable: vk.exe } } });
  await vk.service.refresh();
  const vkXml = fs.readFileSync(vk.settingsFile);
  const vkPrefs = vk.service.store.read().gameOverrides;
  await assert.rejects(vk.service.applyGameRoute(vkGame.id, { api: 'dx12', version: CURRENT }), { code: 'VULKAN_RESTORE_FIRST' });
  assert.deepEqual(fs.readFileSync(vk.settingsFile), vkXml);
  assert.deepEqual(vk.service.store.read().gameOverrides, vkPrefs);
});

test('Vulkan accepts only its exact package id and never treats native 047 as a Vulkan core', async t => {
  const vulkan = makeVulkan();
  const f = fixture(t, { rdr2: true, initialApi: 'DX12', vulkan, installer: { async install() { throw new Error('native path must not run'); } } });
  const game = await bootOne(f);
  await assert.rejects(f.service.applyGameRoute(game.id, { api: 'vulkan', version: CURRENT }), { code: 'VULKAN_PACKAGE_MISMATCH' });
  assert.match(fs.readFileSync(f.settingsFile, 'utf8'), /kSettingAPI_DX12/);
  assert.deepEqual(f.service.store.read().gameOverrides, {});

  const applied = await f.service.applyGameRoute(game.id, { api: 'vulkan', version: VK_PACKAGE });
  assert.equal(applied.appliedRoute.version, VK_PACKAGE);
  assert.equal(vulkan.calls.length, 1);
  assert.equal(vulkan.calls[0].request.version, VK_PACKAGE);
  assert.equal(vulkan.calls[0].game.scan.chosen.apiResolution.api, 'vulkan');
  assert.match(fs.readFileSync(f.settingsFile, 'utf8'), /kSettingAPI_Vulkan/);
});

test('auto rereads current RDR2 settings and does not install using a stale scanned API', async t => {
  const calls = [];
  const installer = { async install(request) { calls.push(request); return { complete: true }; } };
  const f = fixture(t, { rdr2: true, initialApi: 'Vulkan', installer });
  const stale = await bootOne(f);
  assert.equal(stale.chosen.detectedApi, 'vulkan');
  fs.writeFileSync(f.settingsFile, xml('DX12'));

  const result = await f.service.applyGameRoute(stale.id, { api: 'auto', version: CURRENT });
  assert.equal(result.appliedRoute.api, 'dx12');
  assert.equal(result.appliedRoute.gameSettingsSynced, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scan.chosen.apiResolution.api, 'dx12');
  const refreshed = await bootOne(f);
  assert.equal(refreshed.apiOverride, 'auto');
  assert.equal(refreshed.chosen.apiResolution.api, 'dx12');
});
