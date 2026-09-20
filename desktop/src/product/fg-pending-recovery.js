'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks } = require('./launch-safety');
const { ADDON, PROVIDERS, knownProviderForHash } = require('./fg-mfgunlock-resources');
const PRODUCT = 'xiaofeng-fg-components';
const HASH = /^[a-f0-9]{64}$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const OLD_NAMES = /^(?:RTX40MFGCore\.dll|RTX40MFG\.asi|RTX40MFG-UI\.addon64|RTX40MFG-Universal\.json|(?:dinput8|version|winmm)\.(?:dll|ini)|dxgi\.dll)$/i;
const PHASES = ['prepare', 'undo-prepare', 'restore', 'legacy-restore', 'migration-rollback', 'migration-commit'];
const contexts = new Map(), locks = new Set();
const key = value => path.resolve(value).toLowerCase();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => digest(Buffer.from(JSON.stringify(value, null, 2) + '\n'));
const canonicalRel = value => typeof value === 'string' ? value.replaceAll('\\', '/').toLowerCase() : '';

async function hashFile(file) {
  await noLinks(file);
  let before;
  try { before = await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.nlink > 1 || before.size > 64 * 1024 * 1024) fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 恢复目标不是有界普通文件。');
  const hash = crypto.createHash('sha256'); for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  await noLinks(file); const after = await fsp.lstat(file);
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 文件在检查中发生变化，保留恢复记录。');
  return hash.digest('hex');
}

function createFgPendingRecovery({ journal, assertGameClosed, providerLibrary, backend }) {
  const sm86 = backend === 'dlssg-sm86', product = sm86 ? 'xiaofeng-fg-sm86' : PRODUCT;
  const known = providerLibrary?.knownProviderForHash || knownProviderForHash;
  const providers = () => providerLibrary?.providers() || PROVIDERS;
  function kind(t, rel) {
    const dest = journal.safePath(t.game, rel), normalized = canonicalRel(path.relative(t.game, dest));
    if (canonicalRel(rel) !== normalized) return null;
    if (normalized === '_dlss5_backup/manifest.json') return 'manifest';
    if (sm86) {
      if (normalized === '_dlss5_backup/xiaofeng-fg-sm86.json') return 'receipt';
      if (key(path.dirname(dest)) !== key(t.dir)) return null;
      if (path.basename(dest).toLowerCase() === 'version.dll') return 'addon';
      if (path.basename(dest).toLowerCase() === 'dlssg_sm86.ini') return 'config';
      return null;
    }
    if (normalized === '_dlss5_backup/xiaofeng-fg-components.json') return 'receipt';
    if (normalized === '_dlss5_backup/xiaofeng-fg-migration.json') return 'migration';
    if (new RegExp(`^_dlss5_backup/\\.fg-migration/${UUID}/(?:[0-9]|1[0-5])\\.bin$`, 'i').test(normalized)) return 'migration-snapshot';
    if (new RegExp(`^_dlss5_backup/\\.fg-originals/${UUID}/addon\\.bin$`, 'i').test(normalized)) return 'original-snapshot';
    if (key(path.dirname(dest)) !== key(t.dir)) return null;
    if (path.basename(dest).toLowerCase() === ADDON.toLowerCase()) return 'addon';
    return OLD_NAMES.test(path.basename(dest)) ? 'legacy-component' : null;
  }
  async function read(t) {
    const file = journal.pendingPath(t.game); await noLinks(file);
    let stat; try { stat = await fsp.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.nlink > 1 || stat.size > 2 * 1024 * 1024) fail('SETTINGS_FG_FILE_RECOVERY_INVALID', '共享文件恢复记录不是有界普通文件。');
    const text = await fsp.readFile(file, 'utf8'); let state;
    try { state = JSON.parse(text); } catch { fail('SETTINGS_FG_FILE_RECOVERY_INVALID', '共享文件恢复记录无法解析，已保留。'); }
    return { file, text, state };
  }
  function identified(t, state) {
    if (sm86) return state?.owner?.product === product || state?.files?.some(row => canonicalRel(row.rel) === '_dlss5_backup/xiaofeng-fg-sm86.json') === true;
    return state?.owner?.product === PRODUCT || state?.files?.some(row => {
      try { return ['addon', 'receipt', 'migration', 'migration-snapshot'].includes(kind(t, row.rel)) ||
        kind(t, row.rel) === 'legacy-component' && /^RTX40MFG/i.test(path.basename(row.rel)); } catch { return false; }
    }) === true;
  }
  async function inspect(t) {
    try {
      const value = await read(t);
      const pending = Boolean(value && identified(t, value.state));
      return { fileRecoveryPending: pending && !contexts.has(key(t.game)), fileOperationActive: pending && contexts.has(key(t.game)),
        fileRecoveryOwner: value?.state?.owner?.product || null, fileRecoveryPhase: value?.state?.owner?.operation || null,
        fileRecoveryBlocker: pending ? 'FG 组件有未完成文件操作，请先恢复；外部修改会保留并单独提示。' : null };
    } catch (error) { return { fileRecoveryPending: true, fileRecoveryBlocker: error.message, fileRecoveryError: error.code }; }
  }
  async function validate(t, value) {
    const state = value.state;
    if (!identified(t, state)) fail('SETTINGS_FG_FILE_RECOVERY_OTHER', '该文件事务不属于所选游戏的 FG 组件，未执行恢复。');
    if (state.version !== 1 || !new RegExp(`^_DLSS5_Backup/\\.transactions/${UUID}$`).test(state.folder || '') ||
        !Array.isArray(state.files) || state.files.length < 1 || state.files.length > 96 || !Array.isArray(state.dirs) || state.dirs.length > 160)
      fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 文件事务范围无效，已保留。');
    const owner = state.owner, checks = new Map(), targets = new Set(), directories = new Set();
    if (sm86 && !owner) fail('SETTINGS_FG_FILE_RECOVERY_OTHER', 'SM86 事务缺少专属恢复身份，未执行恢复。');
    if (owner !== undefined) {
      if (!owner || owner.version !== 1 || owner.product !== product || key(owner.exe || '.') !== key(t.exe) || key(owner.game || '.') !== key(t.game) ||
          !PHASES.includes(owner.operation) || !Array.isArray(owner.checks) || owner.checks.length > 96)
        fail('SETTINGS_FG_FILE_RECOVERY_OTHER', 'FG 文件事务归属或 EXE 不一致，未执行恢复。');
      for (const check of owner.checks) {
        if (!kind(t, check.rel) || checks.has(canonicalRel(check.rel)) || !(check.before === null || HASH.test(check.before || '')) ||
            !Array.isArray(check.after) || check.after.length < 1 || check.after.length > 16 || check.after.some(hash => hash !== null && !HASH.test(hash || '')))
          fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 目标摘要记录无效，已保留。');
        checks.set(canonicalRel(check.rel), check);
      }
    }
    for (let index = 0; index < state.files.length; index++) {
      const row = state.files[index], type = kind(t, row.rel), rel = canonicalRel(row.rel);
      if (!type || targets.has(rel) || typeof row.existed !== 'boolean' || row.snapshot !== `${state.folder}/${index}.bin`)
        fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 事务含未知、重复或交叉归属目标，已保留。');
      targets.add(rel);
      let parent = path.posix.dirname(rel); while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
      const snapshot = journal.safePath(t.game, row.snapshot), before = row.existed ? await hashFile(snapshot) : null;
      if (row.existed && before === null || !row.existed && await hashFile(snapshot) !== null)
        fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 回滚快照缺失或与原状态矛盾。');
      const current = await hashFile(journal.safePath(t.game, row.rel)), check = checks.get(rel);
      if (type === 'manifest' && current !== before) fail('SETTINGS_FG_EXTERNAL_CHANGE', '原生安装清单在 FG 中断后变化，未覆盖。');
      // COPYFILE_EXCL may have protected a file that appeared externally. Its
      // snapshot must still equal the live external bytes; never delete it.
      if (row.fgPreservedSha256) {
        if (!HASH.test(row.fgPreservedSha256) || before !== row.fgPreservedSha256 || current !== before)
          fail('SETTINGS_FG_EXTERNAL_CHANGE', '受保护的外部 FG 文件或快照发生变化，已保留。');
        continue;
      }
      if (check && before !== check.before) fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 快照摘要与写入前记录不符，已保留。');
      const permitted = check ? [check.before, ...check.after] : [before];
      // Old unannotated prepare/restore WALs have no arbitrary Add-on rights.
      // Only the one code-pinned new Add-on admits the known creation/deletion.
      if (!owner && type === 'addon' && (before === null || known(before))) permitted.push(null, ...providers().map(row => row.sha256));
      if (!permitted.includes(current)) fail('SETTINGS_FG_EXTERNAL_CHANGE', `${path.basename(row.rel)} 在中断后发生外部变化；文件和恢复记录均已保留。`);
    }
    if ([...checks.keys()].some(rel => !targets.has(rel)) || state.dirs.some(dir => !directories.has(canonicalRel(dir))))
      fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 事务包含未捕获目标或其他目录，未执行恢复。');
    return value;
  }
  async function capture(t, file, after) {
    const context = contexts.get(key(t.game));
    if (!context || !kind(t, path.relative(t.game, file))) fail('SETTINGS_FG_FILE_RECOVERY_INVALID', 'FG 写入没有有效归属或目标范围。');
    await journal.capture(t.game, file);
    const rel = path.relative(t.game, file), current = await hashFile(file);
    let check = context.checks.find(row => canonicalRel(row.rel) === canonicalRel(rel));
    if (!check) { check = { rel, before: current, after: [] }; context.checks.push(check); }
    else if (![check.before, ...check.after].includes(current)) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 目标在本轮操作中被外部改变。');
    if (!check.after.includes(after)) check.after.push(after);
    await journal.setOwner(t.game, context);
  }
  async function transaction(t, operation, work) {
    const gameKey = key(t.game); if (locks.has(gameKey)) fail('SETTINGS_FG_FILE_BUSY', '该游戏正在进行 FG 文件操作。');
    locks.add(gameKey);
    try { return await journal.transaction(t.game, async () => {
      const context = { version: 1, product, exe: t.exe, game: t.game, operation, checks: [] };
      contexts.set(gameKey, context);
      await journal.setOwner(t.game, context);
      try { return await work(); }
      catch (cause) {
        try { await validate(t, await read(t)); }
        catch (recoveryError) { cause.preservePending = true; cause.recoveryError = recoveryError; }
        throw cause;
      } finally { contexts.delete(gameKey); }
    }); } finally { contexts.delete(gameKey); locks.delete(gameKey); }
  }
  async function recover(t) {
    const gameKey = key(t.game); if (locks.has(gameKey)) fail('SETTINGS_FG_FILE_BUSY', '该游戏正在进行 FG 文件操作。');
    locks.add(gameKey);
    try {
      await assertGameClosed(t.game, t.exe); await noLinks(t.exe);
      const value = await read(t); if (!value) return { recovered: false, unchanged: true };
      await validate(t, value); await assertGameClosed(t.game, t.exe);
      const latest = await read(t);
      if (!latest || latest.text !== value.text) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 文件事务在恢复前发生变化，已保留。');
      await validate(t, latest);
      return { recovered: await journal.recover(t.game), filesRestored: true, runtimeVerified: false };
    } finally { locks.delete(gameKey); }
  }
  return { transaction, capture, inspect, recover };
}
module.exports = { PRODUCT, createFgPendingRecovery, jsonHash, hashFile };
