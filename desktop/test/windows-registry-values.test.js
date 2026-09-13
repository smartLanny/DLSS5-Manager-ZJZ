'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createWindowsRegistryValues } = require('../src/product/windows-registry-values');

const scriptPath = path.resolve(__dirname, '../src/product/windows-registry-values.ps1');
function fake(options = {}) {
  return createWindowsRegistryValues({ platform: 'win32', key: 'Software\\XiaofengManagerTests\\fake', scriptPath,
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ...options });
}

test('requests carry key and value only in structured stdin and packaged script path wins', async t => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-registry-script-')); t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const packagedScript = path.join(resources, 'windows-registry-values.ps1'); fs.copyFileSync(scriptPath, packagedScript);
  let request, argsSeen;
  const adapter = createWindowsRegistryValues({ platform: 'win32', key: 'Software\\XiaofengManagerTests\\structured', resourcesPath: resources,
    powershell: 'C:\\fake\\pwsh.exe', runner: async (_file, args, options) => {
      argsSeen = args; request = JSON.parse(options.input); return { code: 0, stdout: JSON.stringify({ version: 1, ok: true, result: { exists: false } }), stderr: '' };
    } });
  assert.deepEqual(await adapter.read('C:\\Synthetic\\ReShade64.json'), { exists: false });
  assert.equal(argsSeen.at(-1), packagedScript); assert.equal(argsSeen.join(' ').includes('XiaofengManagerTests'), false);
  assert.equal(request.key, 'Software\\XiaofengManagerTests\\structured'); assert.equal(request.name, 'C:\\Synthetic\\ReShade64.json');
  const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-registry-missing-')); t.after(() => fs.rmSync(missing, { recursive: true, force: true }));
  assert.throws(() => createWindowsRegistryValues({ platform: 'win32', key: 'Software\\XiaofengManagerTests\\missing', resourcesPath: missing, packaged: true }), { code: 'REGISTRY_HELPER_MISSING' });
});

test('helper timeout, malformed output and access denial remain distinct failures', async () => {
  await assert.rejects(fake({ runner: async () => ({ timedOut: true, stdout: '', stderr: '' }) }).read('value'), { code: 'REGISTRY_HELPER_TIMEOUT' });
  await assert.rejects(fake({ runner: async () => ({ code: 0, stdout: '{bad', stderr: '' }) }).read('value'), { code: 'REGISTRY_HELPER_PROTOCOL' });
  await assert.rejects(fake({ runner: async () => ({ code: 1, stdout: JSON.stringify({ version: 1, ok: false, code: 'REGISTRY_ACCESS_DENIED', error: 'denied' }), stderr: '' }) }).read('value'), { code: 'REGISTRY_ACCESS_DENIED' });
});

test('read refuses unsupported target types while list reports them without conversion', async () => {
  const adapter = fake({ runner: async (_file, _args, options) => {
    const request = JSON.parse(options.input), result = request.op === 'list'
      ? [{ name: 'string-value', exists: true, type: 'REG_STRING' }, { name: 'dword-value', exists: true, type: 'REG_DWORD', data: 0 }]
      : { exists: true, type: 'REG_STRING' };
    return { code: 0, stdout: JSON.stringify({ version: 1, ok: true, result }), stderr: '' };
  } });
  await assert.rejects(adapter.read('string-value'), { code: 'REGISTRY_VALUE_TYPE' });
  assert.deepEqual(await adapter.list(), [
    { name: 'string-value', type: 'REG_STRING', supported: false },
    { name: 'dword-value', exists: true, type: 'REG_DWORD', data: 0, supported: true }
]);
});

test('listMachine performs a read-only fixed HKLM Vulkan layer snapshot', async () => {
  let request;
  const adapter = fake({ runner: async (_file, _args, options) => {
    request = JSON.parse(options.input);
    return { code: 0, stdout: JSON.stringify({ version: 1, ok: true, result: [{ name: 'C:\\ProgramData\\ReShade\\ReShade64.json', exists: true, type: 'REG_DWORD', data: 0 }] }), stderr: '' };
  } });
  assert.deepEqual(await adapter.listMachine(), [{ name: 'C:\\ProgramData\\ReShade\\ReShade64.json', exists: true, type: 'REG_DWORD', data: 0, supported: true }]);
  assert.equal(request.op, 'listMachine'); assert.equal(request.view, '64');
});

test('write validates exact states before invoking the helper', async () => {
  let calls = 0; const adapter = fake({ runner: async () => { calls++; return { code: 0, stdout: '{}', stderr: '' }; } });
  await assert.rejects(adapter.write('value', { exists: true, type: 'REG_SZ', data: '0' }, { exists: false }), { code: 'REGISTRY_VALUE_TYPE' });
  await assert.rejects(adapter.write('value', { exists: false }, { exists: true, type: 'REG_DWORD', data: -1 }), { code: 'REGISTRY_VALUE_TYPE' });
  assert.equal(calls, 0);
});

function findPwsh() {
  if (process.env.DLSS5_TEST_POWERSHELL && path.isAbsolute(process.env.DLSS5_TEST_POWERSHELL) && fs.existsSync(process.env.DLSS5_TEST_POWERSHELL)) return process.env.DLSS5_TEST_POWERSHELL;
  try { return execFileSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).find(Boolean); } catch { return null; }
}
function cleanupKey(powershell, key) {
  const command = "$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);try{$b.DeleteSubKeyTree($env:XIAOFENG_REGISTRY_TEST_KEY,$false);$k=$b.OpenSubKey($env:XIAOFENG_REGISTRY_TEST_KEY,$false);if($null-ne$k){$k.Dispose();throw 'isolated registry test key still exists'}}finally{$b.Dispose()}";
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, env: { ...process.env, XIAOFENG_REGISTRY_TEST_KEY: key } });
}
function putStringValue(powershell, key, name) {
  const command = "$b=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64);try{$k=$b.CreateSubKey($env:XIAOFENG_REGISTRY_TEST_KEY,$true);try{$k.SetValue($env:XIAOFENG_REGISTRY_TEST_VALUE,'external',[Microsoft.Win32.RegistryValueKind]::String);$k.Flush()}finally{$k.Dispose()}}finally{$b.Dispose()}";
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true,
    env: { ...process.env, XIAOFENG_REGISTRY_TEST_KEY: key, XIAOFENG_REGISTRY_TEST_VALUE: name } });
}

test('real adapter round-trips one isolated HKCU x64 DWORD and removes only its exact value', async t => {
  if (process.platform !== 'win32') return t.skip('Windows-only registry test');
  const powershell = findPwsh(); if (!powershell) return t.skip('pwsh.exe is unavailable');
  const key = `Software\\XiaofengManagerTests\\${crypto.randomUUID()}`, name = 'C:\\Synthetic\\ReShade64.json';
  cleanupKey(powershell, key); t.after(() => cleanupKey(powershell, key));
  const adapter = createWindowsRegistryValues({ key, view: '64', powershell: path.resolve(powershell), scriptPath });
  assert.deepEqual(await adapter.read(name), { exists: false }); assert.deepEqual(await adapter.list(), []);
  assert.deepEqual(await adapter.write(name, { exists: false }, { exists: true, type: 'REG_DWORD', data: 0 }), { exists: true, type: 'REG_DWORD', data: 0 });
  assert.deepEqual(await adapter.read(name), { exists: true, type: 'REG_DWORD', data: 0 });
  assert.deepEqual(await adapter.list(), [{ name, exists: true, type: 'REG_DWORD', data: 0, supported: true }]);
  await assert.rejects(adapter.write(name, { exists: false }, { exists: true, type: 'REG_DWORD', data: 1 }), { code: 'REGISTRY_CAS_MISMATCH' });
  assert.deepEqual(await adapter.write(name, { exists: true, type: 'REG_DWORD', data: 0 }, { exists: false }), { exists: false });
  assert.deepEqual(await adapter.read(name), { exists: false });
  putStringValue(powershell, key, name);
  await assert.rejects(adapter.read(name), { code: 'REGISTRY_VALUE_TYPE' });
  await assert.rejects(adapter.write(name, { exists: false }, { exists: true, type: 'REG_DWORD', data: 0 }), { code: 'REGISTRY_VALUE_TYPE' });
  assert.deepEqual(await adapter.list(), [{ name, type: 'REG_STRING', supported: false }]);
});
