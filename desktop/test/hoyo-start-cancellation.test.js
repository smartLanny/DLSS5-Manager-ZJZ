'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHoYoWorkflow } = require('../src/product/hoyo-workflow');
const { createLaunchCoordinator } = require('../src/product/launch-coordinator');
const { createLaunchSessions } = require('../src/product/launch-session');
const { createHoYoLauncher } = require('../src/product/hoyo-launcher');
const { HOYO_RECIPE, HOYO_CLIENTS, launcherRequest, fingerprint } = require('../src/product/hoyoshade-profiles');
const { emptyVerification } = require('../src/product/runtime-verification');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function fixture(t, kind = 'hoyoplay') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-start-cancel-'));
  const userData = path.join(root, 'data'), exe = path.join(root, 'ZenlessZoneZero.exe');
  const launcherFile = path.join(root, kind === 'starward' ? 'Starward.exe' : 'launcher.exe');
  fs.writeFileSync(exe, 'isolated game identity'); fs.writeFileSync(launcherFile, 'isolated launcher identity');
  const launcher = { id: 'launcher', kind, path: launcherFile, sha256: digest(launcherFile), available: true };
  const client = HOYO_CLIENTS.find(row => row.family === 'zzz' && row.channel === 'cn');
  const body = { version: 1, recipeId: HOYO_RECIPE.id, sourceCommit: HOYO_RECIPE.sourceCommit, family: 'zzz', channel: 'cn',
    releaseCategory: 'public', inputRoute: 'native', exePath: exe, exeSha256: digest(exe), architecture: 64,
    launcher: { ...launcherRequest(client, launcher), sha256: launcher.sha256 } };
  const hoyoProfile = { ...body, bindingId: fingerprint(body) };
  const layout = { installed: true, ready: true, verified: true, api: 'dx11', loadingBackend: 'hoyoshade',
    source: 'hoyoshade-profile', exe, gameId: 'game', hoyoProfile, bindingId: hoyoProfile.bindingId, launcher: hoyoProfile.launcher };
  const row = { id: 'client', exePath: exe, gameRoot: root, family: 'zzz', channel: 'cn', exeSha256: body.exeSha256,
    launchers: [launcher], automaticBinding: { family: 'zzz', channel: 'cn', launcher }, evidence: [], warnings: [] };
  const calls = { settings: 0, helperStarts: 0, helperStops: 0, launchers: [], protocol: 0 };
  const gates = {}, entered = { validate: deferred(), target: deferred(), prepare: deferred(), protocol: deferred() };
  const broker = { launch: async request => { calls.launchers.push(request); } };
  const adapter = createHoYoLauncher({ broker, readExecutionLevel: () => 'asInvoker', readProtocol: async () => {
    calls.protocol++;
    if (gates.protocol && calls.protocol === 2) { entered.protocol.resolve(); await gates.protocol.promise; }
    return { enabled: true, command: `"${launcherFile}" "%1"` };
  } });
  const sessions = createLaunchSessions({ userData, broker,
    game: async () => { if (gates.target) { entered.target.resolve(); await gates.target.promise; } return adapter.resolve(layout); },
    helper: { prepare: async request => { if (gates.prepare) { entered.prepare.resolve(); await gates.prepare.promise; } return { ...request, configHash: 'fixture-config' }; },
      start: async session => { calls.helperStarts++; return session; }, alive: () => true, watch: async () => {},
      stop: async () => { calls.helperStops++; return { status: 'stopped' }; } },
    launchHoYo: (_id, _target, controls) => adapter.launch(layout, controls),
    processes: { find: async () => calls.launchers.length ? [{ pid: 88, exe, startedAt: new Date().toISOString() }] : [] } });
  const game = { id: 'game', dir: root, name: 'Fixture', chosen: { path: exe } };
  const service = { listGames: async () => [game], assessmentSeed: () => ({ ...game, scan: { chosen: { apiResolution: { api: 'dx11', source: 'game-config' } } } }),
    inspectDeployment: async () => structuredClone(layout), gameDirectory: () => root, gameExecutable: () => exe,
    validateLaunch: async () => { if (gates.validate) { entered.validate.resolve(); await gates.validate.promise; } } };
  const coordinator = createLaunchCoordinator({ service, guards: { assertGameClosed: async () => {} }, legacySrModel: {},
    settings: { assertReady: async () => {}, beforeLaunch: async () => { calls.settings++; return []; }, hasSrRequest: async () => true, inspect: async () => ({ applied: {} }) },
    launchGame: (id, controls) => sessions.start(id, controls) });
  const workflow = createHoYoWorkflow({ userData, service, launches: sessions,
    operations: { inspect: async () => ({ pending: false }), assertReady: async () => {} },
    discovery: { discover: async () => ({ games: [structuredClone(row)], launchers: [launcher] }), inspectLauncher: async () => launcher },
    verification: { assess: async () => emptyVerification(null, null) },
    launch: (id, controls) => coordinator.serialize(() => coordinator.launch(id, controls)) });
  t.after(async () => {
    for (const gate of Object.values(gates)) gate.resolve();
    await sessions.dispose(); await coordinator.serialize(async () => {});
    assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await workflow.discover()).games[0].phase, 'ready');
  return { root, exe, workflow, coordinator, sessions, gates, entered, calls,
    drain: async () => { await coordinator.serialize(async () => {}); await tick(); } };
}

test('cancel invalidates a queued HoYo start while its eventual completion cannot cancel or clear a later start', async t => {
  const f = await fixture(t), occupied = deferred();
  f.gates.queue = occupied; void f.coordinator.serialize(() => occupied.promise); await tick();
  await f.workflow.start('client'); assert.equal(f.calls.launchers.length, 0);
  assert.equal((await f.workflow.cancel('client')).phase, 'ready');
  f.gates.validate = deferred(); await f.workflow.start('client');
  occupied.resolve(); await f.entered.validate.promise; await tick();
  await assert.rejects(f.workflow.start('client'), { code: 'HOYO_LAUNCH_BUSY' });
  assert.equal(f.calls.launchers.length, 0); f.gates.validate.resolve(); await f.drain();
  assert.equal(f.calls.settings, 1); assert.equal(f.calls.helperStarts, 1); assert.equal(f.calls.launchers.length, 1);
  assert.equal((await f.workflow.inspect('client')).error, null);
});

for (const boundary of ['validate', 'target', 'prepare']) test(`HoYo cancellation during ${boundary} prevents every later helper or launcher dispatch`, async t => {
  const f = await fixture(t); f.gates[boundary] = deferred();
  await f.workflow.start('client'); await f.entered[boundary].promise;
  await f.workflow.cancel('client'); f.gates[boundary].resolve(); await f.drain();
  assert.equal(f.calls.helperStarts, 0); assert.equal(f.calls.launchers.length, 0);
  if (boundary === 'validate') assert.equal(f.calls.settings, 0);
  if (boundary === 'prepare') assert.equal(f.calls.helperStops, 1, 'only the prepared owned helper is cleaned');
  assert.equal(fs.readFileSync(f.exe, 'utf8'), 'isolated game identity');
});

test('cancel during the final Starward protocol recheck prevents the real launcher adapter from dispatching', async t => {
  const f = await fixture(t, 'starward'); f.gates.protocol = deferred();
  await f.workflow.start('client'); await f.entered.protocol.promise;
  await f.workflow.cancel('client'); f.gates.protocol.resolve(); await f.drain();
  assert.equal(f.calls.helperStarts, 1); assert.equal(f.calls.launchers.length, 0); assert.equal(f.calls.helperStops, 1);
});
