'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createOperationPlans } = require('../src/product/operation-plan');
const { resolveOperationApi } = require('../src/product/operation-api');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operation-plan-')); t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { force: true, recursive: true }); });
  const exe = path.join(dir, 'game.exe'); fs.writeFileSync(exe, 'original exe');
  const config = path.join(dir, 'nr_before_sr.ini'); fs.writeFileSync(config, '[NRBeforeSR]\nIntensity=1\n');
  const calls = [], deploymentPreviews = [], state = { gameOverrides: {} }, deployment = { mode: 'local', loadingMode: 'proxy', generation: null, runtimeDir: dir, nrConfigDir: dir, activeConfigPath: path.join(dir, 'ReShade.ini') };
  const game = { id: 'game', installed: true, addonVersion: 'core1', apiOverride: 'auto',
    chosen: { path: exe, apiResolution: { api: 'dx12', source: 'exe-imports' }, detectedApi: 'dx12' } };
  const service = { gameExecutable: () => exe, gameDirectory: () => dir, getLayout: () => deployment, store: { read: () => state },
    listGames: async () => [game], payloadState: () => ({ settings: { addonVersion: 'core1' } }),
    previewDeployment: async (_id, request) => { deploymentPreviews.push(structuredClone(request)); return { planId: crypto.randomUUID(), version: request.version || game.addonVersion || 'core1',
      changes: [{ role: 'core', path: path.join(dir, 'addon.dll'), beforeSha256: 'a', afterSha256: 'b', action: 'replace' },
        { role: 'receipt', path: path.join(dir, 'receipt.json'), beforeSha256: null, afterSha256: crypto.randomUUID(), action: 'create' }] }; },
    applyDeployment: async () => { calls.push('deployment'); }, writeNrSettings: async (_id, patch) => { calls.push('nr'); fs.writeFileSync(config, JSON.stringify(patch)); },
    recoverDeployment: async () => { calls.push('recover-deployment'); }, inspectDeployment: async () => ({ pending: false, needsRecovery: false }),
    previewUninstall: async (_id, request) => ({ changes: [{ action: request.mode, path: path.join(dir, 'core.dll') }] }),
    uninstall: async (_id, request) => { calls.push(request.mode); return { removed: true }; } };
  const settings = { assertReady: async () => {}, pending: async () => [], inspect: async () => ({ applied: {}, requests: {} }), restore: async () => { calls.push('restore-fg'); },
    preview: async (_id, domain, request) => ({ operations: [{ action: 'set', domain, value: request.quality || request.mode }], blockers: [], destination: 'fixture', request }) };
  const options = { userData: path.join(dir, 'manager'), service, settings,
    components: { inspect: async () => ({}), restore: async () => { calls.push('restore-components'); } }, fgWorkflow: { recover: async () => {} },
    environment: { assertReady: async () => {}, recoverPending: async () => {} }, preparation: { assertReady: async () => {}, inspect: async () => ({ pending: false }) },
    guards: { assertGameClosed: async () => {} }, applyEnhancement: async (_id, domain) => { calls.push(domain); },
    restoreForUninstall: async () => { calls.push('restore-launch-settings'); }, inspectLaunchMode: async () => ({ steamAvailable: true }), setLaunchMode: async () => { calls.push('launch'); } };
  return { ...options, dir, exe, config, calls, deploymentPreviews, game, state, deployment, service, settings, options, plans: createOperationPlans(options) };
}
test('preview never writes and Apply executes deployment, NR, SR and FG exactly once in order', async t => {
  const f = fixture(t), plan = await f.plans.preview('game', { deployment: 'external', version: 'core1', nr: { Intensity: 0.5 },
    sr: { backend: 'native', quality: 'quality', preset: 'K' }, fg: { backend: 'mfgunlock', mode: 'follow' } });
  assert.deepEqual(f.calls, []); assert.match(fs.readFileSync(f.config, 'utf8'), /Intensity=1/);
  const result = await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.equal(result.applied, true); assert.deepEqual(f.calls, ['deployment', 'nr', 'sr', 'fg']); assert.equal((await f.plans.inspect('game')).pending, false);
});
test('EXE or configuration changes after preview block all writes', async t => {
  const f = fixture(t), plan = await f.plans.preview('game', { nr: { Intensity: 0.5 } });
  fs.writeFileSync(f.exe, 'different exe');
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), { code: 'OPERATION_CHANGED' }); assert.deepEqual(f.calls, []);
});
test('failed later stage leaves completed stages visible and blocks writes until owner recovery', async t => {
  const f = fixture(t); f.options.applyEnhancement = async () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  f.plans = createOperationPlans(f.options);
  const plan = await f.plans.preview('game', { nr: { Intensity: 0.5 }, sr: { backend: 'native', quality: 'quality', preset: 'K' } });
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), error => error.details.completedStages.includes('nr'));
  await assert.rejects(f.plans.preview('game', { launchMode: 'exe' }), { code: 'OPERATION_RECOVERY_REQUIRED' });
  const recovered = await f.plans.recover('game'); assert.equal(recovered.recovered, true); assert.match(recovered.notice, /已完成的设置仍保留/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)), { Intensity: 0.5 });
});
test('each uninstall requires an explicit clean or restore choice and bound fingerprint', async t => {
  const f = fixture(t), clean = await f.plans.preview('game', { uninstall: 'clean' });
  await assert.rejects(f.plans.apply(clean.planId, { confirm: true }), { code: 'OPERATION_CONFIRM' });
  await f.plans.apply(clean.planId, { confirm: true, fingerprint: clean.fingerprint }); assert.deepEqual(f.calls, ['restore-launch-settings', 'clean']);
  await assert.rejects(f.plans.preview('game', { uninstall: true }), { code: 'OPERATION_INPUT' });
});
test('persisted plans are rebuilt from requests rather than trusting stored executable steps', async t => {
  const f = fixture(t), plan = await f.plans.preview('game', { launchMode: 'exe' });
  const file = path.join(f.options.userData, 'operation-plans', `${plan.planId}.preview.json`), edited = JSON.parse(fs.readFileSync(file));
  edited.steps = [{ kind: 'uninstall' }]; fs.writeFileSync(file, JSON.stringify(edited));
  const independent = createOperationPlans(f.options); await independent.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.deepEqual(f.calls, ['launch']);
});

test('unknown or mixed APIs block installation and enhancement requests before any preview or execution record', async t => {
  const f = fixture(t);
  for (const api of ['unknown', 'mixed']) {
    f.game.chosen.detectedApi = api; f.game.chosen.apiResolution.api = api;
    for (const request of [{ version: 'core1' }, { deployment: 'external' }, { nr: { Intensity: 0.5 } },
      { sr: { backend: 'native', quality: 'quality', preset: 'K' } }, { fg: { backend: 'mfgunlock', mode: 'follow' } }])
      await assert.rejects(f.plans.preview('game', request), { code: 'OPERATION_API_SELECTION_REQUIRED' });
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.deploymentPreviews, []);
  assert.equal(fs.existsSync(path.join(f.options.userData, 'operation-plans')), false);
});

test('a manual API resolves ambiguity, and choosing auto again does not reuse that override', async t => {
  const f = fixture(t); f.game.chosen.detectedApi = 'mixed';
  f.game.chosen.apiResolution = { api: 'dx12', source: 'override' }; f.game.apiOverride = 'dx12';
  await assert.rejects(f.plans.preview('game', { api: 'auto', version: 'core1' }), { code: 'OPERATION_API_SELECTION_REQUIRED' });
  const plan = await f.plans.preview('game', { api: 'dx12', version: 'core1' });
  assert.equal(plan.resolved.effectiveApi, 'dx12');
  await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.deepEqual(f.calls, ['deployment']);
});

test('legacy manual assessments without independent detection cannot supply their effective API as automatic evidence', async t => {
  const f = fixture(t); f.game.apiOverride = 'dx12'; delete f.game.chosen.detectedApi;
  f.game.chosen.apiResolution = { api: 'dx12', source: 'override' };
  f.game.chosen.apiAssessment = { effectiveApi: 'dx12' };
  assert.equal(resolveOperationApi(f.game).effectiveApi, 'dx12');
  assert.equal(resolveOperationApi(f.game).detectedApi, 'unknown');
  await assert.rejects(f.plans.preview('game', { api: 'auto', version: 'core1' }), { code: 'OPERATION_API_SELECTION_REQUIRED' });
  assert.deepEqual(f.deploymentPreviews, []); assert.equal((await f.plans.inspect('game')).pending, false);
});

test('unresolved APIs still allow setting restoration, uninstall and launch preference changes', async t => {
  const f = fixture(t); f.game.chosen.detectedApi = 'mixed'; f.game.chosen.apiResolution.api = 'mixed';
  for (const request of [{ sr: { backend: 'native', quality: 'game' }, fg: { backend: 'mfgunlock', mode: 'restore' } },
    { uninstall: 'restore' }, { launchMode: 'exe' }]) {
    const plan = await f.plans.preview('game', request);
    await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  }
  assert.deepEqual(f.calls, ['sr', 'fg', 'restore-launch-settings', 'restore', 'launch']);
});

test('new native installs default to external proxy and leave legacy global Core preferences implicit', async t => {
  const f = fixture(t); f.game.installed = false; f.game.addonVersion = null; f.state.addonVersion = '0.4.5-ota';
  f.service.payloadState = () => ({ settings: f.state });
  f.service.installationDefaults = (_id, request) => ({ api: request.api || 'auto', version: '0.4.7beta', deployment: 'external', loadingMode: 'proxy', route: 'native' });
  const original = f.service.previewDeployment;
  f.service.previewDeployment = async (id, request) => {
    assert.equal(Object.hasOwn(request, 'version'), false, 'the raw global preference must not become an explicit version');
    return { ...await original(id, request), version: '0.4.7beta' };
  };
  const plan = await f.plans.preview('game', { api: 'dx12' });
  assert.deepEqual(plan.request, { api: 'dx12' });
  assert.equal(plan.resolved.version, '0.4.7beta'); assert.equal(plan.resolved.deployment, 'external'); assert.equal(plan.resolved.loadingMode, 'proxy');
  await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.deepEqual(f.calls, ['deployment']); assert.equal(f.deploymentPreviews.length, 2);
  assert.ok(f.deploymentPreviews.every(request => request.mode === 'external' && request.loadingMode === 'proxy'));
});

test('existing installations preserve their directory and loading mode unless explicitly changed', async t => {
  const f = fixture(t); f.deployment.mode = 'external'; f.deployment.source = 'xiaofeng-external-runtime'; f.deployment.loadingMode = 'helper';
  const plan = await f.plans.preview('game', { version: 'core2' });
  assert.equal(plan.resolved.deployment, 'external'); assert.equal(plan.resolved.loadingMode, 'helper');
  assert.deepEqual(f.deploymentPreviews[0], { mode: 'external', version: 'core2', api: 'auto', loadingMode: 'helper' });
});

test('resolved implicit Core identity is bound to the preview even when payload file changes are identical', async t => {
  const f = fixture(t), original = f.service.previewDeployment; let version = 'core1';
  f.service.previewDeployment = async (id, request) => ({ ...await original(id, request), version });
  const plan = await f.plans.preview('game', { api: 'dx12' }); version = 'core2';
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), { code: 'OPERATION_CHANGED' });
  assert.deepEqual(f.calls, []); assert.equal((await f.plans.inspect('game')).pending, false);
});

test('nested deployment layout blockers are visible and cannot create an execution ledger', async t => {
  const f = fixture(t), original = f.service.previewDeployment;
  f.service.previewDeployment = async (id, request) => ({ ...await original(id, request), blockers: [], layout: { blockers: [{ code: 'ERR_ADDON_SEARCH_PATH' }] } });
  const plan = await f.plans.preview('game', { api: 'dx12', version: 'core1' });
  assert.equal(plan.blockers.length, 1); assert.match(plan.blockers[0], /自定义目录/);
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), { code: 'OPERATION_BLOCKED' });
  assert.deepEqual(f.calls, []); assert.equal((await f.plans.inspect('game')).pending, false);
});

test('a preflight exception on Apply leaves no execution ledger or deployment write', async t => {
  const f = fixture(t), original = f.service.previewDeployment;
  const plan = await f.plans.preview('game', { api: 'dx12' });
  f.service.previewDeployment = async () => { throw Object.assign(new Error('configuration became ambiguous'), { code: 'ERR_RESHADE_CONFIG' }); };
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), { code: 'ERR_RESHADE_CONFIG' });
  assert.deepEqual(f.calls, []); assert.equal((await f.plans.inspect('game')).pending, false);
  f.service.previewDeployment = original;
  await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.deepEqual(f.calls, ['deployment']);
});

function mfgMigrationFixture(t) {
  const f = fixture(t), saved = { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 };
  const current = { request: { ...saved, multiplier: 4 }, providerId: 'mfgunlock-0.6.1' };
  const applied = [];
  f.settings.inspect = async () => ({ current: { fg: { valid: true, request: current.request } },
    requests: { fg: { request: saved } }, applied: { fg: { backend: 'mfgunlock', request: saved } } });
  f.components.inspect = async () => ({ managed: true, receipt: {}, installedProvider: current.providerId });
  f.components.previewProvider = async () => ({ files: [], blockers: [] });
  f.options.applyEnhancement = async (_id, domain, request, options) => { f.calls.push(domain); applied.push({ request, options }); };
  f.plans = createOperationPlans(f.options);
  return { ...f, current, applied };
}

test('explicit MFG requests and provider choices take precedence over migration retention', async t => {
  const f = mfgMigrationFixture(t), request = { deployment: 'external', components: { mfgUnlock: 'mfgunlock-0.7' },
    fg: { backend: 'mfgunlock', mode: 'fixed', multiplier: 5 } };
  const plan = await f.plans.preview('game', request);
  await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.deepEqual(f.applied[0].request, request.fg);
  assert.equal(f.applied[0].options.providerId, request.components.mfgUnlock);
  assert.deepEqual(f.calls, ['restore-fg', 'restore-components', 'deployment', 'fg']);
});

for (const changed of ['menu', 'provider']) test(`MFG ${changed} changes after migration preview require a fresh preview before any writes`, async t => {
  const f = mfgMigrationFixture(t), plan = await f.plans.preview('game', { deployment: 'external' });
  if (changed === 'menu') f.current.request = { ...f.current.request, multiplier: 5 };
  else f.current.providerId = 'mfgunlock-0.7';
  await assert.rejects(f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint }), { code: 'OPERATION_CHANGED' });
  assert.deepEqual(f.calls, []); assert.equal((await f.plans.inspect('game')).pending, false);
});

test('explicit FG restore during layout migration does not reinstall the retained provider', async t => {
  const f = mfgMigrationFixture(t), request = { deployment: 'external', fg: { backend: 'mfgunlock', mode: 'restore' } };
  f.components.previewProvider = async () => { throw new Error('restoration must not prepare a provider'); };
  const plan = await f.plans.preview('game', request);
  await f.plans.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint });
  assert.deepEqual(f.applied[0].request, request.fg);
  assert.equal(Object.hasOwn(f.applied[0].options, 'providerId'), false);
});
