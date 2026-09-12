'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLaunchCoordinator } = require('../src/product/launch-coordinator');
const { normalizeError } = require('../src/product/errors');

function fixture(overrides = {}, components = null) {
  const calls = [];
  const service = { gameDirectory: () => 'C:/game', gameExecutable: () => 'C:/game/a.exe',
    validateLaunch: async () => calls.push('validate'), launch: async () => { calls.push('launch'); return true; } };
  const settings = { assertReady: async () => calls.push('ready'), hasSrRequest: async () => true,
    beforeLaunch: async () => { calls.push('settings'); return [{ domain: 'sr', applied: true }]; },
    inspect: async () => ({ requests: {}, applied: { sr: { readbackVerified: true } } }),
    restore: async (_, domain) => calls.push(`restore-${domain}`), ...overrides };
  const legacySrModel = { applyBeforeLaunch: async () => { calls.push('legacy'); return { apply: { ok: true } }; },
    prepareMigration: async () => calls.push('restore-legacy'), write: async () => calls.push('legacy-write') };
  const guards = { assertGameClosed: async () => calls.push('closed') };
  return { calls, service, settings, legacySrModel, module: createLaunchCoordinator({ service, settings, legacySrModel, guards, components }) };
}

test('managed launch selects one SR writer and applies settings before launch', async () => {
  const f = fixture();
  const result = await f.module.launch('a');
  assert.equal(result.launched, true);
  assert.deepEqual(f.calls, ['ready', 'validate', 'closed', 'settings', 'launch']);
  await assert.rejects(f.module.writeLegacySr('a', 'm'), { code: 'SETTINGS_OWNERSHIP' });
  assert.ok(!f.calls.includes('legacy-write'));
});
test('library-only removal refuses owned settings and never restores files or driver state', async () => {
  const f = fixture({ hasOwnedState: async () => true });
  f.legacySrModel.migrationInfo = async () => ({ baselineCaptured: false });
  f.service.dismissGame = async () => { throw new Error('must not dismiss'); };
  await assert.rejects(f.module.removeLibraryEntry('a'), { code: 'LIBRARY_RESTORE_FIRST' });
  assert.deepEqual(f.calls, ['ready']);
});
test('library-only removal passes metadata-only intent without installing or uninstalling', async () => {
  const f = fixture({ hasOwnedState: async () => false });
  f.legacySrModel.migrationInfo = async () => ({ baselineCaptured: false });
  f.service.dismissGame = async (id, options) => { assert.equal(id, 'a'); assert.deepEqual(options, { libraryOnly: true }); return []; };
  assert.deepEqual(await f.module.removeLibraryEntry('a'), []);
  assert.deepEqual(f.calls, ['ready']);
});
test('legacy-only selection is retained until new SR settings explicitly take ownership', async () => {
  const f = fixture({ hasSrRequest: async () => false });
  await f.module.launch('a');
  assert.deepEqual(f.calls, ['ready', 'validate', 'closed', 'settings', 'legacy', 'launch']);
});

test('unified launch readiness retains the dedicated FG recovery action', async () => {
  let pending = true;
  const f = fixture({ inspectLaunchReadiness: async () => ({ state: 'ready', known: true, blockers: [], pending: [], requests: {} }) }, {
    inspectMigration: async () => ({ migrationPending: false, fileRecoveryPending: pending })
  });
  const readiness = await f.module.inspectLaunchReadiness('a');
  assert.equal(readiness.state, 'blocked');
  assert.equal(readiness.blockers[0].code, 'SETTINGS_FG_FILE_RECOVERY_REQUIRED');
  assert.equal(readiness.blockers[0].action.kind, 'recover');
  pending = false;
  assert.equal((await f.module.inspectLaunchReadiness('a')).state, 'ready');
});


test('plain launch reads saved intent without probing NVIDIA profile scope or component UI state', async () => {
  const f=fixture({savedRequests:async()=>({}),inspect:async()=>{throw Error('plain launch must not inspect GPU settings');}}, {inspect:async()=>{throw Error('no FG request');}});
  await f.module.launch('a');assert.equal(f.calls.includes('launch'),true);
});
test('plain launch cannot bypass an interrupted FG component transaction without a saved FG request', async () => {
  const f = fixture({ savedRequests: async () => ({}) }, {
    inspectMigration: async () => ({ migrationPending: false, fileRecoveryPending: true }),
    inspect: async () => { throw new Error('full FG inspection is unnecessary'); }
  });
  await assert.rejects(f.module.launch('a'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' });
  assert.equal(f.calls.includes('settings'), false); assert.equal(f.calls.includes('launch'), false);
});
test('failed settings and invalid launch preflight cannot start the game', async () => {
  const outcomes = [{ domain: 'sr', applied: true, runtimeVerified: false },
    { domain: 'fg', applied: false, code: 'SETTINGS_BACKEND_MISSING', reason: 'missing' }];
  const f = fixture({ beforeLaunch: async () => outcomes });
  await assert.rejects(f.module.launch('a'), error => {
    assert.equal(error.code, 'SETTINGS_BACKEND_MISSING');
    assert.equal(error.details.phase, 'launch-settings');
    assert.equal(error.details.gameStarted, false);
    assert.deepEqual(error.details.launchSettings, outcomes);
    assert.deepEqual(error.details.recoverableDomains, ['sr']);
    assert.match(error.message, /SR/);
    return true;
  });
  assert.ok(!f.calls.includes('launch'));
  f.service.validateLaunch = async () => { throw new Error('wrong EXE'); };
  f.calls.length = 0;
  await assert.rejects(f.module.launch('a'), /wrong EXE/);
  assert.deepEqual(f.calls, ['ready']);
});
test('process spawn failure retains applied-setting recovery details', async () => {
  const f = fixture({
    beforeLaunch: async () => [{ domain: 'sr', applied: false, skipped: true, noOp: true }],
    inspect: async () => ({ requests: { sr: {} }, applied: { sr: { readbackVerified: true } } })
  });
  f.service.launch = async () => { f.calls.push('launch'); throw Object.assign(new Error('spawn denied'), { code: 'EACCES' }); };
  await assert.rejects(f.module.launch('a'), error => {
    assert.equal(error.code, 'SETTINGS_LAUNCH_FAILED');
    assert.equal(error.details.phase, 'process-spawn');
    assert.equal(error.details.gameStarted, false);
    assert.deepEqual(error.details.recoverableDomains, ['sr']);
    assert.deepEqual(error.details.launchSettings, [{ domain: 'sr', applied: false, skipped: true, noOp: true }]);
    assert.match(error.message, /spawn denied/);
    const publicError = normalizeError(error);
    assert.equal(publicError.code, 'SETTINGS_LAUNCH_FAILED');
    assert.deepEqual(publicError.details.recoverableDomains, ['sr']);
    return true;
  });
  assert.deepEqual(f.calls, ['ready', 'validate', 'closed', 'launch']);
});
test('legacy SR failure also reports settings already applied by the single writer', async () => {
  const f = fixture({ hasSrRequest: async () => false });
  f.legacySrModel.applyBeforeLaunch = async () => ({ apply: { ok: false, error: 'legacy write failed' } });
  await assert.rejects(f.module.launch('a'), error => {
    assert.equal(error.code, 'SETTINGS_APPLY_FAILED');
    assert.equal(error.details.phase, 'legacy-sr');
    assert.deepEqual(error.details.recoverableDomains, ['sr']);
    assert.equal(error.details.gameStarted, false);
    return true;
  });
  assert.ok(!f.calls.includes('launch'));
});
test('thrown legacy and ownership errors retain completed FG outcomes even if receipt inspection fails', async () => {
  for (const source of ['legacy', 'ownership']) {
    const outcomes = [{ domain: 'fg', applied: true, runtimeVerified: false }];
    const f = fixture({ beforeLaunch: async () => outcomes, hasSrRequest: async () => false,
      inspect: async () => { throw new Error('receipt read unavailable'); } });
    const failure = Object.assign(new Error('legacy dependency failed'), { code: 'NVAPI_UNAVAILABLE' });
    if (source === 'legacy') f.legacySrModel.applyBeforeLaunch = async () => { throw failure; };
    else f.settings.hasSrRequest = async () => { throw failure; };
    await assert.rejects(f.module.launch('a'), error => {
      assert.equal(error.code, 'NVAPI_UNAVAILABLE');
      assert.equal(error.details.phase, 'legacy-sr');
      assert.equal(error.details.gameStarted, false);
      assert.deepEqual(error.details.launchSettings, outcomes);
      assert.deepEqual(error.details.recoverableDomains, ['fg']);
      assert.equal(error.cause, failure);
      assert.equal(error.details.recoveryStateKnown, false);
      assert.match(error.message, /BUG/);
      return true;
    });
    assert.ok(!f.calls.includes('launch'));
  }
});

test('successful restore followed by launch failure never invents a surviving receipt', async () => {
  const f = fixture({ beforeLaunch: async () => [{ domain: 'sr', applied: true }],
    inspect: async () => ({ requests: {}, applied: {} }) });
  f.service.launch = async () => { throw new Error('spawn failed after restore'); };
  await assert.rejects(f.module.launch('a'), error => {
    assert.deepEqual(error.details.recoverableDomains, []);
    assert.equal(error.details.recoveryStateKnown, true);
    assert.doesNotMatch(error.message, /保留恢复记录/);
    assert.equal(error.details.gameStarted, false);
    return true;
  });
});

test('no-op restore allows launch and uninstall restores both domains before legacy', async () => {
  const f = fixture({ beforeLaunch: async () => [{ domain: 'sr', applied: false, skipped: true, noOp: true }] });
  assert.equal((await f.module.launch('a')).launched, true);
  f.calls.length = 0;
  await f.module.restoreForUninstall('a');
  assert.deepEqual(f.calls, ['ready', 'closed', 'restore-fg', 'restore-sr', 'restore-legacy']);
});
test('shared IPC serialization waits after errors and never overlaps mutations', async () => {
  const f = fixture(), order = [];
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const first = f.module.serialize(async () => { order.push('a'); await wait; throw new Error('a failed'); });
  const second = f.module.serialize(async () => order.push('b'));
  await Promise.resolve();
  assert.deepEqual(order, ['a']);
  release();
  await assert.rejects(first, /a failed/);
  await second;
  assert.deepEqual(order, ['a', 'b']);
});
test('dismiss restores owned settings first and never hides a game when restore fails', async () => {
  const f = fixture();
  f.service.dismissGame = async () => { f.calls.push('dismiss'); return []; };
  await f.module.dismiss('a');
  assert.deepEqual(f.calls, ['ready', 'closed', 'restore-fg', 'restore-sr', 'restore-legacy', 'dismiss']);
  f.calls.length = 0;
  f.settings.restore = async () => { throw new Error('restore failed'); };
  await assert.rejects(f.module.dismiss('a'), /restore failed/);
  assert.ok(!f.calls.includes('dismiss'));
});
test('EXE reselection checks the old game ownership before updating the library', async () => {
  const f = fixture();
  f.service.gamesInDirectory = () => [{ id: 'old', executable: 'C:/game/old.exe' }];
  let changed = false;
  f.service.addManualSelection = async () => { changed = true; };
  f.settings.inspect = async () => ({ applied: { sr: {} } });
  await assert.rejects(f.module.confirmSelection({ root: 'C:/game', executable: 'C:/game/new.exe' }), { code: 'SETTINGS_EXE_CHANGED' });
  assert.equal(changed, false);
  f.settings.inspect = async () => ({ applied: {}, legacy: { baselineCaptured: false } });
  await f.module.confirmSelection({ root: 'C:/game', executable: 'C:/game/new.exe' });
  assert.equal(changed, true);
});

test('dismiss and uninstall cleanup restore FG components after settings and before leaving the game', async () => {
  const components = { restore: async () => f.calls.push('restore-components') };
  const f = fixture({}, components);
  f.service.dismissGame = async () => f.calls.push('dismiss');
  await f.module.dismiss('a');
  assert.deepEqual(f.calls, ['ready', 'closed', 'restore-fg', 'restore-sr', 'restore-legacy', 'restore-components', 'dismiss']);
  f.calls.length = 0;
  components.restore = async () => { throw new Error('component ownership conflict'); };
  await assert.rejects(f.module.restoreForUninstall('a'), /component ownership conflict/);
  assert.ok(!f.calls.includes('dismiss'));
});

test('FG payload failure leaves SR status and pending recovery visible', async () => {
  const snapshot = { requests: { sr: { request: { backend: 'native', quality: 'quality' } } }, pending: [{ kind: 'file-journal' }] };
  const f = fixture({ inspect: async () => snapshot }, { inspect: async () => { throw Object.assign(new Error('missing FG payload'), { code: 'ERR_PAYLOAD_MISSING' }); } });
  const actual = await f.module.inspect('a');
  assert.deepEqual(actual.requests, snapshot.requests); assert.deepEqual(actual.pending, snapshot.pending);
  assert.equal(actual.fgComponents.ready, false); assert.equal(actual.fgComponents.errorCode, 'ERR_PAYLOAD_MISSING');
});

test('an unreadable interrupted FG receipt cannot hide the independent file recovery entry', async () => {
  const f = fixture({ inspect: async () => ({ pending: [{ kind: 'file-journal' }], requests: {} }) }, {
    inspect: async () => { throw Object.assign(new Error('interrupted receipt'), { code: 'SETTINGS_FG_RECEIPT_INVALID' }); },
    inspectPending: async () => ({ fileRecoveryPending: true, fileRecoveryOwner: 'xiaofeng-fg-components' })
  });
  const result = await f.module.inspect('a');
  assert.equal(result.fgComponents.fileRecoveryPending, true); assert.equal(result.fgComponents.canPrepare, false);
  assert.equal(result.fgComponents.errorCode, 'SETTINGS_FG_RECEIPT_INVALID'); assert.equal(result.pending.length, 1);
});
