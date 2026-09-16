'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLaunchSessions } = require('../src/product/launch-session');
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-session-'));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const exe = path.join(dir, 'game.exe'); fs.writeFileSync(exe, 'fixture');
  const calls = [], events = []; let time = Date.now(), queries = 0;
  const target = { exe, launchMode: 'steam', steamAppId: '12345', steamRoot: dir };
  const process = { pid: 100, exe, startedAt: new Date(time).toISOString(), modules: [] };
  const options = { userData: dir, game: async () => target,
    broker: { launch: async args => { calls.push(args); return { pid: 5 }; } },
    processes: { find: async () => ++queries > 1 ? [process] : [] }, emit: event => events.push(event.status),
    timeoutMs: 100, pollMs: 10, delay: async ms => { time += ms; }, now: () => time, ...overrides };
  return { service: createLaunchSessions(options), dir, exe, target, process, calls, events, options };
}
test('Steam launch records request, waits for selected EXE, and never treats steam PID as game PID', async t => {
  const f = fixture(t), result = await f.service.start('game');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].args, ['-applaunch', '12345']);
  assert.equal(result.process.pid, 100); assert.equal(result.status, 'waiting-enhancement');
  assert(f.events.indexOf('waiting-launcher') < f.events.indexOf('game-matched'));
  assert.equal(result.helper.status, 'not-applicable'); assert.equal(result.runtimeVerified, false);
});
test('launcher timeout retains selected mode without a direct EXE fallback', async t => {
  const f = fixture(t, { processes: { find: async () => [] } });
  await assert.rejects(f.service.start('game'), { code: 'LAUNCH_TARGET_TIMEOUT' });
  assert.equal(f.calls.length, 1); assert.equal((await f.service.inspect('game')).status, 'failed');
});
test('official launcher request waits for the bound real game process', async t => {
  const f = fixture(t), launcher = path.join(f.dir, 'launcher.exe'); fs.writeFileSync(launcher, 'launcher');
  f.target.launchMode = 'official';
  f.target.launchRequest = { exe:launcher, args:['--game=fixture'], cwd:f.dir };
  const result = await f.service.start('game');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], f.target.launchRequest);
  assert.equal(result.process.exe, f.exe); assert(f.events.includes('waiting-launcher'));
});
test('invalid helper Ready fails before launch and only cleans the owned helper', async t => {
  const stops = [];
  const helper = { prepare: async spec => ({ ...spec, configHash: 'one' }), start: async () => ({ sessionId: 'stale', configHash: 'one' }),
    stop: async (session, reason) => { stops.push({ session, reason }); return { status: 'stopped' }; } };
  const f = fixture(t, { helper }); f.target.helper = { directory: f.dir };
  await assert.rejects(f.service.start('game'), { code: 'LAUNCH_HELPER_IDENTITY' });
  assert.equal(f.calls.length, 0); assert.equal(stops.length, 1); assert.equal((await f.service.inspect('game')).cleanup.status, 'stopped');
});
test('helper failing after matched game preserves the game and reports independent failure', async t => {
  let onFailure, stopped = 0;
  const helper = { prepare: async spec => ({ ...spec, configHash: 'one' }), start: async session => session,
    watch: (_session, callbacks) => { onFailure = callbacks.onFailure; }, stop: async () => { stopped++; } };
  const f = fixture(t, { helper }); f.target.helper = { directory: f.dir };
  await f.service.start('game'); await onFailure(new Error('helper exited'));
  const current = await f.service.inspect('game'); assert.equal(current.status, 'enhancement-failed'); assert.equal(current.gamePreserved, true); assert.equal(stopped, 0);
});
test('a prior saved session is historical and never replayed as new Ready', async t => {
  const f = fixture(t); await f.service.start('game');
  const next = createLaunchSessions(f.options), loaded = await next.inspect('game');
  assert.equal(loaded.historical, true);
});
test('invalid Steam identity never opens an arbitrary URI or launches the target directly', async t => {
  const f = fixture(t); f.target.steamAppId = '123;evil';
  await assert.rejects(f.service.start('game'), { code: 'LAUNCH_STEAM_UNVERIFIED' }); assert.equal(f.calls.length, 0);
});
test('an already known helper failure cannot be overwritten when the game match installs its watcher', async t => {
  const helper = { prepare: async spec => ({ ...spec, configHash: 'one' }), start: async session => session,
    watch: async (_session, callbacks) => callbacks.onFailure(new Error('failed before watcher')), stop: async () => ({ status: 'stopped' }) };
  const f = fixture(t, { helper }); f.target.helper = {};
  const result = await f.service.start('game'); assert.equal(result.status, 'enhancement-failed'); assert.equal(result.gamePreserved, true);
  assert.equal((await f.service.inspect('game')).status, 'enhancement-failed'); assert.equal(f.events.at(-1), 'enhancement-failed');
});
test('Ready followed immediately by failure stops before sending any launch request', async t => {
  let stopped = false;
  const helper = { prepare: async spec => ({ ...spec, configHash: 'one' }), start: async session => session, alive: () => false,
    stop: async () => { stopped = true; return { status: 'stopped' }; } };
  const f = fixture(t, { helper }); f.target.helper = {};
  await assert.rejects(f.service.start('game'), { code: 'LAUNCH_HELPER_EXITED' }); assert.equal(f.calls.length, 0); assert.equal(stopped, true);
});
test('failure after sending a request re-observes a game that appeared between polls and preserves it', async t => {
  let queries = 0, f;
  const helper = { prepare: async spec => ({ ...spec, configHash: 'one' }), start: async session => session,
    alive: () => queries < 2, stop: async () => ({ status: 'stopped' }) };
  f = fixture(t, { helper, processes: { find: async () => ++queries > 2 ? [f.process] : [] } }); f.target.helper = {};
  await assert.rejects(f.service.start('game'), { code: 'LAUNCH_HELPER_EXITED' });
  const result = await f.service.inspect('game'); assert.equal(result.process.pid, f.process.pid); assert.equal(result.gamePreserved, true); assert.equal(result.status, 'enhancement-failed');
});
