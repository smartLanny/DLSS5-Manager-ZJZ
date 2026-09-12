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
const {
  DX11_COMPAT_VERSION,
  DX11_COMPAT_LABEL,
  DX11_COMPAT_CARRIER,
  PAYLOAD_FILES,
  INSTALLED_NAMES
} = require('../src/product/constants');
const journal = require('../src/core/file-journal');

const STABLE_VERSION = '0.3.3.5';

function makePayload(t, root, { corrupt = false } = {}) {
  const payloadRoot = path.join(root, 'resources', 'payload', 'nr-before-sr');
  for (const family of ['RTX40', 'RTX50']) {
    const dir = path.join(payloadRoot, 'fixed', family);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.reshade), 'PE64 ReShade Searching for add-ons');
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.bridge), `${family}:nrchain`);
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.runtime), `${family}:runtime`);
  }

  const stable = path.join(payloadRoot, 'versions', STABLE_VERSION);
  const compat = path.join(payloadRoot, 'versions', DX11_COMPAT_VERSION);
  fs.mkdirSync(stable, { recursive: true });
  fs.mkdirSync(compat, { recursive: true });
  fs.writeFileSync(path.join(stable, PAYLOAD_FILES.addon), 'stable:addon');
  fs.writeFileSync(path.join(stable, PAYLOAD_FILES.config), 'stable:config');
  fs.writeFileSync(path.join(compat, PAYLOAD_FILES.addon), 'compat:addon');
  fs.writeFileSync(path.join(compat, PAYLOAD_FILES.config), 'compat:config');
  fs.writeFileSync(path.join(compat, PAYLOAD_FILES.bridge), 'compat:nrchain');
  fs.writeFileSync(path.join(compat, DX11_COMPAT_CARRIER), 'compat:carrier');

  const bundle = createCompactBundle(payloadRoot, [
    { id: STABLE_VERSION, label: 'stable' },
    { id: DX11_COMPAT_VERSION, label: DX11_COMPAT_LABEL, compatibility: 'dx11', ota: true }
  ], STABLE_VERSION);
  fs.writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify(bundle));
  if (corrupt) fs.appendFileSync(path.join(compat, PAYLOAD_FILES.addon), '\ntampered');

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return payloadRoot;
}

function findFiles(root, wantedName) {
  const found = [];
  function visit(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name === wantedName) found.push(file);
    }
  }
  visit(root);
  return found;
}

function makeService(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-watchdogs-legion-'));
  const gameDir = path.join(root, 'Watch Dogs Legion');
  const exeDir = path.join(gameDir, 'Binaries', 'Win64');
  const exe = path.join(exeDir, 'WatchDogsLegion.exe');
  const alternateExe = path.join(exeDir, 'WatchDogsLegion_dx12.exe');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(exe, 'screenshot fixture executable');
  fs.writeFileSync(alternateExe, 'alternate screenshot fixture executable');

  const nativeDlss = path.join(gameDir, 'nvngx_dlss.dll');
  if (options.hasDlss !== false) fs.writeFileSync(nativeDlss, 'native game DLSS');
  const payloadDir = makePayload(t, root, options);

  const candidate = (file, name) => ({
    path: file,
    rel: path.relative(gameDir, file),
    name,
    size: 1,
    api: 'dxgi',
    apiLabel: 'DirectX (DXGI)',
    bitness: options.bitness || 64,
    via: 'imports'
  });
  const first = candidate(exe, 'WatchDogsLegion.exe');
  const second = candidate(alternateExe, 'WatchDogsLegion_dx12.exe');
  const scan = {
    gameDir,
    exeCandidates: [first, second],
    chosen: first,
    dlssFiles: options.hasDlss === false ? [] : [{ path: nativeDlss, name: 'nvngx_dlss.dll', bitness: 64 }],
    primaryDlss: options.hasDlss === false ? null : { path: nativeDlss, name: 'nvngx_dlss.dll', bitness: 64 },
    emulator: null,
    reshade: { installed: false }
  };
  const scanModule = {
    async scanGame() { return structuredClone(scan); },
    selectPrimaryDlss(files) { return files[0] || null; },
    inspectReShade(dir) {
      const file = path.join(dir, INSTALLED_NAMES.reshade);
      return fs.existsSync(file)
        ? { installed: true, file: INSTALLED_NAMES.reshade, addonSupport: fs.readFileSync(file).includes('Searching for add-ons') }
        : { installed: false, file: null, addonSupport: false };
    }
  };
  const library = createLibraryService({
    scan: scanModule,
    library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
  });
  const installer = createInstaller({
    journal,
    scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  const serviceOptions = {
    userData: path.join(root, 'user-data'),
    resourcesPath: path.join(root, 'resources'),
    appDir: root,
    version: '0.4.5',
    overrides: {
      library,
      installer,
      detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' })
    }
  };
  return {
    root,
    gameDir,
    exeDir,
    exe,
    alternateExe,
    payloadDir,
    service: createAppService(serviceOptions),
    freshService: () => createAppService(serviceOptions)
  };
}

test('Watch Dogs Legion DXGI evidence waits for the bound EXE and keeps the DX12 compatibility route coherent', async t => {
  const f = makeService(t);
  const oldCarrier = path.join(f.exeDir, 'r3-nr-native-neutral.addon64');
  const bridge = path.join(f.exeDir, INSTALLED_NAMES.bridge);
  fs.writeFileSync(oldCarrier, 'old carrier from a previous manager');
  fs.writeFileSync(bridge, 'existing nrchain');

  await f.service.addManualGame(f.gameDir);
  let boot = await f.service.boot();
  const id = boot.games[0].id;
  assert.equal(boot.games[0].chosen.path, f.exe);
  assert.equal(boot.games[0].chosen.api, 'dxgi');
  assert.equal(boot.games[0].chosen.apiLabel, 'DirectX (DXGI)');
  assert.equal(boot.games[0].chosen.via, 'imports');
  assert.equal(boot.games[0].chosen.apiResolution.api, 'unknown');
  assert.equal(boot.games[0].supportCode, 'ERR_API_SELECTION_REQUIRED');
  await assert.rejects(f.service.install(id, { version: DX11_COMPAT_VERSION }), { code: 'ERR_API_SELECTION_REQUIRED' });

  await f.service.setGameApi(id, 'dx12');
  boot = await f.service.boot();
  assert.equal(boot.games[0].apiOverride, 'dx12');
  assert.equal(boot.games[0].chosen.apiResolution.api, 'dx12');

  const installed = await f.service.install(id, { version: DX11_COMPAT_VERSION });
  assert.equal(installed.complete, true);
  assert.equal(fs.readFileSync(bridge, 'utf8'), 'compat:nrchain');
  assert.equal(fs.existsSync(path.join(f.exeDir, DX11_COMPAT_CARRIER)), false, 'DX12 does not deploy the compatibility carrier');
  assert.equal(fs.existsSync(oldCarrier), false, 'the old carrier leaves the active game directory');
  const carrierBackups = findFiles(path.join(f.gameDir, '_DLSS5_Backup', 'conflicts'), path.basename(oldCarrier));
  assert.equal(carrierBackups.length, 1);
  assert.equal(fs.readFileSync(carrierBackups[0], 'utf8'), 'old carrier from a previous manager');

  boot = await f.service.refresh();
  assert.equal(boot[0].addonVersion, DX11_COMPAT_VERSION);
  assert.equal(boot[0].apiOverride, 'dx12');
  assert.equal(boot[0].chosen.apiResolution.api, 'dx12');
  const freshBoot = await f.freshService().boot();
  assert.equal(freshBoot.games[0].addonVersion, DX11_COMPAT_VERSION);
  assert.equal(freshBoot.games[0].apiOverride, 'dx12');
  assert.equal(freshBoot.games[0].chosen.apiResolution.api, 'dx12');

  const switched = await f.service.addManualSelection({
    root: f.gameDir,
    executable: f.alternateExe,
    name: 'Watch Dogs Legion'
  });
  assert.equal(switched[0].chosen.path, f.alternateExe);
  assert.equal(switched[0].apiOverride, 'auto', 'an API choice is bound to the selected EXE');
  assert.equal(switched[0].chosen.apiResolution.api, 'unknown');
  assert.equal(switched[0].supportCode, 'ERR_API_SELECTION_REQUIRED');
  const switchedFresh = await f.freshService().boot();
  assert.equal(switchedFresh.games[0].chosen.path, f.alternateExe);
  assert.equal(switchedFresh.games[0].apiOverride, 'auto');
  assert.equal(switchedFresh.games[0].supportCode, 'ERR_API_SELECTION_REQUIRED');
});

test('Watch Dogs Legion DX11 rejects the old stable core and accepts only the explicit matched compatibility core', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir);
  let boot = await f.service.boot();
  const id = boot.games[0].id;

  await f.service.setGameApi(id, 'dx11');
  boot = await f.service.boot();
  assert.equal(boot.games[0].chosen.apiResolution.api, 'dx11');
  assert.equal(boot.games[0].supportCode, null);
  await assert.rejects(f.service.install(id, { version: STABLE_VERSION }), { code: 'ERR_UNSUPPORTED_API' });
  boot = await f.service.boot();
  assert.equal(boot.games[0].installed, false);
  assert.equal(fs.existsSync(path.join(f.exeDir, DX11_COMPAT_CARRIER)), false);

  const installed = await f.service.install(id, { version: DX11_COMPAT_VERSION });
  assert.equal(installed.complete, true);
  assert.equal(fs.readFileSync(path.join(f.exeDir, INSTALLED_NAMES.bridge), 'utf8'), 'compat:nrchain');
  assert.equal(fs.readFileSync(path.join(f.exeDir, DX11_COMPAT_CARRIER), 'utf8'), 'compat:carrier');
  boot = await f.service.boot();
  assert.equal(boot.games[0].addonVersion, DX11_COMPAT_VERSION);
  assert.equal(boot.games[0].chosen.apiResolution.api, 'dx11');
});

test('explicit DX12 selection cannot bypass x64, native DLSS, or payload integrity guards', async t => {
  const cases = [
    { name: '32-bit executable', options: { bitness: 32 }, code: 'ERR_UNSUPPORTED_BITNESS' },
    { name: 'missing native DLSS', options: { hasDlss: false }, code: 'ERR_NO_DLSS' },
    { name: 'corrupt compatibility payload', options: { corrupt: true }, code: 'ERR_PAYLOAD_HASH' }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async tCase => {
      const f = makeService(tCase, scenario.options);
      await f.service.addManualGame(f.gameDir);
      let boot = await f.service.boot();
      const id = boot.games[0].id;
      await f.service.setGameApi(id, 'dx12');
      boot = await f.service.boot();
      assert.equal(boot.games[0].chosen.apiResolution.api, 'dx12');
      if (scenario.options.corrupt) {
        const version = f.service.listAddonVersions().find(item => item.id === DX11_COMPAT_VERSION);
        assert.equal(version.ready, false);
      }
      await assert.rejects(f.service.install(id, { version: DX11_COMPAT_VERSION }), { code: scenario.code });
      boot = await f.service.boot();
      assert.equal(boot.games[0].installed, false);
    });
  }
});
