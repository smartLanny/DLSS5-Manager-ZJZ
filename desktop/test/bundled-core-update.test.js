'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, peBytes, put, hashFile, sha, PROJECT, INSTALLED_NAMES, PAYLOAD_FILES } = require('./helpers/operation-integration-fixture');
const { createCompactBundle } = require('../src/product/payload');
const { readManifest } = require('../src/product/manifest');
const { createExternalRuntime } = require('../src/product/external-runtime');
const { createHoYoProfileService } = require('../src/product/hoyoshade-profile');

const BASE = 'fixture-core-1';
const D13 = '0.5-dline13';
const CORE_FIX8 = '0.4.7beta-corefix.8';
const UPDATES = [D13, CORE_FIX8];
const confirm = plan => ({ confirm: true, fingerprint: plan.fingerprint });

function walk(root, current = root, rows = []) {
  if (!fs.existsSync(current)) return rows;
  const stat = fs.lstatSync(current), rel = path.relative(root, current).replaceAll(path.sep, '/');
  if (stat.isSymbolicLink()) { rows.push([rel, 'link', fs.readlinkSync(current)]); return rows; }
  if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) walk(root, path.join(current, name), rows);
  else rows.push([rel, 'file', fs.readFileSync(current).toString('base64')]);
  return rows;
}

function customizePayload(resourcesPath) {
  const payload = path.join(resourcesPath, 'payload', 'nr-before-sr');
  const entries = [
    { id: BASE, label: 'fixture base', compatibility: 'dx11' },
    { id: 'fixture-core-2', label: 'fixture alternate', compatibility: 'dx11' },
    { id: D13, label: 'beta0.5 D13', compatibility: null, coreUpdateOnly: true, ota: true },
    { id: CORE_FIX8, label: 'beta0.4.7 corefix.8', compatibility: null, coreUpdateOnly: true, ota: true }
  ];
  for (const version of UPDATES) {
    put(path.join(payload, 'versions', version, PAYLOAD_FILES.addon), peBytes(`${version}: unique Core`));
    put(path.join(payload, 'versions', version, PAYLOAD_FILES.bridge), peBytes(`${version}: matched chain`));
    put(path.join(payload, 'versions', version, PAYLOAD_FILES.config), `[NRBeforeSR]\r\nEnabled=1\r\nIntensity=${version === D13 ? '1.3' : '1.8'}\r\nVersionMarker=${version}\r\n`);
  }
  const original = JSON.parse(fs.readFileSync(path.join(payload, 'bundle.json'), 'utf8'));
  put(path.join(payload, 'bundle.json'), JSON.stringify(createCompactBundle(payload, entries, original.defaultVersion)));
  return { payload, defaultVersion: original.defaultVersion };
}

async function coreFixture(t, options = {}) {
  let catalog;
  const f = await fixture(t, {
    api: options.api || 'dx12',
    specialSetup: async ({ resourcesPath }) => {
      catalog = customizePayload(resourcesPath);
      return {};
    },
    ...(options.fixture || {})
  });
  return { ...f, catalog };
}

async function hoyoCoreFixture(t) {
  let catalog, launcher, external, hoyo;
  const f = await fixture(t, {
    api: 'dx12', exeName: 'YuanShen.exe',
    specialSetup: async ({ root, userData, resourcesPath, guards, pe }) => {
      const loader = fs.readFileSync(path.join(PROJECT, 'payload', 'nr-before-sr', 'fixed', 'RTX50', 'ReShade64.dll'));
      for (const family of ['RTX40', 'RTX50']) put(path.join(resourcesPath, 'payload', 'nr-before-sr', 'fixed', family, 'ReShade64.dll'), loader);
      catalog = customizePayload(resourcesPath);
      put(path.join(resourcesPath, 'hoyoshade', 'component.json'), fs.readFileSync(path.join(PROJECT, 'resources', 'hoyoshade', 'component.json')));
      launcher = path.join(root, 'HYP.exe'); put(launcher, peBytes('fixture HoYo launcher; never launched'));
      external = createExternalRuntime({ userData, pe, guards });
      hoyo = createHoYoProfileService({ userData, resourcesPath, appDir: root, externalRuntime: external, pe });
      return { overrides: { hoyo, externalDeployment: external }, launcher, external, hoyo };
    }
  });
  return { ...f, catalog, launcher, external, hoyo };
}

function layoutFiles(f) {
  const layout = f.service.getLayout(f.id);
  const root = layout.runtimeDir || f.exeDir;
  return {
    layout,
    addon: path.join(root, INSTALLED_NAMES.addon),
    bridge: path.join(root, INSTALLED_NAMES.bridge),
    runtime: path.join(root, INSTALLED_NAMES.runtime),
    reshade: layout.loaderPath || layout.proxyPaths?.[0] || path.join(root, INSTALLED_NAMES.reshade),
    config: layout.activeConfigPath || path.join(root, INSTALLED_NAMES.config),
    carrier: path.join(root, INSTALLED_NAMES.carrier),
    nr: path.join(layout.nrConfigDir || root, INSTALLED_NAMES.config)
  };
}

function coreHash(f, version, kind) {
  return hashFile(path.join(f.payload, 'versions', version, PAYLOAD_FILES[kind]));
}

function assertPreserved(f, expected, message) {
  const files = layoutFiles(f);
  assert.deepEqual(fs.readFileSync(files.config), expected.config, `${message}: user INI`);
  assert.deepEqual(fs.readFileSync(files.reshade), expected.reshade, `${message}: ReShade`);
  assert.deepEqual(fs.readFileSync(files.runtime), expected.runtime, `${message}: runtime`);
  assert.equal(fs.existsSync(files.carrier), false, `${message}: DX12 has no carrier`);
}

async function applyCore(f, version, deployment, extra = {}) {
  const request = { api: 'dx12', version, deployment, ...extra };
  const preview = await f.plans.preview(f.id, request);
  assert.deepEqual(preview.blockers, [], `${deployment}/${version} preview blockers`);
  const result = await f.plans.apply(preview.planId, confirm(preview));
  const files = layoutFiles(f), manifest = readManifest(f.gameRoot);
  assert.equal(files.layout.version, version, `${deployment}/${version} layout version`);
  assert.equal(hashFile(files.addon), coreHash(f, version, 'addon'), `${deployment}/${version} Core bytes`);
  assert.equal(hashFile(files.bridge), coreHash(f, version, 'bridge'), `${deployment}/${version} chain bytes`);
  assert.equal(fs.existsSync(files.carrier), false, `${deployment}/${version} does not install a carrier`);
  if (deployment === 'local') {
    assert.equal(manifest?.payloadVersion, version, `${deployment}/${version} manifest version`);
    assert.equal(manifest?.deploymentApi, 'dx12');
    assert.equal(manifest?.files.some(row => row.kind === 'carrier'), false);
  }
  return { preview, result, files, manifest };
}

test('bundled Core update refuses an uninstalled target without writing files', async t => {
  const f = await coreFixture(t), before = walk(f.gameRoot);
  await assert.rejects(f.plans.preview(f.id, { api: 'dx12', version: D13, deployment: 'local' }), { code: 'CORE_UPDATE_BASE_REQUIRED' });
  assert.deepEqual(walk(f.gameRoot), before);
  assert.equal((await f.plans.inspect(f.id)).pending, false);
});

test('bundled Core update refuses DX11 until a real DX12 baseline is deployed', async t => {
  const f = await coreFixture(t, { api: 'dx11' });
  await f.apply({ api: 'dx11', version: BASE, deployment: 'local' });
  const before = walk(f.gameRoot);
  for (const api of ['dx11', 'dx12']) {
    await assert.rejects(f.plans.preview(f.id, { api, version: D13, deployment: 'local' }), { code: 'CORE_UPDATE_BASE_REQUIRED' });
    assert.deepEqual(walk(f.gameRoot), before, `DX11 installation remains unchanged after ${api} refusal`);
  }
  await f.apply({ api: 'dx12', version: BASE, deployment: 'local' });
  const accepted = await f.plans.preview(f.id, { api: 'dx12', version: D13, deployment: 'local' });
  assert.deepEqual(accepted.blockers, []);
});

for (const deployment of ['local', 'external']) test(`bundled Core update keeps the ${deployment} install byte-stable around base → D13 → corefix8 → base`, async t => {
  const f = await coreFixture(t), initial = await f.apply({ api: 'dx12', version: BASE, deployment, ...(deployment === 'external' ? { loadingMode: 'proxy' } : {}) });
  const initialFiles = layoutFiles(f);
  fs.appendFileSync(initialFiles.config, `\r\n[User]\r\nPreserve=${deployment}\r\n`);
  fs.appendFileSync(initialFiles.nr, '\r\nNRPasses=7\r\nSecondScale=0.77\r\n');
  const expected = { config: fs.readFileSync(initialFiles.config), reshade: fs.readFileSync(initialFiles.reshade), runtime: fs.readFileSync(initialFiles.runtime) };
  const catalog = JSON.stringify(f.service.coreVersionCatalog());
  for (const [index, version] of UPDATES.entries()) {
    const extra = index === 0 ? { nr: { TransferStrength: 0.4, CustomWorkScale: 0.25 } } : {};
    const preview = await f.plans.preview(f.id, { api: 'dx12', version, deployment, ...extra });
    if (index === 0) {
      assert.equal(preview.request.nr.TransferStrength, 1);
      assert.equal(preview.request.nr.CustomWorkScale, 0.5);
      assert.ok(preview.changes.some(row => row.key === 'TransferStrength' && row.value === 1));
      assert.ok(preview.changes.some(row => row.key === 'CustomWorkScale' && row.value === 0.5));
    }
    assert.deepEqual(preview.blockers, []);
    await f.plans.apply(preview.planId, confirm(preview));
    assertPreserved(f, expected, `${deployment}/${version}`);
    if (index === 0) {
      const nrText = fs.readFileSync(layoutFiles(f).nr, 'utf8');
      assert.match(nrText, /NRPasses=7/); assert.match(nrText, /SecondScale=0\.77/);
      const nr = await f.service.readNrSettings(f.id);
      assert.equal(nr.TransferStrength, 1); assert.equal(nr.CustomWorkScale, 0.5);
    }
  }
  await applyCore(f, BASE, deployment);
  assertPreserved(f, expected, `${deployment}/${BASE}`);
  assert.equal(JSON.stringify(f.service.coreVersionCatalog()), catalog, `${deployment} catalog/default remain unchanged`);
  assert.deepEqual(f.events.filter(row => row === 'driver-write'), []);
  assert.equal(initial.result.runtimeVerified, false);
});

test('tampered bundled Core or matched chain is rejected before replacing the old installation', async t => {
  for (const kind of ['addon', 'bridge']) {
    const f = await coreFixture(t);
    await f.apply({ api: 'dx12', version: BASE, deployment: 'local' });
    const before = walk(f.gameRoot), source = path.join(f.payload, 'versions', D13, PAYLOAD_FILES[kind]);
    fs.appendFileSync(source, `tampered ${kind}`);
    await assert.rejects(f.plans.preview(f.id, { api: 'dx12', version: D13, deployment: 'local' }), { code: 'ERR_PAYLOAD_HASH' });
    assert.deepEqual(walk(f.gameRoot), before, `${kind} preview tamper leaves base installed`);
  }
  const f = await coreFixture(t); await f.apply({ api: 'dx12', version: BASE, deployment: 'local' });
  const plan = await f.plans.preview(f.id, { api: 'dx12', version: D13, deployment: 'local' });
  fs.appendFileSync(path.join(f.payload, 'versions', D13, PAYLOAD_FILES.addon), 'changed after preview');
  const before = walk(f.gameRoot);
  await assert.rejects(f.plans.apply(plan.planId, confirm(plan)), { code: 'ERR_PAYLOAD_HASH' });
  assert.deepEqual(walk(f.gameRoot), before, 'apply-time source tamper leaves base installed');
});

test('Core update preview expires after a game configuration change and never overwrites the changed INI', async t => {
  const f = await coreFixture(t); await f.apply({ api: 'dx12', version: BASE, deployment: 'local' });
  const files = layoutFiles(f); const plan = await f.plans.preview(f.id, { api: 'dx12', version: D13, deployment: 'local' });
  const changed = Buffer.concat([fs.readFileSync(files.config), Buffer.from('\r\n[ChangedByGame]\r\nValue=9\r\n')]); fs.writeFileSync(files.config, changed);
  await assert.rejects(f.plans.apply(plan.planId, confirm(plan)), error => /CHANGED|预览|配置/.test(error.code || '') || /预览|配置/.test(error.message));
  assert.deepEqual(fs.readFileSync(files.config), changed);
  assert.equal(readManifest(f.gameRoot).payloadVersion, BASE);
});

test('an existing native HoYo profile accepts a bundled Core update while first install rejects it', async t => {
  const f = await hoyoCoreFixture(t), request = version => ({ route: 'native', api: 'dx12', deployment: 'external', loadingBackend: 'hoyoshade', version,
    hoyo: { family: 'genshin', channel: 'cn', launcher: { kind: 'hoyoplay', path: f.launcher } } });
  const before = walk(f.gameRoot);
  await assert.rejects(f.plans.preview(f.id, request(D13)), { code: 'CORE_UPDATE_BASE_REQUIRED' });
  assert.deepEqual(walk(f.gameRoot), before, 'first-install Core update does not create a HoYo profile');

  const base = await f.plans.preview(f.id, request(BASE)); assert.deepEqual(base.blockers, []);
  await f.plans.apply(base.planId, confirm(base));
  const initial = f.service.getLayout(f.id), initialConfig = fs.readFileSync(initial.activeConfigPath);
  const update = await f.plans.preview(f.id, { version: D13, api: 'auto', deployment: 'external', loadingMode: 'helper' }); assert.deepEqual(update.blockers, []);
  await f.plans.apply(update.planId, confirm(update));
  const layout = f.service.getLayout(f.id), core = layout.moduleManifest.find(row => row.role === 'core'), chain = layout.moduleManifest.find(row => row.role === 'chain');
  assert.equal(layout.version, D13);
  assert.equal(core.sha256, coreHash(f, D13, 'addon'));
  assert.equal(chain.sha256, coreHash(f, D13, 'bridge'));
  assert.deepEqual(fs.readFileSync(layout.activeConfigPath), initialConfig, 'native HoYo update preserves its active INI');
});
