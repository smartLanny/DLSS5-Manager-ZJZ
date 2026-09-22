'use strict';

// Import existing, byte-pinned historical artifacts into a new external catalog.
// This does not build Core, broaden its routes, or replace the current default.
const fs = require('node:fs');
const path = require('node:path');
const { getBitness, getFileVersion } = require('../src/core/pe');
const { TARGETS, readZipEntries, readConfigBlob, sha256 } = require('./prepare-beta7-core-catalog');
const { readBundle } = require('../src/product/payload');

const CHAIN = '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb';
const HISTORY = Object.freeze({
  '0.3.7': Object.freeze({
    sourceCommit: '41288a8a30f812361b0af09d827249be70adc512', corePeVersion: '0.3.7.0',
    files: Object.freeze({ 'nr-before-sr.zh-CN.addon64': '050f2004bf63969f32f7ab543bc79386a47e5e5122499d415231b1498d77b68a',
      'nrchain_nvngx.dll': CHAIN, 'nr_before_sr.ini': '2852e4ac2fbea814a2f9a54b5e323a591ffddbb3429271a6f99083a6380f3427' })
  }),
  '0.5-dline13': Object.freeze({
    sourceCommit: '7abd23569d0a64691caa8cd9adcff3596d6a04a9', corePeVersion: '0.5.1.13',
    zipSha256: 'e19378fae4e786a676bf79cd14aa6bc51226efb9763e3a63d975425b30740e6f',
    files: Object.freeze({ 'nr-before-sr.zh-CN.addon64': '3f67cc32536482dd51857df71bc8294f4af3d4e5974c453ca45a94fb9280e296',
      'nrchain_nvngx.dll': CHAIN, 'nr_before_sr.ini': 'e53c9aab059f5b31d83937206b04ae618cc4308b9d9189e45c21b21f5f164923' })
  })
});
function fail(message) { throw new Error(message); }
function checkedBytes(file, expected) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`历史来源不是普通文件：${file}`);
  const data = fs.readFileSync(file);
  if (sha256(data) !== String(expected).toLowerCase()) fail(`历史来源哈希不符：${file}`);
  return data;
}
function assertHistoricalEntry(id, entry) {
  const pinned = HISTORY[id];
  if (!pinned) return;
  if (!entry || entry.sourceCommit !== pinned.sourceCommit || entry.corePeVersion !== pinned.corePeVersion ||
      entry.compatibility !== null || entry.supportsPresent !== false || entry.coreUpdateOnly !== false ||
      entry.comparisonOnly !== false || entry.validation !== 'historical-artifact' ||
      !Array.isArray(entry.inputInterfaces) || entry.inputInterfaces.length ||
      !Array.isArray(entry.capabilities) || entry.capabilities.length ||
      JSON.stringify(Object.entries(entry.files || {}).sort()) !== JSON.stringify(Object.entries(pinned.files).sort())) {
    fail(`历史 Core 身份或能力声明不符：${id}`);
  }
}
async function readHistoricalInputs({ source037, d13Zip, repoPath }) {
  const old = HISTORY['0.3.7'], d13 = HISTORY['0.5-dline13'];
  const manifest = JSON.parse(checkedBytes(path.join(source037, 'manifest.json'),
    '5b9520c18f6f13b9a6f57f3e8de70da359a146d33f9671bdcefce9f256cb175f').toString('utf8'));
  if (manifest.build !== 'beta0.3.7' || manifest.payloadSourceCommit !== old.sourceCommit || manifest.nativeD3D12 !== true) fail('0.3.7 安装清单身份不符。');
  const bytes037 = {};
  for (const [name, hash] of Object.entries(old.files)) {
    const sourceName = name === 'nr-before-sr.zh-CN.addon64' ? 'DLSS5-AI渲染超分版-beta0.3.7-@野生的装机宅-Bilibili.addon64' : name;
    const row = manifest.files.find(file => file.path === sourceName);
    if (!row || row.sha256.toLowerCase() !== hash) fail(`0.3.7 清单文件不符：${name}`);
    bytes037[name] = checkedBytes(path.join(source037, sourceName), hash);
    if (row.bytes !== bytes037[name].length) fail(`0.3.7 文件大小不符：${name}`);
  }
  checkedBytes(d13Zip, d13.zipSha256);
  const zip = await readZipEntries(d13Zip), raw = zip.get('SHA256.json');
  if (!raw || sha256(raw) !== '44ec0144550a216da730e0fec1be2cbc2d2beb972ba21e2ea6f66b0e252abc12') fail('D13 覆盖包 SHA256 清单不符。');
  const info = JSON.parse(raw.toString('utf8'));
  if (info.source_commit !== d13.sourceCommit || info.core_pe_version !== d13.corePeVersion ||
      info.version !== 'beta0.5-dline13' || info.variant !== 'D13-ordinary-baseline' || info.NR_DESCRIPTOR_PROFILE !== 0) fail('D13 覆盖包身份不符。');
  if (zip.size !== Object.keys(info.files).length + 1) fail('D13 覆盖包文件集合不符。');
  for (const [name, row] of Object.entries(info.files)) {
    const data = zip.get(name);
    if (!data || data.length !== row.bytes || sha256(data) !== row.sha256) fail(`D13 覆盖包文件不符：${name}`);
  }
  const config = readConfigBlob(repoPath, TARGETS.find(row => row.id === '0.5-dline13'));
  const bytesD13 = { 'nr-before-sr.zh-CN.addon64': zip.get('nr-before-sr.zh-CN.addon64'),
    'nrchain_nvngx.dll': zip.get('nrchain_nvngx.dll'), 'nr_before_sr.ini': config.bytes };
  for (const [name, hash] of Object.entries(d13.files)) if (sha256(bytesD13[name]) !== hash) fail(`D13 核心/配置身份不符：${name}`);
  return { '0.3.7': bytes037, '0.5-dline13': bytesD13, notices: zip.get('LICENSES.txt') };
}
function historicEntry(id) {
  const pinned = HISTORY[id], d13 = id === '0.5-dline13';
  return { label: d13 ? '0.5 D13 · 双层版（测试）' : '0.3.7 · 历史版',
    notes: d13 ? '原始 D13 双层 Core 与本版首装配置；仅原生 D3D12 历史对照。未补入后续 Bridge/Feeder 修复，具体游戏需实测。' :
      '原始 beta0.3.7 中文 Core 与 ConfigVersion=3 配置；仅原生 D3D12 历史对照，不包含后续 Bridge/Feeder 支持。',
    source: `${pinned.sourceCommit}${d13 ? ` / overlay ${pinned.zipSha256}` : ' / original beta0.3.7 installer manifest'}`,
    sourceCommit: pinned.sourceCommit, corePeVersion: pinned.corePeVersion,
    configContract: d13 ? 'nr-dline13' : 'nr-037', compatibility: null,
    supportsPresent: false, inputInterfaces: [], capabilities: [], coreUpdateOnly: false, comparisonOnly: false,
    ota: false, validation: 'historical-artifact', stableRelease: false, files: { ...pinned.files } };
}
async function prepareHistoricalCatalog({ baseRoot, outputRoot, source037, d13Zip, repoPath }) {
  baseRoot = path.resolve(baseRoot); outputRoot = path.resolve(outputRoot);
  if (fs.existsSync(outputRoot)) fail('输出目录已存在，拒绝覆盖。');
  const relative = path.relative(baseRoot, outputRoot);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) fail('输出必须位于来源目录之外。');
  const bundle = readBundle(baseRoot);
  if (bundle.version !== 4 || bundle.defaultVersion !== '0.4.7beta') fail('需要默认 0.4.7beta 的 v4 目录。');
  const inputs = await readHistoricalInputs({ source037, d13Zip, repoPath });
  const copies = [];
  for (const [family, entry] of Object.entries(bundle.fixed)) for (const [name, hash] of Object.entries(entry.files)) {
    const source = path.join(baseRoot, 'fixed', family, name);
    // The staging manifest owns the separate NR-runtime source, as in the base catalog.
    if (name === 'nvngx_dlssnr.dll' && !fs.existsSync(source)) continue;
    copies.push([`fixed/${family}/${name}`, checkedBytes(source, hash)]);
  }
  for (const [id, entry] of Object.entries(bundle.versions)) {
    if (HISTORY[id]) fail(`来源已有历史版本槽位，拒绝覆盖：${id}`);
    for (const [name, hash] of Object.entries({ ...entry.files, ...entry.companions })) copies.push([`versions/${id}/${name}`, checkedBytes(path.join(baseRoot, 'versions', id, name), hash)]);
  }
  for (const id of Object.keys(HISTORY)) {
    bundle.versions[id] = historicEntry(id);
    assertHistoricalEntry(id, bundle.versions[id]);
    for (const [name, data] of Object.entries(inputs[id])) copies.push([`versions/${id}/${name}`, data]);
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  for (const [relativePath, data] of copies) {
    const destination = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { flag: 'wx' });
  }
  for (const [id, pinned] of Object.entries(HISTORY)) {
    const addon = path.join(outputRoot, 'versions', id, 'nr-before-sr.zh-CN.addon64');
    if (getBitness(addon) !== 64 || getFileVersion(addon) !== pinned.corePeVersion) fail(`历史 Core PE 身份不符：${id}`);
  }
  fs.mkdirSync(path.join(outputRoot, 'notices'), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'notices', 'D13-LICENSES.txt'), inputs.notices, { flag: 'wx' });
  fs.writeFileSync(path.join(outputRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx' });
  return { outputRoot, defaultVersion: bundle.defaultVersion, versions: Object.keys(bundle.versions), added: Object.keys(HISTORY), files: copies.length };
}
if (require.main === module) {
  const [baseRoot, outputRoot, source037, d13Zip, repoPath] = process.argv.slice(2);
  if (![baseRoot, outputRoot, source037, d13Zip, repoPath].every(Boolean)) throw new Error('需要 baseRoot outputRoot source037 d13Zip repoPath 五个路径。');
  prepareHistoricalCatalog({ baseRoot, outputRoot, source037, d13Zip, repoPath }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { HISTORY, assertHistoricalEntry, readHistoricalInputs, historicEntry, prepareHistoricalCatalog };
