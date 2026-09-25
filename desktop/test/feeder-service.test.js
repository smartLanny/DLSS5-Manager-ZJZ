'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFeederService } = require('../src/product/feeder-service');
const { createFeederRuntime, DIRECTORY, RECEIPT, sha, fingerprint } = require('../src/product/feeder-runtime');
const { assess, assessFeeder } = require('../src/product/game-support');
const { inspectNativeEnhancementCapabilities } = require('../src/product/game-enhancement-capabilities');
const journal = require('../src/core/file-journal');
const { createAppService } = require('../src/product/app-service');
const { createFeedbackCollector } = require('../src/product/feedback');
const { createRdr2ApiSettings } = require('../src/product/rdr2-api-settings');

function peBytes(machine = 0x8664) {
  const b = Buffer.alloc(160); b.writeUInt16LE(0x5a4d); b.writeUInt32LE(64, 60); b.writeUInt32LE(0x4550, 64);
  b.writeUInt16LE(machine, 68); b.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 88); return b;
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feeder-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, 'game'), exeDir = options.rdr2 ? gameRoot : path.join(gameRoot, 'bin');
  const exe = path.join(exeDir, options.rdr2 ? 'RDR2.exe' : 'Game.exe');
  const appDir = path.join(root, 'app'), packageRoot = path.join(appDir, 'resources', 'feeder-runtime');
  fs.mkdirSync(exeDir, { recursive: true }); fs.writeFileSync(exe, peBytes()); fs.mkdirSync(packageRoot, { recursive: true });
  const items = [
    ['dxgi.dll', 'loader', false, peBytes()],
    [`${DIRECTORY}/addons/core.addon64`, 'core', false, peBytes()],
    [`${DIRECTORY}/addons/provider.addon64`, 'provider', false, peBytes()],
    [`${DIRECTORY}/addons/nrchain_nvngx.dll`, 'chain', false, peBytes()],
    [`${DIRECTORY}/addons/nvngx_dlssnr.dll`, 'nr-runtime', false, peBytes()],
    [`${DIRECTORY}/addons/nr_before_sr.ini`, 'core-config', true, '[NRBeforeSR]\nEnabled=1\nIntensity=1.2\nR8OutputEncoding=2\n'],
    [`${DIRECTORY}/addons/dlss5-feed.cfg`, 'feeder-config', true, 'enabled=1\nmode=2\n'],
    [`${DIRECTORY}/ReShadePreset.ini`, 'preset', true, 'Techniques=motion,feed\n'],
    [`${DIRECTORY}/reshade-shaders/Shaders/Feed.fx`, 'shader', false, 'shader source'],
    [`${DIRECTORY}/reshade-shaders/Textures/noise.png`, 'shader', false, 'texture data'],
    ['ReShade.ini', 'reshade-config', true, `[GENERAL]\nEffectSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\${DIRECTORY}\\reshade-shaders\\Textures\\**\nPresetPath=.\\${DIRECTORY}\\ReShadePreset.ini\n[ADDON]\nAddonPath=.\\${DIRECTORY}\\addons\n`]
  ];
  const recipe = { version: 1, id: 'nr-feeder-dx12-047-sdr-20260909', route: 'feeder-dx12', api: 'dx12', architecture: 64, hardwareFamily: 'RTX50',
    coreVersion: '0.4.7beta', provenance: 'Synthetic', scope: 'post-process', colorContract: 'rgba8-srgb-confirmed',
    acceptance: { status: 'candidate', realGameVerified: false }, files: items.map(([target, role, mutable, bytes]) => {
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), file = path.join(packageRoot, target);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
      return { source: target, target, role, mutable, bytes: data.length, sha256: sha(data) };
    }) };
  fs.writeFileSync(path.join(packageRoot, 'recipe.json'), JSON.stringify(recipe));
  const lock = { id: recipe.id, recipeFingerprint: fingerprint(recipe) };
  const hardware = { family: 'RTX50', series: ['RTX50'] }, calls = [];
  let running = false, antiCheat = false, elevated = false;
  const broker = { async inspect() { calls.push('inspect'); if (elevated) throw Object.assign(new Error('needs elevation'), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' }); return { elevated: false, launchable: true }; },
    async launch(input) { calls.push(['launch', input]); return { pid: 42, elevated: false }; } };
  const guards = { antiCheatPresent: () => antiCheat, async assertGameClosed() { if (running) throw Object.assign(new Error('running'), { code: 'ERR_GAME_RUNNING' }); } };
  const pe = { getBitness: file => fs.readFileSync(file).readUInt16LE(68) === 0x8664 ? 64 : 32 };
  const runtime = createFeederRuntime({ appDir, lock, pe });
  const chosen = { path: exe, bitness: 64, apiResolution: { api: 'dx12' } };
  const game = { id: 'test', dir: gameRoot, scan: { chosen, primaryDlss: null, dlssFiles: [], streamlineFiles: [] } };
  const service = more => createFeederService({ appDir, userData: path.join(root, 'user'), hardware,
    overrides: { runtime, pe, broker, guards, executionLevel: () => elevated ? 'requireAdministrator' : 'asInvoker', ...options, ...more } });
  return { root, appDir, gameRoot, exeDir, exe, game, hardware, chosen, packageRoot, recipe, lock, runtime, calls, service,
    receipt: path.join(gameRoot, RECEIPT), file: target => path.join(exeDir, target), setRunning: value => running = value,
    setAntiCheat: value => antiCheat = value, setElevated: value => elevated = value };
}

test('waiting source verification checks fixed Feeder bytes while running without writing game files', async t => {
  const f = fixture(t), service = f.service(); f.setRunning(true);
  const verified = await service.verifySource(f.game, { version: f.recipe.coreVersion });
  assert.equal(verified.ready, true); assert.equal(verified.identity, f.lock.recipeFingerprint);
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.file(DIRECTORY)), false);
  fs.appendFileSync(path.join(f.packageRoot, f.recipe.files.find(row => row.role === 'core').source), 'changed');
  await assert.rejects(service.verifySource(f.game), error => /HASH|SIZE|SOURCE/.test(error.code));
  assert.equal(fs.existsSync(f.receipt), false);
});

function apiFixture(t, options = {}) {
  const f = fixture(t, { rdr2: options.rdr2 === true }), userData = path.join(f.root, 'user');
  const documentsDir = path.join(f.root, 'documents');
  const settingsFile = path.join(documentsDir, 'Rockstar Games', 'Red Dead Redemption 2', 'Settings', 'system.xml');
  if (options.rdr2) {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, '<rage__fwuiSystemSettingsCollection><advancedGraphics><API>kSettingAPI_Vulkan</API></advancedGraphics></rage__fwuiSystemSettingsCollection>');
  }
  const reader = createRdr2ApiSettings({ documentsDir }), feeder = f.service(options.feederOverrides);
  const library = { async scanAll(state) {
    const settings = options.rdr2 ? { ...reader.read({ exe: f.exe, steamAppId: '1174180', entryRoot: f.gameRoot }),
      kind: 'rdr2-system-xml', exe: f.exe, steamAppId: '1174180', entryRoot: f.gameRoot } : null;
    const detectedApi = settings?.api || options.detectedApi || 'unknown';
    const saved = state.gameOverrides[path.resolve(f.gameRoot).toLowerCase()];
    const bound = saved?.apiExecutable?.toLowerCase() === f.exe.toLowerCase() && saved.api !== 'auto';
    const chosen = { ...f.chosen, apiSettings: settings, supportedApis: options.supportedApis,
      detectedApi, detectedApiResolution: { api: detectedApi, source: 'fixture', evidence: [] },
      apiResolution: { api: bound ? saved.api : detectedApi, source: bound ? 'override' : 'fixture', evidence: [] } };
    return [{ ...f.game, chosen, apiOverride: bound ? saved.api : 'auto', installed: false,
      scan: { ...f.game.scan, chosen } }];
  } };
  const vulkan = { summary: () => ({ installed: options.vulkanInstalled === true,
    needsRecovery: options.vulkanPending === true, available: false }) };
  const app = createAppService({ userData, appDir: f.appDir, resourcesPath: path.join(f.appDir, 'resources'), documentsDir,
    overrides: { library, feeder, vulkan, apiSettingsReader: reader,
      detectGpu: () => f.hardware, assertGameClosed: async () => {} } });
  return { ...f, app, feeder, settingsFile, key: path.resolve(f.gameRoot).toLowerCase() };
}

test('Feeder previews are read-only and enumerate reused loaders and exact mutable-setting archives', async t => {
  const f = fixture(t), service = f.service();
  fs.copyFileSync(path.join(f.packageRoot, 'dxgi.dll'), f.file('dxgi.dll'));
  const preview = await service.previewInstall(f.game);
  assert.equal(preview.changes.filter(row => row.role !== 'receipt').length, f.recipe.files.length);
  assert.ok(preview.changes.some(row => row.path === f.file('dxgi.dll') && row.action === 'keep' && row.reused));
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(path.join(f.exeDir, DIRECTORY)), false);
  await service.install(f.game);
  const ini = f.file(`${DIRECTORY}/addons/nr_before_sr.ini`); fs.appendFileSync(ini, 'UserValue=123\n');
  const before = fs.readFileSync(f.receipt), restore = await service.previewRestore(f.game);
  const archived = restore.changes.find(row => row.role === 'settings-archive' && row.path.endsWith('nr_before_sr.ini'));
  assert.equal(archived.afterSha256, sha(fs.readFileSync(ini))); assert.equal(fs.existsSync(archived.path), false);
  assert.ok(restore.changes.some(row => row.path === f.file('dxgi.dll') && row.action === 'keep'));
  assert.deepEqual(fs.readFileSync(f.receipt), before); assert.equal(fs.existsSync(journal.pendingPath(f.gameRoot)), false);
});

test('unified Feeder preview includes RDR2 settings and rejects drift before any install write', async t => {
  const f = apiFixture(t, { rdr2: true }); await f.app.refresh();
  const original = fs.readFileSync(f.settingsFile);
  const plan = await f.app.previewSpecialDeployment('test', { route: 'feeder', api: 'dx12' });
  assert.equal(plan.packageId, f.recipe.id);
  assert.ok(plan.changes.some(row => row.path === f.settingsFile && row.role === 'game-api-settings' && row.action === 'replace'));
  assert.equal(fs.existsSync(f.receipt), false); assert.deepEqual(fs.readFileSync(f.settingsFile), original);
  fs.appendFileSync(f.settingsFile, '\n<!-- external preference change -->');
  await assert.rejects(f.app.applySpecialDeployment(plan.planId), { code: 'DEPLOYMENT_PLAN_CHANGED' });
  assert.equal(fs.existsSync(f.receipt), false);
  const fresh = await f.app.previewSpecialDeployment('test', { route: 'feeder', api: 'dx12' });
  assert.equal((await f.app.applySpecialDeployment(fresh.planId)).installed, true);
  assert.match(fs.readFileSync(f.settingsFile, 'utf8'), /kSettingAPI_DX12/);
  const restore = await f.app.previewUninstall('test', { mode: 'restore' });
  assert.ok(restore.changes.some(row => row.role === 'settings-archive'));
});

test('AppService commits an EXE-bound DX12 choice before installing Feeder for an unknown API', async t => {
  const f = apiFixture(t), [before] = await f.app.refresh();
  assert.equal(before.chosen.apiResolution.api, 'unknown');
  assert.equal(before.feeder.available, false);
  assert.equal(before.feeder.selectionAvailable, true);
  const result = await f.app.installFeeder('test', { api: 'dx12' });
  assert.equal(result.installed, true); assert.equal(result.appliedRoute.api, 'dx12');
  assert.equal(fs.existsSync(f.receipt), true);
  assert.equal(f.app.store.read().gameOverrides[f.key].api, 'dx12');
  assert.equal(f.app.store.read().gameOverrides[f.key].apiExecutable, f.exe);
  const [after] = await f.app.refresh();
  assert.equal(after.chosen.apiResolution.api, 'dx12'); assert.equal(after.feeder.available, true);
  assert.equal((await f.feeder.inspect({ ...f.game, scan: { ...f.game.scan, chosen: after.chosen } })).ready, true);
});

test('AppService restores both the previous API choice and actual game settings when Feeder copying fails', async t => {
  const f = apiFixture(t, { rdr2: true, feederOverrides: { async copyFile() { throw new Error('copy failure'); } } });
  await f.app.store.write({ gameOverrides: { [f.key]: { api: 'vulkan', apiExecutable: f.exe, name: 'Keep this name' } } });
  await f.app.refresh();
  const original = fs.readFileSync(f.settingsFile), before = f.app.store.read().gameOverrides;
  await assert.rejects(f.app.installFeeder('test', { api: 'dx12' }), /copy failure/);
  assert.deepEqual(f.app.store.read().gameOverrides, before);
  assert.deepEqual(fs.readFileSync(f.settingsFile), original);
  assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
  assert.equal(fs.existsSync(journal.pendingPath(f.gameRoot)), false);
});

test('Feeder auto selection uses current detection and leaves the existing auto binding in place on same-API repair', async t => {
  const f = apiFixture(t, { detectedApi: 'dx12' }); await f.app.refresh();
  assert.equal((await f.app.installFeeder('test', { api: 'auto' })).installed, true);
  const before = f.app.store.read().gameOverrides;
  assert.equal((await f.app.installFeeder('test', { api: 'dx12' })).repaired, true);
  assert.deepEqual(f.app.store.read().gameOverrides, before);
  assert.equal((await f.app.listGames())[0].chosen.apiResolution.source, 'fixture');
});

test('Feeder API selection preserves supported-API, hardware, package and route restrictions', async t => {
  for (const restriction of ['api', 'gpu', 'bitness', 'package', 'vulkan', 'vulkan-pending', 'native']) {
    const f = apiFixture(t, { supportedApis: restriction === 'api' ? ['vulkan'] : undefined,
      vulkanInstalled: restriction === 'vulkan', vulkanPending: restriction === 'vulkan-pending' });
    if (restriction === 'gpu') f.hardware.family = 'RTX40';
    if (restriction === 'bitness') f.chosen.bitness = 32;
    if (restriction === 'package') fs.unlinkSync(path.join(f.packageRoot, 'recipe.json'));
    if (restriction === 'native') {
      const { newManifest, manifestPath } = require('../src/product/manifest');
      fs.mkdirSync(path.dirname(manifestPath(f.gameRoot)), { recursive: true });
      fs.writeFileSync(manifestPath(f.gameRoot), JSON.stringify(newManifest(f.gameRoot, f.exe, 'dx12')));
    }
    const [game] = await f.app.refresh(), before = f.app.store.read().gameOverrides;
    assert.equal(game.feeder.selectionAvailable, false, restriction);
    assert.ok(game.feeder.selectionReason, restriction);
    await assert.rejects(f.app.installFeeder('test', { api: 'dx12' }));
    assert.deepEqual(f.app.store.read().gameOverrides, before, restriction);
    assert.equal(fs.existsSync(f.receipt), false, restriction);
  }
});

test('Feeder preflight rejects running games, anti-cheat and invalid source files before API settings change', async t => {
  for (const restriction of ['running', 'anti-cheat', 'source']) {
    const f = apiFixture(t, { rdr2: true });
    if (restriction === 'running') f.setRunning(true);
    if (restriction === 'anti-cheat') f.setAntiCheat(true);
    if (restriction === 'source') fs.writeFileSync(path.join(f.packageRoot, 'dxgi.dll'), 'changed');
    await f.app.refresh();
    const original = fs.readFileSync(f.settingsFile), before = f.app.store.read().gameOverrides;
    await assert.rejects(f.app.installFeeder('test', { api: 'dx12' }));
    assert.deepEqual(fs.readFileSync(f.settingsFile), original, restriction);
    assert.deepEqual(f.app.store.read().gameOverrides, before, restriction);
    assert.equal(fs.existsSync(path.join(f.root, 'user', 'game-api-backups')), false, restriction);
    assert.equal(fs.existsSync(f.receipt), false, restriction);
  }
});

test('an installed Feeder accepts same-API repair while preserving its saved binding and rejects unresolved auto selection', async t => {
  const f = apiFixture(t); await f.app.refresh();
  await f.app.installFeeder('test', { api: 'dx12' });
  const before = f.app.store.read().gameOverrides, receipt = fs.readFileSync(f.receipt);
  assert.equal((await f.app.installFeeder('test', { api: 'dx12' })).repaired, true);
  assert.deepEqual(f.app.store.read().gameOverrides, before);
  await assert.rejects(f.app.installFeeder('test', { api: 'auto' }), { code: 'ERR_API_SELECTION_REQUIRED' });
  assert.deepEqual(f.app.store.read().gameOverrides, before);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).installId, JSON.parse(receipt).installId);
});

test('Feeder gets a separate no-DLSS admission without weakening native installation', () => {
  const scan = { chosen: { bitness: 64, apiResolution: { api: 'dx12' } }, primaryDlss: null };
  assert.equal(assess(scan).code, 'ERR_NO_DLSS'); assert.equal(assessFeeder(scan).supported, true);
  for (const api of ['dx11', 'vulkan', 'opengl', 'unknown']) { scan.chosen.apiResolution.api = api; assert.equal(assessFeeder(scan).supported, false); }
  scan.chosen.apiResolution.api = 'dx12'; scan.chosen.bitness = 32; assert.equal(assessFeeder(scan).code, 'FEEDER_GAME_ARCH');
  scan.chosen.bitness = 64; scan.primaryDlss = { name: 'nvngx_dlss.dll' }; assert.equal(assessFeeder(scan).code, 'FEEDER_NATIVE_DLSS_PRESENT');
});

test('fixed recipe cannot self-authorize changed hashes, routes, bitness or a second core', async t => {
  const f = fixture(t);
  await f.runtime.verify();
  for (const edit of [r => r.api = 'dx11', r => r.architecture = 32, r => r.files[0].sha256 = 'f'.repeat(64), r => r.files.push({ ...r.files[1] })]) {
    const altered = structuredClone(f.recipe); edit(altered);
    fs.writeFileSync(path.join(f.packageRoot, 'recipe.json'), JSON.stringify(altered));
    assert.throws(() => f.runtime.load(), { code: 'FEEDER_PACKAGE_UNTRUSTED' });
  }
});

test('prepare installs only its fixed files and restoration keeps user settings in an archive', async t => {
  const f = fixture(t), s = f.service(), original = Buffer.from('unrelated game file'); fs.writeFileSync(f.file('keep.bin'), original);
  assert.equal(s.summary(f.game).available, true);
  const result = await s.install(f.game); assert.equal(result.installed, true); assert.equal(result.runtimeVerified, false);
  assert.equal((await s.inspect(f.game)).ready, true); assert.equal(s.summary(f.game).provenance, 'Synthetic');
  const config = f.file(`${DIRECTORY}/addons/nr_before_sr.ini`); fs.appendFileSync(config, 'Style=2\n');
  const custom = fs.readFileSync(config); await s.install(f.game); assert.deepEqual(fs.readFileSync(config), custom);
  const saved = JSON.parse(fs.readFileSync(f.receipt)); await s.restore(f.game);
  assert.equal(fs.existsSync(f.file('dxgi.dll')), false); assert.equal(fs.existsSync(f.receipt), false);
  assert.deepEqual(fs.readFileSync(path.join(f.gameRoot, '_DLSS5_Backup/feeder-settings', saved.installId, DIRECTORY, 'addons/nr_before_sr.ini')), custom);
  assert.deepEqual(fs.readFileSync(f.file('keep.bin')), original); assert.equal(fs.existsSync(journal.pendingPath(f.gameRoot)), false);
});

test('an exact existing loader is reused and preserved by restore', async t => {
  const f = fixture(t), s = f.service(); fs.copyFileSync(path.join(f.packageRoot, 'dxgi.dll'), f.file('dxgi.dll'));
  await s.install(f.game); const row = JSON.parse(fs.readFileSync(f.receipt)); assert.equal(row.files.find(file => file.target === 'dxgi.dll').reused, true);
  assert.deepEqual(s.summary(f.game).retainedFiles, ['dxgi.dll']);
  const restored = await s.restore(f.game); assert.deepEqual(fs.readFileSync(f.file('dxgi.dll')), peBytes());
  assert.deepEqual(restored.retainedFiles, ['dxgi.dll']); assert.equal(restored.route, 'feeder-dx12');
  assert.match(restored.notice, /安装前已有的 dxgi\.dll 已保留/); assert.match(restored.notice, /反作弊仍可能拒绝/);
});

test('anti-cheat confirmation permits a scoped install but never declares protected launch compatible', async t => {
  const f = fixture(t), s = f.service(); f.setAntiCheat(true);
  assert.equal(s.summary(f.game).antiCheatDetected, true); assert.match(s.summary(f.game).launchWarning, /离线设置不等于停用反作弊/);
  await assert.rejects(s.install(f.game), { code: 'ERR_ANTI_CHEAT_CONFIRM' });
  await s.install(f.game, { allowAntiCheat: true });
  const state = await s.inspect(f.game);
  assert.equal(state.ready, true); assert.equal(state.runtimeVerified, false); assert.match(state.launchWarning, /兼容性尚未确认/);
  const restored = await s.restore(f.game); assert.deepEqual(restored.retainedFiles, []); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
});

test('unknown proxy, existing ReShade config and an old native receipt cause no mutation', async t => {
  for (const name of ['dxgi.dll', 'd3d12.dll', 'ReShade.ini', '_DLSS5_Backup/xiaofeng-manager.json']) {
    const f = fixture(t), target = name.startsWith('_DLSS5_Backup') ? path.join(f.gameRoot, name) : f.file(name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'unknown');
    await assert.rejects(f.service().install(f.game)); assert.equal(fs.existsSync(f.receipt), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unknown'); assert.equal(fs.existsSync(f.file(DIRECTORY)), false);
  }
});

test('missing resource, running game, wrong GPU and elevation preflight decline before files are written', async t => {
  for (const condition of ['missing', 'running', 'gpu', 'elevated']) {
    const f = fixture(t);
    if (condition === 'missing') fs.unlinkSync(path.join(f.packageRoot, f.recipe.files[1].source));
    if (condition === 'running') f.setRunning(true);
    if (condition === 'gpu') f.hardware.family = 'RTX40';
    if (condition === 'elevated') f.setElevated(true);
    await assert.rejects(f.service().install(f.game)); assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
  }
});

test('failed copy and receipt writes roll back every new managed file', async t => {
  for (const failure of ['copy', 'receipt']) {
    const f = fixture(t); let copies = 0;
    const s = f.service(failure === 'copy' ? { async copyFile(...args) { if (++copies === 3) throw new Error('copy failure'); return fsp.copyFile(...args); } }
      : { async writeJson() { throw new Error('receipt failure'); } });
    await assert.rejects(s.install(f.game), new RegExp(`${failure} failure`));
    assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
    assert.equal(fs.existsSync(journal.pendingPath(f.gameRoot)), false);
  }
});

test('source drift, installed binary drift and added secondary owner never get silently repaired', async t => {
  const f = fixture(t), s = f.service(); await s.install(f.game);
  const core = f.file(`${DIRECTORY}/addons/core.addon64`), before = fs.readFileSync(core); fs.writeFileSync(core, 'foreign');
  await assert.rejects(s.install(f.game), { code: 'FEEDER_FILE_CHANGED' }); await assert.rejects(s.restore(f.game), { code: 'FEEDER_FILE_CHANGED' });
  assert.equal(fs.readFileSync(core, 'utf8'), 'foreign'); fs.writeFileSync(core, before);
  fs.writeFileSync(f.file(`${DIRECTORY}/addons/second.addon64`), 'foreign');
  await assert.rejects(s.launch(f.game), { code: 'FEEDER_ADDON_CONFLICT' }); assert.equal(f.calls.some(Array.isArray), false);
});

test('changed config routing or color contract blocks launch while ordinary settings remain editable', async t => {
  const f = fixture(t), s = f.service(); await s.install(f.game);
  const ini = f.file('ReShade.ini'), original = fs.readFileSync(ini, 'utf8');
  fs.writeFileSync(ini, original.replace(`AddonPath=.\\${DIRECTORY}\\addons`, 'AddonPath=..\\foreign'));
  await assert.rejects(s.launch(f.game), { code: 'FEEDER_CONFIG_CHANGED' }); fs.writeFileSync(ini, original);
  const coreIni = f.file(`${DIRECTORY}/addons/nr_before_sr.ini`); fs.writeFileSync(coreIni, fs.readFileSync(coreIni, 'utf8').replace('R8OutputEncoding=2', 'R8OutputEncoding=1'));
  await assert.rejects(s.launch(f.game), { code: 'FEEDER_COLOR_CONFIG' }); assert.equal(f.calls.some(Array.isArray), false);
});

test('ordinary launch preserves exact selected EXE, cwd and empty arguments; no FG setup occurs', async t => {
  const f = fixture(t), s = f.service(); f.setAntiCheat(true);
  await assert.rejects(s.install(f.game), { code: 'ERR_ANTI_CHEAT_CONFIRM' }); await s.install(f.game, { allowAntiCheat: true });
  await s.launch(f.game); const call = f.calls.find(Array.isArray);
  assert.deepEqual(call, ['launch', { exe: f.exe, args: [], cwd: f.exeDir }]);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt)).lastLaunch.pid, 42);
  assert.equal((await s.inspect(f.game)).runtimeVerified, false);
  assert.equal(f.recipe.files.some(file => /dlssg|dlss_g|mfg/i.test(file.target)), false);
});

test('a failed uninstall transaction restores live files and preserves the installation receipt', async t => {
  const f = fixture(t), s = f.service(); await s.install(f.game);
  const before = fs.readFileSync(f.receipt);
  const broken = f.service({ journal: { ...journal, transaction: (root, work) => journal.transaction(root, async () => { await work(); throw new Error('final commit failed'); }) } });
  await assert.rejects(broken.restore(f.game), /final commit failed/);
  assert.deepEqual(fs.readFileSync(f.receipt), before); assert.equal((await s.inspect(f.game)).ready, true);
});

test('SR and FG have separate real x64 evidence and never use private Feeder copies', t => {
  const f = fixture(t), add = (name, machine = 0x8664, sub = '') => { const file = f.file(path.join(sub, name)); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, peBytes(machine)); return { path: file, name }; };
  const scan = { dlssFiles: [add('nvngx_dlss.dll')], streamlineFiles: [] };
  assert.deepEqual(inspectNativeEnhancementCapabilities(scan), { nativeDlssAvailable: true, nativeFgAvailable: false, staticOnly: true });
  scan.dlssFiles.push(add('nvngx_dlssg.dll')); scan.streamlineFiles.push(add('sl.dlss_g.dll'), add('sl.common.dll'));
  assert.equal(inspectNativeEnhancementCapabilities(scan).nativeFgAvailable, true);
  scan.streamlineFiles[0] = add('sl.dlss_g.dll', 0x14c); assert.equal(inspectNativeEnhancementCapabilities(scan).nativeFgAvailable, false);
  assert.equal(inspectNativeEnhancementCapabilities({ dlssFiles: [add('nvngx_dlss.dll', 0x8664, DIRECTORY)] }).nativeDlssAvailable, false);
});

test('historical code-pinned receipts are restorable but cannot authorize a new package', async t => {
  const f = fixture(t), s = f.service(); await s.install(f.game);
  const previous = f.lock.recipeFingerprint, current = structuredClone(f.recipe); current.acceptance.status = 'controlled-callback-candidate';
  f.lock.recipeFingerprint = fingerprint(current); f.lock.restorableRecipeFingerprints = [previous];
  assert.throws(() => f.runtime.load(), { code: 'FEEDER_PACKAGE_UNTRUSTED' });
  fs.writeFileSync(path.join(f.packageRoot, 'recipe.json'), JSON.stringify(current));
  assert.equal(f.runtime.load().fingerprint, f.lock.recipeFingerprint);
  await assert.rejects(s.install(f.game), { code: 'FEEDER_UNAVAILABLE' });
  await s.restore(f.game); assert.equal(fs.existsSync(f.receipt), false); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
  await s.install(f.game); assert.equal(JSON.parse(fs.readFileSync(f.receipt)).recipeFingerprint, f.lock.recipeFingerprint);
});

async function interruptInstall(f) {
  let copies = 0;
  const s = f.service({ async copyFile(...args) {
    if (++copies === 3) throw Object.assign(new Error('interrupted copy'), { preservePending: true }); return fsp.copyFile(...args);
  } });
  await assert.rejects(s.install(f.game), { code: 'errBackendRecovery' });
  assert.equal(fs.existsSync(journal.pendingPath(f.gameRoot)), true);
}

test('an interrupted Feeder installation can be explicitly recovered without taking a native transaction', async t => {
  const f = fixture(t), s = f.service(); await interruptInstall(f);
  assert.equal(s.summary(f.game).needsRecovery, true);
  await assert.rejects(s.install(f.game), { code: 'FEEDER_RECOVERY_FIRST' });
  assert.equal((await s.restore(f.game)).restored, true); assert.equal(fs.existsSync(f.file('dxgi.dll')), false);
  const foreign = { version: 1, folder: '_DLSS5_Backup/.transactions/1234', files: [{ rel: '_DLSS5_Backup/manifest.json', existed: false, snapshot: '_DLSS5_Backup/.transactions/1234/0.bin' }], dirs: [] };
  fs.mkdirSync(path.dirname(journal.pendingPath(f.gameRoot)), { recursive: true }); fs.writeFileSync(journal.pendingPath(f.gameRoot), JSON.stringify(foreign));
  assert.equal(s.summary(f.game).needsRecovery, false); assert.equal(s.summary(f.game).installed, false);
  await assert.rejects(s.restore(f.game), { code: 'FEEDER_RECOVERY_OTHER' }); assert.deepEqual(JSON.parse(fs.readFileSync(journal.pendingPath(f.gameRoot))), foreign);
});

test('pending recovery refuses foreign archive paths, unrelated directories, duplicate snapshots and changed native manifest', async t => {
  for (const tamper of ['archive', 'directory', 'snapshot', 'manifest', 'binary']) {
    const f = fixture(t), s = f.service(); await interruptInstall(f);
    const pending = journal.pendingPath(f.gameRoot), state = JSON.parse(fs.readFileSync(pending));
    if (tamper === 'archive') state.files.push({ rel: '_DLSS5_Backup/feeder-settings/00000000-0000-4000-8000-000000000000/foreign-save.dat', existed: false, snapshot: state.folder + '/90.bin' });
    if (tamper === 'directory') { fs.mkdirSync(f.file('foreign-empty')); state.dirs.push('bin/foreign-empty'); }
    if (tamper === 'snapshot') state.files[1].snapshot = state.files[0].snapshot;
    if (tamper === 'manifest') fs.writeFileSync(path.join(f.gameRoot, '_DLSS5_Backup/manifest.json'), 'other-route-state');
    if (tamper === 'binary') fs.writeFileSync(f.file('dxgi.dll'), 'foreign-after-interruption');
    fs.writeFileSync(pending, JSON.stringify(state));
    await assert.rejects(s.restore(f.game), { code: ['manifest', 'binary'].includes(tamper) ? 'FEEDER_FILE_CHANGED' : 'FEEDER_RECOVERY_INVALID' });
    assert.equal(fs.existsSync(pending), true); assert.equal(fs.existsSync(f.file('dxgi.dll')), true);
    if (tamper === 'directory') assert.equal(fs.existsSync(f.file('foreign-empty')), true);
  }
});

test('main feedback export includes Core and Feeder logs beside a real nested EXE with a validated receipt', async t => {
  const f = fixture(t), feeder = f.service(); await feeder.install(f.game);
  const addons = f.file(`${DIRECTORY}/addons`), outside = path.join(f.root, 'private'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(addons, 'nr-before-sr.log'), 'CORE_FROM_NESTED_EXE\n');
  fs.writeFileSync(path.join(addons, 'dlss5-feed.log'), 'FEEDER_FROM_NESTED_EXE\n' + 'routine frame\n'.repeat(100000) + 'LATEST_FEEDER_FAILURE\n');
  fs.writeFileSync(f.file('ReShade.log'), 'LOCAL_RESHADE_LOG\n');
  fs.writeFileSync(path.join(addons, 'secrets.txt'), 'NON_LOG_FILENAME_NOT_READ');
  fs.writeFileSync(path.join(outside, 'nr-before-sr.log'), 'OUTSIDE_DIRECTORY_NOT_READ');
  const game = { ...f.game, name: 'Nested Feeder fixture', chosen: f.chosen };
  const app = createAppService({ appDir: f.appDir, resourcesPath: path.join(f.appDir, 'resources'), userData: path.join(f.root, 'user'), overrides: {
    library: { scanAll: async () => [game] }, feeder, detectGpu: () => f.hardware, vulkan: { summary: () => ({ installed: false, available: false }) }
  } });
  await app.refresh();
  const report = await app.collectFeedback(game.id), file = path.join(f.root, report.suggestedName); fs.writeFileSync(file, report.text);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /--- nr-before-sr\.log ---\nCORE_FROM_NESTED_EXE/);
  assert.match(text, /--- dlss5-feed\.log ---\nFEEDER_FROM_NESTED_EXE/);
  assert.match(text, /LATEST_FEEDER_FAILURE/); assert.match(text, /LOCAL_RESHADE_LOG/); assert.match(text, /省略中间日志/);
  assert.doesNotMatch(text, /OUTSIDE_DIRECTORY_NOT_READ|NON_LOG_FILENAME_NOT_READ/); assert.ok(Buffer.byteLength(text) < 32 * 1024);
  const direct = createFeedbackCollector({ userData: path.join(f.root, 'user') });
  const unauthorized = await direct.buildReport({ game, managedLogDirs: [addons, outside], feederLogDirectory: addons });
  assert.doesNotMatch(unauthorized.text, /CORE_FROM_NESTED_EXE|FEEDER_FROM_NESTED_EXE|OUTSIDE_DIRECTORY_NOT_READ/);
  const badResolver = createFeedbackCollector({ userData: path.join(f.root, 'user'), resolveFeederLogDirectory: async () => outside });
  assert.doesNotMatch((await badResolver.buildReport({ game, managedLogDirs: [outside] })).text, /OUTSIDE_DIRECTORY_NOT_READ/);
});

test('Feeder feedback rejects mismatched receipts, self-authorized recipes, links and nonselected EXE directories', async t => {
  const f = fixture(t), service = f.service(); await service.install(f.game);
  const game = { ...f.game, chosen: f.chosen }, addons = f.file(`${DIRECTORY}/addons`), log = path.join(addons, 'dlss5-feed.log');
  const collector = createFeedbackCollector({ userData: path.join(f.root, 'user'), resolveFeederLogDirectory: input => service.feedbackLogDirectory(input) });
  fs.writeFileSync(log, 'MANAGED_FEEDER_LOG\n');
  const saved = fs.readFileSync(f.receipt), row = JSON.parse(saved);
  for (const alter of [value => value.game.exe = 'bin/Other.exe', value => { value.recipe.acceptance.status = 'untrusted'; value.recipeFingerprint = fingerprint(value.recipe); }]) {
    const invalid = structuredClone(row); alter(invalid); fs.writeFileSync(f.receipt, JSON.stringify(invalid));
    const report = await collector.buildReport({ game, managedLogDirs: [addons] }); assert.doesNotMatch(report.text, /MANAGED_FEEDER_LOG/);
  }
  fs.writeFileSync(f.receipt, saved);
  const different = { ...game, chosen: { ...game.chosen, path: path.join(f.gameRoot, 'other', 'Game.exe') } };
  assert.doesNotMatch((await collector.buildReport({ game: different })).text, /MANAGED_FEEDER_LOG/);
  const privateDir = path.join(f.root, 'private'), privateLog = path.join(privateDir, 'dlss5-feed.log'); fs.mkdirSync(privateDir); fs.writeFileSync(privateLog, 'LINKED_PRIVATE_LOG');
  fs.unlinkSync(log); fs.linkSync(privateLog, log);
  assert.doesNotMatch((await collector.buildReport({ game })).text, /LINKED_PRIVATE_LOG/);
  fs.renameSync(addons, f.file(`${DIRECTORY}/saved-addons`)); fs.symlinkSync(privateDir, addons, 'junction');
  assert.doesNotMatch((await collector.buildReport({ game })).text, /LINKED_PRIVATE_LOG/);
});
