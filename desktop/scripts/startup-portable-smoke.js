'use strict';

// Optional acceptance of the real portable wrapper and its unique inner app.
// Never treats a surviving wrapper as a ready Electron application.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createGameLaunchBroker } = require('../src/product/game-launch-broker');
const { verifyExecutable } = require('./verify-execution-level');
const { unusedLoopbackPort, inspectorConnection } = require('./startup-packaged-launch');
const { processWindow, startupLog, validateIsolationProof } = require('./startup-uninstrumented-smoke');
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

async function childProcesses(parentPid) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('Invalid owned wrapper PID.');
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); ` +
    `$rows=@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${parentPid}' | ForEach-Object { $taskProcess=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($taskProcess) { @{pid=$taskProcess.Id;parentPid=[int]$_.ParentProcessId;path=$taskProcess.Path;startTicks=$taskProcess.StartTime.ToFileTimeUtc().ToString()} } }); ConvertTo-Json -InputObject $rows -Compress`;
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  return JSON.parse(result.stdout);
}
async function processToken(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid inner application PID.');
  const code = `using System; using System.ComponentModel; using System.Runtime.InteropServices; using System.Security.Principal;
public static class PortableStartupToken {
[DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
[DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
[DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,out int data,int bytes,out int returned);
public static string[] Read(int pid) { IntPtr process=OpenProcess(0x1000,false,pid),token=IntPtr.Zero;
if(process==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
try { if(!OpenProcessToken(process,8,out token))throw new Win32Exception(Marshal.GetLastWin32Error());
int elevated,returned; if(!GetTokenInformation(token,20,out elevated,4,out returned))throw new Win32Exception(Marshal.GetLastWin32Error());
using(var identity=new WindowsIdentity(token))return new string[]{elevated.ToString(),identity.User.Value};
}finally { if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process); } }
}`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${code}\n'@; $result=[PortableStartupToken]::Read(${pid}); @{elevated=($result[0] -ne '0');sid=$result[1]}|ConvertTo-Json -Compress`;
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  return JSON.parse(result.stdout);
}
function insideTemporary(file) {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(file));
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function bindInner({ wrapper, wrapperIdentity, unpackedExecutable, expectedExeHash, expectedAsarHash, expectedSid, desiredPid }) {
  const stillWrapper = await processWindow(wrapper.pid);
  if (!stillWrapper.exists || stillWrapper.startTicks !== wrapperIdentity.startTicks || stillWrapper.path !== wrapperIdentity.path) throw new Error('Portable wrapper identity changed.');
  const children = (await childProcesses(wrapper.pid)).filter(row => path.basename(row.path || '').toLowerCase() === path.basename(unpackedExecutable).toLowerCase());
  if (children.length !== 1 || desiredPid && children[0].pid !== desiredPid) return null;
  const child = children[0], archive = path.join(path.dirname(child.path), 'resources/app.asar');
  if (BigInt(child.startTicks) < BigInt(wrapperIdentity.startTicks) || !insideTemporary(child.path) || !insideTemporary(archive)) throw new Error('Portable child is outside its expected fresh extraction.');
  if (sha256(child.path) !== expectedExeHash || sha256(archive) !== expectedAsarHash) throw new Error('Portable inner EXE/ASAR do not match the verified unpacked candidate.');
  if (!verifyExecutable(child.path, 'asInvoker').ok) throw new Error('Portable inner EXE changed its execution level.');
  const token = await processToken(child.pid);
  if (token.elevated || token.sid !== expectedSid) throw new Error('Portable child is not the same ordinary user token.');
  return { ...child, archive, tokenElevated: false, hashMatched: true };
}
async function closeOwned(identity) {
  if (!identity) return;
  const current = await processWindow(identity.pid);
  if (!current.exists || current.startTicks !== identity.startTicks || current.path !== identity.path) return;
  await processWindow(identity.pid, identity.startTicks); await sleep(700);
  const remaining = await processWindow(identity.pid);
  if (remaining.exists && remaining.startTicks === identity.startTicks && remaining.path === identity.path) process.kill(identity.pid);
}
async function waitWrapperExit(identity) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const current = await processWindow(identity.pid);
    if (!current.exists || current.startTicks !== identity.startTicks) return true;
    await sleep(200);
  }
  return false;
}
async function runPortableSmoke({ portable, unpackedExecutable, unpackedProof, logsDirectory } = {}) {
  if (!portable || !unpackedExecutable || !unpackedProof || !logsDirectory) throw new Error('Provide portable EXE, verified unpacked EXE, unpacked isolation proof and a log directory.');
  portable = fs.realpathSync(portable); unpackedExecutable = fs.realpathSync(unpackedExecutable); logsDirectory = path.resolve(logsDirectory);
  const proof = JSON.parse(fs.readFileSync(unpackedProof, 'utf8'));
  validateIsolationProof(proof, unpackedExecutable, path.join(path.dirname(unpackedExecutable), 'resources/app.asar'));
  if (!verifyExecutable(portable, 'asInvoker').ok) throw new Error('Portable wrapper must use asInvoker.');
  const portableHash = sha256(portable), root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-portable-proof-'));
  const broker = createGameLaunchBroker({ scriptPath: path.join(__dirname, '../src/product/game-launch-broker.ps1'), timeoutMs: 15000 });
  const result = { ok: false, portableSha256: portableHash, executableSha256: proof.executableSha256, sourceSha256: proof.sourceSha256,
    scope: 'Actual portable wrapper and uniquely bound inner application; fresh profiles; default sandbox; no game or driver actions invoked.', runs: [] };
  fs.mkdirSync(logsDirectory, { recursive: true });
  for (const mode of ['isolation-proof', 'ordinary']) {
    if (sha256(portable) !== portableHash) throw new Error('Portable wrapper changed after the isolation proof.');
    const directory = path.join(root, mode), userData = path.join(directory, 'user-data'); fs.mkdirSync(userData, { recursive: true });
    const port = mode === 'isolation-proof' ? await unusedLoopbackPort() : null;
    const args = [`--user-data-dir=${userData}`];
    if (port) args.push(`--inspect-brk=127.0.0.1:${port}`, `--startup-smoke-root=${directory}`);
    let wrapper, wrapperIdentity, child, inspector;
    const startedAt = Date.now();
    try {
      wrapper = await broker.launch({ exe: portable, args, cwd: path.dirname(portable) });
      wrapperIdentity = await processWindow(wrapper.pid);
      if (!wrapperIdentity.exists || wrapperIdentity.path.toLowerCase() !== portable.toLowerCase()) throw new Error('Could not bind the launched portable wrapper.');
      if (port) {
        inspector = await inspectorConnection(port, 60000);
        await inspector.request('Runtime.enable'); await inspector.request('Debugger.enable'); await inspector.request('Runtime.runIfWaitingForDebugger');
        const stopped = await inspector.paused(), frame = stopped.callFrames?.[0]?.callFrameId;
        const identityResult = await inspector.request('Debugger.evaluateOnCallFrame', { callFrameId: frame,
          expression: '({pid:process.pid,ppid:process.ppid,exe:process.execPath,main:__filename,userData:require("electron").app.getPath("userData"),portable:process.env.PORTABLE_EXECUTABLE_FILE})', returnByValue: true });
        const identity = identityResult.result?.value;
        if (identityResult.exceptionDetails || !identity || identity.ppid !== wrapper.pid || identity.userData !== userData || identity.portable.toLowerCase() !== portable.toLowerCase()) throw new Error('Portable did not preserve the isolated profile or expected parent before main execution.');
        child = await bindInner({ wrapper, wrapperIdentity, unpackedExecutable, expectedExeHash: proof.executableSha256, expectedAsarHash: proof.sourceSha256, expectedSid: wrapper.userSid, desiredPid: identity.pid });
        if (!child || child.path !== identity.exe || path.join(child.archive, 'main.js') !== identity.main) throw new Error('Could not uniquely bind the paused portable inner application.');
        const entry = path.join(__dirname, '../test/startup-runtime.electron.cjs');
        const injection = await inspector.request('Debugger.evaluateOnCallFrame', { callFrameId: frame,
          expression: `process.argv.push('--startup-smoke-main='+__filename);require(${JSON.stringify(entry)});true`, returnByValue: true });
        if (injection.exceptionDetails) throw new Error('Portable isolation fixture could not be installed.');
        await inspector.request('Debugger.resume'); inspector.close(); inspector = null;
        const reportFile = path.join(directory, 'result.json'), deadline = Date.now() + 24000;
        while (!fs.existsSync(reportFile) && Date.now() < deadline) await sleep(100);
        if (!fs.existsSync(reportFile)) throw new Error('Portable inner application did not report readiness.');
        const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        const names = new Set(report.stages.map(row => row.stage));
        if (!report.ok || report.mode !== 'normal' || !report.visible || report.configuredSandbox !== true || report.document?.startupContext?.privilege !== 'standard' ||
            !['window-visible', 'page-loaded', 'renderer-ready'].every(name => names.has(name))) throw new Error('Portable inner startup isolation proof failed.');
        fs.cpSync(path.join(directory, 'startup'), path.join(logsDirectory, mode), { recursive: true });
        fs.copyFileSync(reportFile, path.join(logsDirectory, mode, 'result.json'));
        result.runs.push({ ...report, wrapperPid: wrapper.pid, innerPid: child.pid, parentPid: child.parentPid, createdAfterWrapper: true,
          wrapperStartTicks: wrapperIdentity.startTicks, innerStartTicks: child.startTicks, innerRelativeToTemp: path.relative(os.tmpdir(), child.path),
          tokenElevated: false, userDataFlagHonoredBeforeInstrumentation: true, innerHashesMatched: true, instrumentation: true });
      } else {
        const bindDeadline = Date.now() + 60000;
        while (!child && Date.now() < bindDeadline) {
          child = await bindInner({ wrapper, wrapperIdentity, unpackedExecutable, expectedExeHash: proof.executableSha256, expectedAsarHash: proof.sourceSha256, expectedSid: wrapper.userSid });
          if (!child) await sleep(300);
        }
        if (!child) throw new Error('No unique portable inner app appeared; wrapper life does not establish readiness.');
        const minimum = Date.now() + 15000, deadline = Date.now() + 20000; let log;
        while (Date.now() < deadline) {
          log = startupLog(child.pid); const names = new Set(log?.stages.map(row => row.stage));
          if (names.has('startup-failure') || names.has('render-process-gone')) break;
          if (Date.now() >= minimum && ['window-visible', 'page-loaded', 'renderer-ready'].every(name => names.has(name))) break;
          await sleep(200);
        }
        const visible = await processWindow(child.pid), names = new Set(log?.stages.map(row => row.stage));
        const failed = log?.stages.filter(row => row.stage === 'startup-failure' || row.stage === 'render-process-gone' || row.stage === 'child-process-gone' && row.reason !== 'clean-exit') || [];
        const options = log?.stages.find(row => row.stage === 'startup-options');
        if (!visible.exists || visible.startTicks !== child.startTicks || !visible.visible || failed.length || options?.noSandbox !== false ||
            !['window-visible', 'page-loaded', 'renderer-ready'].every(name => names.has(name))) throw new Error('Portable ordinary inner application did not complete visible readiness.');
        result.runs.push({ ok: true, mode: 'normal', instrumentation: false, gameServicesReplaced: false, profileIsolated: true,
          wrapperPid: wrapper.pid, innerPid: child.pid, parentPid: child.parentPid, createdAfterWrapper: true,
          wrapperStartTicks: wrapperIdentity.startTicks, innerStartTicks: child.startTicks, innerRelativeToTemp: path.relative(os.tmpdir(), child.path),
          tokenElevated: false, innerHashesMatched: true, visible: true, elapsedMs: Date.now() - startedAt, stages: log.stages, startupLog: log.file });
      }
    } catch (error) { error.artifactRoot = root; result.error = error.message; throw error; }
    finally {
      inspector?.close(); await closeOwned(child);
      if (child && mode === 'ordinary') {
        const log = startupLog(child.pid);
        if (log) fs.writeFileSync(path.join(logsDirectory, log.file), log.bytes);
      }
      if (wrapperIdentity && !await waitWrapperExit(wrapperIdentity)) await closeOwned({ ...wrapperIdentity, pid: wrapper.pid });
      fs.writeFileSync(path.join(logsDirectory, 'portable-progress.json'), JSON.stringify(result, null, 2));
    }
  }
  if (sha256(portable) !== portableHash) throw new Error('Portable wrapper changed during acceptance.');
  result.ok = true;
  fs.writeFileSync(path.join(logsDirectory, 'portable-progress.json'), JSON.stringify(result, null, 2));
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true });
  return result;
}
if (require.main === module) {
  const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
  runPortableSmoke({ portable: option('--portable'), unpackedExecutable: option('--unpacked-executable'), unpackedProof: option('--unpacked-proof'), logsDirectory: option('--logs') }).then(result => {
    if (option('--output')) fs.writeFileSync(path.resolve(option('--output')), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, runs: result.runs.map(row => ({ instrumentation: row.instrumentation, wrapperPid: row.wrapperPid,
      innerPid: row.innerPid, tokenElevated: row.tokenElevated, visible: row.visible, stages: row.stages.map(stage => stage.stage) })) }, null, 2));
  }).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, artifactRoot: error.artifactRoot }, null, 2)); process.exitCode = 1; });
}
module.exports = { childProcesses, processToken, bindInner, runPortableSmoke };
