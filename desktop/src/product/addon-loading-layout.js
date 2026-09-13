'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { inspectProfile } = require('./external-profile-config');
const { addonValues } = require('./reshade-layout');
const { noLinks } = require('./launch-safety');

const ADDON = /\.addon(?:32|64)?$/i;
const MODULE = /\.(?:dll|addon(?:32|64)?)$/i;
const HASH = /^[a-f0-9]{64}$/;
const LIMITS = Object.freeze({ entries: 4096, files: 128, fileBytes: 256 * 1024 * 1024,
  hashBytes: 512 * 1024 * 1024, probeBytes: 8 * 1024 * 1024, directLoads: 64 });
const key = file => path.resolve(file).toLowerCase();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: 'ADDON_' + code, details }); };
const sameStat = (a, b) => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;

// ReShade uses the FIRST @ and byte-exact names. A name-only entry prevents
// registration, whereas @filename also prevents ordinary directory loading.
// LoadFromDllMain runs before either registration or the normal search loop.
function resolveAddonLoadState({ name, registeredName = null, searched = false, explicit = false,
  architecture = 'unknown', hostArchitecture = 64, disabledValues = [] }) {
  const compatibleArchitecture = architecture === 'unknown' || architecture === (hostArchitecture === 32 ? 'x86' : 'x64');
  const tokens = Array.isArray(disabledValues) ? disabledValues : [];
  const filenameDisabled = tokens.some(value => typeof value === 'string' && value.indexOf('@') >= 0 && value.slice(value.indexOf('@') + 1) === name);
  const registrationDisabled = tokens.some(value => {
    if (typeof value !== 'string') return false;
    const at = value.indexOf('@');
    if (at < 0) return registeredName !== null && value === registeredName;
    return value.slice(at + 1) === name && (at === 0 || registeredName !== null && value.slice(0, at) === registeredName);
  });
  const moduleMayLoad = compatibleArchitecture && (explicit || searched && !filenameDisabled);
  const loadState = !compatibleArchitecture ? 'architecture-mismatch' : explicit ? 'explicit' :
    searched ? filenameDisabled ? 'disabled' : registrationDisabled ? 'registration-disabled' : 'enabled' : 'inactive';
  return { searched, explicit, filenameDisabled, registrationDisabled, moduleMayLoad, loadState,
    registeredNameVerified: registeredName !== null, runtimeVerified: false };
}

// Read PE data as bytes. Never LoadLibrary an untrusted Add-on to ask for NAME.
// Unknown or truncated metadata stays unknown, so a name-only disabled entry
// cannot accidentally suppress a file from the compatibility inventory.
function probeRegisteredName(buffer, fileName, detailed = false) {
  try {
    const ok = (at, size) => Number.isSafeInteger(at) && at >= 0 && at + size <= buffer.length;
    if (!ok(0, 64) || buffer.toString('ascii', 0, 2) !== 'MZ') return null;
    const peAt = buffer.readUInt32LE(0x3c);
    if (!ok(peAt, 24) || buffer.readUInt32LE(peAt) !== 0x4550) return null;
    const count = buffer.readUInt16LE(peAt + 6), optionalSize = buffer.readUInt16LE(peAt + 20), optional = peAt + 24;
    if (!ok(optional, optionalSize) || count > 96 || optionalSize < 112) return null;
    const magic = buffer.readUInt16LE(optional), wide = magic === 0x20b;
    if (!wide && magic !== 0x10b) return null;
    const directory = optional + (wide ? 112 : 96), sections = optional + optionalSize;
    if (!ok(sections, count * 40)) return null;
    const imageBase = wide ? buffer.readBigUInt64LE(optional + 24) : BigInt(buffer.readUInt32LE(optional + 28));
    const map = (rva, size = 1) => {
      if (rva < buffer.readUInt32LE(optional + 60) && ok(rva, size)) return rva;
      for (let i = 0; i < count; i++) {
        const at = sections + i * 40, virtual = buffer.readUInt32LE(at + 12), rawSize = buffer.readUInt32LE(at + 16), raw = buffer.readUInt32LE(at + 20);
        if (rva >= virtual && rva - virtual + size <= rawSize && ok(raw + rva - virtual, size)) return raw + rva - virtual;
      }
      return null;
    };
    const cString = at => {
      if (at === null) throw new Error('unmapped string');
      const end = buffer.indexOf(0, at);
      if (end < at || end - at > 4096) throw new Error('unbounded string');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(at, end));
    };
    let result = path.basename(fileName).replace(/\.[^.]+$/, ''), nameSource = 'filename';
    if (!ok(directory, 24)) return null;
    const resourceRva = buffer.readUInt32LE(directory + 16), resourceSize = buffer.readUInt32LE(directory + 20);
    if (resourceRva && resourceSize) {
      const resource = map(resourceRva, Math.min(resourceSize, 16)); if (resource === null) return null;
      const descend = (offset, wanted) => {
        const at = resource + offset; if (!ok(at, 16)) throw new Error('resource directory');
        const size = buffer.readUInt16LE(at + 12) + buffer.readUInt16LE(at + 14);
        if (size > 4096 || !ok(at + 16, size * 8)) throw new Error('resource entries');
        for (let i = 0; i < size; i++) {
          const entry = at + 16 + i * 8, name = buffer.readUInt32LE(entry), child = buffer.readUInt32LE(entry + 4);
          if (wanted === undefined || name === wanted) return child;
        }
        return null;
      };
      let child = descend(0, 16);
      if (child !== null) {
        for (let depth = 0; child & 0x80000000; depth++) {
          if (depth > 3) throw new Error('resource depth'); child = descend(child & 0x7fffffff);
          if (child === null) throw new Error('empty version resource');
        }
        const at = resource + child; if (!ok(at, 16)) throw new Error('version data');
        const bytes = buffer.readUInt32LE(at + 4), blobAt = map(buffer.readUInt32LE(at), bytes);
        if (bytes > 65536 || blobAt === null) throw new Error('version size');
        const blob = buffer.subarray(blobAt, blobAt + bytes), products = new Set(); let nodes = 0;
        const align = n => (n + 3) & ~3;
        const visit = (offset, end, depth) => {
          if (++nodes > 1024 || depth > 6 || offset + 6 > end) throw new Error('version structure');
          const length = blob.readUInt16LE(offset), valueSize = blob.readUInt16LE(offset + 2), type = blob.readUInt16LE(offset + 4);
          if (length < 6 || offset + length > end) throw new Error('version boundary');
          let stop = offset + 6; while (stop + 1 < offset + length && blob.readUInt16LE(stop)) stop += 2;
          if (stop + 1 >= offset + length) throw new Error('version key');
          const name = blob.subarray(offset + 6, stop).toString('utf16le'), valueAt = align(stop + 2), valueBytes = valueSize * (type === 1 ? 2 : 1);
          if (valueAt + valueBytes > offset + length) throw new Error('version value');
          if (name === 'ProductName' && type === 1 && valueBytes) products.add(blob.subarray(valueAt, valueAt + valueBytes).toString('utf16le').replace(/\0+$/, ''));
          for (let next = align(valueAt + valueBytes); next + 6 <= offset + length;) {
            const size = blob.readUInt16LE(next); if (!size) break; visit(next, offset + length, depth + 1); next = align(next + size);
          }
        };
        visit(0, blob.length, 0); if (products.size > 1) return null;
        if (products.size === 1) { result = [...products][0]; nameSource = 'pe-product-name'; }
      }
    }
    const exportRva = buffer.readUInt32LE(directory), exportSize = buffer.readUInt32LE(directory + 4);
    if (exportRva && exportSize) {
      const at = map(exportRva, 40); if (at === null) return null;
      const functions = buffer.readUInt32LE(at + 20), names = buffer.readUInt32LE(at + 24);
      if (functions > 16384 || names > 16384) return null;
      const fsAt = map(buffer.readUInt32LE(at + 28), functions * 4), nsAt = map(buffer.readUInt32LE(at + 32), names * 4), osAt = map(buffer.readUInt32LE(at + 36), names * 2);
      if (fsAt === null || nsAt === null || osAt === null) return null;
      for (let i = 0; i < names; i++) if (cString(map(buffer.readUInt32LE(nsAt + i * 4))) === 'NAME') {
        const ordinal = buffer.readUInt16LE(osAt + i * 2); if (ordinal >= functions) return null;
        const rva = buffer.readUInt32LE(fsAt + ordinal * 4); if (rva >= exportRva && rva < exportRva + exportSize) return null;
        const pointerAt = map(rva, wide ? 8 : 4); if (pointerAt === null) return null;
        const pointer = wide ? buffer.readBigUInt64LE(pointerAt) : BigInt(buffer.readUInt32LE(pointerAt));
        if (pointer < imageBase || pointer - imageBase > 0xffffffffn) return null;
        result = cString(map(Number(pointer - imageBase))); nameSource = 'name-export'; break;
      }
    }
    return detailed ? { registeredName: result || null, nameSource } : result || null;
  } catch { return null; }
}

async function readRegisteredName(file, { detailed = false } = {}) {
  await noLinks(file); const handle = await fsp.open(file, 'r');
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1) fail('FILE_INVALID', '插件不是普通单链接文件。');
    const buffer = Buffer.alloc(Math.min(before.size, LIMITS.probeBytes)); let used = 0;
    while (used < buffer.length) { const read = await handle.read(buffer, used, buffer.length - used, used); if (!read.bytesRead) fail('FILE_CHANGED', '插件在读取时改变。'); used += read.bytesRead; }
    const result = probeRegisteredName(buffer, path.basename(file), detailed);
    if (!sameStat(before, await handle.stat()) || !sameStat(before, await fsp.stat(file))) fail('FILE_CHANGED', '插件在读取时改变。');
    return detailed ? result || { registeredName: null, nameSource: 'unavailable' } : result;
  } finally { await handle.close(); }
}

async function hashFile(file, budget) {
  await noLinks(file); const handle = await fsp.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMITS.fileBytes || before.size > budget.bytes) fail('FILE_LIMIT', '插件无法在本次读取范围内核对。', { file });
    budget.bytes -= before.size;
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    for (let at = 0; at < before.size;) { const read = await handle.read(buffer, 0, Math.min(buffer.length, before.size - at), at); if (!read.bytesRead) fail('FILE_CHANGED', '插件在读取时改变。'); digest.update(buffer.subarray(0, read.bytesRead)); at += read.bytesRead; }
    if (!sameStat(before, await handle.stat()) || !sameStat(before, await fsp.stat(file))) fail('FILE_CHANGED', '插件在读取时改变。');
    return { sha256: digest.digest('hex'), bytes: before.size };
  } finally { await handle.close(); }
}

async function addonInventory(directory) {
  await noLinks(directory); const result = []; let entries = 0;
  let handle; try { handle = await fsp.opendir(directory); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for await (const entry of handle) {
    if (++entries > LIMITS.entries) fail('DIRECTORY_LIMIT', '插件搜索目录过大，未采用不完整列表。');
    if (ADDON.test(entry.name)) result.push({ name: entry.name, kind: entry.isFile() ? 'file' : 'other' });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function snapshotAddonLoadingLayout({ exeDir, gameId = null, architecture = 64, environment = process.env }) {
  if (!path.isAbsolute(exeDir || '') || ![32, 64].includes(architecture)) fail('LAYOUT_REQUIRED', '插件扫描需要实际 EXE 目录和位数。');
  exeDir = path.resolve(exeDir);
  const profile = inspectProfile(exeDir, environment), blockers = [...profile.blockers], warnings = [...profile.warnings], files = [];
  const result = { version: 1, gameId, exeDir, architecture, profile, blockers, warnings, files,
    environment: { ...profile.legacyDirectLoad?.environment, ...Object.fromEntries(Object.entries(environment).filter(([name]) => name === 'RESHADE_BASE_PATH_OVERRIDE' ||
      new RegExp('%' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '%', 'i').test(profile.rootConfig + profile.config))) } };
  result.configFingerprint = sha(Buffer.from(JSON.stringify({ exeDir: key(exeDir), architecture, configured: profile.configured, identities: profile.identities, environment: result.environment })));
  let inventory = [];
  if (!blockers.length) try {
    inventory = await addonInventory(profile.addonDir);
    if (inventory.length > LIMITS.files || profile.directLoads.length > LIMITS.directLoads) fail('FILE_LIMIT', '插件数量超过本次检查范围。');
    const candidates = new Map(), disabledValues = addonValues(profile.config).get('DisabledAddons') || [];
    for (const item of inventory) {
      const file = path.join(profile.addonDir, item.name), extension = path.extname(item.name);
      // ReShade's extension comparison is case-sensitive, including Windows.
      const searched = extension === '.addon' || extension === (architecture === 32 ? '.addon32' : '.addon64');
      candidates.set(key(file), { path: file, name: item.name, searched, explicit: false });
    }
    for (const item of profile.directLoads) {
      if (!MODULE.test(item.path)) fail('EXPLICIT_TYPE', '显式加载项不是可识别的插件或 DLL。');
      const existing = candidates.get(key(item.path));
      candidates.set(key(item.path), { ...(existing || { path: item.path, name: path.basename(item.path), searched: false }), explicit: true });
    }
    if (candidates.size > LIMITS.files) fail('FILE_LIMIT', '插件数量超过本次检查范围。');
    const budget = { bytes: LIMITS.hashBytes };
    // Runtime require avoids a module cycle: component-assessment consumes the
    // pure loading rules here; this inventory reuses its bounded PE clues.
    const { inspectComponentClues } = require('./component-assessment');
    for (const candidate of candidates.values()) {
      const row = { ...candidate, sha256: null, bytes: 0, architecture: 'unknown', registeredName: null, classification: 'unknown', confidence: 'unknown' };
      try {
        Object.assign(row, await hashFile(row.path, budget));
        const before = await fsp.stat(row.path), details = await inspectComponentClues(row.path);
        Object.assign(row, details, { sha256: row.sha256 });
        Object.assign(row, await readRegisteredName(row.path, { detailed: true }));
        if (!sameStat(before, await fsp.stat(row.path))) fail('FILE_CHANGED', '插件在元数据检查时变化。');
        Object.assign(row, resolveAddonLoadState({ ...row, hostArchitecture: architecture, disabledValues }));
      } catch (error) {
        Object.assign(row, { loadState: 'unavailable', moduleMayLoad: row.explicit || row.searched, error: error.message });
        if (row.explicit || row.searched) blockers.push({ code: error.code || 'ADDON_FILE_UNAVAILABLE', path: row.path, message: error.message });
      }
      files.push(row);
    }
  } catch (error) { blockers.push({ code: error.code || 'ADDON_LAYOUT_UNAVAILABLE', message: error.message }); }
  result.inventory = inventory;
  result.fingerprint = sha(Buffer.from(JSON.stringify({ config: result.configFingerprint, inventory,
    files: files.map(row => ({ path: key(row.path), sha256: row.sha256, bytes: row.bytes, searched: row.searched, explicit: row.explicit,
      loadState: row.loadState, registeredName: row.registeredName })), blockers })));
  return result;
}

async function assertAddonSnapshot(snapshot, { environment = process.env } = {}) {
  if (!snapshot || snapshot.version !== 1 || !HASH.test(snapshot.fingerprint || '') || snapshot.blockers?.length) fail('SNAPSHOT_INVALID', '插件预览不完整，请重新检查。');
  const current = await snapshotAddonLoadingLayout({ exeDir: snapshot.exeDir, gameId: snapshot.gameId, architecture: snapshot.architecture, environment });
  if (current.fingerprint !== snapshot.fingerprint) fail('PLAN_CHANGED', '预览后插件、加载目录或配置发生变化，请重新预览。');
  return true;
}

module.exports = { resolveAddonLoadState, probeRegisteredName, readRegisteredName, snapshotAddonLoadingLayout,
  assertAddonSnapshot, ADDON_LOADING_LIMITS: LIMITS };
