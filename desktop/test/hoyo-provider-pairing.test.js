'use strict';

// Opt-in production-service acceptance against an external release manifest.
// Real component bytes are copied and hashed; every game/launcher is inert and
// no launch method, DLL entry point, driver setting or real game path is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAppService } = require('../src/product/app-service');
const { createLibraryService } = require('../src/product/library-service');
const { buildPayload, buildSmallComponents, buildBundledResources } = require('../scripts/stage-manager-distribution.cjs');
const { digestFile } = require('../src/product/launch-safety');
const { HOYO_RECIPE } = require('../src/product/hoyoshade-profiles');
const { RECEIPT: FEEDER_RECEIPT } = require('../src/product/legacy-service');
const { NAMES: CORE_RESOURCES } = require('../src/product/payload-companions');
const unified5 = require('../src/product/unified5-core');

const manifestFile = process.env.DLSS5_TEST_PROVIDER_STAGING;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inertPe(label, level = 'requireAdministrator') {
  const xml = Buffer.from(`<assembly><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`);
  const bytes = Buffer.alloc(0x1000), pe = 0x80, optional = pe + 24, section = optional + 0xf0;
  bytes.write('MZ'); bytes.writeUInt32LE(pe, 0x3c); bytes.write('PE\0\0', pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(0xf0, pe + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x1000, optional + 128); bytes.writeUInt32LE(0xc00, optional + 132);
  bytes.write('.rsrc\0', section); bytes.writeUInt32LE(0xc00, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0xc00, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  for (const [offset, id, target] of [[0, 24, 0x80000020], [0x20, 1, 0x80000040], [0x40, 1033, 0x60]]) {
    bytes.writeUInt16LE(1, 0x200 + offset + 14); bytes.writeUInt32LE(id, 0x200 + offset + 16); bytes.writeUInt32LE(target, 0x200 + offset + 20);
  }
  bytes.writeUInt32LE(0x1100, 0x260); bytes.writeUInt32LE(xml.length, 0x264); xml.copy(bytes, 0x300); bytes.write(label, 0x700);
  return bytes;
}

function snapshot(directory) {
  const rows = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else rows.push([path.relative(directory, file), sha(fs.readFileSync(file))]);
    }
  }
  visit(directory); return rows.sort(([a], [b]) => a.localeCompare(b));
}

async function stageFixture(t) {
  assert.ok(path.isAbsolute(manifestFile), 'external staging manifest must be an absolute caller-supplied path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-provider-pairing-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const stageRoot = path.join(root, 'app');
  const input = { stageRoot, manifest, manifestFile, flavor: 'base' };
  await buildPayload(input); await buildSmallComponents(input); await buildBundledResources(input);
  const payloadDir = path.join(stageRoot, 'payload', 'nr-before-sr'), resourcesPath = path.join(stageRoot, 'resources');
  const source = manifest.runtime.families.RTX50;
  const runtimeSource = fs.realpathSync(path.resolve(path.dirname(manifestFile), source.file));
  assert.equal(fs.statSync(runtimeSource).size, source.bytes); assert.equal(await digestFile(runtimeSource), source.sha256);
  fs.copyFileSync(runtimeSource, path.join(payloadDir, 'fixed', 'RTX50', 'nvngx_dlssnr.dll'));
  assert.equal(await digestFile(path.join(payloadDir, 'fixed', 'RTX50', 'ReShade64.dll')), HOYO_RECIPE.loaderSha256);
  assert.equal(await digestFile(path.join(payloadDir, 'versions', unified5.ID, 'nr-before-sr.zh-CN.addon64')), unified5.HASHES['zh-CN']);
  assert.equal(fs.existsSync(path.join(resourcesPath, 'legacy-runtime')), false, 'no legacy resource pool is available to either route');
  return { root, stageRoot, resourcesPath, payloadDir };
}

async function gameFixture(staged, api) {
  const root = path.join(staged.root, api), gameDir = path.join(root, 'synthetic-game'), exeDir = path.join(gameDir, 'Client');
  fs.mkdirSync(exeDir, { recursive: true });
  const exe = path.join(exeDir, 'ZenlessZoneZero.exe'), launcher = path.join(root, 'HYP.exe');
  fs.writeFileSync(exe, inertPe('inert test EXE; never execute')); fs.writeFileSync(launcher, inertPe('inert test launcher; never execute', 'asInvoker'));
  const personal = path.join(exeDir, 'personal.txt'); fs.writeFileSync(personal, 'unrelated user file');
  const chosen = { path: exe, rel: path.relative(gameDir, exe), name: path.basename(exe), size: fs.statSync(exe).size,
    bitness: 64, api, apiLabel: api, dx12: api === 'dx12', apiResolution: { api }, detectedApiResolution: { api } };
  const scan = { gameDir, gameName: 'Synthetic HoYo service test', chosen, exeCandidates: [chosen], dlssFiles: [], primaryDlss: null,
    emulator: null, reshade: { installed: false } };
  const scanner = { scanGame: async () => structuredClone(scan), selectPrimaryDlss: () => null, inspectReShade: () => ({ installed: false, addonSupport: false }) };
  const library = createLibraryService({ scan: scanner, library: { discover: () => ({ games: [], roots: [] }), dedupe: rows => rows } });
  const featureEvidence = { support: api === 'dx11'
    ? { status: 'unsupported', code: 'SETTINGS_NATIVE_INTEGRATION_NOT_OBSERVED' } : { status: 'supported' } };
  const service = createAppService({ userData: path.join(root, 'user-data'), resourcesPath: staged.resourcesPath, appDir: staged.stageRoot,
    version: require('../package.json').version, overrides: { library, componentLibraryRoot: path.join(root, 'components'),
      detectGpu: () => ({ family: 'RTX50', series: ['RTX50'], vendor: 'NVIDIA', names: ['Synthetic RTX 5090'] }),
      getFeatureEvidence: async () => structuredClone(featureEvidence), assertGameClosed: async () => {},
      externalDeploymentOptions: { guards: { assertGameClosed: async () => {}, antiCheatPresent: () => false } },
      nativeLaunchBroker: { launch: async () => assert.fail('installation must never launch the game') } } });
  await service.addManualGame(gameDir, { executable: exe }); const id = (await service.boot()).games[0].id;
  const request = { api, version: unified5.ID, loadingBackend: 'hoyoshade',
    hoyo: { family: 'zzz', channel: 'cn', launcher: { kind: 'hoyoplay', path: launcher } } };
  return { ...staged, root, service, id, request, gameDir, exeDir, exe, launcher, personal, featureEvidence };
}

async function assertAdapterIntegrity(f, recipe) {
  const root = path.join(f.root, 'components'), inventoryFile = path.join(root, 'inventory.json');
  const original = fs.readFileSync(inventoryFile), inventory = JSON.parse(original);
  const row = inventory.packages.find(item => item.id === recipe.providerPackageId);
  const core = recipe.files.find(item => item.role === 'core'), runtime = recipe.files.find(item => item.role === 'nr-runtime');
  const currentCore = { id: recipe.coreVariant.selected.id, version: recipe.coreVersion, file: core.source, sha256: core.sha256, architecture: 'x64',
    inputInterfaces: ['NRExternalProviderV1'], capabilities: recipe.coreVariant.requiredCapabilities,
    companions: recipe.coreVariant.selected.companions.map(item => ({ ...item, file: item.source })),
    config: { ...recipe.coreVariant.selected.config, file: recipe.coreVariant.selected.config.source } };
  const packages = require('../src/product/external-provider-package').createExternalProviderPackages({ root, currentCore,
    currentRuntime: { file: runtime.source, sha256: runtime.sha256, bytes: runtime.bytes, family: recipe.hardwareFamily } });
  const load = selection => packages.load({ providerId: row.id, selection });
  const described = packages.inspect().packages.find(item => item.id === row.id).routeDescriptors;
  assert.equal(described.find(item => item.id === recipe.providerRouteId).managerAdaptation.compatibilitySource, 'owner-confirmed-2026-09-22');
  const localSelection = { ...recipe.selection, loadingBackend: 'local', routeId: 'dx11-x64-legacy-direct' };
  const local = load(localSelection);
  assert.ok(local.recipe.externalProvider.managerAdaptation);
  assert.equal(local.recipe.files.find(item => item.target.endsWith('/DLSS5_Feed.fx'))?.sha256,
    'cdac08a721b14b97187dd86c5b5bead157c9063d7ee859a0f131a8ee791695f1', 'new local installations include the same fixed shader');
  packages.validateRecipe(local.recipe);
  let oldLocalRecipe;
  try {
    const historical = structuredClone(inventory), historicalRow = historical.packages.find(item => item.id === row.id);
    Object.assign(historicalRow, { source: 'user-imported', verifiedSource: false, immutable: false });
    fs.writeFileSync(inventoryFile, JSON.stringify(historical));
    oldLocalRecipe = load(localSelection).recipe;
    // Disabling the adapter models the old file layout; its historical bundled
    // provenance must still match the restored inventory used for validation.
    oldLocalRecipe.upstream.source = row.source;
    assert.equal(oldLocalRecipe.externalProvider.managerAdaptation, undefined);
    assert.equal(oldLocalRecipe.files.some(item => item.target.endsWith('/DLSS5_Feed.fx')), false);
  } finally { fs.writeFileSync(inventoryFile, original); }
  assert.equal(packages.validateRecipe(oldLocalRecipe), oldLocalRecipe, 'old receipts retain their original file contract after the bundle gains an adapter');
  packages.validateRecipe(recipe);
  for (const mutate of [
    value => { value.externalProvider.managerAdaptation.version++; },
    value => { value.files.find(item => item.role === 'provider').target = 'other.addon64'; },
    value => { value.files = value.files.filter(item => !item.target.endsWith('/DLSS5_Feed.fx')); }
  ]) {
    const forged = structuredClone(recipe); mutate(forged);
    assert.throws(() => packages.validateRecipe(forged), { code: 'EXTERNAL_PROVIDER_RECEIPT' });
  }
  assert.throws(() => packages.load({ providerId: row.id, selection: recipe.selection,
    currentCore: { ...currentCore, capabilities: ['same-frame-output'] } }), { code: 'EXTERNAL_PROVIDER_CORE_INCOMPATIBLE' });
  try {
    for (const index of row.files.keys()) {
      const changed = structuredClone(inventory), file = changed.packages.find(item => item.id === row.id).files[index];
      file.sha256 = '0'.repeat(64); file.file = `objects/${file.sha256}/${path.basename(file.name)}`;
      fs.writeFileSync(inventoryFile, JSON.stringify(changed));
      const inspected = packages.inspect().packages.find(item => item.id === row.id);
      assert.equal((inspected.routeDescriptors || []).some(item => item.loadingBackend === 'hoyoshade'), false, `changed package file cannot gain an adapter: ${file.name}`);
    }
    const withoutShader = structuredClone(inventory);
    for (const item of withoutShader.packages) item.files = item.files.filter(file => file.sha256 !== 'cdac08a721b14b97187dd86c5b5bead157c9063d7ee859a0f131a8ee791695f1');
    fs.writeFileSync(inventoryFile, JSON.stringify(withoutShader));
    assert.throws(() => load(recipe.selection), { code: 'EXTERNAL_PROVIDER_PROFILE_MISSING' });
    assert.throws(() => load(localSelection), { code: 'EXTERNAL_PROVIDER_PROFILE_MISSING' });
    assert.equal(packages.validateRecipe(oldLocalRecipe), oldLocalRecipe, 'the unchanged old local receipt has no new shader dependency');
  } finally { fs.writeFileSync(inventoryFile, original); }
  const shader = recipe.files.find(item => item.target.endsWith('/DLSS5_Feed.fx'));
  const shaderFile = path.join(root, shader.source), shaderBytes = fs.readFileSync(shaderFile);
  try {
    fs.unlinkSync(shaderFile);
    const verifier = require('../src/product/legacy-runtime').createLegacyRuntime({ root: path.join(f.root, 'absent-legacy-pool'), componentLibraryRoot: root });
    await assert.rejects(verifier.verify({ root, recipe, fingerprint: require('../src/product/feeder-runtime').fingerprint(recipe) }),
      error => error.code === 'LEGACY_PACKAGE_HASH' && error.details?.file === shader.source);
  } finally { fs.writeFileSync(shaderFile, shaderBytes); }
  packages.validateRecipe(recipe); assert.deepEqual(fs.readFileSync(inventoryFile), original);
}

test('real staged Provider pairing uses production HoYo and Feeder services without loading payloads', {
  skip: !manifestFile && 'set DLSS5_TEST_PROVIDER_STAGING to an external verified staging manifest', timeout: 180000
}, async t => {
  const times = {}, mark = async (name, operation) => { const started = performance.now(); try { return await operation(); }
    finally { times[name] = Math.round(performance.now() - started); } };
  const staged = await mark('stage', () => stageFixture(t));

  await t.test('DX11 pairs Unified5 with the exact D16-r3 HoYo adaptation, preserves INI on update and restores', async () => {
    const f = await mark('dx11.setup', () => gameFixture(staged, 'dx11')), before = snapshot(f.gameDir);
    assert.equal(await f.service.resolveInputRoute(f.id, f.request), 'feeder');
    const cancelled = await mark('dx11.preview', () => f.service.previewHoYoDeployment(f.id, f.request));
    assert.deepEqual(snapshot(f.gameDir), before, 'preview and abandoning its token write no game files');
    assert.equal(cancelled.route, 'feeder'); assert.equal(cancelled.blockers.length, 0);
    const fresh = await f.service.previewHoYoDeployment(f.id, f.request);
    await mark('dx11.apply', () => f.service.applyHoYoDeployment(fresh.planId, { confirm: true }));
    const receiptFile = path.join(f.gameDir, FEEDER_RECEIPT), receipt = JSON.parse(fs.readFileSync(receiptFile));
    assert.equal(receipt.recipe.providerPackageId, 'feeder-legacy-host-d16-r3');
    assert.equal(receipt.recipe.providerRouteId, 'hoyoshade-dx11-x64-legacy-direct');
    assert.equal(receipt.recipe.coreVersion, unified5.ID); assert.ok(receipt.recipe.externalProvider.managerAdaptation);
    assert.equal(receipt.recipe.acceptance.realGameVerified, false);
    assert.equal(receipt.recipe.files.some(row => row.role === 'game-loader' || row.base === 'game'), false);
    await mark('dx11.adapterIntegrity', () => assertAdapterIntegrity(f, receipt.recipe));
    const layout = f.service.getLayout(f.id); assert.equal(layout.loadingBackend, 'hoyoshade'); assert.equal(layout.inputRoute, 'feeder');
    assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
    assert.equal(await digestFile(layout.loaderPath), HOYO_RECIPE.loaderSha256);
    assert.equal(await digestFile(path.join(layout.nrConfigDir, 'nr-before-sr.zh-CN.addon64')), unified5.HASHES['zh-CN']);
    for (const name of CORE_RESOURCES) assert.equal(fs.existsSync(path.join(layout.nrConfigDir, name)), true, name);
    const feedShader = path.join(layout.runtimeDir, 'reshade-shaders', 'Shaders', 'DLSS5_Feed.fx');
    assert.equal(fs.statSync(feedShader).size, 51193, 'fixed cross-component shader dependency is deployed');
    assert.equal(await digestFile(feedShader), 'cdac08a721b14b97187dd86c5b5bead157c9063d7ee859a0f131a8ee791695f1');
    assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
    const ini = path.join(layout.nrConfigDir, 'nr_before_sr.ini'), feederConfig = path.join(layout.nrConfigDir, 'dlss5-feed.cfg');
    await f.service.writeNrSettings(f.id, { Intensity: 1.234567 });
    fs.appendFileSync(ini, '\n; keep user NR comment\n'); fs.appendFileSync(feederConfig, '\n; keep user feeder comment\n');
    const nrBefore = fs.readFileSync(ini), cfgBefore = fs.readFileSync(feederConfig);
    const update = await f.service.previewHoYoDeployment(f.id, f.request);
    await mark('dx11.update', () => f.service.applyHoYoDeployment(update.planId, { confirm: true }));
    assert.deepEqual(fs.readFileSync(ini), nrBefore); assert.deepEqual(fs.readFileSync(feederConfig), cfgBefore);
    assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
    await mark('dx11.restore', () => f.service.uninstall(f.id, { mode: 'restore' }));
    assert.equal(f.service.hoyoProfile(f.id).installed, false); assert.equal(fs.existsSync(receiptFile), false);
    assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
    for (const [name, hash] of before) assert.equal(await digestFile(path.join(f.gameDir, name)), hash);
  });

  await t.test('DX12 with confirmed native DLSS chooses native HoYo without a legacy pool; absent DLSS retains Feeder', async () => {
    const f = await mark('dx12.setup', () => gameFixture(staged, 'dx12')), before = snapshot(f.gameDir);
    f.featureEvidence.support = { status: 'unsupported', code: 'SETTINGS_NATIVE_INTEGRATION_NOT_OBSERVED' };
    assert.equal(await f.service.resolveInputRoute(f.id, f.request), 'feeder', 'Present-capable Core must not replace the Feeder fallback when native DLSS is absent');
    f.featureEvidence.support = { status: 'supported' };
    assert.equal(await f.service.resolveInputRoute(f.id, f.request), 'native', 'confirmed native DLSS takes priority over Feeder');
    const plan = await f.service.previewHoYoDeployment(f.id, f.request);
    assert.equal(plan.route, 'native'); assert.deepEqual(plan.phases, ['hoyoshade-profile']);
    assert.deepEqual(snapshot(f.gameDir), before);
    await mark('dx12.apply', () => f.service.applyHoYoDeployment(plan.planId, { confirm: true }));
    const layout = f.service.getLayout(f.id); assert.equal(layout.inputRoute, 'native');
    assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
    assert.equal(fs.existsSync(path.join(f.gameDir, FEEDER_RECEIPT)), false);
    assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
    assert.equal(await digestFile(path.join(layout.nrConfigDir, 'nr-before-sr.zh-CN.addon64')), unified5.HASHES['zh-CN']);
    await mark('dx12.restore', () => f.service.uninstall(f.id, { mode: 'restore' }));
    assert.equal(f.service.hoyoProfile(f.id).installed, false);
    for (const [name, hash] of before) assert.equal(await digestFile(path.join(f.gameDir, name)), hash);
  });
  t.diagnostic(JSON.stringify({ scope: 'production AppService/HoYo/Feeder/installer journals; real staged component bytes; inert game and launcher; no payload execution',
    timingsMs: times, actualGameValidation: false }));
});
