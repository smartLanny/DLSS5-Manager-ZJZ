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
const FACE = companions.NAMES;

test('0.5.1 UI1 is the recommended provider Core with the handoff identities', () => {
  assert.equal(catalog.RECOMMENDED, '0.5.1-beta-ui1');
  assert.equal(RECOMMENDED.buildVersion, 'beta0.5-dline21-unified10-reconstruction1-ui1');
  assert.equal(RECOMMENDED.addon['zh-CN'], '213338900bfcbada149dc89e7fcea0b12f8843f0252a4cb81ce16e847d3b607d');
  assert.equal(RECOMMENDED.addon.en, '54f998be0c7d1c293fcb9a6b231f4ca917a826e6e9c40afa699903534cb97929');
  assert.equal(RECOMMENDED.chain, '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2');
  assert.equal(RECOMMENDED.ota['zh-CN'], '7b9dcb58260edc18e2dfd55111213cfb589d2bf958127bedde8e869cfc7f4e14');
  assert.equal(RECOMMENDED.ota.en, '6f37b47bd1d3be8d48094f0624362ba4fcce5824841ba5f52ddd62cd3dec505b');
  assert.deepEqual([...catalog.MAIN_MENU], ['0.5.1-beta-ui1', '0.4.7beta']);
  assert.deepEqual(catalog.coreForArchive(RECOMMENDED.ota.en), { core: RECOMMENDED, language: 'en' });
  assert.equal(catalog.coreForArchive('0'.repeat(64)), null);
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
  assert.throws(() => hoyo.assertTarget('0.5-dline21-unified5'), /0\.4\.7 或当前 0\.5\.1/);
});

function catalogEntries({ language = 'zh-CN', addon = 'core bytes', build = {} } = {}) {
  const files = { 'core.addon64': addon, 'nrchain_nvngx.dll': 'chain bytes', 'dlss5-native-carrier-045-dx11-compat.addon64': 'carrier bytes',
    'LICENSES.txt': 'licenses', 'NVIDIA-NGX-LICENSE.txt': 'ngx license', '安装说明.txt': 'read me',
    ...Object.fromEntries(FACE.map(name => [name, `face ${name}`])) };
  const core = { ...RECOMMENDED, addon: { 'zh-CN': sha(addon) }, chain: sha('chain bytes'), carrier: null };
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
  assert.equal(result.canonicalCore.id, catalog.RECOMMENDED);
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
  assert.equal(ota.archiveSha256, RECOMMENDED.ota['zh-CN']);
  assert.equal(ota.canonicalCore.id, catalog.RECOMMENDED);
  assert.equal(ota.addonSha256, RECOMMENDED.addon['zh-CN']);
  assert.equal(ota.bridgeSha256, RECOMMENDED.chain);
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

test('importing the recommended OTA stages it as the default without touching older Cores', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ota-import-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { staging, iniSha } = priorPayload(root), { entries, buildInfo } = catalogEntries();
  const readOta = async () => ({ ...catalogCorePackage(entries, RECOMMENDED.ota['zh-CN'], buildInfo,
    { core: { ...RECOMMENDED, addon: { 'zh-CN': sha('core bytes') }, chain: sha('chain bytes') }, language: 'zh-CN' }),
  canonicalCore: { id: catalog.RECOMMENDED }, archiveSha256: RECOMMENDED.ota['zh-CN'] });
  const output = path.join(root, 'out');
  const result = await importCoreOta({ ota: path.join(root, 'x.zip'), staging, output, packageVersion: '0.5.0-beta.11', readOta });
  assert.equal(result.defaultVersion, catalog.RECOMMENDED); assert.equal(result.iniSha256, iniSha);
  const bundle = JSON.parse(fs.readFileSync(path.join(output, 'core-catalog', 'bundle.json'), 'utf8'));
  const entry = bundle.versions[catalog.RECOMMENDED];
  assert.equal(bundle.defaultVersion, catalog.RECOMMENDED);
  assert.equal(entry.files['nr-before-sr.zh-CN.addon64'], sha('core bytes'));
  assert.equal(entry.files['nr_before_sr.ini'], iniSha, 'the previous unified default INI is reused');
  assert.equal(Object.keys(entry.companions).length, FACE.length);
  for (const [name, digest] of Object.entries({ ...entry.files, ...entry.companions }))
    assert.equal(sha(fs.readFileSync(path.join(output, 'core-catalog', 'versions', catalog.RECOMMENDED, name))), digest, name);
  assert.equal(fs.existsSync(path.join(output, 'core-catalog', 'fixed', 'RTX40', 'nvngx_dlssnr.dll')), false, 'DLSS5 model stays separate');
  assert.equal(bundle.versions['0.4.7beta'].files['nr-before-sr.zh-CN.addon64'], sha('047'));
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'staging.json'), 'utf8'));
  assert.equal(manifest.core.version, catalog.RECOMMENDED); assert.equal(manifest.packageVersion, '0.5.0-beta.11');
  assert.ok(manifest.core.versions.includes(catalog.RECOMMENDED));
  assert.deepEqual(manifest.resources.filter(row => row.path.startsWith('core-notices/')).map(row => row.path).sort(),
    ['core-notices/051/LICENSES.txt', 'core-notices/051/NVIDIA-NGX-LICENSE.txt']);
  await assert.rejects(importCoreOta({ ota: 'x.zip', staging, output, readOta }), /新的空输出目录/);
  await assert.rejects(importCoreOta({ ota: 'x.zip', staging, output: path.join(root, 'other'),
    readOta: async () => ({ ...(await readOta()), archiveSha256: '0'.repeat(64) }) }), /未在 src\/shared\/core-catalog\.js 登记/);
});
