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
const REAL_HOTFIX_OTA = path.resolve(PROJECT_ROOT, '..', 'deliveries',
  'DLSS5-Core-0.4.6-hotfix.1-20260908', 'DLSS5-0.4.6-hotfix.1-zh-CN-OTA.zip');
const HASHES = Object.freeze({
  coreHotfix: '0727be26ceddcf60354535cee7c12a3138eef3075d7f90110b3693508fb633a5',
  core046: 'b68f2709a131c9ce0513b6366dbcc2e7d551bef5bcd41934075407378a48c090',
  carrierHotfix: '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86',
  carrier046: '8268ba3a9d7614ca0e0efad22f7c477780547224dfd0847a1d67188fc05f13c0',
  bridge: '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'
});

function makeHistoricalCatalog(root) {
  const catalog = path.join(root, 'historical-0.4.6-hotfix.1');
  const fixedSource = path.join(PROJECT_ROOT, 'payload', 'nr-before-sr', 'fixed', 'RTX40');
  const versionSource = path.join(PROJECT_ROOT, 'payload', 'nr-before-sr', 'versions', '0.4.6-hotfix.1');
  const fixed = path.join(catalog, 'fixed', 'RTX40');
  const version = path.join(catalog, 'versions', '0.4.6-hotfix.1');
  fs.mkdirSync(fixed, { recursive: true });
  fs.mkdirSync(version, { recursive: true });
  for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll'])
    fs.copyFileSync(path.join(fixedSource, name), path.join(fixed, name));
  for (const name of [INSTALLED_NAMES.addon, INSTALLED_NAMES.config, INSTALLED_NAMES.bridge, INSTALLED_NAMES.carrier])
    fs.copyFileSync(path.join(versionSource, name), path.join(version, name));
  const files = names => Object.fromEntries(names.map(name => [name,
    sha256(path.join(['ReShade64.dll', 'nvngx_dlssnr.dll'].includes(name) ? fixed : version, name))]));
  const bundle = {
    version: 4,
    generatedAt: '2026-09-08T00:00:00.000Z',
    defaultVersion: '0.4.6-hotfix.1',
    fixed: {
      RTX40: { files: files(['ReShade64.dll', 'nvngx_dlssnr.dll']) },
      RTX50: { files: {} }
    },
    versions: {
      '0.4.6-hotfix.1': {
        label: '0.4.6-hotfix.1 · historical transaction fixture',
        compatibility: 'dx11',
        source: 'isolated from the retained real 0.4.6-hotfix.1 payload files',
        files: files([INSTALLED_NAMES.addon, INSTALLED_NAMES.config, INSTALLED_NAMES.bridge, INSTALLED_NAMES.carrier])
      }
    },
    supersededVersions: { '0.4.6': '0.4.6-hotfix.1' }
  };
  fs.writeFileSync(path.join(catalog, 'bundle.json'), JSON.stringify(bundle));
  return catalog;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function iniValue(file, key) {
  const match = fs.readFileSync(file, 'utf8').match(new RegExp(`^${key}\\s*=\\s*([0-9.]+)`, 'mi'));
  return match ? Number(match[1]) : null;
}

function makeService(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-hotfix1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game');
  const exeDir = path.join(gameDir, 'Binaries', 'Win64');
  fs.mkdirSync(exeDir, { recursive: true });
  const exe = path.join(exeDir, 'Game.exe');
  fs.writeFileSync(exe, 'non-executable test fixture');
  const historicalCatalog = makeHistoricalCatalog(root);

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
        throw Object.assign(new Error('injected hotfix manifest write failure'), { code: 'EIO' });
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
    userData: path.join(root, 'user-data'), resourcesPath: PROJECT_ROOT, appDir: PROJECT_ROOT,
    version: '0.4.6-hotfix.1',
    overrides: { library, installer,
      detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' }) }
  });
  return { gameDir, exeDir, historicalCatalog, service, armManifestWriteFailure: () => { failManifestWrite = true; } };
}

test('real hotfix.1 payload and OTA preserve explicit INI values across API routes, rollback and journal failure',
  { skip: !fs.existsSync(REAL_HOTFIX_OTA) }, async t => {
    const f = makeService(t);
    await f.service.addManualGame(f.gameDir);
    let boot = await f.service.boot();
    const id = boot.games[0].id;
    assert.equal(boot.payload.selectedVersion, '0.4.7beta');
    assert.equal(Object.hasOwn(boot.payload.versions, '0.4.6-hotfix.1'), false);
    await f.service.selectPayloadSource(f.historicalCatalog);
    boot = await f.service.boot();
    assert.equal(boot.payload.selectedVersion, '0.4.6-hotfix.1');
    const files = {
      core: path.join(f.exeDir, INSTALLED_NAMES.addon),
      bridge: path.join(f.exeDir, INSTALLED_NAMES.bridge),
      carrier: path.join(f.exeDir, INSTALLED_NAMES.carrier),
      config: path.join(f.exeDir, INSTALLED_NAMES.config),
      manifest: path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json')
    };

    await f.service.setGameApi(id, 'dx12');
    await f.service.install(id);
    assert.equal(sha256(files.core), HASHES.coreHotfix);
    assert.equal(sha256(files.bridge), HASHES.bridge);
    assert.equal(fs.existsSync(files.carrier), false);
    assert.equal(iniValue(files.config, 'TransferStrength'), 1);
    assert.equal(iniValue(files.config, 'PostTransferStrength'), 1);

    let ini = fs.readFileSync(files.config, 'utf8')
      .replace(/^TransferStrength=.*$/mi, 'TransferStrength=3.25')
      .replace(/^PostTransferStrength=.*$/mi, 'PostTransferStrength=0.66');
    fs.writeFileSync(files.config, ini);
    await f.service.setGameApi(id, 'dx11');
    await f.service.repair(id);
    assert.equal(sha256(files.carrier), HASHES.carrierHotfix);
    await f.service.setGameApi(id, 'dx12');
    assert.equal(fs.existsSync(files.carrier), false);
    assert.equal(sha256(files.core), HASHES.coreHotfix);
    assert.equal(sha256(files.bridge), HASHES.bridge);
    await f.service.setGameApi(id, 'dx11');
    assert.equal(sha256(files.carrier), HASHES.carrierHotfix);

    const versions = await f.service.importAddonFile(REAL_HOTFIX_OTA);
    const imported = versions.find(row => row.source === 'imported' &&
      row.otaManifest?.version === 'beta0.4.6-hotfix.1');
    assert.ok(imported);
    await f.service.upgradeAddon(id, imported.id);
    assert.equal(sha256(files.core), HASHES.coreHotfix);
    assert.equal(sha256(files.carrier), HASHES.carrierHotfix);
    assert.equal(iniValue(files.config, 'TransferStrength'), 3.25);
    assert.equal(iniValue(files.config, 'PostTransferStrength'), 0.66);

    await assert.rejects(f.service.repair(id, { version: '0.4.6' }), error =>
      error.code === 'ERR_ADDON_NOT_FOUND' && error.details?.replacementVersion === '0.4.6-hotfix.1');
    assert.equal(sha256(files.core), HASHES.coreHotfix);
    assert.equal(sha256(files.bridge), HASHES.bridge);
    assert.equal(sha256(files.carrier), HASHES.carrierHotfix);
    assert.equal(iniValue(files.config, 'TransferStrength'), 3.25);
    assert.equal(iniValue(files.config, 'PostTransferStrength'), 0.66);

    const beforeFailure = Object.fromEntries(Object.entries(files).map(([name, file]) =>
      [name, fs.existsSync(file) ? fs.readFileSync(file) : null]));
    f.armManifestWriteFailure();
    await assert.rejects(f.service.repair(id, { version: '0.4.6-hotfix.1' }),
      /injected hotfix manifest write failure/);
    for (const [name, file] of Object.entries(files)) {
      assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null,
        beforeFailure[name], `${name} rolled back`);
    }
    assert.equal(fs.existsSync(realJournal.pendingPath(f.gameDir)), false);

    await f.service.applyDefault(id);
    assert.equal(iniValue(files.config, 'TransferStrength'), 1);
    assert.equal(iniValue(files.config, 'PostTransferStrength'), 1);
  });
