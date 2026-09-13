'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOperationElevation, executeOperationWorker, createWindowsProcessInspector, locations, hash } = require('../src/product/operation-elevation');
const { workerArguments } = require('../src/product/operation-worker');
const planId = '11111111-1111-4111-8111-111111111111', fingerprint = 'a'.repeat(64);
const nonce = '22222222-2222-4222-8222-222222222222';
const waitTurn = () => new Promise(resolve => setImmediate(resolve));

test('real Windows PowerShell preserves a Chinese process path when decoded as UTF-8', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const source = path.resolve(__dirname, '../build/load-helper/fixture-target.exe');
  try { await fs.access(source); } catch { t.skip('Build the owned native helper fixture first.'); return; }
  const { spawn, execFile } = require('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '提权身份-'));
  const executable = path.join(root, '管理器 中文测试.exe'); await fs.copyFile(source, executable);
  const child = spawn(executable, ['5000'], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  t.after(async () => { await exited; assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const inspect = createWindowsProcessInspector(command => new Promise((resolve, reject) => execFile(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()))));
  const row = await inspect(child.pid);
  assert.equal(row.pid, child.pid); assert.equal(path.resolve(row.executable).toLowerCase(), executable.toLowerCase());
  assert.ok(Number.isFinite(Date.parse(row.startedAt)));
});

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operation-elevation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = overrides.now || Date.now;
  const exe = path.join(root, 'manager.exe'), gameExe = path.join(root, 'Game.exe');
  const application = { execPath: exe, appPath: root, mainHash: 'c'.repeat(64), codeHash: 'd'.repeat(64) };
  const parent = { pid: 101, executable: exe, startedAt: '2026-09-09T10:00:00Z' }, child = { pid: 102, executable: exe, startedAt: '2026-09-09T10:00:01Z' };
  const plan = { planId, fingerprint, gameId: 'game', exe: gameExe, expiresAt: now() + 600000, before: { exeSha256: 'b'.repeat(64) }, blockers: [] };
  const state = { alive: new Map([[101, parent], [102, child]]), initialized: 0, applied: 0, launchCommands: [], worker: null };
  const inspectProcess = async pid => structuredClone(state.alive.get(pid) || null);
  const plans = { loadPlan: async (id, fp) => { assert.equal(id, planId); assert.equal(fp, fingerprint); return structuredClone(plan); },
    apply: async (id, consent) => { assert.equal(id, planId); assert.equal(consent.confirm, true); state.applied++; return { applied: true, stages: [{ kind: 'sr', status: 'complete' }], runtimeVerified: false }; } };
  const workerOptions = { userData: root, processInfo: { pid: 102 }, inspectProcess, getApplication: async () => application,
    isAdministrator: async () => true, initialize: async () => { state.initialized++; return { plans }; }, sleep: waitTurn, now };
  const runPowerShell = async command => {
    state.launchCommands.push(command);
    const lock = JSON.parse(await fs.readFile(locations(root).lock, 'utf8'));
    state.worker = executeOperationWorker({ ...workerOptions, nonce: lock.nonce, requestHash: lock.requestHash }).finally(() => state.alive.delete(102));
    return '102';
  };
  const brokerOptions = { userData: root, plans, processInfo: { platform: 'win32', pid: 101, execPath: exe }, appPath: root,
    inspectProcess, getApplication: async () => application, runPowerShell, sleep: waitTurn, timeoutMs: 1000, now, ...overrides };
  const broker = createOperationElevation(brokerOptions);
  return { root, application, parent, child, plan, state, plans, workerOptions, brokerOptions, broker };
}

async function seed(f, patch = {}) {
  const request = { version: 1, nonce, planId, fingerprint, gameId: 'game', target: { exe: f.plan.exe, exeHash: f.plan.before.exeSha256 },
    parent: f.parent, application: f.application, createdAt: Date.now(), expiresAt: Date.now() + 60000, allowAntiCheat: false, ...patch };
  const requestHash = hash(request), files = locations(f.root, nonce);
  for (const file of [files.lock, files.request]) await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(files.request, JSON.stringify(request));
  await fs.writeFile(files.lock, JSON.stringify({ version: 1, nonce, requestHash, parent: f.parent, child: f.child, state: 'running' }));
  return { request, requestHash, files };
}

test('one-shot broker waits for the exact worker result and preserves the ordinary parent', async t => {
  const f = await fixture(t); const result = await f.broker.apply('game', planId, { confirm: true, fingerprint });
  await f.state.worker;
  assert.equal(result.applied, true); assert.equal(result.elevated, true); assert.equal(result.runtimeVerified, false);
  assert.equal(f.state.applied, 1); assert.equal(f.state.initialized, 1); assert.ok(f.state.alive.has(101));
  assert.equal(f.state.launchCommands.length, 1); assert.match(f.state.launchCommands[0], /-Verb RunAs -WindowStyle Hidden/);
  assert.doesNotMatch(f.state.launchCommands[0], /no-sandbox|as-admin|elevation-handoff/);
  assert.equal((await f.broker.inspect()).active, false);
  const claims = await fs.readdir(path.join(f.root, 'operation-elevation/claims')); assert.equal(claims.length, 1);
});
test('a broker ticket uses one clock sample while expired and overlong tickets still fail closed', async t => {
  let tick = Date.now(); const now = () => tick++;
  const valid = await fixture(t, { now });
  assert.equal((await valid.broker.apply('game', planId, { confirm: true, fingerprint })).applied, true);
  await valid.state.worker; assert.equal(valid.state.applied, 1);

  for (const mode of ['expired', 'overlong']) {
    const f = await fixture(t, { now });
    const timing = mode === 'expired' ? { createdAt: tick - 60000, expiresAt: tick - 1 }
      : { createdAt: tick, expiresAt: tick + 120001 };
    const value = await seed(f, timing);
    await assert.rejects(executeOperationWorker({ ...f.workerOptions, nonce, requestHash: value.requestHash }),
      { code: 'OPERATION_ELEVATION_REQUEST' });
    assert.equal(f.state.initialized, 0); assert.equal(f.state.applied, 0);
  }
});
test('a UAC cancellation does not apply or retry and leaves no blocking reservation', async t => {
  const f = await fixture(t, { runPowerShell: async () => { throw Object.assign(Error('user cancelled'), { code: 1223 }); } });
  await assert.rejects(f.broker.apply('game', planId, { confirm: true, fingerprint }), { code: 'OPERATION_ELEVATION_START_FAILED' });
  assert.equal(f.state.applied, 0); assert.equal((await f.broker.inspect()).active, false);
});

test('a cancelled launch token stops a slow plan reload before requesting UAC', async t => {
  let cancelled = false, release, entered;
  const gate = new Promise(resolve => { release = resolve; }), loading = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { cancelled: () => cancelled }), load = f.plans.loadPlan;
  f.plans.loadPlan = async (...args) => { entered(); await gate; return load(...args); };
  const pending = f.broker.apply('game', planId, { confirm: true, fingerprint });
  const rejected = assert.rejects(pending, { code: 'LAUNCH_CANCELLED' });
  await loading; cancelled = true; release(); await rejected;
  assert.equal(f.state.launchCommands.length, 0); assert.equal(f.state.applied, 0);
  assert.equal((await f.broker.inspect()).active, false);
});

test('a cancellation reservation is published before UAC and cancelling it releases only this unlaunched lock', async t => {
  let cancelled = false, reserved;
  const f = await fixture(t, { cancelled: () => cancelled, onReserved: async value => { reserved = value; cancelled = true; } });
  await assert.rejects(f.broker.apply('game', planId, { confirm: true, fingerprint }), { code: 'LAUNCH_CANCELLED' });
  const request = JSON.parse(await fs.readFile(locations(f.root, reserved.nonce).request, 'utf8'));
  assert.equal(reserved.gameId, 'game'); assert.equal(reserved.requestHash, hash(request));
  assert.equal(f.state.launchCommands.length, 0); assert.equal(f.state.applied, 0);
  assert.equal((await f.broker.inspect()).active, false);
});

test('a worker publishing its result between the response read and process exit keeps the real outcome', async t => {
  for (const ok of [true, false]) {
    const f = await fixture(t); let childReads = 0;
    const broker = createOperationElevation({ ...f.brokerOptions, runPowerShell: async () => '102', inspectProcess: async pid => {
      if (pid === 102 && ++childReads === 2) {
        const lock = JSON.parse(await fs.readFile(locations(f.root).lock, 'utf8')), files = locations(f.root, lock.nonce);
        const request = JSON.parse(await fs.readFile(files.request, 'utf8'));
        const response = { version: 1, nonce: request.nonce, requestHash: lock.requestHash, planId, fingerprint,
          parent: f.parent, child: f.child, target: request.target, targetVerified: true, ok,
          ...(ok ? { result: { applied: true } } : { error: { code: 'LAUNCH_TARGET_TIMEOUT', message: 'launcher timeout' } }) };
        await fs.mkdir(path.dirname(files.response), { recursive: true }); await fs.writeFile(files.response, JSON.stringify(response) + '\n');
        f.state.alive.delete(102); return null;
      }
      return structuredClone(f.state.alive.get(pid) || null);
    } });
    if (ok) assert.equal((await broker.apply('game', planId, { confirm: true, fingerprint })).applied, true);
    else await assert.rejects(broker.apply('game', planId, { confirm: true, fingerprint }), error =>
      error.code === 'OPERATION_ELEVATION_WORKER_FAILED' && error.details.worker.error.code === 'LAUNCH_TARGET_TIMEOUT');
    assert.equal((await broker.inspect()).active, false);
  }
});
test('a PID without a response never becomes execution success and a live worker keeps the lock', async t => {
  const f = await fixture(t, { runPowerShell: async () => '102', timeoutMs: 5 });
  await assert.rejects(f.broker.apply('game', planId, { confirm: true, fingerprint }), { code: 'OPERATION_ELEVATION_TIMEOUT' });
  assert.equal(f.state.applied, 0); assert.equal((await f.broker.inspect()).workerRunning, true);
  await assert.rejects(f.broker.assertAvailable(), { code: 'OPERATION_ELEVATION_BUSY' });
  await assert.rejects(f.broker.recover(), { code: 'OPERATION_ELEVATION_BUSY' });
  f.state.alive.delete(102); assert.equal((await f.broker.recover()).needsDomainRecovery, true);
});
test('a failed domain operation returns its real error and leaves its own recovery record untouched', async t => {
  const f = await fixture(t); const wal = path.join(f.root, 'domain-pending.json');
  f.plans.apply = async () => { await fs.writeFile(wal, 'keep domain recovery'); throw Object.assign(Error('driver write denied'), { code: 'NVAPI_ACCESS_DENIED', details: { stages: [{ kind: 'sr', status: 'started' }] } }); };
  await assert.rejects(f.broker.apply('game', planId, { confirm: true, fingerprint }), error => error.code === 'OPERATION_ELEVATION_WORKER_FAILED' && error.details.worker.error.code === 'NVAPI_ACCESS_DENIED');
  await f.state.worker; assert.equal(await fs.readFile(wal, 'utf8'), 'keep domain recovery');
});
test('request replay, altered request hash, expired request, wrong child and stale parent all fail closed', async t => {
  for (const mode of ['replay', 'hash', 'expired', 'child', 'parent']) {
    const f = await fixture(t), value = await seed(f, mode === 'expired' ? { expiresAt: Date.now() - 1 } : {});
    const options = { ...f.workerOptions, nonce, requestHash: value.requestHash };
    if (mode === 'replay') { const response = await executeOperationWorker(options); assert.equal(response.ok, true); await assert.rejects(executeOperationWorker(options), { code: 'OPERATION_ELEVATION_REPLAY' }); assert.equal(f.state.applied, 1); continue; }
    if (mode === 'hash') options.requestHash = 'd'.repeat(64);
    if (mode === 'child') options.processInfo = { pid: 101 };
    if (mode === 'parent') f.state.alive.set(101, { ...f.parent, startedAt: 'reused PID' });
    await assert.rejects(executeOperationWorker(options));
    assert.equal(f.state.initialized, 0); assert.equal(f.state.applied, 0);
  }
});
test('worker rechecks target identity and rejects a non-admin token before any operation', async t => {
  for (const mode of ['exe', 'hash', 'privilege']) {
    const f = await fixture(t), value = await seed(f);
    if (mode === 'exe') f.plan.exe = path.join(f.root, 'Other.exe');
    if (mode === 'hash') f.plan.before.exeSha256 = 'd'.repeat(64);
    const result = await executeOperationWorker({ ...f.workerOptions, nonce, requestHash: value.requestHash, isAdministrator: async () => mode !== 'privilege' });
    assert.equal(result.ok, false); assert.equal(f.state.applied, 0);
    assert.equal(result.error.code, mode === 'privilege' ? 'OPERATION_ELEVATION_PRIVILEGE' : 'OPERATION_ELEVATION_TARGET');
  }
});
test('broker rejects a different game or missing explicit consent before reserving or launching', async t => {
  const f = await fixture(t);
  await assert.rejects(f.broker.apply('game', planId, { fingerprint }), { code: 'OPERATION_ELEVATION_CONSENT' });
  await assert.rejects(f.broker.apply('other', planId, { confirm: true, fingerprint }), { code: 'OPERATION_ELEVATION_PLAN' });
  assert.equal(f.state.launchCommands.length, 0); assert.equal(f.state.applied, 0);
});
test('worker CLI permits only one bound ticket and refuses sandbox/debug relaunch switches', () => {
  assert.equal(workerArguments(['manager.exe']), null);
  const args = ['manager.exe', `--operation-worker=${nonce}`, `--operation-request-hash=${fingerprint}`];
  assert.deepEqual(workerArguments(args), { nonce, requestHash: fingerprint });
  for (const extra of ['--no-sandbox', '--inspect-brk', '--user-data-dir=C:/Other', '--eval=anything', `--operation-worker=${nonce}`]) assert.throws(() => workerArguments([...args, extra]), { code: 'OPERATION_ELEVATION_ARGUMENTS' });
});

test('stale responses and successful process creation cannot forge this operation result', async t => {
  for (const mode of ['nonce', 'pid', 'target', 'not-applied']) {
    const f = await fixture(t);
    const broker = createOperationElevation({ ...f.brokerOptions, runPowerShell: async () => {
      const lock = JSON.parse(await fs.readFile(locations(f.root).lock, 'utf8')), files = locations(f.root, lock.nonce);
      const request = JSON.parse(await fs.readFile(files.request, 'utf8'));
      const row = { version: 1, nonce: request.nonce, requestHash: lock.requestHash, planId, fingerprint, parent: f.parent, child: f.child,
        target: request.target, targetVerified: true, ok: true, result: { applied: true } };
      if (mode === 'nonce') row.nonce = nonce;
      if (mode === 'pid') row.child = { ...f.child, pid: 999 };
      if (mode === 'target') row.target = { ...row.target, exeHash: 'e'.repeat(64) };
      if (mode === 'not-applied') row.result.applied = false;
      await fs.mkdir(path.dirname(files.response), { recursive: true }); await fs.writeFile(files.response, JSON.stringify(row) + '\n');
      return '102';
    } });
    await assert.rejects(broker.apply('game', planId, { confirm: true, fingerprint }), { code: 'OPERATION_ELEVATION_RESPONSE' });
    assert.equal(f.state.applied, 0); assert.equal((await broker.inspect()).workerRunning, true);
  }
});
test('a changed application package or a parent exiting during initialization cannot reach apply', async t => {
  for (const mode of ['code', 'parent-exit']) {
    const f = await fixture(t), value = await seed(f);
    const options = { ...f.workerOptions, nonce, requestHash: value.requestHash };
    if (mode === 'code') {
      options.getApplication = async () => ({ ...f.application, codeHash: 'e'.repeat(64) });
      await assert.rejects(executeOperationWorker(options), { code: 'OPERATION_ELEVATION_APPLICATION' });
    } else {
      options.initialize = async () => { f.state.alive.delete(101); return { plans: f.plans }; };
      assert.equal((await executeOperationWorker(options)).error.code, 'OPERATION_ELEVATION_PARENT');
    }
    assert.equal(f.state.applied, 0);
  }
});
