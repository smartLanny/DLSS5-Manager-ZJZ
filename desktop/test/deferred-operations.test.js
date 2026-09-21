'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createDeferredOperations } = require('../src/product/deferred-operations');
const { createWorkScheduler } = require('../src/product/work-scheduler');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-waiting-'));
  t.after(() => { assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }); });
  const exe = path.join(dir, 'game.exe'), ini = path.join(dir, 'nr_before_sr.ini');
  fs.writeFileSync(exe, 'synthetic executable'); fs.writeFileSync(ini, '[NRBeforeSR]\nIntensity=1\n');
  const state = { running: true, calls: [], blockers: [] }, scheduler = createWorkScheduler();
  const service = { gameDirectory: () => dir, gameExecutable: () => exe,
    getLayout: () => ({ mode: 'local', source: 'managed', runtimeDir: dir }) };
  const options = { userData: path.join(dir, 'data'), service,
    assertClosed: async () => { if (state.running) throw Object.assign(new Error('running'), { code: 'errGameRunning' }); },
    run: scheduler.run,
    operations: {
      prepareForWaiting: async (_id, request) => { state.calls.push('prepare'); if (state.sourceError) throw state.sourceError;
        if (state.duringPreparation) await state.duringPreparation(); return { ready: !state.blockers.length, blockers: state.blockers, request, identity: 'verified-synthetic-components' }; },
      inspect: async () => ({ pending: state.pending === true }),
      preview: async (_id, request) => { state.calls.push('preview'); return { planId: 'plan', fingerprint: 'fp', blockers: state.blockers, request }; },
      apply: async () => { state.calls.push('apply'); return { applied: true }; }
    }
  };
  return { dir, exe, ini, options, state, queue: createDeferredOperations(options) };
}
test('waiting does not write or create recovery; restart rechecks and applies once after exit', async t => {
  const f = fixture(t);
  assert.equal((await f.queue.submit('game', { nr: { Intensity: 1.5 } })).waiting, true);
  assert.deepEqual(f.state.calls, ['prepare']);
  await f.queue.tick(); assert.deepEqual(f.state.calls, ['prepare']);
  f.state.running = false;
  const restarted = createDeferredOperations(f.options);
  await restarted.tick(); await restarted.tick();
  assert.deepEqual(f.state.calls, ['prepare', 'preview', 'apply']);
  assert.equal((await restarted.inspect('game')).status, 'complete');
});
test('external INI wins, keeps original pending request as backup and never writes', async t => {
  const f = fixture(t); await f.queue.submit('game', { nr: { Intensity: 1.5 } });
  fs.writeFileSync(f.ini, '[NRBeforeSR]\nIntensity=0.7\n'); f.state.running = false;
  await f.queue.tick();
  const result = await f.queue.inspect('game');
  assert.equal(result.status, 'changed'); assert.equal(result.draftBackup.nr.Intensity, 1.5);
  assert.deepEqual(f.state.calls, ['prepare']); assert.match(fs.readFileSync(f.ini, 'utf8'), /0.7/);
});
test('cancel and repeated click never apply two operations', async t => {
  const f = fixture(t);
  await Promise.all([f.queue.submit('game', { nr: { Intensity: 1.2 } }), f.queue.submit('game', { nr: { Intensity: 1.8 } })]);
  assert.equal((await f.queue.inspect('game')).request.nr.Intensity, 1.2);
  await f.queue.cancel('game'); f.state.running = false; await f.queue.tick();
  assert.equal((await f.queue.inspect('game')).status, 'cancelled'); assert.deepEqual(f.state.calls, ['prepare']);
});
test('new blockers after exit stop without consuming the installation journal', async t => {
  const f = fixture(t); await f.queue.submit('game', { nr: { Intensity: 1.5 } });
  f.state.blockers = ['unknown proxy']; f.state.running = false; await f.queue.tick();
  assert.equal((await f.queue.inspect('game')).status, 'attention');
  assert.deepEqual(f.state.calls, ['prepare', 'preview']);
});

test('mandatory NR isolation always requires a preview confirmation even when keep choices are empty', async t => {
  const f = fixture(t); f.state.running = false;
  f.options.operations.preview = async (_id, request) => ({ planId: 'nr-plan', fingerprint: 'nr-fp', request, blockers: [],
    nrConflicts: { required: true, backupDirectories: ['backup'], files: [{ name: 'renodx.addon64', path: path.join(f.dir, 'renodx.addon64'), action: 'backup-isolate' }] } });
  const result = await f.queue.submit('game', { nr: { Intensity: 1.5 }, addonKeep: [] });
  assert.equal(result.needsAttention, true); assert.equal(result.plan.nrConflicts.required, true);
  assert.equal(f.state.calls.includes('apply'), false); assert.equal(await f.queue.inspect('game'), null);
});

test('an NR conflict discovered after exit stops waiting for explicit review without applying or relaunching', async t => {
  const f = fixture(t); await f.queue.submit('game', { nr: { Intensity: 1.5 } }); f.state.running = false;
  f.options.operations.preview = async (_id, request) => ({ planId: 'nr-plan', fingerprint: 'nr-fp', request, blockers: [],
    nrConflicts: { required: true, backupDirectories: ['backup'], files: [{ name: 'renodx.addon64', path: path.join(f.dir, 'renodx.addon64'), action: 'backup-isolate' }] } });
  await f.queue.tick(); const state = await f.queue.inspect('game');
  assert.equal(state.status, 'attention'); assert.equal(state.requiresReview, true); assert.equal(state.pending, false);
  assert.equal(f.state.calls.includes('apply'), false); assert.match(state.message, /确认|冲突/);
});

test('a running-game NR confirmation binds the reviewed file hashes and applies once after exit', async t => {
  const f = fixture(t), plugin = path.join(f.dir, 'renodx.addon64'); let fingerprint = 'one';
  const preview = request => ({ planId: 'nr-plan', fingerprint, request, blockers: [],
    nrConflicts: { required: true, backupDirectories: ['backup'], files: [{ name: 'renodx.addon64', path: plugin, action: 'backup-isolate' }] },
    deployment: { addonCompatibility: { decisions: [{ moduleMayLoad: true, mandatory: false, classification: 'unknown', action: 'isolate' }] } },
    changes: [{ path: plugin, beforeSha256: fingerprint, afterSha256: null }] });
  f.options.operations.prepareForWaiting = async (_id, request) => preview(request);
  f.options.operations.preview = async (_id, request) => preview(request);
  const result = await f.queue.submit('game', { nr: { Intensity: 1.5 } });
  assert.equal(result.needsAttention, true); assert.equal(result.plan.waitingConfirmation, true);
  assert.equal(await f.queue.inspect('game'), null);
  await assert.rejects(f.queue.apply('game', result.plan.planId, { fingerprint: 'one' }), { code: 'WAITING_CONFIRM' });
  const accepted = await f.queue.apply('game', result.plan.planId, { confirm: true, fingerprint: 'one' }); assert.equal(accepted.waiting, true);
  f.state.running = false; await f.queue.tick(); assert.equal((await f.queue.inspect('game')).status, 'complete');
  assert.equal(f.state.calls.filter(row => row === 'apply').length, 1);
  f.state.running = true;
  const again = await f.queue.submit('game', { nr: { Intensity: 1.7 } }); await f.queue.apply('game', again.plan.planId, { confirm: true, fingerprint: 'one' });
  fingerprint = 'changed-plugin'; f.state.running = false; await f.queue.tick();
  assert.equal((await f.queue.inspect('game')).status, 'attention'); assert.equal(f.state.calls.filter(row => row === 'apply').length, 1);
});
test('missing or blocked components cannot enter the waiting queue', async t => {
  const f = fixture(t); f.state.sourceError = Object.assign(new Error('runtime DLC missing'), { code: 'ERR_PAYLOAD_MISSING' });
  await assert.rejects(f.queue.submit('game', { version: 'candidate' }), { code: 'ERR_PAYLOAD_MISSING' });
  assert.equal(await f.queue.inspect('game'), null); assert.equal(fs.existsSync(path.join(f.options.userData, 'waiting-operations')), false);
  f.state.sourceError = null; f.state.blockers = ['provider identity unavailable'];
  const result = await f.queue.submit('game', { nr: { Intensity: 1.5 } });
  assert.equal(result.needsAttention, true); assert.equal(await f.queue.inspect('game'), null);
  assert.equal(f.state.calls.includes('apply'), false);
});
test('external changes during component verification win before the request can enter waiting', async t => {
  const f = fixture(t); f.state.duringPreparation = () => fs.writeFileSync(f.ini, '[NRBeforeSR]\nIntensity=0.61111\n');
  const result = await f.queue.submit('game', { nr: { Intensity: 1.7 } });
  assert.equal(result.waiting, false); assert.equal(result.status, 'changed'); assert.equal(result.draftBackup.nr.Intensity, 1.7);
  f.state.running = false; await f.queue.tick(); assert.equal(f.state.calls.includes('apply'), false);
});
test('external changes to the actual NR storage directory invalidate a waiting request', async t => {
  const f = fixture(t), storage = path.join(f.dir, '_storage_'); fs.mkdirSync(storage);
  const active = path.join(storage, 'nr_before_sr.ini'); fs.copyFileSync(f.ini, active);
  f.options.service.readNrSettings = async () => ({ file: active, readable: true, status: 'ready' });
  await f.queue.submit('game', { nr: { Intensity: 1.7 } }); fs.writeFileSync(active, '[NRBeforeSR]\nIntensity=0.4\n');
  f.state.running = false; await f.queue.tick(); assert.equal((await f.queue.inspect('game')).status, 'changed');
  assert.deepEqual(f.state.calls, ['prepare']);
});
for (const pending of [false, true]) test(`restart surfaces an interrupted applying record with ${pending ? 'an owner recovery ledger' : 'no owner ledger'} and never replays it`, async t => {
  const f = fixture(t); await f.queue.submit('game', { nr: { Intensity: 1.5 } }); f.state.running = false;
  const io = require('node:fs/promises'), rename = io.rename;
  t.mock.method(io, 'rename', async function(from, to) {
    if (String(to).includes('waiting-operations') && JSON.parse(await io.readFile(from, 'utf8')).status === 'complete')
      throw Object.assign(new Error('interrupted completion publication'), { code: 'EIO' });
    return rename.call(this, from, to);
  });
  await f.queue.tick(); t.mock.restoreAll(); f.state.pending = pending;
  const restarted = createDeferredOperations(f.options); await restarted.tick(); await restarted.tick();
  const state = await restarted.inspect('game'); assert.equal(state.status, pending ? 'recovery-required' : 'attention');
  assert.equal(state.pending, false); assert.equal(state.requiresReview, true); assert.equal(state.recovery.required, pending);
  assert.equal(state.draftBackup.nr.Intensity, 1.5); assert.deepEqual(f.state.calls, ['prepare', 'preview', 'apply']);
  if (pending) {
    await assert.rejects(restarted.submit('game', { nr: { Intensity: 1.1 } }), { code: 'WAITING_RECOVERY_REQUIRED' });
    f.state.pending = false; assert.equal((await restarted.inspect('game')).status, 'attention', 'completed owner recovery releases the stale recovery gate');
  }
});
test('reading an in-flight operation never reclassifies it as interrupted', async t => {
  const f = fixture(t); await f.queue.submit('game', { nr: { Intensity: 1.5 } }); f.state.running = false;
  let release, entered; const started = new Promise(resolve => { entered = resolve; });
  f.options.operations.apply = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { applied: true }; };
  const applying = f.queue.tick(); await started;
  const state = await f.queue.inspect('game'); assert.equal(state.status, 'applying'); assert.equal(state.pending, true);
  release(); await applying; assert.equal((await f.queue.inspect('game')).status, 'complete');
});
test('keyed scheduling keeps another game responsive and recovers from rejection', async () => {
  const s = createWorkScheduler(), calls = []; let release;
  const a = s.run('a', () => new Promise(resolve => { release = resolve; }));
  const a2 = s.run('a', () => calls.push('a2'));
  await s.run('b', () => calls.push('b')); assert.deepEqual(calls, ['b']);
  release(); await a; await a2; assert.deepEqual(calls, ['b', 'a2']);
  await assert.rejects(s.run('a', () => { throw Error('test'); }));
  await s.run('a', () => calls.push('recovered')); assert.equal(calls.at(-1), 'recovered');
});

test('a long queued apply does not delay other games and still serializes its own game', async t => {
  const f = fixture(t), dirs = {};
  for (const id of ['slow', 'fast', 'later']) {
    dirs[id] = path.join(f.dir, id); fs.mkdirSync(dirs[id]);
    fs.writeFileSync(path.join(dirs[id], 'game.exe'), id);
  }
  f.options.service.gameDirectory = id => dirs[id];
  f.options.service.gameExecutable = id => path.join(dirs[id], 'game.exe');
  f.options.service.getLayout = id => ({ mode: 'local', source: 'managed', runtimeDir: dirs[id] });
  let release, started; const entered = new Promise(resolve => { started = resolve; });
  f.options.operations.preview = async id => ({ planId: id, fingerprint: 'fp', blockers: [] });
  f.options.operations.apply = async id => {
    f.state.calls.push(id);
    if (id === 'slow') { started(); await new Promise(resolve => { release = resolve; }); }
    return { applied: true };
  };
  await f.queue.submit('slow', { nr: { Intensity: 1.5 } }); await f.queue.submit('fast', { nr: { Intensity: 1.5 } });
  // Visit slow first regardless of its hashed record name; fast must still run.
  const io = require('node:fs/promises'), readdir = io.readdir;
  t.mock.method(io, 'readdir', async function(dir, ...args) {
    const names = await readdir.call(this, dir, ...args);
    return String(dir).endsWith('waiting-operations') ? names.sort((a, b) =>
      Number(JSON.parse(fs.readFileSync(path.join(dir, b))).gameId === 'slow') - Number(JSON.parse(fs.readFileSync(path.join(dir, a))).gameId === 'slow')) : names;
  });
  f.state.running = false; const ticking = f.queue.tick(); await entered;
  let sameGameDone = false; const sameGame = f.options.run(dirs.slow, () => { sameGameDone = true; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(check); reject(Error('the fast game was delayed by the slow game')); }, 3000);
      const check = setInterval(() => { if (f.state.calls.includes('fast')) { clearTimeout(timeout); clearInterval(check); resolve(); } }, 5);
    });
    assert.equal(sameGameDone, false);
    f.state.running = true; await f.queue.submit('later', { nr: { Intensity: 1.6 } }); f.state.running = false;
    await f.queue.tick();
    assert.equal((await f.queue.inspect('later')).status, 'complete', 'a subsequent poll runs newly queued games while another owner remains busy');
    assert.equal(f.state.calls.filter(id => id === 'slow').length, 1);
  } finally { release(); await ticking; await sameGame; }
  assert.equal((await f.queue.inspect('fast')).status, 'complete'); assert.equal(sameGameDone, true);
});
