'use strict';

// Antivirus scans, the search indexer and backup tools briefly hold a file that
// was just written or read. Renaming, deleting or overwriting it then fails with
// EBUSY/EPERM/EACCES, while the same step a moment later succeeds. File steps
// that change a game folder retry those codes for about three seconds before
// reporting the original error unchanged (so a real permission problem still
// reaches the elevation and recovery paths).
//
// Callers check ownership and hashes once, right before the step. A retry
// must not act on a file that another program replaced in the meantime, so
// every guarded path has to keep the identity it had before the first try.
const fs = require('node:fs');

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
// Tests shorten the delays; production keeps the default schedule.
const retryPolicy = { delays: [50, 100, 200, 400, 800, 1500] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function identity(file) {
  try {
    const stat = fs.lstatSync(file);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isFile(), stat.isSymbolicLink()].join(':');
  } catch (error) {
    // Unreadable metadata is compared like any other value; only a later
    // difference stops the retries, the first attempt behaves as before.
    return error.code === 'ENOENT' ? null : `error:${error.code}`;
  }
}
const changed = file => Object.assign(new Error('文件在等待重试时被其他程序改变，已停止，未覆盖或删除。'),
  { code: 'ERR_FILE_CHANGED', details: { file } });

async function lockedRetry(operation, guard = []) {
  const paths = guard.filter(file => typeof file === 'string');
  const before = paths.map(identity);
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!LOCK_CODES.has(error?.code) || attempt >= retryPolicy.delays.length) throw error;
      await sleep(retryPolicy.delays[attempt]);
      const moved = paths.find((file, index) => identity(file) !== before[index]);
      if (moved !== undefined) throw changed(moved);
    }
  }
}

// fs.promises is looked up on every call so a replaced method is still used.
const lockedFs = Object.freeze({
  rename: (source, target) => lockedRetry(() => fs.promises.rename(source, target), [source, target]),
  unlink: file => lockedRetry(() => fs.promises.unlink(file), [file]),
  copyFile: (source, target, ...rest) => lockedRetry(() => fs.promises.copyFile(source, target, ...rest), [source, target]),
  writeFile: (file, ...rest) => lockedRetry(() => fs.promises.writeFile(file, ...rest), [file])
});

// Windows PowerShell reports a failed [IO.File]::Move/Replace through the
// exception's HRESULT; scripts print it as "HRESULT:<n>" on stderr.
const HRESULT_CODES = new Map([[-2147024864, 'EBUSY'], [-2147024863, 'EBUSY'], [-2147024891, 'EPERM']]);
function powerShellLockCode(error) {
  const match = /HRESULT:(-?\d+)/.exec(String(error?.stderr || ''));
  return match ? HRESULT_CODES.get(Number(match[1])) || null : null;
}
const POWERSHELL_HRESULT = "catch { $e=$_.Exception; while ($e.InnerException) { $e=$e.InnerException }; [Console]::Error.Write('HRESULT:' + $e.HResult); exit 3 }";

module.exports = { LOCK_CODES, retryPolicy, lockedRetry, lockedFs, powerShellLockCode, POWERSHELL_HRESULT };
