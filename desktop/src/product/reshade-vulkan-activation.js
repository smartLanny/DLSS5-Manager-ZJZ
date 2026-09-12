'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { addonValues } = require('./reshade-layout');
const { atomicJson, inside, noLinks } = require('./launch-safety');

const ID = 'reshade-ini-v1';
const MARKER_KEY = 'XiaofengVulkanMarker';
const SCOPE_KEY = 'XiaofengVulkanScope';
const MARKER = /^xiaofeng-vulkan-deployment:[0-9a-f-]{36}$/i;
const MAX_INI_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashText(value) {
  return hashBytes(Buffer.from(String(value), 'utf8'));
}

function canonicalPath(value) {
  return path.resolve(value).toLowerCase();
}

function assertExe(exe) {
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) fail('VULKAN_ACTIVATION_INVALID', 'ReShade 按 EXE 激活需要绝对路径。');
  return path.resolve(exe);
}

function decodeIni(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('VULKAN_ACTIVATION_INVALID', 'ReShade.ini 不是 ReShade 支持的严格 UTF-8 配置。'); }
}

function parseIni(text) {
  // Keep ReShade's exact section/key and repeated-vector semantics in one place.
  const sections = new Map();
  for (const section of ['INSTALL', 'ADDON']) sections.set(section, addonValues(String(text), section));
  return sections;
}

function iniValue(parsed, section, key) {
  return parsed.get(section)?.get(key)?.[0];
}

function isLocalPath(value) {
  if (value === undefined || value === null || String(value).trim() === '') return true;
  const normalized = String(value).trim().replace(/\//g, '\\').toLowerCase();
  return normalized === '.' || normalized === '.\\';
}

function scopeFor(groupKey, basePath = null) {
  return hashText(basePath ? `${groupKey}\0${canonicalPath(basePath)}` : groupKey).slice(0, 32);
}

function archiveStem(groupKey, marker, basePath = null) {
  return `${scopeFor(groupKey, basePath)}-${hashText(marker).slice(0, 32)}`;
}

function archiveName(groupKey, marker, contentHash, basePath = null) {
  return `${archiveStem(groupKey, marker, basePath)}-${contentHash}.ini`;
}

function legacyArchiveName(groupKey, marker, basePath = null) {
  return `${archiveStem(groupKey, marker, basePath)}.ini`;
}

function isSafeRegularFile(stat) {
  return stat && stat.isFile() && !stat.isSymbolicLink();
}

async function readBytes(file, { maxBytes = MAX_INI_BYTES, missing = null } = {}) {
  await noLinks(file);
  let link;
  try { link = await fsp.lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw error;
  }
  if (!isSafeRegularFile(link)) fail('VULKAN_ACTIVATION_INVALID', 'ReShade 激活文件不是安全的普通文件。', { file: path.basename(file) });
  if (link.size > maxBytes) fail('VULKAN_ACTIVATION_INVALID', 'ReShade 激活文件超出安全大小限制。', { file: path.basename(file) });
  return fsp.readFile(file);
}

function bindMarker(marker, basePath) {
  if (!basePath) return marker;
  return `${marker}@${hashText(canonicalPath(basePath)).slice(0, 32)}`;
}

function markerFromToken(token, basePath) {
  if (!basePath) {
    if (!MARKER.test(token)) fail('VULKAN_ACTIVATION_INVALID', 'Manager 新建 ReShade 激活缺少有效标记。');
    return token;
  }
  const separator = String(token).lastIndexOf('@');
  const marker = separator > 0 ? String(token).slice(0, separator) : '';
  const suffix = separator > 0 ? String(token).slice(separator + 1) : '';
  if (!MARKER.test(marker) || suffix !== hashText(canonicalPath(basePath)).slice(0, 32)) fail('VULKAN_ACTIVATION_SCOPE', 'ReShade 激活标记未绑定当前 profile。');
  return marker;
}

function stateFromBytes(exe, bytes, expectedBasePath = null) {
  const exePath = assertExe(exe);
  const groupKey = canonicalPath(path.join(path.dirname(exePath), 'ReShade.ini'));
  const text = decodeIni(bytes);
  const parsed = parseIni(text);
  const baseValue = iniValue(parsed, 'INSTALL', 'BasePath');
  const addonValue = iniValue(parsed, 'ADDON', 'AddonPath');
  const loadedBasePath = isLocalPath(baseValue) ? path.dirname(exePath) : path.resolve(path.dirname(exePath), String(baseValue));
  if (!isLocalPath(addonValue)) fail('VULKAN_ACTIVATION_ADDON_PATH_UNSUPPORTED', 'ReShade.ini 使用了未知 AddonPath，已阻止接管。', { file: 'ReShade.ini' });
  const marker = iniValue(parsed, 'INSTALL', MARKER_KEY);
  const scope = iniValue(parsed, 'INSTALL', SCOPE_KEY);
  const profileMatches = expectedBasePath && canonicalPath(loadedBasePath) === canonicalPath(expectedBasePath);
  if (!isLocalPath(baseValue) && !profileMatches) fail('VULKAN_ACTIVATION_BASE_PATH_UNSUPPORTED', 'ReShade.ini 使用了未知 BasePath，已阻止接管。', { file: 'ReShade.ini' });
  const controlled = Boolean(expectedBasePath && profileMatches);
  const expectedScope = scopeFor(groupKey, controlled ? expectedBasePath : null);
  if (marker !== undefined) {
    if (!MARKER.test(marker)) fail('VULKAN_ACTIVATION_MARKER_INVALID', 'ReShade.ini 的 Manager 激活标记无效。');
    if (String(scope || '') !== expectedScope) fail('VULKAN_ACTIVATION_SCOPE', 'ReShade.ini 的 Manager 激活作用域不匹配当前 EXE。');
    if (expectedBasePath && !profileMatches) fail('VULKAN_ACTIVATION_BASE_PATH_UNSUPPORTED', '受管 ReShade.ini 未指向当前 profile。', { file: 'ReShade.ini' });
    return { active: true, token: bindMarker(marker, controlled ? expectedBasePath : null), groupKey, basePath: loadedBasePath, owned: true, bytes, sha256: hashBytes(bytes) };
  }
  const loadedAddon = loadedBasePath;
  const locationToken = hashText(`${canonicalPath(loadedBasePath)}\0${canonicalPath(loadedAddon)}`).slice(0, 32);
  return { active: true, token: `external:${locationToken}`, groupKey, basePath: loadedBasePath, owned: false, bytes, sha256: hashBytes(bytes) };
}

function minimalIni(marker, scope, basePath = null) {
  const base = basePath ? `BasePath=${path.resolve(basePath).replace(/,/g, ',,')}\r\n` : '';
  return Buffer.from(`[INSTALL]\r\n${base}XiaofengVulkanMarker=${marker}\r\nXiaofengVulkanScope=${scope}\r\n\r\n[ADDON]\r\nAddonPath=.\\\r\n`, 'utf8');
}

async function writeExclusive(file, bytes, maxBytes = MAX_ARCHIVE_BYTES) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) fail('VULKAN_ACTIVATION_INVALID', 'ReShade 激活内容超出安全大小限制。');
  await noLinks(file);
  const handle = await fsp.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes); await handle.sync();
  } finally { await handle.close(); }
}

async function ensureArchive(file, bytes) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await noLinks(file);
  try { await writeExclusive(file, bytes); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readBytes(file, { maxBytes: MAX_ARCHIVE_BYTES });
    if (!existing || !existing.equals(bytes)) fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', 'ReShade 激活归档已被外部修改。');
  }
}

async function readJson(file, maxBytes = 64 * 1024) {
  const bytes = await readBytes(file, { maxBytes });
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', 'ReShade 激活归档索引损坏。'); }
}

function sameState(a, b) {
  return Boolean(a?.active) === Boolean(b?.active) && String(a?.token) === String(b?.token);
}

function createReshadeVulkanActivation(options = {}) {
  if (typeof options.userData !== 'string' || !path.isAbsolute(options.userData)) fail('VULKAN_BAD_CONFIG', 'ReShade 激活需要绝对的用户数据目录。');
  const userData = path.resolve(options.userData);
  const resolveBasePath = options.resolveBasePath;
  if (resolveBasePath !== undefined && typeof resolveBasePath !== 'function') fail('VULKAN_BAD_CONFIG', 'ReShade profile resolver 必须是函数。');
  const archiveRoot = path.join(userData, 'vulkan-deployment', 'activation-archives');

  function groupKey(exe) {
    const file = assertExe(exe);
    return canonicalPath(path.join(path.dirname(file), 'ReShade.ini'));
  }

  async function profilePath(exe) {
    if (!resolveBasePath) return null;
    let value;
    try { value = await resolveBasePath(assertExe(exe)); }
    catch (error) { fail('VULKAN_ACTIVATION_PROFILE_UNAVAILABLE', '无法解析 ReShade 外部 profile 路径。', { cause: error.code || 'resolver' }); }
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('VULKAN_ACTIVATION_PROFILE_INVALID', 'ReShade profile 路径必须是绝对路径。');
    const resolved = path.resolve(value);
    if (!inside(canonicalPath(userData), canonicalPath(resolved))) fail('VULKAN_ACTIVATION_PROFILE_INVALID', 'ReShade profile 必须位于 Manager userData 内。');
    await noLinks(resolved);
    let stat;
    try { stat = await fsp.lstat(resolved); }
    catch (error) { if (error.code === 'ENOENT') fail('VULKAN_ACTIVATION_PROFILE_MISSING', 'ReShade profile 目录尚未准备完成。'); throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('VULKAN_ACTIVATION_PROFILE_INVALID', 'ReShade profile 不是安全目录。');
    return resolved;
  }

  async function read(exe) {
    const file = groupKey(exe);
    const bytes = await readBytes(file);
    if (!bytes) return { active: false, token: 'absent' };
    return stateFromBytes(exe, bytes, await profilePath(exe));
  }

  async function readArchived(exe, group, marker, basePath) {
    const indexFile = path.join(archiveRoot, `${archiveStem(group, marker, basePath)}.latest.json`);
    const index = await readJson(indexFile);
    if (index) {
      if (index.version !== 1 || index.groupKey !== group || index.marker !== marker || typeof index.archive !== 'string' ||
          path.basename(index.archive) !== index.archive || !/^[a-f0-9-]+-[a-f0-9]{64}\.ini$/i.test(index.archive) ||
          typeof index.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(index.sha256) || !Number.isInteger(index.size) || index.size < 0 || index.size > MAX_ARCHIVE_BYTES ||
          (basePath ? index.basePath !== canonicalPath(basePath) : index.basePath !== undefined && index.basePath !== null)) {
        fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', 'ReShade 激活归档索引作用域或摘要无效。');
      }
      const archive = path.resolve(archiveRoot, index.archive);
      if (!inside(archiveRoot, archive)) fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', 'ReShade 激活归档索引越界。');
      const bytes = await readBytes(archive, { maxBytes: MAX_ARCHIVE_BYTES });
      if (!bytes || bytes.length !== index.size || hashBytes(bytes) !== index.sha256) fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', 'ReShade 激活归档内容已被外部修改。');
      const state = stateFromBytes(exe, bytes, basePath);
      if (!sameState(state, { active: true, token: marker })) fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', 'ReShade 激活归档标记不一致。');
      return bytes;
    }
    const legacy = path.join(archiveRoot, legacyArchiveName(group, marker, basePath));
    const bytes = await readBytes(legacy, { maxBytes: MAX_ARCHIVE_BYTES });
    if (!bytes) return null;
    const state = stateFromBytes(exe, bytes, basePath);
    if (!sameState(state, { active: true, token: marker })) fail('VULKAN_ACTIVATION_ARCHIVE_CHANGED', '旧 ReShade 激活归档标记不一致。');
    return bytes;
  }

  async function write(exe, expected, desired) {
    const file = groupKey(exe);
    const basePath = await profilePath(exe);
    const current = await read(exe);
    if (!sameState(current, expected)) fail('VULKAN_ACTIVATION_CHANGED', '游戏的 ReShade.ini 已被外部修改。');
    if (!desired || typeof desired.active !== 'boolean' || typeof desired.token !== 'string') fail('VULKAN_ACTIVATION_INVALID', 'ReShade 激活目标无效。');
    if (desired.active) {
      if (current.active) {
        if (sameState(current, desired)) return;
        fail('VULKAN_ACTIVATION_CHANGED', 'ReShade.ini 已存在其他激活状态。');
      }
      const marker = markerFromToken(desired.token, basePath);
      const scope = scopeFor(file, basePath);
      let bytes = await readArchived(exe, file, desired.token, basePath);
      if (!bytes) bytes = minimalIni(marker, scope, basePath);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await noLinks(file);
      try { await writeExclusive(file, bytes); }
      catch (error) { if (error.code === 'EEXIST') fail('VULKAN_ACTIVATION_CHANGED', 'ReShade.ini 在写入前被外部创建。'); throw error; }
      const after = await read(exe);
      if (!sameState(after, desired)) fail('VULKAN_ACTIVATION_WRITE', 'ReShade 激活写入后读回不一致。');
      return;
    }
    if (desired.token !== 'absent') fail('VULKAN_ACTIVATION_INVALID', 'ReShade 停用目标必须是 absent。');
    if (!current.active) return;
    if (!current.owned) fail('VULKAN_ACTIVATION_EXTERNAL', '当前 ReShade.ini 属于外部配置，未自动移除。');
    markerFromToken(current.token, basePath);
    const before = await readBytes(file);
    if (!before) fail('VULKAN_ACTIVATION_CHANGED', 'ReShade.ini 在归档前消失。');
    const group = file;
    // Validate an existing latest pointer before adding a new immutable archive.
    markerFromToken(current.token, basePath);
    await readArchived(exe, group, current.token, basePath);
    const contentHash = hashBytes(before);
    const archive = path.join(archiveRoot, archiveName(group, current.token, contentHash, basePath));
    await ensureArchive(archive, before);
    await atomicJson(path.join(archiveRoot, `${archiveStem(group, current.token, basePath)}.latest.json`), {
      version: 1, groupKey: group, marker: current.token, basePath: basePath ? canonicalPath(basePath) : null,
      archive: path.basename(archive), sha256: contentHash, size: before.length
    });
    const check = await readBytes(file);
    if (!check || !check.equals(before)) fail('VULKAN_ACTIVATION_CHANGED', 'ReShade.ini 在按摘要移除前发生变化。');
    await noLinks(file);
    try { await fsp.unlink(file); }
    catch (error) { if (error.code === 'ENOENT') fail('VULKAN_ACTIVATION_CHANGED', 'ReShade.ini 在移除时已消失。'); throw error; }
    const after = await read(exe);
    if (after.active) fail('VULKAN_ACTIVATION_WRITE', 'ReShade 激活移除后仍可读到配置。');
  }

  async function bindToken(exe, marker) {
    if (!MARKER.test(marker)) fail('VULKAN_ACTIVATION_INVALID', 'Manager 新建 ReShade 激活缺少有效标记。');
    return bindMarker(marker, await profilePath(exe));
  }

  return Object.freeze({ id: ID, groupKey, bindToken, read, write });
}

module.exports = {
  ID,
  MARKER_KEY,
  SCOPE_KEY,
  createReshadeVulkanActivation,
  parseIni,
  stateFromBytes
};
