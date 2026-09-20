'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppService } = require('../src/product/app-service');
const { createLibraryService } = require('../src/product/library-service');
const { createInstaller } = require('../src/product/installer');
const { createCompactBundle } = require('../src/product/payload');
const { sha256 } = require('../src/product/payload');
const { normalizeError } = require('../src/product/errors');
const { PAYLOAD_FILES, DX11_COMPAT_VERSION, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const journal = require('../src/core/file-journal');
const { CARRIER, BRIDGE, zip, dx11Fixture } = require('./helpers/ota-fixture');
const D21_PACKAGE = 'C:\\Users\\PC\\Downloads\\装机宅DLSS5 0.5版本叠层测试\\OTA覆盖小包-装机宅叠层DLSS5-0.5-D21-累计常规版-中文-OTA.zip';

function makePayload(t, root) {
  const payloadRoot = path.join(root, 'resources', 'payload', 'nr-before-sr');
  for (const family of ['RTX40', 'RTX50']) {
    const dir = path.join(payloadRoot, 'fixed', family);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ReShade64.dll', 'nrchain_nvngx.dll', 'nvngx_dlssnr.dll'])
      fs.writeFileSync(path.join(dir, name), name === 'ReShade64.dll' ? 'ReShade Searching for add-ons' : `${family}:${name}`);
  }
  for (const version of ['0.3.3.5', DX11_COMPAT_VERSION]) {
    const dir = path.join(payloadRoot, 'versions', version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.addon), `${version}:addon`);
    fs.writeFileSync(path.join(dir, PAYLOAD_FILES.config), `${version}:config`);
  }
  const compat = path.join(payloadRoot, 'versions', DX11_COMPAT_VERSION);
  fs.writeFileSync(path.join(compat, PAYLOAD_FILES.bridge), 'compat:bridge');
  fs.writeFileSync(path.join(compat, DX11_COMPAT_CARRIER), 'compat:carrier');
  const bundle = createCompactBundle(payloadRoot, [
    { id: '0.3.3.5', label: 'stable' },
    { id: DX11_COMPAT_VERSION, label: 'unified DX11', compatibility: 'dx11' }
  ], '0.3.3.5');
  fs.writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify(bundle));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return payloadRoot;
}

function makeService(t, extraOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-api-service-'));
  const gameDir = path.join(root, 'game');
  const exeDir = path.join(gameDir, 'Binaries', 'Win64');
  fs.mkdirSync(exeDir, { recursive: true });
  const exe = path.join(exeDir, 'Game.exe');
  fs.writeFileSync(exe, 'fixture exe');
  const payloadDir = makePayload(t, root);
  const scan = {
    gameDir,
    exeCandidates: [{ path: exe, rel: 'Binaries\\Win64\\Game.exe', name: 'Game.exe', size: 1, api: 'dxgi', apiLabel: 'DirectX 11/12', bitness: 64, dx12: false }],
    chosen: { path: exe, rel: 'Binaries\\Win64\\Game.exe', name: 'Game.exe', size: 1, api: 'dxgi', apiLabel: 'DirectX 11/12', bitness: 64, dx12: false },
    dlssFiles: [{ path: path.join(gameDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 }],
    primaryDlss: { path: path.join(gameDir, 'nvngx_dlss.dll'), name: 'nvngx_dlss.dll', bitness: 64 },
    emulator: null,
    reshade: { installed: false }
  };
  const scanModule = {
    async scanGame() { return structuredClone(scan); },
    selectPrimaryDlss(files) { return files[0] || null; },
    inspectReShade(dir) {
      const file = path.join(dir, 'dxgi.dll');
      return fs.existsSync(file)
        ? { installed: true, file: 'dxgi.dll', addonSupport: fs.readFileSync(file).includes('Searching for add-ons') }
        : { installed: false, file: null, addonSupport: false };
    }
  };
  const library = createLibraryService({ scan: scanModule, library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows } });
  const installer = createInstaller({ journal, scan: scanModule, guards: { antiCheatPresent: () => false, assertGameClosed: async () => {} }, pe: { getBitness: () => 64 } });
  const service = createAppService({ userData: path.join(root, 'user-data'), resourcesPath: path.join(root, 'resources'), appDir: root, version: '0.4.5', overrides: { library, installer, detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' }), ...extraOverrides } });
  return { root, gameDir, exe, payloadDir, service, scan, library, installer };
}

async function externalFixture(t) {
  const f=makeService(t);await f.service.addManualGame(f.gameDir);const id=(await f.service.boot()).games[0].id;await f.service.setGameApi(id,'dx12');
  const external=path.join(f.root,'external','nr-before-sr');fs.cpSync(f.payloadDir,external,{recursive:true});
  const addon=path.join(external,'versions','0.3.3.5',PAYLOAD_FILES.addon);fs.writeFileSync(addon,'external:stable:addon');
  const bundleFile=path.join(external,'bundle.json'),bundle=JSON.parse(fs.readFileSync(bundleFile,'utf8'));bundle.versions['0.3.3.5'].files[PAYLOAD_FILES.addon]=sha256(addon);fs.writeFileSync(bundleFile,JSON.stringify(bundle));
  return {...f,id,external,addon,bundleFile};
}

for (const deployment of ['local', 'external']) test(`waiting source validation verifies the ${deployment} package while the game runs without deploying it`, async t => {
  const running = async () => { throw Object.assign(new Error('game running'), { code: 'errGameRunning' }); };
  const f = makeService(t, { assertGameClosed: running, externalDeploymentOptions: { guards: { assertGameClosed: running, antiCheatPresent: () => false }, pe: { getImports: () => [] } } });
  await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  const request = { api: 'dx12', version: '0.3.3.5', deployment };
  const result = await f.service.validateWaitingComponents(id, request);
  assert.equal(result.ready, true); assert.equal(result.route, 'native'); assert.equal(result.version, request.version);
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), PAYLOAD_FILES.addon)), false);
  assert.equal(fs.existsSync(path.join(f.gameDir, '_DLSS5_Backup')), false);
  fs.appendFileSync(path.join(f.payloadDir, 'versions', request.version, PAYLOAD_FILES.addon), 'changed source');
  await assert.rejects(f.service.validateWaitingComponents(id, request), { code: 'ERR_PAYLOAD_HASH' });
  assert.equal(fs.existsSync(path.join(f.gameDir, '_DLSS5_Backup')), false);
});

test('unified deployment performs a first external install and routes NR, hotkeys, diagnosis and uninstall to its active profile', async t => {
  const f = makeService(t, { assertGameClosed: async () => {},
    externalDeploymentOptions: { guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, pe: { getImports: () => [] } } });
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  const plan = await f.service.previewDeployment(id, { mode: 'external', api: 'dx12', version: '0.3.3.5' });
  f.installer.install = async () => { throw new Error('first external deployment must not invoke native install'); };
  assert.deepEqual(plan.phases, ['external-install']);
  assert.ok(plan.changes.some(row => row.phase === 'external-install' && row.name === PAYLOAD_FILES.addon));
  await f.service.applyDeployment(plan.planId);
  const layout = f.service.getLayout(id);
  assert.equal(layout.mode, 'external'); assert.equal(layout.verified, true);
  const modules = await f.service.gameModuleManifest(id);
  assert.equal(modules.find(row => row.role === 'core').path, path.join(layout.runtimeDir, PAYLOAD_FILES.addon));
  assert.equal(modules.find(row => row.role === 'reshade').path, path.join(path.dirname(f.exe), 'dxgi.dll'));
  await f.service.writeNrSettings(id, { Intensity: 1.6 });
  assert.match(fs.readFileSync(path.join(layout.nrConfigDir, 'nr_before_sr.ini'), 'utf8'), /Intensity=1.6/);
  await f.service.writeGameHotkey(id, 'reshade', { key: 35 });
  assert.match(fs.readFileSync(layout.activeConfigPath, 'utf8'), /KeyOverlay=35,0,0,0/);
  assert.equal((await f.service.readGameHotkeys(id)).reshade.key, 35);
  const diagnosis = await f.service.diagnose(id);
  assert.equal(diagnosis.complete, true); assert.equal(diagnosis.deployment.mode, 'external');
  fs.writeFileSync(path.join(layout.runtimeDir, 'nr-before-sr.log'), 'external Core log marker');
  const report = await f.service.collectFeedback(id);
  assert.match(report.text, /external Core log marker/);
  const uninstall = await f.service.previewUninstall(id, { mode: 'clean' });
  assert.deepEqual(uninstall.phases, ['external-uninstall']);
  assert.ok(uninstall.changes.some(row => row.phase === 'external-uninstall' && row.name === PAYLOAD_FILES.addon && row.afterSha256 === null));
  const result = await f.service.uninstall(id, { mode: 'clean' });
  assert.equal(result.removed, true); assert.equal(result.mode, 'clean');
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), PAYLOAD_FILES.addon)), false);
});

test('installation metadata reads preserve imported and comparison entries without inspecting large payload files', async t => {
  const f = makeService(t); await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id, metadataFile = path.join(f.payloadDir, 'bundle.json');
  const bundle = JSON.parse(fs.readFileSync(metadataFile));
  bundle.versions.comparison = { ...bundle.versions['0.3.3.5'], comparisonOnly: true, compatibilityEvidence: { scope: 'same-game comparison' } };
  bundle.versions.retired = { ...bundle.versions['0.3.3.5'] }; bundle.supersededVersions = { retired: '0.3.3.5' };
  fs.writeFileSync(metadataFile, JSON.stringify(bundle));
  const importedId = 'imported-aabbccddeeff', importedDir = path.join(f.root, 'user-data', 'addon-versions', importedId);
  fs.mkdirSync(importedDir, { recursive: true });
  fs.writeFileSync(path.join(importedDir, 'meta.json'), JSON.stringify({ id: importedId, label: 'Imported user Core', kind: 'ota', compatibility: 'dx11' }));
  fs.writeFileSync(path.join(importedDir, PAYLOAD_FILES.addon), 'metadata-only source; not parsed or executed');
  const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (typeof file === 'string' && /\.(?:dll|addon64)$/i.test(file)) throw new Error('catalog must not read payload bytes');
    return originalRead.call(this, file, ...args);
  };
  let catalog;
  try { catalog = f.service.coreVersionCatalog(); } finally { fs.readFileSync = originalRead; }
  assert.ok(catalog.find(row => row.id === importedId && row.ota && row.addonOnly && row.verification === 'metadata-only'));
  assert.equal(catalog.find(row => row.id === 'comparison').comparisonOnly, true);
  assert.equal(catalog.some(row => row.id === 'retired'), false);
  assert.equal(f.service.assessmentSeed(id).scan.chosen.path, f.exe);
  const defaults = f.service.installationDefaults(id);
  assert.equal(defaults.api, 'auto'); assert.equal(defaults.version, '0.3.3.5');
  assert.equal(defaults.deployment, 'local'); assert.equal(defaults.loadingMode, 'proxy');
  fs.renameSync(metadataFile, metadataFile + '.absent');
  assert.ok(f.service.coreVersionCatalog().find(row => row.id === importedId));
});

test('planned FG restoration can be previewed but must finish before external deployment applies', async t => {
  const f = makeService(t, { assertGameClosed: async () => {},
    externalDeploymentOptions: { guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, pe: { getImports: () => [] } } });
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx12'); await f.service.install(id, { version: '0.3.3.5' });
  const fg = path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-fg-components.json');
  fs.writeFileSync(fg, '{}');
  const request = { mode: 'external', api: 'dx12', version: '0.3.3.5' };
  await assert.rejects(f.service.previewDeployment(id, request), { code: 'DEPLOYMENT_FG_RESTORE_FIRST' });
  const blocked = await f.service.previewDeployment(id, request, { plannedFgRestore: true });
  assert.equal(blocked.requiresFgRestore, true);
  await assert.rejects(f.service.applyDeployment(blocked.planId), { code: 'DEPLOYMENT_FG_RESTORE_FIRST' });
  const plan = await f.service.previewDeployment(id, request, { plannedFgRestore: true });
  fs.unlinkSync(fg);
  fs.writeFileSync(path.join(path.dirname(f.exe), 'ReShade.ini'), '[UserFilter]\nKeptAfterFgRestore=1\n');
  const oldState = f.service.store.read();
  const otherKey = path.join(f.root, 'another-game').toLowerCase();
  await f.service.store.write({ gameOverrides: { ...oldState.gameOverrides, [otherKey]: { api: 'dx11', apiExecutable: path.join(otherKey, 'other.exe') } } });
  await f.service.applyDeployment(plan.planId);
  assert.match(fs.readFileSync(f.service.getLayout(id).activeConfigPath, 'utf8'), /KeptAfterFgRestore=1/);
  assert.equal(f.service.store.read().gameOverrides[otherKey].api, 'dx11');
});

test('historical hotfix Add-on restored by uninstall stays visible and can be reversibly isolated', async t => {
  const f = await externalFixture(t), name = 'DLSS5-AI渲染超分版-beta0.4.6-hotfix.1-@野生的装机宅-Bilibili.addon64';
  const old = path.join(path.dirname(f.exe), name); fs.writeFileSync(old, 'original hotfix core');
  await assert.rejects(f.service.install(f.id, { version: '0.3.3.5' }), { code: 'ADOPTION_CONFIRM_REQUIRED' });
  const adoption = await f.service.previewDeployment(f.id, { mode: 'local', api: 'dx12', version: '0.3.3.5' });
  assert.equal(adoption.requiresAdoptionConfirmation, true); assert.equal(fs.readFileSync(old, 'utf8'), 'original hotfix core');
  await f.service.applyDeployment(adoption.planId, { confirm: true });
  assert.equal(fs.existsSync(old), false, 'installation quarantines the conflicting old Add-on');
  const result = await f.service.uninstall(f.id);
  assert.equal(result.removed, true); assert.equal(fs.readFileSync(old, 'utf8'), 'original hotfix core');
  assert.ok(result.restoredOriginalFiles.some(rel => rel.endsWith(name)));
  const environment = require('../src/product/game-environment').createGameEnvironment({
    gameDirectory: () => f.gameDir, gameExecutable: () => f.exe, pe: { versionMentions: () => false }, guards: { assertGameClosed: async () => {} }
  });
  const remaining = (await environment.inspect(f.id)).remainingFiles;
  assert.equal(remaining.find(row => row.name === name).legacyNr, true);
  const preview = await environment.preview(f.id);
  assert.equal(preview.candidates.find(row => row.name === name).selectedByDefault, true);
  await environment.apply(f.id, preview.planId, [name]); assert.equal(fs.existsSync(old), false);
  await environment.restore(f.id); assert.equal(fs.readFileSync(old, 'utf8'), 'original hotfix core');
});

test('incomplete uninstall returns a failed IPC envelope and keeps the original receipt and changed file', async t => {
  const f = await externalFixture(t); await f.service.install(f.id, { version: '0.3.3.5' });
  const receipt = path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json');
  const before = fs.readFileSync(receipt), changed = path.join(path.dirname(f.exe), PAYLOAD_FILES.bridge);
  fs.writeFileSync(changed, 'external changed bridge');
  const result = await f.service.withError(() => f.service.uninstall(f.id), { action: 'game-uninstall', gameId: f.id });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'ERR_FILE_CHANGED');
  assert.equal(result.error.details.removed, false); assert.equal(result.error.details.operation, 'uninstall');
  assert.ok(result.error.details.warnings.some(row => row.code === 'ERR_FILE_CHANGED' && row.rel.endsWith(PAYLOAD_FILES.bridge)));
  assert.match(result.error.message, /nrchain_nvngx\.dll/); assert.doesNotMatch(result.error.message, /卸载完成/);
  assert.deepEqual(fs.readFileSync(receipt), before);
  assert.equal(fs.readFileSync(changed, 'utf8'), 'external changed bridge');
  assert.equal((await f.service.listGames()).find(game => game.id === f.id).installed, true);
});

test('missing imported source does not hide installed-file diagnostics or prevent uninstall', async t => {
  const f=await externalFixture(t);await f.service.install(f.id,{version:'0.3.3.5'});
  const file=path.join(f.gameDir,'_DLSS5_Backup/xiaofeng-manager.json'), manifest=JSON.parse(fs.readFileSync(file));
  manifest.payloadVersion='imported-123456789abc';fs.writeFileSync(file,JSON.stringify(manifest));await f.service.refreshAfterMutation({});
  const diagnosis=await f.service.diagnose(f.id);assert.equal(diagnosis.sourceMissing,true);assert.equal(diagnosis.components.find(row=>row.key==='addon').ok,true);
  assert.equal(diagnosis.complete, true); assert.match(diagnosis.sourceNotice, /原安装源不可用/);
  await assert.rejects(f.service.repair(f.id),{code:'ERR_ADDON_NOT_FOUND'});
  await f.service.uninstall(f.id);assert.equal(fs.existsSync(file),false);
});

test('missing-source feedback keeps current-EXE component diagnostics and ignores old-directory hashes', async t => {
  const f = await externalFixture(t); await f.service.install(f.id, { version: '0.3.3.5' });
  const file = path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.payloadVersion = 'imported-missing-source';
  const addon = manifest.files.find(row => row.kind === 'addon');
  manifest.files.push({ ...addon, rel: path.join('OldExecutable', PAYLOAD_FILES.addon), installedSha256: '0'.repeat(64) });
  fs.writeFileSync(file, JSON.stringify(manifest)); await f.service.refreshAfterMutation({});
  let calls = 0; const original = f.installer.diagnose;
  f.installer.diagnose = async request => { calls++; return original(request); };
  const diagnosis = await f.service.diagnose(f.id);
  assert.equal(diagnosis.sourceMissing, true); assert.equal(diagnosis.components.find(row => row.key === 'addon').ok, true);
  const feedback = await f.service.collectFeedback(f.id);
  assert.equal(calls, 2, 'each operation shares one diagnosis path without a duplicate inspect/diagnose');
  assert.match(feedback.text, /NR Core：完整/); assert.match(feedback.text, /修复来源：原安装源不可用/);
  assert.doesNotMatch(feedback.text, /诊断生成：/);
});

test('removing an installed game restores managed files before excluding the row; a failure keeps it visible', async t => {
  const f=await externalFixture(t);await f.service.install(f.id,{version:'0.3.3.5'});
  const bridge=path.join(path.dirname(f.exe),PAYLOAD_FILES.bridge), installed=fs.readFileSync(bridge);
  fs.writeFileSync(bridge,'changed externally');await assert.rejects(f.service.dismissGame(f.id));assert.equal((await f.service.boot()).games.some(row=>row.id===f.id),true);
  fs.writeFileSync(bridge,installed);await f.service.dismissGame(f.id);assert.equal((await f.service.boot()).games.some(row=>row.id===f.id),false);
  assert.equal(fs.existsSync(bridge),false);assert.equal(fs.existsSync(path.join(f.gameDir,'_DLSS5_Backup/xiaofeng-manager.json')),false);assert.equal(fs.existsSync(f.exe),true);
});

test('uninstall chooses the first recognized warning and fails closed when no warning is recognized', async t => {
  const f = await externalFixture(t);
  for (const [warnings, code] of [
    [[{ code: 'ERR_FUTURE_WARNING', rel: 'unknown.dll' }, { code: 'ERR_FILE_CHANGED', rel: 'kept.dll' }, { code: 'ERR_BACKUP_INVALID' }], 'ERR_FILE_CHANGED'],
    [[{ code: 'ERR_FUTURE_WARNING', rel: 'unknown.dll' }], 'ERR_BACKUP_INVALID'],
    [[], 'ERR_BACKUP_INVALID']
  ]) {
    f.installer.uninstall = async () => ({ removed: false, warnings });
    const result = await f.service.withError(() => f.service.uninstall(f.id));
    assert.equal(result.ok, false); assert.equal(result.error.code, code);
    assert.deepEqual(result.error.details.warnings, warnings);
    assert.equal(result.error.details.removed, false);
  }
});

test('successful uninstall preserves archive metadata and refreshes the real installed state', async t => {
  const f = await externalFixture(t); await f.service.install(f.id, { version: '0.3.3.5' });
  const result = await f.service.withError(() => f.service.uninstall(f.id));
  assert.equal(result.ok, true); assert.equal(result.value.removed, true);
  assert.match(result.value.historyRel, /^_DLSS5_Backup[\\/]xiaofeng-history[\\/]/);
  assert.equal(fs.existsSync(path.join(f.gameDir, result.value.historyRel)), true);
  assert.ok(Array.isArray(result.value.retainedSidecars)); assert.equal(typeof result.value.archivedConflictCopies, 'number');
  assert.equal(fs.existsSync(path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json')), false);
  assert.equal((await f.service.listGames()).find(game => game.id === f.id).installed, false);
});

test('external source persists across restart and installs from selected files while preserving game paths',async t=>{
  const f=await externalFixture(t),before=f.service.store.read();
  const result=await f.service.selectPayloadSource(path.dirname(f.external));assert.equal(result.payload.source.mode,'external');assert.equal(result.addons[0].source,'external');
  assert.deepEqual(f.service.store.read().manualGames,before.manualGames);assert.deepEqual(f.service.store.read().gameOverrides,before.gameOverrides);
  const restarted=createAppService({userData:path.join(f.root,'user-data'),resourcesPath:path.join(f.root,'resources'),appDir:f.root,overrides:{library:f.library,installer:f.installer,detectGpu:()=>({family:'RTX40'})}});
  assert.equal((await restarted.boot()).payload.source.path,fs.realpathSync(f.external));await restarted.install(f.id,{version:'0.3.3.5'});
  assert.equal(fs.readFileSync(path.join(path.dirname(f.exe),PAYLOAD_FILES.addon),'utf8'),'external:stable:addon');
});

test('direct NR config and hotkey access cannot follow a newly selected EXE away from the install receipt', async t => {
  const f = await externalFixture(t); await f.service.install(f.id, { version: '0.3.3.5' });
  const other = path.join(f.gameDir, 'Binaries', 'Win64', 'Other.exe'); fs.writeFileSync(other, 'other exe');
  f.scan.exeCandidates = [{ ...f.scan.chosen, path: other, rel: path.relative(f.gameDir, other), name: 'Other.exe' }];
  f.scan.chosen = f.scan.exeCandidates[0];
  await f.service.refresh();
  for (const operation of [
    () => f.service.readNrSettings(f.id),
    () => f.service.writeNrSettings(f.id, { Style: 1 }),
    () => f.service.readGameHotkeys(f.id),
    () => f.service.writeGameHotkey(f.id, 'reshade', { key: 36 }),
    () => f.service.applyDefault(f.id),
    () => f.service.applyRecommended(f.id)
  ]) await assert.rejects(operation, { code: 'ERR_INSTALL_EXE_CHANGED' });
});

test('Core-only acceptance ZIP keeps its specific message and creates no imported version', async t => {
  const f = makeService(t), file = path.join(f.root, 'core-only.zip');
  zip(file, [
    { name: 'core.addon64', data: 'isolated-core' },
    { name: BRIDGE, data: 'isolated-nrchain' },
    { name: 'build-info.json', data: JSON.stringify({ version: 'beta0.5-dev10', scope: 'D3D12 Core-only manual acceptance; not Manager/multi-API OTA' }) },
    { name: 'SHA256.json', data: '[]' }
  ]);
  await assert.rejects(f.service.importAddonFile(file), error => {
    assert.equal(error.code, 'ERR_OTA_CORE_ONLY');
    assert.match(normalizeError(error).message, /仅供 D3D12 验收.*不能作为 Manager OTA/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(f.root, 'user-data', 'addon-versions')), false);
});

test('bad source selection leaves active preferences intact and disconnected source cannot silently fall back',async t=>{
  const f=await externalFixture(t);await f.service.selectPayloadSource(f.external);const before=f.service.store.read();
  await assert.rejects(f.service.selectPayloadSource(path.join(f.root,'missing')),{code:'ERR_PAYLOAD_SOURCE_MISSING'});assert.deepEqual(f.service.store.read(),before);
  const moved=path.join(f.root,'disconnected');assert.ok(f.external.startsWith(f.root+path.sep)&&moved.startsWith(f.root+path.sep));fs.renameSync(f.external,moved);
  const boot=await f.service.boot();assert.equal(boot.games.length,1);assert.equal(boot.payload.ready,false);assert.equal(boot.payload.source.error.code,'ERR_PAYLOAD_SOURCE_UNAVAILABLE');
  await assert.rejects(f.service.install(f.id),{code:'ERR_PAYLOAD_SOURCE_UNAVAILABLE'});assert.equal(fs.existsSync(path.join(path.dirname(f.exe),'dxgi.dll')),false);
  await f.service.selectPayloadSource(null);assert.equal((await f.service.boot()).payload.source.mode,'bundled');assert.equal(f.service.store.read().payloadSourcePath,null);
});

test('source manifest changes require explicit recheck and operation rejects later binary drift',async t=>{
  const f=await externalFixture(t);await f.service.selectPayloadSource(f.external);fs.appendFileSync(f.bundleFile,'\n');
  assert.equal(f.service.payloadState().payload.source.error.code,'ERR_PAYLOAD_SOURCE_CHANGED');await assert.rejects(f.service.install(f.id),{code:'ERR_PAYLOAD_SOURCE_CHANGED'});
  assert.equal((await f.service.recheckPayloadSource()).payload.ready,true);fs.appendFileSync(f.addon,'changed');
  await assert.rejects(f.service.install(f.id),{code:'ERR_PAYLOAD_HASH'});assert.equal(fs.existsSync(path.join(path.dirname(f.exe),'dxgi.dll')),false);
});

test('repair never silently replaces an installed version absent from the selected external catalog',async t=>{
  const f=await externalFixture(t);await f.service.install(f.id,{version:'0.3.3.5'});
  const bundle=JSON.parse(fs.readFileSync(f.bundleFile,'utf8'));delete bundle.versions['0.3.3.5'];bundle.defaultVersion=DX11_COMPAT_VERSION;fs.writeFileSync(f.bundleFile,JSON.stringify(bundle));
  await f.service.selectPayloadSource(f.external);await assert.rejects(f.service.repair(f.id),{code:'ERR_ADDON_NOT_FOUND'});
  await f.service.repair(f.id,{version:DX11_COMPAT_VERSION});
});

test('external-only manager starts without bundled payload and can prepare installation from a remembered source', async t => {
  const f = await externalFixture(t);
  const staging = path.join(f.root, 'saved-bundled-fixture');
  assert.ok(f.payloadDir.startsWith(f.root + path.sep) && staging.startsWith(f.root + path.sep));
  fs.renameSync(f.payloadDir, staging);
  const restarted = createAppService({ userData: path.join(f.root, 'user-data'), resourcesPath: path.join(f.root, 'resources'),
    appDir: f.root, overrides: { library: f.library, installer: f.installer, detectGpu: () => ({ family: 'RTX40' }) } });
  const initial = await restarted.boot();
  assert.equal(initial.games.length, 1);
  assert.equal(initial.payload.ready, false);
  assert.equal(initial.payload.source.mode, 'unconfigured');
  assert.equal(initial.payload.source.path, '');
  assert.equal(initial.payload.source.bundledAvailable, false);
  const selected = await restarted.selectPayloadSource(f.external);
  assert.equal(selected.payload.source.bundledAvailable, false);
  assert.equal(selected.payload.ready, true);
  await assert.rejects(restarted.selectPayloadSource(null), { code: 'ERR_PAYLOAD_MISSING' });
  assert.equal(restarted.store.read().payloadSourcePath, fs.realpathSync(f.external));
  await restarted.install(f.id, { version: '0.3.3.5' });
  assert.equal(fs.readFileSync(path.join(path.dirname(f.exe), PAYLOAD_FILES.addon), 'utf8'), 'external:stable:addon');
});

test('slim bundled manager treats a missing GPU runtime as DLC setup and activates the matching import', async t => {
  const f = makeService(t), runtime = path.join(f.payloadDir, 'fixed', 'RTX40', 'nvngx_dlssnr.dll');
  fs.unlinkSync(runtime);
  const initial = await f.service.boot();
  assert.equal(initial.payload.ready, false);
  assert.equal(initial.payload.source.runtimeDlcRequired, true);
  assert.equal(initial.payload.source.requiredHardwareFamily, 'RTX40');
  assert.equal(initial.payload.source.error, null);

  const dlc = path.join(f.root, 'runtime-dlc'); fs.mkdirSync(dlc);
  const bytes = Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(2, 84); bytes.writeUInt16LE(0x20b, 88);
  const file = path.join(dlc, 'nvngx_dlssnr.dll'); fs.writeFileSync(file, bytes);
  fs.writeFileSync(path.join(dlc, 'component-manifest.json'), JSON.stringify({ schema:'dlss5-component-v1', id:'runtime-test-rtx40', kind:'nr-runtime',
    version:'test', variant:'RTX40', architecture:'x64', interface:'NGX-Feature18', hardwareFamilies:['RTX40'],
    files:[{ path:'nvngx_dlssnr.dll', sha256:sha256(file), bytes:bytes.length }] }));
  const result = await f.service.importRuntimeDlc(dlc);
  assert.equal(result.activated, true);
  assert.equal(result.hardwareFamily, 'RTX40');
  assert.equal(result.state.payload.ready, true);
  assert.equal(result.state.payload.source.runtimeDlcRequired, false);
});

test('API override routes one game through DX12 then unified DX11 and persists', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir, { name: 'Fixture' });
  let boot = await f.service.boot();
  const id = boot.games[0].id;
  assert.equal(boot.games[0].chosen.apiResolution.api, 'mixed');
  assert.equal(boot.games[0].supportCode, 'ERR_API_SELECTION_REQUIRED');
  await assert.rejects(f.service.install(id, { version: DX11_COMPAT_VERSION }), { code: 'ERR_API_SELECTION_REQUIRED' });

  await f.service.setGameApi(id, 'dx12');
  boot = await f.service.boot();
  assert.equal(boot.games[0].apiOverride, 'dx12');
  assert.equal(boot.games[0].chosen.apiResolution.api, 'dx12');
  await f.service.install(id, { version: DX11_COMPAT_VERSION });
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), 'nrchain_nvngx.dll')), true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), DX11_COMPAT_CARRIER)), false);

  await f.service.setGameApi(id, 'dx11');
  boot = await f.service.boot();
  assert.equal(boot.games[0].chosen.apiResolution.api, 'dx11');
  await f.service.repair(id, { version: DX11_COMPAT_VERSION });
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), DX11_COMPAT_CARRIER)), true);

  await f.service.setGameApi(id, 'dx12');
  await f.service.repair(id, { version: DX11_COMPAT_VERSION });
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), DX11_COMPAT_CARRIER)), false);
  await f.service.uninstall(id);
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), 'nrchain_nvngx.dll')), false);

  const fresh = createAppService({ userData: path.join(f.root, 'user-data'), resourcesPath: path.join(f.root, 'resources'), appDir: f.root, version: '0.4.5', overrides: { library: f.library, installer: f.installer, detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' }) } });
  // The persisted override is checked through a fresh service using the same
  // real library; no fake game state is injected into the service layer.
  const freshBoot = await fresh.boot();
  assert.equal(freshBoot.games[0].apiOverride, 'dx12');
  assert.equal(freshBoot.games[0].chosen.apiResolution.api, 'dx12');
});

test('carrier follows API automatically and the retired manual endpoint cannot override it', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx11');
  await f.service.install(id, { version: DX11_COMPAT_VERSION });
  const dir = path.dirname(f.exe);
  const carrier = path.join(dir, DX11_COMPAT_CARRIER);
  const core = path.join(dir, PAYLOAD_FILES.addon), bridge = path.join(dir, PAYLOAD_FILES.bridge);
  const before = [fs.readFileSync(core), fs.readFileSync(bridge)];
  const unrelated = path.join(dir, 'another-nr-addon.addon64');
  fs.writeFileSync(unrelated, 'keep unrelated addon');
  const rows = await f.service.setGameApi(id, 'dx12');
  assert.equal(fs.existsSync(carrier), false);
  assert.deepEqual(fs.readFileSync(core), before[0]);
  assert.deepEqual(fs.readFileSync(bridge), before[1]);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep unrelated addon');
  assert.equal(rows[0].components.dx11Carrier, false);
  assert.equal(rows[0].supported, true);
  assert.equal(rows[0].addonVersion, DX11_COMPAT_VERSION);
  assert.equal((await f.service.boot()).games[0].components.dx11Carrier, false);
  await assert.rejects(f.service.setGameCarrier(id, true), { code: 'ERR_BAD_REQUEST' });
  await f.service.setGameApi(id, 'dx11');
  assert.equal(fs.existsSync(carrier), true, 'saving DX11 prepares the carrier through the repair transaction');
  assert.equal(fs.existsSync(bridge), true);
});

test('historical carrier preference fields are ignored by the automatic API route', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  const key = path.resolve(f.gameDir).toLowerCase(), state = f.service.store.read();
  await f.service.store.write({ gameOverrides: { ...state.gameOverrides, [key]: { api: 'dx11', apiExecutable: f.exe, carrierEnabled: false, carrierExecutable: f.exe } } });
  const game = (await f.service.boot()).games[0]; assert.equal(game.apiOverride, 'dx11'); assert.equal(game.components.dx11Carrier, true);
  assert.equal(Object.hasOwn(f.service.store.read().gameOverrides[key], 'carrierEnabled'), false);
});

test('renaming a game changes only its display name and preserves route bindings', async t => {
  const f = makeService(t);
  await f.service.addManualSelection({ root: f.gameDir, executable: f.exe, name: '旧名称', icon: 'data:image/png;base64,icon' });
  const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx11');
  const before = f.service.store.read();
  const key = path.resolve(f.gameDir).toLowerCase();
  const beforeOverride = before.gameOverrides[key];
  const beforeManualGames = before.manualGames;
  const beforeManualExecutables = before.manualExecutables;
  const rows = await f.service.renameGame(id, '新名称');
  const after = f.service.store.read();
  assert.equal(rows[0].name, '新名称');
  assert.equal(after.gameOverrides[key].name, '新名称');
  assert.equal(after.gameOverrides[key].icon, beforeOverride.icon);
  assert.equal(after.gameOverrides[key].api, beforeOverride.api);
  assert.equal(after.gameOverrides[key].apiExecutable, beforeOverride.apiExecutable);
  assert.deepEqual(after.manualGames, beforeManualGames);
  assert.deepEqual(after.manualExecutables, beforeManualExecutables);
});

test('imported compatibility OTA follows the selected API without mixing package generations', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir, { name: 'Fixture' });
  let boot = await f.service.boot();
  const id = boot.games[0].id;
  const exeDir = path.dirname(f.exe);
  const addonFile = path.join(exeDir, PAYLOAD_FILES.addon);
  const bridgeFile = path.join(exeDir, BRIDGE);
  const carrierFile = path.join(exeDir, CARRIER);

  await f.service.setGameApi(id, 'dx12');
  await f.service.install(id, { version: '0.3.3.5' });
  assert.equal(fs.readFileSync(addonFile, 'utf8'), '0.3.3.5:addon');
  assert.equal(fs.existsSync(bridgeFile), true);
  assert.equal(fs.existsSync(carrierFile), false);

  const packageFile = zip(path.join(f.root, 'compatibility-ota.zip'), dx11Fixture());
  const versions = await f.service.importAddonFile(packageFile);
  const imported = versions.find(item => item.source === 'imported');
  assert.ok(imported);
  assert.match(imported.id, /^imported-[a-f0-9]{12}$/);
  assert.equal(imported.compatibility, 'dx11');
  assert.equal(path.basename(imported.carrierFile), CARRIER);
  assert.match(imported.addonSha256, /^[a-f0-9]{64}$/);
  assert.match(imported.bridgeSha256, /^[a-f0-9]{64}$/);
  assert.match(imported.carrierSha256, /^[a-f0-9]{64}$/);

  await f.service.upgradeAddon(id, imported.id);
  assert.equal(fs.readFileSync(addonFile, 'utf8'), 'dx11-core');
  assert.equal(fs.readFileSync(bridgeFile, 'utf8'), 'matched-bridge');
  assert.equal(fs.existsSync(carrierFile), false, 'DX12 must not deploy the packaged carrier');
  boot = await f.service.boot();
  assert.equal(boot.games[0].addonVersion, imported.id);

  await f.service.setGameApi(id, 'dx11');
  assert.equal(fs.readFileSync(carrierFile, 'utf8'), 'matched-carrier');
  boot = await f.service.boot();
  assert.equal(boot.games[0].addonVersion, imported.id);

  await f.service.setGameApi(id, 'dx12');
  assert.equal(fs.existsSync(carrierFile), false, 'saving DX12 immediately retires the managed carrier');
  assert.equal((await f.service.diagnose(id)).routeMismatch, false);
  await f.service.repair(id, { version: imported.id });
  assert.equal(fs.existsSync(carrierFile), false, 'DX12 repair retires the managed carrier');
  assert.equal(fs.readFileSync(addonFile, 'utf8'), 'dx11-core');
  assert.equal(fs.readFileSync(bridgeFile, 'utf8'), 'matched-bridge');

  const fresh = createAppService({
    userData: path.join(f.root, 'user-data'), resourcesPath: path.join(f.root, 'resources'),
    appDir: f.root, version: '0.4.5',
    overrides: { library: f.library, installer: f.installer, detectGpu: () => ({ family: 'RTX40', series: ['RTX 4070'], vendor: 'NVIDIA' }) }
  });
  const persisted = fresh.listAddonVersions().find(item => item.id === imported.id);
  assert.equal(persisted.compatibility, 'dx11');
  assert.equal(persisted.otaManifest.version, 'beta0.4.5-dx11-compat');
  assert.equal(persisted.otaManifest.sourceCommit, 'd'.repeat(40));
  assert.equal(persisted.otaManifest.includesDx11, true);
  assert.equal(persisted.addonSha256, imported.addonSha256);
  assert.equal(persisted.bridgeSha256, imported.bridgeSha256);
  assert.equal(persisted.carrierSha256, imported.carrierSha256);
  boot = await fresh.boot();
  assert.equal(boot.games[0].addonVersion, imported.id);

  const importedCarrier = path.join(f.root, 'user-data', 'addon-versions', imported.id, CARRIER);
  fs.writeFileSync(importedCarrier, 'tampered-carrier-source');
  const before = { addon: fs.readFileSync(addonFile), bridge: fs.readFileSync(bridgeFile) };
  await assert.rejects(fresh.setGameApi(id, 'dx11'), error =>
    error.code === 'ERR_ADDON_INVALID' && error.details && error.details.reason === 'hash');
  assert.deepEqual(fs.readFileSync(addonFile), before.addon);
  assert.deepEqual(fs.readFileSync(bridgeFile), before.bridge);
  assert.equal(fs.existsSync(carrierFile), false, 'failed validation cannot change the game carrier');
  assert.equal(imported.label, '0.4.5-DX11-兼容增强');
  assert.equal(persisted.label, '0.4.5-DX11-兼容增强');
});

test('the exact D21 OTA enters the component library as one Core plus chain and does not create a legacy archive copy',
  { skip: !fs.existsSync(D21_PACKAGE) }, async t => {
    const componentLibraryRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manager-d21-library-')), 'components');
    t.after(() => fs.rmSync(path.dirname(componentLibraryRoot), { recursive:true, force:true }));
    const f = makeService(t, { componentLibraryRoot });
    const versions = await f.service.importAddonFile(D21_PACKAGE);
    const activeBundle = JSON.parse(fs.readFileSync(path.join(componentLibraryRoot, 'bundle.json'), 'utf8'));
    assert.equal(activeBundle.versions['0.5-dline21']?.coreUpdateOnly, true);
    const d21 = versions.find(row => row.id === '0.5-dline21');
    assert.equal(d21?.ready, true); assert.equal(d21?.source, 'external');
    assert.equal(d21?.coreUpdateOnly, true); assert.equal(d21?.addonOnly, true);
    assert.equal(f.service.store.read().addonVersion, '0.5-dline21');
    assert.equal(fs.existsSync(path.join(f.root, 'user-data', 'addon-versions')), false);
    const inventory = JSON.parse(fs.readFileSync(path.join(componentLibraryRoot, 'inventory.json'), 'utf8'));
    const imported = inventory.packages.find(row => row.id === '0.5-dline21');
    assert.equal(imported.coreUpdateOnly, true);
    assert.deepEqual(imported.files.map(row => row.name).sort(), ['nr-before-sr.zh-CN.addon64','nrchain_nvngx.dll']);
  });


test('failed DX12 transition restores API preference and leaves the changed carrier intact', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx11');
  await f.service.install(id, { version: DX11_COMPAT_VERSION });
  const carrier = path.join(path.dirname(f.exe), DX11_COMPAT_CARRIER);
  fs.writeFileSync(carrier, 'user edit');
  await assert.rejects(f.service.setGameApi(id, 'dx12'), { code: 'ERR_FILE_CHANGED' });
  assert.equal((await f.service.boot()).games[0].apiOverride, 'dx11');
  assert.equal(fs.readFileSync(carrier, 'utf8'), 'user edit');
});

test('auto returns to mixed detection and retires a managed DX11 carrier', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx11');
  await f.service.install(id, { version: DX11_COMPAT_VERSION });
  await f.service.setGameApi(id, 'auto');
  const game = (await f.service.boot()).games[0]; assert.equal(game.apiOverride, 'auto'); assert.equal(game.chosen.detectedApi, 'mixed');
  assert.equal(game.supportCode, 'ERR_API_SELECTION_REQUIRED'); assert.equal(game.components.dx11Carrier, false);
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), DX11_COMPAT_CARRIER)), false);
});

test('an old manifest manual-off flag cannot suppress a later DX11 selection', async t => {
  const f = makeService(t);
  await f.service.addManualGame(f.gameDir);
  const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx11');
  await f.service.install(id, { version: DX11_COMPAT_VERSION });
  await f.installer.disableCarrier({ gameDir: f.gameDir, scan: f.service.gameScan(id), manual: true });
  assert.equal((await f.service.boot()).games[0].components.dx11Carrier, true, 'UI state derives from API rather than old manual-off metadata');
  await f.service.setGameApi(id, 'dx12');
  await f.service.setGameApi(id, 'dx11');
  assert.equal((await f.service.boot()).games[0].components.dx11Carrier, true);
  assert.equal(fs.existsSync(path.join(path.dirname(f.exe), DX11_COMPAT_CARRIER)), true);
});

test('all API choices persist per EXE while detected API remains independent', async t => {
  const f = makeService(t); await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  for (const api of ['dx9', 'dx10', 'dx11', 'dx12', 'vulkan', 'opengl']) {
    await f.service.setGameApi(id, api); const game = (await f.service.boot()).games[0];
    assert.equal(game.apiOverride, api); assert.equal(game.chosen.apiResolution.api, api); assert.equal(game.chosen.detectedApi, 'mixed');
    if (!['dx11', 'dx12'].includes(api)) assert.equal(game.supportCode, api === 'vulkan' ? 'VULKAN_UNAVAILABLE' : 'ERR_UNSUPPORTED_API');
  }
  await f.service.setGameApi(id, 'auto'); const automatic = (await f.service.boot()).games[0];
  assert.equal(automatic.apiOverride, 'auto'); assert.equal(automatic.chosen.apiResolution.api, 'mixed'); assert.equal(automatic.supportCode, 'ERR_API_SELECTION_REQUIRED');
});

test('implicit superseded core selection repairs to replacement but explicit old request is rejected', async t => {
  const f = makeService(t); await f.service.addManualGame(f.gameDir); let game = (await f.service.boot()).games[0]; const id = game.id;
  await f.service.setGameApi(id, 'dx12'); await f.service.install(id, { version: '0.3.3.5' });
  const manifestFile = path.join(f.gameDir, '_DLSS5_Backup', 'xiaofeng-manager.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); manifest.payloadVersion = '0.3.3.4'; fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const bundleFile = path.join(f.payloadDir, 'bundle.json'), bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  bundle.supersededVersions = { '0.3.3.4': '0.3.3.5' }; fs.writeFileSync(bundleFile, JSON.stringify(bundle)); await f.service.refresh();
  const repaired = await f.service.repair(id); assert.deepEqual(repaired.payloadReplacement, { from: '0.3.3.4', to: '0.3.3.5', reason: 'superseded' });
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).payloadVersion, '0.3.3.5');
  manifest.payloadVersion = '0.3.3.4'; fs.writeFileSync(manifestFile, JSON.stringify(manifest)); await f.service.refresh();
  await assert.rejects(f.service.repair(id, { version: '0.3.3.4' }), error => error.code === 'ERR_ADDON_NOT_FOUND' && error.details?.replacementVersion === '0.3.3.5');
  assert.equal(JSON.parse(fs.readFileSync(manifestFile, 'utf8')).payloadVersion, '0.3.3.4');
});

test('proxy-only operation preserves the installed Core and API, and a late occupied destination rejects all writes', async t => {
  const f = makeService(t); await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx12'); await f.service.install(id, { version: '0.3.3.5' });
  const { createOperationPlans } = require('../src/product/operation-plan');
  const manifestFile = path.join(f.gameDir, '_DLSS5_Backup/xiaofeng-manager.json'), before = JSON.parse(fs.readFileSync(manifestFile));
  const core = path.join(path.dirname(f.exe), PAYLOAD_FILES.addon), coreHash = sha256(core);
  const options = { userData: path.join(f.root, 'operations'), service: f.service,
    settings: { assertReady: async () => {} }, components: {}, environment: { assertReady: async () => {} }, preparation: { assertReady: async () => {} },
    guards: { assertGameClosed: async () => {} } };
  const plans = createOperationPlans(options), first = await plans.preview(id, { proxyEntry: 'd3d12' });
  assert.deepEqual(first.steps, [{ kind: 'proxy', entry: 'd3d12' }]); assert.equal(first.blockers.length, 0);
  assert.equal(first.changes[0].action, 'rename-proxy');
  const destination = path.join(path.dirname(f.exe), 'd3d12.dll'); fs.writeFileSync(destination, 'user proxy');
  await assert.rejects(plans.apply(first.planId, { confirm: true, fingerprint: first.fingerprint }), { code: 'OPERATION_CHANGED' });
  assert.equal(sha256(core), coreHash); assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)), before);
  fs.unlinkSync(destination); const retry = await plans.preview(id, { proxyEntry: 'd3d12' });
  await plans.apply(retry.planId, { confirm: true, fingerprint: retry.fingerprint });
  const after = JSON.parse(fs.readFileSync(manifestFile)); assert.equal(after.reshadeRoute, 'd3d12');
  assert.equal(after.payloadVersion, before.payloadVersion); assert.deepEqual(after.files, before.files); assert.equal(after.deploymentApi, 'dx12');
  assert.equal(sha256(core), coreHash); assert.equal((await f.service.boot()).games[0].apiOverride, 'dx12');
});

test('exact repair restores a missing renamed proxy in place while keeping original ownership and plugin exceptions', async t => {
  const f = makeService(t); await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx12'); await f.service.install(id, { version: '0.3.3.5' }); await f.service.applyProxyEntry(id, 'd3d12');
  const manifestFile = path.join(f.gameDir, '_DLSS5_Backup/xiaofeng-manager.json'), before = JSON.parse(fs.readFileSync(manifestFile));
  const destination = path.join(path.dirname(f.exe), 'd3d12.dll'), expected = sha256(destination); fs.unlinkSync(destination);
  const plugin = path.join(path.dirname(f.exe), 'personal.addon64'); fs.writeFileSync(plugin, 'unknown active addon');
  const preview = await f.service.previewRepair(id), choice = preview.addonCompatibility.decisions.find(row => row.path === plugin);
  assert.equal(choice.action, 'isolate'); assert.ok(preview.changes.some(row => row.path === destination && row.action === 'create'));
  const kept = await f.service.previewRepair(id, { addonKeep: [{ path: plugin, sha256: choice.sha256, configFingerprint: choice.configFingerprint }] });
  assert.equal(kept.blockers.length, 0); await f.service.applyRepair(kept.planId);
  assert.equal(sha256(destination), expected); assert.equal(fs.existsSync(path.join(path.dirname(f.exe), 'dxgi.dll')), false);
  const after = JSON.parse(fs.readFileSync(manifestFile)); assert.deepEqual(after.files, before.files); assert.equal(after.reshadeRoute, 'd3d12');
  assert.equal(fs.readFileSync(plugin, 'utf8'), 'unknown active addon');
});

test('automatic input selection requires executable integration evidence rather than a DLSS file candidate', async t => {
  let supported = false;
  const f = makeService(t, { getFeatureEvidence: async () => ({ support: { status: supported ? 'supported' : 'unknown' } }) });
  await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  assert.equal(await f.service.resolveInputRoute(id, { api: 'dx12' }), 'feeder');
  supported = true; assert.equal(await f.service.resolveInputRoute(id, { api: 'dx12' }), 'native');
  assert.equal(await f.service.resolveInputRoute(id, { api: 'dx9' }), 'feeder');
  assert.equal(await f.service.resolveInputRoute(id, { api: 'dx12', route: 'feeder' }), 'feeder');
});

test('component choices explain the same API and input route used by installation', async t => {
  let supported = false;
  const f = makeService(t, { getFeatureEvidence: async () => ({ support: { status: supported ? 'supported' : 'unknown' } }) });
  await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  await f.service.setGameApi(id, 'dx12');
  let choices = await f.service.componentChoices(id);
  assert.equal(choices.stack.api, 'dx12'); assert.equal(choices.stack.route, 'feeder');
  assert.match(choices.stack.title, /DLSS5 Feeder/);
  supported = true; choices = await f.service.componentChoices(id);
  assert.equal(choices.stack.route, 'native'); assert.match(choices.stack.title, /原生 DLSS/);
  assert.match(choices.stack.reason, /不需要 DLSS5 Bridge/);
  await f.service.setGameApi(id, 'dx11'); choices = await f.service.componentChoices(id);
  assert.equal(choices.stack.api, 'dx11'); assert.match(choices.stack.title, /DLSS5 Bridge/);
  assert.equal(choices.stack.manualBridge, true);
});

test('HoYo native operation binds the launcher digest, then installs directly into the dedicated profile without a game proxy', async t => {
  const f = makeService(t, { assertGameClosed: async () => {},
    externalDeploymentOptions: { guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false }, pe: { getImports: () => [] } } });
  const pe = label => { const bytes = Buffer.alloc(0x500); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.write('PE\0\0', 0x80);
    bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(0xf0, 0x94); bytes.writeUInt16LE(0x20b, 0x98); bytes.write(label, 0x300); return bytes; };
  const exe = path.join(path.dirname(f.exe), 'YuanShen.exe'); fs.renameSync(f.exe, exe); fs.writeFileSync(exe, pe('game'));
  for (const row of [f.scan.chosen, ...f.scan.exeCandidates]) { row.path = exe; row.name = 'YuanShen.exe'; row.rel = path.relative(f.gameDir, exe); }
  const launcher = path.join(f.root, 'HYP.exe'); fs.writeFileSync(launcher, pe('launcher'));
  fs.cpSync(path.resolve(__dirname, '../resources/hoyoshade'), path.join(f.root, 'resources/hoyoshade'), { recursive: true });
  const productionLoader = path.resolve(__dirname, '../payload/nr-before-sr/fixed/RTX50/ReShade64.dll');
  if (fs.existsSync(productionLoader)) for (const family of ['RTX40', 'RTX50'])
    fs.copyFileSync(productionLoader, path.join(f.payloadDir, 'fixed', family, 'ReShade64.dll'));
  fs.writeFileSync(path.join(f.payloadDir, 'bundle.json'), JSON.stringify(createCompactBundle(f.payloadDir,
    [{ id: '0.3.3.5', label: 'stable' }, { id: DX11_COMPAT_VERSION, label: 'DX11 fixture', compatibility: 'dx11' }], '0.3.3.5')));
  await f.service.addManualGame(f.gameDir); const id = (await f.service.boot()).games[0].id;
  const { createOperationPlans } = require('../src/product/operation-plan');
  const plans = createOperationPlans({ userData: path.join(f.root, 'operations'), service: f.service,
    settings: { assertReady: async () => {} }, components: {}, environment: { assertReady: async () => {} }, preparation: { assertReady: async () => {} },
    guards: { assertGameClosed: async () => {} } });
  const request = { api: 'dx11', version: DX11_COMPAT_VERSION, route: 'native', loadingBackend: 'hoyoshade', hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: launcher } } };
  const plan = await plans.preview(id, request); assert.equal(plan.blockers.length, 0); assert.equal(plan.resolved.loadingBackend, 'hoyoshade');
  assert.equal(plan.resolved.launcherSha256, sha256(launcher));
  assert.equal(fs.existsSync(path.join(path.dirname(exe), 'dxgi.dll')), false);
  fs.writeFileSync(launcher, pe('updated launcher'));
  await assert.rejects(plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), { code: 'OPERATION_CHANGED' });
  assert.equal(f.service.hoyoProfile(id).installed, false);
  const fresh = await plans.preview(id, request); await plans.apply(fresh.planId, { confirm: true, fingerprint: fresh.fingerprint });
  const profile = f.service.getLayout(id); assert.equal(profile.loadingBackend, 'hoyoshade'); assert.equal(profile.loadingMode, 'helper');
  assert.equal(profile.hoyoProfile.launcher.sha256, sha256(launcher)); assert.equal((await f.service.inspectDeployment(id)).ready, true);
  assert.equal(fs.existsSync(path.join(path.dirname(exe), 'dxgi.dll')), false); assert.equal(fs.existsSync(path.join(path.dirname(exe), PAYLOAD_FILES.addon)), false);
  assert.equal(fs.existsSync(path.join(profile.runtimeDir, PAYLOAD_FILES.addon)), true);
  await f.service.uninstall(id, { mode: 'restore' }); assert.equal(f.service.hoyoProfile(id).installed, false);
  assert.equal(fs.existsSync(exe), true);
});
