'use strict';

// Add the reviewed 0.4.6 Chinese build to an already verified hotfix.3 payload.
// Historical slots stay byte-for-byte intact so existing choices can roll back.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const { sha256, inspectPayload, createCompactBundle } = require('../src/product/payload');
const ROOT = path.resolve(__dirname, '..', 'payload', 'nr-before-sr');
const SOURCE = '9087a9efbc7bb53a3c79e7766a174534f49c412c';
const FILES = {
  'nr-before-sr.zh-CN.addon64': ['DLSS5-AI渲染超分版-beta0.4.6-@野生的装机宅-Bilibili.addon64', 'b68f2709a131c9ce0513b6366dbcc2e7d551bef5bcd41934075407378a48c090'],
  'nrchain_nvngx.dll': ['nrchain_nvngx.dll', '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb'],
  'dlss5-native-carrier-045-dx11-compat.addon64': ['dlss5-native-carrier-045-dx11-compat.addon64', '8268ba3a9d7614ca0e0efad22f7c477780547224dfd0847a1d67188fc05f13c0'],
  'nr_before_sr.ini': [null, 'cae9227a1d891321194fc7bb7d7e19c43031578349c82d53e9a316fa36118df8']
};
const ENTRY = {
  id: '0.4.6', label: '0.4.6（最新）', source: `beta0.4.6@${SOURCE}`,
  compatibility: 'dx11', ota: true,
  notes: '中文核心 0.4.6，修复 RR/SR 切换阻断并改进光照保护与反馈。DX12 使用核心和 nrchain；仅已确认 DX11 且兼容桥接开启时部署配套 carrier。保留现有 INI；不支持 Vulkan、无普通 DLSS 或 x86。新版本游戏效果仍待实测。'
};

function verifyVersion(dir, files = FILES) {
  for (const [name, [, hash]] of Object.entries(files)) assert.equal(sha256(path.join(dir, name)), hash, `reviewed 0.4.6 ${name}`);
}

function prepare(otaDir, config, profile = { ENTRY, FILES, SOURCE, peVersion: '0.4.6.0' }) {
  const { ENTRY, FILES, SOURCE, peVersion } = profile;
  const old = inspectPayload(ROOT);
  assert.equal(old.bundle.version, 4);
  for (const item of Object.values(old.versions)) assert.equal(item.ready, true, 'existing payload must be intact');
  const info = JSON.parse(fs.readFileSync(path.join(otaDir, 'build-info.json'), 'utf8'));
  assert.equal(info.source_commit, SOURCE); assert.equal(info.packaging_commit, SOURCE);
  assert.equal(info.core_pe_version, peVersion); assert.equal(info.language, 'zh-CN');
  const inputs = Object.entries(FILES).map(([name, [source, hash]]) => ({ name, file: source ? path.join(otaDir, source) : config, hash }));
  for (const row of inputs) assert.equal(sha256(row.file), row.hash, `input ${row.name}`);
  const target = path.join(ROOT, 'versions', ENTRY.id);
  // Never overwrite an unknown candidate or a directory redirect.
  for (const dir of [ROOT, path.join(ROOT, 'versions'), target]) {
    if (fs.existsSync(dir)) assert.equal(fs.lstatSync(dir).isSymbolicLink(), false, dir);
  }
  if (fs.existsSync(target)) verifyVersion(target, FILES);
  fs.mkdirSync(target, { recursive: true });
  for (const row of inputs) fs.copyFileSync(row.file, path.join(target, row.name));
  verifyVersion(target, FILES);
  const entries = Object.entries(old.bundle.versions).filter(([id]) => id !== ENTRY.id).map(([id, entry]) => ({ ...entry, id }));
  for (const entry of entries) entry.label = entry.label.replace('（最新）', '');
  for (const entry of entries) if (entry.id === '0.3.3.5') {
    entry.label = '0.3.3.5（历史稳定版）'; entry.notes = '保留的历史核心，用于兼容性对比与回退。';
  }
  const bundle = createCompactBundle(ROOT, [...entries, ENTRY], ENTRY.id);
  fs.writeFileSync(path.join(ROOT, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  console.log(JSON.stringify({ sourceCommit: SOURCE, defaultVersion: bundle.defaultVersion, bundleSha256: sha256(path.join(ROOT, 'bundle.json')) }));
}

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/prepare-release-046.js <reviewed OTA directory> <reviewed INI>');
  prepare(path.resolve(process.argv[2]), path.resolve(process.argv[3]));
}
module.exports = { ENTRY, FILES, SOURCE, verifyVersion, prepare };
