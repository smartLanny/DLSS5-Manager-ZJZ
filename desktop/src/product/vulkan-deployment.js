'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const peDefault = require('../core/pe');
const { inside, noLinks, digestFile, atomicJson } = require('./launch-safety');

const PRODUCT = 'xiaofeng-vulkan-deployment';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function sameState(a, b) {
  return Boolean(a?.exists) === Boolean(b?.exists) && (!a?.exists ||
    a.type === b.type && String(a.data) === String(b.data));
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function equalJson(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function createVulkanDeployment(options = {}) {
  if (typeof options.userData !== 'string' || !path.isAbsolute(options.userData)) fail('VULKAN_BAD_CONFIG', 'Vulkan 部署需要绝对的用户数据目录。');
  const userData = path.resolve(options.userData);
  const pe = options.pe || peDefault;
  const registry = options.registry;
  const activation = options.activation;
  const externalLayer = options.externalLayer || null;
  const inspectLaunchContext = options.inspectLaunchContext || (async () => ({ elevated: 'unknown' }));
  const stateRoot = path.join(userData, 'vulkan-deployment');
  const layerRoot = path.join(stateRoot, 'layers');
  const receiptPath = path.join(stateRoot, 'receipt.json');
  const pendingPath = path.join(stateRoot, 'pending.json');
  const lockPath = path.join(stateRoot, 'operation.lock');

  function assertAdapters() {
    if (!registry || typeof registry.read !== 'function' || typeof registry.write !== 'function' || typeof registry.list !== 'function' ||
        !registry.identity || registry.identity.scope !== 'HKCU' || registry.identity.view !== '64' || typeof registry.identity.key !== 'string') {
      fail('VULKAN_REGISTRY_UNAVAILABLE', '没有可验证的 HKCU x64 注册表 adapter。');
    }
    if (!activation || typeof activation.read !== 'function' || typeof activation.write !== 'function' || typeof activation.id !== 'string') {
      fail('VULKAN_ACTIVATION_UNAVAILABLE', '缺少可验证的按 EXE 激活 adapter。');
    }
  }

  function activationGroupKey(exe) {
    const value = typeof activation?.groupKey === 'function' ? activation.groupKey(exe) : path.resolve(exe);
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('VULKAN_ACTIVATION_INVALID', '按 EXE 激活 adapter 返回了无效共享作用域。');
    return path.resolve(value).toLowerCase();
  }
  function refGroupKey(ref) {
    const value = ref?.activation?.groupKey;
    return typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value).toLowerCase() : path.resolve(ref.exe).toLowerCase();
  }

  async function acquireLock() {
    await noLinks(lockPath); await fsp.mkdir(stateRoot, { recursive: true });
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      const nonce = crypto.randomUUID();
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, nonce, createdAt: Date.now() })}\n`, 'utf8');
      await handle.sync(); await handle.close();
      return async () => {
        let current;
        try { current = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch { return; }
        if (current?.nonce === nonce) await fsp.unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let row;
      try { row = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch { fail('VULKAN_BUSY', 'Vulkan 部署锁损坏；请保留现场并恢复。'); }
      let alive = true;
      if (Number.isInteger(row?.pid) && row.pid > 0) try { process.kill(row.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
      if (alive) fail('VULKAN_BUSY', '另一个 Vulkan 部署操作仍在进行。');
      fail('VULKAN_STALE_LOCK', '检测到已停止进程留下的 Vulkan 部署锁；未自动接管，请保留状态并由受控维护流程清理。', { file: path.basename(lockPath), pid: row?.pid });
    }
  }
  async function locked(work) { const release = await acquireLock(); try { return await work(); } finally { await release(); } }

  async function readJsonStrict(file, kind) {
    await noLinks(file);
    if (!fs.existsSync(file)) return null;
    try {
      const stat = await fsp.stat(file); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('size');
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch { fail('VULKAN_STATE_INVALID', `${kind}损坏，已停止 Vulkan 部署操作。`, { file: path.basename(file) }); }
  }

  function validateActivationState(row) {
    if (!row || typeof row.active !== 'boolean' || typeof row.token !== 'string' || row.token.length > 512) {
      fail('VULKAN_ACTIVATION_INVALID', '无法验证按 EXE 激活状态。');
    }
    return { active: row.active, token: row.token };
  }
  function validateRegistryState(row) {
    if (!row || typeof row.exists !== 'boolean') fail('VULKAN_REGISTRY_INVALID', '无法验证注册表状态。');
    if (!row.exists) return { exists: false };
    if (row.type !== 'REG_DWORD' || !(Number.isInteger(row.data) && row.data >= 0 && row.data <= 0xffffffff || /^0x[a-f0-9]{1,8}$/i.test(String(row.data)))) {
      fail('VULKAN_REGISTRY_INVALID', '注册表值类型或数据不符合 Vulkan layer 合同。');
    }
    return { exists: true, type: row.type, data: row.data };
  }
  function validateGame(game) {
    if (!game || typeof game.id !== 'string' || !game.id || game.id.length > 256 || typeof game.exe !== 'string' || !path.isAbsolute(game.exe)) {
      fail('VULKAN_BAD_GAME', '游戏标识或 EXE 路径无效。');
    }
    return { id: game.id, exe: path.resolve(game.exe) };
  }

  async function validateRecipe(recipe) {
    if (!recipe || recipe.version !== 1 || !ID.test(recipe.id || '') || !ID.test(recipe.release || '') || recipe.architecture !== 64 ||
        !recipe.layer || !recipe.activation || recipe.activation.interface !== activation?.id ||
        typeof recipe.sourceRoot !== 'string' || !path.isAbsolute(recipe.sourceRoot)) {
      fail('VULKAN_RECIPE_INVALID', 'Vulkan recipe 身份、架构或激活接口无效。');
    }
    const root = path.resolve(recipe.sourceRoot);
    if (typeof recipe.layer.manifest !== 'string' || recipe.layer.manifest !== path.basename(recipe.layer.manifest) ||
        typeof recipe.layer.library !== 'string' || recipe.layer.library !== path.basename(recipe.layer.library)) {
      fail('VULKAN_RECIPE_INVALID', 'Vulkan recipe 只接受同目录的 manifest 与 DLL 叶文件名。');
    }
    const manifest = path.resolve(root, recipe.layer.manifest);
    const library = path.resolve(root, recipe.layer.library);
    if (!inside(root, manifest) || !inside(root, library) || samePath(manifest, library) ||
        path.extname(manifest).toLowerCase() !== '.json' || path.extname(library).toLowerCase() !== '.dll' ||
        !HASH.test(recipe.layer.manifestSha256 || '') || !HASH.test(recipe.layer.librarySha256 || '') ||
        typeof recipe.layer.name !== 'string' || !recipe.layer.name.startsWith('VK_LAYER_')) {
      fail('VULKAN_RECIPE_INVALID', 'Vulkan recipe 文件路径或摘要无效。');
    }
    await noLinks(manifest); await noLinks(library);
    if (await digestFile(manifest) !== recipe.layer.manifestSha256 || await digestFile(library) !== recipe.layer.librarySha256) {
      fail('VULKAN_RECIPE_HASH', 'Vulkan layer 文件与固定摘要不一致。');
    }
    if (pe.getBitness(library) !== 64) fail('VULKAN_RECIPE_ARCH', 'Vulkan layer DLL 不是 x64。');
    let data;
    try {
      const stat = await fsp.stat(manifest); if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('size');
      data = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    } catch { fail('VULKAN_RECIPE_INVALID', 'Vulkan layer manifest 无法读取。'); }
    const libraryPath = data?.layer?.library_path;
    if (data?.layer?.name !== recipe.layer.name || data?.layer?.type !== 'GLOBAL' ||
        typeof libraryPath !== 'string' || path.isAbsolute(libraryPath) || path.basename(libraryPath) !== recipe.layer.library ||
        path.dirname(path.normalize(libraryPath)) !== '.' || libraryPath.includes('..') || !data.layer.disable_environment || typeof data.layer.disable_environment !== 'object') {
      fail('VULKAN_RECIPE_INVALID', 'Vulkan layer manifest 的名称、DLL 引用或禁用入口无效。');
    }
    return { recipe, root, manifest, library, manifestData: data };
  }

  function validateReceipt(row) {
    if (!row) return null;
    if (row.version !== 1 || row.product !== PRODUCT || !ID.test(row.recipe?.id || '') || !ID.test(row.recipe?.release || '') ||
        !HASH.test(row.recipe?.manifestSha256 || '') || !HASH.test(row.recipe?.librarySha256 || '') ||
        !row.layer || !['owned', 'reused'].includes(row.layer.mode) || typeof row.layer.manifest !== 'string' ||
        !Array.isArray(row.refs) || row.refs.length > 512 || row.registry?.key !== registry.identity.key ||
        row.registry?.scope !== 'HKCU' || row.registry?.view !== '64') fail('VULKAN_STATE_INVALID', 'Vulkan 部署收据无效。');
    const manifest = path.resolve(row.layer.manifest);
    if (!path.isAbsolute(row.layer.manifest) || typeof row.layer.library !== 'string' || !path.isAbsolute(row.layer.library)) fail('VULKAN_STATE_INVALID', 'Vulkan layer 收据路径无效。');
    if (row.layer.mode === 'owned' && (!inside(layerRoot, manifest) || !inside(layerRoot, path.resolve(row.layer.library)))) fail('VULKAN_STATE_INVALID', 'Vulkan layer 收据路径越界。');
    if (row.layer.mode === 'reused' && (!HASH.test(row.layer.manifestSha256 || '') || !HASH.test(row.layer.librarySha256 || ''))) fail('VULKAN_STATE_INVALID', '外部 Vulkan layer 摘要收据无效。');
    if (row.layer.mode === 'owned') validateRegistryState(row.layer.registryBefore);
    validateRegistryState(row.layer.registryAfter);
    if (row.layer.registryScope !== undefined && row.layer.registryScope !== 'HKLM') fail('VULKAN_STATE_INVALID', 'Vulkan layer 注册作用域无效。');
    const seen = new Set();
    for (const ref of row.refs) {
      if (!ref || typeof ref.id !== 'string' || typeof ref.exe !== 'string' || !path.isAbsolute(ref.exe) || !HASH.test(ref.exeSha256 || '') ||
          !ref.activation || !['owned', 'reused'].includes(ref.activation.mode)) fail('VULKAN_STATE_INVALID', 'Vulkan 游戏引用无效。');
      const key = path.resolve(ref.exe).toLowerCase(); if (seen.has(key)) fail('VULKAN_STATE_INVALID', '同一 EXE 存在重复 Vulkan 引用。'); seen.add(key);
      validateActivationState(ref.activation.before); validateActivationState(ref.activation.after);
      if (ref.activation.groupKey !== undefined && (typeof ref.activation.groupKey !== 'string' || !path.isAbsolute(ref.activation.groupKey) || path.resolve(ref.activation.groupKey).toLowerCase() !== activationGroupKey(ref.exe))) fail('VULKAN_STATE_INVALID', 'Vulkan 游戏激活共享作用域无效。');
      if (ref.activation.ownerBefore !== undefined) validateActivationState(ref.activation.ownerBefore);
      if (ref.activation.ownerAfter !== undefined) validateActivationState(ref.activation.ownerAfter);
    }
    return row;
  }

  async function readReceipt() { return validateReceipt(await readJsonStrict(receiptPath, 'Vulkan 部署收据')); }
  async function readPending() {
    const row = await readJsonStrict(pendingPath, 'Vulkan 恢复记录'); if (!row) return null;
    if (row.version !== 1 || row.product !== PRODUCT || !/^[a-f0-9-]{36}$/i.test(row.transactionId || '') ||
        !['prepare', 'restore'].includes(row.operation) || !['planned', 'committed'].includes(row.stage) ||
        !Object.hasOwn(row, 'beforeReceipt') || !Object.hasOwn(row, 'targetReceipt') || !Array.isArray(row.files)) {
      fail('VULKAN_STATE_INVALID', 'Vulkan 恢复记录无效。');
    }
    if (row.beforeReceipt) validateReceipt(row.beforeReceipt); if (row.targetReceipt) validateReceipt(row.targetReceipt);
    if (row.activation) {
      if (typeof row.activation.exe !== 'string' || !path.isAbsolute(row.activation.exe)) fail('VULKAN_STATE_INVALID', 'Vulkan 激活恢复目标无效。');
      validateActivationState(row.activation.before); validateActivationState(row.activation.after);
      const refs = [...(row.beforeReceipt?.refs || []), ...(row.targetReceipt?.refs || [])];
      if (!refs.some(ref => samePath(ref.exe, row.activation.exe) && equalJson(ref.activation.before, row.activation.before) && equalJson(ref.activation.after, row.activation.after))) fail('VULKAN_STATE_INVALID', 'Vulkan 激活恢复目标未绑定收据。');
    }
    if (row.registry) {
      if (typeof row.registry.name !== 'string' || !path.isAbsolute(row.registry.name)) fail('VULKAN_STATE_INVALID', 'Vulkan 注册表恢复目标无效。');
      validateRegistryState(row.registry.before); validateRegistryState(row.registry.after);
      const layers = [row.beforeReceipt?.layer, row.targetReceipt?.layer].filter(Boolean);
      if (!layers.some(layer => layer.mode === 'owned' && samePath(layer.manifest, row.registry.name) &&
          sameState(layer.registryBefore, row.registry.before) && sameState(layer.registryAfter, row.registry.after))) fail('VULKAN_STATE_INVALID', 'Vulkan 注册表恢复目标未绑定收据。');
    }
    if (row.files.length > 2) fail('VULKAN_STATE_INVALID', 'Vulkan 文件恢复目标过多。');
    const owned = row.beforeReceipt?.layer?.mode === 'owned' ? row.beforeReceipt : row.targetReceipt?.layer?.mode === 'owned' ? row.targetReceipt : null;
    const expectedFiles = owned ? new Map([[path.resolve(owned.layer.manifest).toLowerCase(), owned.recipe.manifestSha256], [path.resolve(owned.layer.library).toLowerCase(), owned.recipe.librarySha256]]) : new Map();
    const seenFiles = new Set();
    for (const item of row.files) {
      if (!item || typeof item.target !== 'string' || !path.isAbsolute(item.target) || !inside(stateRoot, item.target) ||
          item.backup && (typeof item.backup !== 'string' || !path.isAbsolute(item.backup) || !inside(stateRoot, item.backup))) fail('VULKAN_STATE_INVALID', 'Vulkan 文件恢复目标无效。');
      const key = path.resolve(item.target).toLowerCase(), expectedHash = expectedFiles.get(key);
      if (!expectedHash || seenFiles.has(key) || item.before?.exists !== (row.operation === 'restore') || item.after?.exists !== (row.operation === 'prepare') ||
          row.operation === 'restore' && item.before.sha256 !== expectedHash || row.operation === 'prepare' && item.after.sha256 !== expectedHash ||
          row.operation === 'restore' && (!item.backup || !inside(path.join(stateRoot, 'recovery', row.transactionId), item.backup))) {
        fail('VULKAN_STATE_INVALID', 'Vulkan 文件恢复记录与部署收据不一致。');
      }
      seenFiles.add(key);
    }
    return row;
  }

  async function registryRead(name) { return validateRegistryState(await registry.read(name)); }
  async function machineList() {
    if (typeof registry.listMachine !== 'function') return null;
    let rows;
    try { rows = await registry.listMachine(); }
    catch (error) { fail('VULKAN_MACHINE_REGISTRY_UNAVAILABLE', '无法只读检查 HKLM x64 Vulkan layer。', { cause: error.code || 'read' }); }
    if (!Array.isArray(rows) || rows.length > 4096) fail('VULKAN_MACHINE_REGISTRY_INVALID', 'HKLM x64 Vulkan layer 列表无效。');
    return rows;
  }
  async function machineRead(name) {
    const rows = await machineList(); if (!rows) return { exists: false };
    const matches = rows.filter(row => row && typeof row.name === 'string' && path.isAbsolute(row.name) && samePath(row.name, name));
    if (matches.length > 1) fail('VULKAN_MACHINE_REGISTRY_INVALID', 'HKLM x64 Vulkan layer 注册值身份不明确。');
    if (!matches.length) return { exists: false };
    return validateRegistryState(matches[0]);
  }
  async function registryWrite(name, expected, desired) {
    const before = await registryRead(name); if (!sameState(before, expected)) fail('VULKAN_REGISTRY_CHANGED', 'Vulkan 注册表值已被外部修改。');
    await registry.write(name, expected, desired);
    const after = await registryRead(name); if (!sameState(after, desired)) fail('VULKAN_REGISTRY_WRITE', 'Vulkan 注册表写入后读回不一致。');
  }
  async function activationRead(exe) { return validateActivationState(await activation.read(exe)); }
  async function activationToken(exe, marker) {
    return typeof activation.bindToken === 'function' ? await activation.bindToken(exe, marker) : marker;
  }
  async function activationWrite(exe, expected, desired) {
    const before = await activationRead(exe); if (!equalJson(before, expected)) fail('VULKAN_ACTIVATION_CHANGED', '游戏的 Vulkan 激活状态已被外部修改。');
    await activation.write(exe, expected, desired);
    const after = await activationRead(exe); if (!equalJson(after, desired)) fail('VULKAN_ACTIVATION_WRITE', '按 EXE 激活设置写入后读回不一致。');
  }

  async function writeReceipt(row) {
    if (row) await atomicJson(receiptPath, row);
    else { await noLinks(receiptPath); await fsp.unlink(receiptPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async function reconcileFiles(files, direction) {
    for (const item of direction === 'before' ? [...files].reverse() : files) {
      const target = path.resolve(item.target); if (!inside(stateRoot, target)) fail('VULKAN_STATE_INVALID', 'Vulkan 恢复文件路径越界。');
      await noLinks(target);
      const desired = item[direction]; const actual = await digestFile(target);
      if (!desired.exists) {
        if (actual === null) continue;
        const other = direction === 'before' ? item.after : item.before;
        if (!other?.sha256 || actual !== other.sha256) fail('VULKAN_FILE_CHANGED', 'Vulkan layer 文件已被外部修改。', { file: path.basename(target) });
        await fsp.unlink(target); continue;
      }
      if (actual === desired.sha256) continue;
      if (actual !== null) fail('VULKAN_FILE_CHANGED', 'Vulkan layer 文件已被外部修改，未用备份覆盖。', { file: path.basename(target) });
      if (!item.backup || !inside(stateRoot, item.backup) || await digestFile(item.backup) !== desired.sha256) fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan layer 恢复副本缺失或损坏。', { file: path.basename(target) });
      await noLinks(item.backup);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      try { await fsp.copyFile(item.backup, target, fs.constants.COPYFILE_EXCL); }
      catch (error) { if (error.code === 'EEXIST') fail('VULKAN_FILE_CHANGED', 'Vulkan layer 文件在恢复前被外部创建。', { file: path.basename(target) }); throw error; }
      if (await digestFile(target) !== desired.sha256) fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan layer 文件恢复后校验失败。');
    }
  }

  async function restoreActivation(pending) {
    if (!pending.activation) return;
    const desired = pending.operation === 'prepare' ? pending.activation.before : pending.activation.after;
    const changed = pending.operation === 'prepare' ? pending.activation.after : pending.activation.before;
    const current = await activationRead(pending.activation.exe);
    if (equalJson(current, desired)) return;
    if (!equalJson(current, changed)) fail('VULKAN_ACTIVATION_CHANGED', '无法判断未完成操作后的 EXE 激活状态。');
    await activationWrite(pending.activation.exe, changed, desired);
  }
  async function restoreRegistry(pending) {
    if (!pending.registry) return;
    const desired = pending.operation === 'prepare' ? pending.registry.before : pending.registry.after;
    const changed = pending.operation === 'prepare' ? pending.registry.after : pending.registry.before;
    const current = await registryRead(pending.registry.name);
    if (sameState(current, desired)) return;
    if (!sameState(current, changed)) fail('VULKAN_REGISTRY_CHANGED', '无法判断未完成操作后的注册表状态。');
    await registryWrite(pending.registry.name, changed, desired);
  }

  async function verifyPendingEffects(pending, actualReceipt, expectedReceipt, states) {
    if (!equalJson(actualReceipt, expectedReceipt)) fail('VULKAN_RECOVERY_BLOCKED', '恢复收据与目标状态不一致。');
    if (actualReceipt) {
      let blockers;
      try { blockers = await receiptBlockers(actualReceipt); }
      catch (error) { fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标收据状态无法验证。', { cause: error.code || 'state' }); }
      if (blockers.length) fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标收据的文件、注册表或激活状态未完成。', { blockers });
    }
    for (const item of pending.files) {
      let actual, desired = item[states.files];
      try { await noLinks(item.target); actual = await digestFile(item.target); }
      catch (error) { fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标文件状态无法验证。', { cause: error.code || 'state' }); }
      if (desired.exists ? actual !== desired.sha256 : actual !== null) {
        fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标文件状态未完成。', { file: path.basename(item.target) });
      }
    }
    if (pending.registry) {
      const desired = pending.registry[states.registry];
      try {
        if (!sameState(await registryRead(pending.registry.name), desired)) fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标注册表状态未完成。');
      } catch (error) { if (error.code === 'VULKAN_RECOVERY_BLOCKED') throw error; fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标注册表状态无法验证。', { cause: error.code || 'state' }); }
    }
    if (pending.activation) {
      const desired = pending.activation[states.activation];
      try {
        if (!equalJson(await activationRead(pending.activation.exe), desired)) fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标激活状态未完成。');
      } catch (error) { if (error.code === 'VULKAN_RECOVERY_BLOCKED') throw error; fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan 目标激活状态无法验证。', { cause: error.code || 'state' }); }
    }
  }

  async function recoverLocked() {
    assertAdapters();
    const pending = await readPending(); if (!pending) return { recovered: false };
    const receipt = await readReceipt();
    if (equalJson(receipt, pending.targetReceipt)) {
      await verifyPendingEffects(pending, receipt, pending.targetReceipt, pending.operation === 'prepare'
        ? { files: 'after', registry: 'after', activation: 'after' }
        : { files: 'after', registry: 'before', activation: 'before' });
      await fsp.unlink(pendingPath); return { recovered: true, completed: true };
    }
    if (!equalJson(receipt, pending.beforeReceipt)) fail('VULKAN_RECOVERY_BLOCKED', '当前 Vulkan 收据与恢复记录不一致。');
    if (pending.operation === 'prepare') {
      await restoreActivation(pending); await restoreRegistry(pending); await reconcileFiles(pending.files, 'before');
    } else {
      await reconcileFiles(pending.files, 'before'); await restoreRegistry(pending); await restoreActivation(pending);
    }
    await writeReceipt(pending.beforeReceipt);
    await verifyPendingEffects(pending, await readReceipt(), pending.beforeReceipt, pending.operation === 'prepare'
      ? { files: 'before', registry: 'before', activation: 'before' }
      : { files: 'before', registry: 'after', activation: 'after' });
    await fsp.unlink(pendingPath); return { recovered: true, rolledBack: true };
  }

  async function receiptBlockers(receipt) {
    const blockers = [];
    const reg = receipt.layer.registryScope === 'HKLM' ? await machineRead(receipt.layer.manifest) : await registryRead(receipt.layer.manifest);
    if (!sameState(reg, receipt.layer.registryAfter)) blockers.push(`${receipt.layer.mode === 'owned' ? 'Manager 自有' : '外部复用'} Vulkan 注册值与收据不一致。`);
    if (receipt.layer.mode === 'owned') for (const [file, hash] of [[receipt.layer.manifest, receipt.recipe.manifestSha256], [receipt.layer.library, receipt.recipe.librarySha256]]) {
      try { await noLinks(file); if (await digestFile(file) !== hash) blockers.push(`${path.basename(file)} 与收据摘要不一致。`); }
      catch { blockers.push(`${path.basename(file)} 的路径或链接状态不安全。`); }
    }
    if (receipt.layer.mode === 'reused') for (const [file, hash] of [[receipt.layer.manifest, receipt.layer.manifestSha256], [receipt.layer.library, receipt.layer.librarySha256]]) {
      try { await noLinks(file); if (await digestFile(file) !== hash) blockers.push(`外部 ${path.basename(file)} 与复用收据摘要不一致。`); }
      catch { blockers.push(`外部 ${path.basename(file)} 的路径或链接状态不安全。`); }
    }
    for (const ref of receipt.refs) if (!equalJson(await activationRead(ref.exe), ref.activation.after)) blockers.push(`${path.basename(ref.exe)} 的 Vulkan 激活状态与收据不一致。`);
    return blockers;
  }

  async function inspectLocked(game) {
      assertAdapters(); const target = validateGame(game); const pending = await readPending();
      if (pending) return { status: 'pending', ready: false, pending: { operation: pending.operation, transactionId: pending.transactionId }, blockers: ['Vulkan 部署有未完成恢复记录。'] };
      const receipt = await readReceipt(); if (!receipt) return { status: 'absent', ready: false, refs: [], owned: false, blockers: [] };
      const ref = receipt.refs.find(item => samePath(item.exe, target.exe)) || null;
      const blockers = await receiptBlockers(receipt);
      return { status: blockers.length ? 'blocked' : 'ready', ready: blockers.length === 0 && Boolean(ref), refs: receipt.refs.map(item => ({ id: item.id, exe: item.exe })),
        owned: receipt.layer.mode === 'owned', reused: receipt.layer.mode === 'reused', blockers, recipe: receipt.recipe };
  }
  async function inspect(game) { return locked(() => inspectLocked(game)); }

  async function prepare(game, recipe, previewOnly = false) {
    const run = previewOnly ? async work => { await noLinks(lockPath); if (fs.existsSync(lockPath)) fail('VULKAN_BUSY', 'Vulkan 部署正在进行，请稍后重新预览。'); return work(); } : locked;
    return run(async () => {
      assertAdapters(); const target = validateGame(game);
      if (await readPending()) fail('VULKAN_RECOVERY_FIRST', '请先恢复未完成的 Vulkan 部署操作。');
      const launch = await inspectLaunchContext(target);
      if (!launch || launch.elevated !== false) fail('VULKAN_ELEVATED_HKCU', '当前启动方式不能证明游戏以普通权限读取 HKCU Vulkan layer，未部署。');
      await noLinks(target.exe); if (pe.getBitness(target.exe) !== 64) fail('VULKAN_GAME_ARCH', '当前 Vulkan 部署基础只支持 x64 游戏。');
      const exeSha256 = await digestFile(target.exe); if (!exeSha256) fail('VULKAN_BAD_GAME', '游戏 EXE 不存在或无法读取。');
      const verified = await validateRecipe(recipe); let receipt = await readReceipt();
      if (receipt && !equalJson(receipt.recipe, { id: recipe.id, release: recipe.release, manifestSha256: recipe.layer.manifestSha256, librarySha256: recipe.layer.librarySha256 })) {
        fail('VULKAN_RECIPE_CONFLICT', '现有 Vulkan layer 或游戏引用属于另一份 recipe/EXE。');
      }
      if (receipt) {
        const blockers = await receiptBlockers(receipt);
        if (blockers.length) fail('VULKAN_STATE_CHANGED', '现有 Vulkan layer 状态与收据不一致，未增加新引用。', { blockers });
      }
      if (receipt?.refs.some(ref => samePath(ref.exe, target.exe))) return { prepared: false, unchanged: true, changes: [], ...(await inspectLocked(target)) };

      const tx = crypto.randomUUID(), targetDir = path.join(layerRoot, recipe.id);
      const targetManifest = path.join(targetDir, path.basename(recipe.layer.manifest));
      const targetLibrary = path.join(targetDir, path.basename(recipe.layer.library));
      let layer;
      if (receipt) layer = receipt.layer;
      else {
        const machineValues = await machineList();
        if (machineValues) {
          const machineCandidates = [];
          for (const value of machineValues) {
            if (!value || value.type !== 'REG_DWORD' || !['0', '0x0'].includes(String(value.data).toLowerCase()) || typeof value.name !== 'string' || !path.isAbsolute(value.name)) continue;
            try {
              if (/^\\\\/.test(value.name)) continue;
              await noLinks(value.name);
              const stat = await fsp.stat(value.name); if (!stat.isFile() || stat.size > 64 * 1024) continue;
              const data = JSON.parse(await fsp.readFile(value.name, 'utf8'));
              if (data?.layer?.name === recipe.layer.name) machineCandidates.push({ value, data });
            } catch {}
          }
          if (machineCandidates.length) {
            const verifier = externalLayer?.verifyMachine || externalLayer?.verify;
            if (typeof verifier !== 'function') fail('VULKAN_MACHINE_LAYER_CONFLICT', '检测到 HKLM x64 中已有同名 Vulkan layer，但无法安全验证复用；未写入 HKCU。');
            const accepted = [];
            for (const candidate of machineCandidates) {
              const result = await verifier({ manifestPath: candidate.value.name, manifest: candidate.data, recipe, registryScope: 'HKLM', registryView: '64' });
              if (result?.valid !== true || typeof result.library !== 'string' || !path.isAbsolute(result.library)) continue;
              const expectedLibrary = path.resolve(path.dirname(candidate.value.name), candidate.data?.layer?.library_path || '');
              if (!samePath(expectedLibrary, result.library) || pe.getBitness(result.library) !== 64 || !candidate.data.layer.disable_environment) continue;
              await noLinks(candidate.value.name); await noLinks(result.library);
              const manifestSha256 = await digestFile(candidate.value.name), librarySha256 = await digestFile(result.library);
              if (manifestSha256 && librarySha256) accepted.push({ candidate, result, manifestSha256, librarySha256 });
            }
            if (accepted.length !== 1) fail('VULKAN_MACHINE_LAYER_CONFLICT', 'HKLM x64 中已有同名 Vulkan layer，但无法唯一验证复用；未写入 HKCU。');
            layer = { mode: 'reused', registryScope: 'HKLM', manifest: path.resolve(accepted[0].candidate.value.name), library: path.resolve(accepted[0].result.library), identity: String(accepted[0].result.identity || ''),
              manifestSha256: accepted[0].manifestSha256, librarySha256: accepted[0].librarySha256,
              registryAfter: validateRegistryState({ exists: true, type: accepted[0].candidate.value.type, data: accepted[0].candidate.value.data }) };
          }
        }
        if (layer) {
          // A verified machine layer is reused in place; never create a same-name HKCU value.
        } else {
        const values = await registry.list(); if (!Array.isArray(values)) fail('VULKAN_REGISTRY_INVALID', '无法枚举 Vulkan layer 注册值。');
        const candidates = [];
        for (const value of values) {
          if (!value || value.type !== 'REG_DWORD' || !['0', '0x0'].includes(String(value.data).toLowerCase()) || typeof value.name !== 'string' || !path.isAbsolute(value.name)) continue;
          try {
            if (/^\\\\/.test(value.name)) continue;
            const stat = await fsp.stat(value.name); if (!stat.isFile() || stat.size > 64 * 1024) continue;
            const data = JSON.parse(await fsp.readFile(value.name, 'utf8'));
            if (data?.layer?.name === recipe.layer.name) candidates.push({ value, data });
          } catch {}
        }
        if (candidates.length) {
          if (!externalLayer || typeof externalLayer.verify !== 'function') fail('VULKAN_EXTERNAL_UNVERIFIED', '检测到外部 Vulkan layer，但缺少安全复用验证。');
          const accepted = [];
          for (const candidate of candidates) {
            const result = await externalLayer.verify({ manifestPath: candidate.value.name, manifest: candidate.data, recipe });
            if (result?.valid === true && typeof result.library === 'string' && path.isAbsolute(result.library)) {
              const expectedLibrary = path.resolve(path.dirname(candidate.value.name), candidate.data?.layer?.library_path || '');
              if (!samePath(expectedLibrary, result.library) || pe.getBitness(result.library) !== 64 || !candidate.data.layer.disable_environment) continue;
              await noLinks(candidate.value.name); await noLinks(result.library);
              const manifestSha256 = await digestFile(candidate.value.name), librarySha256 = await digestFile(result.library);
              if (manifestSha256 && librarySha256) accepted.push({ candidate, result, manifestSha256, librarySha256 });
            }
          }
          if (accepted.length !== 1) fail('VULKAN_EXTERNAL_UNVERIFIED', '外部 Vulkan layer 无法唯一验证，未接管。');
          layer = { mode: 'reused', manifest: path.resolve(accepted[0].candidate.value.name), library: path.resolve(accepted[0].result.library), identity: String(accepted[0].result.identity || ''),
            manifestSha256: accepted[0].manifestSha256, librarySha256: accepted[0].librarySha256,
            registryAfter: validateRegistryState({ exists: true, type: accepted[0].candidate.value.type, data: accepted[0].candidate.value.data }) };
        } else {
          await noLinks(targetDir);
          if (fs.existsSync(targetDir)) {
            const entries = await fsp.readdir(targetDir);
            if (entries.length) fail('VULKAN_FILE_CHANGED', 'Manager layer 目录已存在但没有有效收据。');
            try { if (!previewOnly) await fsp.rmdir(targetDir); }
            catch (error) { if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') fail('VULKAN_FILE_CHANGED', 'Manager layer 目录在重试前被外部创建。'); throw error; }
          }
          const registryBefore = await registryRead(targetManifest);
          if (registryBefore.exists) fail('VULKAN_REGISTRY_CHANGED', 'Manager layer 注册值已存在但没有有效收据。');
          layer = { mode: 'owned', manifest: targetManifest, library: targetLibrary, registryBefore, registryAfter: { exists: true, type: 'REG_DWORD', data: 0 } };
        }
        }
      }

      const activationBefore = await activationRead(target.exe);
      const groupKey = activationGroupKey(target.exe);
      const sharedRefs = receipt?.refs.filter(item => refGroupKey(item) === groupKey) || [];
      const owner = sharedRefs.find(item => item.activation.ownerBefore && item.activation.ownerAfter) || sharedRefs.find(item => item.activation.mode === 'owned');
      const activationAfter = owner ? (owner.activation.ownerAfter || owner.activation.after) : activationBefore.active ? activationBefore : { active: true, token: previewOnly ? 'planned-owned-activation' : await activationToken(target.exe, `${PRODUCT}:${tx}`) };
      const ownerBefore = owner ? (owner.activation.ownerBefore || owner.activation.before) : activationBefore;
      const ownerAfter = owner ? (owner.activation.ownerAfter || owner.activation.after) : activationAfter;
      const ownsActivation = !activationBefore.active && !owner;
      const activation = { mode: ownsActivation ? 'owned' : 'reused', before: activationBefore, after: activationAfter, groupKey,
        ...(ownsActivation || owner ? { ownerBefore, ownerAfter } : {}) };
      const ref = { id: target.id, exe: target.exe, exeSha256, activation };
      const targetReceipt = receipt ? { ...receipt, refs: [...receipt.refs, ref], updatedAt: new Date().toISOString() } : {
        version: 1, product: PRODUCT, registry: { ...registry.identity }, recipe: { id: recipe.id, release: recipe.release, manifestSha256: recipe.layer.manifestSha256, librarySha256: recipe.layer.librarySha256 },
        layer, refs: [ref], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      const files = layer.mode === 'owned' && !receipt ? [
        { source: verified.manifest, target: targetManifest, before: { exists: false }, after: { exists: true, sha256: recipe.layer.manifestSha256 } },
        { source: verified.library, target: targetLibrary, before: { exists: false }, after: { exists: true, sha256: recipe.layer.librarySha256 } }
      ] : [];
      const pending = { version: 1, product: PRODUCT, transactionId: tx, operation: 'prepare', stage: 'planned', beforeReceipt: receipt, targetReceipt,
        registry: layer.mode === 'owned' && !receipt ? { name: targetManifest, before: layer.registryBefore, after: layer.registryAfter } : null,
        activation: activationBefore.active ? null : { exe: target.exe, before: activationBefore, after: activationAfter }, files };
      if (previewOnly) return deploymentPreview(pending, layer, false);
      await atomicJson(pendingPath, pending);
      try {
        if (files.length) {
          await noLinks(layerRoot); await fsp.mkdir(layerRoot, { recursive: true });
          try { await fsp.mkdir(targetDir); }
          catch (error) { if (error.code === 'EEXIST') fail('VULKAN_FILE_CHANGED', 'Manager layer 目录在复制前被外部创建。'); throw error; }
        }
        for (const item of files) {
          await noLinks(item.target);
          try { await fsp.copyFile(item.source, item.target, fs.constants.COPYFILE_EXCL); }
          catch (error) { if (error.code === 'EEXIST') fail('VULKAN_FILE_CHANGED', 'Vulkan layer 目标文件在复制前被外部创建。', { file: path.basename(item.target) }); throw error; }
          if (await digestFile(item.target) !== item.after.sha256) fail('VULKAN_RECIPE_HASH', 'Vulkan layer 复制后摘要不一致。');
        }
        if (files.length) {
          const expected = files.map(item => path.basename(item.target)).sort();
          const actual = (await fsp.readdir(targetDir)).sort();
          if (!equalJson(actual, expected)) fail('VULKAN_FILE_CHANGED', 'Manager layer 目录在复制期间出现外部文件。');
        }
        if (pending.registry) await registryWrite(pending.registry.name, pending.registry.before, pending.registry.after);
        if (pending.activation) await activationWrite(pending.activation.exe, pending.activation.before, pending.activation.after);
        await writeReceipt(targetReceipt); pending.stage = 'committed'; await atomicJson(pendingPath, pending); await fsp.unlink(pendingPath);
        return { prepared: true, owned: layer.mode === 'owned', reused: layer.mode === 'reused', refs: targetReceipt.refs.length, runtimeVerified: false };
      } catch (error) { error.details = { ...error.details, recoveryRequired: true }; throw error; }
    });
  }

  async function restore(game, previewOnly = false) {
    const run = previewOnly ? async work => { await noLinks(lockPath); if (fs.existsSync(lockPath)) fail('VULKAN_BUSY', 'Vulkan 部署正在进行，请稍后重新预览。'); return work(); } : locked;
    return run(async () => {
      assertAdapters(); const target = validateGame(game); if (await readPending()) fail('VULKAN_RECOVERY_FIRST', '请先恢复未完成的 Vulkan 部署操作。');
      const receipt = await readReceipt(); if (!receipt) return { restored: false, unchanged: true, changes: [] };
      const index = receipt.refs.findIndex(ref => samePath(ref.exe, target.exe));
      if (index < 0) return { restored: false, unchanged: true, changes: [] };
      const ref = receipt.refs[index]; await noLinks(ref.exe);
      if (await digestFile(ref.exe) !== ref.exeSha256 && fs.existsSync(ref.exe)) fail('VULKAN_GAME_CHANGED', '游戏 EXE 与 Vulkan 引用记录不一致。');
      let refs = receipt.refs.filter((_, i) => i !== index);
      const groupKey = refGroupKey(ref);
      const remainingGroupRefs = refs.filter(item => refGroupKey(item) === groupKey);
      if (ref.activation.mode === 'owned' && remainingGroupRefs.length) {
        const ownerBefore = ref.activation.ownerBefore || ref.activation.before;
        const ownerAfter = ref.activation.ownerAfter || ref.activation.after;
        const transfer = remainingGroupRefs[0];
        refs = refs.map(item => item === transfer ? { ...item, activation: { ...item.activation, mode: 'owned', before: ownerBefore, after: ownerAfter,
          ownerBefore, ownerAfter } } : item);
      }
      const targetReceipt = refs.length ? { ...receipt, refs, updatedAt: new Date().toISOString() } : null;
      const tx = crypto.randomUUID(), backupDir = path.join(stateRoot, 'recovery', tx); const files = [];
      if (!refs.length && receipt.layer.mode === 'owned') for (const [targetFile, hash] of [[receipt.layer.manifest, receipt.recipe.manifestSha256], [receipt.layer.library, receipt.recipe.librarySha256]]) {
        await noLinks(targetFile);
        if (await digestFile(targetFile) !== hash) fail('VULKAN_FILE_CHANGED', 'Manager 自有 Vulkan layer 文件已被外部修改。', { file: path.basename(targetFile) });
        files.push({ target: targetFile, backup: path.join(backupDir, path.basename(targetFile)), before: { exists: true, sha256: hash }, after: { exists: false } });
      }
      const activationCurrent = await activationRead(ref.exe);
      if (ref.activation.mode === 'owned' && !equalJson(activationCurrent, ref.activation.after)) fail('VULKAN_ACTIVATION_CHANGED', '游戏的 Vulkan 激活状态已被外部修改。');
      const pending = { version: 1, product: PRODUCT, transactionId: tx, operation: 'restore', stage: 'planned', beforeReceipt: receipt, targetReceipt,
        activation: ref.activation.mode === 'owned' && !remainingGroupRefs.length ? { exe: ref.exe, before: ref.activation.before, after: ref.activation.after } : null,
        registry: !refs.length && receipt.layer.mode === 'owned' ? { name: receipt.layer.manifest, before: receipt.layer.registryBefore, after: receipt.layer.registryAfter } : null, files };
      if (previewOnly) {
        const currentRegistry = receipt.layer.registryScope === 'HKLM' ? await machineRead(receipt.layer.manifest) : await registryRead(receipt.layer.manifest);
        if (!sameState(currentRegistry, receipt.layer.registryAfter)) fail('VULKAN_REGISTRY_CHANGED', 'Vulkan 注册值在恢复前已改变。');
        return deploymentPreview(pending, receipt.layer, true);
      }
      await atomicJson(pendingPath, pending);
      try {
        for (const item of files) {
          await noLinks(item.backup); await fsp.mkdir(path.dirname(item.backup), { recursive: true });
          try { await fsp.copyFile(item.target, item.backup, fs.constants.COPYFILE_EXCL); }
          catch (error) { if (error.code === 'EEXIST') fail('VULKAN_RECOVERY_BLOCKED', 'Vulkan layer 恢复副本在复制前被外部创建。'); throw error; }
          if (await digestFile(item.backup) !== item.before.sha256) fail('VULKAN_RECOVERY_BLOCKED', '无法建立 Vulkan layer 恢复副本。');
        }
        if (pending.activation) await activationWrite(pending.activation.exe, pending.activation.after, pending.activation.before);
        if (pending.registry) await registryWrite(pending.registry.name, pending.registry.after, pending.registry.before);
        await reconcileFiles(files, 'after'); await writeReceipt(targetReceipt);
        pending.stage = 'committed'; await atomicJson(pendingPath, pending); await fsp.unlink(pendingPath);
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        return { restored: true, refs: refs.length, layerRemoved: !refs.length && receipt.layer.mode === 'owned', externalPreserved: receipt.layer.mode === 'reused' };
      } catch (error) { error.details = { ...error.details, recoveryRequired: true }; throw error; }
    });
  }

  async function recover() { return locked(recoverLocked); }

  async function deploymentPreview(pending, layer, removing) {
    const changes = pending.files.map(file => ({ path: file.target, name: path.basename(file.target), role: 'vulkan-layer',
      beforeSha256: file.before.sha256 || null, afterSha256: file.after.sha256 || null, action: removing ? 'remove' : 'create' }));
    if (!pending.files.length) for (const [file, hash] of [[layer.manifest, layer.manifestSha256 || pending.beforeReceipt?.recipe.manifestSha256],
      [layer.library, layer.librarySha256 || pending.beforeReceipt?.recipe.librarySha256]])
      changes.push({ path: file, name: path.basename(file), role: 'vulkan-layer', beforeSha256: hash, afterSha256: hash, action: 'keep', reused: layer.mode === 'reused' });
    const registryChange = pending.registry;
    changes.push({ path: `${layer.registryScope || 'HKCU'}\\${registry.identity.key}\\${layer.manifest}`, name: layer.manifest,
      role: 'vulkan-registry', type: 'registry', action: registryChange ? removing ? 'restore' : 'create' : 'keep',
      before: registryChange ? registryChange[removing ? 'after' : 'before'] : layer.registryAfter,
      after: registryChange ? registryChange[removing ? 'before' : 'after'] : layer.registryAfter });
    if (pending.activation) {
      const file = path.join(path.dirname(pending.activation.exe), 'ReShade.ini');
      changes.push({ path: file, name: 'ReShade.ini', role: 'vulkan-activation', beforeSha256: await digestFile(file),
        ...(removing ? { afterSha256: null } : {}), action: removing ? 'archive-remove' : 'create' });
    }
    changes.push({ path: receiptPath, name: path.basename(receiptPath), role: 'receipt', beforeSha256: await digestFile(receiptPath),
      ...(pending.targetReceipt ? {} : { afterSha256: null }), action: pending.targetReceipt ? pending.beforeReceipt ? 'update' : 'create' : 'remove' });
    return { changes, owned: layer.mode === 'owned', reused: layer.mode === 'reused', refs: pending.targetReceipt?.refs.length || 0, runtimeVerified: false };
  }

  return Object.freeze({ inspect, prepare, restore, recover, previewPrepare: (game, recipe) => prepare(game, recipe, true),
    previewRestore: game => restore(game, true), peek: inspectLocked, receiptPath, pendingPath, lockPath });
}

module.exports = { createVulkanDeployment, PRODUCT };
