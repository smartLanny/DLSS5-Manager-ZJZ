'use strict';

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./payload');
const { safePath } = require('../core/file-journal');
const { appError } = require('./errors');

const BACKUP_DIR = '_DLSS5_Backup';
const ADDON_EXT = /\.addon(?:32|64)?$/i;

function isProtectedName(name) {
  return /^(?:dxgi|d3d9|d3d10(?:_1)?|d3d11|d3d12|opengl32|dinput8|version|winmm|dsound|nvngx_dlss(?:g|d|nr)?|nrchain_nvngx|_nvngx)\.dll$/i.test(name);
}

function classifyAddon(name, file) {
  const lower = name.toLowerCase();
  // A pinned, separately managed FG menu is not an NR/NGX conflict. A name
  // alone is never sufficient to exempt another DLL from conflict checks.
  if (lower === 'rtx40mfg-ui.addon64' && file) {
    try { if (sha256(file) === 'caec2ec46bba6fdae9ce0f525028e55d54df3b86d3bbffae820007ae9c26b010') return null; } catch {}
  }
  if (/^(?:dlss5-native-carrier|r3-nr-native-neutral)(?:[-_.].*)?\.addon(?:32|64)?$/i.test(lower)) {
    return { category: 'native-carrier', reason: '旧版 DX11 Native Carrier' };
  }
  if (lower === 'renodx-dlss5.addon64') {
    return { category: 'dlss5-tool', reason: '原版 DLSS5 Tool（RHI 中显示为 DLSS5 Tool）' };
  }
  if (/nr[-_ ]?before[-_ ]?sr/i.test(lower)) {
    return { category: 'legacy-nr-before-sr', reason: '旧版 NR-before-SR Addon' };
  }
  // Ordinary RenoDX color/HDR addons do not touch the DLSS/NR/NGX path and
  // are explicitly left in place.
  if (lower.includes('renodx') && !/(dlss|ngx|nr)/i.test(lower)) return null;
  if (/(dlss|dlssg|ngx|optiscaler|streamline)|(?:^|[-_. ])nr(?:[-_. ]|$)/i.test(lower)) {
    return { category: 'other-dlss-nr-ngx', reason: '可能修改 DLSS、NR 或 NGX 的 ReShade Addon' };
  }

  // Some addons use neutral filenames. A small string check catches the
  // common self-identifying binaries without touching ordinary DLLs.
  if (file) {
    try {
      // Ordinary overlay/HDR addons can mention DLSS or import NGX without
      // owning that path. Only a self-identifying implementation is moved.
      // Bound the read: conflict checks must not read an arbitrary huge addon.
      const fd = fs.openSync(file, 'r');
      let identified = false;
      try {
        const buffer = Buffer.alloc(64 * 1024); let tail = '';
        for (let position = 0; position < Math.min(fs.fstatSync(fd).size, 8 * 1024 * 1024); position += buffer.length) {
          const size = fs.readSync(fd, buffer, 0, buffer.length, position);
          if (!size) break;
          const text = tail + buffer.subarray(0, size).toString('latin1');
          if (/(NRBeforeSR|NR-before-SR|OptiScaler|renodx-dlss5)/i.test(text)) { identified = true; break; }
          tail = text.slice(-32);
        }
      } finally { fs.closeSync(fd); }
      if (identified) {
        return { category: 'other-dlss-nr-ngx', reason: 'Addon 内容声明修改 DLSS、NR 或 NGX' };
      }
    } catch {}
  }
  return null;
}

function walkAddons(root, maxDepth = 4) {
  const result = [];
  function visit(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.toLowerCase() === BACKUP_DIR.toLowerCase() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && ADDON_EXT.test(entry.name) && !isProtectedName(entry.name)) result.push(file);
    }
  }
  visit(path.resolve(root), 0);
  return result;
}

function scanConflicts(gameDir, options = {}) {
  const root = path.resolve(gameDir);
  const excluded = new Set((options.exclude || []).map(rel => path.normalize(rel).toLowerCase()));
  const files = options.addonDir ? walkAddons(path.resolve(options.addonDir), 0) : walkAddons(root);
  return files.flatMap(file => {
    const name = path.basename(file);
    const rel = path.relative(root, file);
    if (excluded.has(path.normalize(rel).toLowerCase())) return [];
    const classification = classifyAddon(name, file);
    if (!classification) return [];
    if (Array.isArray(options.categories) && !options.categories.includes(classification.category)) return [];
    return [{
      source: file,
      rel,
      name,
      ...classification,
      sha256: sha256(file)
    }];
  });
}

function conflictBackupPath(gameDir, installId, rel, index = 0) {
  const safeRel = path.normalize(rel);
  const suffix = index ? `.conflict.${index}` : '';
  return safePath(gameDir, path.join(BACKUP_DIR, 'conflicts', installId, `${safeRel}${suffix}`));
}

async function moveConflicts(gameDir, installId, options = {}) {
  const moved = [];
  const rename = options.rename || fs.promises.rename;
  try {
    for (const conflict of scanConflicts(gameDir, options)) {
      safePath(gameDir, conflict.rel);
      if (!fs.existsSync(conflict.source)) continue;
      let destination = conflictBackupPath(gameDir, installId, conflict.rel);
      let index = 0;
      while (fs.existsSync(destination)) {
        index += 1;
        destination = conflictBackupPath(gameDir, installId, conflict.rel, index);
      }
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      if (typeof options.capture === 'function') {
        await options.capture(conflict.source);
        await options.capture(destination);
      }
      if (sha256(conflict.source) !== conflict.sha256) throw appError('ERR_FILE_CHANGED', { rel: conflict.rel });
      await rename(conflict.source, destination);
      moved.push({
        sourceRel: conflict.rel,
        backupRel: path.relative(gameDir, destination),
        name: conflict.name,
        category: conflict.category,
        reason: conflict.reason,
        sha256: conflict.sha256
      });
    }
  } catch (error) {
    // A surrounding file journal owns rollback when capture is supplied. The
    // standalone helper still restores prior moves before surfacing failure.
    if (typeof options.capture !== 'function') {
      try {
        const rollbackWarnings = await restoreConflicts(gameDir, [...moved].reverse(), { rename });
        if (rollbackWarnings.length) error.rollbackWarnings = rollbackWarnings;
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }
  return moved;
}

// The installer calls this only after compiling the shared loading snapshot.
// Its journal still owns both sides of every move and their rollback. Unlike
// scanConflicts, this path never expands the selection with a fresh name scan.
async function movePlannedConflicts(gameDir, installId, plan, options = {}) {
  const { noLinks } = require('./launch-safety');
  const { assertAddonSnapshot } = require('./addon-loading-layout');
  if (!plan || plan.version !== 1 || plan.blockers?.length || !Array.isArray(plan.decisions) ||
      !/^[a-f0-9]{64}$/.test(plan.sourceFingerprint || '') || !/^[a-f0-9-]{36}$/.test(installId || ''))
    throw appError('ERR_FILE_CHANGED', { reason: '插件隔离预览无效或尚未完成。' });
  if (options.snapshot) {
    if (options.snapshot.fingerprint !== plan.sourceFingerprint) throw appError('ERR_FILE_CHANGED', { reason: '插件预览来源不一致。' });
    await assertAddonSnapshot(options.snapshot, { environment: options.environment || process.env });
  }
  const root = path.resolve(gameDir), moved = [], seen = new Set(), rename = options.rename || fs.promises.rename;
  const rows = plan.decisions.filter(row => ['isolate', 'retire-core'].includes(row.action));
  // Validate the COMPLETE selection before creating a backup or moving files.
  for (const row of rows) {
    if (!row || !path.isAbsolute(row.path || '') || !/^[a-f0-9]{64}$/.test(row.sha256 || '') ||
        row.sourceFingerprint !== plan.sourceFingerprint || row.configFingerprint !== plan.configFingerprint ||
        !row.moduleMayLoad || !ADDON_EXT.test(row.path) && !(row.explicit === true && /\.dll$/i.test(row.path)) ||
        isProtectedName(path.basename(row.path))) throw appError('ERR_FILE_CHANGED', { reason: '插件隔离目标未绑定实际加载范围。' });
    const relative = path.relative(root, row.path), file = safePath(root, relative), identity = path.resolve(file).toLowerCase();
    if (seen.has(identity)) throw appError('ERR_FILE_CHANGED', { reason: '插件隔离目标重复。' });
    seen.add(identity); await noLinks(file);
    if (sha256(file) !== row.sha256) throw appError('ERR_FILE_CHANGED', { rel: relative });
  }
  try {
    for (const row of rows) {
      const relative = path.relative(root, row.path), source = safePath(root, relative);
      let destination = conflictBackupPath(root, installId, relative), index = 0;
      while (fs.existsSync(destination)) destination = conflictBackupPath(root, installId, relative, ++index);
      await noLinks(source); await noLinks(destination);
      if (typeof options.capture === 'function') { await options.capture(source); await options.capture(destination); }
      if (sha256(source) !== row.sha256) throw appError('ERR_FILE_CHANGED', { rel: relative });
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await noLinks(source); await noLinks(destination);
      if (sha256(source) !== row.sha256 || fs.existsSync(destination)) throw appError('ERR_FILE_CHANGED', { rel: relative });
      await rename(source, destination);
      moved.push({ sourceRel: relative, backupRel: path.relative(root, destination), name: path.basename(source), sha256: row.sha256,
        category: row.action === 'retire-core' ? 'own-core-upgrade' : row.mandatory ? 'confirmed-addon-conflict' : 'unverified-addon',
        reason: row.reason, sourceFingerprint: plan.sourceFingerprint, configFingerprint: plan.configFingerprint, originalOwned: row.owned === true });
    }
  } catch (error) {
    if (typeof options.capture !== 'function') try { const warnings = await restoreConflicts(root, [...moved].reverse(), { rename }); if (warnings.length) error.rollbackWarnings = warnings; }
    catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
  return moved;
}

async function restoreConflicts(gameDir, rows, options = {}) {
  const warnings = [];
  const rename = options.rename || fs.promises.rename;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.sourceRel !== 'string' || typeof row.backupRel !== 'string') continue;
    const source = safePath(gameDir, row.sourceRel);
    const backup = safePath(gameDir, row.backupRel);
    if (!fs.existsSync(backup) || (row.sha256 && sha256(backup) !== row.sha256)) {
      warnings.push({ code: 'ERR_BACKUP_INVALID', rel: row.sourceRel });
      continue;
    }
    if (fs.existsSync(source)) {
      if (row.sha256 && fs.statSync(source).isFile() && sha256(source) === row.sha256) continue;
      warnings.push({ code: 'ERR_FILE_CHANGED', rel: row.sourceRel });
      continue;
    }
    await fs.promises.mkdir(path.dirname(source), { recursive: true });
    if (typeof options.capture === 'function') {
      await options.capture(backup);
      await options.capture(source);
    }
    if (typeof options.capture === 'function') {
      // A confirmed uninstall already has a file WAL. Restore the original
      // without consuming the fixed quarantine archive or overwriting a new file.
      await fs.promises.copyFile(backup, source, fs.constants.COPYFILE_EXCL);
      if (sha256(source) !== sha256(backup) || row.sha256 && sha256(source) !== row.sha256)
        throw appError('ERR_BACKUP_INVALID', { rel: row.sourceRel });
    } else await rename(backup, source);
  }
  return warnings;
}

module.exports = {
  isProtectedName,
  classifyAddon,
  scanConflicts,
  moveConflicts,
  movePlannedConflicts,
  restoreConflicts
};
