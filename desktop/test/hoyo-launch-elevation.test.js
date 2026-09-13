'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createHoYoLaunchPlans, createHoYoElevatedSessions, runHoYoRuntime, needsHoYoElevation, namespace } = require('../src/product/hoyo-launch-elevation');
const { createHoYoLauncher } = require('../src/product/hoyo-launcher');
const { HOYO_RECIPE, HOYO_CLIENTS, launcherRequest, fingerprint, validHoYoProfile } = require('../src/product/hoyoshade-profiles');
const { locations } = require('../src/product/operation-elevation');
const { emptyVerification } = require('../src/product/runtime-verification');

const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// Real RT_MANIFEST resource structure, not an execution-level override or a
// manifest-looking string appended outside the executable's resource table.
function manifestPe(level) {
  const manifest = Buffer.from(`<assembly xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`);
  const buffer = Buffer.alloc(0x1000), pe = 0x80, optional = pe + 24, section = optional + 0xf0;
  buffer.writeUInt16LE(0x5a4d); buffer.writeUInt32LE(pe, 0x3c); buffer.writeUInt32LE(0x4550, pe); buffer.writeUInt16LE(0x8664, pe + 4);
  buffer.writeUInt16LE(1, pe + 6); buffer.writeUInt16LE(0xf0, pe + 20); buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(0x1000, optional + 128); buffer.writeUInt32LE(0xc00, optional + 132);
  buffer.write('.rsrc\0', section); buffer.writeUInt32LE(0xc00, section + 8); buffer.writeUInt32LE(0x1000, section + 12);
  buffer.writeUInt32LE(0xc00, section + 16); buffer.writeUInt32LE(0x200, section + 20);
  for (const [offset, id, target] of [[0, 24, 0x80000020], [0x20, 1, 0x80000040], [0x40, 1033, 0x60]]) {
    buffer.writeUInt16LE(1, 0x200 + offset + 14); buffer.writeUInt32LE(id, 0x200 + offset + 16); buffer.writeUInt32LE(target, 0x200 + offset + 20);
  }
  buffer.writeUInt32LE(0x1100, 0x260); buffer.writeUInt32LE(manifest.length, 0x264); manifest.copy(buffer, 0x300); return buffer;
}

function fixture(t, level = 'requireAdministrator') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-launch-elevation-')), cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const userData = path.join(root, 'data'), game = path.join(root, 'game'), runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(game); fs.mkdirSync(runtimeDir);
  const exe = path.join(game, 'ZenlessZoneZero.exe'), launcherExe = path.join(root, 'launcher.exe'), config = path.join(runtimeDir, 'ReShade.ini');
  fs.writeFileSync(exe, manifestPe(level)); fs.writeFileSync(launcherExe, manifestPe('asInvoker')); fs.writeFileSync(config, '[ADDON]\r\nAddonPath=.\r\n');
  const modules = ['ReShade64.dll', 'Core.addon64'].map((name, index) => {
    const file = path.join(runtimeDir, name); fs.writeFileSync(file, Buffer.from('owned fixture module ' + index));
    return { path: file, expectedSha256: sha(file), role: index === 0 ? 'reshade' : 'core', status: 'enabled' };
  });
  const client = HOYO_CLIENTS.find(row => row.family === 'zzz' && row.channel === 'cn');
  const profile = { version: 1, recipeId: HOYO_RECIPE.id, sourceCommit: HOYO_RECIPE.sourceCommit, releaseCategory: 'public',
    exePath: exe, exeSha256: sha(exe), architecture: 64, family: 'zzz', channel: 'cn', inputRoute: 'feeder',
    launcher: { ...launcherRequest(client, { kind: 'hoyoplay', path: launcherExe }), sha256: sha(launcherExe) } };
  profile.bindingId = fingerprint(profile); assert.equal(validHoYoProfile(profile, exe), true);
  const layout = { installed: true, verified: true, source: 'hoyoshade-profile', loadingBackend: 'hoyoshade', mode: 'external', loadingMode: 'helper',
    gameId: 'zzz', exe, gameRoot: game, hoyoProfile: profile, bindingId: profile.bindingId, activeConfigPath: config, runtimeDir, generation: 'fixture-generation' };
  let time = Date.parse('2026-09-10T12:00:00Z'); const calls = { guards: [], execute: [] }, state = { deploymentReady: true, helperReady: true };
  const launcher = createHoYoLauncher({ broker: { launch: async () => { throw Error('A preview must not launch a process.'); } } });
  const options = { userData, now: () => time, service: { getLayout: () => layout, gameDirectory: () => game,
    inspectDeployment: async () => ({ ready: state.deploymentReady }) }, helper: { inspect: async () => ({ ready: state.helperReady, configHash: sha(config), modules }) },
    launcher, guards: { assertGameClosed: async (...args) => calls.guards.push(args) }, execute: async plan => { calls.execute.push(plan); return { applied: true }; } };
  const plans = createHoYoLaunchPlans(options);
  return { root, userData, game, exe, launcherExe, config, modules, layout, profile, plans, options, state, calls, cleanups,
    now: () => time, advance: amount => { time += amount; }, planFile: id => path.join(namespace(userData), 'launch-plans', id + '.json') };
}

test('launch plans bind a real administrator HoYo profile, executable, official launcher, config and module bytes before execution', async t => {
  const f = fixture(t), before = [f.exe, f.launcherExe, f.config, ...f.modules.map(row => row.path)].map(sha);
  assert.equal(needsHoYoElevation(f.layout), true);
  const plan = await f.plans.preview('zzz');
  assert.equal(plan.kind, 'hoyoshade-elevated-launch'); assert.equal(plan.exe, f.exe); assert.equal(plan.binding.exeSha256, sha(f.exe));
  assert.equal(plan.binding.launcher.path, f.launcherExe); assert.equal(plan.binding.launcher.sha256, sha(f.launcherExe));
  assert.equal(plan.binding.configHash, sha(f.config)); assert.equal(plan.binding.modules.length, 2);
  assert.equal(plan.expiresAt - plan.createdAt, 120000); assert.equal(f.calls.execute.length, 0);
  assert.deepEqual(await f.plans.loadPlan(plan.planId, plan.fingerprint), plan);
  await assert.rejects(f.plans.apply(plan.planId, { fingerprint: plan.fingerprint }), { code: 'HOYO_ELEVATION_WORKER_REQUIRED' });
  assert.equal((await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint })).applied, true);
  assert.equal(f.calls.execute.length, 1); assert.ok(f.calls.guards.every(args => args[0] === f.game && args[1] === f.exe));
  assert.deepEqual([f.exe, f.launcherExe, f.config, ...f.modules.map(row => row.path)].map(sha), before);
});

for (const mode of ['config', 'module', 'exe', 'launcher', 'generation', 'binding', 'expired']) test(`launch plan rejects ${mode} drift before any execution`, async t => {
  const f = fixture(t), plan = await f.plans.preview('zzz');
  if (mode === 'config') fs.appendFileSync(f.config, '; new personal setting\n');
  if (mode === 'module') fs.appendFileSync(f.modules[1].path, 'external replacement');
  if (mode === 'exe') fs.appendFileSync(f.exe, 'game update');
  if (mode === 'launcher') fs.appendFileSync(f.launcherExe, 'launcher update');
  if (mode === 'generation') f.layout.generation = 'repaired-after-preview';
  if (mode === 'binding') { const edited = structuredClone(plan); edited.binding.configHash = 'a'.repeat(64); fs.writeFileSync(f.planFile(plan.planId), JSON.stringify(edited)); }
  if (mode === 'expired') f.advance(120001);
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), error => /^(HOYO_ELEVATION_|HOYO_LAUNCH_)/.test(error.code));
  assert.equal(f.calls.execute.length, 0);
});

for (const expiry of ['extended', 'non-numeric']) test(`persisted launch plan cannot bypass its lifetime with an ${expiry} expiry`, async t => {
  const f = fixture(t), plan = await f.plans.preview('zzz'), edited = structuredClone(plan);
  edited.expiresAt = expiry === 'extended' ? plan.expiresAt + 86400000 : 'never';
  fs.writeFileSync(f.planFile(plan.planId), JSON.stringify(edited));
  await assert.rejects(f.plans.loadPlan(plan.planId, plan.fingerprint), { code: 'HOYO_ELEVATION_CHANGED' });
  assert.equal(f.calls.execute.length, 0);
});

test('only a verified administrator HoYo route can produce an elevated launch plan', async t => {
  for (const mode of ['ordinary', 'other-backend', 'invalid-profile', 'unverified', 'recovery', 'deployment', 'modules']) {
    const f = fixture(t, mode === 'ordinary' ? 'asInvoker' : 'requireAdministrator');
    if (mode === 'other-backend') f.layout.loadingBackend = 'external';
    if (mode === 'invalid-profile') f.layout.hoyoProfile = { ...f.profile, bindingId: '0'.repeat(64) };
    if (mode === 'unverified') f.layout.verified = false;
    if (mode === 'recovery') f.layout.needsRecovery = true;
    if (mode === 'deployment') f.state.deploymentReady = false;
    if (mode === 'modules') f.state.helperReady = false;
    await assert.rejects(f.plans.preview('zzz'), error => /^HOYO_ELEVATION_(ROUTE|NOT_READY)$/.test(error.code), mode);
    assert.equal(f.calls.execute.length, 0);
  }
});

function wrapped(f, { autoDispatch = true, previous = { active: false } } = {}) {
  const called = { normal: [], factories: [], applied: [], emitted: [], plans: [], broker: [] }, worker = deferred(), dispatched = { nonce: crypto.randomUUID(), requestHash: 'b'.repeat(64) };
  const created = deferred(), applying = deferred(), normalRow = { gameId: 'zzz', status: 'ordinary' };
  const normal = { start: async id => { called.normal.push(['start', id]); return normalRow; }, inspect: async id => { called.normal.push(['inspect', id]); return normalRow; },
    cancel: async id => { called.normal.push(['cancel', id]); return { cancelled: true }; }, dispose: async () => called.normal.push(['dispose']), live: () => normalRow };
  const plans = { ...f.plans, preview: async id => { const plan = await f.plans.preview(id); called.plans.push(plan); return plan; } };
  const sessions = createHoYoElevatedSessions({ userData: f.userData, plans, normal, getLayout: () => f.layout, now: f.now,
    emit: row => called.emitted.push(structuredClone(row)), processInfo: { platform: 'win32', pid: 11, execPath: path.join(f.root, 'manager.exe') },
    appPath: f.root, packaged: false, runPowerShell: () => { throw Error('Tests do not invoke UAC.'); }, elevationFactory: options => {
      called.factories.push(options); created.resolve(options);
      return { inspect: async () => { called.broker.push('inspect'); return previous; }, recover: async () => { called.broker.push('recover'); return { recovered: true }; },
        apply: async (...args) => { called.broker.push('apply'); called.applied.push(args); if (autoDispatch) await options.onDispatched(dispatched); applying.resolve(); return worker.promise; } };
    } });
  f.cleanups.push(async () => { worker.resolve({ applied: true }); await turn(); await sessions.dispose(); });
  const begin = async (waitForApply = true) => { const pending = sessions.start('zzz'); pending.catch(() => {}); const options = await created.promise; if (waitForApply) await applying.promise; return { pending, options }; };
  const row = (extra = {}) => { const sessionId = called.plans.at(-1)?.sessionId || '11111111-1111-4111-8111-111111111111'; return { version: 1, gameId: 'zzz', sessionId,
    targetExe: f.exe, requestedAt: new Date(f.now()).toISOString(), status: 'waiting-launcher', helper: { status: 'starting' }, process: null, ...extra }; };
  const progress = (options, session, verification = null, checkedAt = f.now()) => options.onProgress({ session, verification, checkedAt: new Date(checkedAt).toISOString() });
  return { sessions, normalRow, called, worker, dispatched, begin, row, progress };
}

test('ordinary and non-HoYo sessions retain the normal adapter without creating a UAC worker or launch plan', async t => {
  for (const mode of ['ordinary', 'non-HoYo']) {
    const f = fixture(t, mode === 'ordinary' ? 'asInvoker' : 'requireAdministrator'); if (mode === 'non-HoYo') f.layout.loadingBackend = 'external';
    const w = wrapped(f); assert.deepEqual(await w.sessions.start('zzz'), w.normalRow);
    assert.equal(w.called.factories.length, 0); assert.equal(w.called.plans.length, 0); assert.deepEqual(w.called.normal, [['start', 'zzz']]);
  }
});

test('administrator dispatch uses its separate namespace and cancellation writes only the bound helper request', async t => {
  const f = fixture(t), w = wrapped(f), { pending, options } = await w.begin(), row = w.row();
  w.progress(options, row); const session = await pending;
  assert.equal(session.elevated, true); assert.equal(options.userData, namespace(f.userData)); assert.equal(options.workerFlag, '--hoyo-launch-worker');
  assert.equal(w.called.applied[0][0], 'zzz'); assert.equal(w.called.applied[0][2].confirm, true);
  assert.deepEqual(await w.sessions.start('zzz'), session); assert.equal(w.called.factories.length, 1); assert.equal(w.called.applied.length, 1);
  assert.deepEqual(await w.sessions.cancel('zzz'), { cancelled: true, gamePreserved: true });
  const cancel = JSON.parse(fs.readFileSync(locations(namespace(f.userData), w.dispatched.nonce).cancel, 'utf8'));
  assert.deepEqual(cancel, { version: 1, nonce: w.dispatched.nonce, requestHash: w.dispatched.requestHash, cancel: true });
  assert.equal(fs.existsSync(locations(f.userData, w.dispatched.nonce).cancel), false); assert.deepEqual(w.called.normal, []);
});

test('recoverable old worker records are recovered before dispatch, while a live old worker prevents a second launch', async t => {
  for (const canRecover of [true, false]) {
    const f = fixture(t), w = wrapped(f, { previous: { active: true, canRecover } }), { pending, options } = await w.begin(canRecover);
    if (canRecover) { w.progress(options, w.row()); await pending; assert.deepEqual(w.called.broker, ['inspect', 'recover', 'apply']); }
    else { await assert.rejects(pending, { code: 'HOYO_ELEVATION_BUSY' }); assert.deepEqual(w.called.broker, ['inspect']); assert.equal(w.called.applied.length, 0); }
  }
});

test('concurrent first clicks cannot create two administrator workers while the launch plan is still being prepared', async t => {
  const f = fixture(t), plan = await f.plans.preview('zzz'), gate = deferred(); let previews = 0;
  f.plans.preview = async () => { previews++; await gate.promise; return plan; };
  const w = wrapped(f), first = w.sessions.start('zzz'), second = w.sessions.start('zzz'); first.catch(() => {}); second.catch(() => {});
  await turn(); gate.resolve(); await turn();
  assert.equal(previews, 1); assert.equal(w.called.factories.length, 1);
});

test('cancelling while a launch plan is being prepared prevents any later UAC dispatch', async t => {
  const f = fixture(t), plan = await f.plans.preview('zzz'), gate = deferred();
  f.plans.preview = async () => { await gate.promise; return plan; };
  const w = wrapped(f), pending = w.sessions.start('zzz'); pending.catch(() => {});
  await turn(); await w.sessions.cancel('zzz'); gate.resolve(); await turn();
  assert.equal(w.called.applied.length, 0); assert.equal(w.called.normal.some(row => row[0] === 'cancel'), false);
  await assert.rejects(pending, { code: 'HOYO_ELEVATION_CANCELLED' });
});

test('cancellation requested while UAC dispatch is pending is retained for the eventual owned helper', async t => {
  const f = fixture(t), w = wrapped(f, { autoDispatch: false }), { options } = await w.begin();
  assert.deepEqual(await w.sessions.cancel('zzz'), { cancelled: true, gamePreserved: true });
  await options.onDispatched(w.dispatched); await turn();
  const cancelFile = locations(namespace(f.userData), w.dispatched.nonce).cancel;
  assert.equal(fs.existsSync(cancelFile), true, 'a cancelled UAC wait must not become an uncancelled helper after dispatch');
});

test('ordinary HoYo sessions receive the same cancellation token and an already cancelled request cannot create a UAC plan', async t => {
  const f = fixture(t, 'asInvoker'); let received, previews = 0, cancelled = false;
  const controls = { cancelled: () => cancelled };
  const sessions = createHoYoElevatedSessions({ userData: f.userData, getLayout: () => f.layout,
    plans: { preview: async () => { previews++; } }, normal: { start: async (_id, value) => { received = value; return {}; } } });
  await sessions.start('zzz', controls); assert.equal(received, controls);
  cancelled = true;
  await assert.rejects(sessions.start('zzz', controls), { code: 'LAUNCH_CANCELLED' }); assert.equal(previews, 0);
});

test('HoYo cancellation can write its bound request before the UAC child is announced', async t => {
  const f = fixture(t), w = wrapped(f, { autoDispatch: false }), { options } = await w.begin();
  await options.onReserved(w.dispatched);
  await w.sessions.cancel('zzz');
  const cancel = JSON.parse(fs.readFileSync(locations(namespace(f.userData), w.dispatched.nonce).cancel, 'utf8'));
  assert.deepEqual(cancel, { version: 1, nonce: w.dispatched.nonce, requestHash: w.dispatched.requestHash, cancel: true });
  assert.equal(options.cancelled(), true); assert.deepEqual(w.called.normal, []);
});

for (const mode of ['game', 'exe', 'invalid-session']) test(`administrator progress rejects a mismatched ${mode} identity before accepting a launch`, async t => {
  const f = fixture(t), w = wrapped(f), { options } = await w.begin(), row = w.row();
  if (mode === 'game') row.gameId = 'another-game';
  if (mode === 'exe') row.targetExe = path.join(f.root, 'another', 'ZenlessZoneZero.exe');
  if (mode === 'invalid-session') row.sessionId = 'old-session';
  assert.throws(() => w.progress(options, row), { code: 'HOYO_ELEVATION_PROGRESS' }); assert.equal(w.called.emitted.length, 0);
});

test('a valid first administrator session cannot be replaced by another valid UUID from the same game', async t => {
  const f = fixture(t), w = wrapped(f), { pending, options } = await w.begin(), row = w.row();
  w.progress(options, row); await pending;
  assert.throws(() => w.progress(options, { ...row, sessionId: crypto.randomUUID() }), { code: 'HOYO_ELEVATION_PROGRESS' });
  assert.equal((await w.sessions.inspect('zzz')).sessionId, row.sessionId);
});

test('matched administrator process identity remains fixed across later progress updates', async t => {
  const f = fixture(t), w = wrapped(f), { pending, options } = await w.begin(), row = w.row({ status: 'waiting-enhancement',
    process: { pid: 42, exe: f.exe, startedAt: new Date(f.now()).toISOString() } });
  w.progress(options, row); await pending;
  for (const process of [{ ...row.process, pid: 43 }, { ...row.process, startedAt: new Date(f.now() + 1000).toISOString() }])
    assert.throws(() => w.progress(options, { ...row, process }), { code: 'HOYO_ELEVATION_PROGRESS' });
});

function passed(session) { const result = emptyVerification(session.helper, session); result.nr = { status: 'passed', detail: 'Current-session strict fixture evidence.', evidence: [] }; return result; }
test('NR evidence expires after 15 seconds and immediately when its worker ends', async t => {
  const f = fixture(t), w = wrapped(f), { pending, options } = await w.begin(), row = w.row();
  w.progress(options, row, passed(row)); const session = await pending;
  assert.equal((await w.sessions.assess('zzz', session)).nr.status, 'passed');
  f.advance(15001); assert.equal((await w.sessions.assess('zzz', session)).nr.status, 'unverified');
  w.progress(options, row, passed(row)); assert.equal((await w.sessions.assess('zzz', session)).nr.status, 'passed');
  w.worker.resolve({ applied: true }); await turn(); assert.equal((await w.sessions.assess('zzz', session)).nr.status, 'unverified');
});

test('a delayed administrator observation cannot refresh evidence already older than 15 seconds', async t => {
  const f = fixture(t), w = wrapped(f), { pending, options } = await w.begin(), row = w.row();
  w.progress(options, row, passed(row)); const session = await pending;
  f.advance(20000); w.progress(options, row, passed(row), f.now() - 19999);
  assert.equal((await w.sessions.assess('zzz', session)).nr.status, 'unverified');
});

test('cached administrator NR evidence is not returned for a different target with the same session UUID', async t => {
  const f = fixture(t), w = wrapped(f), { pending, options } = await w.begin(), row = w.row();
  w.progress(options, row, passed(row)); const session = await pending;
  assert.equal((await w.sessions.assess('zzz', { ...session, targetExe: path.join(f.root, 'other.exe') })).nr.status, 'unverified');
});

function runtimeFixture() {
  let time = Date.parse('2026-09-10T12:00:00Z'); const events = [], calls = [], row = { gameId: 'zzz', sessionId: crypto.randomUUID(),
    targetExe: path.resolve('fixture-ZenlessZoneZero.exe'), status: 'waiting-enhancement', process: { pid: 42, startedAt: '2026-09-10T12:00:00Z' }, helper: { status: 'starting' } };
  let observations = 0;
  const options = { plan: { gameId: 'zzz' }, now: () => time, delay: async ms => { time += ms; },
    sessions: { start: async id => { calls.push(['start', id]); return row; }, inspect: async () => row, cancel: id => calls.push(['cancel-helper', id]), dispose: async () => calls.push(['dispose-helper']) },
    processes: { find: async () => ++observations <= 2 ? [row.process] : [] }, verification: { assess: async () => { calls.push(['assess']); return passed(row); } },
    controls: { cancelled: async () => false, parentAlive: async () => true, publish: async value => events.push(value) } };
  return { options, row, events, calls };
}

test('runtime monitoring publishes strict current-session observations and clears them on natural game exit', async () => {
  const f = runtimeFixture(), result = await runHoYoRuntime(f.options);
  assert.equal(f.events.length, 3); assert.equal(f.events[0].verification.nr.status, 'passed'); assert.equal(f.events[1].verification.nr.status, 'passed');
  assert.equal(f.events[2].session.status, 'game-exited'); assert.equal(f.events[2].verification.nr.status, 'unverified');
  assert.equal(f.events.every(event => event.session.elevated === true), true);
  assert.deepEqual(result, { applied: true, gamePreserved: true, monitoringEnded: true, cancelled: false, runtimeVerified: false });
  assert.deepEqual(f.calls.filter(row => row[0] !== 'assess'), [['start', 'zzz'], ['dispose-helper']]);
});

for (const mode of ['cancel', 'parent-exit']) test(`runtime ${mode} while waiting requests helper cancellation and preserves the game`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = runtimeFixture(), started = deferred(), entered = deferred();
  f.options.sessions.start = async () => { f.calls.push(['start', 'zzz']); entered.resolve(); return started.promise; };
  const running = runHoYoRuntime(f.options); await entered.promise;
  if (mode === 'cancel') f.options.controls.cancelled = async () => true; else f.options.controls.parentAlive = async () => false;
  t.mock.timers.tick(1000); await turn(); started.resolve(f.row);
  const result = await running;
  assert.equal(result.cancelled, true); assert.equal(result.gamePreserved, true); assert.equal(f.events.length, 0);
  assert.deepEqual(f.calls, [['start', 'zzz'], ['cancel-helper', 'zzz'], ['dispose-helper']]);
});

test('a HoYo worker observes a cancellation recorded before its first session and creates no helper or launch', async () => {
  const f = runtimeFixture(); f.options.controls.cancelled = async () => true;
  const result = await runHoYoRuntime(f.options);
  assert.equal(result.cancelled, true); assert.equal(result.gamePreserved, true);
  assert.deepEqual(f.calls, [['dispose-helper']]); assert.equal(f.events.length, 0);
});

test('a cancellation during a verification read cannot publish a new passed NR observation afterward', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] }); const f = runtimeFixture(), assessing = deferred(), finishAssessment = deferred();
  f.options.verification.assess = async () => { assessing.resolve(); return finishAssessment.promise; };
  const running = runHoYoRuntime(f.options); await assessing.promise;
  f.options.controls.cancelled = async () => true; t.mock.timers.tick(1000); await turn(); finishAssessment.resolve(passed(f.row));
  assert.equal((await running).cancelled, true); assert.equal(f.events.some(row => row.verification.nr.status === 'passed'), false);
});
