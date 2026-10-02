'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = require('../src/product/digest-async');
const { sha256 } = require('../src/product/streaming-digest-sync');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-async-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; };
const hex = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sameError = async (file) => {
  let expected; try { sha256(file); } catch (error) { expected = error; }
  assert.ok(expected, 'the sync digest fails too');
  await assert.rejects(digest.sha256Async(file), error => {
    assert.equal(error.constructor, expected.constructor);
    assert.equal(error.code, expected.code);
    assert.equal(error.message, expected.message);
    return true;
  });
};

test('small files are hashed directly without starting a worker', async () => {
  const bytes = Buffer.from('small');
  assert.equal(await digest.sha256Async(write('small.ini', bytes)), hex(bytes));
  await sameError(path.join(root, 'missing.dll'));
  assert.equal(digest._state().worker, null);
  assert.equal(digest._state().offloaded, 0);
});

test('large files are hashed on the worker with the same result while this thread keeps running', async () => {
  const bytes = crypto.randomBytes(digest.policy.offloadBytes + 4096), file = write('model.dll', bytes);
  let turned = false; setImmediate(() => { turned = true; });
  assert.equal(await digest.sha256Async(file), hex(bytes));
  assert.equal(turned, true, 'the event loop turned before the digest arrived');
  assert.equal(digest._state().offloaded, 1);
  assert.equal(digest._state().pending, 0);
});

test('worker failures carry the same error type, code and message as the direct digest', async () => {
  digest.policy.offloadBytes = 1;
  try {
    const dir = path.join(root, 'folder.dll'); fs.mkdirSync(dir);
    await sameError(dir);
    if (process.platform !== 'win32') {
      const link = path.join(root, 'link.dll'); fs.symlinkSync(write('target.dll', 'target'), link);
      await sameError(link);
    }
    assert.ok(digest._state().offloaded >= 2);
  } finally { digest.policy.offloadBytes = 8 * 1024 * 1024; }
});

test('concurrent requests each receive their own file digest', async () => {
  digest.policy.offloadBytes = 1;
  try {
    const rows = Array.from({ length: 8 }, (_, index) => { const bytes = crypto.randomBytes(1024 + index); return { file: write(`part-${index}.bin`, bytes), hash: hex(bytes) }; });
    assert.deepEqual(await Promise.all(rows.map(row => digest.sha256Async(row.file))), rows.map(row => row.hash));
    assert.equal(digest._state().pending, 0);
  } finally { digest.policy.offloadBytes = 8 * 1024 * 1024; }
});

test('a broken worker never loses a digest; after repeated failures files are hashed directly', async () => {
  const healthy = digest.policy.workerFile, limit = digest.policy.maxFailures;
  digest.policy.offloadBytes = 1; digest.policy.maxFailures = digest._state().failures + 4;
  try {
    const bytes = crypto.randomBytes(2048), file = write('fallback.dll', bytes);
    // A worker that dies with a request in flight: the request is answered directly.
    digest.policy.workerFile = write('exit-worker.js', "require('node:worker_threads').parentPort.on('message', () => process.exit(3));");
    await digest._state().worker?.terminate();
    await new Promise(resolve => setImmediate(resolve));
    const failuresBefore = digest._state().failures;
    assert.equal(await digest.sha256Async(file), hex(bytes));
    assert.equal(digest._state().failures, failuresBefore + 1);
    // A worker that cannot start.
    digest.policy.workerFile = write('broken-worker.js', 'throw new Error("cannot start");');
    for (let attempt = 0; digest._state().failures < digest.policy.maxFailures; attempt++) {
      assert.ok(attempt < 4); assert.equal(await digest.sha256Async(file), hex(bytes));
    }
    const offloaded = digest._state().offloaded;
    assert.equal(await digest.sha256Async(file), hex(bytes));
    assert.equal(digest._state().offloaded, offloaded, 'no worker is started after two failures');
    assert.equal(digest._state().worker, null);
  } finally { Object.assign(digest.policy, { workerFile: healthy, maxFailures: limit, offloadBytes: 8 * 1024 * 1024 }); }
});
