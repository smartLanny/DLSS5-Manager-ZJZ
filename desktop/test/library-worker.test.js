'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { createLibraryWorkerClient } = require('../src/product/library-worker-client');

// A real worker, with bounded synthetic CPU work instead of real disk discovery.
const fixtureSource = `
const { parentPort, threadId } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
let sequence = 0, queue = Promise.resolve();
parentPort.on('message', request => {
  const state = request.args[0] || {};
  if (state.exit) process.exit(23);
  if (state.crash) { process.nextTick(() => { throw new Error('synthetic worker crash'); }); return; }
  queue = queue.then(() => {
    sequence++;
    if (state.fail) { parentPort.postMessage({ id: request.id, ok: false, error: { code: 'FIXTURE_SCAN_FAILED', message: 'synthetic scan failure' } }); return; }
    const start = performance.now();
    while (performance.now() - start < (state.blockMs || 0)) {}
    parentPort.postMessage({ id: request.id, ok: true, value: { threadId, sequence, state } });
  });
});`;

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'library-worker-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function fixture(t) {
  const root = temporary(t), workerFile = path.join(root, 'fixture.cjs');
  fs.writeFileSync(workerFile, fixtureSource);
  const client = createLibraryWorkerClient({ workerFile });
  t.after(() => client.dispose());
  return { root, workerFile, client };
}

test('the main process passes its resolved Documents folder to the real worker', async t => {
  const root = temporary(t), workerFile = path.join(root, 'known-folder.cjs');
  fs.writeFileSync(workerFile, `const {parentPort, workerData}=require('node:worker_threads');
    parentPort.on('message', request=>parentPort.postMessage({id:request.id,ok:true,value:workerData.documentsDir}));`);
  const documentsDir = path.join(root, 'Redirected Documents');
  const client = createLibraryWorkerClient({ workerFile, documentsDir });
  t.after(() => client.dispose());
  assert.equal(await client.scanAll({}), documentsDir);
  assert.equal(await client.prepareSelection(path.join(root, 'RDR2.exe')), documentsDir);
});

test('real worker keeps the main event loop responsive during synchronous scan work', async t => {
  const { client } = fixture(t);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  try {
    const result = await client.scanAll({ blockMs: 180 });
    assert.ok(result.threadId > 0);
    assert.ok(ticks >= 5, `main event loop only received ${ticks} timer ticks`);
  } finally { clearInterval(timer); }
});

test('equivalent scanAll requests share one in-flight task without caching completed scans', async t => {
  const { client } = fixture(t);
  const first = client.scanAll({ blockMs: 50, scope: { b: 2, a: 1 } });
  const duplicate = client.scanAll({ scope: { a: 1, b: 2 }, blockMs: 50 });
  assert.equal(duplicate, first);
  assert.equal((await first).sequence, 1);
  const later = await client.scanAll({ scope: { a: 1, b: 2 }, blockMs: 50 });
  assert.equal(later.sequence, 2, 'a later rescan must still see disk changes');
});

test('task errors reject normally and a later task reuses the live worker', async t => {
  const { client } = fixture(t);
  const before = await client.scanAll({});
  await assert.rejects(client.scanAll({ fail: true }), { code: 'FIXTURE_SCAN_FAILED' });
  const after = await client.scanAll({});
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.sequence, 3);
});

test('unexpected exit and worker errors reject all pending tasks and permit reconstruction', async t => {
  const { client } = fixture(t);
  for (const request of [{ exit: true }, { crash: true }]) {
    const previous = await client.scanAll({});
    const failed = await Promise.allSettled([client.scanAll(request), client.prepareSelection('queued')]);
    for (const result of failed) {
      assert.equal(result.status, 'rejected');
      assert.match(result.reason.code, /^ERR_LIBRARY_WORKER(?:_EXIT)?$/);
    }
    const restarted = await client.scanAll({});
    assert.notEqual(restarted.threadId, previous.threadId);
    assert.equal(restarted.sequence, 1);
  }
});

test('real library worker accepts bounded folder selection and recovers after invalid selection', async t => {
  const root = temporary(t), folder = path.join(root, 'empty-selected-game'); fs.mkdirSync(folder);
  const client = createLibraryWorkerClient(); t.after(() => client.dispose());
  await assert.rejects(client.prepareSelection('not-an-absolute-path'), /invalid selection source/);
  const selected = await client.prepareSelection(folder);
  assert.equal(selected.root, folder);
  assert.deepEqual(selected.candidates, []);
  assert.equal(selected.chosen, null);
});

test('worker entry point rejects methods outside the read-only allowlist', async t => {
  const worker = new Worker(path.join(__dirname, '../src/product/library-worker.js'));
  t.after(() => worker.terminate());
  const result = await new Promise((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject);
    worker.postMessage({ id: 1, method: 'constructor', args: [] });
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ERR_LIBRARY_WORKER_METHOD');
});

test('busy worker keeps a process alive but an idle worker does not prevent exit', async t => {
  const { root, workerFile } = fixture(t);
  const script = path.join(root, 'lifetime.cjs');
  fs.writeFileSync(script, `const {createLibraryWorkerClient}=require(${JSON.stringify(path.resolve(__dirname, '../src/product/library-worker-client'))});
    createLibraryWorkerClient({workerFile:${JSON.stringify(workerFile)}}).scanAll({blockMs:100}).then(value=>console.log('completed:'+value.sequence));`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('idle worker prevented process exit')); }, 5000);
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output, errors }); });
  });
  assert.equal(result.code, 0, result.errors);
  assert.match(result.output, /completed:1/);
});

test('dispose rejects active work and prevents starting another worker', async t => {
  const { client } = fixture(t);
  const active = client.scanAll({ blockMs: 500 });
  const rejected = assert.rejects(active, { code: 'ERR_LIBRARY_WORKER_CLOSED' });
  await client.dispose(); await rejected;
  await assert.rejects(client.scanAll({}), { code: 'ERR_LIBRARY_WORKER_CLOSED' });
});
