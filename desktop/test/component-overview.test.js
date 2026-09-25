'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { buildOverview, createComponentOverview, compareVersions } = require('../src/product/component-overview');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const core = { version: 'current', inputInterfaces: ['NGX-D3D12-Feature1', 'ExternalProviderV1'], capabilities: ['frame', 'fence'] };
const row = (id, kind, version, digest = hash(id)) => ({ id, kind, version, sha256: digest, files: [{ name: 'module.addon64', file: 'module.addon64', sha256: digest, bytes: 4 }], filesReady: true, source: 'bundled', validation: 'candidate', interface: 'NGX-D3D12-Feature1' });
const release = (id, kind, version, digest = hash(id)) => ({ ...row(id, kind, version, digest), downloadUrl: 'https://github.com/example/component', immutable: true });

test('bundled content identities suppress alias downloads and historical versions', () => {
  const bridge = row('bundled-date', 'bridge', '1.4.13-pre8');
  const overview = buildOverview({ currentCore: core, packages: [bridge, { ...bridge, id: 'import-alias', source: 'imported' }], catalog: { packages: [
    release('catalog-alias', 'bridge', bridge.version, bridge.sha256), release('old', 'bridge', '1.4.12'),
    release('same-version-new-bytes', 'bridge', bridge.version) ] } });
  assert.equal(overview.groups[0].entries.length, 1); assert.equal(overview.groups[0].state, 'prepared'); assert.deepEqual(overview.updates, []);
});
test('each category offers its newest compatible update; unverified releases stay notices', () => {
  const overview = buildOverview({ currentCore: core, packages: [row('old', 'bridge', '1.4.13-pre8')], catalog: { packages: [
    release('new-verified', 'bridge', '1.4.13-pre10'), release('newer-incompatible', 'bridge', '1.5.0'),
    { ...release('new-mfg', 'mfg', '1.1'), immutable: false } ].map(x => x.id === 'newer-incompatible' ? { ...x, requiresAdapter: true } : x) } });
  assert.equal(overview.updates.length, 2); assert.equal(overview.updates[0].id, 'new-verified'); assert.equal(overview.updates[0].downloadable, true);
  assert.equal(overview.updates[1].downloadable, false); assert.equal(compareVersions('1.4.13-pre10', '1.4.13-pre8'), 1);
  assert.equal(compareVersions('1.4.13', '1.4.13-pre10'), 1); assert.equal(compareVersions('unknown', '1.0'), null);
});
test('Feeder files do not imply current Core interface and fence compatibility', () => {
  const feeder = { ...row('feeder', 'feeder', '0.5.0'), interface: 'ExternalProviderV1', requiredCoreCapabilities: ['frame', 'fence', 'extra'] };
  const groups = buildOverview({ currentCore: core, packages: [feeder, row('mfg', 'mfg', '1.0')] }).groups;
  assert.equal(groups[1].filesReady, true); assert.equal(groups[1].state, 'needs-adapter'); assert.equal(groups[2].state, 'prepared');
  assert.equal(buildOverview({ currentCore: { ...core, capabilities: [...core.capabilities, 'extra'] }, packages: [feeder] }).groups[1].state, 'prepared');
});
test('inventory verification detects same-size external edits and missing files on subsequent reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-overview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'module.addon64'), 'good');
  const entry = row('bridge', 'bridge', '1.4.13', hash('good'));
  const overview = createComponentOverview({ appDir: root, libraryRoot: root });
  const read = () => overview.read({ inventory: { packages: [entry] }, currentCore: core });
  assert.equal((await read()).groups[0].state, 'prepared');
  await fs.writeFile(path.join(root, 'module.addon64'), 'evil');
  assert.equal((await read()).groups[0].state, 'invalid');
  await fs.writeFile(path.join(root, 'module.addon64'), 'good');
  assert.equal((await read()).groups[0].state, 'prepared');
  await fs.unlink(path.join(root, 'module.addon64'));
  assert.equal((await read()).groups[0].state, 'invalid');
});
test('Feeder uses its verified descriptor capabilities rather than a catalog label', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-overview-feeder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const definition = JSON.stringify({ interface: { name: 'ExternalProviderV1', requiredCoreCapabilities: ['frame', 'fence'] } });
  await fs.writeFile(path.join(root, 'external-provider-package.json'), definition);
  await fs.writeFile(path.join(root, 'module.addon64'), 'good');
  const entry = row('feeder', 'feeder', '0.5.0', hash('good'));
  entry.files.push({ name: 'external-provider-package.json', file: 'external-provider-package.json', bytes: Buffer.byteLength(definition), sha256: hash(definition) });
  const overview = createComponentOverview({ appDir: root, libraryRoot: root });
  assert.equal((await overview.read({ inventory: { packages: [entry] }, currentCore: core })).groups[1].state, 'prepared');
  assert.equal((await overview.read({ inventory: { packages: [entry] }, currentCore: { ...core, capabilities: [] } })).groups[1].state, 'needs-adapter');
});
