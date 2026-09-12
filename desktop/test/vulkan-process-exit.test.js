'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const script = path.resolve(__dirname, '../scripts/wait-vulkan-validation-process.ps1');
const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

test('validation keeps the real process handle and observes nonzero teardown exit', { skip: process.platform !== 'win32' }, async t => {
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(17), 1500)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const { stdout } = await run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProcessIdToWatch', String(child.pid), '-ExpectedExePath', process.execPath, '-StartedAfter', startedAt], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { step: 'process-exit', pid: child.pid, exitCode: 17, observed: true });
});

test('validation refuses an unrelated live process instead of inventing its exit status', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(run(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ProcessIdToWatch', String(process.pid), '-ExpectedExePath', path.join(path.dirname(process.execPath), 'wrong.exe'),
    '-StartedAfter', new Date(0).toISOString()], { windowsHide: true, timeout: 10000 }), error => {
    const result = JSON.parse(error.stdout); assert.equal(result.observed, false); assert.equal(result.exitCode, null);
    assert.equal(result.pid, process.pid); return true;
  });
});
