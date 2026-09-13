'use strict';

const fs = require('fs');
const path = require('path');
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
  function keyFor(dir, inspectOptions) {
    return JSON.stringify([pathKey(dir), Boolean(inspectOptions.allowMissingBundle), inspectOptions.hardwareFamily || null, inspectOptions.version || null]);
  }
  function touch(key, entry) { entries.delete(key); entries.set(key, entry); }
  function trim() { while (entries.size > maximum) entries.delete(entries.keys().next().value); }
  return Object.freeze({
    inspect(dir, inspectOptions = {}) {
      const key = keyFor(dir, inspectOptions), cached = entries.get(key);
      if (cached) {
        const current = fingerprint(cached.files);
        if (sameFingerprint(current, cached.fingerprint)) { touch(key, cached); return clone(cached.result); }
        entries.delete(key);
      }
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
      if (dir === undefined) { entries.clear(); return; }
      const root = pathKey(dir);
      for (const [key] of entries) if (JSON.parse(key)[0] === root) entries.delete(key);
    }
  });
}

module.exports = { createPayloadInspectionCache };
