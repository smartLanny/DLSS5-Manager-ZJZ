'use strict';

// Hashing a large file (the DLSS model is about 160-310 MB) takes the main
// process a second or more, and an install hashes it several times; the
// window cannot respond meanwhile. Large files are hashed on a worker thread
// by the same streaming-digest-sync.sha256, so its checks, result and error
// codes are unchanged. Small files, and every file once the worker has failed
// twice, are hashed here directly.
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { sha256 } = require('./streaming-digest-sync');

const policy = { offloadBytes: 8 * 1024 * 1024, maxFailures: 2, workerFile: path.join(__dirname, 'digest-worker.js') };
const ERROR_TYPES = { TypeError, RangeError };
let worker = null, nextId = 0, failures = 0, offloaded = 0;
const pending = new Map();

function revive(data = {}) {
  const error = new (ERROR_TYPES[data.name] || Error)(data.message);
  for (const key of ['code', 'errno', 'syscall', 'path']) if (data[key] !== undefined) error[key] = data[key];
  return error;
}

function lose(instance) {
  if (worker !== instance) return;
  worker = null; failures++;
  void instance.terminate().catch(() => {});
  // Requests already sent are answered here by the same function.
  for (const [id, task] of pending) {
    pending.delete(id);
    try { task.resolve(sha256(task.file)); } catch (error) { task.reject(error); }
  }
}

function ensureWorker() {
  if (worker) return worker;
  const instance = new Worker(policy.workerFile);
  worker = instance;
  instance.on('message', reply => {
    const task = reply && pending.get(reply.id);
    if (worker !== instance || !task) return;
    pending.delete(reply.id);
    if (reply.ok === true && typeof reply.value === 'string') task.resolve(reply.value); else task.reject(revive(reply.error));
    if (!pending.size) instance.unref();
  });
  for (const event of ['error', 'messageerror', 'exit']) instance.on(event, () => lose(instance));
  instance.unref();
  return instance;
}

async function sha256Async(file) {
  let size = 0;
  try { size = fs.lstatSync(file).size; } catch {}
  if (size < policy.offloadBytes || failures >= policy.maxFailures) return sha256(file);
  let instance;
  try { instance = ensureWorker(); } catch { failures = policy.maxFailures; return sha256(file); }
  return new Promise((resolve, reject) => {
    const id = ++nextId; offloaded++;
    pending.set(id, { file, resolve, reject });
    instance.ref();
    try { instance.postMessage({ id, file }); }
    catch {
      pending.delete(id); if (!pending.size) instance.unref();
      try { resolve(sha256(file)); } catch (error) { reject(error); }
    }
  });
}

module.exports = { sha256Async, policy, _state: () => ({ worker, failures, offloaded, pending: pending.size }) };
