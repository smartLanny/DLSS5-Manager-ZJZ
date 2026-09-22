'use strict';

// Build the exact Manager 0.5.0-beta.2 test catalog in a new external
// directory. Missing historical binaries remain explicit metadata; they are
// never substituted with a nearby version.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { getBitness, getFileVersion } = require('../src/core/pe');
const { readOtaPackage } = require('../src/product/ota');
const release042 = require('./prepare-release-042');

const HASH = /^[a-f0-9]{64}$/i;
const FILES047 = Object.freeze({
  'nr-before-sr.zh-CN.addon64': '93011d9283615ea9dc8e92955f5ca6aeff01435925f63e941dc1eea1128a372c',
  'nrchain_nvngx.dll': '46041a5ff91ae2fd907e310d132aabc3c4a1ecd48dace511b8672909d5d9c2fb',
  'dlss5-native-carrier-045-dx11-compat.addon64': '4656d9aac382a6f9b5c8488669aa5365283f03b5b94b2267f1c7f9b53927dc86',
  'nr_before_sr.ini': '7ed62ef6f3f565a00e9cb6a92195e7c1bfaa3714f6f4fc28dfcbd1644a41ff80'
});
const MISSING = Object.freeze({
  '0.3.3-dev-r4': {
    label: '0.3.3.4（等待精确原包）', bytes: 652288,
    sha256: '2869d7d6b2d184b4200c3eb7ac671db0299be64e7625c4f816ee26b41890bfb9', substitute: false
  },
  '0.4.7-corefix8': {
    label: '0.4.7 Corefix8（等待精确原包）', bytes: 3241472,
    sha256: '504bb48b1137b02a9ab126fe10337f0331a93684c413f411f4fea4fa47eb1b8d', peVersion: '0.4.7.13', substitute: false
  }
});
// The original D21 archive is an update-only OTA. Once it is assembled into
// the Manager catalog with the verified shared ReShade/runtime/config set it
// becomes a complete, explicitly selectable candidate. It is still never the
// default or a stable release.
const D21_POLICY = Object.freeze({ coreUpdateOnly: false, comparisonOnly: false,
  validation: 'candidate', stableRelease: false });

function fail(message) { throw new Error(message); }
function plainFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} 不存在：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} 必须是普通文件：${file}`);
  return stat;
}
async function digest(file) {
  plainFile(file, '待校验文件');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'), stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
function safeName(name) {
  if (path.basename(name) !== name || !['ReShade64.dll', 'nvngx_dlssnr.dll', 'nrchain_nvngx.dll',
    'nr-before-sr.zh-CN.addon64', 'dlss5-native-carrier-045-dx11-compat.addon64', 'nr_before_sr.ini'].includes(name)) fail(`不支持的载荷文件：${name}`);
  return name;
}
async function copyVerified(source, target, expected) {
  if (!HASH.test(String(expected || '')) || await digest(source) !== expected.toLowerCase()) fail(`来源哈希不符：${source}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  if (await digest(target) !== expected.toLowerCase()) fail(`复制后哈希不符：${target}`);
}
function readBundle(root) {
  const file = path.join(root, 'bundle.json'); plainFile(file, '基础 bundle.json');
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (bundle.version !== 4 || !bundle.fixed?.RTX40?.files || !bundle.fixed?.RTX50?.files || !bundle.versions) fail('基础载荷不是 v4 bundle。');
  return bundle;
}
function resolveFixedSource(baseRoot, family, name, runtimes = {}) {
  const bundled = path.join(baseRoot, 'fixed', family, name);
  if (fs.existsSync(bundled)) return bundled;
  if (name === 'nvngx_dlssnr.dll' && runtimes[family]) return path.resolve(runtimes[family]);
  if (name === 'nvngx_dlssnr.dll') fail(`基础载荷未内置 ${family} NR 运行库；请显式提供 --runtime${family === 'RTX40' ? '40' : '50'}。`);
  return bundled;
}
async function copyBase(baseRoot, targetRoot, runtimes) {
  const source = readBundle(baseRoot), version = '0.2.0-beta.2', entry = source.versions[version];
  if (!entry?.files) fail('基础载荷缺少 0.2.0-beta.2。');
  const fixed = {};
  for (const family of ['RTX40', 'RTX50']) {
    fixed[family] = { files: {} };
    for (const [name, expected] of Object.entries(source.fixed[family].files)) {
      safeName(name); await copyVerified(resolveFixedSource(baseRoot, family, name, runtimes), path.join(targetRoot, 'fixed', family, name), expected);
      fixed[family].files[name] = expected.toLowerCase();
    }
  }
  const files = {};
  for (const [name, expected] of Object.entries(entry.files)) {
    safeName(name); await copyVerified(path.join(baseRoot, 'versions', version, name), path.join(targetRoot, 'versions', version, name), expected);
    files[name] = expected.toLowerCase();
  }
  const bundle = { version: 4, generatedAt: new Date().toISOString(), defaultVersion: version, fixed,
    versions: { [version]: { ...structuredClone(entry), files } }, unavailableVersions: structuredClone(MISSING) };
  await fsp.writeFile(path.join(targetRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, { encoding:'utf8', flag:'wx' });
  const readme = path.join(baseRoot, 'README.md');
  if (fs.existsSync(readme)) await fsp.copyFile(readme, path.join(targetRoot, 'README.md'), fs.constants.COPYFILE_EXCL);
}
async function add047(sourceRoot, targetRoot, bridgeFile) {
  const sources = {
    'nr-before-sr.zh-CN.addon64': path.join(sourceRoot, 'DLSS5-AI渲染超分版-0.4.7beta-@野生的装机宅-Bilibili.addon64'),
    'nrchain_nvngx.dll': path.join(sourceRoot, 'nrchain_nvngx.dll'),
    'dlss5-native-carrier-045-dx11-compat.addon64': path.resolve(bridgeFile),
    'nr_before_sr.ini': path.join(sourceRoot, 'nr_before_sr.ini')
  };
  for (const [name, source] of Object.entries(sources)) await copyVerified(source, path.join(targetRoot, 'versions', '0.4.7beta', name), FILES047[name]);
  if (getBitness(sources['nr-before-sr.zh-CN.addon64']) !== 64 || getFileVersion(sources['nr-before-sr.zh-CN.addon64']) !== '0.4.7.0') fail('标准 0.4.7 Core 的 PE 身份不符。');
  const bundle = readBundle(targetRoot);
  bundle.versions['0.4.7beta'] = {
    label: '0.4.7beta（标准版 · 默认）',
    notes: '标准 0.4.7 中文 Core；不是 Corefix8。D3D12 原生路线不使用 Bridge；DX11 自动配套固定适配版 DLSS5 Bridge 1.4.12。具体游戏仍需实机验收。',
    source: 'vulkan-provider-047@4ecc6d02ca6058cb1ebb0faae5aa49b34b0614ad (0.4.7 base 6a0ad7684683993328a7a98a9bea83ac76b01a64)',
    compatibility: null, ota: true, supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1', 'NRExternalProviderV1'],
    capabilities: ['same-frame-output', 'external-provider-v1'], files: FILES047
  };
  bundle.defaultVersion = '0.4.7beta';
  await fsp.writeFile(path.join(targetRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
}
async function addD21(sourceZip, targetRoot) {
  const ota = await readOtaPackage(sourceZip), core = ota.canonicalCore;
  if (!core || core.id !== '0.5-dline21') fail('来源不是精确 D21 累计常规版。');
  const dir = path.join(targetRoot, 'versions', core.id); await fsp.mkdir(dir, { recursive:true });
  const addon = path.join(dir, 'nr-before-sr.zh-CN.addon64'), chain = path.join(dir, 'nrchain_nvngx.dll');
  await fsp.writeFile(addon, ota.addon, { flag:'wx' }); await fsp.writeFile(chain, ota.bridge, { flag:'wx' });
  if (await digest(addon) !== ota.addonSha256 || await digest(chain) !== ota.bridgeSha256 || getBitness(addon) !== 64 || getFileVersion(addon) !== '0.5.1.23') fail('D21 解包后的 Core/chain 身份不符。');
  await copyVerified(path.join(targetRoot, 'versions', '0.4.7beta', 'nr_before_sr.ini'), path.join(dir, 'nr_before_sr.ini'), FILES047['nr_before_sr.ini']);
  const bundle = readBundle(targetRoot);
  bundle.versions[core.id] = {
    label: '0.5 D21（累计常规版 · 测试）',
    notes: '可由用户为新游戏直接选择的 D3D12 测试 Core；0.4.7 仍为默认。RTX40 与具体游戏尚待实机验收。',
    source: `beta0.5-dline21-223fix2@${ota.manifest.sourceCommit}; archive ${ota.archiveSha256}`,
    compatibility: null, ota: true, ...D21_POLICY,
    supportsPresent: true, inputInterfaces: [...core.inputInterfaces], capabilities: [...core.capabilities],
    blockers: [...core.blockers],
    files: { 'nr-before-sr.zh-CN.addon64': ota.addonSha256, 'nrchain_nvngx.dll': ota.bridgeSha256,
      'nr_before_sr.ini': FILES047['nr_before_sr.ini'] }
  };
  await fsp.writeFile(path.join(targetRoot, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
}
async function prepare(options) {
  const output = path.resolve(options.output), parent = path.dirname(output);
  if (fs.existsSync(output)) fail(`输出已存在，未覆盖：${output}`);
  await fsp.mkdir(parent, { recursive:true });
  const stage = await fsp.mkdtemp(path.join(parent, `.${path.basename(output)}-`));
  try {
    await copyBase(path.resolve(options.base), stage, options.runtimes);
    await release042.prepare(path.resolve(options.release042), { root:stage });
    await add047(path.resolve(options.release047), stage, options.bridge047);
    await addD21(path.resolve(options.d21), stage);
    const bundle = readBundle(stage);
    if (bundle.defaultVersion !== '0.4.7beta' || Object.keys(bundle.versions).sort().join(',') !== ['0.2.0-beta.2','0.4.2','0.4.7beta','0.5-dline21'].sort().join(',')) fail('最终 Core 目录不符合 beta.2 版本矩阵。');
    await fsp.rename(stage, output);
    return { output, defaultVersion:bundle.defaultVersion, versions:Object.keys(bundle.versions), unavailableVersions:Object.keys(bundle.unavailableVersions) };
  } catch (error) { await fsp.rm(stage, { recursive:true, force:true }); throw error; }
}
function args(argv) {
  const out = {};
  for (let i=2;i<argv.length;i+=2) { if (!/^--(?:base|runtime40|runtime50|042|047|bridge047|d21|output)$/.test(argv[i]) || !argv[i+1]) fail('参数应为 --base/--runtime40/--runtime50/--042/--047/--bridge047/--d21/--output。'); out[argv[i].slice(2)] = argv[i+1]; }
  if (!out.base || !out['042'] || !out['047'] || !out.bridge047 || !out.d21 || !out.output) fail('缺少 beta.2 Core 目录参数。');
  return { base:out.base, runtimes:{ RTX40:out.runtime40, RTX50:out.runtime50 }, release042:out['042'], release047:out['047'], bridge047:out.bridge047, d21:out.d21, output:out.output };
}
if (require.main === module) prepare(args(process.argv)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode=1; });
module.exports = { FILES047, MISSING, D21_POLICY, resolveFixedSource, prepare };
