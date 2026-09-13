'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, put, hashFile, INSTALLED_NAMES } = require('./helpers/operation-integration-fixture');
const { createExternalRuntime, RECEIPT, PENDING } = require('../src/product/external-runtime');
const { ADDON: MFG_ADDON } = require('../src/product/fg-mfgunlock-resources');
const { enhancementEvidence } = require('./helpers/enhancement-evidence');
const confirm = plan => ({ confirm: true, fingerprint: plan.fingerprint });

for (const mode of ['clean', 'restore']) test(`OperationPlan direct external MFG ${mode} then reinstall retains owned history and deterministic preview paths`, async t => {
  const f = await fixture(t, { family: 'RTX40', components: { getFeatureEvidence: async () => enhancementEvidence() } });
  const original = '[ADDON]\r\nAddonPath=.\\addon\r\n[GENERAL]\r\nEffectSearchPaths=.\\missing-shaders\\**\r\n';
  put(path.join(f.exeDir, 'ReShade.ini'), original);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'external' });
  const first = f.layout().runtimeDir;
  await f.apply({ fg: { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 } });
  assert.equal(fs.existsSync(path.join(first, MFG_ADDON)), true);
  await f.apply({ uninstall: mode });
  assert.equal(fs.readFileSync(path.join(f.exeDir, 'ReShade.ini'), 'utf8'), original);
  const removed = JSON.parse(fs.readFileSync(path.join(f.gameRoot, RECEIPT)));
  assert.equal(removed.removed, true);
  const backup = path.join(first, '_DLSS5_Backup'); assert.equal(fs.existsSync(backup), true);
  const request = { api: 'dx12', version: 'fixture-core-1', deployment: 'external' };
  const before = fs.readdirSync(backup).sort();
  const a = await f.plans.preview(f.id, request), b = await f.plans.preview(f.id, request);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.deployment.layout.runtimeDir, path.join(path.dirname(first), 'active-' + removed.generation));
  assert.deepEqual(a.changes.map(row => row.path), b.changes.map(row => row.path));
  await f.plans.apply(a.planId, confirm(a));
  assert.notEqual(f.layout().runtimeDir, first); assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
  assert.deepEqual(fs.readdirSync(backup).sort(), before);
  assert.equal(fs.existsSync(path.join(first, MFG_ADDON)), false);
});

test('removed direct profiles with unknown active files remain blocked without moving or deleting those files', async t => {
  const f = await fixture(t);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'external' });
  const old = f.layout().runtimeDir; await f.apply({ uninstall: 'restore' });
  put(path.join(old, '_DLSS5_Backup', 'history', 'retained.json'), '{}');
  const unknown = path.join(old, 'user-added.addon64'); put(unknown, 'unowned user addon'); const before = hashFile(unknown);
  await assert.rejects(f.plans.preview(f.id, { api: 'dx12', version: 'fixture-core-1', deployment: 'external' }), { code: 'DEPLOYMENT_PROFILE_EXISTS' });
  assert.equal(hashFile(unknown), before); assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false);
});

test('OperationPlan direct to ordinary with a pre-existing mutable configuration recompiles the same backup paths', async t => {
  const f = await fixture(t);
  put(path.join(f.exeDir, 'ReShade.ini'), '[ADDON]\nAddonPath=.\n[User]\nKeep=1\n');
  const config = path.join(f.exeDir, INSTALLED_NAMES.config); put(config, '[NRBeforeSR]\nIntensity=1.25\n');
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'external' });
  assert.equal(fs.readFileSync(path.join(f.layout().runtimeDir, INSTALLED_NAMES.config), 'utf8'), '[NRBeforeSR]\nIntensity=1.25\n');
  const request = { deployment: 'local' }, a = await f.plans.preview(f.id, request), b = await f.plans.preview(f.id, request);
  assert.equal(a.fingerprint, b.fingerprint);
  const backups = a.changes.filter(row => row.role === 'original-backup'); assert.equal(backups.length, 1);
  assert.deepEqual(backups.map(row => row.path), b.changes.filter(row => row.role === 'original-backup').map(row => row.path));
  await f.plans.apply(a.planId, confirm(a));
  await f.apply({ uninstall: 'restore' });
  assert.equal(fs.readFileSync(config, 'utf8'), '[NRBeforeSR]\nIntensity=1.25\n');
});

test('a new profile generation interrupted before its receipt commits recovers with the WAL binding', async t => {
  let interrupt = false;
  const f = await fixture(t, { external: { afterWrite: ({ row }) => {
    if (interrupt && row.role === 'game-proxy') throw Object.assign(new Error('new generation interrupted'), { preservePending: true });
  } } });
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'external' });
  const old = f.layout().runtimeDir; await f.apply({ uninstall: 'restore' });
  put(path.join(old, '_DLSS5_Backup', 'history', 'retained.json'), '{"fixtureHistory":true}');
  const receipt = path.join(f.gameRoot, RECEIPT), before = hashFile(receipt), request = { api: 'dx12', version: 'fixture-core-1', deployment: 'external' };
  const plan = await f.plans.preview(f.id, request); interrupt = true;
  await assert.rejects(f.plans.apply(plan.planId, confirm(plan)), /new generation interrupted/);
  const pending = JSON.parse(fs.readFileSync(path.join(f.gameRoot, PENDING))); assert.ok(pending.profileId);
  const restarted = createExternalRuntime({ userData: f.userData, guards: f.guards });
  const game = { dir: f.gameRoot, exe: f.exe };
  assert.equal((await restarted.recover(game)).recovered, true);
  assert.equal(hashFile(receipt), before);
  assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false);
  assert.equal(fs.readFileSync(path.join(old, '_DLSS5_Backup', 'history', 'retained.json'), 'utf8'), '{"fixtureHistory":true}');
});

test('a beta1 ordinary-external-ordinary-uninstall history remains available while reinstall uses a new deterministic profile', async t => {
  const f = await fixture(t);
  const original = '[ADDON]\nAddonPath=.\n[GENERAL]\nEffectSearchPaths=.\\shaders\\**\n[User]\nRetain=1\n';
  put(path.join(f.exeDir, 'ReShade.ini'), original);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  await f.apply({ deployment: 'external' }); const old = f.layout().runtimeDir;
  await f.service.writeGameHotkey(f.id, 'reshade', { key: 35 });
  put(path.join(old, 'nr-before-sr.log'), 'old runtime log remains in the inactive profile');
  await f.apply({ deployment: 'local' }); await f.apply({ uninstall: 'restore' });
  const oldCore = hashFile(path.join(old, INSTALLED_NAMES.addon)), oldConfig = hashFile(path.join(old, 'ReShade.ini'));
  const request = { api: 'dx12', version: 'fixture-core-1', deployment: 'external' };
  const a = await f.plans.preview(f.id, request), b = await f.plans.preview(f.id, request);
  assert.equal(a.fingerprint, b.fingerprint); assert.notEqual(a.deployment.layout.runtimeDir, old);
  await f.plans.apply(a.planId, confirm(a));
  assert.equal(hashFile(path.join(old, INSTALLED_NAMES.addon)), oldCore);
  assert.equal(hashFile(path.join(old, 'ReShade.ini')), oldConfig);
  assert.equal(fs.readFileSync(path.join(old, 'nr-before-sr.log'), 'utf8'), 'old runtime log remains in the inactive profile');
  assert.equal((await f.service.inspectDeployment(f.id)).ready, true);
});

test('inactive beta1 relative Font and screenshot working directory require the exact historical configuration hash', async t => {
  const f = await fixture(t);
  const original = '[ADDON]\nAddonPath=.\n[STYLE]\nFont=.\\Fonts\\User.ttf\n[SCREENSHOT]\nPostSaveCommandWorkingDirectory=.\\\n';
  put(path.join(f.exeDir, 'ReShade.ini'), original);
  await f.apply({ api: 'dx12', version: 'fixture-core-1', deployment: 'local' });
  await f.apply({ deployment: 'external' });
  const old = f.layout().runtimeDir, oldIni = path.join(old, 'ReShade.ini');
  // Fixed output of the e9517524 beta.1 algorithm for the minimal input above:
  // neither Font nor PostSaveCommandWorkingDirectory was rewritten then.
  put(oldIni, original);
  await f.apply({ deployment: 'local' }); await f.apply({ uninstall: 'restore' });
  const before = hashFile(oldIni), request = { api: 'dx12', deployment: 'external' };
  const a = await f.plans.preview(f.id, request), b = await f.plans.preview(f.id, request);
  assert.equal(a.fingerprint, b.fingerprint);
  put(oldIni, original.replace('User.ttf', 'ExternalEdit.ttf'));
  const externalChange = hashFile(oldIni);
  await assert.rejects(f.plans.preview(f.id, request), { code: 'DEPLOYMENT_PROFILE_EXISTS' });
  assert.equal(hashFile(oldIni), externalChange);
  assert.equal(fs.existsSync(path.join(f.gameRoot, PENDING)), false);
  // Restore only this synthetic fixture to its recorded historical bytes.
  put(oldIni, original);
  const ready = await f.plans.preview(f.id, request); await f.plans.apply(ready.planId, confirm(ready));
  assert.equal(hashFile(oldIni), before); assert.notEqual(f.layout().runtimeDir, old);
  assert.match(fs.readFileSync(f.layout().activeConfigPath, 'utf8'), /PostSaveCommandWorkingDirectory=[A-Z]:\\/i);
});
