'use strict';

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const FORBIDDEN = new Set([
  'nvngx_dlssnr.dll', 'nr-before-sr.zh-cn.addon64', 'nrchain_nvngx.dll',
  'dlss5-native-carrier-045-dx11-compat.addon64'
]);
const REQUIRED_RESOURCES = [
  'nvapi-drs.ps1', 'nvapi-profile.ps1', 'windows-registry-values.ps1', 'launcher-locations.ps1', 'game-launch-broker.ps1',
  'fg-components/manifest.json', 'fg-components/LICENSE', 'fg-components/MINHOOK-LICENSE.txt',
  'fg-components/UAL-LICENSE', 'fg-components/global.ini'
];
const REQUIRED_ROOT_FILES = ['启动诊断.cmd', 'startup-diagnostics.ps1'];

const LEGACY_FG_METADATA_FILES = Object.freeze(['manifest.json', 'LICENSE', 'MINHOOK-LICENSE.txt', 'UAL-LICENSE', 'global.ini']);
const LEGACY_FG_ROLES = Object.freeze(['core', 'asi', 'overlay', 'ual', 'ualConfig']);
const LEGACY_FG_BINARY = /\.(?:dll|asi|addon(?:32|64)?)$/i;

function fail(message, details = {}) { throw Object.assign(new Error(message), { code: 'ERR_EXTERNAL_PACKAGE_INVALID', details }); }

function isNonemptyFile(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size > 0; } catch { return false; }
}

function resourcesDirectory(selected) {
  const absolute = path.resolve(selected || ''); let stat;
  try { stat = fs.statSync(absolute); } catch { fail('找不到外部组件版待验证目录。', { path: absolute }); }
  if (stat.isFile()) {
    if (path.basename(absolute).toLowerCase() !== 'app.asar') fail('请选择 app.asar、resources 或 win-unpacked 目录。', { path: absolute });
    return path.dirname(absolute);
  }
  if (!stat.isDirectory()) fail('待验证路径不是目录。', { path: absolute });
  if (fs.existsSync(path.join(absolute, 'app.asar'))) return absolute;
  if (fs.existsSync(path.join(absolute, 'resources', 'app.asar'))) return path.join(absolute, 'resources');
  fail('目录中没有找到 resources/app.asar。', { path: absolute });
}

function walkNames(root, limit = 10000) {
  const rows = [], queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), rel = path.relative(root, full);
      if (entry.isSymbolicLink()) fail('打包资源中不应包含链接。', { file: rel });
      if (entry.isDirectory()) queue.push(full); else if (entry.isFile()) rows.push(rel);
      if (rows.length + queue.length > limit) fail('打包资源数量超过验证范围。');
    }
  }
  return rows;
}

function verifyLegacyFgMetadata(resources) {
  const root = path.join(resources, 'fg-components');
  const files = walkNames(root).map(name => String(name).replace(/\\/g, '/'));
  const expected = [...LEGACY_FG_METADATA_FILES];
  const missing = expected.filter(name => !files.includes(name));
  const unexpected = files.filter(name => !expected.includes(name));
  const binaries = files.filter(name => LEGACY_FG_BINARY.test(path.posix.basename(name)));
  if (binaries.length) fail('外部组件版旧 FG 目录中不应包含二进制文件。', { files: binaries });
  if (missing.length || unexpected.length) fail('外部组件版旧 FG 元数据清单不完整或包含未授权文件。', { missing, files: unexpected });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
  catch (error) { fail('外部组件版旧 FG manifest.json 无效。', { cause: error.message }); }
  if (!manifest || manifest.version !== 1 || manifest.protocol !== 11 || typeof manifest.id !== 'string' || !manifest.id ||
      !manifest.files || LEGACY_FG_ROLES.some(role => {
        const row = manifest.files[role];
        return !row || typeof row.file !== 'string' || path.basename(row.file) !== row.file || !/^[a-f0-9]{64}$/i.test(String(row.sha256 || ''));
      }) || !Array.isArray(manifest.ualProxyNames) || manifest.ualProxyNames.length < 1 ||
      manifest.ualProxyNames.some(name => !['dinput8.dll', 'version.dll', 'winmm.dll'].includes(String(name).toLowerCase())))
    fail('外部组件版旧 FG manifest.json 结构无效。');
  return { files: expected.map(name => 'fg-components/' + name), manifestId: manifest.id, metadataOnly: true };
}

function verifyExternalPackage(selected) {
  const resources = resourcesDirectory(selected), archive = path.join(resources, 'app.asar');
  const asarEntries = asar.listPackage(archive);
  if (!Array.isArray(asarEntries) || asarEntries.length > 100000) fail('app.asar 文件列表无效或过大。');
  const forbiddenAsar = asarEntries.filter(name => {
    const normalized = String(name).replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/payload/nr-before-sr/') || FORBIDDEN.has(path.posix.basename(normalized));
  });
  if (forbiddenAsar.length) fail('app.asar 中包含不应随外部版分发的 NR payload。', { files: forbiddenAsar.slice(0, 20) });
  if (fs.existsSync(path.join(resources, 'payload'))) fail('外部组件版 resources 中仍包含 payload 目录。', { path: path.join(resources, 'payload') });
  if (fs.existsSync(path.join(resources, 'vulkan-runtime'))) fail('外部组件版 resources 中仍包含 Vulkan NR 运行包。');
  const resourceFiles = walkNames(resources).filter(name => path.resolve(resources, name) !== path.resolve(archive));
  const forbiddenResources = resourceFiles.filter(name => FORBIDDEN.has(path.basename(name).toLowerCase()));
  if (forbiddenResources.length) fail('外部组件版 resources 中包含专有 NR 文件。', { files: forbiddenResources.slice(0, 20) });
  const missing = REQUIRED_RESOURCES.filter(name => !isNonemptyFile(path.join(resources, name)));
  if (missing.length) fail('外部组件版缺少有效的开源组件、许可证或系统辅助脚本。', { files: missing });
  const missingRoot = REQUIRED_ROOT_FILES.filter(name => !isNonemptyFile(path.join(path.dirname(resources), name)));
  if (missingRoot.length) fail('外部组件版根目录缺少有效的启动诊断文件。', { files: missingRoot });
  const legacyMetadata = verifyLegacyFgMetadata(resources);
  return { ok: true, resources, asarEntries: asarEntries.length, payloadBundled: false,
    retained: REQUIRED_RESOURCES, retainedRootFiles: REQUIRED_ROOT_FILES, legacyMetadata, forbiddenFiles: [] };
}

if (require.main === module) {
  try { console.log(JSON.stringify(verifyExternalPackage(process.argv[2]), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, details: error.details || {} }, null, 2)); process.exitCode = 1; }
}

module.exports = { verifyExternalPackage, verifyLegacyFgMetadata, resourcesDirectory, FORBIDDEN, REQUIRED_RESOURCES, REQUIRED_ROOT_FILES, LEGACY_FG_METADATA_FILES, LEGACY_FG_ROLES };
