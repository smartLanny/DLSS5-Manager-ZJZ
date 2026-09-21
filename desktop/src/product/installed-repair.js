'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks, digestFile, inside } = require('./launch-safety');
const { readManifest, assertManifestExecutable, manifestPath } = require('./manifest');
const HASH = /^[a-f0-9]{64}$/i;
const KINDS = new Set(['reshade', 'addon', 'bridge', 'carrier', 'runtime', 'config']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// Repair resolves each recorded byte identity independently. A newer catalog
// default never changes the installed Core, bridge, loader entry or baseline.
async function inspectInstalledRepair({ gameDir, exePath, sourceRoots = [] }) {
  const manifest = readManifest(gameDir);
  if (!manifest) fail('ERR_NOT_INSTALLED', '没有可用于修复的安装记录。');
  assertManifestExecutable(gameDir, manifest, exePath);
  await noLinks(manifestPath(gameDir)); await noLinks(exePath);
  const entries = [], changes = [], blockers = [], candidates = [];
  let searched = false;
  async function locate(name, expected) {
    if (!searched) {
      searched = true;
      for (const root of [...new Set(sourceRoots.filter(Boolean).map(value => path.resolve(value)))]) {
        const pending = [{ dir: root, depth: 0 }]; let count = 0;
        while (pending.length) {
          const { dir, depth } = pending.pop(); await noLinks(dir);
          let rows; try { rows = await fs.readdir(dir, { withFileTypes: true }); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          for (const row of rows) {
            if (++count > 4096) fail('REPAIR_SOURCE_LIMIT', '修复来源超出有界检查范围。');
            const file = path.join(dir, row.name);
            if (!inside(root, file) || row.isSymbolicLink()) continue;
            if (row.isDirectory() && depth < 5) pending.push({ dir: file, depth: depth + 1 });
            else if (row.isFile()) candidates.push(file);
          }
        }
      }
    }
    for (const candidate of candidates.filter(file => path.basename(file).toLowerCase() === name.toLowerCase())) {
      await noLinks(candidate);
      if (await digestFile(candidate) === expected) return candidate;
    }
    return null;
  }
  for (const row of manifest.files.filter(row => KINDS.has(row.kind))) {
    if (typeof row.rel !== 'string' || path.isAbsolute(row.rel) || !HASH.test(row.installedSha256 || ''))
      fail('ERR_BACKUP_INVALID', '安装记录缺少可核对的组件身份。');
    const targetRel = require('./native-loader-target').nativeTargetRel(manifest, row);
    const target = path.resolve(gameDir, targetRel);
    if (!inside(gameDir, target) || path.dirname(target).toLowerCase() !== path.dirname(exePath).toLowerCase())
      fail('ERR_BACKUP_INVALID', '安装记录中的组件不属于当前游戏程序目录。');
    await noLinks(target);
    const current = await digestFile(target), expected = row.installedSha256.toLowerCase();
    if (current && (row.kind === 'config' || current === expected)) {
      changes.push({ action: 'keep', name: path.basename(target), path: target, role: row.kind, beforeSha256: current, afterSha256: current });
      continue;
    }
    if (current) {
      blockers.push(`${path.basename(target)} 已被外部修改；请先核对或使用明确的升级预览，修复不会覆盖。`);
      continue;
    }
    const source = await locate(row.sourceName || path.basename(target), expected);
    if (!source) { blockers.push(`${path.basename(target)} 缺失，未找到原摘要对应的修复来源；请重新导入原组件包。`); continue; }
    entries.push({ rel: row.rel, targetRel, kind: row.kind, source, sha256: expected });
    changes.push({ action: 'create', name: path.basename(target), path: target, role: row.kind, beforeSha256: null, afterSha256: expected });
  }
  return { version: manifest.payloadVersion, mode: 'local', repair: true, entries, changes, blockers,
    manifestHash: await digestFile(manifestPath(gameDir)), exeHash: await digestFile(exePath),
    proxyEntry: manifest.reshadeRoute || 'dxgi', runtimeVerified: false };
}
module.exports = { inspectInstalledRepair };
