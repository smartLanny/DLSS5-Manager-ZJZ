'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const packageJson = require('../package.json');
const { DX11_COMPAT_LABEL, DX11_COMPAT_CARRIER } = require('../src/product/constants');
const { buildConfig } = require('../scripts/build-manager.cjs');
const { resourceCopies, LEGACY_FG_RESOURCE_FILES } = require('../scripts/static-resources.cjs');

test('Windows GUI and portable launch normally without requiring elevation', () => {
  assert.equal(packageJson.build.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(packageJson.build.portable.requestExecutionLevel, 'user');
});

test('base and offline dynamic configs include only the five legacy FG metadata files', () => {
  const appRoot = path.resolve(__dirname, '..');
  const expected = resourceCopies({ root: appRoot, rows: LEGACY_FG_RESOURCE_FILES });
  for (const flavor of ['base', 'offline']) {
    const config = buildConfig({ stageRoot: path.join(os.tmpdir(), 'manager-stage-' + flavor), flavor,
      outputRoot: path.join(os.tmpdir(), 'manager-output-' + flavor), portableOnly: false });
    const rows = config.extraResources.filter(row => expected.some(item => item.to === row.to));
    assert.deepEqual(rows, expected, flavor + ' legacy resource rows');
    assert.equal(rows.some(row => /\.(?:dll|exe|asi|addon(?:32|64)?)$/i.test(String(row.from) + '/' + row.to)), false);
    assert.deepEqual(config.extraResources.find(row => row.to === 'legacy-runtime'),
      { from: path.join(os.tmpdir(), 'manager-stage-' + flavor, 'resources', 'legacy-runtime'), to: 'legacy-runtime' },
      'HoYo and old-API fixed pool must survive the dynamic package allow-list');
  }
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
