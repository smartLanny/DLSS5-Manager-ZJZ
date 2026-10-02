'use strict';

// Antivirus scans, the search indexer and backup tools briefly hold a file that
// was just written or read. Renaming, deleting or overwriting it then fails with
// EBUSY/EPERM/EACCES, while the same step a moment later succeeds. File steps
// that change a game folder retry those codes for about three seconds before
// reporting the original error unchanged (so a real permission problem still
// reaches the elevation and recovery paths).
const fs = require('node:fs');

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
// Tests shorten the delays; production keeps the default schedule.
const retryPolicy = { delays: [50, 100, 200, 400, 800, 1500] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function lockedRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!LOCK_CODES.has(error?.code) || attempt >= retryPolicy.delays.length) throw error;
      await sleep(retryPolicy.delays[attempt]);
    }
  }
}

// fs.promises is looked up on every call so a replaced method is still used.
const retried = name => (...args) => lockedRetry(() => fs.promises[name](...args));
const lockedFs = Object.freeze({
  rename: retried('rename'), unlink: retried('unlink'), copyFile: retried('copyFile'), writeFile: retried('writeFile')
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
