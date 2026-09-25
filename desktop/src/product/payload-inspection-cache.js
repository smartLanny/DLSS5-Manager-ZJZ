'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('node:worker_threads');
const { inspectPayload } = require('./payload');

const clone = value => structuredClone(value);
const pathKey = value => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function referencedFiles(dir, result) {
  const files = new Map();
  const add = file => { if (typeof file === 'string') files.set(pathKey(file), path.resolve(file)); };
  add(path.join(dir, 'bundle.json'));
  const variants = result?.versions
    ? Object.values(result.versions).flatMap(version => Object.values(version.variants || {}))
    : result?.variants ? Object.values(result.variants) : [result];
  for (const variant of variants) for (const row of variant?.files || []) add(row.file);
  return [...files.values()].sort((a, b) => pathKey(a).localeCompare(pathKey(b)));
}

function fileState(file) {
  try {
    const stat = fs.statSync(file);
    return [pathKey(file), true, stat.isFile(), stat.size, stat.mtimeMs, stat.ctimeMs,
      String(stat.dev ?? ''), String(stat.ino ?? '')];
  } catch (error) {
    if (error.code === 'ENOENT') return [pathKey(file), false];
    throw error;
  }
}

function fingerprint(files) {
  return files.map(fileState);
}

function sameFingerprint(left, right) {
  return left.length === right.length && left.every((row, index) =>
    row.length === right[index].length && row.every((value, field) => value === right[index][field]));
}

function complete(result) {
  if (!result?.bundle) return false;
  const variants = result.versions
    ? Object.values(result.versions).flatMap(version => Object.values(version.variants || {}))
    : result.variants ? Object.values(result.variants) : [result];
  return variants.every(variant => (variant?.files || []).every(row => row.exists === false || row.valid === true));
}

function createPayloadInspectionCache(options = {}) {
  const maximum = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? Math.min(options.maxEntries, 32) : 8;
  const entries = new Map();
  const pending = new Map(); let generation = 0;
  function keyFor(dir, inspectOptions) {
    return JSON.stringify([pathKey(dir), Boolean(inspectOptions.allowMissingBundle), inspectOptions.hardwareFamily || null, inspectOptions.version || null, Boolean(inspectOptions.selectedOnly)]);
  }
  function touch(key, entry) { entries.delete(key); entries.set(key, entry); }
  function trim() { while (entries.size > maximum) entries.delete(entries.keys().next().value); }
  function cachedResult(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (!sameFingerprint(fingerprint(entry.files), entry.fingerprint)) { entries.delete(key); return null; }
    touch(key, entry); return clone(entry.result);
  }
  return Object.freeze({
    prime(dir, inspectOptions = {}) {
      const key = keyFor(dir, inspectOptions), cached = cachedResult(key);
      if (cached) return Promise.resolve(cached);
      if (pending.has(key)) return pending.get(key).then(clone);
      const epoch = generation;
      const task = new Promise((resolve, reject) => {
        const worker = new Worker(options.workerFile || path.join(__dirname, 'payload-inspection-worker.js'), {
          workerData: { dir: path.resolve(dir), options: { allowMissingBundle: inspectOptions.allowMissingBundle === true,
            hardwareFamily: inspectOptions.hardwareFamily, version: inspectOptions.version, selectedOnly: inspectOptions.selectedOnly === true } } });
        let settled = false;
        const finish = (error, result) => { if (settled) return; settled = true; void worker.terminate(); error ? reject(error) : resolve(result); };
        worker.once('message', message => {
          if (!message?.ok) { finish(Object.assign(new Error(message?.error?.message || '组件检查未完成。'), message?.error)); return; }
          try {
            const { result, files, states } = message;
            if (!sameFingerprint(fingerprint(files), states)) throw Object.assign(new Error('组件在检查期间发生变化，请重新检查。'), { code: 'ERR_PAYLOAD_SOURCE_CHANGED' });
            if (epoch === generation && complete(result)) { touch(key, { files, fingerprint: states, result: clone(result) }); trim(); }
            finish(null, clone(result));
          } catch (error) { finish(error); }
        });
        worker.once('error', error => finish(error));
        worker.once('messageerror', error => finish(error));
        worker.once('exit', code => { if (!settled) finish(Object.assign(new Error(`组件检查线程已退出（${code}）。`), { code: 'ERR_PAYLOAD_INSPECTION_WORKER' })); });
      });
      pending.set(key, task);
      task.then(() => { if (pending.get(key) === task) pending.delete(key); }, () => { if (pending.get(key) === task) pending.delete(key); });
      return task.then(clone);
    },
    inspect(dir, inspectOptions = {}) {
      const key = keyFor(dir, inspectOptions), cached = !inspectOptions.fresh && cachedResult(key);
      if (cached) return cached;
      // A split base package intentionally has absent runtime files. Their
      // missing state participates in the fingerprint, so importing them
      // invalidates the UI snapshot. Corrupt files and exceptions are not cached.
      // Deployment still performs its own fresh source/target checks.
      const result = inspectPayload(dir, inspectOptions), files = referencedFiles(dir, result);
      if (complete(result)) {
        const entry = { files, fingerprint: fingerprint(files), result: clone(result) };
        touch(key, entry); trim();
      }
      return clone(result);
    },
    invalidate(dir) {
      generation++; pending.clear();
      if (dir === undefined) { entries.clear(); return; }
      const root = pathKey(dir);
      for (const [key] of entries) if (JSON.parse(key)[0] === root) entries.delete(key);
    }
  });
}

module.exports = { createPayloadInspectionCache, referencedFiles, fileState, sameFingerprint };
