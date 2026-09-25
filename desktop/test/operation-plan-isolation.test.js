'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture, peBytes, put, hashFile } = require('./helpers/operation-integration-fixture');
const { readManifest } = require('../src/product/manifest');
const { createDeferredOperations } = require('../src/product/deferred-operations');
const { createWorkScheduler } = require('../src/product/work-scheduler');
const confirm = plan => ({ confirm: true, fingerprint: plan.fingerprint });

for (const mode of ['local', 'external']) test(`running ${mode} deployment detects existing NR conflicts before queue consent`, async t => {
  const f = await fixture(t);
  await f.apply({ version: 'fixture-core-1', deployment: mode });
  const plugin = path.join(f.service.getLayout(f.id).addonDirectory || f.exeDir, 'running-generic.addon64');
  put(plugin, peBytes('RenoDX Generic NR')); const original = hashFile(plugin);
  const ini = path.join(f.service.getLayout(f.id).nrConfigDir || f.service.getLayout(f.id).runtimeDir || f.exeDir, 'nr_before_sr.ini');
  const iniBefore = hashFile(ini), scheduler = createWorkScheduler(); let running = true;
  f.guards.assertGameClosed = async () => { if (running) throw Object.assign(new Error('running'), { code: 'errGameRunning' }); };
  const queue = createDeferredOperations({ userData: f.userData, service: f.service, operations: f.plans, run: scheduler.run,
    assertClosed: f.guards.assertGameClosed });
  const proposal = await queue.submit(f.id, { version: 'fixture-core-2' });
  assert.equal(proposal.needsAttention, true); assert.equal(proposal.plan.waitingConfirmation, true);
  assert.equal(proposal.plan.nrConflicts.required, true); assert.ok(proposal.plan.nrConflicts.files.some(row => row.path === plugin));
  assert.equal(await queue.inspect(f.id), null, 'unconfirmed conflicts never create a waiting record');
  assert.equal(hashFile(plugin), original); assert.equal(hashFile(ini), iniBefore); assert.equal((await f.plans.inspect(f.id)).pending, false);
  const accepted = await queue.apply(f.id, proposal.plan.planId, confirm(proposal.plan)); assert.equal(accepted.waiting, true);
  await queue.tick(); assert.equal(hashFile(plugin), original);
  running = false; await queue.tick(); assert.equal((await queue.inspect(f.id)).status, 'complete');
  assert.equal(hashFile(plugin), null); assert.equal(hashFile(ini), iniBefore);
});

test('unified external conflict preview, update, migration confirmation and uninstall preserve both generations of isolation', async t => {
  const f = await fixture(t), initial = path.join(f.exeDir, 'original-generic.addon64');
  put(initial, peBytes('RenoDX Generic NR')); const originalHash = hashFile(initial);
  const first = await f.plans.preview(f.id, { version: 'fixture-core-1', deployment: 'external' });
  assert.equal(first.nrConflicts.required, true); assert.equal(first.nrConflicts.files[0].path, initial);
  assert.deepEqual(first.blockers, []); await f.plans.apply(first.planId, confirm(first));
  assert.equal(fs.existsSync(initial), false);
  const runtime = f.service.getLayout(f.id).runtimeDir, added = path.join(runtime, 'later-generic.addon64');
  put(added, peBytes('RenoDX Generic NR later')); const addedHash = hashFile(added);
  const update = await f.plans.preview(f.id, { version: 'fixture-core-2' });
  assert.equal(update.nrConflicts.required, true); assert.equal(update.nrConflicts.files[0].path, added);
  await f.plans.apply(update.planId, confirm(update)); assert.equal(fs.existsSync(added), false);
  const migrate = await f.plans.preview(f.id, { deployment: 'local' });
  assert.deepEqual(migrate.blockers, []); assert.equal(migrate.nrConflicts.required, true);
  const transfers = migrate.nrConflicts.files.filter(row => row.action === 'transfer-backup');
  assert.equal(transfers.length, 2);
  for (const row of transfers) assert.equal(path.dirname(row.restorePath), f.exeDir);
  // Apply recompiles the complete plan; generated backup destinations and
  // ownership transfer must remain stable across that second preview.
  await f.plans.apply(migrate.planId, confirm(migrate));
  assert.equal(fs.existsSync(initial), false); assert.equal(fs.existsSync(path.join(f.exeDir, path.basename(added))), false);
  const conflicts = readManifest(f.gameRoot).conflicts; assert.equal(conflicts.length, 2);
  const remove = await f.plans.preview(f.id, { uninstall: 'restore' });
  assert.equal(remove.nrConflicts.required, false, 'uninstall must not relabel historical conflicts as new isolation');
  await f.plans.apply(remove.planId, confirm(remove));
  assert.equal(hashFile(initial), originalHash); assert.equal(hashFile(path.join(f.exeDir, path.basename(added))), addedHash);
  for (const row of conflicts) assert.equal(hashFile(path.join(f.gameRoot, row.backupRel)), row.sha256);
});
