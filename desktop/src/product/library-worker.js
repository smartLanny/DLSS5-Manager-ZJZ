'use strict';

// Read-only discovery and PE inspection run here, away from Electron's main
// event loop. Keep one service and serialize requests; scanAll already bounds
// its own directory I/O and this worker must not multiply full-library scans.
const { parentPort, workerData } = require('node:worker_threads');
const { createLibraryService } = require('./library-service');

if (!parentPort) throw new Error('Library worker requires a worker thread.');
const library = createLibraryService({ documentsDir: workerData?.documentsDir });
const methods = Object.freeze({
  scanAll: state => library.scanAll(state),
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
    try {
      if (!Object.hasOwn(methods, request.method) || !Array.isArray(request.args))
        throw Object.assign(new Error('不支持的扫描工作请求。'), { code: 'ERR_LIBRARY_WORKER_METHOD' });
      const value = await methods[request.method](...request.args);
      parentPort.postMessage({ id: request.id, ok: true, value });
    } catch (error) {
      parentPort.postMessage({ id: request.id, ok: false, error: serializedError(error) });
    }
  });
});
