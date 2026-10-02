'use strict';

// Read-only discovery and PE inspection run here, away from Electron's main
// event loop. Keep one service and serialize requests; scanAll already bounds
// its own directory I/O and this worker must not multiply full-library scans.
const { parentPort, workerData } = require('node:worker_threads');
const pe = require('../core/pe');
const { createLibraryService } = require('./library-service');
const { createMarkerMemo } = require('./marker-memo');

if (!parentPort) throw new Error('Library worker requires a worker thread.');
// Every reader in this thread (the upstream scanner, API evidence, Unity
// check) calls pe.findMarkers through the shared module object.
const memo = createMarkerMemo({ original: pe.findMarkers, file: workerData?.markerCache?.file || null,
  appVersion: String(workerData?.markerCache?.version || '') });
pe.findMarkers = memo.findMarkers;
const library = createLibraryService({ documentsDir: workerData?.documentsDir });
const methods = Object.freeze({
  // A manual refresh reads every file again.
  scanAll: (state, options) => { if (options?.fresh === true) memo.clear(); return library.scanAll(state); },
  scanGames: (state, dirs) => library.scanGames(state, dirs),
  prepareSelection: (source, preferredExecutable) => library.prepareSelection(source, preferredExecutable)
});
let queue = Promise.resolve();

function serializedError(error) {
  return { name: typeof error?.name === 'string' ? error.name : 'Error',
    message: typeof error?.message === 'string' ? error.message : '游戏扫描失败。',
    code: typeof error?.code === 'string' ? error.code : 'ERR_LIBRARY_SCAN' };
}

parentPort.on('message', request => {
  if (!request || !Number.isSafeInteger(request.id) || request.id <= 0) return;
  queue = queue.then(async () => {
    let reply;
    try {
      if (!Object.hasOwn(methods, request.method) || !Array.isArray(request.args))
        throw Object.assign(new Error('不支持的扫描工作请求。'), { code: 'ERR_LIBRARY_WORKER_METHOD' });
      reply = { id: request.id, ok: true, value: await methods[request.method](...request.args) };
    } catch (error) {
      reply = { id: request.id, ok: false, error: serializedError(error) };
    }
    // Saved before the reply, so a finished scan's reads are already on disk.
    memo.save();
    parentPort.postMessage(reply);
  });
});
