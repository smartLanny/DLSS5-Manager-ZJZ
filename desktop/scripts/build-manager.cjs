'use strict';

// Build the Electron application from an external, verified staging manifest.
// `base` excludes the two large NR runtime DLLs; `offline` includes exactly
// one RTX40-family and one RTX50-family runtime from that same manifest.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { stageDistribution } = require('./stage-manager-distribution.cjs');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const DEFAULT_MANIFEST = process.env.DLSS5_MANAGER_STAGING || path.resolve(APP_ROOT, '..', 'manager-distribution-staging.json');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
const STATIC_RESOURCE_FILES = [
  ['src/product/nvapi-drs.ps1', 'nvapi-drs.ps1'],
  ['src/product/nvapi-profile.ps1', 'nvapi-profile.ps1'],
  ['src/product/windows-registry-values.ps1', 'windows-registry-values.ps1'],
  ['src/product/launcher-locations.ps1', 'launcher-locations.ps1'],
  ['src/product/game-launch-broker.ps1', 'game-launch-broker.ps1']
];

function fail(message) { throw new Error(message); }

function parseArgs(args) {
  const result = { flavor: 'base', manifestFile: DEFAULT_MANIFEST, portableOnly: false, outputRoot: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--flavor' && args[i + 1]) result.flavor = args[++i];
    else if (args[i] === '--manifest' && args[i + 1]) result.manifestFile = args[++i];
    else if (args[i] === '--out' && args[i + 1]) result.outputRoot = args[++i];
    else if (args[i] === '--portable') result.portableOnly = true;
    else if (args[i] === '--dry-run') result.dryRun = true;
    else throw new Error('用法：node scripts/build-manager.cjs [--flavor base|offline] [--manifest <json>] [--out <repo外目录>] [--portable] [--dry-run]');
  }
  if (!['base', 'offline'].includes(result.flavor)) throw new Error(`未知打包 flavor：${result.flavor}`);
  result.manifestFile = path.resolve(result.manifestFile);
  return result;
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

function ensureExistingRows(rows) {
  for (const [source, target] of rows) {
    if (!fs.existsSync(path.join(APP_ROOT, source))) fail(`打包辅助文件缺失：${source}`);
    if (!target) fail(`打包辅助文件目标为空：${source}`);
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
  ensureExistingRows(STATIC_RESOURCE_FILES);
  return STATIC_RESOURCE_FILES.map(([from, to]) => ({ from, to }));
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

function buildConfig({ stageRoot, flavor, outputRoot, portableOnly }) {
  const config = structuredClone(PACKAGE.build || {});
  config.directories = { ...(config.directories || {}), output: outputRoot };
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
  config.win = { ...(config.win || {}), target: portableOnly ? ['portable'] : ['nsis', 'portable'] };
  config.portable = { ...(config.portable || {}), artifactName: `DLSS5-Manager-${PACKAGE.version}-${flavor}-portable.exe` };
  config.nsis = { ...(config.nsis || {}), artifactName: `DLSS5-Manager-${PACKAGE.version}-${flavor}-Setup.exe` };
  config.publish = null;
  return config;
}

async function buildManager(options = {}) {
  const flavor = options.flavor || 'base';
  const outputRoot = path.resolve(options.outputRoot || path.join(APP_ROOT, '..', 'deliveries', `DLSS5-Manager-${PACKAGE.version}-${flavor}`));
  assertOutsideRepo(outputRoot);
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
  runSharedContractBuild();
  const stageRoot = path.join(APP_ROOT, '.packaging-stage', flavor);
  const stage = await stageDistribution({ manifestFile: options.manifestFile || DEFAULT_MANIFEST, flavor, outputRoot: stageRoot });
  const config = buildConfig({ stageRoot, flavor, outputRoot, portableOnly: options.portableOnly === true });
  const summary = { packageVersion: PACKAGE.version, flavor, stage, outputRoot, portableOnly: options.portableOnly === true };
  if (flavor === 'offline') summary.runtimePackage = await createOfflineRuntimeZip(stageRoot, outputRoot);
  if (options.dryRun) return summary;
  runIconBuild();
  let build;
  try { ({ build } = require('electron-builder')); }
  catch (error) { fail(`缺少 electron-builder；请先在 desktop 执行 npm install。${error.message}`); }
  const artifacts = await build({ projectDir: APP_ROOT, config });
  summary.artifacts = artifacts;
  fs.writeFileSync(path.join(outputRoot, 'packaging-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

if (require.main === module) {
  buildManager(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)); process.exitCode = 1; });
}

module.exports = { buildManager, buildConfig, parseArgs, STATIC_RESOURCE_FILES, runSharedContractBuild };
