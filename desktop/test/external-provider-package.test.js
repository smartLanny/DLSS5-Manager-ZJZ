'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createExternalProviderPackages } = require('../src/product/external-provider-package');
const { createLegacyRuntime } = require('../src/product/legacy-runtime');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, alter = value => value) {
  const userData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'external-provider-v1-'));
  const root = path.join(userData, 'component-library'); fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const rows = [];
  function object(name, bytes) {
    const sha256 = hash(bytes), file = `objects/${sha256}/${path.basename(name)}`, target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    const row = { file, name, sha256, bytes: bytes.length }; rows.push(row); return row;
  }
  const provider = object('transport/provider.addon64', Buffer.from('provider-fixture'));
  const core = object('core/current-core.addon64', Buffer.from('core-fixture'));
  const chain = object('nrchain_nvngx.dll', Buffer.from('core-chain-fixture'));
  const config = object('nr_before_sr.ini', Buffer.from('[NRBeforeSR]\nEnabled=1\n'));
  const runtime = object('runtime/nvngx_dlssnr.dll', Buffer.from('runtime-fixture'));
  const manifest = alter({ schema: 'dlss5-external-provider-package-v1',
    interface: { name: 'NRExternalProviderV1', version: 1, requiredCoreCapabilities: ['same-frame-output'] },
    contract: { provenance: 'Native', scope: 'game-input', colorContract: 'same-frame-native-input', srInjected: false, fgInjected: false },
    defaults: { definitions: 'PROVIDER=1', hostGuides: '[ADDON]\nAddonPath=.\\addons\n', feeder: 'enabled=1\nmode=2\n' },
    routes: [{ id: 'dx11-x64-local', api: 'dx11', architecture: 'x64', hardwareFamilies: ['RTX40', 'RTX50'], loadingBackend: 'local',
      proxyEntries: ['auto', 'dxgi'], hostRequired: false, transport: 'in-process-d3d12', relay: null, wrapper: null,
      coreDirectory: '', runtimeDirectory: '', files: [{ role: 'provider', file: provider.name, base: 'addon', target: 'dlss5-feed.addon64', architecture: 'x64', mutable: false }] }] });
  const definition = object('external-provider-package.json', Buffer.from(JSON.stringify(manifest)));
  const inventory = { schemaVersion: 1, selected: {}, packages: [
    { id: 'provider-v1-fixture', kind: 'feeder', version: '1.0.0', architecture: 'mixed', interface: 'NRExternalProviderV1',
      gameApis: ['dx11'], hardwareFamilies: ['RTX40', 'RTX50'], files: [provider, definition], source: 'user-imported', validation: 'candidate' },
    { id: 'core-fixture', kind: 'core', version: 'D15', architecture: 'x64', interface: 'NRExternalProviderV1', files: [core, chain, config], source: 'user-imported', validation: 'candidate' },
    { id: 'runtime-fixture', kind: 'nr-runtime', version: '310', architecture: 'x64', interface: 'NGX-Feature18', files: [runtime], source: 'catalog', validation: 'candidate' }
  ] };
  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify(inventory));
  const currentCore = { id: 'core-fixture', version: 'D15', file: core.file, sha256: core.sha256, architecture: 'x64',
    inputInterfaces: ['NRExternalProviderV1'], capabilities: ['same-frame-output', 'native-motion-vectors'],
    companions: [{ role: 'core-chain', name: 'nrchain_nvngx.dll', file: chain.file, sha256: chain.sha256, bytes: chain.bytes }],
    config: { role: 'core-config', name: 'nr_before_sr.ini', file: config.file, sha256: config.sha256, bytes: config.bytes } };
  const currentRuntime = { file: runtime.file, sha256: runtime.sha256, bytes: runtime.bytes, family: 'RTX50' };
  return { userData, root, inventory, currentCore, currentRuntime,
    packages: createExternalProviderPackages({ root, currentCore, currentRuntime }) };
}

test('an explicitly ABI-compatible Core carries only complete whitelisted resources; Feature1-only unified3 remains refused', async t => {
  const f = fixture(t), names = require('../src/product/payload-companions').NAMES;
  for (const name of names) {
    const bytes = Buffer.from('resource:' + name), sha256 = hash(bytes), file = `objects/${sha256}/${path.basename(name)}`;
    const target = path.join(f.root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    const row = { name, file, sha256, bytes: bytes.length };
    f.inventory.packages[1].files.push(row); f.currentCore.companions.push({ ...row, role: 'core-resource' });
  }
  fs.writeFileSync(path.join(f.root, 'inventory.json'), JSON.stringify(f.inventory));
  const selection = { api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'local' };
  const load = () => f.packages.load({ id: 'provider-v1-fixture', selection });
  const recipe = load().recipe;
  assert.equal(recipe.files.filter(row => row.role === 'core-resource').length, 7);
  assert.deepEqual(f.packages.validateRecipe(recipe), recipe);
  f.currentCore.companions.pop(); assert.throws(load);
  f.currentCore.id = '0.5-dline21-unified3'; f.currentCore.inputInterfaces = ['NGX-D3D12-Feature1'];
  assert.throws(load, { code: 'EXTERNAL_PROVIDER_CORE_INCOMPATIBLE' });
});

test('a selected v1 provider injects the current ABI-compatible Core and shared runtime by exact digest', async t => {
  const f = fixture(t), before = f.packages.inspect();
  assert.equal(before.packages[0].selectable, true); assert.equal(before.packages[0].runtimeVerified, false);
  assert.deepEqual(await f.packages.select('provider-v1-fixture'), { selectedId: 'provider-v1-fixture',
    selectedByApi: { dx11: 'provider-v1-fixture' }, selectedByRoute: { 'dx11|x64|local': 'provider-v1-fixture' },
    changedGames: false, runtimeVerified: false });
  const pkg = f.packages.load({ selection: { api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'local' } });
  assert.equal(pkg.recipe.coreVersion, 'D15'); assert.equal(pkg.recipe.coreVariant.genericCoreInterchangeable, true);
  assert.equal(pkg.recipe.files.find(row => row.role === 'core').sha256, f.currentCore.sha256);
  assert.equal(pkg.recipe.files.find(row => row.role === 'core-chain').sha256, f.currentCore.companions[0].sha256);
  assert.equal(pkg.recipe.files.find(row => row.role === 'core-config').sha256, f.currentCore.config.sha256);
  assert.equal(pkg.recipe.files.find(row => row.role === 'nr-runtime').sha256, f.currentRuntime.sha256);
  assert.equal(pkg.recipe.acceptance.status, 'candidate'); assert.equal(pkg.recipe.externalProvider.runtimeVerified, false);
});

test('invalid selected metadata and Feature1-only packages never fall back to bundled Core 0.4.7', async t => {
  const f = fixture(t); f.inventory.selected.externalProvider = 'missing-provider';
  fs.writeFileSync(path.join(f.root, 'inventory.json'), JSON.stringify(f.inventory));
  assert.throws(() => f.packages.load({ api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'local' }),
    { code: 'EXTERNAL_PROVIDER_SELECTION_INVALID' });
  const incompatible = fixture(t, value => ({ ...value, interface: { ...value.interface, name: 'NGX-D3D12-Feature1' } }));
  assert.equal(incompatible.packages.inspect().packages[0].selectable, false);
  await assert.rejects(incompatible.packages.select('provider-v1-fixture'));
});

test('legacy runtime consumes the selected recipe through its normal exact-file verifier', async t => {
  const f = fixture(t); await f.packages.select('provider-v1-fixture');
  const runtime = createLegacyRuntime({ appDir: f.userData, root: path.join(f.userData, 'unused-bundled-pool'),
    externalProviders: f.packages, currentCore: f.currentCore, currentRuntime: f.currentRuntime,
    pe: { getBitness: file => /current-core|provider|nrchain_nvngx|nvngx_dlssnr/.test(file) ? 64 : null } });
  const pkg = await runtime.verify({ api: 'dx11', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: 'local' });
  assert.equal(pkg.recipe.providerPackageId, 'provider-v1-fixture'); assert.equal(pkg.root, f.root);
  fs.appendFileSync(path.join(f.root, pkg.recipe.files.find(row => row.role === 'provider').source), 'changed');
  await assert.rejects(runtime.verify(pkg), { code: 'LEGACY_PACKAGE_HASH' });
});

test('a route supporting both GPU families still refuses the other family runtime without changing its selection', async t => {
  for (const [hardwareFamily, runtimeFamily] of [['RTX40', 'RTX50'], ['RTX50', 'RTX40']]) {
    const f = fixture(t); f.currentRuntime.family = runtimeFamily;
    await f.packages.select('provider-v1-fixture');
    const inventoryFile = path.join(f.root, 'inventory.json'), before = fs.readFileSync(inventoryFile);
    assert.throws(() => f.packages.load({ selection: { api: 'dx11', architecture: 'x64', hardwareFamily, loadingBackend: 'local' } }),
      { code: 'EXTERNAL_PROVIDER_RUNTIME_INCOMPATIBLE' });
    assert.deepEqual(fs.readFileSync(inventoryFile), before);
  }
});
