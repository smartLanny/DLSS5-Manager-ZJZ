'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createHoYoDiscovery, parseHoYoGameData, readStarwardInstalls } = require('../src/product/hoyo-discovery');
const { HOYO_RECIPE, HOYO_CLIENTS, launcherRequest, fingerprint } = require('../src/product/hoyoshade-profiles');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function pe(label, bits = 64) {
  const b = Buffer.alloc(0x500); b.write('MZ'); b.writeUInt32LE(0x80, 0x3c); b.write('PE\0\0', 0x80);
  b.writeUInt16LE(bits === 64 ? 0x8664 : 0x14c, 0x84); b.writeUInt16LE(0xf0, 0x94); b.writeUInt16LE(bits === 64 ? 0x20b : 0x10b, 0x98); b.write(label, 0x300); return b;
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
function vint(number) { const out = []; do { const byte = number % 128; number = Math.floor(number / 128); out.push(byte | (number ? 128 : 0)); } while (number); return Buffer.from(out); }
function mmkv(rows) {
  const chunks = [vint(0xffffff)];
  for (const [name, value] of rows) {
    const k = Buffer.from(name), v = value === null ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : (() => { const text = Buffer.from(JSON.stringify(value)); return Buffer.concat([vint(text.length), text]); })();
    chunks.push(vint(k.length), k, vint(v.length), v);
  }
  const data = Buffer.concat(chunks), bytes = Buffer.alloc(Math.max(4096, data.length + 4)); bytes.writeUInt32LE(data.length); data.copy(bytes, 4); return bytes;
}
function snapshot(root) {
  const result = {};
  function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) walk(file); else { const s = fs.statSync(file); result[path.relative(root, file)] = { sha256: hash(file), size: s.size, mtimeMs: s.mtimeMs }; } } }
  walk(root); return result;
}
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appData = path.join(root, 'AppData'), programs = path.join(root, 'Program Files');
  const registry = { launchers: [], gameRoots: [], starwardUserData: [] };
  const options = { appData, programFiles: [programs], readRegistry: async () => registry, knownGames: [], knownLaunchers: [], savedBindings: [] };
  const makeGame = (family = 'zzz', channel = 'cn', directory = path.join(root, 'Games', family), config = '[General]\ngame_version=3.2.0\nchannel=1\nsub_channel=2\n') => {
    const client = HOYO_CLIENTS.find(row => row.family === family && row.channel === channel);
    const exe = write(path.join(directory, client.exeName), pe(client.gameBiz)); write(path.join(directory, 'config.ini'), config); return { exe, directory, client };
  };
  const makeHYP = (directory = path.join(programs, 'miHoYo Launcher'), primary = 'nap_cn') => {
    const launcher = write(path.join(directory, 'launcher.exe'), pe('HoYoPlay'));
    write(path.join(directory, 'config.ini'), `[hyp]\nchannel=1\nsub_channel=2\nprimary_game=${primary}\n[box]\naccount-secret=do-not-read\n`);
    return launcher;
  };
  const writeHYP = rows => write(path.join(appData, 'miHoYo', 'HYP', '1_2', 'data', 'gamedata.dat'), mmkv(rows));
  const makeStarward = (directory = path.join(programs, 'Starward')) => write(path.join(directory, 'Starward.exe'), pe('Starward'));
  return { root, appData, programs, registry, options, makeGame, makeHYP, writeHYP, makeStarward, service: () => createHoYoDiscovery(options) };
}
function saveProfile(game, launcher, kind = 'hoyoplay') {
  const body = { version: 1, recipeId: HOYO_RECIPE.id, sourceCommit: HOYO_RECIPE.sourceCommit, family: game.client.family, channel: game.client.channel,
    releaseCategory: 'public', inputRoute: 'native', exePath: game.exe, exeSha256: hash(game.exe), architecture: 64,
    launcher: { ...launcherRequest(game.client, { kind, path: launcher }), sha256: hash(launcher) } };
  return { ...body, bindingId: fingerprint(body) };
}
function sqlite(file, rows) {
  const { DatabaseSync } = require('node:sqlite'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file); db.exec('CREATE TABLE KVT (Key TEXT PRIMARY KEY, Value TEXT, Time TEXT); CREATE TABLE GameAccount (secret TEXT)');
  const add = db.prepare('INSERT INTO KVT (Key,Value) VALUES (?,?)'); for (const [k, v] of rows) add.run(k, v);
  db.exec("INSERT INTO GameAccount VALUES ('ACCOUNT_SECRET_MUST_NOT_ESCAPE')"); db.close(); return file;
}

test('MMKV decodes only public installation fields, applies overwrite/tombstones, and ignores private malformed values', () => {
  const root = path.resolve('fixture-game');
  const bytes = mmkv([
    ['account', Buffer.from([255, 255, 255])], ['nap_beta', { gameBiz: 'nap_beta', installPath: root, cookie: 'secret' }],
    ['nap_cn', { gameBiz: 'nap_cn', installPath: path.resolve('old'), token: 'not-returned' }],
    ['hk4e_cn', { gameBiz: 'hk4e_cn', installPath: path.resolve('deleted') }], ['hk4e_cn', null],
    ['nap_cn', { gameBiz: 'nap_cn', installPath: root, persistentInstallPath: root, gameSettings: { account: 'PRIVATE' } }]
  ]);
  assert.deepEqual(parseHoYoGameData(bytes), [{ gameBiz: 'nap_cn', gameRoot: root }]);
  assert.deepEqual(parseHoYoGameData(Buffer.alloc(4096)), []);
});

test('MMKV refuses truncation, overflowing lengths and mismatched game identity without exposing record text', () => {
  const bytes = mmkv([['nap_cn', { gameBiz: 'nap_cn', installPath: path.resolve('fixture') }]]);
  assert.throws(() => parseHoYoGameData(bytes.subarray(0, 20)), /不完整/);
  const overflow = Buffer.from([9, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 1, 1, 1, 1]);
  assert.throws(() => parseHoYoGameData(overflow), /溢出/);
  assert.throws(() => parseHoYoGameData(mmkv([['nap_cn', { gameBiz: 'ACCOUNT_SECRET' }]])), error => /冲突/.test(error.message) && !error.message.includes('ACCOUNT_SECRET'));
});

test('all eleven public client mappings are discoverable by recorded gameBiz with a unique launcher', async t => {
  const f = setup(t); f.makeHYP();
  const entries = HOYO_CLIENTS.map(client => {
    const game = f.makeGame(client.family, client.channel, path.join(f.root, 'Games', client.gameBiz));
    return [client.gameBiz, { gameBiz: client.gameBiz, installPath: game.directory }];
  });
  f.writeHYP(entries);
  const before = snapshot(f.root), result = await f.service().discover();
  assert.equal(result.games.length, 11); assert.equal(result.launchers.length, 1); assert.deepEqual(result.warnings, []);
  for (const game of result.games) {
    assert.equal(game.architecture, 64); assert.equal(game.releaseCategory, 'public'); assert.equal(game.gameVersion, '3.2.0');
    assert.equal(game.automaticBinding.channel, HOYO_CLIENTS.find(row => row.gameBiz === game.gameBiz).channel);
  }
  assert.deepEqual(snapshot(f.root), before, 'discovery must never write game, launcher or data files');
});

test('registry and saved paths work before finite fallback; missing defaults and unrelated deep folders are not games', async t => {
  const f = setup(t), game = f.makeGame(), launcher = f.makeHYP(path.join(f.root, 'Relocated Launcher'));
  f.registry.launchers.push({ kind: 'hoyoplay', path: launcher });
  f.writeHYP([['nap_cn', { gameBiz: 'nap_cn', installPath: game.directory }], ['hk4e_cn', { gameBiz: 'hk4e_cn', installPath: path.join(f.root, 'not-installed') }]]);
  f.makeGame('starrail', 'cn', path.join(f.programs, 'unrelated', 'deep', 'Star Rail Game'));
  const result = await f.service().discover();
  assert.deepEqual(result.games.map(row => row.exePath), [game.exe]); assert.equal(result.games[0].automaticBinding.launcher.path, launcher);
});

test('same-name channels remain undecided without installation evidence, even beside a launcher', async t => {
  const f = setup(t), launcher = f.makeHYP(), game = f.makeGame('starrail', 'cn', path.join(path.dirname(launcher), 'games', 'Star Rail Game'));
  f.options.knownGames = async () => [{ scan: { chosen: { path: game.exe } } }];
  const result = await f.service().discover(), found = result.games[0];
  assert.equal(found.channel, null); assert.equal(found.gameBiz, null); assert.equal(found.automaticBinding, null);
  assert.deepEqual(found.channelCandidates, ['cn', 'bilibili', 'global']); assert.equal(found.launchers[0].matched, false);
});

test('manual inspection rejects launchers, renamed beta clients, explicit non-public gameBiz and x86 clients', async t => {
  const f = setup(t), launcher = f.makeHYP(), game = f.makeGame();
  assert.equal((await f.service().inspectGame(launcher)).games.length, 0);
  assert.equal((await f.service().inspectGame(write(path.join(f.root, 'ZenlessZoneZeroBeta.exe'), pe('beta')))).games.length, 0);
  write(path.join(game.directory, 'config.ini'), '[General]\ngame_biz=nap_beta\n');
  assert.equal((await f.service().inspectGame(game.directory)).warnings[0].code, 'HOYO_PUBLIC_CLIENT_ONLY');
  write(path.join(game.directory, 'config.ini'), '[General]\n'); write(game.exe, pe('x86', 32));
  assert.equal((await f.service().inspectGame(game.exe)).warnings[0].code, 'HOYO_ARCHITECTURE');
});

test('duplicate game paths and versioned HYP aliases collapse to one game and one launcher', async t => {
  const f = setup(t), launcher = f.makeHYP(), game = f.makeGame();
  const alias = write(path.join(path.dirname(launcher), '1.18.0.380', 'HYP.exe'), pe('HYP alias'));
  f.options.knownLaunchers = [{ kind: 'hoyoplay', path: alias }, { kind: 'hoyoplay', path: launcher }];
  f.options.knownGames = [game.exe, game.directory, { exePath: game.exe }];
  f.writeHYP([['nap_cn', { gameBiz: 'nap_cn', installPath: game.directory, persistentInstallPath: game.directory }]]);
  const result = await f.service().discover();
  assert.equal(result.games.length, 1); assert.equal(result.launchers.length, 1); assert.equal(result.launchers[0].path, launcher);
  assert.equal(result.games[0].launchers.length, 1); assert.ok(result.games[0].automaticBinding);
});

test('portable Starward config resolves only installation keys and never creates SQLite sidecars', async t => {
  const f = setup(t), launcher = f.makeStarward(), game = f.makeGame('starrail', 'bilibili');
  write(path.join(path.dirname(launcher), 'config.ini'), 'UserDataFolder=../Starward Data\n');
  const database = sqlite(path.join(f.programs, 'Starward Data', 'StarwardDatabase.db'), [
    ['install_path_hkrpg_bilibili', game.directory], ['account', 'PRIVATE_SECRET'], ['install_path_hkrpg_beta', path.join(f.root, 'beta')]
  ]);
  const before = snapshot(f.root), result = await f.service().discover();
  assert.equal(result.games.length, 1); assert.equal(result.games[0].channel, 'bilibili');
  assert.equal(result.games[0].automaticBinding.launcher.path, launcher);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'), false);
  assert.deepEqual(snapshot(f.root), before); assert.equal(fs.existsSync(database + '-shm'), false);
});

test('registered Starward resolves its registry user data, and active WAL is never read as an old authoritative snapshot', async t => {
  const f = setup(t), launcher = f.makeStarward(path.join(f.root, 'custom launcher')), game = f.makeGame();
  f.registry.launchers = [{ kind: 'starward', path: launcher }]; f.registry.starwardUserData = [path.join(f.root, 'custom data')];
  const file = sqlite(path.join(f.registry.starwardUserData[0], 'StarwardDatabase.db'), [['install_path_nap_cn', game.directory]]);
  assert.equal((await f.service().discover()).games[0].automaticBinding.launcher.kind, 'starward');
  write(file + '-wal', 'active transaction');
  await assert.rejects(readStarwardInstalls(file), /正在写入/);
  const result = await f.service().discover(); assert.equal(result.games.length, 0); assert.ok(result.warnings.some(row => row.code === 'HOYO_STARWARD_RECORDS'));
});

test('two authoritative launchers require confirmation; a verified saved binding takes priority', async t => {
  const f = setup(t), hyp = f.makeHYP(), starward = f.makeStarward(), game = f.makeGame();
  f.writeHYP([['nap_cn', { gameBiz: 'nap_cn', installPath: game.directory }]]);
  sqlite(path.join(path.dirname(starward), 'StarwardDatabase.db'), [['install_path_nap_cn', game.directory]]);
  const ambiguous = (await f.service().discover()).games[0];
  assert.equal(ambiguous.channel, 'cn'); assert.equal(ambiguous.automaticBinding, null); assert.ok(ambiguous.warnings.some(row => row.code === 'HOYO_LAUNCHER_AMBIGUOUS'));
  f.options.savedBindings = async () => [{ hoyoProfile: saveProfile(game, hyp), verified: true }];
  const chosen = (await f.service().discover()).games[0]; assert.equal(chosen.automaticBinding.launcher.path, hyp); assert.equal(chosen.launchers.length, 2);
});

test('updated game or launcher preserves saved candidate paths but prevents automatic rebinding even if records still match', async t => {
  const f = setup(t), launcher = f.makeHYP(), game = f.makeGame();
  f.writeHYP([['nap_cn', { gameBiz: 'nap_cn', installPath: game.directory }]]);
  const profile = saveProfile(game, launcher); f.options.savedBindings = [profile];
  fs.appendFileSync(game.exe, 'game update');
  let result = (await f.service().discover()).games[0];
  assert.equal(result.automaticBinding, null); assert.equal(result.launchers[0].path, launcher); assert.ok(result.warnings.some(row => row.code === 'HOYO_BINDING_RECONFIRM'));
  write(game.exe, pe(game.client.gameBiz)); fs.appendFileSync(launcher, 'launcher update');
  result = (await f.service().discover()).games[0]; assert.equal(result.automaticBinding, null); assert.equal(result.launchers[0].path, launcher);
  fs.unlinkSync(launcher);
  const missing = await f.service().discover(); result = missing.games[0];
  assert.equal(result.automaticBinding, null); assert.equal(result.launchers[0].path, launcher); assert.equal(missing.launchers[0].available, false);
});

test('conflicting channels are visible and cannot automatically select the first record', async t => {
  const f = setup(t), game = f.makeGame(), launcher = f.makeStarward();
  sqlite(path.join(path.dirname(launcher), 'StarwardDatabase.db'), [['install_path_nap_cn', game.directory], ['install_path_nap_bilibili', game.directory]]);
  const result = (await f.service().discover()).games[0];
  assert.equal(result.channel, null); assert.equal(result.gameBiz, null); assert.equal(result.automaticBinding, null);
  assert.ok(result.warnings.some(row => row.code === 'HOYO_CHANNEL_CONFLICT'));
});

test('corrupt or unavailable records degrade to manual candidates without returning private content', async t => {
  const f = setup(t), game = f.makeGame(), launcher = f.makeHYP(); f.options.knownGames = [game.exe];
  f.writeHYP([['nap_cn', Buffer.from('PRIVATE_ACCOUNT_SECRET')]]);
  const result = await f.service().discover();
  assert.equal(result.games.length, 1); assert.equal(result.games[0].automaticBinding, null); assert.equal(result.games[0].launchers[0].path, launcher);
  assert.ok(result.warnings.some(row => row.code === 'HOYO_INSTALL_RECORDS')); assert.equal(JSON.stringify(result).includes('PRIVATE_ACCOUNT_SECRET'), false);
  f.options.readRegistry = async () => { throw Error('PRIVATE_REGISTRY_SECRET'); };
  const degraded = await f.service().discover(); assert.equal(degraded.games.length, 1); assert.equal(JSON.stringify(degraded).includes('PRIVATE_REGISTRY_SECRET'), false);
});

test('link-based paths are refused and a SQL view cannot redirect whitelisted installation reads', async t => {
  const f = setup(t), game = f.makeGame();
  const link = path.join(f.root, 'linked-game'); fs.symlinkSync(game.directory, link, 'junction');
  const result = await f.service().inspectGame(link); assert.equal(result.games.length, 0); assert.ok(result.warnings.length);
  const { DatabaseSync } = require('node:sqlite'), file = path.join(f.root, 'view.db'), db = new DatabaseSync(file);
  db.exec("CREATE TABLE Account(secret TEXT); CREATE VIEW KVT AS SELECT 'install_path_nap_cn' AS Key,secret AS Value FROM Account"); db.close();
  await assert.rejects(readStarwardInstalls(file), /记录表不可用/);
});
