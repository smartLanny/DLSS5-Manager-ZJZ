'use strict';
const { executeOperationWorker, createWindowsProcessInspector, applicationIdentity } = require('./operation-elevation');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function workerArguments(argv) {
  const legacy = argv.filter(value => typeof value === 'string' && value.startsWith('--operation-worker='));
  const hoyo = argv.filter(value => typeof value === 'string' && value.startsWith('--hoyo-launch-worker='));
  if (legacy.length && hoyo.length) throw Object.assign(Error('管理员工作类型重复。'), { code: 'OPERATION_ELEVATION_ARGUMENTS' });
  const prefix = hoyo.length ? '--hoyo-launch-worker=' : '--operation-worker=';
  const nonces = hoyo.length ? hoyo : legacy;
  if (!nonces.length) return null;
  const hashes = argv.filter(value => typeof value === 'string' && value.startsWith('--operation-request-hash='));
  const nonce = nonces[0].slice(prefix.length), requestHash = hashes[0]?.slice('--operation-request-hash='.length);
  if (nonces.length !== 1 || hashes.length !== 1 || !UUID.test(nonce) || !HASH.test(requestHash || '') ||
      argv.some(value => typeof value === 'string' && value.startsWith('--') && !value.startsWith(prefix) && !value.startsWith('--operation-request-hash=')))
    throw Object.assign(Error('一次性工作进程参数无效，未启动界面或执行操作。'), { code: 'OPERATION_ELEVATION_ARGUMENTS' });
  return { nonce, requestHash, ...(hoyo.length ? { hoyoRuntime: true } : {}) };
}
async function runOperationWorker({ userData, args, processInfo = process, appPath, runPowerShell, initialize, elevation, log }) {
  return executeOperationWorker({ userData: args.hoyoRuntime ? require('./hoyo-launch-elevation').namespace(userData) : userData, ...args, processInfo, initialize, log,
    inspectProcess: createWindowsProcessInspector(runPowerShell),
    getApplication: () => applicationIdentity({ execPath: processInfo.execPath, appPath }),
    isAdministrator: async () => (await elevation.context()).privilege === 'administrator' });
}
module.exports = { workerArguments, runOperationWorker };
