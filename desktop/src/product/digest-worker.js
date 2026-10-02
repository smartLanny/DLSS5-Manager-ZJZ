'use strict';
const { parentPort } = require('node:worker_threads');
const { sha256 } = require('./streaming-digest-sync');

parentPort.on('message', ({ id, file }) => {
  try { parentPort.postMessage({ id, ok: true, value: sha256(file) }); }
  catch (error) {
    const { name, message, code, errno, syscall, path } = error instanceof Error ? error : { message: String(error) };
    parentPort.postMessage({ id, ok: false, error: { name, message, code, errno, syscall, path } });
  }
});
