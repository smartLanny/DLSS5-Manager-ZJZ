'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Module = require('node:module');
const { createRdr2ApiSettings } = require('../src/product/rdr2-api-settings');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const xml = api => `<?xml version="1.0" encoding="UTF-8" ?>\r\n<rage__fwuiSystemSettingsCollection>\r\n  <version value="37" />\r\n  <!-- keep user graphics preferences -->\r\n  <graphics><textureQuality>kSettingLevel_Ultra</textureQuality></graphics>\r\n  <advancedGraphics>\r\n    <API>  kSettingAPI_${api}  </API>\r\n    <asyncComputeEnabled value="false" />\r\n  </advancedGraphics>\r\n</rage__fwuiSystemSettingsCollection>\r\n`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdr2-api-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entryRoot = path.join(root, 'Steam-RDR2'), documentsDir = path.join(root, 'OneDrive', 'Documents');
  fs.mkdirSync(entryRoot); const exe = path.join(entryRoot, 'RDR2.exe'); fs.writeFileSync(exe, 'fixture game');
  const file = path.join(documentsDir, 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, xml('Vulkan'));
  return { root, entryRoot, documentsDir, exe, file, input: { exe, entryRoot, steamAppId: '1174180' }, service: createRdr2ApiSettings({ documentsDir }) };
}

test('only a discovered exact Steam RDR2 entry exposes supported APIs and the current bounded user settings', t => {
  const f = fixture(t), result = f.service.read(f.input);
  assert.equal(result.matched, true); assert.equal(result.api, 'vulkan'); assert.equal(result.file, f.file);
  assert.deepEqual(result.supportedApis, ['vulkan', 'dx12']); assert.equal(result.canSync, true);
  assert.equal(result.sha256, hash(fs.readFileSync(f.file)));
  for (const input of [{ ...f.input, steamAppId: '999' }, { ...f.input, entryRoot: undefined },
    { ...f.input, exe: path.join(f.entryRoot, 'bin', 'RDR2.exe') }, { ...f.input, exe: path.join(f.entryRoot, 'PlayRDR2.exe') },
    { ...f.input, exe: path.join(f.root, 'unrelated', 'RDR2.exe') }]) {
    const unknown = f.service.read(input); assert.equal(unknown.matched, false); assert.equal(unknown.api, null); assert.deepEqual(unknown.supportedApis, []);
  }
  fs.writeFileSync(f.file, xml('DX12'));
  assert.equal(f.service.read(f.input).api, 'dx12', 'every scan reads the latest saved setting');
});

test('the default documents source is Electron KnownFolder, including OneDrive, with no stale Documents fallback', t => {
  const f = fixture(t), load = Module._load; let calls = 0;
  t.mock.method(Module, '_load', function (request, ...args) {
    if (request === 'electron') return { app: { getPath(name) { calls++; assert.equal(name, 'documents'); return f.documentsDir; } } };
    return load.call(this, request, ...args);
  });
  const service = createRdr2ApiSettings(); assert.equal(service.inspect(f.input).file, f.file); assert.equal(calls, 1);
  fs.unlinkSync(f.file);
  const stale = path.join(f.root, 'Documents', 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  fs.mkdirSync(path.dirname(stale), { recursive: true }); fs.writeFileSync(stale, xml('DX12'));
  assert.equal(service.read(f.input).api, null);
});

test('workers without Electron app require an injected KnownFolder and never guess a documents directory', t => {
  const f = fixture(t), load = Module._load;
  t.mock.method(Module, '_load', function (request, ...args) {
    if (request === 'electron') return 'electron executable path';
    return load.call(this, request, ...args);
  });
  const unknown = createRdr2ApiSettings().read(f.input);
  assert.equal(unknown.matched, true); assert.equal(unknown.file, null); assert.equal(unknown.api, null); assert.equal(unknown.canSync, false);
  assert.equal(createRdr2ApiSettings({ documentsDir: f.documentsDir }).read(f.input).api, 'vulkan');
});

test('mutation planning changes only the API text, preserves BOM and all other bytes, and performs no writes', t => {
  const f = fixture(t);
  const encodings = [
    text => Buffer.from(text),
    text => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    text => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace('UTF-8', 'UTF-16'), 'utf16le')]),
    text => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text.replace('UTF-8', 'UTF-16'), 'utf16le').swap16()])
  ];
  for (const encode of encodings) {
    const before = encode(xml('Vulkan')); fs.writeFileSync(f.file, before);
    const plan = f.service.prepareMutation({ ...f.input, api: 'dx12' });
    assert.equal(plan.file, f.file); assert.equal(plan.api, 'dx12'); assert.equal(plan.changed, true);
    assert.deepEqual(plan.before.bytes, before); assert.deepEqual(plan.after.bytes, encode(xml('DX12')));
    assert.equal(plan.before.sha256, hash(before)); assert.equal(plan.after.sha256, hash(plan.after.bytes));
    assert.deepEqual(plan.identity, f.input); assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(f.service.prepareMutation({ ...f.input, api: 'vulkan' }).changed, false);
  }
});

test('malformed, duplicate, injected or unrelated XML cannot authorize a guessed API or mutation', t => {
  const f = fixture(t);
  const invalid = [
    xml('Unknown'), xml('Vulkan').replace('</advancedGraphics>', '</other>'),
    xml('Vulkan').replace('<API>', '<API hint="api">'), xml('Vulkan').replace('<API>', '<API><other/>'),
    xml('Vulkan').replace('</API>', '</API><API>kSettingAPI_DX12</API>'),
    xml('Vulkan').replace('</advancedGraphics>', '</advancedGraphics><advancedGraphics/>'),
    xml('Vulkan').replace('<advancedGraphics>', '<graphics>'),
    xml('Vulkan') + xml('DX12'),
    '<!DOCTYPE x [<!ENTITY api "kSettingAPI_DX12">]>' + xml('Vulkan'),
    xml('Vulkan').replace('kSettingAPI_Vulkan', '<![CDATA[kSettingAPI_Vulkan]]>'),
    xml('Vulkan').replace('kSettingAPI_Vulkan', 'kSettingAPI_<!--x-->Vulkan'),
    xml('Vulkan').replace('kSettingAPI_Vulkan', '&#107;SettingAPI_Vulkan'),
    '<!-- <advancedGraphics><API>kSettingAPI_DX12</API></advancedGraphics> -->'
  ];
  for (const value of invalid) {
    fs.writeFileSync(f.file, value);
    assert.equal(f.service.read(f.input).api, null);
    assert.throws(() => f.service.prepareMutation({ ...f.input, api: 'dx12' }), { code: 'RDR2_SETTINGS_UNAVAILABLE' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), value);
  }
  assert.throws(() => f.service.prepareMutation({ ...f.input, api: 'dx11' }), { code: 'RDR2_API_UNSUPPORTED' });
  assert.throws(() => f.service.prepareMutation({ ...f.input, steamAppId: '999', api: 'dx12' }), { code: 'RDR2_SETTINGS_IDENTITY' });
});

test('oversized and hardlinked settings are rejected before reading content', t => {
  const f = fixture(t), open = fs.openSync; let reads = 0;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => { if (file === f.file && flags === 'r') reads++; return open(file, flags, ...args); });
  fs.writeFileSync(f.file, ' '.repeat(64 * 1024) + xml('Vulkan')); assert.equal(f.service.read(f.input).api, null); assert.equal(reads, 0);
  fs.writeFileSync(f.file, xml('Vulkan')); const link = path.join(f.root, 'linked.xml'); fs.linkSync(f.file, link);
  assert.equal(f.service.read(f.input).api, null); assert.equal(reads, 0); fs.unlinkSync(link);
  fs.unlinkSync(f.file); assert.equal(f.service.read(f.input).api, null);
  assert.equal(createRdr2ApiSettings({ documentsDir: 'relative/Documents' }).read(f.input).file, null);
});

test('a settings file changed during the bounded read cannot produce a stale write plan', t => {
  const f = fixture(t), read = fs.readSync; let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = read(...args);
    if (!changed) { changed = true; fs.writeFileSync(f.file, xml('DX12')); }
    return count;
  });
  assert.equal(f.service.read(f.input).canSync, false);
  const plan = f.service.prepareMutation({ ...f.input, api: 'vulkan' });
  assert.equal(plan.before.sha256, hash(Buffer.from(xml('DX12'))));
  assert.deepEqual(plan.after.bytes, Buffer.from(xml('Vulkan')));
  assert.equal(fs.readFileSync(f.file, 'utf8'), xml('DX12'));
});

function gameFor(f, canSync = true) {
  return { id: 'rdr2', appid: '1174180', dir: f.entryRoot, scan: { chosen: {
    path: f.exe,
    apiSettings: { kind: 'rdr2-system-xml', canSync, file: f.file, exe: f.exe,
      entryRoot: f.entryRoot, steamAppId: '1174180', supportedApis: ['vulkan', 'dx12'] }
  } } };
}

test('apply writes only a canSync RDR2 fixture and returns an idempotent rollback session', async t => {
  const f = fixture(t), userData = path.join(f.root, 'manager-user-data'), checks = [];
  const settings = createRdr2ApiSettings({ documentsDir: f.documentsDir });
  const writer = require('../src/product/game-api-settings').createGameApiSettings({
    userData, settings, assertGameClosed: async (dir, exe) => checks.push({ dir, exe })
  });
  const before = fs.readFileSync(f.file);
  const session = await writer.apply(gameFor(f), 'dx12');
  assert.equal(session.applied, true); assert.equal(session.changed, true); assert.equal(session.api, 'dx12');
  assert.equal(session.file, f.file); assert.equal(fs.readFileSync(f.file, 'utf8'), xml('DX12'));
  assert.equal(session.beforeSha256, hash(before)); assert.equal(session.afterSha256, hash(fs.readFileSync(f.file)));
  assert.equal(fs.readFileSync(session.backup).compare(before), 0);
  const first = await session.rollback();
  assert.deepEqual(first, { rolledBack: true, file: f.file, sha256: hash(before) });
  assert.equal(fs.readFileSync(f.file).compare(before), 0);
  assert.deepEqual(await session.rollback(), first);
  assert.equal(checks.length, 3, 'apply checks before planning and publishing; rollback checks before restore');
});

test('missing or unsafe RDR2 XML keeps the old manual API route as a no-op', async t => {
  const f = fixture(t), calls = [];
  const writer = require('../src/product/game-api-settings').createGameApiSettings({
    userData: path.join(f.root, 'manager-user-data'), settings: f.service,
    assertGameClosed: async () => calls.push('closed')
  });
  const before = fs.readFileSync(f.file);
  const session = await writer.apply(gameFor(f, false), 'dx12');
  assert.deepEqual({ applied: session.applied, changed: session.changed, api: session.api },
    { applied: false, changed: false, api: 'dx12' });
  assert.deepEqual(await session.rollback(), { rolledBack: false, noOp: true, changed: false, api: 'dx12' });
  assert.equal(calls.length, 0); assert.equal(fs.readFileSync(f.file).compare(before), 0);
});

test('a canSync plan that is externally changed before publish fails closed and preserves the external bytes', async t => {
  const f = fixture(t), external = Buffer.from(xml('DX12').replace('value="37"', 'value="38"'));
  const base = f.service;
  const settings = { prepareMutation(input) {
    const plan = base.prepareMutation(input); fs.writeFileSync(f.file, external); return plan;
  } };
  const writer = require('../src/product/game-api-settings').createGameApiSettings({
    userData: path.join(f.root, 'manager-user-data'), settings, assertGameClosed: async () => {}
  });
  await assert.rejects(writer.apply(gameFor(f), 'dx12'), { code: 'GAME_API_FILE_CHANGED' });
  assert.equal(fs.readFileSync(f.file).compare(external), 0);
});

test('rollback retains a user change made after the API session was applied', async t => {
  const f = fixture(t), writer = require('../src/product/game-api-settings').createGameApiSettings({
    userData: path.join(f.root, 'manager-user-data'), settings: f.service, assertGameClosed: async () => {}
  });
  const session = await writer.apply(gameFor(f), 'dx12');
  const external = Buffer.from(xml('Vulkan').replace('value="37"', 'value="39"'));
  fs.writeFileSync(f.file, external);
  assert.deepEqual(await session.rollback(), { rolledBack: false, retained: true,
    code: 'GAME_API_EXTERNAL_CHANGE', file: f.file });
  assert.equal(fs.readFileSync(f.file).compare(external), 0);
});
