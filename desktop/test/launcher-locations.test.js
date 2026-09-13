'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLibraryAdapter } = require('../src/library');
const { createLauncherLocations, readRegistrySnapshot } = require('../src/product/launcher-locations');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-launcher-locations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function steamRoot(root, appid, name) {
  const steam = path.join(root, 'Steam');
  const game = path.join(steam, 'steamapps', 'common', name);
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(steam, 'steamapps', `appmanifest_${appid}.acf`),
    `"AppState" { "appid" "${appid}" "name" "${name}" "installdir" "${name}" }`);
  return steam;
}

test('registry snapshot uses one bounded PowerShell helper and never spawns reg.exe', () => {
  const helper = fs.readFileSync(path.resolve(__dirname, '../src/product/launcher-locations.ps1'), 'utf8');
  assert.doesNotMatch(helper, /\breg(?:\.exe)?\b/i);
  let called = null;
  const result = readRegistrySnapshot({ platform: 'win32', runner: (...args) => { called = args; throw Object.assign(new Error('blocked'), { code: 'EPERM' }); } });
  assert.ok(called); assert.equal(path.basename(called[0]).toLowerCase(), 'powershell.exe');
  assert.ok(called[2].timeout > 0); assert.ok(called[2].maxBuffer > 0);
  assert.match(result.warnings[0].code, /LAUNCHER_REGISTRY_SNAPSHOT_FAILED/);
});

test('Steam and GOG discovery survive registry helper failure and preserve a saved user path', t => {
  const root = temp(t);
  const steam = steamRoot(root, '1234', 'Steam Game');
  const gog = path.join(root, 'Gog Game'); fs.mkdirSync(gog);
  const saved = steamRoot(root, '5678', 'Saved Game');
  const locations = {
    snapshot: () => ({ steamPath: null, gog: [{ id: 'gog-1', name: 'GOG Game', path: gog }], warnings: [{ code: 'LAUNCHER_REGISTRY_SNAPSHOT_FAILED', message: 'blocked' }] }),
    defaultSteamRoots: () => []
  };
  const library = createLibraryAdapter({ launcherLocations: locations, epicReader: () => ({ games: [], warnings: [] }) });
  const result = library.discover([saved], false, []);
  const names = result.games.map(game => game.name).sort();
  assert.deepEqual(names, ['GOG Game', 'Saved Game', 'Steam Game']);
  assert.equal(result.warnings[0].code, 'LAUNCHER_REGISTRY_SNAPSHOT_FAILED');
  assert.ok(result.games.every(game => game.dir.startsWith(root)));
  void steam;
});

test('Epic manifests remain a bounded local read without vendor GOG or eval hooks', t => {
  const root = temp(t);
  const epicRoot = path.join(root, 'Epic'); fs.mkdirSync(epicRoot);
  const game = path.join(root, 'Epic Game'); fs.mkdirSync(game);
  fs.writeFileSync(path.join(epicRoot, 'game.item'), JSON.stringify({ AppName: 'epic-1', DisplayName: 'Epic Game', InstallLocation: game }));
  const locations = createLauncherLocations({ snapshot: () => ({ steamPath: null, gog: [], warnings: [] }), epicRoot });
  const result = locations.epic();
  assert.deepEqual(result.warnings, []); assert.equal(result.games[0].launcher, 'Epic Games');
});
