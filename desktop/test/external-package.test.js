'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');
const packageJson = require('../package.json');
const { verifyExternalPackage } = require('../scripts/verify-external-package.cjs');

test('external build inherits the normal app while excluding native and Vulkan NR payload resources', () => {
  const before = structuredClone(packageJson.build), config = require('../scripts/external-build-config.cjs');
  assert.deepEqual(packageJson.build, before, 'loading the variant must not mutate the default package config');
  for (const key of ['appId', 'productName', 'files', 'fileAssociations']) assert.deepEqual(config[key], before[key]);
  assert.equal(config.extraResources.some(row => row.from === 'payload'), false);
  assert.equal(config.extraResources.some(row => row.from === 'resources/vulkan-runtime'), false);
  for (const from of ['src/product/nvapi-drs.ps1', 'src/product/nvapi-profile.ps1', 'src/product/windows-registry-values.ps1', 'src/product/launcher-locations.ps1', 'src/product/game-launch-broker.ps1', 'resources/fg-components', 'resources/vulkan-reshade'])
    assert.equal(config.extraResources.some(row => row.from === from), true, `${from} retained`);
  for (const [from, to] of [['scripts/startup-diagnostics.cmd', '启动诊断.cmd'], ['scripts/startup-diagnostics.ps1', 'startup-diagnostics.ps1'],
    ['scripts/startup-compatible.cmd', '兼容启动.cmd'], ['scripts/startup-compatible.ps1', 'startup-compatible.ps1']])
    assert.equal(config.extraFiles.some(row => row.from === from && row.to === to), true, `${to} retained at app root`);
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker'); assert.equal(config.portable.requestExecutionLevel, 'user');
  assert.equal(config.portable.artifactName, 'DLSS5-Manager-${version}-external-portable.exe');
  assert.equal(config.nsis.artifactName, 'DLSS5-Manager-Setup-${version}-external.exe'); assert.equal(config.directories.output, 'dist-external');
});

async function packagedFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-external-package-')), app = path.join(root, 'app'), resources = path.join(root, 'win-unpacked', 'resources');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(app, { recursive: true }); fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'xiaofeng-dlss5-manager', main: 'main.js' })); fs.writeFileSync(path.join(app, 'main.js'), 'module.exports = true;');
  if (options.forbiddenAsar) fs.writeFileSync(path.join(app, 'nr-before-sr.zh-CN.addon64'), 'must not enter asar');
  await asar.createPackage(app, path.join(resources, 'app.asar'));
  for (const name of ['nvapi-drs.ps1', 'nvapi-profile.ps1', 'windows-registry-values.ps1', 'launcher-locations.ps1', 'game-launch-broker.ps1']) fs.writeFileSync(path.join(resources, name), '# fixture');
  for (const name of ['启动诊断.cmd', 'startup-diagnostics.ps1', '兼容启动.cmd', 'startup-compatible.ps1']) fs.writeFileSync(path.join(path.dirname(resources), name), 'fixture');
  const fg = path.join(resources, 'fg-components'); fs.mkdirSync(fg);
  for (const name of ['LICENSE', 'MINHOOK-LICENSE.txt', 'UAL-LICENSE', 'global.ini', 'component.dll']) fs.writeFileSync(path.join(fg, name), name);
  fs.writeFileSync(path.join(fg, 'manifest.json'), JSON.stringify({ version: 1, files: { core: { file: 'component.dll', sha256: '0'.repeat(64) } } }));
  return { root, app, resources, unpacked: path.dirname(resources) };
}

test('package verifier accepts an external build with FG licenses and no NR payload', async t => {
  const f = await packagedFixture(t), result = verifyExternalPackage(f.unpacked);
  assert.equal(result.ok, true); assert.equal(result.payloadBundled, false); assert.ok(result.asarEntries >= 2);
  assert.deepEqual(result.retainedRootFiles, ['启动诊断.cmd', 'startup-diagnostics.ps1', '兼容启动.cmd', 'startup-compatible.ps1']);
});

test('package verifier rejects each missing system helper and root diagnostic entry from every supported input path', async t => {
  const f = await packagedFixture(t);
  for (const rel of ['resources/windows-registry-values.ps1', 'resources/launcher-locations.ps1', 'resources/game-launch-broker.ps1', '启动诊断.cmd', 'startup-diagnostics.ps1', '兼容启动.cmd', 'startup-compatible.ps1']) {
    const file = path.join(f.unpacked, rel), original = fs.readFileSync(file); fs.unlinkSync(file);
    for (const selected of [f.unpacked, f.resources, path.join(f.resources, 'app.asar')]) {
      assert.throws(() => verifyExternalPackage(selected), error => {
        assert.equal(error.code, 'ERR_EXTERNAL_PACKAGE_INVALID');
        assert.ok(error.details.files.includes(path.basename(file)), `${rel} must be reported`); return true;
      });
    }
    fs.writeFileSync(file, original);
  }
  assert.equal(verifyExternalPackage(f.unpacked).ok, true);
});

test('package verifier rejects empty or directory replacements for required helpers', async t => {
  const f = await packagedFixture(t);
  for (const rel of ['resources/windows-registry-values.ps1', 'resources/launcher-locations.ps1', 'resources/game-launch-broker.ps1', '启动诊断.cmd', 'startup-diagnostics.ps1', '兼容启动.cmd', 'startup-compatible.ps1']) {
    const file = path.join(f.unpacked, rel), original = fs.readFileSync(file);
    fs.writeFileSync(file, ''); assert.throws(() => verifyExternalPackage(f.unpacked), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' });
    fs.unlinkSync(file); fs.mkdirSync(file); assert.throws(() => verifyExternalPackage(f.unpacked), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' });
    fs.rmdirSync(file); fs.writeFileSync(file, original);
  }
});

test('package verifier rejects proprietary NR files in resources or app.asar', async t => {
  const f = await packagedFixture(t), leaked = path.join(f.resources, 'payload', 'nr-before-sr', 'fixed', 'RTX50'); fs.mkdirSync(leaked, { recursive: true });
  fs.writeFileSync(path.join(leaked, 'nvngx_dlssnr.dll'), 'must not ship');
  assert.throws(() => verifyExternalPackage(f.resources), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' }); fs.rmSync(path.join(f.resources, 'payload'), { recursive: true });

  const second = await packagedFixture(t, { forbiddenAsar: true });
  assert.throws(() => verifyExternalPackage(path.join(second.resources, 'app.asar')), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' });
  const third = await packagedFixture(t); fs.mkdirSync(path.join(third.resources, 'vulkan-runtime'));
  assert.throws(() => verifyExternalPackage(third.resources), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' });
});
