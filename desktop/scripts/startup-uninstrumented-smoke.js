'use strict';

// Actual packaged application, ordinary token, a verified fresh profile, no
// debugger or module replacements. Does not invoke any game/driver action.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createGameLaunchBroker } = require('../src/product/game-launch-broker');
const { verifyExecutable } = require('./verify-execution-level');
const execute = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function processWindow(pid, closeTicks = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || closeTicks !== null && !/^\d+$/.test(closeTicks)) throw new Error('Invalid owned process identity.');
  const close = closeTicks === null ? '' : `if ($taskStartTicks -ne '${closeTicks}') { throw 'Process identity changed; did not close it.' }; $closeRequested = $taskProcess.CloseMainWindow();`;
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); ` +
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class StartupVisibility { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle); }'; ` +
    `$taskProcess=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $taskProcess) { @{exists=$false}|ConvertTo-Json -Compress; exit }; ` +
    `try { $taskStartTicks=$taskProcess.StartTime.ToFileTimeUtc().ToString(); $taskPath=$taskProcess.Path; $taskHandle=$taskProcess.MainWindowHandle; ` + close +
    `} catch { if ($taskProcess.HasExited) { @{exists=$false}|ConvertTo-Json -Compress; exit }; throw }; ` +
    `if ($taskProcess.HasExited) { @{exists=$false}|ConvertTo-Json -Compress; exit }; ` +
    `@{exists=$true;pid=$taskProcess.Id;path=$taskPath;startTicks=$taskStartTicks;handle=$taskHandle.ToInt64().ToString();visible=[StartupVisibility]::IsWindowVisible($taskHandle);closeRequested=$closeRequested}|ConvertTo-Json -Compress`;
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  return JSON.parse(result.stdout);
}
function startupLog(pid) {
  const roots = [path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'xiaofeng-dlss5-manager/startup'), path.join(os.tmpdir(), 'xiaofeng-dlss5-manager/startup')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root).filter(value => /^startup-[a-f0-9-]{36}\.log$/.test(value))) {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) continue;
      const bytes = fs.readFileSync(file, 'utf8');
      const stages = bytes.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      if (stages[0]?.stage === 'process-start' && stages[0].pid === pid) return { file: name, stages, bytes };
    }
  }
  return null;
}
function validateIsolationProof(proof, executable, archive) {
  if (proof?.ok !== true || proof.packagedExecutable !== true || proof.executableSha256 !== sha256(executable) || proof.sourceSha256 !== sha256(archive) ||
      !proof.runs?.some(row => row.ok === true && row.mode === 'normal' && row.packagedExecutable === true && row.userDataFlagHonoredBeforeInstrumentation === true && row.tokenElevated === false))
    throw new Error('Require a successful isolated branded-EXE report proving --user-data-dir before instrumentation for these exact EXE/ASAR hashes.');
}
async function runUninstrumentedSmoke({ executable, proofFile, logsDirectory } = {}) {
  if (process.platform !== 'win32') throw new Error('This packaged startup acceptance requires Windows.');
  if (!executable || !proofFile) throw new Error('Provide --executable and --isolation-proof.');
  executable = fs.realpathSync(executable);
  const archive = path.join(path.dirname(executable), 'resources/app.asar');
  const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  validateIsolationProof(proof, executable, archive);
  if (!verifyExecutable(executable, 'asInvoker').ok) throw new Error('Actual EXE must use asInvoker.');
  if (logsDirectory) {
    logsDirectory = path.resolve(logsDirectory);
    const relative = path.relative(path.dirname(executable), logsDirectory);
    if (relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw new Error('Keep startup logs outside the candidate directory.');
    fs.mkdirSync(logsDirectory, { recursive: true });
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-uninstrumented-'));
  const userData = path.join(root, 'user-data'); fs.mkdirSync(userData);
  const broker = createGameLaunchBroker({ scriptPath: path.join(__dirname, '../src/product/game-launch-broker.ps1'), timeoutMs: 15000 });
  let started, ownedStartTicks, log, lastWindow, report;
  const begins = Date.now();
  try {
    started = await broker.launch({ exe: executable, args: [`--user-data-dir=${userData}`], cwd: path.dirname(executable) });
    const initial = await processWindow(started.pid);
    if (!initial.exists || path.resolve(initial.path).toLowerCase() !== executable.toLowerCase()) throw new Error('Could not bind the launched PID to the expected EXE.');
    ownedStartTicks = initial.startTicks;
    const deadline = Date.now() + 20000, minimum = Date.now() + 15000;
    while (Date.now() < deadline) {
      log = startupLog(started.pid);
      const names = new Set(log?.stages.map(row => row.stage));
      if (names.has('startup-failure') || names.has('render-process-gone') || log?.stages.some(row => row.stage === 'child-process-gone' && row.reason !== 'clean-exit')) break;
      if (Date.now() >= minimum && ['window-visible', 'page-loaded', 'renderer-ready'].every(name => names.has(name))) break;
      await sleep(250);
    }
    lastWindow = await processWindow(started.pid);
    if (lastWindow.exists && (lastWindow.startTicks !== ownedStartTicks || path.resolve(lastWindow.path).toLowerCase() !== executable.toLowerCase())) throw new Error('Returned PID no longer belongs to the launched EXE.');
    const names = new Set(log?.stages.map(row => row.stage)), options = log?.stages.find(row => row.stage === 'startup-options');
    const failed = log?.stages.filter(row => row.stage === 'startup-failure' || row.stage === 'render-process-gone' || row.stage === 'child-process-gone' && row.reason !== 'clean-exit') || [];
    const ok = started.elevated === false && lastWindow.exists && lastWindow.visible === true && !failed.length && options?.noSandbox === false &&
      ['window-visible', 'page-loaded', 'renderer-ready'].every(name => names.has(name));
    report = { ok, packagedExecutable: true, instrumentation: false, gameServicesReplaced: false, profileIsolated: true,
      scope: 'Actual EXE and ASAR, default sandbox, ordinary token, fresh verified user-data-dir; read-only real game discovery permitted; no game/driver actions invoked.',
      executableSha256: proof.executableSha256, sourceSha256: proof.sourceSha256, pid: started.pid, tokenElevated: started.elevated,
      elapsedMs: Date.now() - begins, visible: lastWindow.visible === true, windowHandle: lastWindow.handle || null,
      startupLog: log?.file || null, stages: log?.stages || [], failed,
      userDataCreated: fs.readdirSync(userData).length > 0, logsDirectory: logsDirectory || null };
    if (sha256(executable) !== proof.executableSha256 || sha256(archive) !== proof.sourceSha256) throw new Error('Candidate files changed during the startup acceptance.');
    return report;
  } catch (error) { error.artifactRoot = root; throw error; }
  finally {
    if (started) {
      const current = await processWindow(started.pid);
      if (current.exists && current.startTicks === ownedStartTicks && path.resolve(current.path).toLowerCase() === executable.toLowerCase()) {
        await processWindow(started.pid, current.startTicks);
        await sleep(750);
        const afterClose = await processWindow(started.pid);
        if (afterClose.exists && afterClose.startTicks === current.startTicks && path.resolve(afterClose.path).toLowerCase() === executable.toLowerCase()) {
          process.kill(started.pid); if (report) report.cleanup = 'Only the verified owned PID was terminated after its close request.';
        } else if (report) report.cleanup = 'Only the verified owned window was asked to close; the process exited.';
      }
      if (logsDirectory) {
        const complete = startupLog(started.pid);
        if (complete) {
          fs.writeFileSync(path.join(logsDirectory, complete.file), complete.bytes);
          if (report) report.completeLogSha256 = crypto.createHash('sha256').update(complete.bytes).digest('hex');
        }
      }
    }
    // Keep failed runs for inspection; successful runs contain only this new
    // profile and no user files. Validate the root before recursive cleanup.
    if (report?.ok && path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())) {
      await sleep(250); fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
if (require.main === module) {
  const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  runUninstrumentedSmoke({ executable: option('--executable'), proofFile: option('--isolation-proof'), logsDirectory: option('--logs') }).then(result => {
    if (option('--output')) fs.writeFileSync(path.resolve(option('--output')), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ok: result.ok, instrumentation: result.instrumentation, profileIsolated: result.profileIsolated,
      pid: result.pid, tokenElevated: result.tokenElevated, visible: result.visible, elapsedMs: result.elapsedMs,
      stages: result.stages.map(row => row.stage), failed: result.failed, cleanup: result.cleanup }, null, 2));
    if (!result.ok) process.exitCode = 1;
  }).catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, artifactRoot: error.artifactRoot }, null, 2)); process.exitCode = 1; });
}
module.exports = { runUninstrumentedSmoke, validateIsolationProof, processWindow, startupLog };
