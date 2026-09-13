'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { loadOwner } = require('./helpers/manager-boundary-loader.cjs');
const safety = require('../src/product/launch-safety');
const ini = require('../src/product/launch-ini');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const feeder = loadOwner(path.join(__dirname, '../src/product/feeder-runtime.js'), { './feeder-package-lock': {}, '../core/pe': {} });
const brokerSource = path.join(__dirname, '../src/product/game-launch-broker.js');
const brokerModule = loadOwner(brokerSource, { '../core/pe': {} });
const ownerSource = path.join(__dirname, '../src/product/legacy-service.js');

// A real data-only PE with RT_MANIFEST/1/1033. Never executed.
function executable(level) {
  const bytes = Buffer.alloc(4096), pe = 0x80, optional = pe + 24, section = optional + 240, raw = 0x400;
  bytes.write('MZ'); bytes.writeUInt32LE(pe, 0x3c); bytes.write('PE\0\0', pe);
  bytes.writeUInt16LE(0x8664, pe + 4); bytes.writeUInt16LE(1, pe + 6); bytes.writeUInt16LE(240, pe + 20);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1000, optional + 128); bytes.writeUInt32LE(0xc00, optional + 132);
  bytes.write('.rsrc', section); bytes.writeUInt32LE(0xc00, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0xc00, section + 16); bytes.writeUInt32LE(raw, section + 20);
  for (const [off, id, target] of [[0, 24, 0x80000020], [0x20, 1, 0x80000040], [0x40, 1033, 0x60]]) {
    bytes.writeUInt16LE(1, raw + off + 14); bytes.writeUInt32LE(id, raw + off + 16); bytes.writeUInt32LE(target, raw + off + 20);
  }
  const manifest = Buffer.from(`<assembly><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`);
  bytes.writeUInt32LE(0x1080, raw + 0x60); bytes.writeUInt32LE(manifest.length, raw + 0x64); manifest.copy(bytes, raw + 0x80);
  return bytes;
}
function fixture(t, { level = 'requireAdministrator', source = 'local', sourceFile = ownerSource } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mgr27-')), dir = path.join(root, 'game'), pool = path.join(root, 'pool');
  fs.mkdirSync(dir); fs.mkdirSync(pool); const exe = path.join(dir, 'yysls.exe'); fs.writeFileSync(exe, executable(level));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = { id: 'g', dir, scan: { chosen: { path: exe, bitness: 64, apiResolution: { api: 'dx12' } } } };
  const state = { inspections: 0, launches: 0, closedChecks: 0, running: false, antiCheat: false, afterWrite: null };
  const elevationError = () => Object.assign(new Error('ordinary-token launch refused'), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' });
  const broker = { inspect: async () => { state.inspections++; throw elevationError(); }, launch: async () => { state.launches++; throw elevationError(); } };
  const runtimeDir = path.join(dir, '_DLSS5_Feeder');
  const layout = { source, verified: true, gameDir: dir, exePath: exe, runtimeDir, addonDirectory: path.join(runtimeDir, 'addons'),
    nrConfigDir: path.join(runtimeDir, 'addons'), activeConfigPath: path.join(dir, 'ReShade.ini'), generation: 'fixture' };
  if (source === 'hoyoshade-profile') layout.loadingBackend = 'hoyoshade';
  const selection = { api: 'dx12', architecture: 'x64', hardwareFamily: 'RTX50', loadingBackend: source === 'local' ? 'local' : 'hoyoshade', proxyEntry: 'auto' };
  const files = [['game', 'dxgi.dll', 'game-loader'], ['addon', 'core.addon64', 'core'], ['addon', 'feed.addon64', 'provider']].map(([base, target, role]) => {
    const content = Buffer.from('fixture only: ' + role); fs.writeFileSync(path.join(pool, role), content);
    return { base, target, role, mutable: false, source: role, sha256: sha(content), bytes: content.length, architecture: 'x64' };
  });
  const recipe = { schema: 2, id: 'test-dx12', gameApi: 'dx12', architecture: 'x64', loadingBackend: selection.loadingBackend, hostRequired: false,
    coreVersion: 'test', selection, files, defaults: { feeder: '[Feeder]\nEnabled=1\n', definitions: 'FIXTURE=1' } };
  const pkg = { root: pool, recipe, fingerprint: feeder.fingerprint(recipe) };
  const runtime = { root: pool, verify: async input => {
    if (input?.recipe) assert.equal(feeder.fingerprint(input.recipe), pkg.fingerprint);
    for (const f of files) assert.equal(await feeder.fileDigest(path.join(pool, f.source)), f.sha256);
    return pkg;
  }, validate: value => { assert.equal(feeder.fingerprint(value), pkg.fingerprint); return value; } };
  const original = '[GENERAL]\nPresetPath=personal.ini\n[INPUT]\nKeyOverlay=36,0,0,0\n[USER]\nKeep=42\n';
  fs.writeFileSync(layout.activeConfigPath, original);
  const substitutes = {
    './game-launch-broker': { ...brokerModule, createGameLaunchBroker: () => broker },
    './legacy-runtime': { createLegacyRuntime: () => runtime, DIRECTORY: '_DLSS5_Feeder', RECEIPT: '_DLSS5_Backup/xiaofeng-feeder.json' },
    './legacy-runtime-catalog': { resolve: x => ({ ...x }), validateLayout: (_g, x) => x },
    './feeder-runtime': feeder,
    './feeder-runtime-evidence': { readLegacyFeederEvidence: async () => ({ loaded: 'unknown', processed: 'unknown' }) },
    './external-runtime': { createExternalRuntime: () => ({ planAddonMigration: async () => ({
      binding: { fingerprint: 'b'.repeat(64), config: original, environment: {}, configured: { baseDir: dir } },
      rows: [], isolated: [], directNames: [], compatibility: { decisions: [] }, guard: async () => {}
    }) }) },
    './external-profile-config': { externalConfig: text => text, PATH_KEYS: [] },
    './addon-source-binding': { sourceAllows: () => false, validSourceBinding: () => false },
    './addon-loading-layout': { snapshotAddonLoadingLayout: async () => ({ profile: { activeConfigPath: layout.activeConfigPath, addonDir: layout.addonDirectory }, blockers: [], files: [] }) },
    './addon-compatibility': { planAddonCompatibility: () => ({ blockers: [], isolate: [], retire: [] }) },
    './conflicts': { isProtectedName: () => false }, './launch-ini': ini,
    './hotkeys': { DEFAULT_RESHADE_KEY: 36, MANAGED_RESHADE_DEFAULT_KEYS: [36], hasKeyOverlay: text => ini.getIni(text, 'INPUT', 'KeyOverlay') !== null,
      ensureDefaultReShadeHotkey: text => text },
    '../core/file-journal': { safePath: (r, rel) => { const file = path.resolve(r, rel); assert(safety.inside(r, file)); return file; } }
  };
  const owner = loadOwner(sourceFile, substitutes);
  const service = owner.createLegacyService({ userData: path.join(root, 'user'), runtime, broker, getLayout: () => layout,
    hardware: { family: 'RTX50' }, pe: { getBitness: file => {
      const fd = fs.openSync(file, 'r'), word = Buffer.alloc(2);
      try { return fs.readSync(fd, word, 0, 2, 0x84) === 2 && word.readUInt16LE(0) === 0x8664 ? 64 : 0; }
      finally { fs.closeSync(fd); }
    } },
    guards: { assertGameClosed: async () => { state.closedChecks++; if (state.running) throw Object.assign(new Error('running'), { code: 'GAME_RUNNING' }); }, antiCheatPresent: () => state.antiCheat },
    afterWrite: row => state.afterWrite?.(row) });
  return { service, state, game, exe, dir, pool, layout, recipe, original, request: { loadingBackend: selection.loadingBackend } };
}
for (const level of ['requireAdministrator', 'highestAvailable', 'asInvoker']) {
  test(`${level}: local deployment preview never starts/probes an ordinary-token helper`, async t => {
    const f = fixture(t, { level }); assert.equal(brokerModule.executionLevel(f.exe), level);
    const before = fs.readdirSync(f.dir); const p = await f.service.previewInstall(f.game, f.request);
    assert.equal(f.state.inspections, 0); assert.equal(f.state.launches, 0); assert.equal(p.runtimeVerified, false);
    assert.deepEqual(fs.readdirSync(f.dir), before); assert(f.state.closedChecks > 0);
  });
}
test('local elevated game: real file install, pinned repair, preservation and restore', async t => {
  const f = fixture(t); const p = await f.service.previewInstall(f.game);
  await f.service.install(f.game, { expectedPlanId: p.planId });
  assert.equal((await f.service.inspect(f.game)).ready, true);
  const core = path.join(f.layout.addonDirectory, 'core.addon64'), coreBytes = fs.readFileSync(core);
  await fsp.unlink(core); const repair = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: repair.planId });
  assert.deepEqual(fs.readFileSync(core), coreBytes);
  fs.appendFileSync(f.layout.activeConfigPath, '[PERSONAL]\nKeepMore=7\n');
  const removed = await f.service.restore(f.game); assert.equal(removed.restored, true);
  const text = fs.readFileSync(f.layout.activeConfigPath, 'utf8'); assert.match(text, /KeepMore=7/); assert.match(text, /Keep=42/); assert.match(text, /PresetPath=personal.ini/);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(f.state.inspections, 0); assert.equal(f.state.launches, 0);
});
test('actual local launch still calls broker and refuses unsupported elevation', async t => {
  const f = fixture(t); await f.service.install(f.game); await assert.rejects(f.service.launch(f.game), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' });
  assert.equal(f.state.launches, 1); assert.equal((await f.service.inspect(f.game)).ready, true);
});
test('anti-cheat consent remains enforced with zero deployment writes', async t => {
  const f = fixture(t); f.state.antiCheat = true; const p = await f.service.previewInstall(f.game);
  await assert.rejects(f.service.install(f.game, { expectedPlanId: p.planId }), { code: 'ERR_ANTI_CHEAT_CONFIRM' });
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(fs.readFileSync(f.layout.activeConfigPath, 'utf8'), f.original);
});
test('game running still blocks preview', async t => {
  const f = fixture(t); f.state.running = true; await assert.rejects(f.service.previewInstall(f.game), { code: 'GAME_RUNNING' });
});
test('changed EXE after preview aborts before write', async t => {
  const f = fixture(t); const p = await f.service.previewInstall(f.game); fs.appendFileSync(f.exe, 'new game update');
  await assert.rejects(f.service.install(f.game, { expectedPlanId: p.planId }), { code: 'LEGACY_PLAN_CHANGED' });
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false);
});
test('changed destination is preserved after preview', async t => {
  const f = fixture(t), p = await f.service.previewInstall(f.game), target = path.join(f.dir, 'dxgi.dll'); fs.writeFileSync(target, 'another mod');
  await assert.rejects(f.service.install(f.game, { expectedPlanId: p.planId }), { code: 'LEGACY_PLAN_CHANGED' }); assert.equal(fs.readFileSync(target, 'utf8'), 'another mod');
});
test('write interruption rolls back files and leaves original settings', async t => {
  const f = fixture(t); f.state.afterWrite = ({ index }) => { if (index === 0) throw new Error('injected write interruption'); };
  await assert.rejects(f.service.install(f.game), /injected write interruption/);
  assert.equal(fs.existsSync(path.join(f.dir, 'dxgi.dll')), false); assert.equal(fs.readFileSync(f.layout.activeConfigPath, 'utf8'), f.original);
  assert.equal((await f.service.previewRecovery(f.game)).needsRecovery, false);
});
test('HoYo non-elevated route retains broker admission, not silently converted to local', async t => {
  const f = fixture(t, { source: 'hoyoshade-profile', level: 'asInvoker' });
  await assert.rejects(f.service.previewInstall(f.game, f.request), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' }); assert.equal(f.state.inspections, 1);
});
test('HoYo explicit elevated workflow keeps its existing special preflight', async t => {
  const f = fixture(t, { source: 'hoyoshade-profile' }); const p = await f.service.previewInstall(f.game, f.request);
  assert.equal(p.mode, 'hoyoshade'); assert.equal(f.state.inspections, 0); assert.equal(f.state.launches, 0);
});

// Whole production broker in a Windows-path/process-token double. No real user
// token is obtained. The elevation guard is before any helper invocation.
for (const level of ['requireAdministrator', 'highestAvailable']) {
  test(`broker ${level}: inspect and launch still reject, message is route-neutral`, async () => {
    let calls = 0;
    const file = 'C:\\Game\\game.exe';
    const source = loadOwner(brokerSource, { 'node:path': path.win32, 'node:fs': { existsSync: () => true, statSync: () => ({ isFile: () => true }) },
      '../core/pe': {}, './launch-safety': { noLinks: async () => {}, assertLaunchNotCancelled: safety.assertLaunchNotCancelled } });
    const b = source.createGameLaunchBroker({ platform: 'win32', scriptPath: 'C:\\helper.ps1', powershell: 'C:\\powershell.exe',
      executionLevel: () => level, peBitness: () => 64, runner: async () => { calls++; throw new Error('must not run'); } });
    await assert.rejects(b.inspect({ exe: file }), e => e.code === 'GAME_LAUNCH_REQUIRES_ELEVATION' && !e.message.includes('Vulkan'));
    await assert.rejects(b.launch({ exe: file }), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' }); assert.equal(calls, 0);
  });
}
test('reported 976121112-byte game completes local preview/install/restore with its full identity preserved', async t => {
  const f = fixture(t), size = 976121112;
  const handle = await fsp.open(f.exe, 'r+');
  try { await handle.truncate(size); await handle.write(Buffer.from('BOUNDARY-TAIL'), 0, 13, size - 13); }
  finally { await handle.close(); }
  const identity = await feeder.fileDigest(f.exe);
  const p = await f.service.previewInstall(f.game); await f.service.install(f.game, { expectedPlanId: p.planId });
  assert.equal(f.service.receipt(f.game).exeSha256, identity);
  assert.equal((await f.service.inspect(f.game)).ready, true);
  await f.service.restore(f.game);
  assert.equal(await feeder.fileDigest(f.exe), identity);
  assert.equal(fs.readFileSync(f.layout.activeConfigPath, 'utf8'), f.original);
  assert.equal(f.state.inspections, 0); assert.equal(f.state.launches, 0);
});
module.exports = { fixture };
