'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, atomicJson } = require('./launch-safety');
const { hashRegularFile } = require('./streamed-file-digest');
const { snapshotAddonLoadingLayout, assertAddonSnapshot } = require('./addon-loading-layout');

const RECEIPT = '_DLSS5_Backup/xiaofeng-user-addons.json';
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const digest = file => hashRegularFile(file, { assertPath: noLinks, maxBytes: 256 * 1024 * 1024 });
const same = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

function executable(game) {
  const value = game?.scan?.chosen?.path || game?.chosen?.path;
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.exe')
    fail('USER_ADDON_GAME', '所选游戏程序无效，请重新选择 EXE。');
  return path.resolve(value);
}

function receiptFile(game) { return path.join(path.resolve(game.dir), RECEIPT); }

async function readReceipt(game) {
  const file = receiptFile(game);
  try {
    await noLinks(file); const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) fail('USER_ADDON_RECEIPT', '用户 Add-on 安装记录无效。');
    const value = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (value?.schema !== 1 || !Array.isArray(value.items) || value.items.length > 128 || value.items.some(row =>
      !row || typeof row.componentId !== 'string' || typeof row.target !== 'string' || !path.isAbsolute(row.target) ||
      path.basename(row.target) !== row.name || !/\.addon64$/i.test(row.name || '') || !HASH.test(row.sha256 || '')))
      fail('USER_ADDON_RECEIPT', '用户 Add-on 安装记录无效。');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { schema: 1, gameId: game.id, items: [] };
    if (error instanceof SyntaxError) fail('USER_ADDON_RECEIPT', '用户 Add-on 安装记录无效。');
    throw error;
  }
}

function packageFile(root, item) {
  if (!item || item.kind !== 'user-addon' || item.architecture !== 'x64' || !Array.isArray(item.files) || item.files.length !== 1)
    fail('USER_ADDON_PACKAGE', '请选择已导入的 64 位用户 Add-on。');
  const row = item.files[0];
  if (!row || typeof row.file !== 'string' || path.isAbsolute(row.file) || row.file.includes('..') ||
      path.basename(row.name || '') !== row.name || !/\.addon64$/i.test(row.name) || !HASH.test(row.sha256 || ''))
    fail('USER_ADDON_PACKAGE', '用户 Add-on 库记录无效。');
  const source = path.resolve(root, row.file);
  const relative = path.relative(path.resolve(root), source);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail('USER_ADDON_PACKAGE', '用户 Add-on 来源超出组件仓库。');
  return { ...row, source };
}

function createUserAddonManager({ componentRoot, assertGameClosed, environment = process.env }) {
  async function snapshot(game) {
    const exe = executable(game);
    return snapshotAddonLoadingLayout({ exeDir: path.dirname(exe), gameId: game.id, architecture: 64, environment });
  }

  async function inspect(game, packages, enabled) {
    const receipt = await readReceipt(game), current = enabled ? await snapshot(game) : null;
    return Promise.all(packages.filter(row => row.kind === 'user-addon').map(async item => {
      const file = packageFile(componentRoot, item), target = current ? path.join(current.profile.addonDir, file.name) : null;
      const owned = receipt.items.find(row => row.componentId === item.id);
      let currentHash = null;
      if (target && fs.existsSync(target)) try { currentHash = await digest(target); } catch {}
      return { id: item.id, label: item.variant || item.version || file.name, name: file.name,
        classification: item.classification || 'unknown', canApply: Boolean(enabled && current && !current.blockers.length),
        installed: Boolean(owned && target && path.resolve(owned.target).toLowerCase() === path.resolve(target).toLowerCase() && currentHash === file.sha256),
        present: Boolean(currentHash), managed: Boolean(owned), changed: Boolean(owned && currentHash && currentHash !== file.sha256),
        sha256: file.sha256, target };
    }));
  }

  async function setEnabled(game, item, enabled) {
    const file = packageFile(componentRoot, item), exe = executable(game), current = await snapshot(game);
    if (current.blockers.length) fail('USER_ADDON_LAYOUT', '当前 ReShade Add-on 路径无法安全确认，请先在维护页修复加载环境。', { blockers: current.blockers });
    await assertAddonSnapshot(current, { environment });
    await assertGameClosed(path.resolve(game.dir), exe);
    await noLinks(file.source);
    if (!fs.existsSync(file.source) || await digest(file.source) !== file.sha256) fail('USER_ADDON_PACKAGE', '组件仓库中的用户 Add-on 已改变，请重新导入。');
    const target = path.join(current.profile.addonDir, file.name), receipt = await readReceipt(game);
    await noLinks(target);
    const owned = receipt.items.find(row => row.componentId === item.id);
    if (enabled) {
      if (fs.existsSync(target)) {
        const existing = await digest(target);
        if (existing !== file.sha256) fail('USER_ADDON_COLLISION', `游戏的 Add-on 目录已有同名文件：${file.name}。为避免覆盖其他模组，本次未修改。`);
        if (!owned) return { changed: false, alreadyPresent: true, notice: '游戏中已有完全相同的 Add-on；管理器没有取得或伪造其所有权。' };
        return { changed: false, installed: true, notice: '这个用户 Add-on 已经加载。' };
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${crypto.randomUUID()}.part`;
      try {
        await fsp.copyFile(file.source, temp, fs.constants.COPYFILE_EXCL);
        if (await digest(temp) !== file.sha256) fail('USER_ADDON_COPY', '复制用户 Add-on 后校验不一致。');
        await fsp.rename(temp, target);
        receipt.items = receipt.items.filter(row => row.componentId !== item.id);
        receipt.items.push({ componentId: item.id, name: file.name, target, sha256: file.sha256, installedAt: new Date().toISOString() });
        try { await atomicJson(receiptFile(game), receipt); }
        catch (error) { await fsp.unlink(target).catch(() => {}); throw error; }
      } finally { await fsp.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { changed: true, installed: true, notice: '用户 Add-on 已复制到当前 ReShade 加载目录；请重启游戏验证。' };
    }
    if (!owned) return { changed: false, installed: false, notice: '该文件不是由本管理器部署，未删除。' };
    if (!same(owned.target, target)) fail('USER_ADDON_CHANGED', 'ReShade 加载目录已经改变；未从旧位置自动删除文件，请先恢复原加载布局。');
    if (!fs.existsSync(target) || await digest(target) !== owned.sha256) fail('USER_ADDON_CHANGED', '用户 Add-on 已被外部修改或移动，未自动删除。');
    const parked = `${target}.${crypto.randomUUID()}.remove`;
    await fsp.rename(target, parked);
    receipt.items = receipt.items.filter(row => row !== owned);
    try { await atomicJson(receiptFile(game), receipt); }
    catch (error) { await fsp.rename(parked, target).catch(() => {}); throw error; }
    await fsp.unlink(parked);
    return { changed: true, installed: false, notice: '已移除管理器部署的用户 Add-on。' };
  }

  async function removeAll(game) {
    const receipt = await readReceipt(game);
    if (!receipt.items.length) return { removed: false, unchanged: true };
    const current = await snapshot(game);
    if (current.blockers.length) fail('USER_ADDON_LAYOUT', '当前 ReShade Add-on 路径无法安全确认，未自动删除用户 Add-on。', { blockers: current.blockers });
    await assertAddonSnapshot(current, { environment });
    await assertGameClosed(path.resolve(game.dir), executable(game));
    for (const row of [...receipt.items]) {
      if (!same(path.dirname(row.target), current.profile.addonDir))
        fail('USER_ADDON_CHANGED', `用户 Add-on 的原加载目录与当前布局不一致，未删除：${row.name}`);
      const currentHash = fs.existsSync(row.target) ? await digest(row.target) : null;
      if (currentHash && currentHash !== row.sha256) fail('USER_ADDON_CHANGED', `用户 Add-on 已被修改，未删除：${row.name}`);
      if (currentHash) { await noLinks(row.target); await fsp.unlink(row.target); }
    }
    receipt.items = [];
    await atomicJson(receiptFile(game), receipt);
    return { removed: true };
  }

  return { inspect, setEnabled, removeAll, readReceipt };
}

module.exports = { createUserAddonManager, RECEIPT, packageFile };

