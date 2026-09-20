'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/product/app-service');
const { createLibraryService, idFor } = require('../src/product/library-service');
const { createInstaller } = require('../src/product/installer');
const { newManifest, manifestPath } = require('../src/product/manifest');
const { dedupe } = require('../vendor/DLSS5-Swapper/src/library');

function fixture(t) {
  const broad = fs.mkdtempSync(path.join(os.tmpdir(), 'service-alias-'));
  t.after(() => fs.rmSync(broad, { recursive: true, force: true }));
  const outer = path.join(broad, 'Neverness'), root = path.join(outer, 'Client', 'WindowsNoEditor');
  const binary = path.join(root, 'HT', 'Binaries', 'Win64'), exe = path.join(binary, 'HTGame.exe');
  const native = path.join(root, 'Engine', 'Plugins', 'Nvidia', 'nvngx_dlss.dll');
  const otherRoot = path.join(broad, 'OtherGame'), other = path.join(otherRoot, 'OtherGame.exe');
  for (const file of [exe, native, other]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  const inside = (file, dir) => { const rel = path.relative(dir, file); return !rel.startsWith('..') && !path.isAbsolute(rel); };
  const scan = {
    async scanGame(dir) {
      const selected = inside(exe, dir) ? exe : other;
      const chosen = { path: selected, rel: path.relative(dir, selected), name: path.basename(selected), size: 90000000,
        api: 'dxgi', apiLabel: 'DirectX 12', via: 'imports', dx12: true, bitness: 64 };
      const dll = inside(native, dir) ? { name: 'nvngx_dlss.dll', path: native, rel: path.relative(dir, native), bitness: 64 } : null;
      return { gameDir: dir, chosen, exeCandidates: [chosen], dlssFiles: dll ? [dll] : [], primaryDlss: dll, reshade: { installed: false } };
    },
    selectPrimaryDlss: files => files.find(row => row.name === 'nvngx_dlss.dll') || null,
    inspectReShade: () => ({ installed: false, addonSupport: false })
  };
  const library = createLibraryService({ scan, library: { discover: () => ({ games: [], roots: [] }), dedupe } });
  const installer = createInstaller({ scan, guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, pe: { getBitness: () => 64 } });
  const service = createAppService({ userData: path.join(broad, 'user-data'), appDir: broad, resourcesPath: path.join(broad, 'resources'),
    overrides: { library, installer, detectGpu: () => ({ family: 'RTX50' }) } });
  const icon = 'data:image/png;base64,aWNvbg==';
  const initial = { manualGames: [binary, root, outer, broad, otherRoot], manualExecutables: [{ root: binary, file: exe }, { root, file: exe }, { root: otherRoot, file: other }],
    gameOverrides: { [binary.toLowerCase()]: { api: 'dx12', apiExecutable: exe, name: '我的异环', icon },
      [broad.toLowerCase()]: { name: '启动器目录', icon }, [otherRoot.toLowerCase()]: { api: 'dx12', apiExecutable: other, name: 'Other custom', icon } } };
  const receipt = dir => { const value = newManifest(dir, exe, 'dxgi'); value.payloadVersion = 'imported-fixture';
    fs.mkdirSync(path.dirname(manifestPath(dir)), { recursive: true }); fs.writeFileSync(manifestPath(dir), JSON.stringify(value)); return fs.readFileSync(manifestPath(dir)); };
  return { broad, outer, root, binary, exe, otherRoot, other, icon, service, installer, initial, receipt };
}

test('concurrent names, APIs and another game preference preserve every committed field', async t => {
  const f = fixture(t);
  await f.service.store.write({ manualGames: [f.root, f.otherRoot],
    manualExecutables: [{ root: f.root, file: f.exe }, { root: f.otherRoot, file: f.other }] });
  const games = (await f.service.boot()).games;
  const first = games.find(row => row.dir === f.root), second = games.find(row => row.dir === f.otherRoot);
  await Promise.all([f.service.renameGame(first.id, 'First renamed'), f.service.setGameApiPreference(second.id, 'dx11'),
    f.service.setGameApiPreference(first.id, 'dx12')]);
  const saved = f.service.store.read().gameOverrides;
  assert.equal(saved[f.root.toLowerCase()].name, 'First renamed');
  assert.equal(saved[f.root.toLowerCase()].api, 'dx12');
  assert.equal(saved[f.otherRoot.toLowerCase()].api, 'dx11');
  await f.service.store.update(state => ({ gameOverrides: { ...state.gameOverrides, [f.root.toLowerCase()]: {
    ...state.gameOverrides[f.root.toLowerCase()], launchMode: 'exe', launchExecutable: f.exe } } }));
  await f.service.addManualSelection({ root: f.root, executable: f.exe });
  assert.equal(f.service.store.read().gameOverrides[f.root.toLowerCase()].launchMode, 'exe');
});

test('explicit selection persists one EXE alias with its old API and display metadata without unexcluding other games', async t => {
  const f = fixture(t); f.receipt(f.root);
  await f.service.store.write({ ...f.initial, excludedRoots: [f.broad, f.binary, f.outer, f.root, f.otherRoot],
    excludedGames: [{ dir: f.binary, executable: f.exe }, { dir: f.outer, executable: f.exe }, { dir: f.otherRoot, executable: f.other }] });
  await f.service.boot();
  await f.service.addManualSelection({ root: f.root, executable: f.exe, name: '', icon: null });
  const state = f.service.store.read();
  assert.deepEqual(state.manualExecutables.filter(row => row.file === f.exe), [{ root: f.root, file: f.exe }]);
  assert.equal(state.manualGames.includes(f.binary), false); assert.equal(state.manualGames.includes(f.outer), false);
  assert.ok(state.manualGames.includes(f.broad)); assert.ok(state.manualGames.includes(f.otherRoot));
  assert.deepEqual(state.gameOverrides[f.root.toLowerCase()], { name: '我的异环', icon: f.icon, api: 'dx12', apiExecutable: f.exe });
  assert.equal(state.gameOverrides[f.binary.toLowerCase()], undefined);
  assert.equal(state.gameOverrides[f.otherRoot.toLowerCase()].name, 'Other custom');
  assert.deepEqual(new Set(state.excludedRoots), new Set([f.broad, f.otherRoot]));
  assert.deepEqual(state.excludedGames.map(row => row.executable), [f.other]);
  assert.equal((await f.service.listGames()).filter(row => row.chosen?.path === f.exe).length, 1);
});

test('successful removal cleans stale EXE metadata and stays hidden until an explicit readd', async t => {
  const f = fixture(t); f.receipt(f.root); await f.service.store.write(f.initial);
  const games = (await f.service.boot()).games, game = games.find(row => row.chosen?.path === f.exe);
  assert.equal(game.installed, true);
  await f.service.dismissGame(game.id);
  assert.equal(fs.existsSync(manifestPath(f.root)), false, 'the real uninstall completed before the row was hidden');
  let state = f.service.store.read();
  assert.equal(state.manualExecutables.some(row => row.file === f.exe), false);
  assert.equal(Object.values(state.gameOverrides).some(row => row.apiExecutable === f.exe), false);
  assert.ok(state.manualGames.includes(f.broad)); assert.ok(state.manualGames.includes(f.otherRoot));
  assert.equal((await f.service.boot()).games.some(row => row.chosen?.path === f.exe), false);
  assert.ok((await f.service.listGames()).some(row => row.chosen?.path === f.other));
  await f.service.addManualSelection({ root: f.root, executable: f.exe, name: '重新添加的异环' });
  state = f.service.store.read();
  assert.equal(state.excludedGames.some(row => row.executable === f.exe), false);
  const added = (await f.service.listGames()).find(row => row.chosen?.path === f.exe);
  assert.ok(added); assert.equal(added.name, '重新添加的异环'); assert.equal(added.installed, false);
});

test('an unsuccessful uninstall leaves all alias metadata and exclusions unchanged', async t => {
  const f = fixture(t); const receipt = f.receipt(f.root); await f.service.store.write(f.initial);
  const game = (await f.service.boot()).games.find(row => row.chosen?.path === f.exe), before = f.service.store.read();
  f.installer.uninstall = async () => ({ removed: false, warnings: [{ code: 'ERR_FILE_CHANGED', rel: 'held.dll' }] });
  await assert.rejects(f.service.dismissGame(game.id), { code: 'ERR_BACKUP_INVALID' });
  assert.deepEqual(f.service.store.read(), before); assert.deepEqual(fs.readFileSync(manifestPath(f.root)), receipt);
  assert.ok((await f.service.listGames()).some(row => row.id === game.id));
});

test('a second receipt for the same EXE keeps its settings and visible recovery entry when the other root is removed', async t => {
  const f = fixture(t); f.receipt(f.root); const receipt = f.receipt(f.binary); await f.service.store.write(f.initial);
  await f.service.boot(); await f.service.dismissGame(idFor(f.root));
  const state = f.service.store.read();
  assert.deepEqual(fs.readFileSync(manifestPath(f.binary)), receipt);
  assert.ok(state.manualGames.includes(f.binary)); assert.ok(state.manualExecutables.some(row => row.root === f.binary && row.file === f.exe));
  assert.equal(state.gameOverrides[f.binary.toLowerCase()].api, 'dx12');
  assert.ok((await f.service.listGames()).some(row => row.dir === f.binary && row.installed));
  await f.service.addManualSelection({ root: f.root, executable: f.exe, name: '再添加' });
  assert.deepEqual(fs.readFileSync(manifestPath(f.binary)), receipt);
  assert.equal(f.service.store.read().gameOverrides[f.binary.toLowerCase()].name, '我的异环');
});

test('explicitly rebinding an unowned canonical root replaces A with B without inheriting the A API', async t => {
  const f = fixture(t), replacement = path.join(f.binary, 'Alternate.exe'); fs.writeFileSync(replacement, 'fixture B');
  await f.service.store.write({ manualGames: [f.root, f.otherRoot],
    manualExecutables: [{ root: f.root, file: f.exe }, { root: f.otherRoot, file: f.other }],
    gameOverrides: { [f.root.toLowerCase()]: { api: 'dx11', apiExecutable: f.exe, name: 'Game A' },
      [f.otherRoot.toLowerCase()]: { api: 'dx12', apiExecutable: f.other, name: 'Other game' } } });
  await f.service.boot(); assert.equal(fs.existsSync(manifestPath(f.root)), false);
  await f.service.addManualSelection({ root: f.root, executable: replacement, name: 'Game B' });
  const state = f.service.store.read();
  assert.deepEqual(state.manualExecutables.filter(row => row.root === f.root), [{ root: f.root, file: replacement }]);
  assert.equal(state.manualExecutables.some(row => row.file === f.exe), false, 'the old canonical A binding must not become a ghost alias');
  assert.deepEqual(state.manualExecutables.find(row => row.root === f.otherRoot), { root: f.otherRoot, file: f.other });
  assert.equal(state.gameOverrides[f.root.toLowerCase()].api, 'auto'); assert.equal(state.gameOverrides[f.root.toLowerCase()].apiExecutable, null);
  assert.ok((await f.service.listGames()).some(row => row.chosen?.path === replacement && row.apiOverride === 'auto'));
});
