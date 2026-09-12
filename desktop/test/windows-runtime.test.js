'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { inspectVcRuntime, VC_RUNTIME_FILES } = require('../src/product/windows-runtime');

function runtimeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-vc-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of VC_RUNTIME_FILES) fs.writeFileSync(path.join(dir, name), runtimePe());
  return dir;
}

function runtimePe(machine = 0x8664) {
  const bytes = Buffer.alloc(512); bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(machine, 0x84); bytes.writeUInt16LE(0xf0, 0x94); bytes.writeUInt16LE(0x20b, 0x98);
  return bytes;
}

test('VC runtime inspection distinguishes missing and x86 files', t => {
  const dir = runtimeFixture(t);
  fs.unlinkSync(path.join(dir, 'vcruntime140_1.dll'));
  let result = inspectVcRuntime({ systemDirectory: dir, pe: { getBitness: () => 64 } });
  assert.equal(result.status, 'missing'); assert.equal(result.ready, false); assert.deepEqual(result.missing, ['vcruntime140_1.dll']);

  fs.writeFileSync(path.join(dir, 'vcruntime140_1.dll'), runtimePe());
  result = inspectVcRuntime({ systemDirectory: dir, pe: { getBitness: file => path.basename(file) === 'msvcp140.dll' ? 32 : 64 } });
  assert.equal(result.status, 'missing'); assert.deepEqual(result.missing, ['msvcp140.dll']);
  fs.writeFileSync(path.join(dir, 'msvcp140.dll'), runtimePe(0xaa64));
  result = inspectVcRuntime({ systemDirectory: dir });
  assert.equal(result.status, 'missing'); assert.deepEqual(result.missing, ['msvcp140.dll'], '64-bit ARM is not an x64 game runtime');
});

test('VC runtime inspection does not turn environment or read errors into success', t => {
  assert.equal(inspectVcRuntime({ platform: 'linux' }).status, 'unknown');
  const dir = runtimeFixture(t);
  const inaccessible = { statSync() { const error = new Error('denied'); error.code = 'EACCES'; throw error; }, accessSync() {} };
  const result = inspectVcRuntime({ systemDirectory: dir, fs: inaccessible, pe: { getBitness: () => 64 } });
  assert.equal(result.status, 'unknown'); assert.equal(result.ready, false);
});

test('available means only that the three readable files are x64 PE files', t => {
  const dir = runtimeFixture(t);
  const result = inspectVcRuntime({ systemDirectory: dir, pe: { getBitness: () => 64 } });
  assert.deepEqual(result, {
    status: 'available', ready: true, missing: [],
    message: '已找到基础 x64 VC++ 运行库文件；尚未验证组件实际加载或游戏兼容性。'
  });
});

test('game-local x64 runtimes are usable and an invalid local DLL cannot be hidden by a system copy', t => {
  const systemDirectory = runtimeFixture(t), applicationDirectory = runtimeFixture(t);
  fs.unlinkSync(path.join(systemDirectory, 'msvcp140.dll'));
  assert.equal(inspectVcRuntime({ systemDirectory, applicationDirectory }).ready, true, 'a game-local runtime does not require duplicate global installation');
  fs.writeFileSync(path.join(systemDirectory, 'msvcp140.dll'), runtimePe());
  fs.writeFileSync(path.join(applicationDirectory, 'msvcp140.dll'), runtimePe(0x014c));
  const invalid = inspectVcRuntime({ systemDirectory, applicationDirectory });
  assert.equal(invalid.ready, false); assert.match(invalid.message, /游戏 EXE 旁/);
  fs.unlinkSync(path.join(applicationDirectory, 'msvcp140.dll'));
  assert.equal(inspectVcRuntime({ systemDirectory, applicationDirectory }).ready, true, 'an absent local DLL may use the system copy');
});
