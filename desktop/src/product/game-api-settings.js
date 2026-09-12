'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { inside, noLinks } = require('./launch-safety');

const RDR2_APP_ID = '1174180';
const RDR2_KIND = 'rdr2-system-xml';
const APIS = new Set(['dx12', 'vulkan']);
const HASH = /^[a-f0-9]{64}$/i;
const MAX_SETTINGS_BYTES = 64 * 1024;

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}

function text(value) { return typeof value === 'string' ? value : ''; }

function absolute(value, name) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value))
    fail('GAME_API_IDENTITY', `${name} 不是有效的绝对路径。`);
  return path.resolve(value);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function readPlain(file) {
  await noLinks(file);
  let stat;
  try { stat = await fs.stat(file); } catch (error) {
    if (error.code === 'ENOENT') fail('GAME_API_FILE_MISSING', 'RDR2 图形设置文件不存在。');
    throw error;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SETTINGS_BYTES)
    fail('GAME_API_FILE_INVALID', 'RDR2 图形设置文件不是有界普通文件。');
  const bytes = await fs.readFile(file);
  if (bytes.length !== stat.size) fail('GAME_API_FILE_CHANGED', '读取 RDR2 图形设置时文件发生变化。');
  return { bytes, sha256: hashBytes(bytes) };
}

async function hashFile(file) {
  await noLinks(file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.nlink > 1) fail('GAME_API_EXE_INVALID', '绑定的游戏 EXE 不是普通文件。');
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      position += result.bytesRead;
    }
  } finally { await handle.close(); }
  return hash.digest('hex');
}

function bytes(value, name) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_SETTINGS_BYTES)
    fail('GAME_API_PLAN_INVALID', `${name} 必须是有界 Buffer。`);
  return Buffer.from(value);
}

function digest(value, name) {
  const result = text(value).toLowerCase();
  if (!HASH.test(result)) fail('GAME_API_PLAN_INVALID', `${name} 不是 SHA-256。`);
  return result;
}

function identity(game) {
  const chosen = game?.scan?.chosen;
  const info = chosen?.apiSettings;
  if (!info || info.kind !== RDR2_KIND || info.matched === false) return null;
  const steamAppId = text(info.steamAppId || info.appId || game?.appid);
  if (steamAppId !== RDR2_APP_ID) return null;
  const exe = absolute(info.exe || chosen.path, '游戏 EXE');
  const entryRoot = absolute(info.entryRoot || game?.dir, '游戏根目录');
  if (!samePath(exe, path.join(entryRoot, 'RDR2.exe')))
    fail('GAME_API_IDENTITY', 'RDR2 配置身份必须绑定根目录中的 RDR2.exe。');
  if (info.exe && !samePath(info.exe, chosen.path)) fail('GAME_API_IDENTITY', 'RDR2 配置身份与当前 EXE 不一致。');
  if (info.entryRoot && !samePath(info.entryRoot, game?.dir || info.entryRoot))
    fail('GAME_API_IDENTITY', 'RDR2 配置身份与当前游戏根目录不一致。');
  return { info, chosen, exe, entryRoot, steamAppId };
}

function validatePlan(plan, id, requestedApi) {
  if (!plan || typeof plan !== 'object') fail('GAME_API_PLAN_INVALID', 'RDR2 配置 adapter 未返回修改计划。');
  const file = absolute(plan.file, 'RDR2 设置文件');
  if (id.info.file && !samePath(file, id.info.file)) fail('GAME_API_IDENTITY', '配置计划指向的文件与扫描身份不一致。');
  if (plan.api !== requestedApi || !APIS.has(text(plan.api).toLowerCase()))
    fail('GAME_API_PLAN_INVALID', '配置计划的 API 与请求不一致。');
  const beforeBytes = bytes(plan.before?.bytes, 'before.bytes');
  const afterBytes = bytes(plan.after?.bytes, 'after.bytes');
  const beforeSha256 = digest(plan.before?.sha256, 'before.sha256');
  const afterSha256 = digest(plan.after?.sha256, 'after.sha256');
  if (hashBytes(beforeBytes) !== beforeSha256 || hashBytes(afterBytes) !== afterSha256)
    fail('GAME_API_PLAN_INVALID', '配置计划中的字节与摘要不一致。');
  if (typeof plan.changed !== 'boolean' || plan.changed !== (beforeSha256 !== afterSha256))
    fail('GAME_API_PLAN_INVALID', '配置计划的 changed 标记不一致。');
  return { file, beforeBytes, afterBytes, beforeSha256, afterSha256, changed: plan.changed };
}

async function writeAtomic(file, content, expectedSha256, replace) {
  await noLinks(file);
  if (expectedSha256) {
    const current = await readPlain(file);
    if (current.sha256 !== expectedSha256) fail('GAME_API_FILE_CHANGED', '配置文件在写入前已被外部修改。');
  }
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    await noLinks(temporary);
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close(); handle = null;
    await noLinks(file);
    await replace(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function saveBackup(userData, exeHash, beforeSha256, content) {
  const root = path.resolve(userData);
  const directory = path.join(root, 'game-api-backups', exeHash);
  const file = path.join(directory, `${beforeSha256}.xml`);
  if (!inside(root, file)) fail('GAME_API_BACKUP_PATH', 'RDR2 配置备份路径越界。');
  await noLinks(root); await fs.mkdir(directory, { recursive: true }); await noLinks(file);
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(file);
    if (hashBytes(existing) !== beforeSha256) fail('GAME_API_BACKUP_CONFLICT', 'RDR2 配置备份摘要冲突。');
  }
  await noLinks(file);
  return file;
}

function noOp(api = null) {
  return Object.freeze({ applied: false, changed: false, api,
    rollback: async () => ({ rolledBack: false, noOp: true, changed: false, api }) });
}

/**
 * Build the single-writer session used by AppService's API route.
 *
 * `assertGameClosed(gameDir, exe)` is called before planning, before publish,
 * and before rollback. `apply(game, api)` resolves to an immutable session:
 * `{ applied, changed, api, file?, beforeSha256?, afterSha256?, backup?,
 *    rollback(): Promise<{ rolledBack, retained?, already?, code?, file? }> }`.
 * A session whose scan cannot prove `canSync === true` is an explicit no-op,
 * so the caller can keep its existing manual API preference unchanged.
 */
function createGameApiSettings(options = {}) {
  const userData = absolute(options.userData, 'userData');
  const settings = options.settings;
  const assertGameClosed = options.assertGameClosed;
  const replace = options.replace || ((temporary, target) => fs.rename(temporary, target));
  if (typeof replace !== 'function') fail('GAME_API_BAD_CONFIG', 'replace 必须是函数。');

  async function closed(id) {
    if (typeof assertGameClosed !== 'function') fail('GAME_CLOSED_CHECK_UNAVAILABLE', '无法确认游戏已退出，未修改图形设置。');
    await assertGameClosed(id.entryRoot, id.exe);
  }

  async function apply(game, api, previewOnly = false) {
    const requested = text(api).toLowerCase();
    if (requested === 'auto') return noOp('auto');
    const id = identity(game);
    if (!id) return noOp(requested || null);
    // RDR2 may be identified as a dual-API game even when the KnownFolder
    // document is absent, malformed, or otherwise unsafe to read. Preserve
    // the existing manual route in that case; only an explicit canSync=true
    // scan is allowed to claim or perform a game-settings synchronization.
    if (id.info.canSync !== true) return noOp(requested || null);
    if (!APIS.has(requested)) fail('GAME_API_UNSUPPORTED', 'RDR2 仅允许同步为 DX12 或 Vulkan。');
    if (Array.isArray(id.info.supportedApis) && !id.info.supportedApis.includes(requested))
      fail('GAME_API_UNSUPPORTED', '当前 RDR2 配置 adapter 不支持所选图形 API。');
    if (!settings || typeof settings.prepareMutation !== 'function')
      fail('GAME_API_SETTINGS_UNAVAILABLE', '缺少 RDR2 图形设置 adapter。');

    await closed(id);
    const rawPlan = await settings.prepareMutation({ exe: id.exe, steamAppId: id.steamAppId,
      entryRoot: id.entryRoot, api: requested });
    const plan = validatePlan(rawPlan, id, requested);
    const current = await readPlain(plan.file);
    if (current.sha256 !== plan.beforeSha256) fail('GAME_API_FILE_CHANGED', 'RDR2 配置已偏离修改计划。');
    if (!plan.changed) return noOp(requested);

    const exeHash = await hashFile(id.exe);
    if (previewOnly) {
      const backup = path.join(userData, 'game-api-backups', exeHash, `${plan.beforeSha256}.xml`);
      await noLinks(backup);
      let backupHash = null;
      try { backupHash = hashBytes(await fs.readFile(backup)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (backupHash && backupHash !== plan.beforeSha256) fail('GAME_API_BACKUP_CONFLICT', 'RDR2 配置备份摘要冲突。');
      return { applied: false, changed: true, api: requested, changes: [
        { path: backup, name: path.basename(backup), role: 'game-api-backup', beforeSha256: backupHash,
          afterSha256: plan.beforeSha256, action: backupHash ? 'keep' : 'create' },
        { path: plan.file, name: path.basename(plan.file), role: 'game-api-settings', beforeSha256: plan.beforeSha256,
          afterSha256: plan.afterSha256, action: 'replace', beforeApi: rawPlan.before?.api, afterApi: requested }
      ] };
    }
    const backup = await saveBackup(userData, exeHash, plan.beforeSha256, plan.beforeBytes);
    await closed(id);
    await noLinks(plan.file);
    const beforePublish = await readPlain(plan.file);
    if (beforePublish.sha256 !== plan.beforeSha256) fail('GAME_API_FILE_CHANGED', '发布前 RDR2 配置已被外部修改。');
    await writeAtomic(plan.file, plan.afterBytes, plan.beforeSha256, replace);
    try {
      await noLinks(plan.file);
      const after = await readPlain(plan.file);
      if (after.sha256 !== plan.afterSha256) fail('GAME_API_WRITE_VERIFY', 'RDR2 图形设置写入校验失败。');
    } catch (error) {
      // A failed verification must not silently overwrite a newer external edit.
      try {
        const actual = await readPlain(plan.file);
        if (actual.sha256 === plan.afterSha256) {
          await closed(id);
          await writeAtomic(plan.file, plan.beforeBytes, plan.afterSha256, replace);
        }
      } catch {}
      throw error;
    }

    let rollbackResult = null;
    return Object.freeze({ applied: true, changed: true, api: requested, file: plan.file,
      beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256, backup,
      rollback: async () => {
        if (rollbackResult) return { ...rollbackResult };
        await closed(id); await noLinks(plan.file);
        const currentFile = await readPlain(plan.file);
        if (currentFile.sha256 === plan.beforeSha256) {
          rollbackResult = { rolledBack: true, already: true, file: plan.file, sha256: plan.beforeSha256 };
          return { ...rollbackResult };
        }
        if (currentFile.sha256 !== plan.afterSha256) {
          rollbackResult = { rolledBack: false, retained: true, code: 'GAME_API_EXTERNAL_CHANGE', file: plan.file };
          return { ...rollbackResult };
        }
        await writeAtomic(plan.file, plan.beforeBytes, plan.afterSha256, replace);
        const restored = await readPlain(plan.file);
        if (restored.sha256 !== plan.beforeSha256) fail('GAME_API_ROLLBACK_VERIFY', 'RDR2 图形设置恢复校验失败。');
        rollbackResult = { rolledBack: true, file: plan.file, sha256: plan.beforeSha256 };
        return { ...rollbackResult };
      }
    });
  }

  return Object.freeze({ apply, preview: (game, api) => apply(game, api, true) });
}

module.exports = { createGameApiSettings, RDR2_APP_ID, RDR2_KIND };
