'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createNvapiDrs, parseJsonLine } = require('../src/product/nvapi-drs');

const helper = path.join(__dirname, '..', 'src', 'product', 'nvapi-drs.ps1');
const systemPowerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

test('NvAPI wrapper passes only the requested SR preset to the helper', async () => {
  let captured = null;
  const nvapi = createNvapiDrs({
    scriptPath: helper,
    platform: 'win32',
    exists: () => true,
    runner: async (_script, args) => {
      captured = args;
      return { stdout: '{"ok":true,"rawPreset":13,"profile":"Game"}\n', stderr: '', error: null };
    }
  });
  const result = await nvapi.applySrPreset({ exePath: 'C:\\Games\\Test\\game.exe', preset: 'm', friendlyName: 'Test' });
  assert.equal(result.ok, true);
  assert.equal(result.preset, 'm');
  assert.deepEqual(captured.slice(captured.indexOf('-Preset'), captured.indexOf('-Preset') + 2), ['-Preset', 'M']);
});

test('PowerShell helper contains SR-only Driver Settings ids', () => {
  const source = fs.readFileSync(helper, 'utf8');
  assert.match(source, /0x10E41E01/);
  assert.match(source, /0x10E41DF3/);
  assert.doesNotMatch(source, /0x10E41E02|0x10E41E03|0x10E41DF7|0x10E41DF1/);
});

test('PowerShell helper C# layout self-test compiles on Windows', { skip: process.platform !== 'win32' }, () => {
  const output = execFileSync(systemPowerShell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helper, '-Action', 'selftest'
  ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const parsed = parseJsonLine(output);
  assert.equal(parsed.ok, true);
  assert.match(parsed.layout, /NVDRS_SETTING=12320/);
  assert.match(parsed.layout, /NVDRS_APPLICATION_V4=20492/);
});

test('legacy wrapper preserves absent null values and native read failures without inventing defaults', async () => {
  const absent = { explicit: false, value: null, kind: 'absent', location: null, predefined: null };
  const result = { ok: true, profileFound: true, profile: 'Existing predefined game', enable: absent, preset: absent };
  const nvapi = createNvapiDrs({ scriptPath: helper, platform: 'win32', runner: async () => ({ stdout: JSON.stringify(result) }) });
  assert.deepEqual(await nvapi.readSrState({ exePath: 'C:\\Games\\game.exe' }), result);
  result.ok = false; result.error = 'NvAPI_DRS_GetSetting 0x10E41E01 failed (-175)';
  const failure = await nvapi.readSrState({ exePath: 'C:\\Games\\game.exe' });
  assert.equal(failure.ok, false); assert.equal(failure.error, result.error);
});

test('legacy runner uses system Windows PowerShell even when PATH has no shell', { skip: process.platform !== 'win32' }, () => {
  const moduleFile = path.join(__dirname, '..', 'src', 'product', 'nvapi-drs.js');
  const code = `const {createNvapiDrs}=require(${JSON.stringify(moduleFile)});createNvapiDrs({scriptPath:${JSON.stringify(helper)}}).selfTest().then(value=>{console.log(JSON.stringify(value));if(!value.ok)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=1;});`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'));
  const output = execFileSync(process.execPath, ['-e', code], { env: { ...env, PATH: '' }, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(JSON.parse(output.trim()).ok, true);
});
