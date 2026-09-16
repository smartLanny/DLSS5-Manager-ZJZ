'use strict';

// Build directly importable NR runtime DLC packages from the same verified
// external manifest used by the Manager build. No NVIDIA binary is stored in
// the source tree or silently substituted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PACKAGE = require('../package.json');
const FAMILIES = ['RTX40', 'RTX50'];
const HASH = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(message); }

function parseArgs(args) {
  const result = { manifestFile: process.env.DLSS5_MANAGER_STAGING || '', outputRoot: '', workRoot: '' };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--manifest' && args[index + 1]) result.manifestFile = args[++index];
    else if (args[index] === '--out' && args[index + 1]) result.outputRoot = args[++index];
    else if (args[index] === '--work-root' && args[index + 1]) result.workRoot = args[++index];
    else fail('用法：node scripts/build-runtime-dlc.cjs --manifest <json> --work-root <临时目录> --out <交付目录>');
  }
  for (const key of ['manifestFile', 'outputRoot', 'workRoot']) if (!result[key]) fail(`缺少 ${key}。`);
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, path.resolve(value)]));
}

function plainFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label}不存在：${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(`${label}必须是普通文件：${file}`);
  return stat;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'), stream = fs.createReadStream(file);
    stream.on('error', reject); stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readManifest(file) {
  const stat = plainFile(file, '分发清单');
  if (stat.size > 4 * 1024 * 1024) fail('分发清单过大。');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`分发清单 JSON 无效：${error.message}`); }
}

function zipDirectory(path7za, directory, archive, entries = ['.']) {
  const result = spawnSync(path7za, ['a', '-tzip', archive, ...entries, '-mx=0'], {
    cwd: directory, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
  if (result.error || result.status !== 0) fail(`运行库 DLC 压缩失败：${result.stderr || result.error?.message || result.status}`);
}

function componentManifest(family, spec) {
  return {
    schema: 'dlss5-component-v1',
    id: family === 'RTX40' ? 'nr-runtime-rtx20-40-sfv2' : 'nr-runtime-rtx50-sfv2',
    kind: 'nr-runtime',
    version: '310.8.SF-v2',
    variant: family === 'RTX40' ? 'RTX 20/30/40 系' : 'RTX 50 系',
    architecture: 'x64',
    interface: 'NGX-Feature18',
    gameApis: ['dx12'],
    hardwareFamilies: [family],
    validation: 'candidate',
    files: [{ path: 'nvngx_dlssnr.dll', bytes: spec.bytes, sha256: spec.sha256 }]
  };
}

async function verifyRuntime(spec, family) {
  if (!spec || typeof spec.file !== 'string' || !Number.isSafeInteger(spec.bytes) || spec.bytes <= 0 || !HASH.test(spec.sha256 || '')) {
    fail(`${family} 运行库身份不完整。`);
  }
  const source = path.resolve(spec.file), stat = plainFile(source, `${family} 运行库`);
  if (stat.size !== spec.bytes) fail(`${family} 运行库长度不符。`);
  const actual = await sha256(source);
  if (actual !== spec.sha256) fail(`${family} 运行库 SHA-256 不符。`);
  return { ...spec, file: source };
}

async function createRuntimeDlcPackages(options) {
  const manifestFile = path.resolve(options.manifestFile), outputRoot = path.resolve(options.outputRoot), workRoot = path.resolve(options.workRoot);
  if (outputRoot === path.parse(outputRoot).root || workRoot === path.parse(workRoot).root) fail('交付目录和临时目录不能是磁盘根目录。');
  if (fs.existsSync(outputRoot)) fail(`交付目录已存在，拒绝覆盖：${outputRoot}`);
  const manifest = readManifest(manifestFile), runtimes = {};
  for (const family of FAMILIES) runtimes[family] = await verifyRuntime(manifest.runtime?.families?.[family], family);
  let path7za;
  try { path7za = require('7zip-bin').path7za; }
  catch (error) { fail(`运行库 DLC 需要 7zip-bin：${error.message}`); }
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: false });
  const temp = fs.mkdtempSync(path.join(workRoot, 'runtime-dlc-'));
  const relativeTemp = path.relative(workRoot, temp);
  if (!relativeTemp || relativeTemp.startsWith('..') || path.isAbsolute(relativeTemp) || !path.basename(temp).startsWith('runtime-dlc-')) fail('临时目录边界检查失败。');
  const packages = [];
  try {
    for (const family of FAMILIES) {
      const directory = path.join(temp, family); fs.mkdirSync(directory);
      fs.copyFileSync(runtimes[family].file, path.join(directory, 'nvngx_dlssnr.dll'), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(directory, 'component-manifest.json'), `${JSON.stringify(componentManifest(family, runtimes[family]), null, 2)}\n`, 'utf8');
      const archive = path.join(outputRoot, `DLSS5-Manager-${PACKAGE.version}-NR-Runtime-${family}.zip`);
      zipDirectory(path7za, directory, archive);
      packages.push({ family, file: archive, bytes: fs.statSync(archive).size, sha256: await sha256(archive) });
    }
    fs.writeFileSync(path.join(temp, '使用说明.txt'), [
      'DLSS 5 Manager NR Runtime DLC',
      '',
      '此合并包可直接在“组件管理 → 导入组件包”中导入，会同时加入 RTX40 与 RTX50 两套运行库。',
      '管理器只会按目标显卡选择对应版本，不会同时把两套 DLL 写入同一个游戏。',
      '单独的 RTX40/RTX50 ZIP 也可直接导入，无需手动解压。',
      ''
    ].join('\r\n'), 'utf8');
    const combined = path.join(outputRoot, `DLSS5-Manager-${PACKAGE.version}-NR-Runtime-RTX40-RTX50.zip`);
    zipDirectory(path7za, temp, combined, ['RTX40', 'RTX50', '使用说明.txt']);
    packages.push({ family: 'RTX40+RTX50', file: combined, bytes: fs.statSync(combined).size, sha256: await sha256(combined) });
    const report = { packageVersion: PACKAGE.version, manifestFile, packages };
    fs.writeFileSync(path.join(outputRoot, 'runtime-dlc-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  createRuntimeDlcPackages(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exitCode = 1; });
}

module.exports = { parseArgs, componentManifest, createRuntimeDlcPackages };

