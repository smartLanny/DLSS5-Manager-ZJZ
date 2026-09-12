'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/startup-diagnostics.ps1');
const cmd = path.resolve(__dirname, '../scripts/startup-diagnostics.cmd');
const required = [
  'resources/app.asar', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'ffmpeg.dll', 'd3dcompiler_47.dll',
  'libEGL.dll', 'libGLESv2.dll', 'vulkan-1.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json'
];

function pwsh() {
  if (process.env.DLSS5_TEST_POWERSHELL && path.isAbsolute(process.env.DLSS5_TEST_POWERSHELL) && fs.existsSync(process.env.DLSS5_TEST_POWERSHELL)) return process.env.DLSS5_TEST_POWERSHELL;
  try { return execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean); } catch { return null; }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-startup-diagnostics-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = path.join(root, '安装 目录'), temp = path.join(root, 'temp'), logs = path.join(root, 'startup'), source = path.join(root, '下载 目录');
  for (const dir of [install, temp, logs, source, path.join(install, 'resources'), path.join(install, 'locales')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(install, 'DLSS 5 AI 超分管理器.exe'), Buffer.alloc(1024 * 1024));
  for (const rel of required) { const file = path.join(install, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rel); }
  fs.writeFileSync(path.join(install, 'locales', 'zh-CN.pak'), 'locale'); fs.writeFileSync(path.join(source, 'DLSS5-Manager-Setup-test.exe'), 'setup');
  return { root, install, temp, logs, source, output: path.join(root, '报告.txt') };
}
function run(shell, f, extra = []) {
  return spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoUI', '-InstallPath', f.install,
    '-TempPath', f.temp, '-StartupLogPath', f.logs, '-SourcePath', f.source, '-OutputPath', f.output, ...extra],
  { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
}

test('helper and CMD are bounded and avoid invasive diagnostics', () => {
  const ps = fs.readFileSync(script, 'utf8'), wrapper = fs.readFileSync(cmd, 'utf8');
  for (const forbidden of ['Get-WinEvent', 'Win32_Process', 'CommandLine', 'Stop-Process', 'taskkill', 'Start-Process']) assert.equal(ps.includes(forbidden), false, forbidden);
  assert.match(ps, /Get-Process -Name/); assert.match(ps, /Length -le 65536/); assert.match(ps, /Select-Object -First 4/); assert.match(ps, /New-Object byte\[\] 131072/);
  assert.match(ps, /EventID=1000/); assert.match(ps, /timediff\(@SystemTime\) <= 86400000/);
  assert.match(ps, /\$examined -lt 100 -and \$found -lt 3 -and \$eventWatch\.ElapsedMilliseconds -lt 1500/);
  assert.match(ps, /ReadEvent\(\[TimeSpan\]::FromMilliseconds\(150\)\)/);
  assert.match(ps, /\$data\['AppName'\] -ieq \$ExecutableName/);
  assert.match(wrapper, /%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(wrapper, /-ExecutionPolicy Bypass -File/);
  assert.match(wrapper, /"%~dp0startup-diagnostics\.ps1" %\*/); assert.match(wrapper, /pause/);
});

test('system Windows PowerShell 5.1 executes the BOM helper against a Chinese-path fixture with the CMD policy', t => {
  if (process.platform !== 'win32') return t.skip('Windows-only helper');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assert.ok(fs.existsSync(shell), 'the CMD entry requires system Windows PowerShell');
  const version = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.match(version.trim(), /^5\.1\./, 'must execute Windows PowerShell 5.1, not pwsh or a configured test override');
  assert.deepEqual(fs.readFileSync(script).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'Windows PowerShell 5.1 needs the UTF-8 BOM to read Chinese literals');
  const f = fixture(t), exe = `诊断 中文 ${path.basename(f.root)}.exe`;
  fs.renameSync(path.join(f.install, 'DLSS 5 AI 超分管理器.exe'), path.join(f.install, exe));
  fs.writeFileSync(path.join(f.logs, 'startup-中文.log'), '临时诊断记录：仅测试夹具。\r\n', 'utf8');
  const before = fs.readdirSync(f.install, { recursive: true }).map(String).sort();
  const result = run(shell, f, ['-ExecutableName', exe]);
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = fs.readFileSync(f.output, 'utf8');
  assert.match(report, /^小枫 DLSS 5 Manager 启动诊断/);
  assert.ok(report.includes(`[OK] 主程序 EXE: ${exe}`));
  assert.match(report, /\[OK\] 随包文件 resources\\app\.asar/);
  assert.match(report, /临时诊断记录：仅测试夹具。/);
  assert.match(report, /在限定范围内没有匹配记录；不表示启动成功。/);
  assert.deepEqual(fs.readdirSync(f.install, { recursive: true }).map(String).sort(), before);
  assert.deepEqual(fs.readdirSync(f.temp), [], 'temporary write probes must be removed');
});

test('fixture report validates the Electron layout, bounds logs and redacts paths', t => {
  if (process.platform !== 'win32') return t.skip('Windows-only helper'); const shell = pwsh(); if (!shell) return t.skip('pwsh.exe unavailable');
  const f = fixture(t), privatePath = path.join(process.env.USERPROFILE || 'C:\\Users\\private', 'Games', 'Secret', 'game.exe');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(f.logs, `startup-${i}.log`), (`game=${privatePath}\nline=${'x'.repeat(900)}\n`).repeat(65).slice(0, 65536));
  const result = run(shell, f); assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(fs.existsSync(f.output), true);
  const bytes = fs.readFileSync(f.output), report = bytes.toString('utf8'); assert.ok(bytes.length <= 128 * 1024);
  assert.match(report, /\[OK\] 主程序 EXE/); assert.match(report, /\[OK\] 随包文件 resources\\app\.asar/); assert.match(report, /DLSS5-Manager-Setup-test\.exe/);
  assert.doesNotMatch(report, /Games[\\/]Secret/i); assert.doesNotMatch(report, new RegExp((process.env.USERPROFILE || 'impossible').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.equal((report.match(/tail <= 24 KiB/g) || []).length, 4);
});

test('missing ASAR and an injected non-directory TEMP are reported without modifying the fixture', t => {
  if (process.platform !== 'win32') return t.skip('Windows-only helper'); const shell = pwsh(); if (!shell) return t.skip('pwsh.exe unavailable');
  const f = fixture(t), asar = path.join(f.install, 'resources', 'app.asar'); fs.unlinkSync(asar);
  const tempFile = path.join(f.root, 'not-a-directory.tmp'); fs.writeFileSync(tempFile, 'keep'); f.temp = tempFile;
  const before = fs.readdirSync(f.install, { recursive: true }).map(String).sort(); const result = run(shell, f); assert.equal(result.status, 2, result.stderr || result.stdout);
  const report = fs.readFileSync(f.output, 'utf8'); assert.match(report, /\[FAIL\] 随包文件 resources\\app\.asar/); assert.match(report, /\[FAIL\] TEMP 写入/);
  assert.equal(fs.readFileSync(tempFile, 'utf8'), 'keep'); assert.deepEqual(fs.readdirSync(f.install, { recursive: true }).map(String).sort(), before);
});

test('current installed Manager can be inspected read-only with its actual runtime file set', t => {
  if (process.platform !== 'win32') return t.skip('Windows-only helper'); const shell = pwsh(); if (!shell) return t.skip('pwsh.exe unavailable');
  const installed = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'xiaofeng-dlss5-manager'); if (!fs.existsSync(installed)) return t.skip('current Manager is not installed');
  const f = fixture(t); f.install = installed; const before = fs.readdirSync(installed).sort(); const result = run(shell, f);
  assert.equal(result.status, 0, result.stderr || result.stdout); const report = fs.readFileSync(f.output, 'utf8');
  assert.match(report, /\[OK\] 主程序 EXE/); assert.match(report, /version\.dll 不属于管理器的必需运行文件/);
  assert.deepEqual(fs.readdirSync(installed).sort(), before);
});

test('Electron 44 DXC runtime pair is checked without falsely requiring separate ANGLE DLLs', t => {
  if (process.platform !== 'win32') return t.skip('Windows-only helper'); const shell = pwsh(); if (!shell) return t.skip('pwsh.exe unavailable');
  const f = fixture(t);
  for (const name of ['libEGL.dll', 'libGLESv2.dll']) fs.unlinkSync(path.join(f.install, name));
  for (const name of ['dxcompiler.dll', 'dxil.dll']) fs.writeFileSync(path.join(f.install, name), name);
  assert.equal(run(shell, f).status, 0);
  const report = fs.readFileSync(f.output, 'utf8'); assert.match(report, /\[OK\] 随包文件 dxcompiler\.dll/); assert.doesNotMatch(report, /\[FAIL\].*libEGL/);
  fs.unlinkSync(path.join(f.install, 'dxil.dll')); assert.equal(run(shell, f).status, 2);
  assert.match(fs.readFileSync(f.output, 'utf8'), /\[FAIL\] 随包文件 dxil\.dll/);
});
