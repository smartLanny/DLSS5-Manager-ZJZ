'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createExternalRuntime, RECEIPT, PENDING } = require('../src/product/external-runtime');
const { createHoYoProfileService, HOYO_RECIPE, HOYO_CLIENTS, supportedProfileOptions } = require('../src/product/hoyoshade-profile');
const { INSTALLED_NAMES } = require('../src/product/constants');
const { addonValues } = require('../src/product/reshade-layout');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function peBytes(label) { const bytes = Buffer.alloc(0x500); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80);
  bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(0xf0, 0x94); bytes.writeUInt16LE(0x20b, 0x98); bytes.write(label, 0x300); return bytes; }
function fixture(t, exeName = 'YuanShen.exe', externalOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-profile-beta3-')), gameRoot = path.join(root, 'game'), dir = path.join(gameRoot, 'Client');
  fs.mkdirSync(dir, { recursive: true }); const exe = path.join(dir, exeName); fs.writeFileSync(exe, peBytes('fixture game'));
  const launcher = path.join(root, 'HYP.exe'); fs.writeFileSync(launcher, peBytes('fixture launcher'));
  const original = '; personal HoYo settings\r\n[ADDON]\r\nAddonPath=.\\Addons\r\n[STYLE]\r\nHdrOverlayBrightness=190\r\n' +
    '[GENERAL]\r\nPresetPath=.\\PersonalPreset.ini\r\nEffectSearchPaths=.\\personal-shaders\\**\r\n';
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), original); fs.writeFileSync(path.join(dir, 'PersonalPreset.ini'), 'Techniques=Personal');
  const game = { id: 'hoyo-fixture', dir: gameRoot, scan: { chosen: { path: exe, bitness: 64, apiResolution: { api: 'dx11' } } } };
  const payloadDir = path.join(root, 'payload'); fs.mkdirSync(payloadDir); const payload = { version: 'fixture-core', versionInfo: { compatibility: 'dx11' } };
  for (const kind of ['addon', 'bridge', 'runtime', 'config', 'carrier']) {
    const file = path.join(payloadDir, INSTALLED_NAMES[kind]), bytes = kind === 'config' ? Buffer.from('[NRBeforeSR]\nIntensity=1.5\n') : peBytes('fixture ' + kind);
    fs.writeFileSync(file, bytes); payload[kind] = { file, actual: hash(bytes) };
  }
  const reshade = path.resolve(__dirname, '../payload/nr-before-sr/fixed/RTX50/ReShade64.dll');
  assert.equal(hash(fs.readFileSync(reshade)), HOYO_RECIPE.loaderSha256); payload.reshade = { file: reshade, actual: HOYO_RECIPE.loaderSha256 };
  const userData = path.join(root, 'data'), options = { userData, guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, ...externalOptions };
  const external = createExternalRuntime(options), service = createHoYoProfileService({ externalRuntime: external, userData, appDir: path.resolve(__dirname, '..') });
  const request = { profile: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: launcher } }, inputRoute: 'native', api: 'dx11', payload };
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, gameRoot, dir, exe, launcher, original, game, userData, options, external, service, request, payload };
}

test('formal client table selects eleven channel mappings by the actual EXE and excludes beta names', () => {
  assert.equal(HOYO_CLIENTS.length, 11);
  assert.deepEqual(supportedProfileOptions({ exe: 'C:/fixture/YuanShen.exe' }).map(row => row.channel), ['cn', 'bilibili']);
  assert.deepEqual(supportedProfileOptions({ exe: 'C:/fixture/GenshinImpact.exe' }).map(row => row.channel), ['global']);
  assert.equal(supportedProfileOptions({ exe: 'C:/fixture/ZenlessZoneZeroBeta.exe' }).length, 0);
  assert.equal(new Set(HOYO_CLIENTS.map(row => row.gameBiz)).size, 11);
});

test('HoYo rescue reconnects an externally edited loader INI, restores a deleted helper and can clean then reinstall', async t => {
  const f = fixture(t), original = await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const runtime = original.layout.runtimeDir, rootIni = path.join(f.dir, 'ReShade.ini');
  const loader = path.join(runtime, 'ReShade64.dll');
  const foreign = path.join(f.root, 'unknown-settings'); fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'private.ini'), 'private');
  const edited = `[GENERAL]\nBasePath=${foreign}\n[ADDON]\nAddonPath=${foreign}\n`;
  fs.writeFileSync(rootIni, edited); fs.unlinkSync(loader);
  const preview = await f.external.previewRescue(f.game, 'repair');
  assert.equal(fs.existsSync(loader), false); assert.equal(fs.readFileSync(rootIni, 'utf8'), edited);
  const result = await f.external.applyRescue(f.game, preview.planId, { confirm: true });
  assert.equal(hash(fs.readFileSync(loader)), HOYO_RECIPE.loaderSha256);
  assert.equal((await f.service.inspect(f.game)).ready, true);
  assert.equal((await f.service.inspect(f.game)).loadingBackend, 'hoyoshade');
  const archive = JSON.parse(fs.readFileSync(path.join(result.archiveDirectory, 'operation.json')));
  const row = archive.files.find(item => item.file === rootIni);
  assert.equal(fs.readFileSync(path.join(result.archiveDirectory, row.snapshot), 'utf8'), edited);
  fs.unlinkSync(path.join(runtime, INSTALLED_NAMES.addon)); fs.writeFileSync(rootIni, edited);
  const clean = await f.external.previewRescue(f.game, 'clean'); await f.external.applyRescue(f.game, clean.planId, { confirm: true });
  assert.equal(fs.existsSync(loader), false); assert.equal(fs.readFileSync(path.join(foreign, 'private.ini'), 'utf8'), 'private');
  assert.equal(fs.readFileSync(rootIni, 'utf8'), f.original);
  await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  assert.equal((await f.service.inspect(f.game)).ready, true);
});

test('first HoYo installation uses helper directly, stable preview layout and original INI preservation; restore leaves user presets intact', async t => {
  const f = fixture(t), a = await f.service.preview(f.game, f.request), b = await f.service.preview(f.game, f.request);
  assert.equal(a.origin, 'direct_hoyo'); assert.equal(a.loadingMode, 'helper'); assert.equal(a.layout.generation, b.layout.generation);
  assert.equal(a.changes.some(row => row.role === 'game-proxy'), false); assert.equal(fs.existsSync(f.userData), false);
  const result = await f.service.apply(a.planId), layout = result.layout;
  assert.equal(layout.verified, true); assert.equal(layout.source, 'hoyoshade-profile'); assert.equal(layout.launcher.mode, 'open-and-wait');
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(fs.existsSync(path.join(f.dir, 'd3d11.dll')), false);
  assert.equal(hash(fs.readFileSync(layout.loaderPath)), HOYO_RECIPE.loaderSha256);
  const config = fs.readFileSync(layout.activeConfigPath, 'utf8'); assert.match(config, /HdrOverlayBrightness=190/);
  assert.equal(addonValues(config, 'INPUT').get('KeyOverlay')[0], '36');
  assert.match(config, /KeyOverlay=36,0,0,0/);
  assert.equal(addonValues(config, 'GENERAL').get('PresetPath')[0], path.join(f.dir, 'PersonalPreset.ini'));
  assert.equal((await f.service.inspect(f.game)).ready, true);
  const saved = JSON.parse(fs.readFileSync(path.join(f.gameRoot, RECEIPT))); assert.equal(saved.origin, 'direct_hoyo'); assert.equal(saved.proxy, null);
  await f.service.restore(f.game);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(fs.readFileSync(path.join(f.dir, 'PersonalPreset.ini'), 'utf8'), 'Techniques=Personal');
  assert.equal(f.service.profile(f.game).installed, false);
});

test('HoYo updates isolate newly added declared NR via the shared external ledger and restore only on uninstall', async t => {
  const f = fixture(t), first = await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const file = path.join(first.layout.runtimeDir, 'renodx-dlssnr.addon64'), bytes = peBytes('renodx-dlssnr'); fs.writeFileSync(file, bytes);
  const plan = await f.service.preview(f.game, f.request);
  assert.equal(plan.addonCompatibility.isolate.find(row => row.path === file)?.mandatory, true);
  assert.deepEqual(fs.readFileSync(file), bytes);
  await f.service.apply(plan.planId); assert.equal(fs.existsSync(file), false);
  await f.service.apply((await f.service.preview(f.game, f.request)).planId); assert.equal(fs.existsSync(file), false);
  await f.service.restore(f.game); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.existsSync(path.join(first.layout.runtimeDir, INSTALLED_NAMES.addon)), false);
});

test('HoYo Feeder profile owns no native Core, preserves loader ownership and emits a derived Starward URI', async t => {
  const f = fixture(t, 'StarRail.exe'), launcher = path.join(f.root, 'Starward.exe'); fs.writeFileSync(launcher, peBytes('fixture Starward'));
  const request = { ...f.request, hoyo: { family: 'starrail', channel: 'bilibili', launcher: { kind: 'starward', path: launcher } },
    profile: undefined, inputRoute: 'feeder', payload: { reshade: f.payload.reshade } };
  const plan = await f.service.preview(f.game, request); await f.service.apply(plan.planId);
  const layout = f.service.profile(f.game); assert.equal(layout.launcher.uri, 'starward://startgame/hkrpg_bilibili');
  assert.equal(layout.inputRoute, 'feeder'); assert.deepEqual(layout.moduleManifest.map(row => row.role), ['reshade']);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, INSTALLED_NAMES.addon)), false);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, INSTALLED_NAMES.config)), false);
  const again = await f.service.preview(f.game, request); assert.equal(again.layout.generation, layout.generation);
  await f.service.apply(again.planId); await f.service.restore(f.game);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
});

test('mismatched client/channel, arbitrary launcher and changed EXE stop before profile writes', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.preview(f.game, { ...f.request, profile: { ...f.request.profile, channel: 'global' } }), { code: 'HOYO_CLIENT' });
  await assert.rejects(f.service.preview(f.game, { ...f.request, profile: { ...f.request.profile, launcher: { kind: 'hoyoplay', path: f.exe } } }), { code: 'HOYO_LAUNCHER' });
  const plan = await f.service.preview(f.game, f.request); fs.appendFileSync(f.exe, 'changed');
  await assert.rejects(f.service.apply(plan.planId), { code: 'HOYO_PLAN_CHANGED' });
  assert.equal(fs.existsSync(f.userData), false); assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false);
});

test('existing verified ReShade proxy is archived before HoYo helper preparation and restored without a second live proxy', async t => {
  const f = fixture(t), proxy = path.join(f.dir, 'd3d11.dll'); fs.copyFileSync(f.payload.reshade.file, proxy);
  const plan = await f.service.preview(f.game, f.request); assert.equal(plan.changes.some(row => row.path === proxy && row.afterSha256 === null), true);
  await f.service.apply(plan.planId); assert.equal(fs.existsSync(proxy), false); assert.equal((await f.service.inspect(f.game)).ready, true);
  await f.service.restore(f.game); assert.equal(hash(fs.readFileSync(proxy)), HOYO_RECIPE.loaderSha256);
});

test('HoYo first installation preserves an explicit custom panel key in the active profile', async t => {
  const f = fixture(t), original = f.original + '[INPUT]\r\nKeyOverlay=121,1,0,1\r\n';
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), original);
  const plan = await f.service.preview(f.game, f.request); await f.service.apply(plan.planId);
  const config = fs.readFileSync(f.service.profile(f.game).activeConfigPath, 'utf8');
  assert.match(config, /KeyOverlay=121,1,0,1/); assert.doesNotMatch(config, /KeyOverlay=36/);
  await f.service.restore(f.game); assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), original);
});

test('Windows userData casing preserves the first transaction INI identity through inspect and restore', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), plan = await f.service.preview(f.game, f.request);
  await f.service.apply(plan.planId);
  const before = f.service.profile(f.game), external = createExternalRuntime({ ...f.options, userData: f.userData.toUpperCase() });
  const service = createHoYoProfileService({ externalRuntime: external, userData: f.userData.toUpperCase(), appDir: path.resolve(__dirname, '..') });
  const state = await service.inspect(f.game);
  assert.equal(state.ready, true); assert.equal(state.runtimeDir, before.runtimeDir);
  const again = await service.preview(f.game, f.request); await service.apply(again.planId);
  assert.equal((await service.inspect(f.game)).ready, true);
  await service.restore(f.game);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(service.profile(f.game).installed, false);
});
