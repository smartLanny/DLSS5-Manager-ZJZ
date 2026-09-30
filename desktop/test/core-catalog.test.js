'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../src/shared/core-catalog');
const hoyo = require('../src/shared/hoyo-core-policy');
const companions = require('../src/product/payload-companions');
const { pinnedConfigContract } = require('../src/product/nr-core-identity');
const { resolveContract } = require('../src/product/nr-config-contract');
const { readOtaPackage, catalogCorePackage } = require('../src/product/ota');
const { importCoreOta } = require('../scripts/import-core-ota.cjs');
const { zip, tempZip } = require('./helpers/ota-fixture');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const RECOMMENDED = catalog.byId(catalog.RECOMMENDED);
// 0.5.1 UI1 is still delivered as a Core-only OTA; Beta 13 as two handoff packages.
const OTA_CORE = catalog.byId('0.5.1-beta-ui1');
const FACE = companions.NAMES;

test('0.5.2 Beta 13 is the recommended provider Core with the handoff identities', () => {
  assert.equal(catalog.RECOMMENDED, '0.5.2-beta13');
  assert.equal(RECOMMENDED.displayVersion, '0.5.2-beta.13');
  assert.equal(RECOMMENDED.sourceCommit, 'cd8ba7009d333f7b03c463dc4237a913f9913081');
  assert.equal(RECOMMENDED.addon['zh-CN'], '46dc1cd9e4a9a5542230219ec2dfcd8bc39889e94b8e922c636792d745b40d64');
  assert.equal(RECOMMENDED.addon.en, '6264bc14269431478053ef55e153e87344b836b1dff6d6f18db904c97e584032');
  assert.equal(RECOMMENDED.chain, '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2');
  assert.deepEqual([...catalog.MAIN_MENU], ['0.5.2-beta13', '0.4.7beta']);
  // Package digests recomputed from the downloaded draft-release files.
  assert.equal(catalog.coreForPackage('fed1aa879c498955cf5b044aa1e2475da679003444c3737921de596fd6c56c2e').variant, 'RTX40-50');
  assert.equal(catalog.coreForPackage('e2994429b4433fc484a4aa59cc34dc4f7b3eb715ca29e9b341abdaab5bade29f').variant, 'RTX20-30');
  assert.equal(catalog.coreForPackage('0'.repeat(64)), null);
  assert.deepEqual(catalog.coreForArchive(OTA_CORE.ota.en), { core: OTA_CORE, language: 'en' });
  assert.equal(catalog.coreForArchive('0'.repeat(64)), null);
});

test('Beta 13 pairs one DLSS5 model per GPU series; older Cores keep the shared runtime', () => {
  const fortyFifty = 'a2d16f9fba2b619559427821169918df56fc8e410a6ac87569953598a00b66fa';
  const twentyThirty = '6dac1b40f0c87af84a8177b18c741e84fb0c914f204c9d87d95916b665ba3af8';
  for (const series of ['RTX40', 'RTX50']) assert.equal(catalog.pairedRuntime(catalog.RECOMMENDED, series).sha256, fortyFifty);
  for (const series of ['RTX20', 'RTX30']) assert.equal(catalog.pairedRuntime(catalog.RECOMMENDED, series).sha256, twentyThirty);
  assert.equal(catalog.pairedRuntime(catalog.RECOMMENDED, null), null, 'an unknown series is refused, never guessed');
  assert.equal(catalog.requiresPairedRuntime(catalog.RECOMMENDED), true);
  for (const id of ['0.5.1-beta-ui1', '0.5-dline21-unified5', '0.4.7beta']) assert.equal(catalog.requiresPairedRuntime(id), false);
  assert.equal(catalog.isPairedRuntime(fortyFifty), true); assert.equal(catalog.isPairedRuntime('0'.repeat(64)), false);
  const runtimes = require('../src/product/component-catalog.json').packages.filter(row => catalog.isPairedRuntime(row.sha256));
  assert.deepEqual(runtimes.map(row => row.hardwareSeries.join('/')).sort(), ['RTX20/RTX30', 'RTX40/RTX50']);
  assert.ok(runtimes.every(row => !/kio/i.test(JSON.stringify(row))), 'user-visible labels name the GPU series only');
});

test('a catalog ID alone never grants the provider stack', () => {
  assert.equal(catalog.isProviderCore(catalog.RECOMMENDED, RECOMMENDED.addon['zh-CN']), true);
  assert.equal(catalog.isProviderCore(catalog.RECOMMENDED, '0'.repeat(64)), false);
  assert.equal(catalog.isProviderCore('0.5-dline21-unified3', catalog.byId('0.5-dline21-unified3').addon['zh-CN']), false);
  assert.equal(require('../src/product/experimental-core-routing').isProviderCore('0.5-dline21-unified5',
    catalog.byId('0.5-dline21-unified5').addon['zh-CN']), true);
});

test('config contract, face resources and HoYo policy follow the catalog', () => {
  for (const hash of Object.values(RECOMMENDED.addon)) {
    const pinned = pinnedConfigContract(hash);
    assert.deepEqual(pinned, { configContract: 'nr-uniform-colour-v2', sourceCommit: RECOMMENDED.sourceCommit });
    assert.equal(resolveContract({ version: RECOMMENDED.id, ...pinned }).colourMemory, true);
  }
  assert.equal(companions.required(RECOMMENDED.id), true);
  assert.throws(() => companions.validateMap(undefined, RECOMMENDED.id), { code: 'ERR_PAYLOAD_HASH' });
  assert.equal(hoyo.CURRENT, catalog.RECOMMENDED);
  assert.equal(hoyo.allowed(catalog.RECOMMENDED, 'feeder'), true);
  assert.equal(hoyo.allowed('0.4.7beta', 'feeder'), false);
  assert.throws(() => hoyo.assertTarget('0.5-dline21-unified5'), /0\.4\.7 或当前 0\.5\.2 Beta 13/);
});

function catalogEntries({ language = 'zh-CN', addon = 'core bytes', build = {} } = {}) {
  const files = { 'core.addon64': addon, 'nrchain_nvngx.dll': 'chain bytes', 'dlss5-native-carrier-045-dx11-compat.addon64': 'carrier bytes',
    'LICENSES.txt': 'licenses', 'NVIDIA-NGX-LICENSE.txt': 'ngx license', '安装说明.txt': 'read me',
    ...Object.fromEntries(FACE.map(name => [name, `face ${name}`])) };
  const core = { ...OTA_CORE, addon: { 'zh-CN': sha(addon) }, chain: sha('chain bytes'), carrier: null };
  const buildInfo = { version: core.buildVersion, source_commit: core.sourceCommit, language, full_face_backend: true,
    game_runtime_verified: false, stable_release: false, ...build };
  // Like the packaging script, SHA256.json lists every member including build-info.json.
  files['build-info.json'] = JSON.stringify(buildInfo);
  const rows = Object.entries(files).map(([file, data]) => ({ file, sha256: sha(data) }));
  const entries = new Map([...Object.entries(files).map(([name, data]) => [name, Buffer.from(data)]),
    ['SHA256.json', Buffer.from(JSON.stringify(rows))]]);
  return { entries, core, buildInfo };
}

test('a cataloged OTA is admitted only with matching metadata and member digests', () => {
  const { entries, core, buildInfo } = catalogEntries();
  const result = catalogCorePackage(entries, 'a'.repeat(64), buildInfo, { core, language: 'zh-CN' });
  assert.equal(result.canonicalCore.id, OTA_CORE.id);
  assert.equal(result.addonSha256, sha('core bytes'));
  assert.equal(result.companions.length, FACE.length);
  assert.deepEqual(result.notices.map(row => row.name).sort(), ['LICENSES.txt', 'NVIDIA-NGX-LICENSE.txt']);
  assert.throws(() => catalogCorePackage(entries, 'a'.repeat(64), buildInfo, { core, language: 'en' }), { code: 'ERR_OTA_LANGUAGE' });
  const other = catalogEntries({ build: { source_commit: '0'.repeat(40) } });
  assert.throws(() => catalogCorePackage(other.entries, 'a'.repeat(64), other.buildInfo, { core, language: 'zh-CN' }), /metadata mismatch/);
  const swapped = catalogEntries({ addon: 'another core' });
  assert.throws(() => catalogCorePackage(swapped.entries, 'a'.repeat(64), swapped.buildInfo, { core, language: 'zh-CN' }), /Core/);
  assert.throws(() => catalogCorePackage(entries, 'a'.repeat(64), buildInfo, { core: { ...core, carrier: '0'.repeat(64) }, language: 'zh-CN' }), /carrier/);
});

test('identical 0.5.1 metadata in an unregistered ZIP is not recognized', async t => {
  const { entries } = catalogEntries();
  const file = zip(tempZip(), [...entries].map(([name, data]) => ({ name, data })));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  await assert.rejects(readOtaPackage(file), /unsupported DX11 OTA metadata/);
});

const realOta = process.env.DLSS5_TEST_CORE_OTA;
test('the delivered 0.5.1 UI1 Chinese OTA matches the catalog byte for byte', { skip: !realOta && '设置 DLSS5_TEST_CORE_OTA 指向实际 ZIP 才运行' }, async () => {
  const ota = await readOtaPackage(path.resolve(realOta));
  assert.equal(ota.archiveSha256, OTA_CORE.ota['zh-CN']);
  assert.equal(ota.canonicalCore.id, OTA_CORE.id);
  assert.equal(ota.addonSha256, OTA_CORE.addon['zh-CN']);
  assert.equal(ota.bridgeSha256, OTA_CORE.chain);
});

function priorPayload(root) {
  const payload = path.join(root, 'payload'), write = (rel, data) => {
    const file = path.join(payload, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return sha(data);
  };
  const fixed = {};
  for (const family of ['RTX40', 'RTX50'])
    fixed[family] = { files: { 'ReShade64.dll': write(`fixed/${family}/ReShade64.dll`, 'reshade'), 'nrchain_nvngx.dll': write(`fixed/${family}/nrchain_nvngx.dll`, 'chain'),
      'nvngx_dlssnr.dll': sha(`runtime ${family}`) } };
  const unified5 = { files: { 'nr-before-sr.zh-CN.addon64': write('versions/0.5-dline21-unified5/nr-before-sr.zh-CN.addon64', 'u5'),
    'nr_before_sr.ini': write('versions/0.5-dline21-unified5/nr_before_sr.ini', '[NRBeforeSR]\nIntensity=1\n') } };
  const standard = { files: { 'nr-before-sr.zh-CN.addon64': write('versions/0.4.7beta/nr-before-sr.zh-CN.addon64', '047') } };
  fs.writeFileSync(path.join(payload, 'bundle.json'), JSON.stringify({ version: 4, defaultVersion: '0.4.7beta', fixed,
    versions: { '0.4.7beta': standard, '0.5-dline21-unified5': unified5 } }));
  const staging = path.join(root, 'staging.json');
  fs.writeFileSync(staging, JSON.stringify({ schemaVersion: 1, packageVersion: 'old', core: { payloadRoot: payload, version: '0.4.7beta',
    versions: ['0.4.7beta', '0.5-dline21-unified5'] }, resources: [{ path: 'hoyoshade/component.json' }] }));
  return { staging, iniSha: unified5.files['nr_before_sr.ini'] };
}

test('importing a Core-only OTA stages its slot without changing the recommended default', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ota-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { staging, iniSha } = priorPayload(root), { entries, buildInfo } = catalogEntries();
  const readOta = async () => ({ ...catalogCorePackage(entries, OTA_CORE.ota['zh-CN'], buildInfo,
    { core: { ...OTA_CORE, addon: { 'zh-CN': sha('core bytes') }, chain: sha('chain bytes') }, language: 'zh-CN' }),
  canonicalCore: { id: OTA_CORE.id }, archiveSha256: OTA_CORE.ota['zh-CN'] });
  const output = path.join(root, 'out');
  const result = await importCoreOta({ ota: path.join(root, 'x.zip'), staging, output, packageVersion: '0.5.0-beta.11', readOta });
  assert.equal(result.defaultVersion, '0.4.7beta', 'only the recommended Core becomes the default'); assert.equal(result.iniSha256, iniSha);
  const bundle = JSON.parse(fs.readFileSync(path.join(output, 'core-catalog', 'bundle.json'), 'utf8'));
  const entry = bundle.versions[OTA_CORE.id];
  assert.equal(entry.files['nr-before-sr.zh-CN.addon64'], sha('core bytes'));
  assert.equal(entry.files['nr_before_sr.ini'], iniSha, 'the previous unified default INI is reused');
  assert.equal(entry.otaArchiveSha256, OTA_CORE.ota['zh-CN']);
  assert.equal(Object.keys(entry.companions).length, FACE.length);
  for (const [name, digest] of Object.entries({ ...entry.files, ...entry.companions }))
    assert.equal(sha(fs.readFileSync(path.join(output, 'core-catalog', 'versions', OTA_CORE.id, name))), digest, name);
  assert.equal(fs.existsSync(path.join(output, 'core-catalog', 'fixed', 'RTX40', 'nvngx_dlssnr.dll')), false, 'DLSS5 model stays separate');
  assert.equal(bundle.versions['0.4.7beta'].files['nr-before-sr.zh-CN.addon64'], sha('047'));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'staging.json'), 'utf8'));
  assert.equal(manifest.packageVersion, '0.5.0-beta.11'); assert.ok(manifest.core.versions.includes(OTA_CORE.id));
  assert.deepEqual(manifest.resources.filter(row => row.path.startsWith('core-notices/')).map(row => row.path).sort(),
    ['core-notices/051/LICENSES.txt', 'core-notices/051/NVIDIA-NGX-LICENSE.txt']);
  await assert.rejects(importCoreOta({ ota: 'x.zip', staging, output, readOta }), /新的空输出目录/);
  await assert.rejects(importCoreOta({ ota: 'x.zip', staging, output: path.join(root, 'other'),
    readOta: async () => ({ ...(await readOta()), archiveSha256: '0'.repeat(64) }) }), /未在 src\/shared\/core-catalog\.js 登记/);
});

test('the recommended handoff package becomes the default without staging its DLSS5 model', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-package-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { staging, iniSha } = priorPayload(root);
  const data = { addon: Buffer.from('beta13 core'), bridge: Buffer.from('chain bytes'), notice: Buffer.from('licenses') };
  const calls = [];
  const readPackage = async (file, options) => { calls.push([file, options]); return { archiveSha256: RECOMMENDED.packages['RTX40-50'].sha256, core: RECOMMENDED,
    variant: 'RTX40-50', addon: data.addon, addonSha256: sha(data.addon), bridge: data.bridge, bridgeSha256: sha(data.bridge),
    companions: FACE.map(name => ({ name, data: Buffer.from(`face ${name}`), sha256: sha(`face ${name}`) })),
    notices: [{ name: 'LICENSES.txt', data: data.notice, sha256: sha(data.notice) }], runtime: { sha256: RECOMMENDED.packages['RTX40-50'].runtime, file: null } }; };
  const output = path.join(root, 'out');
  const result = await importCoreOta({ package: path.join(root, 'DLSS5-0.5.2-beta.13-RTX40-50.zip'), staging, output, readPackage });
  assert.equal(calls.length, 1); assert.equal(calls[0][1], undefined, 'the NVIDIA DLSS5 model is never extracted for staging');
  assert.equal(result.defaultVersion, catalog.RECOMMENDED); assert.equal(result.iniSha256, iniSha);
  const bundle = JSON.parse(fs.readFileSync(path.join(output, 'core-catalog', 'bundle.json'), 'utf8'));
  const entry = bundle.versions[catalog.RECOMMENDED];
  assert.equal(bundle.defaultVersion, catalog.RECOMMENDED);
  assert.equal(entry.packageSha256, RECOMMENDED.packages['RTX40-50'].sha256); assert.equal(entry.otaArchiveSha256, undefined);
  assert.deepEqual(Object.keys(entry.files).sort(), ['nr-before-sr.zh-CN.addon64', 'nr_before_sr.ini', 'nrchain_nvngx.dll'], 'no carrier and no DLSS5 model');
  const versionDir = path.join(output, 'core-catalog', 'versions', catalog.RECOMMENDED);
  assert.equal(fs.existsSync(path.join(versionDir, 'nvngx_dlssnr.dll')), false);
  for (const [name, digest] of Object.entries({ ...entry.files, ...entry.companions }))
    assert.equal(sha(fs.readFileSync(path.join(versionDir, name))), digest, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'staging.json'), 'utf8'));
  assert.equal(manifest.core.version, catalog.RECOMMENDED);
  assert.deepEqual(manifest.resources.filter(row => row.path.startsWith('core-notices/')).map(row => row.path), ['core-notices/052/LICENSES.txt']);
  await assert.rejects(importCoreOta({ ota: 'x.zip', package: 'y.zip', staging, output: path.join(root, 'both') }), /用法/);
});
