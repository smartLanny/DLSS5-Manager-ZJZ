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
const { assertReleaseStage } = require('./release-gate.cjs');
const { verifyExecutable } = require('./verify-execution-level');
const PELibrary = require('pe-library');
const ResEdit = require('resedit');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const DEFAULT_MANIFEST = process.env.DLSS5_MANAGER_STAGING || path.resolve(APP_ROOT, '..', 'manager-distribution-staging.json');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
function fail(message) { throw new Error(message); }

function parseArgs(args) {
  const result = { flavor: 'base', manifestFile: DEFAULT_MANIFEST, portableOnly: false, unpackedZip: false, release: false, outputRoot: null, workRoot: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--flavor' && args[i + 1]) result.flavor = args[++i];
    else if (args[i] === '--manifest' && args[i + 1]) result.manifestFile = args[++i];
    else if (args[i] === '--out' && args[i + 1]) result.outputRoot = args[++i];
    else if (args[i] === '--work-root' && args[i + 1]) result.workRoot = args[++i];
    else if (args[i] === '--portable') result.portableOnly = true;
    else if (args[i] === '--unpacked-zip') result.unpackedZip = true;
    else if (args[i] === '--release') result.release = true;
    else if (args[i] === '--dry-run') result.dryRun = true;
    else throw new Error('用法：node scripts/build-manager.cjs [--flavor base|offline] [--manifest <json>] [--work-root <外部工作目录>] [--out <交付目录>] [--portable|--unpacked-zip] [--release] [--dry-run]');
  }
  if (!['base', 'offline'].includes(result.flavor)) throw new Error(`未知打包 flavor：${result.flavor}`);
  if (result.portableOnly && result.unpackedZip) throw new Error('--portable 与 --unpacked-zip 不能同时使用。');
  if (result.release && (result.flavor !== 'base' || !result.unpackedZip)) throw new Error('正式公开发布只允许 base 目录式 Portable.zip；请同时使用 --flavor base --unpacked-zip。');
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
  const archive = path.join(outputRoot, `DLSS5-Manager-${PACKAGE.version}-Portable.zip`);
  const result = spawnSync(path7za, ['a', '-tzip', archive, '.', '-mx=1'], { cwd:unpacked, encoding:'utf8', windowsHide:true, maxBuffer:8*1024*1024 });
  if (result.error || result.status !== 0) fail(`免安装 ZIP 生成失败：${result.stderr || result.error?.message || result.status}`);
  const stat = fs.statSync(archive);
  return { file:archive, bytes:stat.size, sha256:await hashFile(archive) };
}

function inspectExecutableIcons(executable) {
  const image = PELibrary.NtExecutable.from(fs.readFileSync(executable), { ignoreCert: true });
  const resources = PELibrary.NtExecutableResource.from(image);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const sizes = [...new Set(groups.flatMap(group => group.icons || []).map(icon => icon.width || 256))].sort((a, b) => a - b);
  if (!groups.length || ![16, 32, 48, 256].every(size => sizes.includes(size))) {
    fail(`Manager EXE 图标资源不完整：${sizes.join(', ') || '无'}`);
  }
  const hash = crypto.createHash('sha256');
  for (const entry of resources.entries.filter(entry => entry.type === 3 || entry.type === 14)
    .sort((left, right) => left.type - right.type || String(left.id).localeCompare(String(right.id)) || left.lang - right.lang)) {
    hash.update(`${entry.type}:${entry.id}:${entry.lang}:`);
    hash.update(Buffer.from(entry.bin));
  }
  return { groups: groups.length, sizes, sha256: hash.digest('hex') };
}

async function editUnpackedExecutableResources(outputRoot) {
  const executableName = `${PACKAGE.build.productName}.exe`;
  const executable = path.join(outputRoot, 'win-unpacked', executableName);
  const icon = path.resolve(APP_ROOT, PACKAGE.build?.win?.icon || 'build/icon.ico');
  if (!fs.existsSync(executable)) fail('目录式便携包缺少 Manager 主程序，不能写入图标与版本资源。');
  if (!fs.existsSync(icon)) fail(`缺少 Manager ICO：${icon}`);
  let rcedit;
  try { ({ rcedit } = await import('rcedit')); }
  catch (error) { fail(`缺少固定版本的 EXE 资源编辑器；请先在 desktop 执行 npm ci。${error.message}`); }
  const buildVersion = PACKAGE.build?.buildVersion || PACKAGE.version.replace(/[^0-9.].*$/, '');
  await rcedit(executable, {
    'version-string': {
      CompanyName: PACKAGE.author || '',
      FileDescription: PACKAGE.build.productName,
      ProductName: PACKAGE.build.productName,
      InternalName: PACKAGE.build.productName,
      OriginalFilename: executableName,
      LegalCopyright: `Copyright © ${new Date().getUTCFullYear()} ${PACKAGE.author || ''}`
    },
    'file-version': buildVersion,
    'product-version': buildVersion,
    icon,
    'requested-execution-level': 'asInvoker'
  });
  const executionLevel = verifyExecutable(executable, 'asInvoker');
  if (!executionLevel.ok) fail('目录式便携包的 EXE 普通权限资源写入失败。');
  const icons = inspectExecutableIcons(executable);
  const stat = fs.statSync(executable);
  return {
    file: executableName,
    bytes: stat.size,
    sha256: await hashFile(executable),
    icons,
    executionLevel
  };
}

async function createUpdateManifest(outputRoot, bundle, options = {}) {
  if (!bundle?.file || !Number.isSafeInteger(bundle.bytes) || !/^[a-f0-9]{64}$/.test(bundle.sha256 || '')) fail('便携包信息不足，不能生成更新清单。');
  const version = PACKAGE.version, tag = options.tag || `v${version}`, filename = path.basename(bundle.file);
  if (!/^v[0-9a-z.-]+$/i.test(tag) || !/^DLSS5-Manager-[0-9a-z.-]+-Portable[.]zip$/i.test(filename)) fail('更新发布标签或文件名无效。');
  const manifest = { schema:'dlss5-manager-update-v1', version,
    channel:/-(?:alpha|beta|rc)[.-]/i.test(version) ? 'preview' : 'stable',
    releaseUrl:`https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/tag/${tag}`,
    notes:'本清单只更新管理器程序；Core、DLSS5 Bridge、DLSS5 Feeder、MFG 与 NR 运行库保持独立更新。',
    artifact:{ format:'directory-portable-zip',
      url:`https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases/download/${tag}/${filename}`,
      bytes:bundle.bytes, sha256:bundle.sha256 } };
  const file=path.join(outputRoot,'update-manifest.json');fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n','utf8');
  return { file, sha256:await hashFile(file), manifest };
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
    { from: path.join(stageRoot, 'resources', 'fg-sm86'), to: 'fg-sm86' },
    { from: path.join(stageRoot, 'resources', 'components'), to: 'components' },
    ...(fs.existsSync(path.join(stageRoot, 'resources', 'legacy-runtime', 'manifest.json'))
      ? [{ from: path.join(stageRoot, 'resources', 'legacy-runtime'), to: 'legacy-runtime' }] : []),
    { from: path.join(stageRoot, 'resources', 'bridge-dlc'), to: 'bridge-dlc' },
    { from: path.join(stageRoot, 'resources', 'hoyoshade'), to: 'hoyoshade' },
    { from: path.join(stageRoot, 'resources', 'loading-helper'), to: 'loading-helper' },
    { from: path.join(stageRoot, 'resources', 'reframework-01417'), to: 'reframework-01417' },
    { from: path.join(stageRoot, 'resources', 'vulkan-reshade'), to: 'vulkan-reshade' },
    ...staticResources()
  ];
  config.extraFiles = PACKAGE.build?.extraFiles || [];
  if (unpackedZip) config.extraFiles.push({ from:path.join(APP_ROOT, 'scripts', 'DLSS5-Manager.portable.json'), to:'DLSS5-Manager.portable.json' });
  config.win = { ...(config.win || {}), target: unpackedZip ? ['dir'] : portableOnly ? ['portable'] : ['nsis', 'portable'] };
  // electron-builder's cross-platform signing bundle contains macOS symlinks,
  // which cannot be unpacked on locked-down Windows accounts. Directory builds
  // use the pinned, Windows-only rcedit dependency immediately after packing.
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
  const releaseGate = options.release === true ? assertReleaseStage(stageRoot) : null;
  const config = buildConfig({ stageRoot, flavor, outputRoot, portableOnly: options.portableOnly === true, unpackedZip:options.unpackedZip === true,
    electronDist: options.electronDist || process.env.ELECTRON_OVERRIDE_DIST_PATH || null });
  const summary = { packageVersion: PACKAGE.version, flavor, stage, outputRoot, portableOnly: options.portableOnly === true, unpackedZip:options.unpackedZip === true,
    release: options.release === true, ...(releaseGate ? { releaseGate } : {}) };
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
  if (options.unpackedZip === true) {
    summary.executableResources = await editUnpackedExecutableResources(outputRoot);
    summary.unpackedBundle = await createUnpackedZip(outputRoot, flavor);
    summary.updateManifest = await createUpdateManifest(outputRoot, summary.unpackedBundle);
  }
  fs.writeFileSync(path.join(outputRoot, 'packaging-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

if (require.main === module) {
  buildManager(parseArgs(process.argv.slice(2))).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, details: error.details }, null, 2)); process.exitCode = 1; });
}

module.exports = { buildManager, buildConfig, parseArgs, resolveBuildRoots, createUnpackedZip, createUpdateManifest, editUnpackedExecutableResources, explicitTargets, staticResources, STATIC_RESOURCE_FILES, LEGACY_FG_RESOURCE_FILES, ALL_STATIC_RESOURCE_FILES, runSharedContractBuild };
