'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const upstream = require('../../vendor/DLSS5-Swapper/src/core/install-guards.js');

function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, {
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function normalizedExecutable(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return path.resolve(value).toLowerCase(); } catch { return null; }
}

function numericPid(value) {
  if (value === null || value === undefined || value === '') return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processRows(value) {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.every(row => row && typeof row === 'object')) throw new TypeError('Invalid process snapshot');
  return rows;
}

function independentEngineReporter(row, gameDir, gameExePath) {
  if (String(row.Name || '').toLowerCase() !== 'crashreportclient.exe' || typeof row.ExecutablePath !== 'string' || !path.isAbsolute(row.ExecutablePath)) return false;
  const root = normalizedExecutable(gameDir), game = normalizedExecutable(gameExePath), processPath = normalizedExecutable(row.ExecutablePath);
  if (!root || !game || !processPath || game === processPath) return false;
  const selectedRelative = path.relative(root, game);
  if (path.isAbsolute(selectedRelative)) return false;
  const selected = selectedRelative.split(path.sep);
  // Only the known Unreal sibling layout is independent of the deployment
  // directory. Reporters beside the game or in any other location stay guarded.
  if (selected.length !== 4 || ['..', 'engine'].includes(selected[0]) || selected[1] !== 'binaries' || selected[2] !== 'win64') return false;
  const reporter = path.join(root, 'engine', 'binaries', 'win64', 'crashreportclient.exe');
  if (processPath !== reporter) return false;
  try {
    // Prove that these names resolve to ordinary separate files; a junction,
    // symlink or hardlink must not turn the apparent sibling into deployed code.
    for (const source of [path.resolve(gameExePath), path.resolve(row.ExecutablePath)]) {
      if (normalizedExecutable(fs.realpathSync.native(source)) !== normalizedExecutable(source)) return false;
      let current = source;
      for (let depth = 0; depth <= 4; depth++) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || (depth === 0 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) return false;
        if (normalizedExecutable(current) === root) break;
        current = path.dirname(current);
      }
    }
    const deployment = /^(?:(?:dxgi|d3d9|d3d10|d3d11|d3d12|opengl32|version|winmm|nvngx(?:_[^.]*)?|nrchain(?:_[^.]*)?)\.dll|reshade\.ini|global\.ini|_dlss5_backup|reshade-shaders)$|\.(?:addon(?:32|64)?|asi)$/i;
    const entries = fs.opendirSync(path.dirname(row.ExecutablePath));
    try {
      let entry, examined = 0;
      while ((entry = entries.readSync()) !== null) {
        if (++examined > 256 || entry.isSymbolicLink() || deployment.test(entry.name)) return false;
      }
    } finally { entries.closeSync(); }
    return true;
  } catch { return false; }
}

const powershellPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

// The list leaves PowerShell as Base64 of UTF-8 JSON. Plain output follows the
// console code page (GBK on Chinese Windows), which garbles a path such as a
// game folder named in Chinese, so the game would not be recognized as running.
const SNAPSHOT = '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject ' +
  '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath))))';

function decodeSnapshot(text) {
  const value = String(text || '').trim();
  if (!value || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new TypeError('Invalid process snapshot');
  return processRows(JSON.parse(Buffer.from(value, 'base64').toString('utf8')));
}

async function systemProcesses(runner = run) {
  return decodeSnapshot(await runner(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${SNAPSHOT}`]));
}

// Starting PowerShell takes most of a check's 1-3 s, and one install checks
// before every stage and file group. A host started on first use answers each
// request with a list taken after the request arrives; nothing is reused, so a
// game started a moment ago is still seen. Each request carries a random id
// and is answered on one line. A failed, slow or garbled answer stops the host
// and that check runs the one-shot query instead. The session then uses only
// the one-shot query if the host never answered, or after a second failure.
const HOST_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'while ($true) { $id = [Console]::In.ReadLine(); if ($null -eq $id) { break }',
  `try { $line = $id + ' OK ' + (${SNAPSHOT}) } catch { $line = $id + ' ERR' }`,
  '[Console]::Out.Write($line + [char]10); [Console]::Out.Flush() }'
].join('; ');
const HOST_LINE = /^([0-9a-f]{32}) (OK|ERR)(?: (\S+))?$/;

function spawnProcessHost() {
  // -InputFormat None keeps PowerShell itself from reading the request lines.
  return spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', HOST_SCRIPT],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
}

function createProcessHost(options = {}) {
  const start = options.spawn || spawnProcessHost;
  const timeoutMs = options.timeoutMs || 15000, idleMs = options.idleMs || 60000, maxFailures = options.maxFailures || 2;
  let child = null, buffer = '', pending = null, idle = null, failures = 0, worked = false, queue = Promise.resolve();

  function stop() {
    clearTimeout(idle); idle = null;
    const current = child; child = null; buffer = '';
    if (current) { try { current.stdin.destroy(); } catch {} try { current.kill(); } catch {} }
  }
  function settle(error, rows) {
    const request = pending; if (!request) return;
    pending = null; clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(rows);
  }
  function broken(reason) {
    // A host that has never answered will not start working later.
    failures = worked ? failures + 1 : maxFailures; stop();
    settle(Object.assign(new Error(`process host ${reason}`), { code: 'ERR_PROCESS_HOST' }));
  }
  function receive(line) {
    const match = HOST_LINE.exec(line);
    if (!match) return; // Not an answer line; the request keeps its timeout.
    if (!pending || match[1] !== pending.id) return broken('answered an unknown request');
    if (match[2] === 'ERR') return settle(Object.assign(new Error('process query failed'), { code: 'ERR_PROCESS_QUERY' }));
    let rows;
    try { rows = decodeSnapshot(match[3]); } catch { return broken('returned an invalid list'); }
    worked = true; settle(null, rows);
  }
  function launch() {
    const current = start();
    child = current;
    const gone = () => { if (child === current) broken('exited'); };
    current.on('error', gone); current.on('exit', gone);
    current.stdin.on('error', gone);
    current.stdout.setEncoding('latin1');
    current.stdout.on('data', chunk => {
      if (child !== current) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return broken('returned too much output');
      for (let end; child === current && (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        receive(line);
      }
    });
    // The pending request's timer keeps Node alive; an idle host never does.
    // The host exits by itself when this process ends and its input closes.
    for (const handle of [current, current.stdin, current.stdout]) handle?.unref?.();
  }
  function send() {
    return new Promise((resolve, reject) => {
      clearTimeout(idle); idle = null;
      if (!child) { try { launch(); } catch (error) { failures = maxFailures; child = null; throw error; } }
      const id = crypto.randomBytes(16).toString('hex');
      pending = { id, resolve, reject, timer: setTimeout(() => broken('timed out'), timeoutMs) };
      child.stdin.write(`${id}\n`);
    }).finally(() => {
      if (child && !idle) { idle = setTimeout(stop, idleMs); idle.unref?.(); }
    });
  }
  return {
    get usable() { return failures < maxFailures; },
    query() { const result = queue.then(send, send); queue = result.catch(() => {}); return result; },
    dispose: stop
  };
}

let sharedHost = null;
async function hostedProcesses(host, oneShot = systemProcesses) {
  if (!host) {
    if (!sharedHost) { sharedHost = createProcessHost(); process.once('exit', () => sharedHost.dispose()); }
    host = sharedHost;
  }
  if (host.usable) { try { return await host.query(); } catch {} }
  return oneShot();
}

function createInstallGuards(options = {}) {
  const processId = numericPid(options.processId === undefined ? process.pid : options.processId);
  const executablePath = normalizedExecutable(options.executablePath === undefined ? process.execPath : options.executablePath);
  const portableExecutablePath = normalizedExecutable(options.portableExecutablePath === undefined
    ? process.env.PORTABLE_EXECUTABLE_FILE
    : options.portableExecutablePath);
  const queryProcesses = options.queryProcesses || (() => hostedProcesses());

  function ownedProcessIds(rows, gameExePath) {
    const gamePath = normalizedExecutable(gameExePath);
    const owned = new Set();
    if (processId !== null && executablePath !== gamePath) owned.add(processId);

    // Electron renderer/GPU/utility processes use the same executable as the
    // main process. Require both exact path identity and a descendant relation;
    // a game launched by the Manager remains guarded because its path differs.
    let changed = true;
    while (changed && executablePath && executablePath !== gamePath) {
      changed = false;
      for (const row of rows) {
        const pid = numericPid(row && row.ProcessId);
        const parentPid = numericPid(row && row.ParentProcessId);
        if (pid !== null && parentPid !== null && !owned.has(pid) && owned.has(parentPid) &&
            normalizedExecutable(row.ExecutablePath) === executablePath) {
          owned.add(pid);
          changed = true;
        }
      }
    }

    // electron-builder's portable launcher stays alive in ExecWait while the
    // extracted app runs. Trust its environment path only when the process
    // snapshot also proves that exact executable is our direct parent. If UAC
    // or a stale snapshot breaks that relation, retain the conservative block.
    if (processId !== null && portableExecutablePath && portableExecutablePath !== gamePath) {
      const current = rows.find(row => numericPid(row && row.ProcessId) === processId);
      const parentPid = numericPid(current && current.ParentProcessId);
      const parent = rows.find(row => numericPid(row && row.ProcessId) === parentPid);
      if (parentPid !== null && parent && normalizedExecutable(parent.ExecutablePath) === portableExecutablePath) {
        owned.add(parentPid);
      }
    }
    return owned;
  }

  function matchingProcesses(processes, gameDir, gameExePath) {
    const rows = processRows(processes);
    const owned = ownedProcessIds(rows, gameExePath);
    const candidates = rows.filter(row => !owned.has(numericPid(row && row.ProcessId)));
    const matches = upstream.matchingProcesses(candidates, gameDir, gameExePath)
      .filter(row => !independentEngineReporter(row, gameDir, gameExePath));

    // Upstream always excludes process.pid. If the selected game executable is
    // the Manager itself, restore that row so an identity collision fails shut.
    const gamePath = normalizedExecutable(gameExePath);
    if (gamePath && gamePath === executablePath) {
      const current = rows.find(row => numericPid(row && row.ProcessId) === processId &&
        normalizedExecutable(row && row.ExecutablePath) === gamePath);
      if (current && !matches.includes(current)) matches.push(current);
    }
    return matches;
  }

  async function assertGameClosed(gameDir, gameExePath) {
    let rows;
    try {
      rows = processRows(await queryProcesses());
    } catch (cause) {
      throw Object.assign(new Error('errProcessCheck'), { code: 'errProcessCheck', cause });
    }
    const matches = matchingProcesses(rows, gameDir, gameExePath);
    if (matches.length) {
      const processes = matches.map(row => {
        const executable = normalizedExecutable(row && row.ExecutablePath);
        const game = normalizedExecutable(gameExePath);
        const relativePath = executable ? path.relative(path.resolve(gameDir).toLowerCase(), executable) : null;
        return {
          pid: numericPid(row && row.ProcessId),
          name: typeof (row && row.Name) === 'string' && row.Name ? row.Name : 'unknown',
          relativePath,
          reason: !executable ? '同名进程路径无法读取' : executable === game ? '所选游戏进程仍在运行'
            : game && path.dirname(executable) === path.dirname(game) ? '游戏部署目录内的进程仍在运行' : '游戏目录内的进程仍在运行'
        };
      });
      throw Object.assign(new Error(`Close the game and helper first: ${processes.map(row => row.name).join(', ')}`), {
        code: 'errGameRunning',
        details: { processes }
      });
    }
  }

  return { ...upstream, matchingProcesses, assertGameClosed };
}

module.exports = { ...createInstallGuards(), createInstallGuards, createProcessHost, spawnProcessHost, hostedProcesses, systemProcesses };
