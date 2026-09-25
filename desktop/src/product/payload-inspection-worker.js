'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');
const { inspectPayload } = require('./payload');
const { referencedFiles, fileState, sameFingerprint } = require('./payload-inspection-cache');
try {
  const before = new Map(), key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  const remember = file => before.set(key(file), fileState(file));
  remember(path.join(fs.realpathSync(workerData.dir), 'bundle.json'));
  const result = inspectPayload(workerData.dir, { ...workerData.options, onFileInspect: remember });
  const files = referencedFiles(workerData.dir, result), states = files.map(fileState);
  const expected = files.map(file => before.get(key(file)) || [key(file), false]);
  if (!sameFingerprint(expected, states)) throw Object.assign(new Error('组件在检查期间发生变化，请重新检查。'), { code: 'ERR_PAYLOAD_SOURCE_CHANGED' });
  parentPort.postMessage({ ok: true, result, files, states });
} catch (error) { parentPort.postMessage({ ok: false, error: { code: error.code || 'ERR_PAYLOAD_INSPECTION', message: error.message, details: error.details } }); }
