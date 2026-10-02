'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { retryPolicy, lockedRetry, lockedFs, powerShellLockCode, POWERSHELL_HRESULT } = require('../src/core/locked-file-retry');

function shortRetries(t) {
  const delays = retryPolicy.delays; retryPolicy.delays = [1, 1, 1];
  t.after(() => { retryPolicy.delays = delays; });
}

test('a briefly locked file step is retried until it succeeds', async t => {
  shortRetries(t);
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    let calls = 0;
    const value = await lockedRetry(async () => { if (++calls < 3) throw Object.assign(new Error('locked'), { code }); return 'done'; });
    assert.equal(value, 'done'); assert.equal(calls, 3, code);
  }
});

test('a lock that outlasts the retries reports the original error, and other errors are not retried', async t => {
  shortRetries(t);
  let calls = 0;
  const locked = Object.assign(new Error('still locked'), { code: 'EBUSY' });
  await assert.rejects(lockedRetry(async () => { calls++; throw locked; }), error => error === locked);
  assert.equal(calls, retryPolicy.delays.length + 1);
  calls = 0;
  await assert.rejects(lockedRetry(async () => { calls++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), { code: 'ENOENT' });
  assert.equal(calls, 1, 'a missing file is final at once');
});

test('the retried file functions use the current fs.promises methods', async t => {
  shortRetries(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-retry-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.txt'), moved = path.join(root, 'b.txt');
  await lockedFs.writeFile(file, 'bytes');
  const rename = fs.promises.rename; let failures = 2;
  t.after(() => { fs.promises.rename = rename; });
  fs.promises.rename = async (...args) => { if (failures-- > 0) throw Object.assign(new Error('indexer'), { code: 'EBUSY' }); return rename(...args); };
  await lockedFs.rename(file, moved);
  fs.promises.rename = rename;
  assert.equal(fs.readFileSync(moved, 'utf8'), 'bytes');
  await lockedFs.copyFile(moved, file); await lockedFs.unlink(moved);
  assert.equal(fs.readFileSync(file, 'utf8'), 'bytes'); assert.equal(fs.existsSync(moved), false);
});

test('PowerShell file commits report sharing and access failures as lock codes', () => {
  assert.equal(powerShellLockCode({ stderr: 'HRESULT:-2147024864' }), 'EBUSY', 'sharing violation');
  assert.equal(powerShellLockCode({ stderr: 'HRESULT:-2147024863' }), 'EBUSY', 'lock violation');
  assert.equal(powerShellLockCode({ stderr: 'HRESULT:-2147024891' }), 'EPERM', 'access denied');
  assert.equal(powerShellLockCode({ stderr: 'HRESULT:-2147024816' }), null, 'file exists is not a lock');
  assert.equal(powerShellLockCode({ stderr: '' }), null);
  assert.match(POWERSHELL_HRESULT, /^catch \{ .*HResult.*exit 3 \}$/);
});

test('a file replaced while waiting for a retry is left alone', async t => {
  shortRetries(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'locked-retry-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'owned.addon64');
  fs.writeFileSync(file, 'bytes the manager checked');
  const unlink = fs.promises.unlink; let calls = 0;
  t.after(() => { fs.promises.unlink = unlink; });
  fs.promises.unlink = async target => {
    calls++;
    // Another program swaps the file while it is "locked".
    fs.writeFileSync(target, 'a different program wrote these bytes');
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  };
  await assert.rejects(lockedFs.unlink(file), error => error.code === 'ERR_FILE_CHANGED' && error.details.file === file);
  fs.promises.unlink = unlink;
  assert.equal(calls, 1, 'the changed file is never deleted by a retry');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a different program wrote these bytes');

  // A file that appears at a move target during the wait also stops the retry.
  const source = path.join(root, 'staged.part'), target = path.join(root, 'dxgi.dll');
  fs.writeFileSync(source, 'staged');
  const rename = fs.promises.rename; let renames = 0;
  t.after(() => { fs.promises.rename = rename; });
  fs.promises.rename = async () => { renames++; fs.writeFileSync(target, 'foreign proxy'); throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
  await assert.rejects(lockedFs.rename(source, target), { code: 'ERR_FILE_CHANGED' });
  fs.promises.rename = rename;
  assert.equal(renames, 1); assert.equal(fs.readFileSync(target, 'utf8'), 'foreign proxy');
});
