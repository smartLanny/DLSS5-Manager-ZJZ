'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');
const packageJson = require('../package.json');
const { resourceCopies, LEGACY_FG_RESOURCE_FILES } = require('../scripts/static-resources.cjs');
const { createFgComponents: createLegacyFgComponents, DEFAULT_CONTROL } = require('../src/product/fg-legacy-components');
const { verifyExternalPackage } = require('../scripts/verify-external-package.cjs');
const APP_ROOT = path.resolve(__dirname, '..');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

test('external build keeps the normal app while using the source-only static resource allow-list', () => {
  const before = structuredClone(packageJson.build), config = require('../scripts/external-build-config.cjs');
  assert.deepEqual(packageJson.build, before, 'loading the variant must not mutate the default package config');
  for (const key of ['appId', 'productName', 'files', 'fileAssociations']) assert.deepEqual(config[key], before[key]);
  assert.deepEqual(config.extraResources, resourceCopies({ root: APP_ROOT }));
  assert.equal(config.extraResources.length, 10);
  for (const row of config.extraResources) {
    assert.doesNotMatch(String(row.from) + '/' + String(row.to), /(?:payload|vulkan-runtime|feeder-runtime|fg-mfgunlock)/i);
    assert.doesNotMatch(String(row.from) + '/' + String(row.to), /\.(?:dll|exe|asi|addon(?:32|64)?)$/i);
  }
  assert.deepEqual(config.extraResources.filter(row => row.to.startsWith('fg-components/')).map(row => row.to).sort(),
    LEGACY_FG_RESOURCE_FILES.map(([, to]) => to).sort());
  for (const [from, to] of [['scripts/startup-diagnostics.cmd', '启动诊断.cmd'], ['scripts/startup-diagnostics.ps1', 'startup-diagnostics.ps1'],
    ['scripts/startup-compatible.cmd', '兼容启动.cmd'], ['scripts/startup-compatible.ps1', 'startup-compatible.ps1']])
    assert.equal(config.extraFiles.some(row => row.from === from && row.to === to), true, to + ' retained at app root');
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker'); assert.equal(config.portable.requestExecutionLevel, 'user');
  assert.equal(config.portable.artifactName, 'DLSS5-Manager-' + '$' + '{version}-external-portable.exe');
  assert.equal(config.nsis.artifactName, 'DLSS5-Manager-Setup-' + '$' + '{version}-external.exe'); assert.equal(config.directories.output, 'dist-external');
  assert.match(packageJson.scripts['build:external'], /build-desktop-contract\.mjs/);
  assert.doesNotMatch(packageJson.scripts['build:external'], /verify:fg-components|verify:fg-mfgunlock/);
});

test('metadata-only external resources still inspect a legacy v1 receipt without shipping FG binaries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-legacy-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, 'resources'), fg = path.join(resourceRoot, 'fg-components');
  fs.mkdirSync(fg, { recursive: true });
  for (const [from, to] of LEGACY_FG_RESOURCE_FILES) fs.copyFileSync(path.join(APP_ROOT, from), path.join(resourceRoot, to));
  const metadataOnly = fs.readdirSync(fg).sort();
  assert.deepEqual(metadataOnly, ['LICENSE', 'MINHOOK-LICENSE.txt', 'UAL-LICENSE', 'global.ini', 'manifest.json']);
  assert.equal(metadataOnly.some(name => /\.(?:dll|exe|asi|addon(?:32|64)?)$/i.test(name)), false);
  const game = path.join(root, 'game'), dir = path.join(game, 'bin'), exe = path.join(dir, 'Game.exe');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(exe, 'fixture');
  const manifest = JSON.parse(fs.readFileSync(path.join(fg, 'manifest.json'), 'utf8'));
  const receipt = {
    version: 1, id: manifest.id, protocol: 11, exe, proxy: 'version.dll',
    files: [
      { role: 'core', rel: 'bin/' + manifest.files.core.file, mode: 'created', after: manifest.files.core.sha256 },
      { role: 'asi', rel: 'bin/' + manifest.files.asi.file, mode: 'created', after: manifest.files.asi.sha256 },
      { role: 'overlay', rel: 'bin/' + manifest.files.overlay.file, mode: 'created', after: manifest.files.overlay.sha256 },
      { role: 'ual', rel: 'bin/version.dll', mode: 'created', after: manifest.files.ual.sha256 },
      { role: 'ualConfig', rel: 'bin/version.ini', mode: 'created', after: '0'.repeat(64) },
      { role: 'control', rel: 'bin/RTX40MFG-Universal.json', mode: 'created', after: sha256(Buffer.from(DEFAULT_CONTROL, 'utf8')) }
    ]
  };
  const receiptFile = path.join(game, '_DLSS5_Backup', 'xiaofeng-fg-components.json');
  fs.mkdirSync(path.dirname(receiptFile), { recursive: true }); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const service = createLegacyFgComponents({ resourcesPath: resourceRoot, appDir: root, gameDirectory: () => game, gameExecutable: () => exe,
    getReShadeSource: async () => null });
  const plan = await service.inspectRestore('old');
  assert.equal(plan.receipt.id, manifest.id); assert.deepEqual(plan.retained, []);
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
  for (const name of ['LICENSE', 'MINHOOK-LICENSE.txt', 'UAL-LICENSE', 'global.ini']) fs.writeFileSync(path.join(fg, name), name);
  fs.writeFileSync(path.join(fg, 'manifest.json'), JSON.stringify({ version: 1, id: 'fixture-legacy', protocol: 11,
    files: { core: { file: 'RTX40MFGCore.dll', sha256: '0'.repeat(64) }, asi: { file: 'RTX40MFG.asi', sha256: '1'.repeat(64) },
      overlay: { file: 'RTX40MFG-UI.addon64', sha256: '2'.repeat(64) }, ual: { file: 'ual-x64.dll', sha256: '3'.repeat(64) },
      ualConfig: { file: 'global.ini', sha256: '4'.repeat(64) } }, ualProxyNames: ['version.dll'], sources: [] }));
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

test('package verifier rejects incomplete or binary legacy FG resources', async t => {
  const f = await packagedFixture(t);
  for (const rel of ['resources/fg-components/manifest.json', 'resources/fg-components/LICENSE', 'resources/fg-components/MINHOOK-LICENSE.txt',
    'resources/fg-components/UAL-LICENSE', 'resources/fg-components/global.ini']) {
    const file = path.join(f.unpacked, rel), original = fs.readFileSync(file); fs.unlinkSync(file);
    assert.throws(() => verifyExternalPackage(f.unpacked), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' });
    fs.writeFileSync(file, original);
  }
  const leaked = path.join(f.resources, 'fg-components', 'RTX40MFGCore.dll');
  fs.writeFileSync(leaked, 'must not ship');
  assert.throws(() => verifyExternalPackage(f.unpacked), { code: 'ERR_EXTERNAL_PACKAGE_INVALID' });
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
