'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryService, idFor } = require('../src/product/library-service');
const { newManifest, manifestPath } = require('../src/product/manifest');
const { dedupe } = require('../vendor/DLSS5-Swapper/src/library');

function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'library-root-alias-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const outer = path.join(temporary, 'Neverness'), root = path.join(outer, 'Client', 'WindowsNoEditor');
  const binary = path.join(root, 'HT', 'Binaries', 'Win64'), exe = path.join(binary, 'HTGame.exe'), other = path.join(binary, 'Other.exe');
  const native = path.join(root, 'Engine', 'Plugins', 'Runtime', 'Nvidia', 'DLSS', 'Binaries', 'ThirdParty', 'Win64', 'nvngx_dlss.dll');
  fs.mkdirSync(binary, { recursive: true }); fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(exe, 'fixture'); fs.writeFileSync(other, 'fixture');
  if (!options.noNative) fs.writeFileSync(native, 'native fixture');
  const under = (file, dir) => !path.relative(dir, file).startsWith('..');
  const visited = [];
  const scan = {
    async scanGame(dir) {
      visited.push(dir);
      const candidate = file => ({ path: file, rel: path.relative(dir, file), name: path.basename(file), bitness: 64,
        api: 'dxgi', apiLabel: 'DirectX 12', dx12: true, via: 'imports', size: 90000000 });
      const candidates = [options.omitPreferred ? other : exe, ...(options.omitPreferred ? [] : [other])].map(candidate);
      const dll = !options.noNative && under(native, dir) ? { name: 'nvngx_dlss.dll', path: native, rel: path.relative(dir, native), bitness: 64 } : null;
      return { gameDir: dir, chosen: candidates[0], exeCandidates: candidates, dlssFiles: dll ? [dll] : [{ name: 'nvngx_dlssnr.dll' }], primaryDlss: dll };
    },
    selectPrimaryDlss(files) { return files.find(row => row.name === 'nvngx_dlss.dll') || null; }
  };
  const library = createLibraryService({ scan, library: { discover: () => ({ games: options.discovered || [], roots: [] }), dedupe } });
  const state = { manualGames: [binary, root, outer], manualExecutables: [{ root: binary, file: exe }, { root, file: exe }],
    gameOverrides: { [binary.toLowerCase()]: { api: 'dx12', apiExecutable: exe, name: 'HT' } }, excludedGames: [], excludedRoots: [], scanFolders: [], scanDrives: false };
  const receipt = dir => { const value = newManifest(dir, exe, 'dxgi'); value.payloadVersion = 'imported-fixture';
    fs.mkdirSync(path.dirname(manifestPath(dir)), { recursive: true }); fs.writeFileSync(manifestPath(dir), JSON.stringify(value)); return fs.readFileSync(manifestPath(dir)); };
  return { temporary, outer, root, binary, exe, other, native, visited, library, state, receipt };
}

test('legacy binary root and outer folder coalesce at the existing receipt without losing the EXE-bound API', async t => {
  const f = fixture(t), receipt = f.receipt(f.root), before = structuredClone(f.state);
  const rows = await f.library.scanAll(f.state);
  assert.equal(rows.length, 1); const row = rows[0];
  assert.equal(row.dir, f.root); assert.equal(row.id, idFor(f.root)); assert.equal(row.chosen.path, f.exe);
  assert.equal(row.apiOverride, 'dx12'); assert.equal(row.chosen.apiResolution.source, 'override');
  assert.equal(row.scan.primaryDlss.path, f.native); assert.equal(row.installed, true); assert.equal(row.addonVersion, 'imported-fixture');
  assert.deepEqual(new Set(row.rootAliases), new Set([f.binary, f.root, f.outer]));
  assert.equal(f.visited.length, new Set(f.visited).size, 'aliases share one scan per directory within a refresh');
  assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(manifestPath(f.root)), receipt);
});

test('preparing an outer folder returns paths and API evidence consistent with its inferred root', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.binary, 'ReShade.log'), `Initializing crosire's ReShade version '6.8' into '${f.exe}' ...\nRedirecting D3D11CreateDevice(...)\nRedirecting D3D12CreateDevice(...)\n`);
  const selection = await f.library.prepareSelection(f.outer, f.exe);
  assert.equal(selection.root, f.root); assert.equal(selection.chosen.path, f.exe);
  assert.equal(selection.chosen.rel, path.relative(f.root, f.exe)); assert.equal(selection.chosen.detectedApi, 'dx12');
  assert.equal(selection.candidates.find(row => row.path === f.exe).rel, selection.chosen.rel);
});

test('canonical explicit choices win aliases while another EXE never inherits the old API', async t => {
  const f = fixture(t); f.state.gameOverrides[f.root.toLowerCase()] = { api: 'auto', apiExecutable: f.exe };
  let rows = await f.library.scanAll(f.state); assert.equal(rows[0].apiOverride, 'auto');
  f.state.manualGames = [f.root]; f.state.manualExecutables = [{ root: f.root, file: f.other }];
  rows = await f.library.scanAll(f.state); assert.equal(rows[0].chosen.path, f.other); assert.equal(rows[0].apiOverride, 'auto');
});

test('two recovery receipts for the same executable remain visible and keep their roots', async t => {
  const f = fixture(t); const nested = f.receipt(f.binary), outer = f.receipt(f.root);
  f.state.manualGames = [f.binary, f.root];
  const rows = await f.library.scanAll(f.state);
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.installed));
  assert.deepEqual(new Set(rows.map(row => row.dir)), new Set([f.binary, f.root]));
  assert.deepEqual(fs.readFileSync(manifestPath(f.binary)), nested); assert.deepEqual(fs.readFileSync(manifestPath(f.root)), outer);
});

test('missing native SR does not broaden a saved root or cross the game boundary', async t => {
  const f = fixture(t, { noNative: true }); f.state.manualGames = [f.binary]; f.state.manualExecutables = [{ root: f.binary, file: f.exe }];
  const rows = await f.library.scanAll(f.state); assert.equal(rows[0].dir, f.binary);
  assert.ok(f.visited.every(dir => dir === f.outer || dir.startsWith(f.outer + path.sep)));
});

test('saved EXE absent from heuristics stays selected, and disappearance never selects a sibling', async t => {
  const f = fixture(t, { omitPreferred: true }); f.state.manualGames = [f.binary]; f.state.manualExecutables = [{ root: f.binary, file: f.exe }];
  let rows = await f.library.scanAll(f.state); assert.equal(rows[0].chosen.path, f.exe);
  fs.unlinkSync(f.exe); rows = await f.library.scanAll(f.state); assert.equal(rows[0].chosen, null);
  assert.equal(rows[0].scan.preferredExecutableMissing, true);
});

test('normalizing an alias does not resurrect a user-excluded game', async t => {
  const f = fixture(t); f.state.excludedGames = [{ dir: f.root, executable: f.exe }];
  assert.deepEqual(await f.library.scanAll(f.state), []);
});

test('launcher metadata dedupe retains the saved executable rather than its heuristic sibling', async t => {
  const options = {}, f = fixture(t, options);
  options.discovered = [{ launcher: 'Steam', id: '12345', name: 'Launcher title', dir: f.root }];
  f.state.manualGames = [f.root]; f.state.manualExecutables = [{ root: f.root, file: f.other }];
  const rows = await f.library.scanAll(f.state);
  assert.equal(rows.length, 1); assert.equal(rows[0].launcher, 'Steam'); assert.equal(rows[0].chosen.path, f.other);
  assert.equal(rows[0].apiOverride, 'auto', 'the previous HT EXE API choice does not follow Other.exe');
});
