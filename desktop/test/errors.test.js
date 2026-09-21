'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appError, normalizeError } = require('../src/product/errors');

test('library and waiting recovery exit errors preserve actionable instructions across IPC', () => {
  for (const code of ['LIBRARY_CONFIRM_REQUIRED', 'LIBRARY_RESTORE_FIRST', 'WAITING_OPERATION_ACTIVE']) {
    const result = normalizeError({ code, message: '请确认仅移出，原备份保留。' });
    assert.equal(result.code, code); assert.match(result.message, /原备份保留/);
  }
});

test('bundled Core update prerequisite survives the IPC error formatter', () => {
  const result = normalizeError(appError('CORE_UPDATE_BASE_REQUIRED'));
  assert.equal(result.code, 'CORE_UPDATE_BASE_REQUIRED');
  assert.match(result.message, /已有的 DX12 原生安装/);
  assert.match(result.message, /默认 Core.*再预览切换/);
});

test('missing components name bounded files and offer player-facing recovery', () => {
  const paths = ['C:/组件/fixed/nvngx_dlssnr.dll', 'nrchain.dll', 'dxgi.dll', 'extra.dll'];
  const error = normalizeError(appError('ERR_PAYLOAD_MISSING', { files: paths }));
  assert.equal(error.code, 'ERR_PAYLOAD_MISSING');
  assert.match(error.message, /缺少安装组件/);
  assert.match(error.message, /C:\/组件\/fixed\/nvngx_dlssnr\.dll/);
  assert.match(error.message, /nrchain\.dll、dxgi\.dll等/);
  assert.doesNotMatch(error.message, /extra\.dll|release payload|F8/);
  assert.match(error.message, /完整组件目录|完整安装包/);
  assert.deepEqual(error.details.files, paths);
});

test('hash and occupied DLL failures expose the file and the action without proposing deletion', () => {
  const mismatch = normalizeError(appError('ERR_PAYLOAD_HASH', { file: 'bridge.dll', reason: 'not-x64' }));
  assert.match(mismatch.message, /bridge\.dll/);
  assert.match(mismatch.message, /64 位/);
  assert.equal(mismatch.details.reason, 'not-x64');
  for (const [code, file] of [['ERR_D3D12_CONFLICT', 'd3d12.dll'], ['ERR_RESHADER_CONFLICT', 'dxgi.dll']]) {
    const result = normalizeError(appError(code));
    assert.ok(result.message.includes(file));
    assert.match(result.message, /槽位.*未覆盖/);
    assert.match(result.message, /原工具还原/);
    assert.doesNotMatch(result.message, /删除/);
  }
  const fg = normalizeError({ code: 'SETTINGS_FG_CONFLICT', message: 'dinput8.dll 已被其他组件占用。' });
  assert.match(fg.message, /dinput8\.dll/);
  assert.match(fg.message, /核对其他工具/);
});

test('external component directory failures remain distinct and retain their path', () => {
  for (const [code, hint] of [
    ['ERR_PAYLOAD_SOURCE_INVALID', /bundle\.json/],
    ['ERR_PAYLOAD_SOURCE_MISSING', /来源缺失.*所选版本/],
    ['ERR_PAYLOAD_SOURCE_HASH', /文件与版本清单不匹配/],
    ['ERR_PAYLOAD_SOURCE_UNAVAILABLE', /重新连接.*权限/],
    ['ERR_PAYLOAD_SOURCE_CHANGED', /检查后发生变化.*重新选择/]
  ]) {
    const result = normalizeError(appError(code, { directory: 'E:/组件包', reason: 'source-check' }));
    assert.equal(result.code, code);
    assert.match(result.message, hint);
    assert.match(result.message, /E:\/组件包/);
    assert.equal(result.details.reason, 'source-check');
    assert.doesNotMatch(result.message, /F8|release payload/);
  }
  const linked = normalizeError({ code: 'ERR_PAYLOAD_SOURCE_INVALID', message: '组件来源不能是符号链接或目录联接。', details: { path: 'E:/linked' } });
  assert.match(linked.message, /符号链接或目录联接/);
});

test('obsolete bridge choice directs users to the API route instead of a deleted checkbox', () => {
  const { message } = normalizeError(appError('ERR_CARRIER_NOT_SELECTED'));
  assert.match(message, /DirectX 11/);
  assert.match(message, /安装或修复.*自动配置/);
  assert.doesNotMatch(message, /勾选|复选框|桥接已关闭/);
});

test('rollback failure preserves original code, cause and recovery stage without stacks', () => {
  const source = Object.assign(new Error('errBackendRecovery'), {
    code: 'errBackendRecovery', params: { phase: 'rollback', file: '_DLSS5_Backup/original.dll' },
    cause: Object.assign(new Error('write failed\n    at privateInternal (C:/secret.js:3)'), { code: 'EACCES' }),
    recoveryError: Object.assign(new Error('backup snapshot missing'), { code: 'ENOENT', details: { phase: 'restore-copy', file: '0.bin' } })
  });
  const result = normalizeError(source);
  assert.equal(result.code, 'ERR_BACKUP_INVALID');
  assert.equal(result.originalCode, 'errBackendRecovery');
  assert.equal(result.details.phase, 'rollback');
  assert.equal(result.details.cause.code, 'EACCES');
  assert.equal(result.details.recoveryError.code, 'ENOENT');
  assert.equal(result.details.recoveryError.details.phase, 'restore-copy');
  assert.match(result.message, /回退尚未完成/);
  assert.match(result.message, /_DLSS5_Backup\/original\.dll/);
  assert.match(result.message, /保留.*保存反馈/);
  assert.doesNotMatch(JSON.stringify(result), /privateInternal|secret\.js|"stack"|F8/);
});

test('launch failure retains the full existing confirmation and recovery details contract', () => {
  const details = { phase: 'process-spawn', gameStarted: false, recoveryStateKnown: true,
    recoverableDomains: ['sr', 'fg'], launchSettings: [
      { domain: 'sr', applied: true, runtimeVerified: false },
      { domain: 'fg', applied: false, skipped: true, noOp: true, reason: 'follow-game' }
    ], pending: [{ domain: 'sr', phase: 'write', id: 'transaction-1' }],
    allowAntiCheat: false, planId: 'preview-123', futureField: { count: 0, accepted: false, value: null } };
  const result = normalizeError({ code: 'SETTINGS_LAUNCH_FAILED', message: 'spawn denied', details });
  assert.equal(result.code, 'SETTINGS_LAUNCH_FAILED');
  assert.deepEqual(result.details, details);
  assert.match(result.message, /本次未启动游戏/);
  assert.match(result.message, /SR \/ FG 设置仍有恢复记录/);
  assert.match(result.message, /保存反馈/);
  assert.doesNotMatch(result.message, /F8/);
});

test('F8 is conditional on a started game and a runtime loading failure, not recovery', () => {
  const incoming = { code: 'SETTINGS_RUNTIME_LOAD_FAILED', message: '运行组件未加载。', details: { phase: 'runtime-load' } };
  assert.doesNotMatch(normalizeError(incoming).message, /F8/);
  incoming.details.gameStarted = false;
  assert.doesNotMatch(normalizeError(incoming).message, /F8/);
  incoming.details.gameStarted = true;
  const result = normalizeError(incoming);
  assert.match(result.message, /若已进入游戏且核心面板可用.*F8/);
  assert.match(result.message, /保存反馈/);
  incoming.details.phase = 'restore'; incoming.code = 'SETTINGS_RESTORE_FAILED';
  assert.doesNotMatch(normalizeError(incoming).message, /F8/);
});

test('public errors bound details, omit metadata and logs, and tolerate cycles without mutation', () => {
  const details = { phase: 'restore', gameStarted: false, file: { name: 'nrchain.dll', metadata: { fullManifest: 'private metadata' } },
    metadata: { bundle: 'private metadata' }, log: 'private log', stack: 'private stack', stdout: 'private stdout',
    nested: { futureField: true, beforeText: 'full config contents' }, notes: 'x'.repeat(100000), files: Array.from({ length: 1000 }, (_, index) => ({ name: `file-${index}.dll` })) };
  details.cycle = details;
  const result = normalizeError({ code: 'SETTINGS_FG_WRITE', message: '组件恢复校验失败。\n    at privateStack (secret.js:1)', details });
  assert.equal(result.details.phase, 'restore');
  assert.equal(result.details.gameStarted, false);
  assert.equal(result.details.nested.futureField, true);
  assert.deepEqual(result.details.file, { name: 'nrchain.dll' });
  assert.ok(result.details.notes.length <= 513);
  assert.ok(result.details.files.length <= 32);
  assert.ok(result.message.length <= 1101);
  assert.ok(JSON.stringify(result).length < 20000);
  assert.doesNotMatch(JSON.stringify(result), /private metadata|private log|private stack|private stdout|full config contents|privateStack|secret\.js/);
  assert.equal(details.notes.length, 100000);
  assert.equal(details.cycle, details);
});

test('unknown errors stay failures, preserve a valid code and do not disclose exception dumps', () => {
  for (const code of ['ERR_FUTURE_CASE', 'EUNEXPECTED', 'toString']) {
    const result = normalizeError({ code, message: 'private exception dump', details: { phase: 'install', newField: 42 } });
    assert.equal(result.code, code);
    assert.match(result.message, /操作失败.*保存反馈/);
    assert.doesNotMatch(result.message, /private exception|成功/);
    assert.equal(result.details.newField, 42);
    assert.equal(result.ok, undefined);
  }
  for (const value of [null, undefined, 'private exception dump', { code: 'ERR_BAD\nCODE', message: 'private exception dump' }]) {
    const result = normalizeError(value);
    assert.equal(result.code, 'ERR_INTERNAL');
    assert.match(result.message, /操作失败/);
  }
});
