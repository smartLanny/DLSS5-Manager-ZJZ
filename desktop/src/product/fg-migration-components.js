'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { noLinks, atomicJson } = require('./launch-safety');
const { HASH, sha256, ADDON, knownProviderForHash } = require('./fg-mfgunlock-resources');
const { jsonHash } = require('./fg-pending-recovery');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RECEIPT = 'xiaofeng-fg-components.json';
const RECORD = 'xiaofeng-fg-migration.json';
const OLD_NAMES = /^(?:RTX40MFGCore\.dll|RTX40MFG\.asi|RTX40MFG-UI\.addon64|RTX40MFG-Universal\.json|(?:dinput8|version|winmm)\.(?:dll|ini)|dxgi\.dll)$/i;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function hashFile(file) {
  try { if (!fs.statSync(file).isFile()) fail('SETTINGS_FG_CONFLICT', 'FG 路径被目录占用。'); return sha256(fs.readFileSync(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function createMigrationStore({ journal, assertGameClosed, fileRecovery, knownProviderForHash: known = knownProviderForHash }) {
  const recordFile = t => journal.safePath(t.game, path.join('_DLSS5_Backup', RECORD));
  const receiptFile = t => journal.safePath(t.game, path.join('_DLSS5_Backup', RECEIPT));
  async function read(t) {
    const file = recordFile(t); await noLinks(file); if (!fs.existsSync(file)) return null;
    let value;
    try { if (fs.statSync(file).size > 128 * 1024) throw new Error(); value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { fail('SETTINGS_FG_MIGRATION_RECORD', 'FG 迁移恢复记录损坏，已保留。'); }
    if (value.version !== 1 || !UUID.test(value.token || '') || !same(value.exe, t.exe) ||
        value.folder !== `_DLSS5_Backup/.fg-migration/${value.token}` || !['removing', 'removed', 'prepared'].includes(value.state) ||
        !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 9) fail('SETTINGS_FG_MIGRATION_RECORD', 'FG 迁移恢复记录身份无效。');
    const seen = new Set();
    for (let i = 0; i < value.files.length; i++) {
      const row = value.files[i], dest = journal.safePath(t.game, row.rel), isReceipt = same(dest, receiptFile(t));
      if ((!isReceipt && (!same(path.dirname(dest), t.dir) || !OLD_NAMES.test(path.basename(dest)))) ||
          seen.has(row.rel.toLowerCase()) || typeof row.existed !== 'boolean' ||
          row.snapshot !== `${value.folder}/${i}.bin` || (row.existed ? !HASH.test(row.before || '') : row.before !== null) ||
          row.after !== null && !HASH.test(row.after || '')) fail('SETTINGS_FG_MIGRATION_RECORD', 'FG 迁移快照路径或摘要无效。');
      await noLinks(dest); await noLinks(journal.safePath(t.game, row.snapshot)); seen.add(row.rel.toLowerCase());
    }
    if (!value.files.some(row => same(journal.safePath(t.game, row.rel), receiptFile(t)) && row.existed)) fail('SETTINGS_FG_MIGRATION_RECORD', 'FG 迁移缺少原收据快照。');
    if (value.prepared) {
      const p = value.prepared;
      if (p.addonRel !== path.relative(t.game, path.join(t.dir, ADDON)) || !(p.addonBefore === null || known(p.addonBefore)) ||
          !known(p.addonAfter) || !HASH.test(p.receiptAfter || '') || p.receiptBeforeText !== null || !UUID.test(p.undoToken || '')) fail('SETTINGS_FG_MIGRATION_RECORD', '新 FG 准备撤销记录无效。');
      if (p.addonBefore !== null && p.addonBefore !== p.addonAfter) {
        if (!/^_DLSS5_Backup\/\.fg-originals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/addon\.bin$/.test(p.addonBeforeSnapshot || ''))
          fail('SETTINGS_FG_MIGRATION_RECORD', '新 FG 版本切换缺少原组件快照。');
        await noLinks(journal.safePath(t.game, p.addonBeforeSnapshot));
      } else if (p.addonBeforeSnapshot) fail('SETTINGS_FG_MIGRATION_RECORD', '新 FG 撤销快照与原件状态不一致。');
    }
    return value;
  }
  async function persist(t, value) {
    const file = recordFile(t); await noLinks(file); await fileRecovery.capture(t, file, jsonHash(value)); await atomicJson(file, value);
  }
  async function begin(t, plan) {
    if (await read(t)) fail('SETTINGS_FG_MIGRATION_PENDING', '还有一次 FG 迁移等待完成或恢复。');
    const token = crypto.randomUUID(), folder = `_DLSS5_Backup/.fg-migration/${token}`;
    const retained = new Set(plan.retained.map(rel => rel.toLowerCase()));
    const targets = plan.receipt.files.filter(row => row.mode !== 'adopted' && !retained.has(row.rel.toLowerCase())).map(row => journal.safePath(t.game, row.rel));
    targets.push(receiptFile(t));
    const files = [];
    for (const dest of targets) {
      await noLinks(dest); const before = hashFile(dest), snapshot = `${folder}/${files.length}.bin`;
      if (before !== null) {
        const copy = journal.safePath(t.game, snapshot); await noLinks(copy); await fileRecovery.capture(t, copy, before);
        await fsp.mkdir(path.dirname(copy), { recursive: true }); await fsp.copyFile(dest, copy, fs.constants.COPYFILE_EXCL);
        if (hashFile(copy) !== before || hashFile(dest) !== before) fail('SETTINGS_FG_EXTERNAL_CHANGE', '旧 FG 在建立迁移快照时发生变化。');
      }
      files.push({ rel: path.relative(t.game, dest), existed: before !== null, before, after: null, snapshot });
    }
    const value = { version: 1, token, exe: t.exe, folder, state: 'removing', files, prepared: null, startedAt: new Date().toISOString() };
    await persist(t, value); return value;
  }
  async function removed(t) {
    const value = await read(t); if (!value || value.state !== 'removing') fail('SETTINGS_FG_MIGRATION_RECORD', 'FG 迁移记录不在预期阶段。');
    for (const row of value.files) row.after = hashFile(journal.safePath(t.game, row.rel));
    value.state = 'removed'; await persist(t, value); return value;
  }
  async function prepared(t, token, delta) {
    const value = await read(t);
    if (!value || value.token !== token || value.state !== 'removed') fail('SETTINGS_FG_MIGRATION_TOKEN', 'FG 迁移凭据无效或已完成。');
    value.prepared = delta; value.state = 'prepared'; await persist(t, value);
  }
  async function unprepare(t, token) {
    const value = await read(t); if (!value || value.token !== token) fail('SETTINGS_FG_MIGRATION_TOKEN', 'FG 迁移凭据无效。');
    value.prepared = null; value.state = 'removed'; await persist(t, value);
  }
  async function checkRollback(t, value) {
    if (value.state === 'removing') fail('errBackendRecovery', '旧组件事务尚未完成，请先恢复共享文件日志。');
    if (value.prepared && hashFile(journal.safePath(t.game, value.prepared.addonRel)) !== value.prepared.addonAfter) fail('SETTINGS_FG_EXTERNAL_CHANGE', '新 MFG Add-on 已发生外部变化，未回滚迁移。');
    if (value.prepared?.addonBeforeSnapshot && hashFile(journal.safePath(t.game, value.prepared.addonBeforeSnapshot)) !== value.prepared.addonBefore)
      fail('SETTINGS_FG_EXTERNAL_CHANGE', '新 MFG 撤销快照已发生变化，未回滚迁移。');
    for (const row of value.files) {
      const file = journal.safePath(t.game, row.rel); await noLinks(file);
      const expected = value.prepared && same(file, receiptFile(t)) ? value.prepared.receiptAfter : row.after;
      if (hashFile(file) !== expected) fail('SETTINGS_FG_EXTERNAL_CHANGE', `${path.basename(file)} 已发生外部变化，迁移快照已保留。`);
      if (row.existed && hashFile(journal.safePath(t.game, row.snapshot)) !== row.before) fail('SETTINGS_FG_MIGRATION_RECORD', 'FG 迁移快照缺失或摘要不匹配。');
    }
  }
  async function discard(t, value) {
    for (const row of value.files) {
      const file = journal.safePath(t.game, row.snapshot); await noLinks(file);
      if (fs.existsSync(file)) { await fileRecovery.capture(t, file, null); await fsp.unlink(file); }
    }
    await fileRecovery.capture(t, recordFile(t), null); await fsp.unlink(recordFile(t));
  }
  async function finish(id, t, token, rollback) {
    await assertGameClosed(t.game, t.exe);
    const value = await read(t);
    if (!value || value.token !== token) fail('SETTINGS_FG_MIGRATION_TOKEN', 'FG 迁移凭据无效或已完成。');
    if (rollback) await checkRollback(t, value);
    else if (value.state !== 'prepared' || hashFile(path.join(t.dir, ADDON)) !== value.prepared?.addonAfter || hashFile(receiptFile(t)) !== value.prepared?.receiptAfter) fail('SETTINGS_FG_MIGRATION_PENDING', '新 MFG 组件尚未完整准备，迁移快照仍保留。');
    const result = await fileRecovery.transaction(t, rollback ? 'migration-rollback' : 'migration-commit', async () => {
      const fresh = await read(t);
      if (JSON.stringify(fresh) !== JSON.stringify(value)) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 迁移记录已在操作前改变。');
      await assertGameClosed(t.game, t.exe);
      if (rollback) {
        await checkRollback(t, value);
        if (value.prepared?.addonBefore === null) {
          const addon = journal.safePath(t.game, value.prepared.addonRel); await noLinks(addon); await fileRecovery.capture(t, addon, null); await fsp.unlink(addon);
        } else if (value.prepared?.addonBeforeSnapshot) {
          const p = value.prepared, addon = journal.safePath(t.game, p.addonRel); await noLinks(addon); await fileRecovery.capture(t, addon, p.addonBefore);
          await fsp.copyFile(journal.safePath(t.game, p.addonBeforeSnapshot), addon);
          if (hashFile(addon) !== p.addonBefore) fail('SETTINGS_FG_WRITE', 'MFG 原组件恢复摘要不符。');
        }
        for (const row of [...value.files].reverse()) {
          const file = journal.safePath(t.game, row.rel); await noLinks(file); await fileRecovery.capture(t, file, row.existed ? row.before : null);
          if (row.existed) {
            await fsp.copyFile(journal.safePath(t.game, row.snapshot), file);
            if (hashFile(file) !== row.before) fail('SETTINGS_FG_WRITE', '旧 FG 快照恢复校验失败。');
          } else if (fs.existsSync(file)) await fsp.unlink(file);
        }
      }
      await discard(t, value);
      return { restored: rollback, committed: !rollback, migrationToken: token, runtimeVerified: false };
    });
    // Remove only our now-empty snapshot directory, never the old backup tree.
    await fsp.rmdir(journal.safePath(t.game, value.folder)).catch(() => {});
    return result;
  }
  return { read, begin, removed, prepared, unprepare, finish, recordFile };
}

// A file appearing between journal capture and COPYFILE_EXCL is external.
// Protect it in the same WAL before allowing automatic rollback of our peers.
async function copyNewFile({ journal, game, source, dest, copyFile = fsp.copyFile }) {
  await journal.capture(game, dest);
  try { await copyFile(source, dest, fs.constants.COPYFILE_EXCL); }
  catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
    try {
      const pending = journal.pendingPath(game); await noLinks(pending);
      const text = fs.readFileSync(pending), wal = JSON.parse(text.toString('utf8'));
      const index = wal.files?.findIndex(row => same(journal.safePath(game, row.rel), dest));
      if (wal.version !== 1 || !/^_DLSS5_Backup\/\.transactions\/[a-f0-9-]{36}$/i.test(wal.folder || '') || index < 0 ||
          wal.files[index].snapshot !== `${wal.folder}/${index}.bin`) fail('SETTINGS_FG_RECOVERY', 'FG 文件缺少有效共享事务记录。');
      const row = wal.files[index];
      if (!row.existed) {
        await noLinks(dest); const actual = hashFile(dest), snapshot = journal.safePath(game, row.snapshot); await noLinks(snapshot);
        if (actual === null || fs.existsSync(snapshot) || !fs.readFileSync(pending).equals(text)) fail('SETTINGS_FG_RECOVERY', 'FG 外部文件保护状态已改变。');
        row.existed = true; row.fgPreservedSha256 = actual;
        await atomicJson(pending, wal);
        await fsp.mkdir(path.dirname(snapshot), { recursive: true }); await fsp.copyFile(dest, snapshot, fs.constants.COPYFILE_EXCL);
        if (hashFile(snapshot) !== actual || hashFile(dest) !== actual) fail('SETTINGS_FG_RECOVERY', 'FG 外部文件保护校验失败。');
      }
    } catch (recoveryError) {
      throw Object.assign(new Error('新出现的外部文件和恢复日志已保留，需要显式恢复。'), { code: 'SETTINGS_FG_RECOVERY', preservePending: true, cause: recoveryError });
    }
    fail('SETTINGS_FG_EXTERNAL_CHANGE', '目标由外部创建，已保留并撤销本轮其他写入。');
  }
}
module.exports = { createMigrationStore, copyNewFile, hashFile, same };
