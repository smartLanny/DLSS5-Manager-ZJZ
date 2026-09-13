'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStartupElevation, withPermissionRecovery } = require('../src/product/startup-elevation');

function fixture({ values = ['False', '42'], argv = ['manager.exe'], switches = [], release = false, reacquire = true, ready = async () => {} } = {}) {
  const calls = [], logs = []; let quits = 0, releases = 0, acquisitions = 0;
  const app = { commandLine: { hasSwitch: name => switches.includes(name) }, quit() { quits++; } };
  const elevation = createStartupElevation({ app, processInfo: { platform: 'win32', argv, env: {}, execPath: 'C:\\Manager Folder\\manager.exe' },
    handoff: { begin: () => ({ nonce: '22222222-2222-2222-2222-222222222222' }), wait: ready, cancel() { logs.push({ stage: 'handoff-cancelled' }); }, finish() {} },
    log: (stage, details) => logs.push({ stage, details }), runPowerShell: async (command, timeout) => {
      calls.push({ command, timeout }); const value = values[calls.length - 1]; if (value instanceof Error) throw value; return value;
    }, releaseLock() { releases++; return release; }, reacquireLock() { acquisitions++; return reacquire; }, restoreTimeoutMs: 0 });
  return { elevation, calls, logs, get quits() { return quits; }, get releases() { return releases; }, get acquisitions() { return acquisitions; } };
}


test('ordinary setup probes its token only on demand and never creates a UAC process', async () => {
  const f=fixture(); assert.equal(f.calls.length,0);
  const [a,b]=await Promise.all([f.elevation.context(),f.elevation.context()]);
  assert.equal(a.privilege,'standard'); assert.deepEqual(a,b); assert.equal(a.sandbox,true);
  assert.equal(a.canRestartElevated,false); assert.equal(a.elevationMode,'one-shot-operation');
  assert.equal(f.calls.length,1); assert.doesNotMatch(f.calls[0].command,/Start-Process|RunAs/);
});
test('unknown privilege keeps the window and whole-app restart is disabled for every token', async () => {
  for(const values of [['False'],['True'],[Error('blocked token query')]]) {
    const f=fixture({values}); await f.elevation.context();
    await assert.rejects(f.elevation.relaunchAsAdministrator(),{code:'STARTUP_WHOLE_APP_ELEVATION_DISABLED'});
    assert.equal(f.calls.length,1); assert.equal(f.quits,0); assert.equal(f.releases,0);
  }
});
test('explicit temporary no-sandbox mode is reported but never propagated to a new elevated GUI', async () => {
  const f=fixture({switches:['no-sandbox'],argv:['manager.exe','--no-sandbox']});
  const value=await f.elevation.context(); assert.equal(value.mode,'compatibility'); assert.equal(value.sandbox,false);
  await assert.rejects(f.elevation.relaunchAsAdministrator()); assert.equal(f.calls.length,1);
});
test('permission guidance preserves error ownership and requires recovery and a new concrete preview', () => {
  const denial={ok:false,error:{code:'SETTINGS_LAUNCH_FAILED',message:'original failure',details:{pending:true,cause:{code:'EACCES'},recoverableDomains:['sr']}}};
  const result=withPermissionRecovery(denial);
  assert.equal(result.error.code,denial.error.code); assert.equal(result.error.details.pending,true);
  assert.deepEqual(result.error.details.recoverableDomains,['sr']); assert.equal(result.error.details.recoveryAction,'recover-repreview-elevated-operation');
  assert.equal(result.error.details.automaticRetry,false); assert.match(result.error.message,/重新预览/);
  assert.equal(denial.error.details.recoveryAction,undefined);
  const blocked={ok:false,error:{code:'ERR_GAME_RUNNING',message:'Close game'}}; assert.equal(withPermissionRecovery(blocked),blocked);
});
