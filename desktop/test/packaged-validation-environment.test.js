'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkEnvironment } = require('../scripts/validate-packaged-startup.cjs');
const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
const reject = code => async () => { throw Object.assign(new Error('fixture environment'), { code }); };

test('ordinary shell enables the original full startup tests', async () => {
  assert.deepEqual(await checkEnvironment(async () => ({ elevated: false, launchable: true }), hosted),
    { status: 'available', ordinaryDesktop: true });
});
for (const code of ['GAME_LAUNCH_SHELL_ELEVATED', 'GAME_LAUNCH_SHELL_MISSING']) test('hosted ' + code + ' is explicitly unverified, never passed', async () => {
  const result = await checkEnvironment(reject(code), hosted);
  assert.equal(result.status, 'not-run'); assert.equal(result.ok, null); assert.equal(result.code, code);
  assert.equal(result.packagedStartupVerified, false); assert.equal(result.safetyGuardsChanged, false);
});
test('ordinary machines and self-hosted runners fail instead of silently skipping', async () => {
  for (const env of [{}, { GITHUB_ACTIONS: 'true' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }])
    await assert.rejects(checkEnvironment(reject('GAME_LAUNCH_SHELL_ELEVATED'), env), { code: 'GAME_LAUNCH_SHELL_ELEVATED' });
});
test('permission mismatches, invalid executables and unknown errors still fail on hosted CI', async () => {
  for (const code of ['GAME_LAUNCH_SESSION_MISMATCH', 'GAME_LAUNCH_REQUIRES_ELEVATION', 'GAME_LAUNCH_TOKEN_QUERY', 'GAME_LAUNCH_EXE_INVALID', 'UNKNOWN'])
    await assert.rejects(checkEnvironment(reject(code), hosted), { code });
  await assert.rejects(checkEnvironment(async () => ({ elevated: true, launchable: true }), hosted), /Invalid ordinary/);
});
