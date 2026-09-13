'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

function workerError(message, code = 'ERR_LIBRARY_WORKER', cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

// Settings are JSON-shaped. Stable object ordering coalesces callers that
// construct equivalent settings independently; array order remains meaningful.
function scanKey(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });
}

function createLibraryWorkerClient(options = {}) {
  const workerFile = options.workerFile || path.join(__dirname, 'library-worker.js');
  let worker = null, nextId = 0, disposed = false;
  const pending = new Map(), scans = new Map();

  function rejectPending(error) {
    for (const task of pending.values()) task.reject(error);
    pending.clear(); scans.clear();
  }

  function loseWorker(instance, error) {
    if (worker !== instance) return;
    worker = null;
    rejectPending(error);
    // Error events normally precede exit; message errors need explicit cleanup.
    void instance.terminate().catch(() => {});
  }

  function ensureWorker() {
    if (disposed) throw workerError('扫描工作线程已关闭。', 'ERR_LIBRARY_WORKER_CLOSED');
    if (worker) return worker;
    const instance = new Worker(workerFile, { workerData: { documentsDir: options.documentsDir } });
    worker = instance;
    instance.on('message', result => {
      if (worker !== instance || !result || !pending.has(result.id)) return;
      const task = pending.get(result.id); pending.delete(result.id);
      if (result.ok === true) task.resolve(result.value);
      else task.reject(Object.assign(workerError(result.error?.message || '游戏扫描失败。', result.error?.code || 'ERR_LIBRARY_SCAN'), {
        name: result.error?.name || 'Error'
      }));
      if (!pending.size) instance.unref();
    });
    instance.on('error', error => loseWorker(instance, workerError('扫描工作线程发生异常，请重试。', 'ERR_LIBRARY_WORKER', error)));
    instance.on('messageerror', error => loseWorker(instance, workerError('扫描结果无法读取，请重试。', 'ERR_LIBRARY_WORKER', error)));
    instance.on('exit', code => loseWorker(instance, workerError(`扫描工作线程已退出（${code}），请重试。`, 'ERR_LIBRARY_WORKER_EXIT')));
    instance.unref();
    return instance;
  }

  function request(method, args) {
    if (!['scanAll', 'prepareSelection'].includes(method)) return Promise.reject(workerError('不支持的扫描工作请求。', 'ERR_LIBRARY_WORKER_METHOD'));
    let instance;
    try { instance = ensureWorker(); } catch (error) { return Promise.reject(error); }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      instance.ref();
      try { instance.postMessage({ id, method, args }); }
      catch (error) { pending.delete(id); if (!pending.size) instance.unref(); reject(error); }
    });
  }

  function scanAll(state, revision = 0) {
    let snapshot, key;
    try { snapshot = structuredClone(state); key = JSON.stringify([scanKey(snapshot), revision]); }
    catch (error) { return Promise.reject(error); }
    if (scans.has(key)) return scans.get(key);
    const promise = request('scanAll', [snapshot]);
    scans.set(key, promise);
    const completed = () => { if (scans.get(key) === promise) scans.delete(key); };
    promise.then(completed, completed);
    return promise;
  }

  async function dispose() {
    disposed = true;
    const instance = worker; worker = null;
    rejectPending(workerError('扫描工作线程已关闭。', 'ERR_LIBRARY_WORKER_CLOSED'));
    if (instance) await instance.terminate();
  }

  return Object.freeze({ scanAll,
    prepareSelection: (source, preferredExecutable = null) => request('prepareSelection', [source, preferredExecutable]),
    dispose });
}

module.exports = { createLibraryWorkerClient };
