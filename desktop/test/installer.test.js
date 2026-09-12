'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInstaller } = require('../src/product/installer');
const { createBundle, inspectPayload, sha256 } = require('../src/product/payload');
const { PAYLOAD_FILES, INSTALLED_NAMES, DX11_COMPAT_VERSION, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const { manifestPath } = require('../src/product/manifest');

function makeJournal() {
  return {
    safePath(root, rel) {
      const target = path.resolve(root, rel);
      if (!path.relative(root, target) || path.relative(root, target).startsWith('..')) throw Error('unsafe');
      return target;
    },
    async capture() {},
    async atomicJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); },
    async transaction(_dir, work) { return work(); }
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-install-'));
  const gameDir = path.join(root, 'Game');
  const exeDir = path.join(gameDir, 'bin');
  const exePath = path.join(exeDir, 'game.exe');
  const payloadDir = path.join(root, 'payload');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.mkdirSync(payloadDir, { recursive: true });
  fs.writeFileSync(exePath, 'exe');
  for (const name of Object.values(PAYLOAD_FILES)) {
    let body = name;
    if (name === PAYLOAD_FILES.reshade) body = 'PE64 ReShade Searching for add-ons';
    fs.writeFileSync(path.join(payloadDir, name), body);
  }
  fs.writeFileSync(path.join(payloadDir, 'bundle.json'), JSON.stringify(createBundle(payloadDir)));
  const payload = Object.fromEntries(inspectPayload(payloadDir).files.map(row => [row.kind, row]));
  const scan = {
    chosen: { path: exePath, rel: 'bin/game.exe', bitness: 64, api: 'dxgi', apiLabel: 'DirectX 12', emulator: null },
    primaryDlss: { name: 'nvngx_dlss.dll' }, emulator: null
  };
  return { root, gameDir, exeDir, exePath, payload, scan };
}

test('installs, diagnoses, repairs and uninstalls without deleting kept settings', async () => {
  const f = fixture();
  const scanModule = {
    async scanGame() { return f.scan; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file)
        ? { installed: true, addonSupport: fs.readFileSync(file).includes('Searching for add-ons'), file: 'dxgi.dll' }
        : { installed: false, addonSupport: false, file: null };
    }
  };
  const installer = createInstaller({
    journal: makeJournal(),
    scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  const installed = await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(installed.complete, true);
  const ini = path.join(f.exeDir, PAYLOAD_FILES.config);
  fs.appendFileSync(ini, '\n; user setting');
  fs.unlinkSync(path.join(f.exeDir, PAYLOAD_FILES.bridge));
  assert.equal((await installer.diagnose({ gameDir: f.gameDir, payload: f.payload, scan: f.scan })).complete, false);
  assert.equal((await installer.repair({ gameDir: f.gameDir, payload: f.payload, scan: f.scan })).complete, true);
  const removed = await installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(ini), true, 'user settings are kept by default');
  assert.equal(fs.existsSync(path.join(f.exeDir, PAYLOAD_FILES.addon)), false);
});

test('warns about anti-cheat first and installs only after explicit confirmation', async () => {
  const f = fixture();
  const installer = createInstaller({
    journal: makeJournal(),
    scan: {
      async scanGame() { return f.scan; },
      inspectReShade(dir) {
        const file = path.join(dir, 'dxgi.dll');
        return fs.existsSync(file)
          ? { installed: true, addonSupport: fs.readFileSync(file).includes('Searching for add-ons'), file: 'dxgi.dll' }
          : { installed: false, addonSupport: false, file: null };
      }
    },
    guards: { antiCheatPresent: () => true, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await assert.rejects(
    installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }),
    error => error && error.code === 'ERR_ANTI_CHEAT_CONFIRM'
  );
  assert.equal(fs.existsSync(path.join(f.exeDir, PAYLOAD_FILES.addon)), false);
  const installed = await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan, allowAntiCheat: true });
  assert.equal(installed.complete, true);
  assert.equal(fs.existsSync(path.join(f.exeDir, PAYLOAD_FILES.addon)), true);
});

test('refuses to overwrite an unknown dxgi.dll', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.exeDir, 'dxgi.dll'), 'some unrelated proxy');
  const installer = createInstaller({
    journal: makeJournal(),
    scan: {
      async scanGame() { return f.scan; },
      inspectReShade() { return { installed: false, addonSupport: false, file: null }; }
    },
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await assert.rejects(
    installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }),
    error => error && error.code === 'ERR_RESHADER_CONFLICT'
  );
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'dxgi.dll'), 'utf8'), 'some unrelated proxy');
});

test('keeps an existing add-on ReShade and restores an overwritten runtime', async () => {
  const f = fixture();
  const reshadePath = path.join(f.exeDir, 'dxgi.dll');
  const runtimePath = path.join(f.exeDir, PAYLOAD_FILES.runtime);
  fs.writeFileSync(reshadePath, 'existing ReShade Searching for add-ons');
  fs.writeFileSync(runtimePath, 'original runtime');
  const scanModule = {
    async scanGame() { return f.scan; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file) && fs.readFileSync(file).includes('Searching for add-ons')
        ? { installed: true, addonSupport: true, file: 'dxgi.dll' }
        : { installed: false, addonSupport: false, file: null };
    }
  };
  const installer = createInstaller({
    journal: makeJournal(),
    scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(fs.readFileSync(reshadePath, 'utf8'), 'existing ReShade Searching for add-ons');
  assert.equal(fs.readFileSync(runtimePath, 'utf8'), PAYLOAD_FILES.runtime);
  assert.equal(fs.readFileSync(`${runtimePath}.bak`, 'utf8'), 'original runtime');
  const removed = await installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(removed.removed, true);
  assert.equal(fs.readFileSync(reshadePath, 'utf8'), 'existing ReShade Searching for add-ons');
  assert.equal(fs.readFileSync(runtimePath, 'utf8'), 'original runtime');
});

test('moves DLSS/NR conflicts but preserves ReShade, game DLSS and ordinary RenoDX files', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.exeDir, 'dxgi.dll'), 'existing ReShade Searching for add-ons');
  fs.writeFileSync(path.join(f.exeDir, 'renodx-dlss5.addon64'), 'old dlss5 tool');
  fs.writeFileSync(path.join(f.exeDir, 'old-nr-before-sr.addon64'), 'old nr');
  fs.writeFileSync(path.join(f.exeDir, 'renodx-hdr.addon64'), 'keep hdr');
  fs.writeFileSync(path.join(f.exeDir, 'nvngx_dlss.dll'), 'game dlss');
  fs.writeFileSync(path.join(f.exeDir, 'nvngx_dlssg.dll'), 'game dlssg');
  const installer = createInstaller({
    journal: makeJournal(),
    scan: {
      async scanGame() { return f.scan; },
      inspectReShade() { return { installed: true, addonSupport: true, file: 'dxgi.dll' }; }
    },
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  const installed = await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  assert.equal(installed.complete, true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'renodx-dlss5.addon64')), false);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'old-nr-before-sr.addon64')), false);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'renodx-hdr.addon64')), true);
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'dxgi.dll'), 'utf8'), 'existing ReShade Searching for add-ons');
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'nvngx_dlss.dll'), 'utf8'), 'game dlss');
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'nvngx_dlssg.dll'), 'utf8'), 'game dlssg');
  const conflictRoot = path.join(f.gameDir, '_DLSS5_Backup', 'conflicts');
  assert.equal(fs.readdirSync(conflictRoot, { recursive: true }).some(name => String(name).includes('renodx-dlss5.addon64')), true);
  const removed = await installer.uninstall({ gameDir: f.gameDir, scan: f.scan });
  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'renodx-dlss5.addon64')), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'old-nr-before-sr.addon64')), true);
});

test('DX11 install refuses a compatibility-labeled payload without its carrier', async () => {
  const f = fixture();
  f.scan.chosen.apiLabel = 'DirectX 11';
  f.payload.versionInfo = { compatibility: 'dx11' };
  const installer = createInstaller({
    journal: makeJournal(),
    scan: { async scanGame() { return f.scan; }, inspectReShade() { return { installed: false, addonSupport: false, file: null }; } },
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await assert.rejects(
    installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan }),
    error => error && error.code === 'ERR_PAYLOAD_MISSING'
  );
});

test('unified compatibility install retires an old managed carrier instead of stacking it', async () => {
  const f = fixture();
  const scanModule = {
    async scanGame() { return f.scan; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file)
        ? { installed: true, addonSupport: fs.readFileSync(file).includes('Searching for add-ons'), file: 'dxgi.dll' }
        : { installed: false, addonSupport: false, file: null };
    }
  };
  const installer = createInstaller({
    journal: makeJournal(), scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  f.scan.chosen.apiLabel = 'DirectX 11';
  f.scan.chosen.apiResolution = { api: 'dx11', source: 'test', evidence: [] };

  const oldCarrier = path.join(f.exeDir, 'dlss5-native-carrier-exp1.addon64');
  fs.writeFileSync(oldCarrier, 'old managed carrier');
  const manifestFile = manifestPath(f.gameDir);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files.push({
    rel: path.relative(f.gameDir, oldCarrier), kind: 'carrier',
    original: { existed: false, backupRel: null, sha256: null },
    installedSha256: sha256(oldCarrier)
  });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const beforeUpgrade = await installer.diagnose({
    gameDir: f.gameDir,
    payload: { ...f.payload, versionInfo: { compatibility: 'dx11' } },
    scan: f.scan
  });
  assert.match(beforeUpgrade.components.find(row => row.key === 'conflicts').detail, /受管旧 Carrier/);

  const carrierSource = path.join(f.root, DX11_COMPAT_CARRIER);
  fs.writeFileSync(carrierSource, 'new matched carrier');
  const payload = {
    ...f.payload,
    version: DX11_COMPAT_VERSION,
    versionInfo: { compatibility: 'dx11' },
    carrier: { file: carrierSource, name: DX11_COMPAT_CARRIER, actual: sha256(carrierSource) }
  };
  const result = await installer.install({ gameDir: f.gameDir, payload, scan: f.scan });
  assert.equal(result.complete, true);
  assert.equal(fs.existsSync(oldCarrier), false);
  assert.equal(fs.readFileSync(path.join(f.exeDir, INSTALLED_NAMES.carrier), 'utf8'), 'new matched carrier');
  const installedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  assert.equal(installedManifest.files.filter(row => row.kind === 'carrier').length, 1);
});

test('upgrades the managed addon and optional paired bridge while leaving the rest intact', async () => {
  const f = fixture();
  const scanModule = {
    async scanGame() { return f.scan; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file)
        ? { installed: true, addonSupport: fs.readFileSync(file).includes('Searching for add-ons'), file: 'dxgi.dll' }
        : { installed: false, addonSupport: false, file: null };
    }
  };
  const installer = createInstaller({
    journal: makeJournal(),
    scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  const replacement = path.join(f.root, 'new-version.addon64');
  fs.writeFileSync(replacement, 'new imported addon');
  const bridgeReplacement = path.join(f.root, 'new-bridge.dll');
  fs.writeFileSync(bridgeReplacement, 'new imported bridge');
  const result = await installer.upgradeAddon({
    gameDir: f.gameDir,
    addon: { id: 'imported-test', file: replacement, bridgeFile: bridgeReplacement,
      addonSha256: sha256(replacement), bridgeSha256: sha256(bridgeReplacement) },
    version: 'imported-test',
    scan: f.scan
  });
  assert.equal(result.complete, true);
  assert.equal(fs.readFileSync(path.join(f.exeDir, PAYLOAD_FILES.addon), 'utf8'), 'new imported addon');
  assert.equal(fs.readFileSync(path.join(f.exeDir, PAYLOAD_FILES.bridge), 'utf8'), 'new imported bridge');
  assert.equal(fs.existsSync(path.join(f.exeDir, `${PAYLOAD_FILES.addon}.bak`)), true);
});

test('switches the managed ReShade hook to d3d12.dll and can roll it back', async () => {
  const f = fixture();
  const scanModule = {
    async scanGame() { return f.scan; },
    inspectReShade(dir) {
      for (const name of ['dxgi.dll', 'd3d12.dll']) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) return { installed: true, addonSupport: fs.readFileSync(file).includes('Searching for add-ons'), file: name };
      }
      return { installed: false, addonSupport: false, file: null };
    }
  };
  const installer = createInstaller({
    journal: makeJournal(),
    scan: scanModule,
    guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} },
    pe: { getBitness: () => 64 }
  });
  await installer.install({ gameDir: f.gameDir, payload: f.payload, scan: f.scan });
  await installer.toggleD3D12({ gameDir: f.gameDir, enabled: true, scan: f.scan });
  assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'd3d12.dll')), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll.bak')), true);
  await installer.toggleD3D12({ gameDir: f.gameDir, enabled: false, scan: f.scan });
  assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'd3d12.dll')), false);
});
