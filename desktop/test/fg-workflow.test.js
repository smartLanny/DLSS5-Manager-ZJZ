'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFgWorkflow } = require('../src/product/fg-workflow');
const request = { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 };
const oldRequest = { backend: 'rtx40', mode: 'fixed', multiplier: 4 };
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({ failAt = null, rollbackFailure = null, pending = false, alreadyNew = false } = {}) {
  const calls = [];
  let current = alreadyNew ? { applied: { fg: { backend: 'mfgunlock', request: { backend: 'mfgunlock', mode: 'follow' } } }, requests: {} }
    : { applied: { fg: { backend: 'rtx40', request: oldRequest } }, requests: { fg: { request: oldRequest } } };
  let status = { route: 'compatibility', legacyNeedsMigration: !alreadyNew && !pending, migrationReady: false,
    migrationPending: pending, migrationToken: pending ? 'migration' : null, blockers: ['old control baseline is not restored'] };
  let restoreCount = 0;
  const mark = name => { calls.push(name); if (failAt === name || rollbackFailure === name) throw Object.assign(new Error(name), { code: `FAIL_${name}` }); };
  const settings = {
    assertReady: async () => mark('assert-ready'), inspect: async () => clone(current),
    restore: async () => { restoreCount++; mark(restoreCount === 1 && !pending && !alreadyNew ? 'restore-old-settings' : 'restore-new-settings'); current = { applied: {}, requests: {} }; status.migrationReady = true; status.blockers = []; },
    preview: async (id, domain, input) => { mark('preview-settings'); return { id: 'plan', request: input, warnings: ['restart required'] }; },
    apply: async () => { mark('apply-settings'); current.applied.fg = { backend: 'mfgunlock', request }; return { applied: true }; },
    save: async (id, domain, input) => { mark('save-settings'); current.requests.fg = { request: input }; }
  };
  const components = {
    inspect: async () => clone(status),
    migrateLegacy: async () => { mark('migrate-legacy'); assert.equal(status.migrationReady, true); status = { ...status, migrationPending: true, migrationToken: 'migration', legacyNeedsMigration: false }; return { migrationToken: 'migration' }; },
    prepare: async (id, options) => { mark('prepare-new'); assert.equal(options.migrationToken, alreadyNew ? null : 'migration'); return { changed: !alreadyNew, undoToken: alreadyNew ? null : 'prepare', created: [alreadyNew ? null : 'addon'].filter(Boolean) }; },
    rollbackPrepare: async () => mark('rollback-new-components'),
    rollbackMigration: async () => { mark('rollback-legacy-components'); status.migrationPending = false; status.migrationToken = null; return { restored: true }; },
    commitMigration: async () => { mark('commit-migration'); status.migrationPending = false; },
    commitPrepare: async () => mark('commit-prepare')
  };
  const workflow = createFgWorkflow({ settings, components, assertClosed: async () => mark('assert-closed') });
  return { workflow, calls, settings, components, state: () => clone(current), status: () => clone(status), setState: next => { current = clone(next); } };
}

test('workflow requires explicit migration and stops before any old settings mutation', async () => {
  const f = fixture();
  await assert.rejects(f.workflow.apply('g', request), { code: 'SETTINGS_FG_MIGRATION_REQUIRED' });
  assert.deepEqual(f.calls, ['assert-ready', 'assert-closed']);
});

test('workflow success restores old setting first, commits migration after new settings save', async () => {
  const f = fixture(); const result = await f.workflow.apply('g', request, { migrateLegacy: true });
  assert.deepEqual(f.calls, ['assert-ready', 'assert-closed', 'restore-old-settings', 'migrate-legacy', 'prepare-new', 'preview-settings', 'apply-settings', 'save-settings', 'commit-migration', 'commit-prepare']);
  assert.equal(result.runtimeVerified, false); assert.equal(result.requiresRestart, true); assert.equal(result.migrated, true); assert.equal(f.state().requests.fg.request.backend, 'mfgunlock');
});

test('new preparation failure restores legacy files without inventing or reactivating an old request', async () => {
  const f = fixture({ failAt: 'prepare-new' });
  await assert.rejects(f.workflow.apply('g', request, { migrateLegacy: true }), error => error.code === 'FAIL_prepare-new' && error.details.preparationRolledBack === true && error.details.gameStarted === false);
  assert.deepEqual(f.calls.slice(-2), ['prepare-new', 'rollback-legacy-components']);
  assert.equal(f.calls.includes('rollback-new-components'), false); assert.deepEqual(f.state(), { applied: {}, requests: {} });
});

test('failure after new INI apply compensates settings before new components and old components', async () => {
  const f = fixture({ failAt: 'save-settings' });
  await assert.rejects(f.workflow.apply('g', request, { migrateLegacy: true }), error => error.code === 'FAIL_save-settings' && error.details.legacySettingsRestored === true);
  assert.deepEqual(f.calls.slice(-4), ['save-settings', 'restore-new-settings', 'rollback-new-components', 'rollback-legacy-components']);
  assert.deepEqual(f.state(), { applied: {}, requests: {} }); assert.equal(f.status().migrationPending, false);
});

test('failed new settings restore retains both component generations and migration evidence for recovery', async () => {
  const f = fixture({ failAt: 'save-settings', rollbackFailure: 'restore-new-settings' });
  await assert.rejects(f.workflow.apply('g', request, { migrateLegacy: true }), error => {
    assert.equal(error.code, 'SETTINGS_FG_RECOVERY_REQUIRED'); assert.equal(error.details.recoveryErrors[0].phase, 'settings'); assert.equal(error.details.migrationToken, 'migration'); return true;
  });
  assert.equal(f.calls.includes('rollback-new-components'), false); assert.equal(f.calls.includes('rollback-legacy-components'), false); assert.equal(f.status().migrationPending, true);
});

test('component rollback conflict prevents reinstating a second old hook owner', async () => {
  const f = fixture({ failAt: 'save-settings', rollbackFailure: 'rollback-new-components' });
  await assert.rejects(f.workflow.apply('g', request, { migrateLegacy: true }), { code: 'SETTINGS_FG_RECOVERY_REQUIRED' });
  assert.equal(f.calls.includes('rollback-legacy-components'), false); assert.equal(f.status().migrationPending, true);
});

test('pending migration blocks a new apply and has an explicit settings-first recovery route', async () => {
  const f = fixture({ pending: true }); f.setState({ applied: { fg: { backend: 'mfgunlock', request } }, requests: { fg: { request } } });
  await assert.rejects(f.workflow.apply('g', request, { migrateLegacy: true }), { code: 'SETTINGS_FG_MIGRATION_PENDING' });
  assert.equal(f.calls.includes('prepare-new'), false);
  assert.equal((await f.workflow.recover('g')).restored, true);
  assert.deepEqual(f.calls.slice(-2), ['restore-new-settings', 'rollback-legacy-components']);
});

test('pending recovery cannot restore old hooks if settings recovery is blocked', async () => {
  const f = fixture({ pending: true, failAt: 'restore-new-settings' }); f.setState({ applied: { fg: { backend: 'mfgunlock', request } }, requests: {} });
  await assert.rejects(f.workflow.recover('g'), { code: 'FAIL_restore-new-settings' });
  assert.equal(f.calls.includes('rollback-legacy-components'), false); assert.equal(f.status().migrationPending, true);
});

test('already prepared new backend does not receive a destructive component undo on settings failure', async () => {
  const f = fixture({ alreadyNew: true, failAt: 'preview-settings' });
  await assert.rejects(f.workflow.apply('g', request), { code: 'FAIL_preview-settings' });
  assert.equal(f.calls.includes('rollback-new-components'), false); assert.equal(f.calls.includes('rollback-legacy-components'), false);
});

test('migration failure after persisting its token is recovered before reporting rollback', async () => {
  const f = fixture(), migrate = f.components.migrateLegacy;
  f.components.migrateLegacy = async (...args) => { await migrate(...args); throw Object.assign(new Error('after durable token'),{code:'FAIL_AFTER_TOKEN'}); };
  f.components.inspectMigration = async () => f.status();
  await assert.rejects(f.workflow.apply('g', request,{migrateLegacy:true}),error=>error.code==='FAIL_AFTER_TOKEN'&&error.details.preparationRolledBack===true);
  assert.equal(f.calls.includes('rollback-legacy-components'),true);
  assert.equal(f.status().migrationPending,false);
});

test('unreadable authoritative migration state never claims preparation was rolled back', async () => {
  const f = fixture({failAt:'migrate-legacy'});
  f.components.inspectMigration = async () => {throw Object.assign(new Error('corrupt migration record'),{code:'SETTINGS_FG_MIGRATION_RECORD'});};
  await assert.rejects(f.workflow.apply('g',request,{migrateLegacy:true}),error=>error.code==='SETTINGS_FG_RECOVERY_REQUIRED'&&error.details.recoveryErrors[0].phase==='migration-status');
  assert.equal(f.calls.includes('rollback-legacy-components'),false);
});

test('file interruption before a component receipt never claims rollback or reinstates legacy hooks', async () => {
  const f = fixture({ failAt: 'prepare-new' });
  f.components.inspectMigration = async () => ({ ...f.status(), fileRecoveryPending: true });
  await assert.rejects(f.workflow.apply('g', request, { migrateLegacy: true }), error => {
    assert.equal(error.code, 'SETTINGS_FG_RECOVERY_REQUIRED');
    assert.equal(error.details.recoveryErrors[0].code, 'SETTINGS_FG_FILE_RECOVERY_REQUIRED');
    assert.equal(error.details.preparationRolledBack, undefined);
    return true;
  });
  assert.equal(f.calls.includes('rollback-legacy-components'), false);
});

test('dedicated FG recovery clears component files before the generic readiness guard', async () => {
  const f = fixture({ alreadyNew: true }); let pending = true;
  f.components.recoverPending = async () => { f.calls.push('recover-component-files'); pending = false; return { recovered: true }; };
  f.settings.assertReady = async () => { f.calls.push('assert-ready'); if (pending) throw new Error('pending files'); };
  const result = await f.workflow.recover('g');
  assert.equal(result.restored, true); assert.equal(result.unchanged, false);
  assert.deepEqual(f.calls, ['assert-closed', 'recover-component-files', 'assert-ready']);
});

test('component recovery conflicts preserve the journal and stop later settings or migration writes', async () => {
  const f = fixture({ pending: true });
  f.components.recoverPending = async () => { f.calls.push('recover-component-files'); throw Object.assign(new Error('external replacement'), { code: 'SETTINGS_FG_FILE_CHANGED' }); };
  await assert.rejects(f.workflow.recover('g'), { code: 'SETTINGS_FG_FILE_CHANGED' });
  assert.deepEqual(f.calls, ['assert-closed', 'recover-component-files']);
  assert.equal(f.status().migrationPending, true);
});
