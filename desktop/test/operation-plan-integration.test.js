'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { fixture, peBytes, put, hashFile, sha, PROJECT, INSTALLED_NAMES, PAYLOAD_FILES, DX11_COMPAT_CARRIER } = require('./helpers/operation-integration-fixture');
const { createOperationPlans } = require('../src/product/operation-plan');
const { readManifest } = require('../src/product/manifest');
const { PENDING } = require('../src/product/external-runtime');
const journal = require('../src/core/file-journal');
const { ADDON: MFG_ADDON, SHA256: MFG_SHA, providerById } = require('../src/product/fg-mfgunlock-resources');
const { specialFixture } = require('./helpers/operation-special-fixture');
const { enhancementEvidence } = require('./helpers/enhancement-evidence');

const confirm = plan => ({ confirm: true, fingerprint: plan.fingerprint });
const installedHashes = f => Object.fromEntries(Object.entries(INSTALLED_NAMES).map(([kind, name]) => [kind, hashFile(path.join(f.exeDir, name))]));

for (const deployment of ['local', 'external']) test(`implicit superseded Core defaults stay consistent through preview and ${deployment} Apply`, async t => {
  const f = await fixture(t), bundleFile = path.join(f.payload, 'bundle.json');
  const bundle = JSON.parse(fs.readFileSync(bundleFile)); bundle.supersededVersions = { 'legacy-global-core': 'fixture-core-2' };
  put(bundleFile, JSON.stringify(bundle)); await f.service.store.write({ addonVersion: 'legacy-global-core' });
  const defaults = f.service.installationDefaults(f.id);
  assert.equal(defaults.version, 'fixture-core-2'); assert.equal(defaults.deployment, 'local'); assert.equal(defaults.loadingMode, 'proxy');
  const requests = [], originalPreview = f.service.previewDeployment;
  f.service.previewDeployment = async (id, request, internal) => { requests.push(structuredClone(request)); return originalPreview(id, request, internal); };
  const preview = await f.plans.preview(f.id, { api: 'dx12', ...(deployment === 'external' ? { deployment } : {}) });
  assert.equal(Object.hasOwn(preview.request, 'version'), false);
  assert.equal(preview.resolved.version, defaults.version);
  assert.equal(preview.resolved.deployment, deployment); assert.equal(preview.resolved.loadingMode, defaults.loadingMode);
  await f.plans.apply(preview.planId, confirm(preview));
  assert.equal(f.layout().mode, deployment); assert.equal(f.layout().version, defaults.version);
  assert.equal(hashFile(path.join(f.layout().runtimeDir, INSTALLED_NAMES.addon)), hashFile(path.join(f.payload, 'versions/fixture-core-2', PAYLOAD_FILES.addon)));
  assert.ok(requests.every(request => !Object.hasOwn(request, 'version')), 'only a user-supplied version is sent as an explicit selection');
  if (deployment === 'external') assert.ok(requests.length >= 2);
});

for (const route of ['vulkan', 'feeder']) test(`OperationPlan ${route} fixed route recompiles the same file effects and restores through its real owner`, async t => {
  const f = await specialFixture(t, route);
  const request = { route, api: route === 'vulkan' ? 'vulkan' : 'dx12', version: f.special.packageId, deployment: route === 'vulkan' ? 'external' : 'local' };
  const first = await f.plans.preview(f.id, request), second = await f.plans.preview(f.id, request);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.ok(first.changes.some(row => row.path.endsWith('core.addon64')));
  assert.equal(fs.existsSync(path.join(f.exeDir, 'ReShade.ini')), false);
  assert.equal(readManifest(f.gameRoot), null);
  if (route === 'vulkan') { assert.equal(f.special.registry.size, 0); assert.equal(f.special.writes.length, 0); }
  assert.equal((await f.plans.apply(first.planId, confirm(first))).applied, true);
  const current = (await f.service.listGames())[0]; assert.equal(current[route].installed, true);
  const seed = f.service.assessmentSeed(f.id), defaults = f.service.installationDefaults(f.id);
  assert.equal(seed[route].installed, true); assert.equal(seed[route].packageId, f.special.packageId);
  assert.equal(defaults.deployment, route === 'vulkan' ? 'external' : 'local');
  assert.equal(f.service.getLayout(f.id).mode, defaults.deployment, 'the installation summary and its fixed owner use the same deployment mode');
  assert.equal(readManifest(f.gameRoot), null, 'a fixed route never installs the independent ordinary payload');
  if (route === 'vulkan') assert.equal(f.special.registry.size, 1);
  const repair = await f.plans.preview(f.id, request);
  assert.equal((await f.plans.preview(f.id, request)).fingerprint, repair.fingerprint);
  assert.equal((await f.plans.apply(repair.planId, confirm(repair))).applied, true);
  const removal = await f.plans.preview(f.id, { uninstall: 'restore' });
  assert.equal((await f.plans.preview(f.id, { uninstall: 'restore' })).fingerprint, removal.fingerprint);
  await f.plans.apply(removal.planId, confirm(removal));
  assert.equal((await f.service.listGames())[0][route].installed, false);
  assert.equal(fs.existsSync(path.join(f.exeDir, 'ReShade.ini')), false);
  if (route === 'vulkan') assert.equal(f.special.registry.size, 0);
});

test('OperationPlan recovery cannot clear its ledger while an interrupted Vulkan owner still has a layer WAL', async t => {
  const f = await specialFixture(t, 'vulkan');
  const preview = await f.plans.preview(f.id, { route: 'vulkan', api: 'vulkan', version: f.special.packageId, deployment: 'external' });
  f.special.control.failRegistryOnce = true;
  await assert.rejects(f.plans.apply(preview.planId, confirm(preview)), error => error.details.recoveryRequired === true);
  const wal = path.join(f.userData, 'vulkan-deployment/pending.json'); assert.equal(fs.existsSync(wal), true);
  const restarted = createOperationPlans(f.planOptions);
  const result = await restarted.recover(f.id);
  assert.equal(result.recovered, true);
  assert.equal(fs.existsSync(wal), false, 'the deployment owner must recover before the unified ledger reports success');
  assert.equal(f.special.registry.size, 0); assert.equal((await restarted.inspect(f.id)).pending, false);
  assert.equal((await f.service.listGames())[0].vulkan.needsRecovery, false);
});

test('OperationPlan recovery routes an interrupted Feeder copy to its original fixed-package owner', async t => {
  const f = await specialFixture(t, 'feeder');
  const preview = await f.plans.preview(f.id, { route: 'feeder', api: 'dx12', version: f.special.packageId, deployment: 'local' });
  f.special.control.failCopyOnce = true;
  await assert.rejects(f.plans.apply(preview.planId, confirm(preview)), error => error.details.recoveryRequired === true);
  const wal = journal.pendingPath(f.gameRoot); assert.equal(fs.existsSync(wal), true);
  const restarted = createOperationPlans(f.planOptions);
  assert.equal((await restarted.recover(f.id)).recovered, true);
  assert.equal(fs.existsSync(wal), false); assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
  assert.equal((await restarted.inspect(f.id)).pending, false);
  assert.equal((await f.service.listGames())[0].feeder.needsRecovery, false);
});

for (const api of ['dx11', 'dx12']) test(`OperationPlan ${api} installs then moves a complete profile through external, ordinary and Helper`, async t => {
  const f = await fixture(t, { api });
  const immutable = ['Game.exe', 'nvngx_dlss.dll', 'nvngx_dlssg.dll', 'unknown.dll.bak'];
  const original = Object.fromEntries(immutable.map(name => [name, hashFile(path.join(f.exeDir, name))]));
  await f.apply({ api, version: 'fixture-core-1', deployment: 'local' });
  const ordinary = installedHashes(f);
  put(path.join(f.exeDir, 'PersonalPreset.ini'), 'personal preset');
  fs.appendFileSync(path.join(f.exeDir, 'ReShade.ini'), '\r\n[SCREENSHOT]\r\nSavePath=.\\shots\r\n[User]\r\nValue=42\r\n');
  const localIni = fs.readFileSync(path.join(f.exeDir, 'ReShade.ini'));
  for (const loadingMode of ['proxy', 'helper']) {
    const preview = await f.plans.preview(f.id, { api, deployment: 'external', loadingMode });
    const repeated = await f.plans.preview(f.id, preview.request);
    assert.equal(repeated.fingerprint, preview.fingerprint, 'fresh owner metadata cannot invalidate an unchanged user-reviewed plan');
    assert.deepEqual(installedHashes(f), ordinary, 'preview leaves the installed ordinary files intact');
    const applied = await f.plans.apply(preview.planId, confirm(preview)); assert.equal(applied.runtimeVerified, false);
    const layout = f.layout(); assert.equal(layout.mode, 'external'); assert.equal(layout.loadingMode, loadingMode);
    assert.equal(hashFile(path.join(layout.runtimeDir, INSTALLED_NAMES.addon)), ordinary.addon);
    assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), false);
    assert.match(fs.readFileSync(layout.activeConfigPath, 'utf8'), /Value=42/);
    if (loadingMode === 'helper') {
      assert.equal(hashFile(layout.loaderPath), ordinary.reshade); assert.equal(fs.existsSync(path.join(f.exeDir, 'dxgi.dll')), false);
    }
    await f.apply({ api, deployment: 'local' });
    assert.equal(f.layout().mode, 'local'); assert.deepEqual(installedHashes(f), ordinary);
    assert.deepEqual(fs.readFileSync(path.join(f.exeDir, 'ReShade.ini')), localIni);
  }
  for (const name of immutable) assert.equal(hashFile(path.join(f.exeDir, name)), original[name]);
  assert.equal((await f.plans.inspect(f.id)).pending, false);
});

test('OperationPlan applies a simultaneous native SR, official FG and NR draft through the real settings receipt', async t => {
  const f = await fixture(t, { family: 'RTX50' });
  const request = { api: 'dx12', version: 'fixture-core-1', deployment: 'local', nr: { Intensity: 1.6 },
    sr: { backend: 'native', quality: 'quality', preset: 'K' }, fg: { backend: 'nvidia', mode: 'fixed', multiplier: 3 } };
  const before = f.driver.peek(), preview = await f.plans.preview(f.id, request);
  assert.deepEqual(f.driver.peek(), before); assert.equal(readManifest(f.gameRoot), null);
  const applied = await f.plans.apply(preview.planId, confirm(preview));
  assert.deepEqual(applied.stages.map(row => row.kind), ['deployment', 'nr', 'sr', 'fg']);
  const settings = await f.settings.inspect(f.id);
  assert.equal(settings.applied.sr.request.preset, 'K'); assert.equal(settings.applied.fg.request.multiplier, 3);
  assert.equal(settings.applied.sr.readbackVerified, true); assert.equal(settings.applied.fg.readbackVerified, true);
  assert.notDeepEqual(f.driver.peek(), before); assert.equal(f.events.filter(row => row === 'driver-write').length, 2);
  assert.equal((await f.service.readNrSettings(f.id)).Intensity, 1.6);
});

test('OperationPlan migration preserves the selected MFG provider and current game-menu multiplier in both layouts', async t => {
  const f = await fixture(t, { family: 'RTX40', components: { getFeatureEvidence: async () => enhancementEvidence() } });
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  const selection = { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 }, active = { ...selection, multiplier: 4 };
  const provider = providerById('mfgunlock-0.9');
  assert.notEqual(provider.sha256, MFG_SHA, '0.9 remains a distinct fallback while 1.0 is the new default');
  await f.apply({ fg: selection, components: { mfgUnlock: provider.id } });
  assert.equal(hashFile(path.join(f.exeDir, MFG_ADDON)), provider.sha256);
  const config = f.layout().activeConfigPath;
  put(config, fs.readFileSync(config, 'utf8').replace('ForceMultiplier=3', 'ForceMultiplier=4'));
  assert.deepEqual((await f.settings.inspect(f.id)).current.fg.request, active);
  const firstReceipt = f.components.receiptFile(f.id); assert.equal(fs.existsSync(firstReceipt), true);
  f.events.length = 0;
  const applied = await f.apply({ deployment: 'external' });
  assert.deepEqual(applied.result.stages.map(row => row.kind), ['restore-fg', 'deployment', 'fg']);
  assert.ok(f.events.indexOf('settings-restore-fg') < f.events.indexOf('components-restore'));
  assert.ok(f.events.indexOf('components-restore') < f.events.indexOf('components-prepare'));
  const layout = f.layout(); assert.equal(hashFile(path.join(layout.addonDirectory, MFG_ADDON)), provider.sha256);
  assert.equal(fs.existsSync(path.join(f.exeDir, MFG_ADDON)), false); assert.equal(fs.existsSync(firstReceipt), false);
  assert.deepEqual((await f.settings.inspect(f.id)).current.fg.request, active);
  assert.deepEqual((await f.settings.inspect(f.id)).applied.fg.request, active);
  assert.equal((await f.components.inspect(f.id)).installedProvider, provider.id);
  await f.apply({ deployment: 'local' });
  assert.equal(hashFile(path.join(f.exeDir, MFG_ADDON)), provider.sha256);
  assert.equal((await f.components.inspect(f.id)).installedProvider, provider.id);
  assert.deepEqual((await f.settings.inspect(f.id)).current.fg.request, active);
  assert.deepEqual((await f.settings.inspect(f.id)).applied.fg.request, active);
});

for (const mode of ['clean', 'restore']) test(`OperationPlan ${mode} uninstall from an external profile preserves unrelated files and its original owner backup`, async t => {
  const f = await fixture(t), originalChain = peBytes('pre-install original chain');
  put(path.join(f.exeDir, INSTALLED_NAMES.bridge), originalChain);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  await f.apply({ deployment: 'external', loadingMode: mode === 'clean' ? 'proxy' : 'helper' });
  const preview = await f.plans.preview(f.id, { uninstall: mode });
  const chain = preview.changes.find(row => row.path === path.join(f.exeDir, INSTALLED_NAMES.bridge) && row.phase === 'uninstall');
  assert.equal(chain.afterSha256, mode === 'restore' ? sha(originalChain) : null);
  await f.plans.apply(preview.planId, confirm(preview));
  assert.equal(hashFile(path.join(f.exeDir, INSTALLED_NAMES.bridge)), mode === 'restore' ? sha(originalChain) : null);
  assert.equal(fs.existsSync(path.join(f.exeDir, INSTALLED_NAMES.addon)), false);
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'unknown.dll.bak'), 'utf8'), 'unrelated backup');
  assert.equal(readManifest(f.gameRoot), null);
});

test('OperationPlan owner recovery clears a genuinely interrupted external file transaction and keeps completed settings visible', async t => {
  let interrupt = false;
  const f = await fixture(t, { external: { afterWrite: ({ row }) => {
    if (interrupt && row.after === null && path.basename(row.file) === INSTALLED_NAMES.addon) {
      interrupt = false; throw Object.assign(new Error('simulated process exit after local Core removal'), { preservePending: true });
    }
  } } });
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local', nr: { Intensity: 1.4 } });
  const original = installedHashes(f); interrupt = true;
  const preview = await f.plans.preview(f.id, { deployment: 'external' });
  await assert.rejects(f.plans.apply(preview.planId, confirm(preview)), error => error.preservePending === true && error.details.recoveryRequired === true);
  assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), true); assert.equal((await f.plans.inspect(f.id)).pending, true);
  const restarted = createOperationPlans(f.planOptions);
  assert.equal((await restarted.recover(f.id)).recovered, true);
  assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false); assert.equal((await restarted.inspect(f.id)).pending, false);
  assert.deepEqual(installedHashes(f), original); assert.equal((await f.service.readNrSettings(f.id)).Intensity, 1.4);
});

test('OperationPlan recovery dispatches an interrupted MFG file WAL to the FG owner before clearing its ledger', async t => {
  let interrupt = true;
  const f = await fixture(t, { family: 'RTX40', components: { getFeatureEvidence: async () => enhancementEvidence(), copyFile: async (...args) => {
    await fsp.copyFile(...args);
    if (interrupt && path.basename(args[1]) === MFG_ADDON) {
      interrupt = false; throw Object.assign(new Error('simulated process exit after first MFG addon copy'), { preservePending: true });
    }
  } } });
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  const originalDriver = f.driver.peek(), preview = await f.plans.preview(f.id, { fg: { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 } });
  await assert.rejects(f.plans.apply(preview.planId, confirm(preview)), error => error.details.recoveryRequired === true);
  const pending = journal.pendingPath(f.gameRoot); assert.equal(fs.existsSync(pending), true);
  assert.equal(JSON.parse(fs.readFileSync(pending)).owner.product, 'xiaofeng-fg-components');
  assert.equal(hashFile(path.join(f.exeDir, MFG_ADDON)), MFG_SHA);
  const restarted = createOperationPlans(f.planOptions); assert.equal((await restarted.recover(f.id)).recovered, true);
  assert.equal(fs.existsSync(pending), false); assert.equal(fs.existsSync(path.join(f.exeDir, MFG_ADDON)), false);
  assert.equal((await restarted.inspect(f.id)).pending, false); assert.deepEqual(f.driver.peek(), originalDriver);
  assert.ok(f.events.includes('components-recover'));
});

test('BG3 refuses a newer Bridge, preserves its explicit 1.4.11 pin across Core selection, and restores cleanly', async t => {
  const f = await fixture(t, { api: 'dx11', exeName: 'bg3_dx11.exe' });
  const { ID, OLD_BRIDGE, CURRENT_BRIDGE } = require('../scripts/prepare-bg3-bridge-comparison');
  assert.equal(OLD_BRIDGE, '73d438ee9427e73d9919d169a107c7f5d73f60b291ea2cd66bd33279a35d3e95', 'issue #224 original attachment identity');
  assert.equal(CURRENT_BRIDGE, '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86', 'the pinned 1.4.12 baseline identity');
  const source = process.env.DLSS5_TEST_LEGACY_PAYLOAD_ROOT
    ? path.resolve(process.env.DLSS5_TEST_LEGACY_PAYLOAD_ROOT) : path.join(PROJECT, 'payload/nr-before-sr');
  if (!fs.existsSync(path.join(source, 'bundle.json'))) return t.skip('optional pinned BG3 payload fixture is unavailable');
  const catalog = JSON.parse(fs.readFileSync(path.join(source, 'bundle.json')));
  assert.ok(catalog.versions[ID], 'the prepared issue #224 comparison payload must exist');
  assert.equal(catalog.versions['0.4.7beta'].files[DX11_COMPAT_CARRIER], CURRENT_BRIDGE);
  assert.equal(catalog.versions[ID].files[DX11_COMPAT_CARRIER], OLD_BRIDGE);
  const differing = Object.keys(catalog.versions['0.4.7beta'].files).filter(name => catalog.versions['0.4.7beta'].files[name] !== catalog.versions[ID].files[name]);
  assert.deepEqual(differing, [DX11_COMPAT_CARRIER]);
  await f.service.selectPayloadSource(source);
  const original = installedHashes(f);
  await assert.rejects(f.plans.preview(f.id, { api: 'dx11', version: '0.4.7beta', deployment: 'local' }),
    error => error.code === 'COMPONENT_GAME_PIN');
  assert.deepEqual(installedHashes(f), original, 'rejecting the newer default Bridge cannot modify the game');
  assert.equal(readManifest(f.gameRoot), null);
  const installed = await f.apply({ api: 'dx11', version: '0.4.7beta', deployment: 'local', components: { bridge: 'nigos-1.4.11-nr' } });
  assert.equal(installed.result.runtimeVerified, false);
  assert.equal(readManifest(f.gameRoot).payloadVersion, '0.4.7beta');
  const comparison = installedHashes(f);
  assert.equal(comparison.carrier, OLD_BRIDGE);
  assert.equal(fs.statSync(path.join(f.exeDir, DX11_COMPAT_CARRIER)).size, 513024);
  await f.apply({ api: 'dx11', version: '0.4.7beta', deployment: 'local' });
  assert.deepEqual(installedHashes(f), comparison, 'selecting the Core preserves the independently pinned 1.4.11 Bridge');
  await assert.rejects(f.plans.preview(f.id, { components: { bridge: 'nigos-1.4.12-nr' } }),
    error => error.code === 'COMPONENT_GAME_PIN');
  assert.equal(readManifest(f.gameRoot).payloadVersion, '0.4.7beta');
  assert.deepEqual(installedHashes(f), comparison, 'even an explicit newer Bridge selection must respect the game exception');
  await f.apply({ uninstall: 'restore' });
  for (const name of Object.values(INSTALLED_NAMES).filter(name => name !== INSTALLED_NAMES.config)) assert.equal(fs.existsSync(path.join(f.exeDir, name)), false);
  assert.equal(hashFile(path.join(f.exeDir, 'nvngx_dlss.dll')), sha(peBytes('original native DLSS')));
});
