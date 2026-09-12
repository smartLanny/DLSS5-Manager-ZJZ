'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHoYoWorkflow } = require('../src/product/hoyo-workflow');
const { emptyVerification } = require('../src/product/runtime-verification');
const { HOYO_RECIPE, HOYO_CLIENTS, launcherRequest, fingerprint } = require('../src/product/hoyoshade-profiles');
const copy = value => structuredClone(value);
const failed = (code, message = code) => Object.assign(new Error(message), { code });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameRoot = path.join(root, 'ZZZ Game'), exe = path.join(gameRoot, 'ZenlessZoneZero.exe');
  const hyp = { id: 'hyp', kind: 'hoyoplay', path: path.join(root, 'HoYoPlay', 'launcher.exe'), sha256: 'b'.repeat(64), available: true };
  const starward = { id: 'starward', kind: 'starward', path: path.join(root, 'Starward', 'Starward.exe'), sha256: 'c'.repeat(64), available: true };
  const discovered = { id: 'client-zzz', exePath: exe, gameRoot, family: 'zzz', familyLabel: '绝区零', channel: 'cn', gameBiz: 'nap_cn',
    gameVersion: '3.2.0', architecture: 64, releaseCategory: 'public', exeSha256: 'a'.repeat(64), channelCandidates: ['cn', 'bilibili', 'global'],
    launchers: [{ ...hyp, matched: true, channel: 'cn' }], automaticBinding: { family: 'zzz', channel: 'cn', launcher: { kind: hyp.kind, path: hyp.path } }, evidence: [], warnings: [] };
  const calls = [], state = { games: [], session: null, deployment: { installed: false, ready: false }, pending: { pending: false },
    deploymentError: null, applyError: null, recoverError: null, api: 'dx11', discovery: { games: [discovered], launchers: [hyp, starward], warnings: [] }, plans: new Map(), nextPlan: 0 };
  function installedState(api = state.api, selection = discovered.automaticBinding) {
    const client = HOYO_CLIENTS.find(row => row.family === selection.family && row.channel === selection.channel);
    const launcher = state.discovery.launchers.find(row => row.path === selection.launcher.path && row.kind === selection.launcher.kind);
    const body = { version: 1, recipeId: HOYO_RECIPE.id, sourceCommit: HOYO_RECIPE.sourceCommit, family: client.family, channel: client.channel,
      releaseCategory: 'public', inputRoute: 'native', exePath: exe, exeSha256: discovered.exeSha256, architecture: 64,
      launcher: { ...launcherRequest(client, launcher), sha256: launcher.sha256 } };
    const hoyoProfile = { ...body, bindingId: fingerprint(body) };
    return { installed: true, ready: true, loadingBackend: 'hoyoshade', api, hoyoProfile, launcher: hoyoProfile.launcher, bindingId: hoyoProfile.bindingId };
  }
  const service = {
    async listGames() { return copy(state.games); },
    async addManualSelection(input) { calls.push(['register', copy(input)]); state.games.push({ id: 'game-' + (state.games.length + 1), name: input.name, dir: input.root, chosen: { path: input.executable } }); return copy(state.games); },
    markHoYoGame(id) { calls.push(['mark', id]); },
    assessmentSeed(id) { return { ...copy(state.games.find(g => g.id === id)), scan: { chosen: { path: exe, apiResolution: { api: state.api, source: 'game-config', evidence: [] } } } }; },
    async inspectDeployment(id) { calls.push(['inspectDeployment', id]); if (state.deploymentError) throw state.deploymentError; return copy(state.deployment); },
    async refresh() { calls.push(['refresh']); },
    async recoverDeployment(id) { calls.push(['recoverDeployment', id]); if (state.recoverError) throw state.recoverError; state.deployment.needsRecovery = false; }
  };
  const operations = {
    async inspect(id) { calls.push(['pending', id]); return copy(state.pending); },
    async preview(gameId, request) { const n = ++state.nextPlan, plan = { gameId, planId: 'plan-' + n, fingerprint: String(n).repeat(64), request: copy(request), changes: [], blockers: [] }; calls.push(['preview', gameId, request]); state.plans.set(plan.planId, plan); return copy(plan); },
    async loadPlan(planId, fingerprint) { calls.push(['loadPlan', planId, fingerprint]); const plan = state.plans.get(planId); if (!plan || plan.fingerprint !== fingerprint) throw failed('OPERATION_PLAN_CHANGED'); return copy(plan); },
    async apply(planId, consent) { calls.push(['apply', planId, consent]); if (state.applyError) throw state.applyError; const plan = state.plans.get(planId); state.deployment = plan.request.uninstall ? { installed: false, ready: false } : installedState(plan.request.api || state.deployment.api, plan.request.hoyo || discovered.automaticBinding); },
    async recover(id) { calls.push(['recover', id]); if (state.recoverError) throw state.recoverError; state.pending = { pending: false }; },
    async assertReady(id) { calls.push(['assertReady', id]); if (state.readyGate) await state.readyGate.promise; }
  };
  const launches = {
    async inspect(id) { calls.push(['session', id]); return copy(state.session); },
    async cancel(id) { calls.push(['cancel', id]); if (state.session) state.session = { ...state.session, status: 'cancelled' }; }
  };
  const discovery = {
    async discover() { calls.push(['discover']); return copy(state.discovery); },
    async inspectGame(file) { return { games: state.discovery.games.filter(row => row.exePath === file || row.gameRoot === file).map(copy), warnings: [] }; },
    async inspectLauncher(file, kind) { const row = state.discovery.launchers.find(row => row.path === file && row.kind === kind); return row?.available === false ? null : row ? copy(row) : null; }
  };
  const userData = path.join(root, 'manager-data'), dependencies = { userData, service, operations, launches, discovery,
    verification: { async assess() { return emptyVerification(null, null); } },
    async launch(id) { calls.push(['launch', id]); if (state.launchImpl) return state.launchImpl(id); },
    async elevatedApply(id, planId, consent) { calls.push(['elevatedApply', id, planId]); return operations.apply(planId, consent); },
    async beforeMutation(id) { calls.push(['beforeMutation', id]); }, ...overrides };
  return { root, userData, exe, hyp, starward, discovered, state, calls, dependencies, installedState, create: () => createHoYoWorkflow(dependencies),
    async ready(flow) { await flow.discover(); state.deployment = installedState(); },
    count(name) { return calls.filter(row => row[0] === name).length; } };
}

test('a unique recorded client binds automatically and registers the game EXE once', async t => {
  const f = fixture(t), flow = f.create(), result = await flow.discover();
  assert.equal(result.games[0].binding.status, 'confirmed'); assert.equal(result.games[0].phase, 'install');
  assert.equal(f.count('register'), 1); assert.equal(f.calls.find(row => row[0] === 'register')[1].executable, f.exe);
  const saved = JSON.parse(fs.readFileSync(path.join(f.userData, 'hoyo-bindings.json'))).bindings[0];
  assert.equal(saved.exePath, f.exe); assert.equal(saved.launcher.path, f.hyp.path); assert.equal(saved.confirmed, true);
  await flow.discover(); assert.equal(f.count('register'), 1);
});

test('installed HoYo inspection exposes metadata-only legacy SR readiness before the editor opens', async t => {
  const seen = [];
  const f = fixture(t, { inspectLaunchReadiness: async id => {
    seen.push(id);
    return { state: 'blocked', known: true, source: 'metadata', pending: [],
      blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '旧 SR 设置需要先应用。', action: { kind: 'open-settings' } }] };
  } });
  const flow = f.create(); await f.ready(flow);
  const result = await flow.inspect('client-zzz');
  assert.deepEqual(seen, ['game-1']);
  assert.equal(result.launchReadiness.state, 'blocked');
  assert.equal(result.launchReadiness.blockers[0].code, 'SETTINGS_LEGACY_APPLY_REQUIRED');
  assert.equal(result.launchReadiness.blockers[0].action.kind, 'open-settings');
  assert.equal(result.phase, 'ready'); assert.equal(result.installation.ready, true);
});

test('installed managed HoYo flow reports ready when metadata readiness has no legacy blocker', async t => {
  const f = fixture(t, { inspectLaunchReadiness: async () => ({ state: 'ready', known: true, source: 'metadata', pending: [], blockers: [] }) });
  const flow = f.create(); await f.ready(flow);
  const result = await flow.inspect('client-zzz');
  assert.equal(result.launchReadiness.state, 'ready'); assert.deepEqual(result.launchReadiness.blockers, []);
  assert.equal(result.phase, 'ready'); assert.equal(result.installation.ready, true);
});

test('metadata-only unknown readiness is surfaced without pretending the readiness check passed', async t => {
  const f = fixture(t, { inspectLaunchReadiness: async () => ({ state: 'unknown', known: false, source: 'metadata', pending: [],
    blockers: [{ domain: 'settings', code: 'SETTINGS_EVIDENCE_UNAVAILABLE', message: '启动设置暂时无法确认。', known: false, action: { kind: 'open-settings' } }] }) });
  const flow = f.create(); await f.ready(flow);
  const result = await flow.inspect('client-zzz');
  assert.equal(result.launchReadiness.state, 'unknown'); assert.equal(result.launchReadiness.known, false);
  assert.equal(result.launchReadiness.blockers[0].action.kind, 'open-settings');
  assert.equal(result.phase, 'ready'); assert.equal(result.installation.ready, true);
});

test('readiness callback failure returns an actionable unknown state and keeps the old flow contract', async t => {
  const f = fixture(t, { inspectLaunchReadiness: async () => { throw failed('SETTINGS_READINESS_IO', '启动设置元数据读取失败。'); } });
  const flow = f.create(); await f.ready(flow);
  const result = await flow.inspect('client-zzz');
  assert.equal(result.launchReadiness.state, 'unknown'); assert.equal(result.launchReadiness.known, false);
  assert.equal(result.launchReadiness.blockers[0].code, 'SETTINGS_READINESS_IO');
  assert.equal(result.launchReadiness.blockers[0].action.kind, 'open-settings');
  assert.equal(result.phase, 'ready'); assert.equal(result.installation.ready, true);
});

test('legacy fixtures without a readiness callback keep the original response shape', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  assert.equal(Object.hasOwn(await flow.inspect('client-zzz'), 'launchReadiness'), false);
});

test('manual launcher, channel and API survive recreation and take precedence over automatic defaults', async t => {
  const f = fixture(t), first = f.create(); await first.discover();
  const bound = await first.bind('client-zzz', { channel: 'bilibili', launcherId: 'starward', api: 'dx12' });
  assert.equal(bound.binding.launcher.path, f.starward.path); assert.equal(bound.api.api, 'dx12');
  f.state.api = 'dx11';
  const reopened = (await f.create().discover()).games[0];
  assert.equal(reopened.channel, 'bilibili'); assert.equal(reopened.binding.launcher.path, f.starward.path);
  assert.equal(reopened.api.api, 'dx12'); assert.equal(reopened.api.source, 'user-selection'); assert.equal(reopened.binding.status, 'confirmed');
});

test('ambiguous channels and launchers stop before installation until the exact choice is confirmed', async t => {
  const f = fixture(t); f.discovered.channel = null; f.discovered.automaticBinding = null;
  f.discovered.launchers.push({ ...f.starward, matched: true, channel: 'bilibili' });
  const flow = f.create(), result = (await flow.discover()).games[0];
  assert.equal(result.phase, 'binding'); assert.equal(result.binding.status, 'missing');
  await assert.rejects(flow.preview('client-zzz'), { code: 'HOYO_BINDING_REQUIRED' }); assert.equal(f.count('preview'), 0);
  const selected = await flow.bind('client-zzz', { channel: 'bilibili', launcherId: 'starward' });
  assert.equal(selected.phase, 'install'); assert.equal(selected.channel, 'bilibili');
  const plan = await flow.preview('client-zzz'); assert.equal(plan.request.hoyo.launcher.path, f.starward.path);
});

test('unknown API requires an explicit supported API before preview and no launcher API is inferred', async t => {
  const f = fixture(t); f.state.api = 'mixed'; const flow = f.create();
  assert.equal((await flow.discover()).games[0].phase, 'api');
  await assert.rejects(flow.preview('client-zzz'), { code: 'HOYO_BINDING_REQUIRED' });
  await assert.rejects(flow.bind('client-zzz', { api: 'dx9' }), { code: 'HOYO_API' });
  assert.equal((await flow.bind('client-zzz', { api: 'dx12' })).phase, 'install');
  assert.equal((await flow.preview('client-zzz')).request.api, 'dx12');
});

test('installation errors and deployment inspection failures never yield ready; explicit recheck clears a transient apply error', async t => {
  const f = fixture(t), flow = f.create(); await flow.discover(); const plan = await flow.preview('client-zzz');
  f.state.applyError = failed('INSTALL_FAILED', '安装失败');
  const result = await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.equal(result.phase, 'failed'); assert.equal(result.installation.ready, false); assert.equal(result.error.code, 'INSTALL_FAILED');
  assert.equal((await flow.inspect('client-zzz')).error.code, 'INSTALL_FAILED');
  f.state.deployment = f.installedState(); f.state.deploymentError = failed('RECEIPT_UNREADABLE');
  const unreadable = await flow.inspect('client-zzz', { retry: true }); assert.equal(unreadable.installation.ready, false); assert.equal(unreadable.phase, 'recovery');
  f.state.deploymentError = null; assert.equal((await flow.inspect('client-zzz', { retry: true })).phase, 'ready');
});

test('pending recovery has priority over binding, installed status and launch errors, and delegates both recovery owners', async t => {
  const f = fixture(t); f.discovered.automaticBinding = null; f.state.pending = { pending: true };
  f.state.session = { sessionId: 's1', historical: false, status: 'failed', error: { code: 'LAUNCH_FAILED', message: '启动失败' } };
  const flow = f.create(), result = (await flow.discover()).games[0];
  assert.equal(result.phase, 'recovery'); assert.equal(result.nextAction, 'recover');
  await assert.rejects(flow.preview('client-zzz'), { code: 'HOYO_RECOVERY_REQUIRED' });
  const recovered = await flow.recover('client-zzz'); assert.equal(f.count('recover'), 1); assert.equal(f.count('recoverDeployment'), 1);
  assert.equal(recovered.installation.needsRecovery, false); assert.equal(recovered.installation.ready, false);
});

test('background start returns before the launcher completes and reports helper then launcher session phases', async t => {
  const f = fixture(t), flow = f.create(), helper = deferred(), official = deferred(); await f.ready(flow);
  f.state.launchImpl = async () => {
    f.state.session = { sessionId: 's1', historical: false, status: 'waiting-helper' }; await helper.promise;
    f.calls.push(['official-launcher']); f.state.session.status = 'waiting-game'; await official.promise;
  };
  const started = await flow.start('client-zzz'); assert.equal(started.phase, 'waiting-helper'); assert.equal(f.count('launch'), 1); assert.equal(f.count('official-launcher'), 0);
  assert.equal((await flow.inspect('client-zzz')).phase, 'waiting-helper');
  helper.resolve(); await tick(); assert.equal((await flow.inspect('client-zzz')).phase, 'waiting-game'); assert.equal(f.count('official-launcher'), 1);
  official.resolve(); await tick();
});

test('background launch errors remain visible during polling and clear only on explicit retry', async t => {
  const f = fixture(t), flow = f.create(), work = deferred(); await f.ready(flow);
  f.state.launchImpl = () => work.promise;
  await flow.start('client-zzz'); work.reject(failed('HELPER_START_FAILED', '助手未就绪')); await tick();
  for (let i = 0; i < 3; i++) { const result = await flow.inspect('client-zzz'); assert.equal(result.phase, 'failed'); assert.equal(result.error.code, 'HELPER_START_FAILED'); assert.equal(result.installation.ready, false); }
  const retried = await flow.inspect('client-zzz', { retry: true }); assert.equal(retried.phase, 'ready'); assert.equal(retried.error, null);
});

test('explicit retry acknowledges only the current failed session, never a later failed session', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  f.state.session = { sessionId: 's1', status: 'failed', historical: false, error: { code: 'FIRST_FAILURE', message: 'first' } };
  assert.equal((await flow.inspect('client-zzz')).error.code, 'FIRST_FAILURE');
  assert.equal((await flow.inspect('client-zzz', { retry: true })).phase, 'ready');
  assert.equal((await flow.inspect('client-zzz')).error, null);
  f.state.session = { ...f.state.session, sessionId: 's2', error: { code: 'SECOND_FAILURE', message: 'second' } };
  assert.equal((await flow.inspect('client-zzz')).error.code, 'SECOND_FAILURE');
});

test('restore removes installation while preserving chosen launcher and API for the next install', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow); await flow.bind('client-zzz', { launcherId: 'starward', channel: 'cn', api: 'dx12' });
  const plan = await flow.preview('client-zzz', 'restore'); assert.deepEqual(plan.request, { uninstall: 'restore' });
  const restored = await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.equal(restored.phase, 'install'); assert.equal(restored.binding.launcher.path, f.starward.path); assert.equal(restored.api.api, 'dx12');
  const reopened = (await f.create().discover()).games[0]; assert.equal(reopened.phase, 'install'); assert.equal(reopened.binding.launcher.path, f.starward.path);
});

test('apply requires confirmation, the exact preview fingerprint and the same registered game target', async t => {
  const f = fixture(t), flow = f.create(); await flow.discover(); const plan = await flow.preview('client-zzz');
  assert.equal((await flow.apply('client-zzz', plan.planId, { fingerprint: plan.fingerprint })).error.code, 'HOYO_CONSENT');
  assert.equal((await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: 'wrong' })).error.code, 'OPERATION_PLAN_CHANGED');
  f.state.plans.get(plan.planId).gameId = 'other-game';
  assert.equal((await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: plan.fingerprint })).error.code, 'HOYO_PLAN_TARGET');
  assert.equal(f.count('apply'), 0); assert.equal(f.count('elevatedApply'), 0);
});

test('elevated installation delegates the same validated plan once and still refreshes readiness', async t => {
  const f = fixture(t, { requiresElevation: async () => true }), flow = f.create(); await flow.discover();
  const plan = await flow.preview('client-zzz'); assert.equal(plan.requiresElevation, true);
  const result = await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.equal(result.phase, 'ready'); assert.equal(f.count('elevatedApply'), 1); assert.equal(f.count('apply'), 1); assert.equal(f.count('refresh'), 1);
});

test('cancel delegates only session cancellation, keeps the game process intact and preserves the binding', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  f.state.session = { sessionId: 's1', historical: false, status: 'running', process: { pid: 54321 } };
  const result = await flow.cancel('client-zzz');
  assert.equal(f.count('cancel'), 1); assert.equal(f.state.session.process.pid, 54321); assert.equal(result.binding.status, 'confirmed'); assert.equal(f.count('launch'), 0);
});

test('changed game or launcher identity keeps previous paths but requires confirmation when discovery has no unique match', async t => {
  const f = fixture(t), first = f.create(); await first.discover(); await first.bind('client-zzz', { launcherId: 'starward', api: 'dx12' });
  f.discovered.automaticBinding = null; f.discovered.exeSha256 = 'd'.repeat(64);
  let reopened = (await f.create().discover()).games[0];
  assert.equal(reopened.binding.status, 'needs-confirmation'); assert.equal(reopened.binding.launcher.path, f.starward.path); assert.equal(reopened.phase, 'binding');
  const second = f.create(); await second.discover(); await second.bind('client-zzz', {});
  f.starward.sha256 = 'e'.repeat(64); reopened = (await f.create().discover()).games[0];
  assert.equal(reopened.binding.status, 'needs-confirmation'); assert.equal(reopened.binding.launcher.path, f.starward.path);
});

test('fresh unique matching automatic evidence can revalidate a changed file without an extra confirmation', async t => {
  const f = fixture(t), first = f.create(); await first.discover();
  f.discovered.exeSha256 = 'f'.repeat(64); f.hyp.sha256 = '9'.repeat(64);
  const reopened = (await f.create().discover()).games[0]; assert.equal(reopened.binding.status, 'confirmed'); assert.equal(reopened.phase, 'install');
});

test('simultaneous start requests can delegate the launch only once, including slow readiness checks', async t => {
  const f = fixture(t), flow = f.create(), work = deferred(); await f.ready(flow);
  f.state.readyGate = deferred(); f.state.launchImpl = () => work.promise;
  const one = flow.start('client-zzz'), two = flow.start('client-zzz');
  const settled = Promise.allSettled([one, two]);
  await tick(); f.state.readyGate.resolve();
  const results = await settled;
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'HOYO_LAUNCH_BUSY');
  assert.equal(f.count('launch'), 1); work.resolve(); await tick();
});

test('preflight failure releases the start reservation and no launch can skip a required binding step', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  await flow.pickLauncher('client-zzz', f.hyp.path);
  await assert.rejects(flow.start('client-zzz'), { code: 'HOYO_NOT_READY' }); assert.equal(f.count('launch'), 0);
  await flow.bind('client-zzz', {});
  f.dependencies.operations.assertReady = async () => { throw failed('PENDING_WRITE'); };
  await assert.rejects(flow.start('client-zzz'), { code: 'PENDING_WRITE' });
  f.dependencies.operations.assertReady = async () => {};
  assert.equal((await flow.start('client-zzz')).phase, 'waiting-helper'); await tick(); assert.equal(f.count('launch'), 1);
});

test('a slow start reservation rejects configuration mutation before the launcher has a session', async t => {
  const f = fixture(t), flow = f.create(), work = deferred(); await f.ready(flow);
  f.state.readyGate = deferred(); f.state.launchImpl = () => work.promise;
  const starting = flow.start('client-zzz'); await tick();
  await assert.rejects(flow.bind('client-zzz', { launcherId: 'starward' }), { code: 'HOYO_LAUNCH_BUSY' });
  await assert.rejects(flow.preview('client-zzz', 'restore'), { code: 'HOYO_LAUNCH_BUSY' });
  f.state.readyGate.resolve(); await starting; work.resolve(); await tick();
});

test('a new API preference requires preview and apply while keeping the currently installed route intact', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  const installed = copy(f.state.deployment);
  const changed = await flow.bind('client-zzz', { api: 'dx12' });
  assert.equal(changed.phase, 'install'); assert.equal(changed.nextAction, 'preview-install'); assert.equal(changed.error, null);
  assert.equal(changed.installation.installed, true); assert.equal(changed.installation.ready, false);
  assert.equal(changed.api.api, 'dx12'); assert.deepEqual(f.state.deployment, installed); assert.equal(f.count('apply'), 0);
  await assert.rejects(flow.start('client-zzz'), { code: 'HOYO_NOT_READY' }); assert.equal(f.count('launch'), 0);
  const reopened = (await f.create().discover()).games[0]; assert.equal(reopened.phase, 'install'); assert.equal(reopened.api.api, 'dx12');
  const plan = await flow.preview('client-zzz', 'install'); assert.equal(plan.request.api, 'dx12'); assert.deepEqual(f.state.deployment, installed);
  const applied = await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.equal(applied.phase, 'ready'); assert.equal(applied.installation.ready, true); assert.equal(f.state.deployment.api, 'dx12');
  assert.equal((await flow.start('client-zzz')).phase, 'waiting-helper'); await tick(); assert.equal(f.count('launch'), 1);
});

test('returning the preference to the installed API restores readiness without rewriting the installation', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow); const installed = copy(f.state.deployment);
  assert.equal((await flow.bind('client-zzz', { api: 'dx12' })).phase, 'install');
  const reverted = await flow.bind('client-zzz', { api: 'dx11' });
  assert.equal(reverted.phase, 'ready'); assert.equal(reverted.error, null); assert.deepEqual(f.state.deployment, installed); assert.equal(f.count('apply'), 0);
});

test('confirmed launcher and channel changes require applying a new binding while preserving the active profile', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow); const installed = copy(f.state.deployment);
  const changed = await flow.bind('client-zzz', { channel: 'bilibili', launcherId: 'starward' });
  assert.equal(changed.installation.bindingChangePending, true); assert.equal(changed.installation.ready, false);
  assert.equal(changed.phase, 'install'); assert.equal(changed.nextAction, 'preview-install'); assert.equal(changed.error, null);
  assert.deepEqual(f.state.deployment, installed); assert.equal(f.count('apply'), 0);
  await assert.rejects(flow.start('client-zzz'), { code: 'HOYO_NOT_READY' });
  const plan = await flow.preview('client-zzz'); assert.equal(plan.request.hoyo.channel, 'bilibili'); assert.equal(plan.request.hoyo.launcher.path, f.starward.path);
  const applied = await flow.apply('client-zzz', plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.equal(applied.phase, 'ready'); assert.equal(applied.installation.bindingChangePending, false);
  assert.equal(f.state.deployment.hoyoProfile.channel, 'bilibili'); assert.equal(f.state.deployment.launcher.path, f.starward.path);
});

test('a changed launcher hash and a different installed binding identity cannot remain ready', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  f.hyp.sha256 = 'd'.repeat(64);
  const changed = await flow.bind('client-zzz', { launcherId: f.hyp.id });
  assert.equal(changed.phase, 'install'); assert.equal(changed.installation.bindingChangePending, true);
  f.state.deployment = f.installedState(); assert.equal((await flow.inspect('client-zzz')).phase, 'ready');
  f.state.deployment.bindingId = 'f'.repeat(64);
  const inconsistent = await flow.inspect('client-zzz'); assert.equal(inconsistent.installation.ready, false); assert.equal(inconsistent.installation.bindingChangePending, true);
});

test('reconfirmed file identity can replace its stale binding but cannot hide other deployment blockers', async t => {
  const f = fixture(t), flow = f.create(); await f.ready(flow);
  f.hyp.sha256 = 'd'.repeat(64); f.state.deployment.ready = false;
  f.state.deployment.blockers = ['游戏或启动器已更新，请重新确认客户端绑定。'];
  await flow.pickLauncher('client-zzz', f.hyp.path);
  assert.equal((await flow.inspect('client-zzz')).phase, 'failed', 'an unconfirmed updated executable is not sufficient to replace the old binding');
  const confirmed = await flow.bind('client-zzz', { launcherId: f.hyp.id });
  assert.equal(confirmed.phase, 'install'); assert.equal(confirmed.error, null); assert.equal(confirmed.installation.ready, false);
  f.state.deployment.blockers.push('Core 组件摘要发生变化，未接管未知文件。');
  const blocked = await flow.inspect('client-zzz'); assert.equal(blocked.phase, 'failed'); assert.match(blocked.error.message, /Core 组件摘要/);
});
