'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGameLaunchBroker, executionLevel } = require('../src/product/game-launch-broker');

const scriptPath = path.resolve(__dirname, '../src/product/game-launch-broker.ps1');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-launch-broker-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exe = path.join(root, '游戏 app.exe'); fs.writeFileSync(exe, 'fixture');
  return { root, exe };
}
function response(extra = {}) {
  return { version: 1, ok: true, result: { launchable: true, elevated: false, userSid: 'S-1-5-21-1000', sessionId: 3, shellPid: 44, ...extra } };
}
function fake(t, runner, extra = {}) {
  const f = fixture(t);
  return { ...f, broker: createGameLaunchBroker({ platform: 'win32', scriptPath, powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    peBitness: () => 64, executionLevel: () => 'asInvoker', runner, ...extra }) };
}

function manifestPe(level, encoding = 'utf8') {
  const xml = `<?xml version="1.0"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="${level}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`;
  const manifest = Buffer.from(xml, encoding), buffer = Buffer.alloc(0x1000), peOffset = 0x80, optionalSize = 0xf0, optional = peOffset + 24, section = optional + optionalSize;
  buffer.writeUInt16LE(0x5a4d, 0); buffer.writeUInt32LE(peOffset, 0x3c); buffer.writeUInt32LE(0x4550, peOffset);
  buffer.writeUInt16LE(0x8664, peOffset + 4); buffer.writeUInt16LE(1, peOffset + 6); buffer.writeUInt16LE(optionalSize, peOffset + 20); buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(0x1000, optional + 112 + 16); buffer.writeUInt32LE(0xc00, optional + 112 + 20);
  buffer.write('.rsrc\0', section); buffer.writeUInt32LE(0xc00, section + 8); buffer.writeUInt32LE(0x1000, section + 12); buffer.writeUInt32LE(0xc00, section + 16); buffer.writeUInt32LE(0x200, section + 20);
  for (const [offset, id, target] of [[0, 24, 0x80000020], [0x20, 1, 0x80000040], [0x40, 1033, 0x60]]) {
    buffer.writeUInt16LE(1, 0x200 + offset + 14); buffer.writeUInt32LE(id, 0x200 + offset + 16); buffer.writeUInt32LE(target, 0x200 + offset + 20);
  }
  buffer.writeUInt32LE(0x1100, 0x260); buffer.writeUInt32LE(manifest.length, 0x264); manifest.copy(buffer, 0x300);
  return buffer;
}

test('PE resource inspection rejects an actual requireAdministrator manifest and ignores overlay text', t => {
  const f = fixture(t);
  fs.writeFileSync(f.exe, manifestPe('requireAdministrator'));
  assert.equal(executionLevel(f.exe), 'requireAdministrator');
  fs.writeFileSync(f.exe, Buffer.concat([manifestPe('asInvoker', 'utf16le'), Buffer.from('<requestedExecutionLevel level="requireAdministrator"/>')]));
  assert.equal(executionLevel(f.exe), 'asInvoker');
});

test('inspect proves a non-elevated shell identity through structured JSON stdin', async t => {
  let invocation;
  const f = fake(t, async (file, args, options) => {
    invocation = { file, args, request: JSON.parse(options.input), options };
    return { code: 0, stdout: JSON.stringify(response()), stderr: '' };
  });
  const result = await f.broker.inspect({ exe: f.exe });
  assert.equal(result.elevated, false); assert.equal(result.bitness, 64); assert.equal(result.executionLevel, 'asInvoker');
  assert.deepEqual(invocation.request, { version: 1, op: 'inspect', exe: path.resolve(f.exe) });
  assert.equal(invocation.args.at(-1), scriptPath); assert.equal(invocation.args.join(' ').includes(f.exe), false);
  assert.equal(invocation.options.maxOutputBytes, 64 * 1024);
});

test('cancellation during ordinary-token inspection prevents the later launch request', async t => {
  let cancelled = false; const operations = [];
  const f = fake(t, async (_file, _args, options) => {
    operations.push(JSON.parse(options.input).op); cancelled = true;
    return { code: 0, stdout: JSON.stringify(response()), stderr: '' };
  });
  await assert.rejects(f.broker.launch({ exe: f.exe }, { cancelled: () => cancelled }), { code: 'LAUNCH_CANCELLED' });
  assert.deepEqual(operations, ['inspect']);
});

test('launch passes only approved Vulkan environment and verifies the second token result', async t => {
  const requests = [];
  const f = fake(t, async (_file, _args, options) => {
    const request = JSON.parse(options.input); requests.push(request);
    return { code: 0, stdout: JSON.stringify(request.op === 'inspect' ? response() : response({ pid: 9876 })), stderr: '' };
  });
  const result = await f.broker.launch({ exe: f.exe, args: ['--name', 'value with space', 'quote"tail\\'], cwd: f.root,
    env: { VK_LAYER_PATH: 'C:\\Layer Path', VK_INSTANCE_LAYERS: 'VK_LAYER_XIAOFENG', RESHADE_BASE_PATH_OVERRIDE: 'C:\\ReShade' } });
  assert.deepEqual(result, { pid: 9876, elevated: false, userSid: 'S-1-5-21-1000', sessionId: 3 });
  assert.equal(requests.length, 2); assert.equal(requests[1].op, 'launch');
  assert.deepEqual(requests[1].expected, { userSid: 'S-1-5-21-1000', sessionId: 3, shellPid: 44 });
  assert.deepEqual(requests[1].args, ['--name', 'value with space', 'quote"tail\\']);
  assert.deepEqual(requests[1].env, { VK_LAYER_PATH: 'C:\\Layer Path', VK_INSTANCE_LAYERS: 'VK_LAYER_XIAOFENG', RESHADE_BASE_PATH_OVERRIDE: 'C:\\ReShade' });
  await assert.rejects(f.broker.launch({ exe: f.exe, env: { PATH: 'C:\\attacker' } }), { code: 'GAME_LAUNCH_ENV_INVALID' });
  await assert.rejects(f.broker.launch({ exe: f.exe, env: { VK_DRIVER_FILES: 'C:\\fake.json' } }), { code: 'GAME_LAUNCH_ENV_INVALID' });
});

test('elevation manifests and token mismatches fail before reporting launch success', async t => {
  let calls = 0;
  const elevated = fake(t, async () => { calls++; return { code: 0, stdout: JSON.stringify(response()), stderr: '' }; }, { executionLevel: () => 'requireAdministrator' });
  await assert.rejects(elevated.broker.inspect({ exe: elevated.exe }), { code: 'GAME_LAUNCH_REQUIRES_ELEVATION' }); assert.equal(calls, 0);

  const mismatch = fake(t, async (_file, _args, options) => {
    const request = JSON.parse(options.input);
    return { code: 0, stdout: JSON.stringify(request.op === 'inspect' ? response() : response({ pid: 77, userSid: 'S-1-5-21-2000' })), stderr: '' };
  });
  await assert.rejects(mismatch.broker.launch({ exe: mismatch.exe }), { code: 'GAME_LAUNCH_TOKEN_MISMATCH' });
});

test('bad targets, helper failures and unproved shell tokens remain distinct', async t => {
  const f = fake(t, async () => ({ timedOut: true, code: 1, stdout: '', stderr: '' }));
  await assert.rejects(f.broker.inspect({ exe: f.exe }), { code: 'GAME_LAUNCH_HELPER_TIMEOUT' });
  await assert.rejects(f.broker.inspect({ exe: '\\\\server\\share\\game.exe' }), { code: 'GAME_LAUNCH_REQUEST_INVALID' });
  const invalid = fake(t, async () => ({ code: 0, stdout: JSON.stringify({ version: 1, ok: true, result: { launchable: true, elevated: true } }), stderr: '' }));
  await assert.rejects(invalid.broker.inspect({ exe: invalid.exe }), { code: 'GAME_LAUNCH_TOKEN_MISMATCH' });
});

test('native helper uses a suspended process and verifies its token before resuming', () => {
  const source = fs.readFileSync(scriptPath, 'utf8');
  for (const api of ['GetShellWindow', 'GetWindowThreadProcessId', 'OpenProcessToken', 'DuplicateTokenEx', 'CreateEnvironmentBlock', 'CreateProcessWithTokenW', 'CreateProcessW', 'ResumeThread', 'TerminateProcess']) assert.match(source, new RegExp(api));
  assert.match(source, /CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT/);
  assert.match(source, /CreateProcessWithTokenW\(shell\.PrimaryToken[^]*?exe,[^]*?new StringBuilder\(command\)/);
  const created = source.indexOf('CreateProcessWithTokenW(shell.PrimaryToken');
  const verified = source.indexOf('OpenProcessToken(process.hProcess', created);
  const resumed = source.indexOf('ResumeThread(process.hThread)', verified);
  assert.ok(created >= 0 && verified > created && resumed > verified, 'child token verification precedes ResumeThread');
  const ordinaryCreated = source.indexOf('CreateProcessW(exe, new StringBuilder(command)');
  assert.ok(ordinaryCreated > created && ordinaryCreated < verified, 'ordinary path performs the same suspended-child verification');
  assert.match(source, /shell\.BrokerElevated\s*\? CreateProcessWithTokenW/);
  assert.doesNotMatch(source, /GAME_LAUNCH_BROKER_NOT_ELEVATED/);
  assert.match(source, /created && !resumed[^]*?TerminateProcess/);
  assert.doesNotMatch(source, /runas|Start-Process|taskkill|TerminateProcess\(shell/iu);
});

function findPowerShell() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(system)) return system;
  try { return execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean); } catch { return null; }
}

test('native STARTUPINFOW marshals the desktop name as UTF-16', t => {
  if (process.platform !== 'win32') return t.skip('Windows native marshaling');
  const powershell = findPowerShell(); if (!powershell) return t.skip('PowerShell unavailable');
  const file = path.join(os.tmpdir(), `xiaofeng-startupinfo-${process.pid}.ps1`);
  const script = `
$text = Get-Content -LiteralPath '${scriptPath.replace(/'/g, "''")}' -Raw
$code = $text.Substring($text.IndexOf("@'") + 2)
$code = $code.Substring(0, $code.IndexOf("'@"))
Add-Type -TypeDefinition $code -Language CSharp
$type = [XiaofengGameLaunchBroker].GetNestedType('STARTUPINFO', [Reflection.BindingFlags]::NonPublic)
$startup = [Activator]::CreateInstance($type)
$type.GetField('lpDesktop').SetValue($startup, 'winsta0\\default')
$buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal([Runtime.InteropServices.Marshal]::SizeOf($startup))
try {
  [Runtime.InteropServices.Marshal]::StructureToPtr($startup, $buffer, $false)
  $offset = [Runtime.InteropServices.Marshal]::OffsetOf($type, 'lpDesktop').ToInt32()
  $pointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($buffer, $offset)
  if ([Runtime.InteropServices.Marshal]::PtrToStringUni($pointer) -cne 'winsta0\\default') { throw 'STARTUPINFOW desktop was marshaled using the wrong character encoding' }
  'UTF16_DESKTOP_OK'
} finally { [Runtime.InteropServices.Marshal]::DestroyStructure($buffer, $type); [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
`;
  fs.writeFileSync(file, script);
  t.after(() => fs.rmSync(file, { force: true }));
  assert.match(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }), /UTF16_DESKTOP_OK/);
});

test('real helper performs a read-only inspection of the current interactive shell token', async t => {
  if (process.platform !== 'win32') return t.skip('Windows-only token inspection');
  const powershell = findPowerShell(); if (!powershell) return t.skip('PowerShell unavailable');
  const broker = createGameLaunchBroker({ powershell: path.resolve(powershell), scriptPath });
  try {
    const result = await broker.inspect({ exe: process.execPath });
    assert.equal(result.elevated, false); assert.equal(result.launchable, true); assert.match(result.userSid, /^S-1-/); assert.ok(result.sessionId >= 0); assert.ok(result.shellPid > 0);
    assert.ok(['current-token', 'shell-token'].includes(result.launchMethod));
  } catch (error) {
    assert.ok(['GAME_LAUNCH_SHELL_MISSING', 'GAME_LAUNCH_SHELL_TOKEN', 'GAME_LAUNCH_SESSION_MISMATCH', 'GAME_LAUNCH_SHELL_ELEVATED'].includes(error.code), `unexpected inspection error: ${error.code} ${error.message}`);
    t.skip(`interactive token unavailable: ${error.code}`);
  }
});

test('real ordinary helper launches a CPU-only fixture with verified token, quoted args and a scoped environment', { timeout: 30000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Windows-only process creation');
  const powershell = findPowerShell(); if (!powershell) return t.skip('PowerShell unavailable');
  const broker = createGameLaunchBroker({ powershell: path.resolve(powershell), scriptPath, timeoutMs: 15000 });
  try { await broker.inspect({ exe: process.execPath }); }
  catch (error) {
    if (['GAME_LAUNCH_SHELL_MISSING', 'GAME_LAUNCH_SHELL_TOKEN', 'GAME_LAUNCH_SESSION_MISMATCH', 'GAME_LAUNCH_SHELL_ELEVATED'].includes(error.code)) return t.skip(`interactive token unavailable: ${error.code}`);
    throw error;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-broker-cpu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const relay = path.join(root, 'ordinary relay.cjs'), payload = path.join(root, 'cpu child.cjs');
  const report = path.join(root, 'relay.json'), output = path.join(root, 'child.json');
  const args = ['value with space', 'quote"tail\\', '中文 [fixture]'];
  fs.writeFileSync(payload, `const fs=require('node:fs'); fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,args:process.argv.slice(3),cwd:process.cwd(),layer:process.env.VK_LAYER_PATH,unexpected:process.env.XIAOFENG_BROKER_FIXTURE_SECRET||null}));`);
  fs.writeFileSync(relay, `
const fs=require('node:fs');
const {createGameLaunchBroker}=require(${JSON.stringify(require.resolve('../src/product/game-launch-broker'))});
(async()=>{
  const broker=createGameLaunchBroker({powershell:${JSON.stringify(path.resolve(powershell))},scriptPath:${JSON.stringify(scriptPath)},timeoutMs:15000});
  const inspection=await broker.inspect({exe:process.execPath});
  if(inspection.launchMethod!=='current-token') throw new Error('ordinary relay is not using the ordinary process path');
  process.env.XIAOFENG_BROKER_FIXTURE_SECRET='parent-only';
  const result=await broker.launch({exe:process.execPath,args:${JSON.stringify([payload, output, ...args])},cwd:${JSON.stringify(root)},env:{VK_LAYER_PATH:${JSON.stringify(root)}}});
  fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({ok:true,method:inspection.launchMethod,elevated:result.elevated,pid:result.pid}));
})().catch(error=>{fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({ok:false,code:error.code,message:error.message}));process.exitCode=1;});
`);
  // Even when the test host is elevated, this first hop creates the ordinary
  // relay. Its second hop must exercise CreateProcessW, never a game or GPU load.
  await broker.launch({ exe: process.execPath, args: [relay], cwd: root });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (!fs.existsSync(report) || !fs.existsSync(output))) {
    if (fs.existsSync(report) && JSON.parse(fs.readFileSync(report, 'utf8')).ok === false) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(report), true, 'ordinary helper returned a fixture report');
  const result = JSON.parse(fs.readFileSync(report, 'utf8')); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.method, 'current-token'); assert.equal(result.elevated, false);
  assert.equal(fs.existsSync(output), true, 'verified child executed the CPU fixture');
  const child = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(child.pid, result.pid); assert.deepEqual(child.args, args); assert.equal(child.cwd, root); assert.equal(child.layer, root); assert.equal(child.unexpected, null);
});
