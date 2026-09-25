'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, validate } = require('../src/product/state-store');
const { normalizeError } = require('../src/product/errors');

function fixture(t, value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-startup-')), file = path.join(root, 'settings.json');
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  if (value !== undefined) fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  return { root, file, store: createStore(file) };
}
const ioWith = (sync = {}, promises = {}) => ({ ...fs, ...sync, promises: { ...fs.promises, ...promises } });
const nativeError = code => Object.assign(new Error(`injected ${code}`), { code });

test('launch preferences retain their own EXE binding without borrowing API identity', t => {
  const f = fixture(t), exe = path.join(f.root, 'game.exe');
  const result = validate({ version: 1, gameOverrides: { [f.root]: { launchMode: 'steam', launchExecutable: exe } } });
  assert.equal(result.gameOverrides[f.root.toLowerCase()].launchMode, 'steam');
  assert.equal(result.gameOverrides[f.root.toLowerCase()].launchExecutable, exe);
  const invalid = validate({ version: 1, gameOverrides: { [f.root]: { launchMode: 'steam', apiExecutable: exe } } });
  assert.deepEqual(invalid.gameOverrides, {});
});

test('an absent config starts normally and the first write creates only current settings', async t => {
  const f = fixture(t);
  assert.deepEqual(f.store.read(), validate(null)); assert.equal(f.store.readRecoveryStatus().state, 'missing');
  assert.equal(fs.existsSync(f.file), false);
  await f.store.write({ addonVersion: '0.4.2' });
  assert.equal(createStore(f.file).read().addonVersion, '0.4.2');
  assert.deepEqual(fs.readdirSync(f.root), ['settings.json']);
});

test('valid settings and UTF-8 BOM retain API bindings, paths and unknown extension records', async t => {
  const f = fixture(t), exe = path.join(f.root, 'Game.exe');
  const original = validate({ version: 1, scanFolders: [f.root], manualGames: [f.root], manualExecutables: [{ root: f.root, file: exe }],
    gameOverrides: { [f.root.toLowerCase()]: { name: '原游戏', api: 'dx12', apiExecutable: exe } }, payloadSourcePath: f.root, payloadSourceIdentity: 'a'.repeat(64),
    addonVersion: '0.4.2', recoveryExtension: { receipt: 'unchanged', enabled: false } });
  const bytes = Buffer.from('\ufeff' + JSON.stringify(original)); fs.writeFileSync(f.file, bytes);
  const read = f.store.read(); assert.deepEqual(read, original); assert.equal(f.store.readRecoveryStatus().state, 'ok');
  assert.deepEqual(fs.readFileSync(f.file), bytes);
  const recoveryFile = path.join(f.root, 'launch-settings.json'); fs.writeFileSync(recoveryFile, 'separate recovery records');
  const next = await f.store.write({ scanDrives: true });
  assert.deepEqual(next.gameOverrides, original.gameOverrides); assert.deepEqual(next.manualExecutables, original.manualExecutables);
  assert.equal(next.payloadSourcePath, original.payloadSourcePath); assert.equal(next.payloadSourceIdentity, original.payloadSourceIdentity);
  assert.deepEqual(next.recoveryExtension, original.recoveryExtension);
  assert.equal(fs.readFileSync(recoveryFile, 'utf8'), 'separate recovery records');
  assert.equal(fs.readdirSync(f.root).some(name => name.includes('.recovery-')), false);
});

test('malformed JSON and invalid UTF-8 preserve exact original bytes before default startup or a later save', async t => {
  for (const bytes of [Buffer.from('{"version":1,"manualGames":['), Buffer.from([0xff, 0xfe, 0x7b, 0x00])]) {
    const f = fixture(t, bytes); assert.deepEqual(f.store.read(), validate(null));
    const recovery = f.store.readRecoveryStatus();
    assert.equal(recovery.state, 'recovered'); assert.equal(recovery.reason, 'malformed-json'); assert.equal(recovery.writeBlocked, false);
    assert.match(recovery.message, /默认配置.*原文件尚未覆盖/);
    assert.deepEqual(fs.readFileSync(f.file), bytes); assert.deepEqual(fs.readFileSync(recovery.backupFile), bytes);
    f.store.read(); assert.equal(f.store.readRecoveryStatus().backupFile, recovery.backupFile, 'repeated startup reads reuse the same preservation copy');
    await f.store.write({ addonVersion: '0.4.2' });
    assert.equal(createStore(f.file).read().addonVersion, '0.4.2'); assert.deepEqual(fs.readFileSync(recovery.backupFile), bytes);
    assert.match(f.store.readRecoveryStatus().message, /原始副本仍保留/);
  }
});

test('bad v1 fields are isolated without discarding valid API, manual EXE, source or extension data', async t => {
  const f = fixture(t), exe = path.join(f.root, 'Game.exe');
  const input = { version: 1, animationsEnabled: 'false', theme: 'midnight', scanDrives: 'true', scanFolders: 'old wrong type', manualGames: [f.root, 12, f.root + '\0bad'],
    manualExecutables: [{ root: f.root, file: exe }, { root: [], file: 7 }],
    gameOverrides: { [f.root]: { api: 'vulkan', apiExecutable: exe } }, excludedGames: 'wrong',
    payloadSourcePath: f.root, payloadSourceIdentity: 'b'.repeat(64), addonVersion: '0.4.2', recoveryExtension: { keep: ['sr', 'fg'] } };
  fs.writeFileSync(f.file, JSON.stringify(input)); const bytes = fs.readFileSync(f.file);
  const read = f.store.read(), status = f.store.readRecoveryStatus();
  assert.equal(status.reason, 'fields-normalized'); assert.ok(status.changedFields.includes('scanFolders')); assert.ok(status.changedFields.includes('manualGames'));
  assert.equal(read.animationsEnabled, true); assert.ok(status.changedFields.includes('animationsEnabled'));
  assert.equal(read.theme, 'system'); assert.ok(status.changedFields.includes('theme'));
  assert.equal(read.scanDrives, false); assert.deepEqual(read.scanFolders, []); assert.deepEqual(read.manualGames, [f.root]);
  assert.equal(read.gameOverrides[f.root.toLowerCase()].api, 'vulkan'); assert.equal(read.gameOverrides[f.root.toLowerCase()].apiExecutable, exe);
  assert.equal(read.payloadSourcePath, f.root); assert.equal(read.payloadSourceIdentity, 'b'.repeat(64)); assert.equal(read.addonVersion, '0.4.2');
  assert.deepEqual(read.manualExecutables, [{ root: f.root, file: exe }]); assert.deepEqual(read.recoveryExtension, input.recoveryExtension);
  assert.deepEqual(fs.readFileSync(f.file), bytes); assert.deepEqual(fs.readFileSync(status.backupFile), bytes);
  await f.store.write({ scanDrives: true }); assert.deepEqual(createStore(f.file).read().recoveryExtension, input.recoveryExtension);
});

test('animation preference defaults on and persists an explicit off value', async t => {
  const f = fixture(t);
  assert.equal(f.store.read().animationsEnabled, true);
  const saved = await f.store.write({ animationsEnabled: false });
  assert.equal(saved.animationsEnabled, false);
  assert.equal(createStore(f.file).read().animationsEnabled, false);
});

test('theme preference defaults to system and persists a supported override', async t => {
  const f = fixture(t);
  assert.equal(f.store.read().theme, 'system');
  const saved = await f.store.write({ theme: 'dark' });
  assert.equal(saved.theme, 'dark');
  assert.equal(createStore(f.file).read().theme, 'dark');
});

test('component storage keeps only a validated absolute library pointer in the small settings file', t => {
  const f=fixture(t), custom=path.join(f.root,'other-drive','component-library');
  assert.equal(validate({version:1,componentLibraryPath:custom}).componentLibraryPath,custom);
  assert.equal(validate({version:1,componentLibraryPath:'relative/cache'}).componentLibraryPath,null);
  assert.equal(validate({version:1,componentLibraryPreviousPath:custom}).componentLibraryPreviousPath,custom);
  assert.equal(validate({version:1,componentLibraryPreviousPath:'relative/cache'}).componentLibraryPreviousPath,null);
});

test('unsupported versions and root shapes remain read-only and are never stamped as v1', async t => {
  for (const value of [{ version: 2, manualGames: ['future data'] }, { version: '1' }, { manualGames: [] }, [], null]) {
    const f = fixture(t, JSON.stringify(value)), bytes = fs.readFileSync(f.file);
    assert.deepEqual(f.store.read(), validate(null));
    const status = f.store.readRecoveryStatus(); assert.equal(status.state, 'blocked'); assert.equal(status.writeBlocked, true);
    assert.match(status.message, /只读.*不能自动迁移/);
    await assert.rejects(f.store.write({ scanDrives: true }), { code: 'SETTINGS_STORE_VERSION_UNSUPPORTED' });
    assert.deepEqual(fs.readFileSync(f.file), bytes); assert.deepEqual(fs.readdirSync(f.root), ['settings.json']);
  }
});

test('unreadable files and a directory at the settings path produce readable startup errors instead of defaults', t => {
  const f = fixture(t, { version: 1, addonVersion: '0.4.2' }), before = fs.readFileSync(f.file);
  const denied = createStore(f.file, { fs: ioWith({ readFileSync() { throw nativeError('EACCES'); } }) });
  assert.throws(() => denied.read(), error => {
    assert.equal(error.code, 'SETTINGS_STORE_READ_FAILED'); assert.equal(error.details.causeCode, 'EACCES');
    assert.match(normalizeError(error).message, /无法读取配置文件/); return true;
  });
  assert.equal(denied.readRecoveryStatus().state, 'error'); assert.deepEqual(fs.readFileSync(f.file), before);
  const directory = fixture(t); fs.mkdirSync(directory.file);
  assert.throws(() => directory.store.read(), { code: 'SETTINGS_STORE_READ_FAILED' });
  assert.equal(fs.statSync(directory.file).isDirectory(), true);
});

test('failure to preserve corrupt bytes is surfaced and does not permit a reset write', async t => {
  const f = fixture(t, '{broken'), before = fs.readFileSync(f.file);
  const store = createStore(f.file, { fs: ioWith({ writeFileSync() { throw nativeError('EACCES'); } }) });
  assert.throws(() => store.read(), { code: 'SETTINGS_STORE_BACKUP_FAILED' });
  assert.equal(store.readRecoveryStatus().writeBlocked, true);
  await assert.rejects(store.write({ scanDrives: true }), { code: 'SETTINGS_STORE_BACKUP_FAILED' });
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('rename failure preserves existing data, cleans its temporary file and does not poison later writes', async t => {
  const f = fixture(t, validate({ version: 1, addonVersion: '0.4.2', custom: { keep: true } })), before = fs.readFileSync(f.file);
  let failRename = true;
  const store = createStore(f.file, { fs: ioWith({}, { rename: async (...args) => { if (failRename) throw nativeError('EACCES'); return fs.promises.rename(...args); } }) });
  await assert.rejects(store.write({ scanDrives: true }), error => error.code === 'SETTINGS_STORE_WRITE_FAILED' && error.details.causeCode === 'EACCES');
  assert.deepEqual(fs.readFileSync(f.file), before); assert.deepEqual(fs.readdirSync(f.root), ['settings.json']);
  assert.equal(store.readRecoveryStatus().state, 'error');
  failRename = false; const next = await store.write({ lastSelectedGame: 'game-1' });
  assert.equal(next.scanDrives, false); assert.equal(next.lastSelectedGame, 'game-1'); assert.deepEqual(next.custom, { keep: true });
});

test('concurrent patches remain ordered and never reuse or remove an unrelated legacy temporary file', async t => {
  const f = fixture(t), oldTemp = f.file + '.tmp'; fs.writeFileSync(oldTemp, 'old evidence');
  await Promise.all([f.store.write({ scanDrives: true }), f.store.write({ addonVersion: '0.4.2' })]);
  const current = f.store.read(); assert.equal(current.scanDrives, true); assert.equal(current.addonVersion, '0.4.2');
  assert.equal(fs.readFileSync(oldTemp, 'utf8'), 'old evidence');
});

test('an external edit or a changed recovery copy blocks replacement instead of losing those bytes', async t => {
  const f = fixture(t, { version: 1, addonVersion: '0.4.2' });
  const outsideEdit = JSON.stringify({ version: 1, addonVersion: 'external-selection' });
  const store = createStore(f.file, { fs: ioWith({}, { writeFile: async (...args) => { await fs.promises.writeFile(...args); fs.writeFileSync(f.file, outsideEdit); } }) });
  await assert.rejects(store.write({ scanDrives: true }), { code: 'SETTINGS_STORE_CHANGED' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), outsideEdit); assert.deepEqual(fs.readdirSync(f.root), ['settings.json']);
  const corrupt = fixture(t, '{original broken bytes'); corrupt.store.read();
  fs.writeFileSync(corrupt.store.readRecoveryStatus().backupFile, 'changed backup');
  await assert.rejects(corrupt.store.write({ scanDrives: true }), { code: 'SETTINGS_STORE_BACKUP_FAILED' });
  assert.equal(fs.readFileSync(corrupt.file, 'utf8'), '{original broken bytes');
});

test('unsupported write patches do not reset valid settings and status snapshots cannot mutate the store', async t => {
  const f = fixture(t, { version: 1, addonVersion: '0.4.2' }), before = fs.readFileSync(f.file);
  for (const patch of [{ version: 2 }, [], 'bad']) await assert.rejects(f.store.write(patch), { code: 'SETTINGS_STORE_PATCH_INVALID' });
  assert.deepEqual(fs.readFileSync(f.file), before);
  f.store.read(); const status = f.store.readRecoveryStatus(); status.writeBlocked = true; status.changedFields.push('injected');
  assert.equal(f.store.readRecoveryStatus().writeBlocked, false); assert.deepEqual(f.store.readRecoveryStatus().changedFields, []);
});
