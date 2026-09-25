'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLibraryService, steamArtworkFor, normalizeUnityDynamicApi } = require('../src/product/library-service');
const { INSTALLED_NAMES } = require('../src/product/constants');

function absRoot(...parts) {
  return path.resolve(path.sep, 'abs-games', ...parts);
}

function scanFixture(root, preferred, hasDlss = true) {
  const game = {
    path: path.join(root, 'Binaries', 'Win64', 'Game.exe'),
    rel: 'Binaries\\Win64\\Game.exe',
    name: 'Game.exe', size: 80 * 1024 * 1024, api: 'dxgi', apiLabel: 'DirectX 12',
    bitness: 64, dx12: true
  };
  const helper = {
    path: path.join(root, 'Launcher.exe'),
    rel: 'Launcher.exe',
    name: 'Launcher.exe', size: 2 * 1024 * 1024, api: 'dxgi', apiLabel: 'DirectX 12',
    bitness: 64, dx12: true
  };
  return {
    gameDir: root,
    exeCandidates: [preferred ? game : helper, preferred ? helper : game],
    chosen: preferred ? game : helper,
    dlssFiles: hasDlss ? [{ path: path.join(root, 'nvngx_dlss.dll'), rel: 'nvngx_dlss.dll', name: 'nvngx_dlss.dll', bitness: 64 }] : [],
    primaryDlss: { name: 'nvngx_dlss.dll' },
    emulator: null,
    reshade: { installed: false }
  };
}

test('manual BG3 DX11 entry retains automatic API identity through selection and refresh', async () => {
  const root = absRoot('Baldurs Gate 3'), bin = path.join(root, 'bin');
  const dx11 = { path: path.join(bin, 'bg3_dx11.exe'), name: 'bg3_dx11.exe', api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 };
  const vulkan = { path: path.join(bin, 'bg3.exe'), name: 'bg3.exe', api: 'vulkan', apiLabel: 'Vulkan', bitness: 64 };
  const native = { path: path.join(bin, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 };
  const game = { launcher: 'Steam', id: '1086940', dir: root, name: 'Baldurs Gate 3' };
  const library = createLibraryService({
    library: { discover: () => ({ games: [game] }), dedupe: rows => rows },
    scan: { async scanGame(dir) { return { gameDir: dir, chosen: dir === root ? vulkan : dx11,
      exeCandidates: [vulkan, dx11].map(row => ({ ...row, rel: path.relative(dir, row.path) })),
      dlssFiles: [native], primaryDlss: native, reshade: { installed: false } }; }, selectPrimaryDlss: () => native }
  });
  const selection = await library.prepareSelection(dx11.path);
  assert.equal(selection.root, bin, 'native SR and recovery root remain in bin');
  assert.equal(selection.chosen.path, dx11.path);
  assert.equal(selection.chosen.apiResolution.api, 'dx11');
  assert.equal(selection.chosen.apiResolution.source, 'game-entry');
  const state = { manualGames: [bin], manualExecutables: [{ root: bin, file: dx11.path }], gameOverrides: {} };
  for (let refresh = 0; refresh < 2; refresh++) {
    const rows = await library.scanAll(state);
    assert.equal(rows.length, 2, 'Vulkan and DX11 keep separate selected entries');
    const manual = rows.find(row => row.chosen.path === dx11.path);
    assert.equal(manual.chosen.apiResolution.api, 'dx11');
    assert.equal(manual.apiOverride, 'auto');
    assert.equal(manual.supported, true);
    assert.equal(rows.find(row => row.chosen.path === vulkan.path).chosen.apiResolution.api, 'vulkan');
  }
  state.gameOverrides[path.resolve(bin).toLowerCase()] = { api: 'dx12', apiExecutable: dx11.path };
  const overridden = (await library.scanAll(state)).find(row => row.chosen.path === dx11.path);
  assert.equal(overridden.chosen.apiResolution.api, 'dx12');
  assert.equal(overridden.chosen.detectedApi, 'dx11');
});

test('manual executable selection keeps the chosen deep game exe and metadata', async () => {
  const root = absRoot('Example');
  const executable = path.join(root, 'Binaries', 'Win64', 'Game.exe');
  const scan = {
    async scanGame(dir) { return scanFixture(dir, true, dir === root); },
    selectPrimaryDlss(files) { return files[0]; }
  };
  const library = createLibraryService({
    scan,
    library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
  });

  const selection = await library.prepareSelection(executable, executable);
  assert.equal(selection.root, root);
  assert.equal(selection.chosen.path, executable);
  assert.equal(selection.candidates.find(row => row.name === 'Launcher.exe').recommended, false);

  const state = {
    scanFolders: [], scanDrives: false, excludedRoots: [],
    manualGames: [root], manualExecutables: [{ root, file: executable }],
    gameOverrides: { [root.toLowerCase()]: { name: '自定义名称', icon: 'data:image/png;base64,icon' } }
  };
  const rows = await library.scanAll(state);
  assert.equal(rows[0].chosen.path, executable);
  assert.equal(rows[0].supported, true);
  assert.equal(rows[0].name, '自定义名称');
  assert.match(rows[0].icon, /^data:/);
});

test('an exact pre-existing Core stays unowned but is exposed for conflict preview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-unmanaged-library-'));
  try {
    const executable = path.join(root, 'Binaries', 'Win64', 'Game.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, 'exe');
    fs.writeFileSync(path.join(path.dirname(executable), INSTALLED_NAMES.addon), 'old unmanaged core');
    const scan = { async scanGame() { return scanFixture(root, true); }, selectPrimaryDlss(files) { return files[0]; } };
    const library = createLibraryService({ scan, library: {
      discover: () => ({ games: [{ launcher: '本地游戏', dir: root, name: 'Existing Core' }], roots: [] }), dedupe: rows => rows
    } });
    const rows = await library.scanAll({ scanFolders: [], scanDrives: false, excludedRoots: [], excludedGames: [], manualGames: [], manualExecutables: [], gameOverrides: {} });
    assert.equal(rows[0].installed, false, 'ownership still requires a valid manager receipt');
    assert.equal(rows[0].existingInstallation.detected, true);
    assert.equal(rows[0].existingInstallation.corePresent, true);
    assert.equal(rows[0].existingInstallation.version, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not treat the manager NR runtime as the game native DLSS root', async () => {
  const root = absRoot('Neverness');
  const executable = path.join(root, 'Client', 'WindowsNoEditor', 'HT', 'Binaries', 'Win64', 'HTGame.exe');
  const native = path.join(root, 'Client', 'WindowsNoEditor', 'Engine', 'Plugins', 'Runtime', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll');
  const scan = {
    async scanGame(dir) {
      const normalized = dir.replace(/\\/g, '/');
      const hasNative = normalized.endsWith('/Client/WindowsNoEditor');
      return {
        exeCandidates: [{ path: executable, rel: 'Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe', name: 'HTGame.exe', size: 254 * 1024 * 1024, api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64 }],
        chosen: { path: executable, name: 'HTGame.exe', api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64 },
        dlssFiles: [{ name: hasNative ? 'nvngx_dlss.dll' : 'nvngx_dlssnr.dll' }],
        primaryDlss: hasNative ? { name: 'nvngx_dlss.dll', path: native } : null
      };
    },
    selectPrimaryDlss(files) { return files.find(file => file.name === 'nvngx_dlss.dll') || null; }
  };
  const library = createLibraryService({
    scan,
    library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
  });
  const selection = await library.prepareSelection(executable, executable);
  assert.equal(selection.root, path.join(root, 'Client', 'WindowsNoEditor'));
});

test('keeps an explicitly selected executable even when heuristics omit it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-explicit-exe-'));
  const requested = path.join(root, 'Bannerlord.exe');
  const recommended = path.join(root, 'Bannerlord.Native.exe');
  try {
    fs.writeFileSync(requested, 'not a real PE');
    fs.writeFileSync(recommended, 'not a real PE');
    const scan = {
      async scanGame(dir) {
        return {
          gameDir: dir,
          exeCandidates: [{ path: recommended, rel: 'Bannerlord.Native.exe', name: 'Bannerlord.Native.exe', size: 1, api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 }],
          chosen: { path: recommended, rel: 'Bannerlord.Native.exe', name: 'Bannerlord.Native.exe', api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 },
          dlssFiles: [{ name: 'nvngx_dlss.dll' }],
          primaryDlss: { name: 'nvngx_dlss.dll' }
        };
      },
      selectPrimaryDlss(files) { return files[0]; }
    };
    const library = createLibraryService({
      scan,
      library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
    });
    const selection = await library.prepareSelection(requested, requested);
    assert.equal(selection.chosen.path, requested);
    assert.ok(selection.candidates.some(row => row.path === requested));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('static DX11 defaults automatically and preserves explicit core and EXE-bound API choices', async () => {
  const root = absRoot('Dx11Example');
  const executable = path.join(root, 'Binaries', 'Win64', 'Dx11Example.exe');
  const scan = {
    async scanGame(dir) {
      return {
        gameDir: dir,
        exeCandidates: [{ path: executable, rel: 'Binaries\\Win64\\Dx11Example.exe', name: 'Dx11Example.exe', size: 8 * 1024 * 1024, api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 }],
        chosen: { path: executable, rel: 'Binaries\\Win64\\Dx11Example.exe', name: 'Dx11Example.exe', size: 8 * 1024 * 1024, api: 'dxgi', apiLabel: 'DirectX 11', bitness: 64 },
        dlssFiles: [{ path: path.join(root, 'nvngx_dlss.dll'), rel: 'nvngx_dlss.dll', name: 'nvngx_dlss.dll', bitness: 64 }],
        primaryDlss: { name: 'nvngx_dlss.dll' },
        emulator: null,
        reshade: { installed: false }
      };
    },
    selectPrimaryDlss(files) { return files[0]; }
  };
  const library = createLibraryService({
    scan,
    library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
  });
  const state = {
    scanFolders: [], scanDrives: false, excludedRoots: [], excludedGames: [],
    manualGames: [root], manualExecutables: [], gameOverrides: {}, addonVersion: '0.4.1-r2'
  };
  const rows = await library.scanAll(state);
  assert.equal(rows[0].supported, true);
  assert.equal(rows[0].chosen.apiResolution.api, 'dx11');
  assert.equal(rows[0].chosen.apiAssessment.bridgeStatus.status, 'required');
  state.gameOverrides[root.toLowerCase()] = { api: 'dx11', apiExecutable: executable };
  const selected = await library.scanAll(state);
  assert.equal(selected[0].supported, true);
  assert.equal(selected[0].recommendedAddonVersion, null);
  assert.equal(selected[0].chosen.apiResolution.api, 'dx11');
  state.gameOverrides[root.toLowerCase()].apiExecutable = path.join(root, 'Other.exe');
  const other = (await library.scanAll(state))[0];
  assert.equal(other.apiOverride, 'auto', 'override never follows a different EXE');
  assert.equal(other.supported, true, 'independent DX11 detection still provides the automatic route');
});

test('a small real game executable is still recommended when the folder and name are strong signals', async () => {
  const root = absRoot('Arknights Endfield');
  const executable = path.join(root, 'Endfield.exe');
  const launcher = path.join(root, 'CefView', 'CefViewWing.exe');
  const scan = {
    async scanGame(dir) {
      return {
        gameDir: dir,
        exeCandidates: [
          { path: launcher, rel: 'CefView\\CefViewWing.exe', name: 'CefViewWing.exe', size: 650 * 1024, api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64, dx12: true },
          { path: executable, rel: 'Endfield.exe', name: 'Endfield.exe', size: 800 * 1024, api: 'dxgi', apiLabel: 'DirectX 11/12（DLSS 关联）', via: 'fallback', bitness: 64, dx12: false }
        ],
        chosen: { path: launcher, rel: 'CefView\\CefViewWing.exe', name: 'CefViewWing.exe', size: 650 * 1024, api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64, dx12: true },
        dlssFiles: [{ path: path.join(root, 'nvngx_dlss.dll'), rel: 'nvngx_dlss.dll', name: 'nvngx_dlss.dll', bitness: 64 }],
        primaryDlss: { name: 'nvngx_dlss.dll' },
        emulator: null,
        reshade: { installed: false }
      };
    },
    selectPrimaryDlss(files) { return files[0]; }
  };
  const library = createLibraryService({
    scan,
    library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows }
  });

  const selection = await library.prepareSelection(root);
  assert.equal(selection.chosen.path, executable);
  assert.equal(selection.chosen.size, 800 * 1024);
  assert.equal(selection.candidates.find(row => row.path === executable).recommended, true);
});

test('Steam artwork prefers the local high-resolution poster before header or launcher icon', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-steam-art-'));
  try {
    const cache = path.join(root, 'appcache', 'librarycache', '12345');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'header.jpg'), 'header');
    fs.writeFileSync(path.join(cache, 'logo.png'), 'logo');
    fs.writeFileSync(path.join(cache, 'library_600x900.jpg'), 'poster');
    const result = steamArtworkFor({ launcher: 'Steam', id: '12345', steamRoot: root, poster: null });
    assert.match(result.poster.file, /library_600x900\.jpg$/i);
    assert.match(result.steamIcon, /logo\.png$/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dismissed games stay hidden when a launcher rediscovers the same app', async () => {
  const root = absRoot('3DMark');
  const scan = {
    async scanGame(dir) { return scanFixture(dir, true, true); },
    selectPrimaryDlss(files) { return files[0]; }
  };
  const library = createLibraryService({
    scan,
    library: {
      discover: () => ({ games: [{ launcher: 'Steam', id: '223850', name: '3DMark', dir: root, poster: null }], roots: [] }),
      dedupe: rows => rows
    }
  });
  const state = {
    scanFolders: [], scanDrives: false, excludedRoots: [],
    excludedGames: [{ dir: root, launcher: 'Steam', id: '223850', appid: '223850' }],
    manualGames: [], manualExecutables: [], gameOverrides: {}
  };
  assert.deepEqual(await library.scanAll(state), []);
});

test('Unity games with native DLSS are not misclassified as OpenGL', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-unity-api-'));
  try {
    fs.writeFileSync(path.join(root, 'UnityPlayer.dll'), 'marker fixture');
    const executable = path.join(root, 'Game.exe');
    const scan = {
      chosen: { path: executable, api: 'opengl', apiLabel: 'OpenGL', via: 'module:unityplayer.dll', bitness: 64 },
      exeCandidates: [{ path: executable, api: 'opengl', apiLabel: 'OpenGL', via: 'module:unityplayer.dll', bitness: 64 }],
      primaryDlss: { name: 'nvngx_dlss.dll' },
      dlssFiles: [{ name: 'nvngx_dlss.dll' }]
    };
    const fixed = normalizeUnityDynamicApi(scan, root, () => new Set(['D3D12CreateDevice', 'D3D11CreateDevice']));
    assert.equal(fixed.chosen.api, 'dxgi');
    assert.equal(fixed.chosen.apiLabel, 'DirectX 11/12');
    assert.equal(fixed.chosen.dx12, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
