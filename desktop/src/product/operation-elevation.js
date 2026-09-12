'use strict';
const fs = require('node:fs/promises');
// Electron's virtual filesystem opens entries inside ASAR, but not the archive
// itself. Identity must bind the physical archive in both parent and worker.
const physicalFs = process.versions.electron ? require('original-fs').promises : fs;
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, digestFile, atomicJson, assertLaunchNotCancelled } = require('./launch-safety');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: `OPERATION_ELEVATION_${code}`, details }); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const argument = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
const sameProcess = (actual, expected) => actual && expected && actual.pid === expected.pid && actual.startedAt === expected.startedAt && samePath(actual.executable, expected.executable);
const processIdentity = row => row && Number.isInteger(row.pid) && row.pid > 0 && typeof row.startedAt === 'string' && row.startedAt.length > 0 &&
  row.startedAt.length <= 80 && typeof row.executable === 'string' && path.isAbsolute(row.executable);

async function read(file, max = 1024 * 1024, allowIncomplete = false) {
  await noLinks(file);
  let stat; try { stat = await fs.stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > max || stat.nlink > 1) fail('RECORD', '一次性操作记录不是有效的有界普通文件。');
  try {
    const text = await fs.readFile(file, 'utf8');
    // Newly published one-shot announcements/results end in a newline. A
    // reader may race the initial write; keep waiting rather than misreporting
    // an empty or partial file as an execution result.
    if (allowIncomplete && !text.endsWith('\n')) return null;
    return JSON.parse(text);
  } catch { fail('RECORD', '一次性操作记录无法读取。'); }
}
async function writeNew(file, value) {
  await noLinks(file); await fs.mkdir(path.dirname(file), { recursive: true });
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle?.close(); }
}
function locations(userData, nonce) {
  if (!path.isAbsolute(userData || '')) fail('DIRECTORY', '一次性操作目录无效。');
  if (nonce !== undefined && !UUID.test(nonce)) fail('NONCE', '一次性操作编号无效。');
  const directory = path.join(userData, 'operation-elevation');
  return { directory, lock: path.join(directory, 'operation.lock'),
    request: nonce && path.join(directory, 'requests', `${nonce}.json`),
    claim: nonce && path.join(directory, 'claims', `${nonce}.json`),
    child: nonce && path.join(directory, 'children', `${nonce}.json`),
    response: nonce && path.join(directory, 'responses', `${nonce}.json`),
    progress: nonce && path.join(directory, 'progress', `${nonce}.json`),
    cancel: nonce && path.join(directory, 'cancel', `${nonce}.json`) };
}
async function activeLock(userData) {
  const lock = await read(locations(userData).lock, 16384);
  if (!lock || lock.child || !UUID.test(lock.nonce || '')) return lock;
  const announcement = await read(locations(userData, lock.nonce).child, 16384, true);
  if (!announcement) return lock;
  if (announcement.version !== 1 || announcement.nonce !== lock.nonce || announcement.requestHash !== lock.requestHash || !processIdentity(announcement.child))
    fail('CHILD', '工作进程关联记录不匹配。');
  return { ...lock, child: announcement.child, state: 'running' };
}
function validateRequest(row, nonce, requestHash, now) {
  if (!row || row.version !== 1 || row.nonce !== nonce || !UUID.test(row.planId || '') || !HASH.test(row.fingerprint || '') ||
      !HASH.test(requestHash || '') || hash(row) !== requestHash || typeof row.gameId !== 'string' || !row.gameId || row.gameId.length > 256 ||
      !processIdentity(row.parent) || !row.application || !path.isAbsolute(row.application.execPath || '') || !path.isAbsolute(row.application.appPath || '') ||
      !HASH.test(row.application.mainHash || '') || !HASH.test(row.application.codeHash || '') || !path.isAbsolute(row.target?.exe || '') || !HASH.test(row.target?.exeHash || '') ||
      !Number.isFinite(row.createdAt) || !Number.isFinite(row.expiresAt) || row.createdAt > now + 5000 || row.expiresAt <= now || row.expiresAt - row.createdAt > 120000 ||
      typeof row.allowAntiCheat !== 'boolean') fail('REQUEST', '一次性操作请求已过期、身份不符或内容发生变化。');
  const fields = ['version', 'nonce', 'planId', 'fingerprint', 'gameId', 'target', 'parent', 'application', 'createdAt', 'expiresAt', 'allowAntiCheat'];
  if (Object.keys(row).some(key => !fields.includes(key))) fail('REQUEST', '一次性请求包含未允许的字段。');
}
function validateLock(lock, request, requestHash) {
  if (!lock || lock.version !== 1 || lock.nonce !== request.nonce || lock.requestHash !== requestHash ||
      !sameProcess(lock.parent, request.parent) || !['reserved', 'running'].includes(lock.state)) fail('LOCK', '一次性操作锁与请求不一致。');
}
function validateResponse(row, request, requestHash, child) {
  if (!row || row.version !== 1 || row.nonce !== request.nonce || row.requestHash !== requestHash || row.planId !== request.planId ||
      row.fingerprint !== request.fingerprint || !sameProcess(row.parent, request.parent) || !sameProcess(row.child, child) ||
      !samePath(row.target?.exe, request.target.exe) || row.target.exeHash !== request.target.exeHash || typeof row.ok !== 'boolean' ||
      row.ok && (row.targetVerified !== true || row.result?.applied !== true)) fail('RESPONSE', '管理员工作进程未返回与本次请求匹配的执行结果。');
  return row;
}

function createWindowsProcessInspector(runPowerShell) {
  return async pid => {
    if (!Number.isInteger(pid) || pid < 1) fail('PROCESS', '进程身份无效。');
    const queryImage = 'using System;using System.Text;using System.Runtime.InteropServices;public static class ExactProcessImage{[DllImport("kernel32.dll",SetLastError=true)]public static extern IntPtr OpenProcess(uint a,bool b,uint c);[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool QueryFullProcessImageName(IntPtr h,uint f,StringBuilder b,ref uint n);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}';
    const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -eq $p){'null'}else{$image=[string]$p.ExecutablePath;if(!$image){Add-Type -TypeDefinition ${quote(queryImage)};$h=[ExactProcessImage]::OpenProcess(4096,$false,${pid});if($h -ne [IntPtr]::Zero){try{$b=New-Object Text.StringBuilder 32768;$n=[uint32]32768;if([ExactProcessImage]::QueryFullProcessImageName($h,0,$b,[ref]$n)){$image=$b.ToString()}}finally{[void][ExactProcessImage]::CloseHandle($h)}}};[ordered]@{pid=[int]$p.ProcessId;executable=$image;startedAt=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
    let row; try { row = JSON.parse(await runPowerShell(command, 10000)); } catch { fail('PROCESS', '无法核对工作进程身份，请导出诊断。'); }
    if (row === null) return null;
    if (!processIdentity(row)) fail('PROCESS', '无法完整核对进程路径及启动时间。');
    return row;
  };
}
async function archiveDigest(file) {
  const full = path.resolve(file), root = path.parse(full).root; let current = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await physicalFs.lstat(current);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1)
      fail('APPLICATION', '管理器代码包路径包含链接，无法核对安装身份。');
  }
  const handle = await physicalFs.open(full, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1 || before.size > 64 * 1024 * 1024)
      fail('APPLICATION', '管理器代码包不是有效的有界普通文件。');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      fail('APPLICATION', '管理器代码包在校验过程中改变。');
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } finally { await handle.close(); }
}
async function applicationIdentity({ execPath, appPath }) {
  const mainHash = await digestFile(path.join(appPath, 'main.js'));
  if (!HASH.test(mainHash || '')) fail('APPLICATION', '无法验证当前管理器入口文件。');
  let codeHash;
  if (/\.asar$/i.test(appPath)) codeHash = await archiveDigest(appPath);
  else {
    const rows = [], pending = ['main.js', 'package.json', 'package-lock.json', 'product.json', 'src', 'vendor']; let bytes = 0;
    while (pending.length) {
      const rel = pending.pop(), file = path.join(appPath, rel); await noLinks(file);
      let stat; try { stat = await fs.stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isDirectory()) for (const entry of await fs.readdir(file)) pending.push(path.join(rel, entry));
      else if (/\.(?:js|cjs|json|ps1)$/i.test(rel)) {
        bytes += stat.size;
        if (rows.length >= 4096 || bytes > 64 * 1024 * 1024) fail('APPLICATION', '管理器代码范围超过有界校验范围。');
        rows.push([rel.replaceAll('\\', '/'), await digestFile(file)]);
      }
    }
    codeHash = hash(rows.sort((a, b) => a[0].localeCompare(b[0])));
  }
  if (!HASH.test(codeHash || '')) fail('APPLICATION', '无法验证当前管理器代码包。');
  return { execPath: path.resolve(execPath), appPath: path.resolve(appPath), mainHash, codeHash };
}

function createOperationElevation({ userData, plans, processInfo = process, appPath, packaged = true, runPowerShell,
  inspectProcess = createWindowsProcessInspector(runPowerShell), getApplication = () => applicationIdentity({ execPath: processInfo.execPath, appPath }),
  now = Date.now, sleep = delay, timeoutMs = 10 * 60000, pollMs = 250, log = () => {},
  workerFlag = '--operation-worker', onProgress = null, onReserved = null, onDispatched = null, cancelled = null }) {
  if (!['--operation-worker', '--hoyo-launch-worker'].includes(workerFlag)) fail('WORKER', '不支持的管理员工作类型。');
  const base = locations(userData); let busy = false;
  async function inspect() {
    const lock = await activeLock(userData);
    if (!lock) return { active: false, canRecover: false };
    if (lock.version !== 1 || !UUID.test(lock.nonce || '') || !HASH.test(lock.requestHash || '') || !processIdentity(lock.parent))
      fail('LOCK', '一次性操作锁损坏，请导出诊断；不会猜测删除锁。');
    const parent = await inspectProcess(lock.parent.pid), child = lock.child ? await inspectProcess(lock.child.pid) : null;
    return { active: true, nonce: lock.nonce, state: lock.state, workerRunning: Boolean(lock.child && sameProcess(child, lock.child)),
      parentRunning: Boolean(sameProcess(parent, lock.parent)), canRecover: !busy && !sameProcess(child, lock.child) && (!sameProcess(parent, lock.parent) || lock.parent.pid === processInfo.pid) };
  }
  async function assertAvailable() {
    if (busy || await read(base.lock, 16384)) fail('BUSY', '一次性管理员操作尚未结束或需要恢复；当前窗口不会同时执行其他修改。');
  }
  async function removeLock(nonce, requestHash) {
    const lock = await read(base.lock, 16384);
    if (!lock || lock.nonce !== nonce || lock.requestHash !== requestHash) fail('LOCK', '一次性操作锁已改变，已保留现状。');
    await noLinks(base.lock); await fs.unlink(base.lock);
  }
  async function recover() {
    const state = await inspect(); if (!state.active) return { recovered: false, unchanged: true };
    if (!state.canRecover) fail('BUSY', '工作进程可能仍在执行，不能释放操作锁。');
    const lock = await read(base.lock, 16384); await removeLock(lock.nonce, lock.requestHash);
    return { recovered: true, needsDomainRecovery: true, message: '一次性工作进程已结束，请先恢复未完成操作，再重新预览。' };
  }
  async function apply(gameId, planId, consent = {}) {
    const assertNotCancelled = () => assertLaunchNotCancelled({ cancelled });
    assertNotCancelled();
    if (processInfo.platform !== 'win32') fail('PLATFORM', '一次性管理员操作仅支持 Windows。');
    if (consent.confirm !== true || !UUID.test(planId || '') || !HASH.test(consent.fingerprint || '') ||
        Object.keys(consent).some(key => !['confirm', 'fingerprint', 'allowAntiCheat'].includes(key))) fail('CONSENT', '请从具体变更预览中明确选择本次管理员应用。');
    await assertAvailable(); busy = true;
    let request, requestHash, child = null, lockCreated = false, responseVerified = false;
    try {
      const plan = await plans.loadPlan(planId, consent.fingerprint);
      assertNotCancelled();
      if (plan.gameId !== gameId || plan.fingerprint !== consent.fingerprint || plan.blockers?.length || plan.expiresAt <= now()) fail('PLAN', '当前操作预览不属于所选游戏、已过期或仍有阻断项。');
      const target = { exe: plan.exe, exeHash: plan.before?.exeSha256 };
      if (!path.isAbsolute(target.exe || '') || !HASH.test(target.exeHash || '')) fail('TARGET', '操作预览缺少真实游戏程序身份。');
      const parent = await inspectProcess(processInfo.pid), application = await getApplication();
      assertNotCancelled();
      if (!processIdentity(parent) || !samePath(parent.executable, application.execPath)) fail('PARENT', '无法确认当前普通界面进程身份。');
      const createdAt = now();
      request = { version: 1, nonce: crypto.randomUUID(), planId, fingerprint: consent.fingerprint, gameId, target, parent, application,
        createdAt, expiresAt: Math.min(plan.expiresAt, createdAt + 120000), allowAntiCheat: consent.allowAntiCheat === true };
      requestHash = hash(request); const files = locations(userData, request.nonce);
      await writeNew(base.lock, { version: 1, nonce: request.nonce, requestHash, parent, child: null, state: 'reserved' }); lockCreated = true;
      await writeNew(files.request, request);
      if (onReserved) await onReserved({ gameId, nonce: request.nonce, requestHash });
      assertNotCancelled();
      const args = [...(packaged ? [] : [appPath]), `${workerFlag}=${request.nonce}`, `--operation-request-hash=${requestHash}`];
      // Fixed trusted executable and worker arguments only. No shell fragments,
      // arbitrary JSON steps, inherited debug flags or portable-wrapper restart.
      const command = `$ErrorActionPreference='Stop'; $env:NODE_OPTIONS=$null; $env:ELECTRON_RUN_AS_NODE=$null; $env:__COMPAT_LAYER=$null; $p=Start-Process -FilePath ${quote(application.execPath)} -WorkingDirectory ${quote(path.dirname(application.execPath))} -ArgumentList ${quote(args.map(argument).join(' '))} -Verb RunAs -WindowStyle Hidden -PassThru; $p.Id`;
      log('operation-elevation-requested', { nonce: request.nonce, planId });
      const pidText = await runPowerShell(command, 60000);
      if (!/^\d+$/.test(String(pidText).trim())) fail('LAUNCH', 'Windows 未返回可核对的工作进程编号。');
      child = await inspectProcess(Number(String(pidText).trim()));
      if (!processIdentity(child) || !samePath(child.executable, application.execPath)) fail('CHILD', '工作进程的路径或启动身份不匹配。');
      validateLock(await read(base.lock), request, requestHash);
      // Keep the reservation immutable. A separate write-once child identity
      // avoids Windows rename/share races with the worker's lock reader.
      await writeNew(files.child, { version: 1, nonce: request.nonce, requestHash, child });
      if (onDispatched) await onDispatched({ gameId, nonce: request.nonce, requestHash, child });
      const deadline = now() + timeoutMs;
      let progressSequence = 0;
      while (now() <= deadline) {
        if (onProgress) {
          const progress = await read(files.progress, 1024 * 1024, true);
          if (progress) {
            validateResponse(progress, request, requestHash, child);
            if (!Number.isSafeInteger(progress.sequence) || progress.sequence < 1) fail('PROGRESS', '管理员运行记录的序号无效。');
            if (progress.sequence > progressSequence) { progressSequence = progress.sequence; await onProgress(progress.result.progress); }
          }
        }
        let response = await read(files.response, 1024 * 1024, true);
        if (!response) {
          const current = await inspectProcess(child.pid);
          if (!sameProcess(current, child)) {
            // The worker may publish and exit between the first file read and
            // this process snapshot. Re-read its write-once result before
            // classifying an ordinary completion as an absent response.
            response = await read(files.response, 1024 * 1024, true);
            if (!response) fail('NO_RESPONSE', '工作进程已退出，但没有匹配的执行结果。请先核对并恢复未完成操作，再重新预览。', { needsRecovery: true });
          }
        }
        if (response) {
          const checked = validateResponse(response, request, requestHash, child); responseVerified = true;
          if (!checked.ok) fail('WORKER_FAILED', checked.error?.message || '管理员工作进程未完成本次操作。', { worker: checked, needsRecovery: true });
          return { ...checked.result, elevated: true, worker: { nonce: request.nonce, pid: child.pid, targetVerified: true }, runtimeVerified: false };
        }
        await sleep(pollMs);
      }
      fail('TIMEOUT', '工作进程尚未返回结果。已保留操作锁和恢复记录，不会重复执行。', { needsRecovery: true });
    } catch (error) {
      log('operation-elevation-failed', { code: error.code, message: error.message, nonce: request?.nonce });
      if (error.code === 'LAUNCH_CANCELLED' || String(error.code || '').startsWith('OPERATION_ELEVATION_')) throw error;
      fail('START_FAILED', '未能完成本次管理员操作，原窗口已保留。若已开始写入，请先恢复，再重新预览。', { cause: { code: error.code, message: error.message }, needsRecovery: true });
    } finally {
      if (lockCreated) {
        let stopped = !child;
        if (child && !responseVerified) { try { stopped = !sameProcess(await inspectProcess(child.pid), child); } catch { stopped = false; } }
        if (responseVerified || stopped) { try { await removeLock(request.nonce, requestHash); } catch (error) { log('operation-elevation-lock-retained', { code: error.code }); } }
      }
      busy = false;
    }
  }
  return Object.freeze({ apply, inspect, recover, assertAvailable, get busy() { return busy; } });
}

async function executeOperationWorker({ userData, nonce, requestHash, processInfo = process, inspectProcess,
  getApplication, initialize, isAdministrator, now = Date.now, sleep = delay, log = () => {} }) {
  const files = locations(userData, nonce); let request = null, child = null, claimed = false, targetVerified = false;
  try {
    request = await read(files.request); validateRequest(request, nonce, requestHash, now());
    const application = await getApplication();
    if (!samePath(application.execPath, request.application.execPath) || !samePath(application.appPath, request.application.appPath) || application.mainHash !== request.application.mainHash || application.codeHash !== request.application.codeHash)
      fail('APPLICATION', '管理器代码或安装位置在预览后改变。');
    if (!sameProcess(await inspectProcess(request.parent.pid), request.parent)) fail('PARENT', '发起请求的普通界面进程已退出或身份发生变化。');
    child = await inspectProcess(processInfo.pid);
    if (!processIdentity(child) || !samePath(child.executable, application.execPath)) fail('CHILD', '管理员工作进程身份无法核对。');
    let lock;
    for (let i = 0; i < 100; i++) {
      lock = await activeLock(userData); validateLock(lock, request, requestHash);
      if (lock.child) break; await sleep(100);
    }
    if (!sameProcess(lock.child, child)) fail('CHILD', '实际工作进程与父窗口启动的进程不一致。');
    validateRequest(request, nonce, requestHash, now());
    // An exclusive durable claim prevents replay, even after success, failure,
    // application restart or a delayed duplicate worker invocation.
    try { await writeNew(files.claim, { version: 1, nonce, requestHash, child, claimedAt: now() }); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') fail('REPLAY', '这份一次性操作请求已被领取，不能再次执行。'); throw error; }
    if (typeof isAdministrator !== 'function' || await isAdministrator() !== true) fail('PRIVILEGE', '工作进程没有取得管理员权限，未执行任何操作。');
    let progressSequence = 0;
    const publish = async progress => {
      const response = { version: 1, nonce, requestHash, planId: request.planId, fingerprint: request.fingerprint,
        parent: request.parent, child, target: request.target, targetVerified: true, ok: true,
        sequence: ++progressSequence, result: { applied: true, progress } };
      if (Buffer.byteLength(JSON.stringify(response)) > 900 * 1024) fail('PROGRESS', '管理员运行记录超过允许大小。');
      await atomicJson(files.progress, response);
    };
    const parentAlive = async () => sameProcess(await inspectProcess(request.parent.pid), request.parent);
    const cancelled = async () => {
      const row = await read(files.cancel, 16384, true);
      return row?.version === 1 && row.nonce === nonce && row.requestHash === requestHash && row.cancel === true;
    };
    const { plans } = await initialize({ publish, parentAlive, cancelled });
    const plan = await plans.loadPlan(request.planId, request.fingerprint);
    if (plan.gameId !== request.gameId || !samePath(plan.exe, request.target.exe) || plan.before?.exeSha256 !== request.target.exeHash ||
        plan.fingerprint !== request.fingerprint || plan.blockers?.length) fail('TARGET', '重新检测后的计划或目标程序身份与本次预览不一致。');
    targetVerified = true;
    const currentLock = await activeLock(userData); validateLock(currentLock, request, requestHash);
    if (!sameProcess(currentLock.child, child) || !sameProcess(await inspectProcess(request.parent.pid), request.parent))
      fail('PARENT', '父窗口或工作进程关联在执行前改变，未开始写入。');
    const result = await plans.apply(request.planId, { confirm: true, fingerprint: request.fingerprint, allowAntiCheat: request.allowAntiCheat });
    if (result?.applied !== true) fail('RESULT', '操作服务没有确认本次计划执行完成。');
    const response = { version: 1, nonce, requestHash, planId: request.planId, fingerprint: request.fingerprint,
      parent: request.parent, child, target: request.target, targetVerified, ok: true, result, finishedAt: now() };
    await writeNew(files.response, response); log('operation-worker-completed', { nonce }); return response;
  } catch (error) {
    log('operation-worker-failed', { nonce, code: error.code, message: error.message });
    if (claimed && request && child) {
      const response = { version: 1, nonce, requestHash, planId: request.planId, fingerprint: request.fingerprint,
        parent: request.parent, child, target: request.target, targetVerified, ok: false,
        error: { code: error.code || 'OPERATION_WORKER_FAILED', message: error.message, details: error.details }, finishedAt: now() };
      try { await writeNew(files.response, response); } catch {}
      return response;
    }
    throw error;
  }
}

module.exports = { createOperationElevation, executeOperationWorker, createWindowsProcessInspector, applicationIdentity, locations, hash };
