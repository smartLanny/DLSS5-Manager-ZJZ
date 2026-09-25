'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readOtaPackage, sha256Buffer } = require('../src/product/ota');
const { CORE, CARRIER, BRIDGE, zip, tempZip, standardFixture, dx11Fixture } = require('./helpers/ota-fixture');

const CORE_046 = 'DLSS5-AI渲染超分版-beta0.4.6-@野生的装机宅-Bilibili.addon64';
const CORE_046_HOTFIX1 = 'DLSS5-AI渲染超分版-beta0.4.6-hotfix.1-@野生的装机宅-Bilibili.addon64';
const D21_PACKAGE = 'C:\\Users\\PC\\Downloads\\装机宅DLSS5 0.5版本叠层测试\\OTA覆盖小包-装机宅叠层DLSS5-0.5-D21-累计常规版-中文-OTA.zip';

test('recognizes the exact D21 cumulative OTA as a canonical candidate without promoting it to stable',
  { skip: !fs.existsSync(D21_PACKAGE) }, async () => {
    const ota = await readOtaPackage(D21_PACKAGE);
    assert.equal(ota.archiveSha256, 'cf6d486a4525c75c5279446bd596b6008fc1eb5e3a8b1863a2ee15f249148107');
    assert.equal(ota.canonicalCore?.id, '0.5-dline21');
    assert.equal(ota.canonicalCore?.validation, 'candidate');
    assert.equal(ota.canonicalCore?.stableRelease, false);
    assert.equal(ota.canonicalCore?.coreUpdateOnly, true);
    assert.equal(ota.addonSha256, '5fb873dab6f03f27c0b37380dff7ab5ad4ebc0ca295feadba06d00a28a1c9c78');
    assert.equal(ota.bridgeSha256, '1acf3cbe509a031be1763a8231cd81e6019aa3532368cd0b08a6c17bc94b70a2');
  });

test('a D3D12 Core-only acceptance archive is explained without mislabeling it as a DX11 OTA', async () => {
  const file = zip(tempZip(), [
    { name: 'core.addon64', data: 'isolated-core' },
    { name: BRIDGE, data: 'isolated-nrchain' },
    { name: 'build-info.json', data: JSON.stringify({ version: 'beta0.5-dev10', scope: 'D3D12 Core-only manual acceptance; not Manager/multi-API OTA', carrier_included: false }) },
    { name: 'SHA256.json', data: '[]' }
  ]);
  await assert.rejects(readOtaPackage(file), error => {
    assert.equal(error.code, 'ERR_OTA_CORE_ONLY');
    assert.match(error.message, /D3D12.*核心测试包/);
    assert.match(error.message, /不能作为 Manager OTA/);
    assert.doesNotMatch(error.message, /DX11 OTA metadata/);
    return true;
  });
});

function release046Fixture(options = {}) {
  const source = '9087a9efbc7bb53a3c79e7766a174534f49c412c';
  const buildInfo = Buffer.from(JSON.stringify({
    display_version: '0.4.6', version: options.version || 'beta0.4.6',
    source_commit: source, packaging_commit: source, language: 'zh-CN',
    core_pe_version: '0.4.6.0', core_file_version: '0.4.6 beta',
    carrier_upstream_file_version: '1.4.12.0',
    bridge_upstream_commit: '28aed4099b0fe1c207b20b5fee5364c0773c25c2',
    source_manifest_sha256: '7bb174529eb077e5b3e619c06e53209e778c3a3795dffc8d8a02ef31f84cfb71',
    validation_sha256: '394bcb44a8f5c921508d8103cb9c597f28c61003731f16bb62b083114e931daa',
    local_windows_verified: true, local_warp_verified: true,
    game_runtime_verified: false, stable_release: false
  }));
  const payload = new Map([
    ['build-info.json', buildInfo],
    [options.carrierName || CARRIER, Buffer.from('self-consistent-but-unpublished-carrier')],
    [CORE_046, Buffer.from('self-consistent-but-unpublished-core')],
    [BRIDGE, Buffer.from('self-consistent-but-unpublished-bridge')]
  ]);
  const hashes = [...payload].map(([file, data]) => ({ file, sha256: sha256Buffer(data) }));
  return [...payload].map(([name, data]) => ({ name, data })).concat({
    name: 'SHA256.json', data: JSON.stringify(hashes)
  });
}

function release046Hotfix1Fixture(options = {}) {
  const source = '35ef9a826642e0eabcecd46d012167dd52b98105';
  const buildInfo = Buffer.from(JSON.stringify({
    display_version: '0.4.6-hotfix.1', version: 'beta0.4.6-hotfix.1',
    source_commit: source, packaging_commit: source, language: 'zh-CN',
    core_pe_version: '0.4.6.1', core_file_version: '0.4.6 hotfix.1 beta',
    carrier_upstream_file_version: '1.4.12.0',
    bridge_upstream_commit: '28aed4099b0fe1c207b20b5fee5364c0773c25c2',
    source_manifest_sha256: 'bf69c537c4c20b75b68940463d4990742f95d17ddffbdd5a7bbe19688c51f90d',
    validation_sha256: '62dfd5ac613c3d14575d3f9a6de4e13a7fe9f929608baba8fd133d80e0224da2',
    local_windows_verified: true, local_warp_verified: true,
    game_runtime_verified: false, stable_release: false
  }));
  const payload = new Map([
    ['build-info.json', buildInfo],
    [CARRIER, Buffer.from('self-consistent-but-unpublished-hotfix-carrier')],
    [options.coreName || CORE_046_HOTFIX1, Buffer.from('self-consistent-but-unpublished-hotfix-core')],
    [BRIDGE, Buffer.from('self-consistent-but-unpublished-hotfix-bridge')]
  ]);
  const hashes = [...payload].map(([file, data]) => ({ file, sha256: sha256Buffer(data) }));
  return [...payload].map(([name, data]) => ({ name, data })).concat({
    name: 'SHA256.json', data: JSON.stringify(hashes)
  });
}

test('keeps the historical nr-branch-ota-v1 DX12 contract', async () => {
  const file = zip(tempZip(), standardFixture());
  const ota = await readOtaPackage(file);
  assert.equal(ota.manifest.schema, 'nr-branch-ota-v1');
  assert.equal(ota.addonName, 'core.addon64');
  assert.equal(ota.addon.toString(), 'standard-core');
  assert.equal(ota.addonSha256, sha256Buffer(ota.addon));
  assert.equal(ota.bridgeName, BRIDGE);
  assert.equal(ota.bridgeSha256, sha256Buffer(ota.bridge));
  assert.equal(ota.carrierName, null);
  assert.equal(ota.carrier, null);
  assert.equal(ota.carrierSha256, null);
  assert.equal(ota.compatibility, null);
  assert.equal(ota.instructions, 'standard instructions');
});

test('keeps the published Beta0.3.8 optional unhashed instructions exception bounded to text', async () => {
  const file = zip(tempZip(), standardFixture({ unhashedInstructions: true }));
  const ota = await readOtaPackage(file);
  assert.equal(ota.instructions, 'standard instructions');
  assert.equal(ota.compatibility, null);
});

test('identifies the published DX11 core, carrier and nrchain by role rather than ZIP order', async () => {
  const file = zip(tempZip(), dx11Fixture());
  const ota = await readOtaPackage(file);
  assert.equal(ota.manifest.version, 'beta0.4.5-dx11-compat');
  assert.equal(ota.manifest.source_commit, 'd'.repeat(40));
  assert.equal(ota.addonName, CORE);
  assert.equal(ota.addon.toString(), 'dx11-core');
  assert.equal(ota.carrierName, CARRIER);
  assert.equal(ota.carrier.toString(), 'matched-carrier');
  assert.equal(ota.bridgeName, BRIDGE);
  assert.equal(ota.compatibility, 'dx11');
  assert.equal(ota.addonSha256, sha256Buffer(ota.addon));
  assert.equal(ota.carrierSha256, sha256Buffer(ota.carrier));
  assert.equal(ota.bridgeSha256, sha256Buffer(ota.bridge));
  assert.equal(ota.instructions, '成套安装');
});

const realPackage = path.resolve(__dirname, '..', '..', 'nr-main-unify', 'build', 'dx11-compat-chinese-final',
  'DLSS5-AI渲染超分版-0.4.5-DX11-兼容增强-@野生的装机宅-Bilibili-OTA.zip');
test('reads the locally verified published Chinese compatibility ZIP', { skip: !fs.existsSync(realPackage) }, async () => {
  const ota = await readOtaPackage(realPackage);
  assert.equal(ota.compatibility, 'dx11');
  assert.equal(ota.addonName, CORE);
  assert.equal(ota.addonSha256, 'ffea8e3a92cf07388f71b1855f3157c9c959a7a094b6f1a35cb92c57bf2f06f9');
  assert.equal(ota.carrierName, CARRIER);
  assert.equal(ota.carrierSha256, 'f825ccc47c2bdf3e365606ba44760371f74ac0ec0fabbc0565ae98864fca05ce');
  assert.equal(ota.bridgeSha256, '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb');
});

const release046Package = path.resolve(__dirname, '..', '..', 'beta046-ota-20260908',
  'DLSS5-AI渲染超分版-0.4.6-@野生的装机宅-Bilibili-OTA.zip');
test('reads the verified 0.4.6 Chinese OTA as one exact core, carrier and nrchain set',
  { skip: !fs.existsSync(release046Package) }, async () => {
    const ota = await readOtaPackage(release046Package);
    assert.equal(ota.manifest.version, 'beta0.4.6');
    assert.equal(ota.manifest.source_commit, '9087a9efbc7bb53a3c79e7766a174534f49c412c');
    assert.equal(ota.manifest.game_runtime_verified, false);
    assert.equal(ota.compatibility, 'dx11');
    assert.equal(ota.addonName, 'DLSS5-AI渲染超分版-beta0.4.6-@野生的装机宅-Bilibili.addon64');
    assert.equal(ota.addonSha256, 'b68f2709a131c9ce0513b6366dbcc2e7d551bef5bcd41934075407378a48c090');
    assert.equal(ota.carrierName, CARRIER);
    assert.equal(ota.carrierSha256, '8268ba3a9d7614ca0e0efad22f7c477780547224dfd0847a1d67188fc05f13c0');
    assert.equal(ota.bridgeName, BRIDGE);
    assert.equal(ota.bridgeSha256, '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb');
    assert.match(ota.instructions, /D3D12.*carrier/s);
  });

test('does not widen the 0.4.6 profile to self-declared binaries, carriers or future versions', async t => {
  await t.test('self-consistent unpublished component hashes', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), release046Fixture())), /component identity mismatch/);
  });
  await t.test('arbitrary carrier filename', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), release046Fixture({ carrierName: 'other-carrier.addon64' }))),
      /matched DX11 carrier/);
  });
  await t.test('unknown future version', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), release046Fixture({ version: 'beta0.4.7' }))),
      /unsupported DX11 OTA metadata/);
  });
  await t.test('inherited object-key version', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), release046Fixture({ version: 'constructor' }))),
      /unsupported DX11 OTA metadata/);
  });
});

const release046Hotfix1Package = path.resolve(__dirname, '..', '..', 'deliveries',
  'DLSS5-Core-0.4.6-hotfix.1-20260908', 'DLSS5-0.4.6-hotfix.1-zh-CN-OTA.zip');
test('reads the verified 0.4.6-hotfix.1 Chinese OTA with its exact component set',
  { skip: !fs.existsSync(release046Hotfix1Package) }, async () => {
    const ota = await readOtaPackage(release046Hotfix1Package);
    assert.equal(ota.manifest.version, 'beta0.4.6-hotfix.1');
    assert.equal(ota.manifest.display_version, '0.4.6-hotfix.1');
    assert.equal(ota.manifest.source_commit, '35ef9a826642e0eabcecd46d012167dd52b98105');
    assert.equal(ota.manifest.packaging_commit, '35ef9a826642e0eabcecd46d012167dd52b98105');
    assert.equal(ota.manifest.core_pe_version, '0.4.6.1');
    assert.equal(ota.manifest.game_runtime_verified, false);
    assert.equal(ota.compatibility, 'dx11');
    assert.equal(ota.addonName, CORE_046_HOTFIX1);
    assert.equal(ota.addonSha256, '0727be26ceddcf60354535cee7c12a3138eef3075d7f90110b3693508fb633a5');
    assert.equal(ota.carrierName, CARRIER);
    assert.equal(ota.carrierSha256, '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86');
    assert.equal(ota.bridgeName, BRIDGE);
    assert.equal(ota.bridgeSha256, '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb');
    assert.match(ota.instructions, /Windows\/WARP通过不等于所有游戏通过/);
  });

test('rejects self-declared and cross-release hotfix component sets', async t => {
  await t.test('self-consistent unpublished hotfix binaries', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), release046Hotfix1Fixture())),
      /beta0\.4\.6-hotfix\.1 OTA component identity mismatch/);
  });
  await t.test('hotfix metadata paired with the original 0.4.6 core role', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), release046Hotfix1Fixture({ coreName: CORE_046 }))),
      /published core addon64/);
  });
});

test('rejects tampered hashes and declared sizes', async t => {
  await t.test('standard hash', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), standardFixture({ badHash: true }))), /hash mismatch/);
  });
  await t.test('standard size', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), standardFixture({ badBytes: true }))), /size mismatch/);
  });
  await t.test('DX11 hash', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), dx11Fixture({ badHash: true }))), /hash mismatch/);
  });
  await t.test('ZIP size metadata', async () => {
    const rows = standardFixture(); rows[1].declaredSize = rows[1].data.length + 1;
    await assert.rejects(readOtaPackage(zip(tempZip(), rows)), /size|invalid/i);
  });
});

test('rejects missing or ambiguous component roles without cross-package fallback', async t => {
  await t.test('DX11 carrier missing', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), dx11Fixture({ noCarrier: true }))), /matched DX11 carrier/);
  });
  await t.test('DX11 nrchain missing', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), dx11Fixture({ noBridge: true }))), /nrchain_nvngx/);
  });
  await t.test('DX11 multiple cores', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), dx11Fixture({ extraCore: true }))), /ambiguous addon64 role/);
  });
  await t.test('DX12 carrier is never accepted as its core', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), standardFixture({ carrier: true }))), /addon64/);
  });
});

test('rejects duplicate paths, case collisions, duplicate records and unlisted payloads', async t => {
  await t.test('exact duplicate ZIP path', async () => {
    const rows = standardFixture(); rows.push({ ...rows[1] });
    await assert.rejects(readOtaPackage(zip(tempZip(), rows)), /duplicate zip path/);
  });
  await t.test('case-colliding ZIP path', async () => {
    const rows = standardFixture(); rows.push({ name: BRIDGE.toUpperCase(), data: 'collision' });
    await assert.rejects(readOtaPackage(zip(tempZip(), rows)), /duplicate zip path/);
  });
  await t.test('file and directory alias', async () => {
    const rows = standardFixture(); rows.push({ name: 'core.addon64/', data: '' });
    await assert.rejects(readOtaPackage(zip(tempZip(), rows)), /duplicate zip path/);
  });
  await t.test('case-colliding manifest record', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), standardFixture({ duplicateRow: true }))), /duplicate OTA file record/);
  });
  await t.test('unlisted payload', async () => {
    await assert.rejects(readOtaPackage(zip(tempZip(), standardFixture({ unlisted: true }))), /unlisted OTA file/);
  });
});
