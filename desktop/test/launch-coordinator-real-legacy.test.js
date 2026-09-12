'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLaunchCoordinator } = require('../src/product/launch-coordinator');
const { createLaunchSettingsService } = require('../src/product/launch-settings-service');
const { createSrModelService, loadPolicies } = require('../src/product/sr-model-service');

function fixture(t, { legacyPolicy, explicitApply = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-real-launch-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'Game');
  const exe = path.join(game, 'Game.exe');
  const userData = path.join(root, 'userdata');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(exe, 'synthetic exe');

  const nvapiCalls = [];
  const nvapi = Object.fromEntries(['readSrState', 'applySrPreset', 'restoreSrState'].map(name => [name, async () => {
    nvapiCalls.push(name);
    throw new Error(`unexpected NVAPI ${name}`);
  }]));
  const legacySrModel = createSrModelService({
    userData,
    resourcesPath: root,
    appDir: root,
    gameDirectory: () => game,
    gameExecutable: () => exe,
    detectHardware: () => ({ family: 'RTX50', series: ['RTX50'] }),
    nvapi
  });
  if (legacyPolicy) {
    fs.mkdirSync(userData, { recursive: true });
    const key = path.resolve(game).toLowerCase();
    fs.writeFileSync(legacySrModel.policyFile, JSON.stringify({ version: 2, games: { [key]: legacyPolicy } }));
  }

  const driverCalls = [];
  const driver = {
    read: async () => { driverCalls.push('read'); throw new Error('unexpected driver read'); },
    write: async () => { driverCalls.push('write'); throw new Error('unexpected driver write'); }
  };
  const settings = createLaunchSettingsService({
    userData,
    appDir: root,
    gameDirectory: () => game,
    gameExecutable: () => exe,
    legacySrModel,
    driver,
    detectHardware: async () => ({ family: 'RTX50', series: ['RTX50'] }),
    environment: async () => ({ verified: true, running: [] }),
    peBitness: () => 64
  });
  const serviceCalls = [];
  const service = {
    gameDirectory: () => game,
    gameExecutable: () => exe,
    validateLaunch: async () => serviceCalls.push('validate'),
    launch: async () => { serviceCalls.push('launch'); return true; }
  };
  const guards = { assertGameClosed: async () => serviceCalls.push('closed') };
  const coordinator = createLaunchCoordinator({ service, settings, legacySrModel, guards, explicitApply });
  return { root, game, exe, legacySrModel, settings, coordinator, nvapiCalls, driverCalls, serviceCalls };
}

test('a completely unconfigured game can open the panel and launch without touching NVAPI or driver settings', async t => {
  const f = fixture(t);

  const panel = await f.coordinator.inspect('game');
  assert.deepEqual(panel.requests, {});
  assert.deepEqual(panel.applied, {});
  assert.equal(panel.legacy.selection, 'auto');
  assert.equal(panel.legacy.baselineCaptured, false);
  assert.deepEqual(f.nvapiCalls, []);
  assert.deepEqual(f.driverCalls, []);
  assert.equal((await f.coordinator.inspectLaunchReadiness('game')).state, 'ready');
  assert.deepEqual(f.nvapiCalls, []); assert.deepEqual(f.driverCalls, []);

  const result = await f.coordinator.launch('game');
  assert.equal(result.launched, true);
  assert.equal(result.srModel.apply.ok, true);
  assert.equal(result.srModel.apply.skipped, true);
  assert.deepEqual(f.nvapiCalls, []);
  assert.deepEqual(f.driverCalls, []);
  assert.deepEqual(f.serviceCalls, ['validate', 'closed', 'launch']);
});

test('a configured legacy M with a captured baseline is visibly blocked before launch without probing NVAPI', async t => {
  const f = fixture(t, { explicitApply: true, legacyPolicy: {
    selection: 'm',
    baseline: { profileFound: false, enable: { explicit: false, value: 0 }, preset: { explicit: false, value: 0 } }
  } });
  const readiness = await f.coordinator.inspectLaunchReadiness('game');
  assert.equal(readiness.state, 'blocked'); assert.equal(readiness.known, true);
  assert.equal(readiness.blockers[0].code, 'SETTINGS_LEGACY_APPLY_REQUIRED');
  assert.equal(readiness.blockers[0].action.kind, 'open-settings');
  assert.deepEqual(f.nvapiCalls, []); assert.deepEqual(f.driverCalls, []);
  await assert.rejects(f.coordinator.launch('game'), { code: 'SETTINGS_LEGACY_APPLY_REQUIRED' });
  assert.deepEqual(f.serviceCalls, ['validate', 'closed']);
  assert.deepEqual(f.nvapiCalls, []); assert.deepEqual(f.driverCalls, []);
});

test('legacy migration treats an omitted or null baseline as unowned and remains launchable', async t => {
  for (const baselineState of ['omitted', 'null']) {
    const legacyPolicy = { selection: 'default' };
    if (baselineState === 'null') legacyPolicy.baseline = null;
    const f = fixture(t, { legacyPolicy });

    const panel = await f.coordinator.inspect('game');
    assert.equal(panel.legacy.selection, 'default', baselineState);
    assert.equal(panel.legacy.effective, 'default', baselineState);
    assert.equal(panel.legacy.baselineCaptured, false, baselineState);

    const migration = await f.legacySrModel.prepareMigration('game');
    assert.equal(migration.ok, true, `${baselineState} baseline migration should be a safe no-op`);
    assert.equal(migration.restored, false, `${baselineState} baseline must not claim a restore`);
    assert.deepEqual(f.nvapiCalls, [], `${baselineState} baseline must not probe NVAPI`);
    assert.deepEqual(f.driverCalls, [], `${baselineState} baseline must not probe the new driver adapter`);

    assert.equal(await f.settings.hasSrRequest('game'), false, `${baselineState} baseline must not acquire new SR ownership`);
    const result = await f.coordinator.launch('game');
    assert.equal(result.launched, true, baselineState);
    assert.ok(result.srModel, `${baselineState} launch should still pass through the legacy writer`);
    assert.equal(result.srModel.apply.skipped, true, baselineState);
    assert.deepEqual(f.nvapiCalls, [], `${baselineState} baseline must remain untouched at launch`);
    assert.deepEqual(f.driverCalls, [], `${baselineState} baseline must remain untouched at launch`);
  }
});

test('legacy native absent values survive auto capture and restore as null instead of invented zeroes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-real-legacy-values-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'Game');
  const exe = path.join(game, 'Game.exe');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(exe, 'synthetic exe');
  const absent = { explicit: false, value: null, kind: 'absent' };
  const calls = { read: 0, apply: [], restore: [] };
  const legacy = createSrModelService({
    userData: path.join(root, 'userdata'),
    resourcesPath: root,
    appDir: root,
    gameDirectory: () => game,
    gameExecutable: () => exe,
    detectHardware: () => ({ family: 'RTX50', series: ['RTX50'] }),
    nvapi: {
      readSrState: async () => {
        calls.read++;
        return { ok: true, profileFound: false, enable: structuredClone(absent), preset: structuredClone(absent) };
      },
      applySrPreset: async request => { calls.apply.push(structuredClone(request)); return { ok: true, rawPreset: 13 }; },
      restoreSrState: async request => { calls.restore.push(structuredClone(request)); return { ok: true, restored: true }; }
    }
  });

  const written = await legacy.write('game', 'auto');
  assert.equal(written.selection, 'auto');
  const applied = await legacy.applyBeforeLaunch('game');
  assert.equal(applied.apply.ok, true);
  assert.equal(applied.effective, 'm');
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.apply[0].exePath, exe);
  assert.equal(calls.apply[0].preset, 'm');
  assert.match(calls.apply[0].friendlyName, /^Xiaofeng DLSS5 - Game \[/);
  assert.equal(calls.read, 1);

  const captured = await legacy.read('game');
  assert.equal(captured.baselineCaptured, true);
  assert.equal((await legacy.migrationInfo('game')).baselineCaptured, true);
  const rows = loadPolicies(legacy.policyFile);
  const stored = rows[path.resolve(game).toLowerCase()].baseline;
  assert.deepEqual(stored.enable, absent);
  assert.deepEqual(stored.preset, absent);

  await legacy.write('game', 'default');
  const restored = await legacy.applyBeforeLaunch('game');
  assert.equal(restored.apply.ok, true);
  assert.deepEqual(calls.restore, [{
    exePath: exe,
    baseline: { profileFound: false, enable: absent, preset: absent }
  }]);
  assert.equal((await legacy.read('game')).baselineCaptured, false);
  assert.equal(loadPolicies(legacy.policyFile)[path.resolve(game).toLowerCase()].baseline, null);
});
