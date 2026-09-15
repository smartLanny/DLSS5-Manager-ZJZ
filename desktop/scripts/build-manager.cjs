'use strict';

// Build the Electron application from an external, verified staging manifest.
// `base` excludes the two large NR runtime DLLs; `offline` includes exactly
// one RTX40-family and one RTX50-family runtime from that same manifest.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { stageDistribution } = require('./stage-manager-distribution.cjs');
const { resourceCopies, STATIC_RESOURCE_FILES, LEGACY_FG_RESOURCE_FILES, ALL_STATIC_RESOURCE_FILES } = require('./static-resources.cjs');
const { verifyDistributionPolicy } = require('./verify-distribution-policy.js');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const DEFAULT_MANIFEST = process.env.DLSS5_MANAGER_STAGING || path.resolve(APP_ROOT, '..', 'manager-distribution-staging.json');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
function fail(message) { throw new Error(message); }

function parseArgs(args) {
  const result = { flavor: 'base', manifestFile: DEFAULT_MANIFEST, portableOnly: false, unpackedZip: false, outputRoot: null, workRoot: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--flavor' && args[i + 1]) result.flavor = args[++i];
    else if (args[i] === '--manifest' && args[i + 1]) result.manifestFile = args[++i];
    else if (args[i] === '--out' && args[i + 1]) result.outputRoot = args[++i];
    else if (args[i] === '--work-root' && args[i + 1]) result.workRoot = args[++i];
    else if (args[i] === '--portable') result.portableOnly = true;
    else if (args[i] === '--unpacked-zip') result.unpackedZip = true;
    else if (args[i] === '--dry-run') result.dryRun = true;
    else throw new Error('用法：node scripts/build-manager.cjs [--flavor base|offline] [--manifest <json>] [--work-root <外部工作目录>] [--out <交付目录>] [--portable|--unpacked-zip] [--dry-run]');
  }
  if (!['base', 'offline'].includes(result.flavor)) throw new Error(`未知打包 flavor：${result.flavor}`);
  if (result.portableOnly && result.unpackedZip) throw new Error('--portable 与 --unpacked-zip 不能同时使用。');
  result.manifestFile = path.resolve(result.manifestFile);
  return result;
}

function strictChild(root, target, label) {
  const resolvedRoot = path.resolve(root), resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (resolvedRoot === path.parse(resolvedRoot).root || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} 必须严格位于 Manager 工作目录内：${resolvedTarget}`);
  }
  return resolvedTarget;
}

function resolveBuildRoots(options = {}) {
  const flavor = options.flavor || 'base';
  if (options.workRoot) {
    const workRoot = path.resolve(options.workRoot);
    const stageRoot = strictChild(workRoot, path.join(workRoot, 'stage', flavor), 'stage 目录');
    const outputRoot = strictChild(workRoot, options.outputRoot || path.join(workRoot, 'deliveries', `DLSS5-Manager-${PACKAGE.version}-${flavor}`), '交付目录');
    return { workRoot, stageRoot, outputRoot };
  }
  const outputRoot = path.resolve(options.outputRoot || path.join(APP_ROOT, '..', 'deliveries', `DLSS5-Manager-${PACKAGE.version}-${flavor}`));
  assertOutsideRepo(outputRoot);
  return { workRoot: path.join(APP_ROOT, '.packaging-stage'), stageRoot: path.join(APP_ROOT, '.packaging-stage', flavor), outputRoot };
}

function assertOutsideRepo(directory) {
  const relative = path.relative(APP_ROOT, path.resolve(directory));
  if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    fail(`交付目录必须位于仓库外：${directory}`);
  }
  const deliveries = path.resolve(APP_ROOT, '..', 'deliveries');
  const underDeliveries = path.relative(deliveries, path.resolve(directory));
  if (underDeliveries === '..' || underDeliveries.startsWith(`..${path.sep}`) || path.isAbsolute(underDeliveries)) {
    fail(`交付目录必须位于仓库旁的 deliveries 下：${directory}`);
  }
}

function runIconBuild() {
  const electron = path.join(APP_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const result = spawnSync(electron, ['scripts/build-icon.js'], { cwd: APP_ROOT, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) fail(`图标构建失败；请先在 desktop 执行 npm install。${result.error ? ` ${result.error.message}` : ''}`);
}

function runSharedContractBuild() {
  const script = path.join(REPO_ROOT, 'scripts', 'build-desktop-contract.mjs');
  if (!fs.existsSync(script)) fail('缺少共享 CLI/Desktop contract 生成脚本；请从仓库根目录执行 npm ci。');
  const result = spawnSync(process.execPath, [script], {
    cwd: REPO_ROOT, stdio: 'inherit', windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail(`共享 CLI/Desktop contract 生成失败；请先在仓库根目录执行 npm ci。${result.error ? ` ${result.error.message}` : ''}`);
  }
}

function staticResources() {
  return resourceCopies({ root: APP_ROOT });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256'), stream = fs.createReadStream(file);
    stream.on('error', reject); stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function createOfflineRuntimeZip(stageRoot, outputRoot) {
  let path7za;
  try { path7za = require('7zip-bin').path7za; }
  catch (error) { fail(`offline runtime ZIP 需要 7zip-bin：${error.message}`); }
  const fixedRoot = path.join(stageRoot, 'payload', 'nr-before-sr', 'fixed');
  const entries = ['RTX40/nvngx_dlssnr.dll', 'RTX50/nvngx_dlssnr.dll'];
  for (const entry of entries) if (!fs.existsSync(path.join(fixedRoot, entry))) fail(`offline runtime 缺少 ${entry}`);
  const archive = path.join(outputRoot, `DLSS5-Manager-${PACKAGE.version}-nr-runtime-offline.zip`);
  const result = spawnSync(path7za, ['a', '-tzip', archive, ...entries, '-mx=0'], { cwd: fixedRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`offline runtime ZIP 生成失败：${result.stderr || result.error?.message || result.status}`);
  const stat = fs.statSync(archive);
  return { file: archive, bytes: stat.size, sha256: await hashFile(archive), entries };
}

async function createUnpackedZip(outputRoot, flavor) {
  let path7za;
  try { path7za = require('7zip-bin').path7za; }
  catch (error) { fail(`免安装 ZIP 需要 7zip-bin：${error.message}`); }
  const unpacked = path.join(outputRoot, 'win-unpacked');
  if (!fs.existsSync(path.join(unpacked, `${PACKAGE.build.productName}.exe`))) fail('免安装目录缺少 Manager 主程序。');
  const archive = path.join(outputRoot, `DLSS5-Manager-${PACKAGE.version}-${flavor}-unpacked.zip`);
  const result = spawnSync(path7za, ['a', '-tzip', archive, '.', '-mx=1'], { cwd:unpacked, encoding:'utf8', windowsHide:true, maxBuffer:8*1024*1024 });
  if (result.error || result.status !== 0) fail(`免安装 ZIP 生成失败：${result.stderr || result.error?.message || result.status}`);
  const stat = fs.statSync(archive);
  return { file:archive, bytes:stat.size, sha256:await hashFile(archive) };
}

function buildConfig({ stageRoot, flavor, outputRoot, portableOnly, unpackedZip = false, electronDist = null }) {
  const config = structuredClone(PACKAGE.build || {});
  config.directories = { ...(config.directories || {}), output: outputRoot };
  if (electronDist) config.electronDist = path.resolve(electronDist);
  // Never inherit the historical all-in-one resource list. The staged tree is
  // the allow-list for this build; optional small components only arrive through
  // the explicit external manifest and large NR runtime stays split out.
  config.extraResources = [
    { from: path.join(stageRoot, 'payload'), to: 'payload' },
    { from: path.join(stageRoot, 'resources', 'fg-mfgunlock'), to: 'fg-mfgunlock' },
    { from: path.join(stageRoot, 'resources', 'components'), to: 'components' },
    { from: path.join(stageRoot, 'resources', 'bridge-dlc'), to: 'bridge-dlc' },
    { from: path.join(stageRoot, 'resources', 'hoyoshade'), to: 'hoyoshade' },
    { from: path.join(stageRoot, 'resources', 'loading-helper'), to: 'loading-helper' },
    { from: path.join(stageRoot, 'resources', 'reframework-01417'), to: 'reframework-01417' },
    { from: path.join(stageRoot, 'resources', 'vulkan-reshade'), to: 'vulkan-reshade' },
    ...staticResources()
  ];
  config.extraFiles = PACKAGE.build?.extraFiles || [];
  config.win = { ...(config.win || {}), target: unpackedZip ? ['dir'] : portableOnly ? ['portable'] : ['nsis', 'portable'] };
  if (unpackedZip) config.win.signAndEditExecutable = false;
  config.portable = { ...(config.portable || {}), artifactName: `DLSS5-Manager-${PACKAGE.version}-${flavor}-portable.exe` };
  config.nsis = { ...(config.nsis || {}), artifactName: `DLSS5-Manager-${PACKAGE.version}-${flavor}-Setup.exe` };
  config.publish = null;
  return config;
}

function explicitTargets(options = {}) {
  if (options.unpackedZip !== true) return undefined;
  const { Platform, Arch } = require('electron-builder');
  return Platform.WINDOWS.createTarget('dir', Arch.x64);
}

async function buildManager(options = {}) {
  const flavor = options.flavor || 'base';
  const roots = resolveBuildRoots(options), outputRoot = roots.outputRoot;
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
    if (fs.existsSync(outputRoot)) fail(`交付目录已存在，拒绝覆盖：${outputRoot}`);
  }
  runSharedContractBuild();
  const stageRoot = roots.stageRoot;
  const stage = await stageDistribution({ manifestFile: options.manifestFile || DEFAULT_MANIFEST, flavor, outputRoot: stageRoot, allowedRoot: roots.workRoot });
  const config = buildConfig({ stageRoot, flavor, outputRoot, portableOnly: options.portableOnly === true, unpackedZip:options.unpackedZip === true,
    electronDist: options.electronDist || process.env.ELECTRON_OVERRIDE_DIST_PATH || null });
  const summary = { packageVersion: PACKAGE.version, flavor, stage, outputRoot, portableOnly: options.portableOnly === true, unpackedZip:options.unpackedZip === true };
  if (dryRun) {
    if (flavor === 'offline') summary.runtimePackage = { dryRun: true, entries: ['RTX40/nvngx_dlssnr.dll', 'RTX50/nvngx_dlssnr.dll'] };
    return summary;
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const buildConfigPath = path.join(outputRoot, 'build-config.json');
  fs.writeFileSync(buildConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  summary.buildConfig = { path: buildConfigPath, sha256: await hashFile(buildConfigPath) };
  if (flavor === 'offline') summary.runtimePackage = await createOfflineRuntimeZip(stageRoot, outputRoot);
  runIconBuild();
  const distributionPolicy = await verifyDistributionPolicy(APP_ROOT, { buildConfig: config });
  if (!distributionPolicy?.ok) fail('分发策略校验失败：' + JSON.stringify(distributionPolicy));
  summary.distributionPolicy = distributionPolicy;
  let build;
  try { ({ build } = require('electron-builder')); }
  catch (error) { fail(`缺少 electron-builder；请先在 desktop 执行 npm install。${error.message}`); }
  const artifacts = await build({ projectDir: APP_ROOT, config, ...(options.unpackedZip === true ? { targets:explicitTargets(options) } : {}) });
  summary.artifacts = artifacts;
  if (options.unpackedZip === true) summary.unpackedBundle = await createUnpackedZip(outputRoot, flavor);
  fs.writeFileSync(path.join(outputRoot, 'packaging-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

if (require.main === module) {
  buildManager(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)); process.exitCode = 1; });
}

module.exports = { buildManager, buildConfig, parseArgs, resolveBuildRoots, createUnpackedZip, explicitTargets, staticResources, STATIC_RESOURCE_FILES, LEGACY_FG_RESOURCE_FILES, ALL_STATIC_RESOURCE_FILES, runSharedContractBuild };
