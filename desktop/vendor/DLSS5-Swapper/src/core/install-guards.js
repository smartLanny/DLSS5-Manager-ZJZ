'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
}
function matchingProcesses(processes, gameDir, exePath) {
  const root = path.resolve(gameDir).toLowerCase() + path.sep;
  return processes.filter(p => {
    if (p.ProcessId === process.pid) return false;
    if (p.ExecutablePath) return path.resolve(p.ExecutablePath).toLowerCase().startsWith(root);
    // Protected processes may omit their path. Fail conservatively for a
    // matching executable/helper name, but not unrelated system processes.
    return [exePath ? path.basename(exePath).toLowerCase() : null, 'dlss5-feed-host64.exe'].includes(String(p.Name).toLowerCase());
  });
}
async function assertGameClosed(gameDir, exePath, runner = run) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  let data;
  try {
    const output = await runner(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress"]);
    data = JSON.parse(output || '[]');
  } catch (cause) { throw Object.assign(new Error('errProcessCheck'), { code: 'errProcessCheck', cause }); }
  const matches = matchingProcesses(Array.isArray(data) ? data : [data], gameDir, exePath);
  if (matches.length) throw Object.assign(new Error(`Close the game and helper first: ${matches.map(p => p.Name).join(', ')}`), { code: 'errGameRunning' });
}
function gpuSupported(rows) {
  return rows.some(row => /\bRTX\s*50\d{2}\b/i.test(row.name) &&
    Number(String(row.driver).split('.')[0]) * 100 + Number(String(row.driver).split('.')[1]) >= 61656);
}
async function gpuInfo(runner = run) {
  try {
    const output = await runner('nvidia-smi.exe', ['--query-gpu=name,driver_version', '--format=csv,noheader']);
    return output.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [name, driver] = line.split(',').map(s => s.trim());
      return { name, driver };
    });
  } catch { return null; }
}
function antiCheatPresent(gameDir) {
  const queue = [[gameDir, 0]];
  let examined = 0;
  while (queue.length && examined < 2000) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (examined >= 2000) break;
      examined++;
      if (/easyanticheat|battleye|(?:^|[-_])(?:eac|be)launcher|eaanticheat/i.test(entry.name)) return true;
      if (entry.isDirectory() && depth < 2 && !/^_DLSS5_Backup$|^node_modules$/i.test(entry.name)) queue.push([path.join(dir, entry.name), depth + 1]);
    }
  }
  return false;
}
module.exports = { assertGameClosed, matchingProcesses, gpuInfo, gpuSupported, antiCheatPresent };
