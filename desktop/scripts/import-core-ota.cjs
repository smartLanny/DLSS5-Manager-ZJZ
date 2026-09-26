'use strict';

// Turn a delivered Core OTA ZIP into a fresh staging tree for build-manager.
// The ZIP must be registered in src/shared/core-catalog.js: readOtaPackage
// recomputes the archive digest and every member digest before anything is
// written here, and each written file is hashed again after the copy.
//
//   node scripts/import-core-ota.cjs --ota <zh-CN OTA.zip> --staging <current staging.json>
//     --output <new empty directory> [--ini <nr_before_sr.ini>] [--package-version <version>]
//
// The new Core becomes the default when it is the catalog's recommended Core.
// The previous payload is copied unchanged; player INIs are never touched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const catalog = require('../src/shared/core-catalog');
const { readOtaPackage } = require('../src/product/ota');
const { DX11_COMPAT_CARRIER } = require('../src/product/constants');

const CORE_FILE = 'nr-before-sr.zh-CN.addon64';
const CHAIN_FILE = 'nrchain_nvngx.dll';
const INI_FILE = 'nr_before_sr.ini';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new Error(message); }
function plainFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} 不存在：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} 必须是普通文件：${file}`);
  return fs.readFileSync(file);
}
function writeExact(target, bytes, sha256) {
  if (digest(bytes) !== sha256) fail(`写入前摘要不符：${path.basename(target)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  if (digest(fs.readFileSync(target)) !== sha256) fail(`写入后摘要不符：${target}`);
}
const copyExact = (source, target, sha256) => writeExact(target, plainFile(source, '来源文件'), sha256);

// The INI is a starting point only; installs keep a player's existing INI.
function defaultIni({ ini, bundle, priorRoot }) {
  if (ini) { const bytes = plainFile(path.resolve(ini), '默认 INI'); return { bytes, sha256: digest(bytes) }; }
  for (const core of [...catalog.CORES].reverse()) {
    const sha256 = bundle.versions?.[core.id]?.files?.[INI_FILE];
    if (!core.provider || !sha256) continue;
    const bytes = plainFile(path.join(priorRoot, 'versions', core.id, INI_FILE), `${core.id} 默认 INI`);
    if (digest(bytes) !== sha256) fail(`${core.id} 默认 INI 与现有清单不一致。`);
    return { bytes, sha256 };
  }
  fail('OTA 包不含 INI，现有 payload 里也没有可沿用的统一 Core INI；请用 --ini 指定。');
}

async function importCoreOta({ ota, staging, output, ini = null, packageVersion = null, readOta = readOtaPackage }) {
  if (!ota || !staging || !output) fail('用法：--ota <OTA.zip> --staging <staging.json> --output <新目录> [--ini <INI>]');
  output = path.resolve(output);
  if (fs.existsSync(output)) fail('请使用新的空输出目录。');
  const pkg = await readOta(path.resolve(ota));
  const cataloged = catalog.coreForArchive(pkg.archiveSha256);
  if (!cataloged || pkg.canonicalCore?.id !== cataloged.core.id)
    fail('这个 ZIP 未在 src/shared/core-catalog.js 登记，或内容与登记身份不符。');
  const { core } = cataloged;

  const stagingFile = path.resolve(staging), manifest = JSON.parse(fs.readFileSync(stagingFile, 'utf8'));
  const priorRoot = path.resolve(path.dirname(stagingFile), manifest.core?.payloadRoot || '');
  const bundle = JSON.parse(plainFile(path.join(priorRoot, 'bundle.json'), '现有 bundle.json').toString('utf8'));
  if (bundle.version !== 4 || !bundle.versions || !bundle.fixed) fail('现有 Core payload 必须是带 fixed/versions 的 v4 bundle.json。');
  if (Object.hasOwn(bundle.versions, core.id)) fail(`现有 payload 已经包含 ${core.id}；无需重复导入。`);

  const payloadRoot = path.join(output, 'core-catalog');
  // The large NR runtime (DLSS5 model) is staged from runtime.families, not copied here.
  for (const [family, row] of Object.entries(bundle.fixed)) for (const [name, sha256] of Object.entries(row.files || {})) {
    if (name !== 'nvngx_dlssnr.dll') copyExact(path.join(priorRoot, 'fixed', family, name), path.join(payloadRoot, 'fixed', family, name), sha256);
  }
  for (const [id, row] of Object.entries(bundle.versions)) {
    for (const [name, sha256] of Object.entries({ ...row.files, ...row.companions }))
      copyExact(path.join(priorRoot, 'versions', id, name), path.join(payloadRoot, 'versions', id, name), sha256);
  }

  const target = path.join(payloadRoot, 'versions', core.id), config = defaultIni({ ini, bundle, priorRoot });
  writeExact(path.join(target, CORE_FILE), pkg.addon, pkg.addonSha256);
  writeExact(path.join(target, CHAIN_FILE), pkg.bridge, pkg.bridgeSha256);
  writeExact(path.join(target, DX11_COMPAT_CARRIER), pkg.carrier, pkg.carrierSha256);
  writeExact(path.join(target, INI_FILE), config.bytes, config.sha256);
  const companions = {};
  for (const row of pkg.companions) { writeExact(path.join(target, row.name), row.data, row.sha256); companions[row.name] = row.sha256; }
  bundle.versions[core.id] = {
    id: core.id, label: core.menuLabel, displayVersion: core.displayVersion, source: core.sourceCommit,
    configContract: core.configContract, compatibility: 'dx11', supportsPresent: true, inputInterfaces: ['NGX-D3D12-Feature1'],
    capabilities: ['same-frame-output'], validation: 'candidate', stableRelease: false, comparisonOnly: false, coreUpdateOnly: false,
    // Only an explicit per-game choice pairs the external Bridge/Feeder stack.
    externalRoutesAutoEnabled: false, explicitSelectionAutoPairs: core.provider === true, otaArchiveSha256: pkg.archiveSha256,
    files: { [CORE_FILE]: pkg.addonSha256, [CHAIN_FILE]: pkg.bridgeSha256, [DX11_COMPAT_CARRIER]: pkg.carrierSha256, [INI_FILE]: config.sha256 },
    companions
  };
  if (core.id === catalog.RECOMMENDED) bundle.defaultVersion = core.id;
  fs.writeFileSync(path.join(payloadRoot, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx' });

  const noticeRoot = path.join(output, 'core-notices', core.menuKey);
  manifest.resources = (manifest.resources || []).filter(row => !String(row.path).startsWith(`core-notices/${core.menuKey}/`));
  for (const row of pkg.notices || []) {
    const file = path.join(noticeRoot, row.name); writeExact(file, row.data, row.sha256);
    manifest.resources.push({ source: file, path: `core-notices/${core.menuKey}/${row.name}`, bytes: row.data.length, sha256: row.sha256 });
  }
  manifest.core = { ...manifest.core, payloadRoot, version: bundle.defaultVersion,
    versions: [...new Set([...(manifest.core?.versions || []), core.id])] };
  if (packageVersion) manifest.packageVersion = packageVersion;
  fs.writeFileSync(path.join(output, 'staging.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return { output, coreId: core.id, archiveSha256: pkg.archiveSha256, addonSha256: pkg.addonSha256, iniSha256: config.sha256,
    defaultVersion: bundle.defaultVersion, notices: (pkg.notices || []).map(row => row.name) };
}

function parseArgs(argv) {
  const keys = { '--ota': 'ota', '--staging': 'staging', '--output': 'output', '--ini': 'ini', '--package-version': 'packageVersion' }, out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1]) fail(`参数无效：${argv[i]}`);
    out[keys[argv[i]]] = argv[i + 1];
  }
  return out;
}
if (require.main === module) {
  importCoreOta(parseArgs(process.argv.slice(2)))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { importCoreOta };
