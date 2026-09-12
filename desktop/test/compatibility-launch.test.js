'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { captureCompatibilitySnapshot } = require('../src/product/compatibility-launch');
const { createLaunchSessions } = require('../src/product/launch-session');

test('optional capture timeout lets the real launch session continue and cancels late publication', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'compat-launch-budget-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const exe = path.join(root, 'game.exe'); await fs.writeFile(exe, 'fixture');
  let resume, published = false, started = false, captureControls;
  const logs = [], stages = [];
  const capture = new Promise(resolve => { resume = resolve; });
  const feedback = { async captureLaunch(_id, _session, controls) {
    captureControls = controls; await capture;
    if (!controls.cancelled()) published = true;
  } };
  const sessions = createLaunchSessions({ userData: root,
    game: async () => ({ exe, launchMode: 'exe' }),
    processes: { find: async () => started ? [{ pid: 123, exe, startedAt: new Date().toISOString() }] : [] },
    beforeLaunch: async (id, session) => {
      stages.push('runtime-prepared');
      await captureCompatibilitySnapshot(feedback, id, session, { timeoutMs: 20, log: (...args) => logs.push(args) });
    },
    launchDirect: async () => { stages.push('game-started'); started = true; },
    broker: {}, pollMs: 1, timeoutMs: 300
  });
  t.after(() => sessions.dispose());
  await sessions.start('fixture');
  assert.equal(started, true);
  assert.deepEqual(stages, ['runtime-prepared', 'game-started']);
  assert.equal(captureControls.cancelled(), true);
  assert.deepEqual(logs, [['compatibility-snapshot-unavailable', { code: 'TIMEOUT' }]]);
  resume(); await capture; await new Promise(resolve => setImmediate(resolve));
  assert.equal(published, false);
});

test('capture failure is recorded without rejecting the launch hook; success finishes before the deadline', async () => {
  const logs = [];
  await captureCompatibilitySnapshot({ captureLaunch: async () => { throw Object.assign(new Error('unavailable'), { code: 'FIXTURE_UNAVAILABLE' }); } },
    'fixture', {}, { timeoutMs: 50, log: (...args) => logs.push(args) });
  assert.deepEqual(logs, [['compatibility-snapshot-unavailable', { code: 'FIXTURE_UNAVAILABLE' }]]);
  let savedBeforeCancellation = false;
  await captureCompatibilitySnapshot({ captureLaunch: async (_id, _session, controls) => { savedBeforeCancellation = !controls.cancelled(); } },
    'fixture', {}, { timeoutMs: 50, log: () => assert.fail('Successful capture must not log failure') });
  assert.equal(savedBeforeCancellation, true);
  await captureCompatibilitySnapshot(null, 'fixture', {});
});
