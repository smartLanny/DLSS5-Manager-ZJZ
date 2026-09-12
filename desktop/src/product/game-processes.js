'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Restrict process discovery to the selected executable's basename, then bind
// every result to the full image path and creation time. A launcher is not the game.
function createGameProcesses(options = {}) {
  const execute = options.execute || run;
  const powershell = options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const powershell32 = options.powershell32 || options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
  const getBitness = options.getBitness || require('../core/pe').getBitness;
  async function query(exe, modules = false) {
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || !/\.exe$/i.test(exe) || exe.includes('\0')) throw new Error('需要已绑定的游戏 EXE。');
    const encoded = Buffer.from(path.basename(exe), 'utf8').toString('base64');
    const source = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $n=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $rows=@(Get-CimInstance Win32_Process -Filter (\"Name='\"+$n.Replace(\"'\",\"''\")+\"'\") | ForEach-Object { $p=$_; $mods=@(); ${modules ? 'try { $mods=@((Get-Process -Id $p.ProcessId -ErrorAction Stop).Modules | ForEach-Object { $_.FileName }) } catch {};' : ''} [pscustomobject]@{ pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; exe=$p.ExecutablePath; startedAt=$p.CreationDate.ToUniversalTime().ToString('o'); modules=$mods } }); ConvertTo-Json -InputObject $rows -Compress -Depth 4`;
    // Windows PowerShell 5's 64-bit Process.Modules returns only the WOW64
    // layer for a 32-bit target. Query modules with the matching system host.
    const shell = modules && getBitness(exe) === 32 ? powershell32 : powershell;
    const { stdout } = await execute(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 6000, maxBuffer: 256 * 1024, encoding: 'utf8' });
    const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(row => row && Number.isInteger(row.pid) && row.pid > 0 && same(row.exe, exe) && Number.isFinite(Date.parse(row.startedAt)))
      .map(row => ({ pid: row.pid, ...(Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 ? { parentPid: row.parentPid } : {}), exe: path.resolve(row.exe), startedAt: row.startedAt, modules: Array.isArray(row.modules) ? row.modules.filter(file => typeof file === 'string' && path.isAbsolute(file)).slice(0, 1024) : [] }));
  }
  async function observe(target) {
    const rows = await query(target.exe, true);
    return rows.find(row => row.pid === target.pid && row.startedAt === target.startedAt) || null;
  }
  return { find: exe => query(exe), observe };
}
module.exports = { createGameProcesses, same };
