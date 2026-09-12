'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/product/app-service');
const { createLibraryService } = require('../src/product/library-service');
const { createInstaller } = require('../src/product/installer');
const { INSTALLED_NAMES } = require('../src/product/constants');
const realJournal = require('../src/core/file-journal');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REAL_046_OTA = path.resolve(PROJECT_ROOT, '..', 'beta046-ota-20260908',
  'DLSS5-AI渲染超分版-0.4.6-@野生的装机宅-Bilibili-OTA.zip');
const HASHES = Object.freeze({
  core046: 'b68f2709a131c9ce0513b6366dbcc2e7d551bef5bcd41934075407378a48c090',
  core045: 'ffea8e3a92cf07388f71b1855f3157c9c959a7a094b6f1a35cb92c57bf2f06f9',
  carrier046: '8268ba3a9d7614ca0e0efad22f7c477780547224dfd0847a1d67188fc05f13c0',
  carrier045: 'f825ccc47c2bdf3e365606ba44760371f74ac0ec0fabbc0565ae98864fca05ce',
  bridge: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function historicalPayloadFixture(root) {
  const resources = path.join(root, 'resources');
  const source = path.join(PROJECT_ROOT, 'payload');
  fs.cpSync(source, path.join(resources, 'payload'), { recursive: true });
  const payload = path.join(resources, 'payload', 'nr-before-sr');
  const versionDir = path.join(payload, 'versions', '0.4.5-ota');
  const bundleFile = path.join(payload, 'bundle.json');
  const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  // This is an isolated historical deployment fixture. Current production
  // catalog supersession is covered by app-service-routing.test.js.
  delete bundle.supersededVersions;
  const names = ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini', 'nrchain_nvngx.dll',
    'dlss5-native-carrier-045-dx11-compat.addon64'];
  bundle.versions['0.4.5-ota'] = {
    label: '0.4.5 historical rollback fixture',
    notes: 'Test-only historical catalog entry.',
    source: 'isolated test fixture', compatibility: 'dx11', ota: true,
    files: Object.fromEntries(names.map(name => [name, sha256(path.join(versionDir, name))]))
  };
  const releaseDir = path.join(payload, 'versions', '0.4.6');
  bundle.versions['0.4.6'] = {
    label: '0.4.6 historical release fixture', notes: 'Test-only historical catalog entry.',
    source: 'isolated test fixture', compatibility: 'dx11', ota: true,
    files: Object.fromEntries(names.map(name => [name, sha256(path.join(releaseDir, name))]))
  };
  fs.writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  return resources;
}

function makeService(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-release046-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourcesPath = historicalPayloadFixture(root);
  const gameDir = path.join(root, 'game');
  const exeDir = path.join(gameDir, 'Binaries', 'Win64');
  fs.mkdirSync(exeDir, { recursive: true });
  const exe = path.join(exeDir, 'Game.exe');
  fs.writeFileSync(exe, 'non-executable test fixture');
  fs.writeFileSync(path.join(exeDir, INSTALLED_NAMES.config), '[NRBeforeSR]\nUserSetting=keep-me\n');

  const scan = {
    gameDir,
    exeCandidates: [{ path: exe, rel: 'Binaries\\Win64\\Game.exe', name: 'Game.exe', size: 1,
      api: 'dxgi', apiLabel: 'DirectX 11/12', bitness: 64, dx12: false }],
    chosen: { path: exe, rel: 'Binaries\\Win64\\Game.exe', name: 'Game.exe', size: 1,
      api: 'dxgi', apiLabel: 'DirectX 11/12', bitness: 64, dx12: false },
    dlssFiles: [{ path: path.join(gameDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 }],
    primaryDlss: { path: path.join(gameDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 },
    emulator: null,
    reshade: { installed: false }
  };
  const scanModule = {
    async scanGame() { return structuredClone(scan); },
    selectPrimaryDlss(files) { return files[0] || null; },
    inspectReShade(dir) {
      const file = path.join(dir, INSTALLED_NAMES.reshade);
      return fs.existsSync(file)
        ? { installed: true, file: INSTALLED_NAMES.reshade,
          addonSupport: fs.readFileSync(file).includes('Searching for add-ons') }
        : { installed: false, file: null, addonSupport: false };
    }
  };
  const library = createLibraryService({
    scan: scanModule,
    library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
  });
  let failManifestWrite = false;
  const journal = {
    ...realJournal,
    async atomicJson(file, data) {
      if (failManifestWrite && path.basename(file) === 'xiaofeng-manager.json' &&
          path.basename(path.dirname(file)) === '_DLSS5_Backup') {
        throw Object.assign(new Error('injected manifest write failure'), { code: 'EIO' });
      }
      return realJournal.atomicJson(file, data);
    }
  };
  const installer = createInstaller({
    journal,
    scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  const service = createAppService({
    userData: path.join(root, 'user-data'), resourcesPath, appDir: PROJECT_ROOT, version: '0.4.6',
    overrides: { library, installer,
      detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' }) }
  });
  return { root, gameDir, exeDir, service, armManifestWriteFailure: () => { failManifestWrite = true; } };
}

test('real 0.4.6 payload and OTA deploy as an API-routed set and journal rollback restores 0.4.5',
  { skip: !fs.existsSync(REAL_046_OTA) }, async t => {
    const f = makeService(t);
    await f.service.addManualGame(f.gameDir);
    const id = (await f.service.boot()).games[0].id;
    const files = {
      core: path.join(f.exeDir, INSTALLED_NAMES.addon),
      bridge: path.join(f.exeDir, INSTALLED_NAMES.bridge),
      carrier: path.join(f.exeDir, INSTALLED_NAMES.carrier),
      config: path.join(f.exeDir, INSTALLED_NAMES.config),
      manifest: path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json')
    };
    const originalIni = fs.readFileSync(files.config);

    await f.service.setGameApi(id, 'dx12');
    await f.service.install(id, { version: '0.4.6' });
    assert.equal(sha256(files.core), HASHES.core046);
    assert.equal(sha256(files.bridge), HASHES.bridge);
    assert.equal(fs.existsSync(files.carrier), false);
    assert.deepEqual(fs.readFileSync(files.config), originalIni);

    await f.service.setGameApi(id, 'dx11');
    await f.service.repair(id, { version: '0.4.6' });
    assert.equal(sha256(files.carrier), HASHES.carrier046);
    await f.service.setGameApi(id, 'dx12');
    assert.equal(fs.existsSync(files.carrier), false);
    assert.equal(sha256(files.core), HASHES.core046);
    assert.equal(sha256(files.bridge), HASHES.bridge);
    await f.service.setGameApi(id, 'dx11');
    assert.equal(sha256(files.carrier), HASHES.carrier046);

    await f.service.repair(id, { version: '0.4.5-ota' });
    assert.equal(sha256(files.core), HASHES.core045);
    assert.equal(sha256(files.carrier), HASHES.carrier045);
    const versions = await f.service.importAddonFile(REAL_046_OTA);
    const imported = versions.find(row => row.source === 'imported' && row.otaManifest?.version === 'beta0.4.6');
    assert.ok(imported);
    await f.service.upgradeAddon(id, imported.id);
    assert.equal(sha256(files.core), HASHES.core046);
    assert.equal(sha256(files.bridge), HASHES.bridge);
    assert.equal(sha256(files.carrier), HASHES.carrier046);
    assert.deepEqual(fs.readFileSync(files.config), originalIni);

    await f.service.repair(id, { version: '0.4.5-ota' });
    const beforeFailure = Object.fromEntries(Object.entries(files).map(([name, file]) =>
      [name, fs.existsSync(file) ? fs.readFileSync(file) : null]));
    f.armManifestWriteFailure();
    await assert.rejects(f.service.repair(id, { version: '0.4.6' }), /injected manifest write failure/);
    for (const [name, file] of Object.entries(files)) {
      assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, beforeFailure[name], `${name} rolled back`);
    }
    assert.equal(sha256(files.core), HASHES.core045);
    assert.equal(sha256(files.carrier), HASHES.carrier045);
    assert.deepEqual(fs.readFileSync(files.config), originalIni);
    assert.equal(fs.existsSync(realJournal.pendingPath(f.gameDir)), false);
  });
