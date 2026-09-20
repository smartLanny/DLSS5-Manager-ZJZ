'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createSm86Components, ID, SOURCE, PIN } = require('../src/product/fg-sm86-components');
const { createFgComponents } = require('../src/product/fg-components');
const { createLaunchSettingsService } = require('../src/product/launch-settings-service');
const { createFgWorkflow } = require('../src/product/fg-workflow');
const { assessEnhancementState } = require('../src/product/game-enhancement-capabilities');
const { fgBackend } = require('../src/product/gpu');
const config = require('../src/product/fg-sm86-config');
const journal = require('../src/core/file-journal');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-sm86-test-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const game = path.join(root, 'game'), dir = path.join(game, 'Bin'), exe = path.join(dir, 'Game.exe'), resources = path.join(root, 'resources', 'fg-sm86');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(resources, { recursive: true }); fs.writeFileSync(exe, 'synthetic executable; never loaded');
  const contents = { proxy: 'synthetic proxy; never loaded', config: '; fixture defaults\r\n[General]\r\nEnabled=1\r\n[FrameGeneration]\r\nOptimized=1\r\nMaxGeneratedFrames=3\r\n[Runtime]\r\nMode=Bundled\r\n',
    notices: 'synthetic notices', readme: 'synthetic readme' };
  const pins = Object.fromEntries(Object.entries(contents).map(([role, bytes]) => {
    const name = PIN[role].name; fs.writeFileSync(path.join(resources, name), bytes); return [role, { name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }];
  }));
  const manifest = { schemaVersion: 1, id: ID, version: '0.3.5', backend: 'dlssg-sm86', source: { repository: 'sdli1995/dlssg_for_sm86', commit: SOURCE }, files: pins };
  fs.writeFileSync(path.join(resources, 'manifest.json'), JSON.stringify(manifest));
  const hardware = { family: 'RTX40', series: ['RTX30'], source: 'synthetic' }, observed = { api: 'dx12', streamlineFg: true };
  const evidence = { support: { status: 'supported', source: 'native-integration', capabilities: {} },
    staticEvidence: { api: 'dx12', nativeFgAvailable: true }, driver: { available: false }, gameSetting: { state: 'unknown' } };
  const opts = { appDir: root, resourcesPath: path.join(root, 'resources'), sm86Definition: pins,
    gameDirectory: () => game, gameExecutable: () => exe, detectHardware: async () => hardware, scan: async () => observed,
    getFeatureEvidence: async () => evidence, pe: { getBitness: () => 64 }, assertGameClosed: async () => {}, antiCheatPresent: () => false, ...extra };
  const create = () => createSm86Components(opts), components = create();
  const settings = createLaunchSettingsService({ ...opts, userData: path.join(root, 'user'), peBitness: () => 64,
    driver: {}, environment: async () => ({ verified: true, running: [] }),
    assertComponents: async (_id, backend) => { assert.equal(backend, 'dlssg-sm86'); if (!(await components.inspect('g')).ready)
      throw Object.assign(new Error('prepare components'), { code: 'SETTINGS_COMPONENTS_NOT_READY' }); } });
  const workflow = createFgWorkflow({ settings, components, assertClosed: async () => {} });
  return { root, game, dir, exe, resources, pins, manifest, hardware, observed, evidence, opts, create, components, settings, workflow,
    proxy: path.join(dir, 'version.dll'), ini: path.join(dir, config.FILE) };
}
test('FG generation remains independent from the shared NR payload family', () => {
  for (const [series, backend] of [['RTX20','dlssg-sm86'],['RTX30','dlssg-sm86'],['RTX40','mfgunlock'],['RTX50','nvidia']])
    assert.equal(fgBackend({ family: series === 'RTX50' ? 'RTX50' : 'RTX40', series: [series] }), backend);
  assert.equal(fgBackend({ family: 'RTX40', series: ['RTX20','RTX40'] }), null);
  assert.equal(fgBackend({ family: 'RTX40', series: [] }), null);
});
test('production SM86 source pins cannot be broadened by a manifest', async t => {
  const f = fixture(t), { sm86Definition, ...productionOptions } = f.opts;
  const state = await createSm86Components(productionOptions).inspect('g');
  assert.equal(state.resourceReady, false); assert.equal(state.canPrepare, false);
  assert.equal(PIN.proxy.bytes, 30021920); assert.equal(PIN.proxy.sha256, 'c3934a09399f022504227c72df0bf8c0de55f9a08880dddde898c5262cefa838');
  f.manifest.source.commit = '0'.repeat(40); fs.writeFileSync(path.join(f.resources, 'manifest.json'), JSON.stringify(f.manifest));
  assert.equal((await f.components.inspect('g')).canPrepare, false);
});
for (const [name, mutate] of [
  ['RTX40 family without physical generation', f => { f.hardware.series = []; }],
  ['Vulkan', f => { f.observed.api = 'vulkan'; }],
  ['x86', f => { f.opts.pe.getBitness = () => 32; }],
  ['loose DLSSG DLL', f => { f.evidence.support.status = 'unknown'; }],
  ['missing native FG', f => { f.observed.streamlineFg = false; }]
]) test(`SM86 refuses ${name} without writing game files`, async t => {
  const f = fixture(t); mutate(f); await assert.rejects(f.components.prepare('g'), { code: 'SETTINGS_SM86_BLOCKED' });
  assert.equal(fs.existsSync(f.proxy), false); assert.equal(fs.existsSync(f.components.receiptFile('g')), false);
});
test('prepare writes only the fixed proxy and config, and clean restore removes only owned files', async t => {
  const f = fixture(t); const names = ['nr_before_sr.ini','ReShade.ini','nr-before-sr.zh-CN.addon64','nvngx_dlssg.dll'];
  for (const name of names) fs.writeFileSync(path.join(f.dir, name), `original ${name}`);
  const result = await f.components.prepare('g'); assert.equal(result.backend, 'dlssg-sm86'); assert.equal(result.runtimeVerified, false);
  assert.equal((await f.components.inspect('g')).ready, true); assert.equal(config.values(fs.readFileSync(f.ini, 'utf8'))['FrameGeneration.MaxGeneratedFrames'], '3');
  await f.components.commitPrepare('g', result.undoToken); await f.components.restore('g');
  assert.equal(fs.existsSync(f.proxy), false); assert.equal(fs.existsSync(f.ini), false);
  for (const name of names) assert.equal(fs.readFileSync(path.join(f.dir, name), 'utf8'), `original ${name}`);
});
test('unknown version.dll and competing FG are refused without overwriting originals', async t => {
  const f = fixture(t); fs.writeFileSync(f.proxy, 'some other proxy');
  await assert.rejects(f.components.prepare('g'), { code: 'SETTINGS_SM86_BLOCKED' }); assert.equal(fs.readFileSync(f.proxy, 'utf8'), 'some other proxy');
  fs.unlinkSync(f.proxy); fs.writeFileSync(path.join(f.dir, 'renodx-mfgunlock.addon64'), 'another backend');
  await assert.rejects(f.components.prepare('g'), { code: 'SETTINGS_SM86_BLOCKED' }); assert.equal(fs.existsSync(f.proxy), false);
});
test('exact pre-existing proxy is adopted and existing config remains user-owned', async t => {
  const f = fixture(t); fs.copyFileSync(path.join(f.resources, 'version.dll'), f.proxy);
  const original = '; mine\r\n[General]\r\nEnabled=0\r\n[FrameGeneration]\r\nOptimized=0\r\nMaxGeneratedFrames=1\r\n[Personal]\r\nKeep=yes\r\n'; fs.writeFileSync(f.ini, original);
  await f.components.prepare('g'); assert.equal(fs.readFileSync(f.ini, 'utf8'), original);
  const restored = await f.components.restore('g'); assert.deepEqual(restored.retained.sort(), ['dlssg_sm86.ini','version.dll']);
  assert.equal(fs.readFileSync(f.ini, 'utf8'), original); assert.ok(fs.existsSync(f.proxy));
});
test('new config edited externally is retained; changed owned proxy blocks removal', async t => {
  const f = fixture(t); await f.components.prepare('g'); fs.appendFileSync(f.ini, '; new personal line\n');
  fs.writeFileSync(f.proxy, 'external replacement'); await assert.rejects(f.components.restore('g'), { code: 'SETTINGS_SM86_CHANGED' });
  fs.copyFileSync(path.join(f.resources, 'version.dll'), f.proxy);
  const result = await f.components.restore('g'); assert.deepEqual(result.retained, ['dlssg_sm86.ini']); assert.match(fs.readFileSync(f.ini, 'utf8'), /new personal line/);
});
test('prepare failure rolls back newly copied files and creates no ownership receipt', async t => {
  let copies = 0; const f = fixture(t, { copyFile: async (source, destination, flags) => { if (++copies === 2) throw Error('synthetic copy failure'); return fsp.copyFile(source, destination, flags); } });
  await assert.rejects(f.components.prepare('g'), /synthetic copy failure/);
  assert.equal(fs.existsSync(f.proxy), false); assert.equal(fs.existsSync(f.ini), false); assert.equal(fs.existsSync(f.components.receiptFile('g')), false);
  assert.equal(fs.existsSync(journal.pendingPath(f.game)), false);
});
test('interrupted SM86 transaction recovers after restart and refuses unrelated external changes', async t => {
  const f = fixture(t, { writeReceipt: async () => { throw Object.assign(Error('simulated process exit'), { preservePending: true }); } });
  await assert.rejects(f.components.prepare('g'), { code: 'errBackendRecovery' });
  const reopened = f.create(); assert.equal((await reopened.inspectPending('g')).fileRecoveryPending, true);
  fs.writeFileSync(f.proxy, 'outside edit after interruption');
  await assert.rejects(reopened.recoverPending('g'), { code: 'SETTINGS_FG_EXTERNAL_CHANGE' });
  assert.equal(fs.readFileSync(f.proxy, 'utf8'), 'outside edit after interruption');
  fs.copyFileSync(path.join(f.resources, 'version.dll'), f.proxy);
  assert.equal((await reopened.recoverPending('g')).recovered, true); assert.equal(fs.existsSync(f.proxy), false); assert.equal(fs.existsSync(f.ini), false);
});
test('workflow prepares components then applies and disables SM86 without touching the NR configuration', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'nr_before_sr.ini'), '[NR]\nIntensity=0.8\n');
  const result = await f.workflow.apply('g', { backend: 'dlssg-sm86', mode: 'fixed', multiplier: 4 });
  assert.equal(result.backend, 'dlssg-sm86'); assert.equal(result.runtimeVerified, false);
  assert.equal((await f.settings.inspect('g')).applied.fg.readbackVerified, true);
  await f.workflow.apply('g', { backend: 'dlssg-sm86', mode: 'off' });
  assert.equal(config.values(fs.readFileSync(f.ini, 'utf8'))['General.Enabled'], '0');
  await f.settings.restore('g', 'fg'); await f.components.restore('g');
  assert.equal(fs.existsSync(f.proxy), false); assert.equal(fs.existsSync(f.ini), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'nr_before_sr.ini'), 'utf8'), '[NR]\nIntensity=0.8\n');
});
test('SM86 configuration restore retains unrelated user INI edits', async t => {
  const f = fixture(t), original = '[General]\r\nEnabled=0\r\n[FrameGeneration]\r\nOptimized=0\r\nMaxGeneratedFrames=1\r\n[Runtime]\r\nMode=Bundled\r\n[Personal]\r\nKeep=yes\r\n';
  fs.writeFileSync(f.ini, original); await f.workflow.apply('g', { backend: 'dlssg-sm86', mode: 'fixed', multiplier: 3 });
  fs.appendFileSync(f.ini, 'Another=user\r\n'); await f.settings.restore('g', 'fg'); await f.components.restore('g');
  assert.equal(fs.readFileSync(f.ini, 'utf8'), original + 'Another=user\r\n');
});
test('6X needs explicit game-plugin support, not the proxy runtime ceiling alone', async t => {
  const f = fixture(t), request = { backend: 'dlssg-sm86', mode: 'fixed', multiplier: 6 };
  assert.equal((await f.settings.assessEligibility('g','fg',request)).eligible, false);
  await assert.rejects(f.workflow.apply('g',request), { code: 'SETTINGS_BLOCKED' }); assert.equal(fs.existsSync(f.proxy), false);
  f.evidence.support.capabilities.dlssgSm86 = { sixXSupported: true };
  assert.equal((await f.settings.assessEligibility('g','fg',request)).eligible, false);
  f.evidence.support.capabilities.dlssgSm86.gamePluginSupportsSixX = true;
  assert.equal((await f.settings.assessEligibility('g','fg',request)).eligible, true);
  await f.workflow.apply('g',request); assert.equal(config.values(fs.readFileSync(f.ini, 'utf8'))['FrameGeneration.MaxGeneratedFrames'], '5');
});
test('config parser refuses ambiguous duplicate keys and disallows lossy or dynamic options', () => {
  assert.throws(() => config.compile('[FrameGeneration]\nOptimized=1\nOptimized=0\n', { mode: 'follow' }), /重复/);
  assert.throws(() => config.compile('', { mode: 'follow', optimized: 3 }));
  assert.throws(() => config.compile('', { mode: 'dynamic', targetFps: 120 }));
});
test('component wrapper chooses RTX20 SM86 and retains its restore owner after a GPU change', async t => {
  const f = fixture(t); f.hardware.series = ['RTX20']; const wrapper = createFgComponents(f.opts);
  assert.equal((await wrapper.inspect('g')).backend, 'dlssg-sm86'); await wrapper.prepare('g');
  f.hardware.series = ['RTX50']; f.hardware.family = 'RTX50';
  assert.equal((await wrapper.inspect('g')).needsCleanup, true); await wrapper.restore('g'); assert.equal(fs.existsSync(f.proxy), false);
});

test('an interrupted previous MFG owner remains routed to its dedicated recovery after a GPU change', async t => {
  const f = fixture(t), file = journal.pendingPath(f.game); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ owner: { product: 'xiaofeng-fg-components' }, files: [] }));
  const state = await createFgComponents(f.opts).inspectPending('g');
  assert.equal(state.fileRecoveryPending, true);
  await assert.rejects(createFgComponents(f.opts).recoverPending('g'), { code: 'SETTINGS_FG_FILE_RECOVERY_INVALID' });
  assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(f.proxy), false);
});
