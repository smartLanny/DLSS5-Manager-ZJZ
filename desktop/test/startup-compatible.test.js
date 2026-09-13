'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/startup-compatible.ps1');
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => `'${String(value).replace(/'/g, "''")}'`;

function run(body) {
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-compatible-log-'));
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); . ${quote(script)} -LogDirectory ${quote(logs)}; ${body}`;
  let result;
  try { result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 15000, windowsHide: true }); }
  finally { fs.rmSync(logs, { recursive: true, force: true }); }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-compat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "中文 [1] & O'Brien"); fs.mkdirSync(dir);
  const exe = path.join(dir, 'DLSS5-Manager-test-portable.exe'); fs.writeFileSync(exe, 'fixture, never executed');
  return { root, dir, exe };
}

test('helper keeps Chinese text readable in system PowerShell and ships beside both package variants', () => {
  assert.deepEqual(fs.readFileSync(script).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  const build = require('../package.json').build;
  assert.ok(build.extraFiles.some(row => row.from === 'scripts/startup-compatible.cmd' && row.to === '兼容启动.cmd'));
  assert.ok(build.extraFiles.some(row => row.from === 'scripts/startup-compatible.ps1' && row.to === 'startup-compatible.ps1'));
  assert.equal(build.win.requestedExecutionLevel, 'asInvoker');
});

test('target resolution preserves the dragged EXE and literal path, refuses ambiguous directories and Setup', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), second = path.join(f.dir, 'DLSS5-Manager-next-portable.exe');
  assert.equal(run(`Resolve-CompatibleTarget -Requested ${quote(f.exe)}`), f.exe);
  assert.equal(run(`Resolve-CompatibleTarget -Directory ${quote(f.dir)}`), f.exe);
  fs.writeFileSync(second, 'not executed');
  assert.match(run(`try { Resolve-CompatibleTarget -Directory ${quote(f.dir)}; throw 'unexpected selection' } catch { $_.Exception.Message }`), /没有找到唯一/);
  const setup = path.join(f.dir, 'DLSS5-Manager-Setup-test.exe'); fs.writeFileSync(setup, 'not executed');
  assert.match(run(`try { Resolve-CompatibleTarget -Requested ${quote(setup)} } catch { $_.Exception.Message }`), /不能选择 Setup/);
  assert.match(run(`try { Get-CompatibleTargetInfo -File ${quote(f.exe)} } catch { $_.Exception.Message }`), /产品信息不是/);
});

test('compatibility launch requires opt-in, cancels without launch, and sends only one transient switch to the selected file', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  // Replace only OS/process seams. Resolution, confirmation, arguments and
  // working-directory selection execute the production helper functions.
  const mocks = `
    function Get-CompatibleTargetInfo { param([string]$File) [pscustomobject]@{ File=[IO.Path]::GetFileName($File); Version='fixture' } }
    $script:launches=New-Object Collections.Generic.List[object]
    function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
      $script:launches.Add(@{file=$FilePath;args=$ArgumentList;cwd=$WorkingDirectory;window=$WindowStyle}); [pscustomobject]@{Id=1234} }
    function Read-Host { param($Prompt) 'n' }
  `;
  const output = run(`${mocks}
    $cancel=Invoke-CompatibleStartup -Requested ${quote(f.exe)}
    if($cancel -ne 2 -or $script:launches.Count -ne 0){throw 'cancel launched a process'}
    $issued=Invoke-CompatibleStartup -Requested ${quote(f.exe)} -Accepted
    if($issued -ne 0 -or $script:launches.Count -ne 1){throw 'expected exactly one launch'}
    $script:launches[0] | ConvertTo-Json -Compress
  `);
  const row = JSON.parse(output.split(/\r?\n/).at(-1));
  assert.deepEqual(row, { cwd: f.dir, args: '--no-sandbox', file: f.exe, window: 'Normal' });
  assert.match(output, /不代表界面已经加载成功/);
  assert.deepEqual(fs.readdirSync(f.dir), [path.basename(f.exe)], 'no executable, shortcut or config is rewritten');
});

test('OS launch errors propagate without a retry or persistent fallback', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const output = run(`
    function Get-CompatibleTargetInfo { param($File) [pscustomobject]@{File='fixture';Version='fixture'} }
    $script:count=0
    function Start-Process { $script:count++; throw 'fixture UAC declined' }
    try { Invoke-CompatibleStartup -Requested ${quote(f.exe)} -Accepted; throw 'unexpected success' }
    catch { if($_.Exception.Message -ne 'fixture UAC declined'){throw}; if($script:count -ne 1){throw 'retried'}; 'declined-once' }
  `);
  assert.match(output, /declined-once/);
});

test('independent helper logs consent, cancellation and launch failure without recording target paths or claiming renderer readiness', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const output = run(`
    function Get-CompatibleTargetInfo { param($File) [pscustomobject]@{File='fixture';Product='fixture';Version='fixture'} }
    function Read-Host { param($Prompt) 'n' }
    $null=Invoke-CompatibleStartup -Requested ${quote(f.exe)}
    function Start-Process { throw ('fixture failure at ' + ${quote(f.exe)}) }
    try { Invoke-CompatibleStartup -Requested ${quote(f.exe)} -Accepted } catch { }
    $events=@(Get-ChildItem -LiteralPath $LogDirectory -File | ForEach-Object { Get-Content -LiteralPath $_.FullName -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json } })
    $events | ConvertTo-Json -Compress
  `);
  const events = JSON.parse(output.split(/\r?\n/).at(-1));
  assert.ok(events.some(row => row.stage === 'compatibility-launch-cancelled'));
  assert.ok(events.some(row => row.stage === 'compatibility-consent' && row.noSandbox === true && row.persistent === false));
  assert.ok(events.some(row => row.stage === 'compatibility-launch-failed'));
  assert.doesNotMatch(JSON.stringify(events), /O'Brien|manager-compat-|中文/);
  assert.equal(events.some(row => row.rendererReady === true), false);
});
