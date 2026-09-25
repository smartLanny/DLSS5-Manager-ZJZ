'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TextDecoder } = require('util');

const DEFAULTS = Object.freeze({
  version: 1,
  animationsEnabled: true,
  theme: 'system',
  scanDrives: false,
  scanFolders: [],
  manualGames: [],
  manualExecutables: [],
  gameOverrides: {},
  excludedRoots: [],
  excludedGames: [],
  lastSelectedGame: null,
  payloadSourcePath: null,
  payloadSourceIdentity: null,
  componentLibraryPath: null,
  componentLibraryPreviousPath: null,
  addonVersion: null
});

const absolutePath = value => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value);

function uniquePaths(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!absolutePath(row)) continue;
    const key = path.resolve(row).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(row));
  }
  return out;
}

function uniqueManualExecutables(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || typeof row.root !== 'string' || typeof row.file !== 'string') continue;
    if (!absolutePath(row.root) || !absolutePath(row.file) || !/\.exe$/i.test(row.file)) continue;
    const root = path.resolve(row.root);
    const file = path.resolve(row.file);
    const key = `${root.toLowerCase()}|${file.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ root, file });
  }
  return out;
}

function normalizeGameOverrides(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawDir, row] of Object.entries(value)) {
    if (!absolutePath(rawDir) || !row || typeof row !== 'object') continue;
    const dir = path.resolve(rawDir).toLowerCase();
    const name = typeof row.name === 'string' ? row.name.trim().slice(0, 160) : '';
    const icon = typeof row.icon === 'string' && row.icon.length <= 1024 * 1024 ? row.icon : null;
    const api = ['dx9', 'dx10', 'dx11', 'dx12', 'vulkan', 'opengl'].includes(row.api) ? row.api : 'auto';
    const apiExecutable = absolutePath(row.apiExecutable)
      ? path.resolve(row.apiExecutable) : null;
    const launchMode = ['steam', 'exe'].includes(row.launchMode) ? row.launchMode : 'auto';
    const launchExecutable = absolutePath(row.launchExecutable) && /\.exe$/i.test(row.launchExecutable)
      ? path.resolve(row.launchExecutable) : null;
    if (!name && !icon && (api === 'auto' || !apiExecutable) && (launchMode === 'auto' || !launchExecutable)) continue;
    out[dir] = { name, icon, api, apiExecutable,
      ...(launchExecutable ? { launchMode, launchExecutable } : {}) };
  }
  return out;
}

function normalizeExcludedGames(value) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(value) ? value : []) {
    if (!row || typeof row !== 'object') continue;
    const dir = absolutePath(row.dir) ? path.resolve(row.dir) : null;
    const executable = absolutePath(row.executable) && /\.exe$/i.test(row.executable)
      ? path.resolve(row.executable)
      : null;
    const launcher = typeof row.launcher === 'string' ? row.launcher.slice(0, 80) : '';
    const id = typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : null;
    const appid = typeof row.appid === 'string' || typeof row.appid === 'number' ? String(row.appid) : null;
    if (!dir && !executable && !(launcher && (id || appid))) continue;
    const key = [dir && dir.toLowerCase(), executable && executable.toLowerCase(), launcher.toLowerCase(), id || '', appid || ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir, executable, launcher, id, appid });
  }
  return out;
}

function validate(value) {
  const state = value && value.version === 1 ? value : {};
  return {
    ...DEFAULTS,
    ...state,
    version: 1,
    animationsEnabled: state.animationsEnabled !== false,
    theme: ['system', 'light', 'dark'].includes(state.theme) ? state.theme : 'system',
    scanDrives: state.scanDrives === true,
    scanFolders: uniquePaths(state.scanFolders),
    manualGames: uniquePaths(state.manualGames),
    manualExecutables: uniqueManualExecutables(state.manualExecutables),
    gameOverrides: normalizeGameOverrides(state.gameOverrides),
    excludedRoots: uniquePaths(state.excludedRoots),
    excludedGames: normalizeExcludedGames(state.excludedGames),
    lastSelectedGame: typeof state.lastSelectedGame === 'string' ? state.lastSelectedGame : null,
    payloadSourcePath: absolutePath(state.payloadSourcePath) ? path.resolve(state.payloadSourcePath) : null,
    payloadSourceIdentity: typeof state.payloadSourceIdentity === 'string' && /^[a-f0-9]{64}$/i.test(state.payloadSourceIdentity) ? state.payloadSourceIdentity.toLowerCase() : null,
    componentLibraryPath: absolutePath(state.componentLibraryPath) ? path.resolve(state.componentLibraryPath) : null,
    componentLibraryPreviousPath: absolutePath(state.componentLibraryPreviousPath) ? path.resolve(state.componentLibraryPreviousPath) : null,
    addonVersion: typeof state.addonVersion === 'string' ? state.addonVersion : null
  };
}

function createStore(file, options = {}) {
  file = path.resolve(file);
  const io = options.fs || fs;
  let status = { state: 'unread', file, backupFile: null, writeBlocked: false, message: null, changedFields: [] };
  let lastBytes = null, preserved = null, writes = Promise.resolve();
  function failure(code, message, cause) {
    return Object.assign(new Error(message), { code, details: { file, ...(cause?.code ? { causeCode: cause.code } : {}) }, ...(cause ? { cause } : {}) });
  }
  function report(error, reason) {
    status = { ...status, state: 'error', reason, writeBlocked: true, message: error.message, error: { code: error.code, ...error.details } };
    return error;
  }
  function preserve(bytes, reason, changedFields) {
    if (!preserved || !preserved.bytes.equals(bytes)) {
      const backupFile = `${file}.recovery-${randomUUID()}.json`;
      try {
        io.writeFileSync(backupFile, bytes, { flag: 'wx' });
        if (!io.readFileSync(backupFile).equals(bytes)) throw new Error('backup readback mismatch');
      } catch (cause) {
        throw report(failure('SETTINGS_STORE_BACKUP_FAILED', '无法完整保存旧配置副本，已停止恢复；原配置未修改。请检查目录权限与磁盘空间。', cause), 'backup-failed');
      }
      preserved = { bytes, backupFile };
    }
    status = { state: 'recovered', reason, file, backupFile: preserved.backupFile, writeBlocked: false, changedFields,
      message: reason === 'malformed-json'
        ? '旧配置无法解析，已保存原始副本并使用默认配置启动；原文件尚未覆盖。'
        : `已规范化旧配置字段：${changedFields.join('、')}。可识别的设置已保留，原始副本已保存。` };
  }
  function bytesOnDisk() {
    try {
      const stat = io.statSync(file);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw failure('SETTINGS_STORE_READ_FAILED', '旧配置不是普通文件或超过 64 MiB，已停止读取并保留原件。请导出启动诊断后处理。');
      return io.readFileSync(file);
    }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }
  function read() {
    try { lastBytes = bytesOnDisk(); }
    catch (cause) { throw report(failure('SETTINGS_STORE_READ_FAILED', '无法读取配置文件，原文件未修改。请检查配置路径和目录权限。', cause), 'read-failed'); }
    if (lastBytes === null) {
      // A dangling link or a non-directory parent is not a fresh installation.
      try { io.lstatSync(file); throw failure('SETTINGS_STORE_READ_FAILED', '配置路径存在但无法读取，原路径未修改。'); }
      catch (cause) {
        if (cause.code !== 'ENOENT') throw report(failure('SETTINGS_STORE_READ_FAILED', '无法读取配置路径，已停止自动替换。', cause), 'read-failed');
      }
      status = { state: 'missing', file, backupFile: null, writeBlocked: false, message: null, changedFields: [] };
      return validate(null);
    }
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lastBytes)); }
    catch {
      preserve(lastBytes, 'malformed-json', []);
      return validate(null);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1) {
      status = { state: 'blocked', reason: 'unsupported-schema', file, backupFile: null, writeBlocked: true, changedFields: [],
        message: '配置结构或版本不受支持，已使用只读默认配置启动；原文件未修改，不能自动迁移。',
        sourceVersion: typeof parsed?.version === 'number' || typeof parsed?.version === 'string' ? String(parsed.version).slice(0, 80) : null,
        error: { code: 'SETTINGS_STORE_VERSION_UNSUPPORTED' } };
      return validate(null);
    }
    const normalized = validate(parsed);
    const changedFields = Object.keys(DEFAULTS).filter(key => Object.hasOwn(parsed, key) && JSON.stringify(parsed[key]) !== JSON.stringify(normalized[key]));
    if (changedFields.length) preserve(lastBytes, 'fields-normalized', changedFields);
    else if (status.state !== 'recovered') status = { state: 'ok', file, backupFile: null, writeBlocked: false, message: null, changedFields: [] };
    return normalized;
  }
  async function writeNow(patch) {
    if (patch != null && (typeof patch !== 'object' || Array.isArray(patch) || Object.hasOwn(patch, 'version') && patch.version !== 1)) {
      throw failure('SETTINGS_STORE_PATCH_INVALID', '配置修改格式或版本无效，原配置未修改。');
    }
    const current = read(), expected = lastBytes;
    if (status.writeBlocked) throw failure('SETTINGS_STORE_VERSION_UNSUPPORTED', status.message);
    const next = validate({ ...current, ...(patch || {}) });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await io.promises.mkdir(path.dirname(file), { recursive: true });
      await io.promises.writeFile(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx' });
      const actual = bytesOnDisk();
      if (expected === null ? actual !== null : !actual || !actual.equals(expected)) throw failure('SETTINGS_STORE_CHANGED', '配置在保存前已被其他操作修改，本次没有覆盖。请重新读取后再保存。');
      if (preserved && expected?.equals(preserved.bytes) && !io.readFileSync(preserved.backupFile).equals(expected)) {
        throw failure('SETTINGS_STORE_BACKUP_FAILED', '旧配置副本已改变，原配置未覆盖。请先核对恢复副本。');
      }
      await io.promises.rename(temp, file);
      if (status.state === 'recovered') status = { ...status, message: '当前配置已保存；旧配置原始副本仍保留，可用于恢复。' };
      return next;
    } catch (cause) {
      const error = /^SETTINGS_STORE_/.test(cause.code || '') ? cause : failure('SETTINGS_STORE_WRITE_FAILED', '配置保存失败，原配置未替换。请检查目录权限与磁盘空间后重试。', cause);
      if (cause.code !== 'EEXIST') {
        try { await io.promises.unlink(temp); }
        catch (cleanup) { if (cleanup.code !== 'ENOENT') error.details.cleanupCode = cleanup.code || 'unknown'; }
      }
      throw report(error, 'write-failed');
    }
  }
  function write(patch) {
    const next = writes.then(() => writeNow(patch));
    writes = next.catch(() => {}); // Keep later writes usable; the caller still receives the rejection.
    return next;
  }
  function update(mutator) {
    const next = writes.then(() => writeNow(mutator(read())));
    writes = next.catch(() => {});
    return next;
  }
  return { read, write, update, readRecoveryStatus: () => structuredClone(status) };
}

module.exports = { DEFAULTS, validate, createStore, uniquePaths, uniqueManualExecutables, normalizeGameOverrides, normalizeExcludedGames };
