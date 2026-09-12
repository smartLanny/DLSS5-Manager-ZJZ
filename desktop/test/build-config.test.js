'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const packageJson = require('../package.json');
const { DX11_COMPAT_LABEL, DX11_COMPAT_CARRIER } = require('../src/product/constants');

test('Windows GUI and portable launch normally without requiring elevation', () => {
  assert.equal(packageJson.build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(packageJson.build.portable.requestExecutionLevel, 'user');
});

test('portable GUI exposes single-operation elevation and refuses whole-app elevation', async () => {
  const service = require('../src/product/startup-elevation').createStartupElevation({
    app: { commandLine: { hasSwitch: () => false } }, processInfo: { platform: 'win32' }, runPowerShell: async () => 'false' });
  const state = await service.context();
  assert.equal(state.privilege, 'standard'); assert.equal(state.canRestartElevated, false); assert.equal(state.canElevateOperation, true);
  await assert.rejects(service.relaunchAsAdministrator(), { code: 'STARTUP_WHOLE_APP_ELEVATION_DISABLED' });
});

test('public DX11 compatibility identity and matched carrier name are exact', () => {
  assert.equal(DX11_COMPAT_LABEL, '0.4.5-DX11-兼容增强');
  assert.equal(DX11_COMPAT_CARRIER, 'dlss5-native-carrier-045-dx11-compat.addon64');
});
