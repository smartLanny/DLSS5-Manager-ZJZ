'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createExternalRuntime, RECEIPT, PENDING } = require('../src/product/external-runtime');
const { INSTALLED_NAMES } = require('../src/product/constants');
const { addonValues } = require('../src/product/reshade-layout');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xf-direct-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, 'game'), dir = path.join(gameRoot, 'Pal', 'Binaries', 'Win64');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'Palworld-Win64-Shipping.exe'); fs.writeFileSync(exe, 'only a fixture EXE');
  const game = { id: 'palworld-fixture', dir: gameRoot, scan: { chosen: { path: exe, bitness: 64, apiResolution: { api: 'dx12' } } } };
  const original = '; existing personal configuration\r\n[ADDON]\r\nAddonPath=.\\addon\r\nDisabledAddons=Generic Depth,User HDR@hdr.addon64\r\n' +
    '[GENERAL]\r\nEffectSearchPaths=.\\reshade-shaders\\**\r\nPresetPath=.\\ReShadePreset.ini\r\n[STYLE]\r\nHdrOverlayBrightness=203\r\n' +
    '[SCREENSHOT]\r\nSavePath=.\\shots\r\nPostSaveCommandWorkingDirectory=.\\\r\n';
  fs.writeFileSync(path.join(dir, 'ReShade.ini'), original); fs.writeFileSync(path.join(dir, 'ReShadePreset.ini'), 'Techniques=UserChoice');
  fs.writeFileSync(path.join(dir, 'renodx-ue-extended.addon64'), 'inactive root HDR');
  const payloadDir = path.join(root, 'payload'); fs.mkdirSync(payloadDir);
  const payload = { version: '0.4.7beta', versionInfo: { compatibility: 'dx11' } };
  for (const kind of ['addon', 'bridge', 'runtime', 'config', 'reshade', 'carrier']) {
    const file = path.join(payloadDir, INSTALLED_NAMES[kind]), bytes = kind === 'reshade' ? 'ReShade Searching for add-ons' : kind === 'config' ? '[NRBeforeSR]\nIntensity=1.4\n' : 'payload:' + kind;
    fs.writeFileSync(file, bytes); payload[kind] = { file, actual: hash(bytes) };
  }
  fs.copyFileSync(payload.runtime.file, path.join(dir, INSTALLED_NAMES.runtime));
  const deploymentOptions = { userData: path.join(root, 'data'), pe: { getBitness: () => 64, getImports: () => [] },
    guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, ...options };
  const service = createExternalRuntime(deploymentOptions);
  return { root, gameRoot, dir, exe, game, payload, original, service, options: deploymentOptions,
    pending: path.join(gameRoot, PENDING), receipt: path.join(gameRoot, RECEIPT), request: { mode: 'external', loadingMode: 'proxy', api: 'dx12', payload } };
}

test('direct unified3 deployment owns only its seven nested resources and restore leaves game resources intact', async t => {
  const f = fixture(t), names = require('../src/product/payload-companions').NAMES;
  f.payload.version = '0.5-dline21-unified3';
  f.payload.companions = names.map(name => { const file = path.join(f.root, 'resources', name), bytes = 'resource:' + name;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return { name, file, actual: hash(bytes) }; });
  const userFile = path.join(f.dir, names[0]); fs.mkdirSync(path.dirname(userFile), { recursive: true }); fs.writeFileSync(userFile, 'game original');
  const plan = await f.service.preview(f.game, f.request); await f.service.apply(plan.planId);
  assert.equal((await f.service.inspect(f.game)).ready, true);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).files.filter(row => row.kind === 'companion').length, 7);
  await f.service.previewRemove(f.game, 'restore'); await f.service.remove(f.game, 'restore');
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'game original');
});

test('first external deployment handles Palworld missing directories without activating root HDR or owning existing runtime', async t => {
  const f = fixture(t), preset = fs.readFileSync(path.join(f.dir, 'ReShadePreset.ini'));
  const current = f.service.getLayout(f.game);
  assert.equal(current.addonDir, path.join(f.dir, 'addon')); assert.equal(current.verified, false);
  const plan = await f.service.preview(f.game, f.request);
  assert.equal(plan.configured.addonDir, path.join(f.dir, 'addon'));
  assert.equal(plan.desired.addonDir, f.service.location(f.game).runtimeDir);
  assert.ok(plan.warnings.some(row => row.code === 'ADDON_DIRECTORY_MISSING'));
  assert.ok(plan.warnings.some(row => row.code === 'FILTER_DIRECTORY_MISSING'));
  assert.equal(plan.inactiveAddons[0].name, 'renodx-ue-extended.addon64');
  assert.ok(!plan.changes.some(row => row.path === path.join(f.dir, INSTALLED_NAMES.runtime)));
  assert.equal(fs.existsSync(path.join(f.gameRoot, '_DLSS5_Backup')), false);
  assert.equal(fs.existsSync(f.options.userData), false);
  const result = await f.service.apply(plan.planId), layout = result.layout;
  assert.equal(layout.verified, true); assert.equal((await f.service.inspect(f.game)).ready, true);
  assert.equal(fs.existsSync(path.join(f.gameRoot, '_DLSS5_Backup', 'xiaofeng-manager.json')), false);
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, 'renodx-ue-extended.addon64')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'renodx-ue-extended.addon64'), 'utf8'), 'inactive root HDR');
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.runtime), 'utf8'), 'payload:runtime');
  const active = fs.readFileSync(layout.activeConfigPath, 'utf8');
  assert.match(active, /KeyOverlay=36,0,0,0/);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).panelDefaultKey, 36);
  assert.equal(addonValues(active).get('AddonPath')[0], '.');
  assert.equal(addonValues(active, 'GENERAL').get('PresetPath')[0], path.join(f.dir, 'ReShadePreset.ini'));
  assert.match(active, /DisabledAddons=Generic Depth,User HDR@hdr.addon64/); assert.match(active, /HdrOverlayBrightness=203/);
  await assert.rejects(f.service.preview(f.game, { mode: 'local' }), { code: 'DEPLOYMENT_DIRECT_LOCAL_UNSUPPORTED' });
  const preview = await f.service.previewRemove(f.game, 'restore'); assert.ok(preview.changes.some(row => row.role === 'game-proxy' && row.afterSha256 === null));
  await f.service.remove(f.game, 'restore');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ReShadePreset.ini')), preset);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.runtime), 'utf8'), 'payload:runtime');
  assert.equal(fs.existsSync(path.join(layout.runtimeDir, INSTALLED_NAMES.addon)), false);
  assert.equal((await f.service.inspect(f.game)).installed, false);
});

test('active custom directory and explicit DLL loads retain disabled HDR, sidecars and original file locations', async t => {
  const f = fixture(t), addon = path.join(f.dir, 'addon'); fs.mkdirSync(addon);
  fs.writeFileSync(path.join(addon, 'hdr.addon64'), 'user HDR in searched directory');
  fs.writeFileSync(path.join(addon, 'hdr.ini'), 'UserBrightness=170');
  fs.writeFileSync(path.join(addon, 'Explicit.dll'), 'RenoDX HDR explicit early user module');
  fs.appendFileSync(path.join(f.dir, 'ReShade.ini'), '[ADDON]\r\nLoadFromDllMain=.\\Explicit.dll\r\n');
  const before = fs.readFileSync(path.join(f.dir, 'ReShade.ini'));
  const first = await f.service.preview(f.game, f.request);
  assert.equal(first.compatibility.isolate.some(row => row.name === 'Explicit.dll'), true);
  const plan = await f.service.preview(f.game, { ...f.request, keepAddons: [{ path: path.join(addon, 'Explicit.dll'),
    sha256: hash('RenoDX HDR explicit early user module'), configFingerprint: first.compatibility.configFingerprint }] });
  const result = await f.service.apply(plan.planId);
  const active = result.layout.runtimeDir;
  assert.equal(fs.readFileSync(path.join(active, 'hdr.addon64'), 'utf8'), 'user HDR in searched directory');
  assert.equal(fs.readFileSync(path.join(active, 'hdr.ini'), 'utf8'), 'UserBrightness=170');
  assert.equal(addonValues(fs.readFileSync(path.join(active, 'ReShade.ini'), 'utf8')).get('LoadFromDllMain')[0], 'Explicit.dll');
  assert.match(fs.readFileSync(path.join(active, 'ReShade.ini'), 'utf8'), /User HDR@hdr.addon64/);
  await f.service.remove(f.game, 'clean');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ReShade.ini')), before);
  assert.equal(fs.readFileSync(path.join(addon, 'hdr.addon64'), 'utf8'), 'user HDR in searched directory');
});

test('ambiguous or linked source layouts fail preview without creating any owner state', async t => {
  for (const variant of ['multiple', 'junction']) {
    const f = fixture(t);
    if (variant === 'multiple') fs.appendFileSync(path.join(f.dir, 'ReShade.ini'), '[ADDON]\nAddonPath=.\\another\n');
    else { const target = path.join(f.root, 'junction-target'); fs.mkdirSync(target); fs.symlinkSync(target, path.join(f.dir, 'addon'), 'junction'); }
    await assert.rejects(f.service.preview(f.game, f.request), { code: 'DEPLOYMENT_SOURCE_LAYOUT' });
    assert.equal(fs.existsSync(f.options.userData), false); assert.equal(fs.existsSync(path.join(f.gameRoot, '_DLSS5_Backup')), false);
  }
});

test('legacy Luma boolean early-load configuration migrates with a warning and restores exact original bytes', async t => {
  const f = fixture(t), ini = path.join(f.dir, 'ReShade.ini');
  fs.appendFileSync(ini, '[ADDON]\r\nLoadFromDllMain=0\r\n');
  const before = fs.readFileSync(ini), plan = await f.service.preview(f.game, f.request);
  assert.ok(plan.warnings.some(row => row.code === 'ADDON_LEGACY_BOOLEAN_LOAD'));
  const installed = await f.service.apply(plan.planId);
  assert.equal(addonValues(fs.readFileSync(installed.layout.activeConfigPath, 'utf8')).has('LoadFromDllMain'), false);
  assert.equal((await f.service.inspect(f.game)).ready, true);
  await f.service.remove(f.game, 'restore');
  assert.deepEqual(fs.readFileSync(ini), before);
});

test('source changes after first external preview reject before a file WAL or profile exists', async t => {
  const f = fixture(t), plan = await f.service.preview(f.game, f.request);
  fs.appendFileSync(path.join(f.dir, 'ReShade.ini'), '; new external edit\n');
  await assert.rejects(f.service.apply(plan.planId), { code: 'DEPLOYMENT_PLAN_CHANGED' });
  assert.equal(fs.existsSync(f.pending), false); assert.equal(fs.existsSync(f.options.userData), false);
  assert.match(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), /new external edit/);
});

test('external source addons are isolated through their bound WAL and restored to original paths outside the game root', async t => {
  const f = fixture(t), external = path.join(f.root, 'personal-external-addons'); fs.mkdirSync(external);
  const userAddon = path.join(external, 'user.addon64'); fs.writeFileSync(userAddon, 'unverified external user addon');
  const original = '[ADDON]\r\nAddonPath=' + external + '\r\n'; fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), original);
  const plan = await f.service.preview(f.game, f.request);
  assert.equal(plan.changes.some(row => row.path === userAddon && row.role === 'source-addon' && row.afterSha256 === null), true);
  await f.service.apply(plan.planId); assert.equal(fs.existsSync(userAddon), false);
  const saved = JSON.parse(fs.readFileSync(f.receipt)); assert.equal(saved.isolatedAddons[0].path, userAddon);
  await f.service.remove(f.game, 'restore');
  assert.equal(fs.readFileSync(userAddon, 'utf8'), 'unverified external user addon');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), original);
});

test('first external interruption after publishing proxy recovers exact original config and leaves old unowned files', async t => {
  const f = fixture(t, { afterWrite: ({ row }) => { if (row.role === 'game-proxy') throw Object.assign(new Error('process exited'), { preservePending: true }); } });
  const plan = await f.service.preview(f.game, f.request);
  await assert.rejects(f.service.apply(plan.planId), /process exited/); assert.equal(fs.existsSync(f.pending), true);
  const restarted = createExternalRuntime({ ...f.options, afterWrite: undefined });
  assert.equal((await restarted.recover(f.game)).recovered, true);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.runtime), 'utf8'), 'payload:runtime');
});

test('direct clean archives a replaced proxy while restore restores it; an identical borrowed proxy stays unowned', async t => {
  for (const mode of ['clean', 'restore', 'borrowed']) {
    const f = fixture(t), previous = mode === 'borrowed' ? fs.readFileSync(f.payload.reshade.file) : Buffer.from('older ReShade Searching for add-ons');
    fs.writeFileSync(path.join(f.dir, 'dxgi.dll'), previous);
    const plan = await f.service.preview(f.game, f.request); await f.service.apply(plan.planId);
    const saved = JSON.parse(fs.readFileSync(f.receipt)); assert.equal(saved.initialProxy.owned, mode !== 'borrowed');
    const removed = await f.service.remove(f.game, mode === 'restore' ? 'restore' : 'clean');
    assert.equal(removed.removed, true);
    if (mode === 'clean') assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
    else assert.deepEqual(fs.readFileSync(path.join(f.dir, 'dxgi.dll')), previous);
    assert.deepEqual(fs.readFileSync(path.join(f.options.userData, 'external-runtime', saved.id, 'history', saved.initialOperation, saved.initialProxy.snapshot)), previous);
    assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  }
});

for (const historicalEquals of [false, true]) test(`direct standard layout (${historicalEquals ? 'historical equals' : 'new Home'}) converts to an owned ordinary install and its ordinary restore remains valid`, async t => {
  const f = fixture(t), localIni = f.original.replace('AddonPath=.\\addon', 'AddonPath=.');
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), localIni);
  fs.unlinkSync(path.join(f.dir, INSTALLED_NAMES.runtime));
  const initial = await f.service.preview(f.game, f.request);
  const first = await f.service.preview(f.game, { ...f.request, addonKeep: initial.compatibility.isolate.map(row => ({
    path: row.path, sha256: row.sha256, configFingerprint: initial.compatibility.configFingerprint })) });
  await f.service.apply(first.planId);
  const external = f.service.getLayout(f.game);
  if (historicalEquals) {
    const saved = JSON.parse(fs.readFileSync(f.receipt)); delete saved.panelDefaultKey;
    fs.writeFileSync(external.activeConfigPath, fs.readFileSync(external.activeConfigPath, 'utf8').replace('KeyOverlay=36,0,0,0', 'KeyOverlay=187,0,0,0'));
    fs.writeFileSync(f.receipt, JSON.stringify(saved));
    assert.equal((await f.service.inspect(f.game)).ready, true);
  }
  fs.writeFileSync(path.join(external.runtimeDir, INSTALLED_NAMES.config), '[NRBeforeSR]\nIntensity=1.7\n');
  const local = await f.service.preview(f.game, { mode: 'local' });
  assert.ok(local.changes.some(row => row.role === 'manifest'));
  await f.service.apply(local.planId);
  assert.match(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.config), 'utf8'), /Intensity=1.7/);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), localIni);
  assert.equal(fs.readFileSync(path.join(f.dir, INSTALLED_NAMES.addon), 'utf8'), 'payload:addon');
  assert.equal(fs.existsSync(path.join(f.dir, 'renodx-ue-extended.addon64')), true);
  const installer = require('../src/product/installer').createInstaller({ guards: f.options.guards, pe: f.options.pe });
  const removed = await installer.uninstall({ gameDir: f.gameRoot, scan: f.game.scan, mode: 'restore', removeSettings: false });
  assert.equal(removed.removed, true); assert.equal(fs.existsSync(path.join(f.dir, INSTALLED_NAMES.addon)), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
});

test('direct helper transition and later proxy transition keep the original uninstall baseline', async t => {
  const f = fixture(t), first = await f.service.preview(f.game, f.request); await f.service.apply(first.planId);
  const helper = await f.service.preview(f.game, { mode: 'external', loadingMode: 'helper' }); await f.service.apply(helper.planId);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
  const proxy = await f.service.preview(f.game, { mode: 'external', loadingMode: 'proxy' }); await f.service.apply(proxy.planId);
  await f.service.remove(f.game, 'restore');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
});

test('DX12 external proxy entry switches transactionally, auto preserves it and restore removes only the selected managed entry', async t => {
  const f = fixture(t), first = await f.service.preview(f.game, { ...f.request, proxyEntry: 'd3d12' });
  await f.service.apply(first.planId); assert.equal(fs.existsSync(path.join(f.dir, 'd3d12.dll')), true); assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
  const change = await f.service.preview(f.game, { mode: 'external', proxyEntry: 'dxgi' });
  assert.equal(change.changes.filter(row => row.role === 'game-proxy').length, 2);
  await f.service.apply(change.planId); assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), true); assert.equal(fs.existsSync(path.join(f.dir, 'd3d12.dll')), false);
  const auto = await f.service.preview(f.game, { mode: 'external', proxyEntry: 'auto' }); assert.equal(auto.changes.some(row => row.role === 'game-proxy'), false);
  await f.service.apply(auto.planId); await f.service.restore(f.game);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(fs.existsSync(path.join(f.dir, 'd3d12.dll')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
});

test('initial DX12 entry change archives the original verified loader and restores its exact old path and bytes', async t => {
  const f = fixture(t), previous = 'old ReShade Searching for add-ons'; fs.writeFileSync(path.join(f.dir, 'dxgi.dll'), previous);
  const first = await f.service.preview(f.game, { ...f.request, proxyEntry: 'd3d12' }); await f.service.apply(first.planId);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(fs.readFileSync(path.join(f.dir, 'd3d12.dll'), 'utf8'), 'ReShade Searching for add-ons');
  await f.service.restore(f.game); assert.equal(fs.readFileSync(path.join(f.dir, 'dxgi.dll'), 'utf8'), previous);
  assert.equal(fs.existsSync(path.join(f.dir, 'd3d12.dll')), false);
});

test('entry switch rejects an occupied destination and stale target changes before any owner writes', async t => {
  const f = fixture(t), first = await f.service.preview(f.game, f.request); await f.service.apply(first.planId);
  const alternate = path.join(f.dir, 'd3d12.dll'); fs.writeFileSync(alternate, 'unknown native library');
  const receipt = fs.readFileSync(f.receipt); await assert.rejects(f.service.preview(f.game, { mode: 'external', proxyEntry: 'd3d12' }), { code: 'DEPLOYMENT_PROXY_CONFLICT' });
  assert.deepEqual(fs.readFileSync(f.receipt), receipt); assert.equal(fs.readFileSync(alternate, 'utf8'), 'unknown native library');
  fs.unlinkSync(alternate); const plan = await f.service.preview(f.game, { mode: 'external', proxyEntry: 'd3d12' });
  fs.writeFileSync(alternate, 'late user file'); await assert.rejects(f.service.apply(plan.planId), { code: 'DEPLOYMENT_PLAN_CHANGED' });
  assert.equal(fs.readFileSync(alternate, 'utf8'), 'late user file'); assert.equal(fs.existsSync(f.pending), false);
});

test('interrupted external entry switch restores the original single live entry and receipt', async t => {
  let switching = false;
  const f = fixture(t, { afterWrite: ({ row }) => { if (switching && row.role === 'game-proxy') throw Object.assign(new Error('interrupted entry switch'), { preservePending: true }); } });
  const first = await f.service.preview(f.game, f.request); await f.service.apply(first.planId); const receipt = fs.readFileSync(f.receipt);
  const plan = await f.service.preview(f.game, { mode: 'external', proxyEntry: 'd3d12' }); switching = true;
  await assert.rejects(f.service.apply(plan.planId), /interrupted entry switch/); assert.equal(fs.existsSync(f.pending), true);
  const restarted = createExternalRuntime({ ...f.options, afterWrite: undefined }); await restarted.recover(f.game);
  assert.deepEqual(fs.readFileSync(f.receipt), receipt); assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), true);
  assert.equal(fs.existsSync(path.join(f.dir, 'd3d12.dll')), false); assert.equal(fs.existsSync(f.pending), false);
});

test('UTF-8 BOM survives a first external round trip and a changed root proxy is never blessed', async t => {
  const f = fixture(t), original = Buffer.from('\uFEFF' + f.original); fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), original);
  const plan = await f.service.preview(f.game, f.request); await f.service.apply(plan.planId);
  const rootProxy = path.join(f.dir, 'dxgi.dll'), loader = fs.readFileSync(rootProxy);
  fs.writeFileSync(rootProxy, 'external replacement proxy');
  assert.equal((await f.service.inspect(f.game)).ready, false);
  await assert.rejects(f.service.previewRemove(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  assert.equal(fs.readFileSync(rootProxy, 'utf8'), 'external replacement proxy');
  fs.writeFileSync(rootProxy, loader); await f.service.remove(f.game, 'restore');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'ReShade.ini')), original);
});

test('rescue repairs a changed loader path and missing Core without following the new path or resetting personal INI', async t => {
  const f = fixture(t), installed = await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const runtime = installed.layout.runtimeDir, loader = path.join(f.dir, 'ReShade.ini');
  const unrelated = path.join(f.root, 'foreign'); fs.mkdirSync(unrelated); fs.writeFileSync(path.join(unrelated, 'keep.dll'), 'unrelated');
  const edited = `[GENERAL]\nBasePath=${unrelated}\n[ADDON]\nAddonPath=${unrelated}\n`;
  fs.writeFileSync(loader, edited); fs.unlinkSync(path.join(runtime, INSTALLED_NAMES.addon));
  const config = path.join(runtime, INSTALLED_NAMES.config); fs.writeFileSync(config, '[NRBeforeSR]\nIntensity=1.23456\n');
  const state = await f.service.inspect(f.game); assert.equal(state.ready, false); assert.equal(state.rescue.available, true); assert.equal(state.rescue.pending, false);
  await assert.rejects(f.service.previewRemove(f.game), { code: 'DEPLOYMENT_FILE_CHANGED' });
  const preview = await f.service.previewRescue(f.game, 'repair');
  assert.equal(fs.readFileSync(loader, 'utf8'), edited); assert.equal(fs.existsSync(preview.archiveDirectory), false);
  assert.equal(preview.changes.some(row => row.path.startsWith(unrelated)), false);
  await assert.rejects(f.service.applyRescue(f.game, preview.planId), { code: 'DEPLOYMENT_RESCUE_CONFIRM_REQUIRED' });
  const result = await f.service.applyRescue(f.game, preview.planId, { confirm: true });
  assert.equal((await f.service.inspect(f.game)).ready, true);
  assert.equal(fs.readFileSync(config, 'utf8'), '[NRBeforeSR]\nIntensity=1.23456\n');
  const archive = JSON.parse(fs.readFileSync(path.join(result.archiveDirectory, 'operation.json')));
  const row = archive.files.find(item => item.file === loader);
  assert.equal(fs.readFileSync(path.join(result.archiveDirectory, row.snapshot), 'utf8'), edited);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.dll'), 'utf8'), 'unrelated');
});

test('rescue clean archives modified owned bytes, tolerates deleted files and leaves unrelated plugins intact', async t => {
  const f = fixture(t), installed = await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const runtime = installed.layout.runtimeDir, addon = path.join(runtime, INSTALLED_NAMES.addon);
  fs.writeFileSync(addon, 'outside replacement Core'); fs.unlinkSync(path.join(runtime, INSTALLED_NAMES.runtime));
  fs.writeFileSync(path.join(f.dir, 'ReShade.ini'), '[ADDON]\nAddonPath=untrusted-path\n');
  fs.writeFileSync(path.join(runtime, 'unrelated.addon64'), 'private unrelated addon');
  const preview = await f.service.previewRescue(f.game, 'clean');
  assert.equal(fs.readFileSync(addon, 'utf8'), 'outside replacement Core');
  const result = await f.service.applyRescue(f.game, preview.planId, { confirm: true });
  assert.equal(result.removed, true); assert.equal(fs.existsSync(addon), false);
  assert.equal(fs.readFileSync(path.join(runtime, 'unrelated.addon64'), 'utf8'), 'private unrelated addon');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal((await f.service.inspect(f.game)).installed, false);
  const archive = JSON.parse(fs.readFileSync(path.join(result.archiveDirectory, 'operation.json'))), row = archive.files.find(item => item.file === addon);
  assert.equal(fs.readFileSync(path.join(result.archiveDirectory, row.snapshot), 'utf8'), 'outside replacement Core');
  const reinstalled = await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  assert.equal(reinstalled.applied, true); assert.equal((await f.service.inspect(f.game)).ready, true);
});

test('rescue rechecks preview hashes, process state and receipt identity before writing', async t => {
  let running = false;
  const f = fixture(t, { guards: { antiCheatPresent: () => false, assertGameClosed: async () => { if (running) throw Object.assign(new Error('game running'), { code: 'ERR_GAME_RUNNING' }); } } });
  await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const file = path.join(f.dir, 'ReShade.ini'); fs.writeFileSync(file, 'edited');
  const stale = await f.service.previewRescue(f.game, 'repair'); fs.writeFileSync(file, 'edited again');
  await assert.rejects(f.service.applyRescue(f.game, stale.planId, { confirm: true }), { code: 'DEPLOYMENT_PLAN_CHANGED' });
  assert.equal(fs.existsSync(stale.archiveDirectory), false); assert.equal(fs.readFileSync(file, 'utf8'), 'edited again');
  const live = await f.service.previewRescue(f.game, 'repair'); running = true;
  await assert.rejects(f.service.applyRescue(f.game, live.planId, { confirm: true }), { code: 'ERR_GAME_RUNNING' });
  assert.equal(fs.existsSync(f.pending), false); assert.equal(fs.readFileSync(file, 'utf8'), 'edited again');
});

test('failed rescue publication rolls back to the edited pre-rescue bytes and leaves a retryable plan', async t => {
  let fail = false;
  const f = fixture(t, { afterWrite: () => { if (fail) throw new Error('injected rescue failure'); } });
  await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const file = path.join(f.dir, 'ReShade.ini'); fs.writeFileSync(file, 'edited before rescue');
  const preview = await f.service.previewRescue(f.game, 'repair'); fail = true;
  await assert.rejects(f.service.applyRescue(f.game, preview.planId, { confirm: true }), /injected rescue failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited before rescue'); assert.equal(fs.existsSync(f.pending), false);
  fail = false; await f.service.applyRescue(f.game, (await f.service.previewRescue(f.game, 'repair')).planId, { confirm: true });
  assert.equal((await f.service.inspect(f.game)).ready, true);
});

test('rescue refuses a linked owned file and cannot turn damaged payload snapshots into a repair', async t => {
  const f = fixture(t), installed = await f.service.apply((await f.service.preview(f.game, f.request)).planId);
  const addon = path.join(installed.layout.runtimeDir, INSTALLED_NAMES.addon), saved = JSON.parse(fs.readFileSync(f.receipt));
  const history = path.join(path.dirname(installed.layout.runtimeDir), 'history', saved.generation), wal = JSON.parse(fs.readFileSync(path.join(history, 'operation.json')));
  const row = wal.files.find(item => item.file === addon); fs.unlinkSync(addon);
  fs.writeFileSync(path.join(history, row.prepared), 'damaged backup');
  await assert.rejects(f.service.previewRescue(f.game, 'repair'), { code: 'DEPLOYMENT_RESCUE_SOURCE_MISSING' });
  const other = path.join(f.root, 'outside.addon64'); fs.writeFileSync(other, 'foreign'); fs.linkSync(other, addon);
  await assert.rejects(f.service.previewRescue(f.game, 'clean'), /链接|link/i);
  assert.equal(fs.readFileSync(other, 'utf8'), 'foreign'); assert.equal(fs.existsSync(f.pending), false);
});

test('an invalid output prefix and a partial initial copy never leave a live component or file WAL', async t => {
  const prefix = fixture(t);
  fs.mkdirSync(prefix.options.userData, { recursive: true }); fs.writeFileSync(path.join(prefix.options.userData, 'external-runtime'), 'existing unrelated file');
  await assert.rejects(prefix.service.preview(prefix.game, prefix.request));
  assert.equal(fs.existsSync(prefix.pending), false);
  assert.equal(fs.readFileSync(path.join(prefix.options.userData, 'external-runtime'), 'utf8'), 'existing unrelated file');
  const f = fixture(t, { copyFile: async (source, destination) => { fs.writeFileSync(destination, fs.readFileSync(source).subarray(0, 3)); throw Object.assign(new Error('copy interrupted'), { code: 'EACCES' }); } });
  const plan = await f.service.preview(f.game, f.request);
  await assert.rejects(f.service.apply(plan.planId), /copy interrupted/);
  assert.equal(fs.existsSync(f.pending), false); assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
  assert.equal(fs.readdirSync(f.service.location(f.game).runtimeDir).length, 0);
});

test('an original addon appearing during publication rolls back instead of silently changing the active profile', async t => {
  let originalAddonDirectory;
  const f = fixture(t, { afterWrite: ({ row }) => {
    if (row.role === 'game-proxy') { fs.mkdirSync(originalAddonDirectory); fs.writeFileSync(path.join(originalAddonDirectory, 'new-user.addon64'), 'external user addon'); }
  } });
  originalAddonDirectory = path.join(f.dir, 'addon');
  const plan = await f.service.preview(f.game, f.request);
  await assert.rejects(f.service.apply(plan.planId), { code: 'DEPLOYMENT_PLAN_CHANGED' });
  assert.equal(fs.existsSync(f.pending), false); assert.equal(fs.existsSync(f.receipt), false);
  assert.equal(fs.readFileSync(path.join(originalAddonDirectory, 'new-user.addon64'), 'utf8'), 'external user addon');
  assert.equal(fs.readFileSync(path.join(f.dir, 'ReShade.ini'), 'utf8'), f.original);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
});
