'use strict';

// Read a PE icon resource without loading or executing the executable. The
// returned ICO data URL can be handed to the existing Electron large-icon
// fallback when a persisted shell icon is missing or stale.
const fs = require('node:fs');
const path = require('node:path');

const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ICON_BYTES = 8 * 1024 * 1024;
const MAX_RESOURCE_ENTRIES = 1024;
const MAX_ICON_GROUPS = 128;
const MAX_ICON_CANDIDATES = 256;
const MAX_TOTAL_READ_BYTES = 32 * 1024 * 1024;
const MAX_ICON_DIMENSION = 4096;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const ICO_HEADER_BYTES = 22;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readExact(fd, size, position, budget) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RESOURCE_BYTES || !Number.isSafeInteger(position) || position < 0 || !budget || !Number.isSafeInteger(budget.used) || size > budget.limit - budget.used) return null;
  budget.used += size;
  const buffer = Buffer.alloc(size);
  const read = fs.readSync(fd, buffer, 0, size, position);
  return read === size ? buffer : null;
}

function parseHeaders(fd, fileSize, budget) {
  const dos = readExact(fd, 0x40, 0, budget);
  if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return null;
  const peOffset = dos.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset > Math.min(fileSize - 24, 1024 * 1024)) return null;
  const signature = readExact(fd, 4, peOffset, budget);
  if (!signature || signature.readUInt32LE(0) !== 0x00004550) return null;
  const coff = readExact(fd, 20, peOffset + 4, budget);
  if (!coff) return null;
  const sectionCount = coff.readUInt16LE(2);
  const optionalSize = coff.readUInt16LE(16);
  if (!sectionCount || sectionCount > 96 || optionalSize < 96 || optionalSize > 1024) return null;
  const optionalOffset = peOffset + 24;
  const optional = readExact(fd, optionalSize, optionalOffset, budget);
  if (!optional) return null;
  const magic = optional.readUInt16LE(0);
  const dataDirectoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
  if (dataDirectoryOffset < 0 || optional.length < dataDirectoryOffset + 16 * 8) return null;
  const resourceRva = optional.readUInt32LE(dataDirectoryOffset + 2 * 8);
  const resourceSize = optional.readUInt32LE(dataDirectoryOffset + 2 * 8 + 4);
  if (!resourceRva || !resourceSize || resourceSize > MAX_RESOURCE_BYTES) return null;
  const sectionOffset = optionalOffset + optionalSize;
  const sectionTable = readExact(fd, sectionCount * 40, sectionOffset, budget);
  if (!sectionTable) return null;
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const offset = index * 40;
    const virtualSize = sectionTable.readUInt32LE(offset + 8);
    const virtualAddress = sectionTable.readUInt32LE(offset + 12);
    const rawSize = sectionTable.readUInt32LE(offset + 16);
    const rawOffset = sectionTable.readUInt32LE(offset + 20);
    if (!rawSize || rawOffset > fileSize || rawOffset + rawSize > fileSize) continue;
    sections.push({ virtualSize, virtualAddress, rawSize, rawOffset });
  }
  const rvaToFileOffset = rva => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        const offset = section.rawOffset + (rva - section.virtualAddress);
        return offset >= section.rawOffset && offset < section.rawOffset + section.rawSize ? offset : null;
      }
    }
    return null;
  };
  const resourceOffset = rvaToFileOffset(resourceRva);
  if (resourceOffset === null || resourceOffset + resourceSize > fileSize) return null;
  return { resourceOffset, resourceSize, rvaToFileOffset };
}

function resourceRead(fd, resource, relative, size, budget) {
  if (!Number.isSafeInteger(relative) || relative < 0 || !Number.isSafeInteger(size) || size < 0 || relative + size > resource.resourceSize) return null;
  return readExact(fd, size, resource.resourceOffset + relative, budget);
}

function resourceDirectory(fd, resource, relative, budget) {
  const header = resourceRead(fd, resource, relative, 16, budget);
  if (!header) return null;
  const namedCount = header.readUInt16LE(12);
  const idCount = header.readUInt16LE(14);
  const count = namedCount + idCount;
  if (count > MAX_RESOURCE_ENTRIES) return null;
  const raw = resourceRead(fd, resource, relative + 16, count * 8, budget);
  if (!raw) return null;
  const entries = [];
  for (let index = 0; index < count; index++) {
    const offset = index * 8;
    const name = raw.readUInt32LE(offset);
    const child = raw.readUInt32LE(offset + 4);
    entries.push({
      id: index < namedCount ? null : name,
      named: Boolean(name & 0x80000000),
      child: child & 0x7fffffff,
      directory: Boolean(child & 0x80000000)
    });
  }
  return entries;
}

function dataBlob(fd, resource, typeId, nameId, budget, expectedSize = null) {
  const types = resourceDirectory(fd, resource, 0, budget);
  const type = types && types.find(entry => !entry.named && entry.id === typeId && entry.directory);
  if (!type) return null;
  const names = resourceDirectory(fd, resource, type.child, budget);
  const name = names && names.find(entry => !entry.named && entry.id === nameId && entry.directory);
  if (!name) return null;
  const languages = resourceDirectory(fd, resource, name.child, budget);
  if (!languages) return null;
  const ordered = [...languages].sort((left, right) => {
    const prefer = value => value.id === 0x0409 ? 0 : value.id === 0 ? 1 : 2;
    return prefer(left) - prefer(right);
  });
  for (const language of ordered) {
    if (language.directory) continue;
    const entry = resourceRead(fd, resource, language.child, 16, budget);
    if (!entry) continue;
    const rva = entry.readUInt32LE(0);
    const size = entry.readUInt32LE(4);
    if (!size || size > MAX_ICON_BYTES) continue;
    if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize !== size)) continue;
    const fileOffset = resource.rvaToFileOffset(rva);
    if (fileOffset === null || fileOffset < resource.resourceOffset || fileOffset + size > resource.resourceOffset + resource.resourceSize) continue;
    const bytes = readExact(fd, size, fileOffset, budget);
    if (bytes && bytes.length === size && (expectedSize === null || bytes.length === expectedSize)) return bytes;
  }
  return null;
}

function parseGroupIcon(group) {
  if (!group || group.length < 6 || group.readUInt16LE(0) !== 0 || group.readUInt16LE(2) !== 1) return [];
  const count = group.readUInt16LE(4);
  if (!count || count > 256 || 6 + count * 14 > group.length) return [];
  const entries = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 14;
    const width = group[offset] || 256;
    const height = group[offset + 1] || 256;
    const bytesInRes = group.readUInt32LE(offset + 8);
    const resourceId = group.readUInt16LE(offset + 12);
    if (!resourceId || !bytesInRes || bytesInRes > MAX_ICON_BYTES) continue;
    entries.push({
      width,
      height,
      colorCount: group[offset + 2],
      planes: group.readUInt16LE(offset + 4),
      bitCount: group.readUInt16LE(offset + 6),
      bytesInRes,
      resourceId
    });
  }
  return entries;
}

function boundedDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION) return null;
  return { width, height };
}

function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return boundedDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function dibDimensions(bytes) {
  if (bytes.length < 12) return null;
  const headerSize = bytes.readUInt32LE(0);
  if (headerSize === 12) {
    const width = bytes.readUInt16LE(4);
    const combinedHeight = bytes.readUInt16LE(6);
    return boundedDimensions(width, combinedHeight >= 2 && combinedHeight % 2 === 0 ? combinedHeight / 2 : combinedHeight);
  }
  if (headerSize < 40 || headerSize > 1024 || headerSize > bytes.length) return null;
  const width = Math.abs(bytes.readInt32LE(4));
  const combinedHeight = Math.abs(bytes.readInt32LE(8));
  if (combinedHeight > MAX_ICON_DIMENSION * 2) return null;
  return boundedDimensions(width, combinedHeight >= 2 && combinedHeight % 2 === 0 ? combinedHeight / 2 : combinedHeight);
}

function icoPayload(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return null;
  const count = bytes.readUInt16LE(4);
  if (!count || count > MAX_ICON_CANDIDATES || 6 + count * 16 > bytes.length) return null;
  const entries = [];
  for (let index = 0; index < count; index++) {
    const offset = 6 + index * 16;
    const dimensions = boundedDimensions(bytes[offset] || 256, bytes[offset + 1] || 256);
    const bytesInRes = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    if (!dimensions || !bytesInRes || bytesInRes > MAX_ICON_BYTES || imageOffset > bytes.length || bytesInRes > bytes.length - imageOffset) return null;
    entries.push({ ...dimensions, bytesInRes, imageOffset });
  }
  return entries.sort((left, right) => {
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    return leftArea - rightArea || left.bytesInRes - right.bytesInRes;
  }).at(-1);
}

function decodeIconBlob(bytes, depth = 0) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || depth > 2) return null;
  const png = pngDimensions(bytes);
  if (png) return { ...png, bytes };
  const ico = icoPayload(bytes);
  if (ico) return decodeIconBlob(bytes.subarray(ico.imageOffset, ico.imageOffset + ico.bytesInRes), depth + 1);
  const dib = dibDimensions(bytes);
  return dib ? { ...dib, bytes } : null;
}

function iconScore(entry) {
  return [entry.width >= 256 && entry.height >= 256 ? 1 : 0, entry.width * entry.height, entry.bitCount, entry.bytesInRes];
}

function compareIcon(left, right) {
  const a = iconScore(left), b = iconScore(right);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function toIco(entry, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_ICON_BYTES) return null;
  const output = Buffer.alloc(ICO_HEADER_BYTES + bytes.length);
  output.writeUInt16LE(0, 0);
  output.writeUInt16LE(1, 2);
  output.writeUInt16LE(1, 4);
  output[6] = entry.width >= 256 ? 0 : entry.width;
  output[7] = entry.height >= 256 ? 0 : entry.height;
  output[8] = entry.colorCount || 0;
  output[9] = 0;
  output.writeUInt16LE(entry.planes || 1, 10);
  output.writeUInt16LE(entry.bitCount || 32, 12);
  output.writeUInt32LE(bytes.length, 14);
  output.writeUInt32LE(ICO_HEADER_BYTES, 18);
  bytes.copy(output, ICO_HEADER_BYTES);
  return `data:image/x-icon;base64,${output.toString('base64')}`;
}

function extractExecutableIcon(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    fd = fs.openSync(file, 'r');
    const budget = { limit: MAX_TOTAL_READ_BYTES, used: 0 };
    const headers = parseHeaders(fd, stat.size, budget);
    if (!headers) return null;
    const groups = resourceDirectory(fd, headers, 0, budget);
    const groupType = groups && groups.find(entry => !entry.named && entry.id === 14 && entry.directory);
    if (!groupType) return null;
    const names = resourceDirectory(fd, headers, groupType.child, budget);
    if (!names || names.length > MAX_ICON_GROUPS) return null;
    const candidates = [];
    for (const name of names || []) {
      if (name.named || !name.directory) continue;
      const group = dataBlob(fd, headers, 14, name.id, budget);
      const entries = parseGroupIcon(group);
      if (candidates.length + entries.length > MAX_ICON_CANDIDATES) return null;
      for (const entry of entries) candidates.push(entry);
    }
    const best = candidates.sort(compareIcon).at(-1);
    if (!best) return null;
    const bytes = dataBlob(fd, headers, 3, best.resourceId, budget, best.bytesInRes);
    const decoded = decodeIconBlob(bytes);
    return decoded ? toIco(best, decoded.bytes) : null;
  } catch (error) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function cacheKey(file) {
  return path.resolve(file).toLowerCase();
}

function dataUrlBytes(data) {
  return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : 0;
}

function createExecutableIconCache(options = {}) {
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? Math.min(options.maxEntries, MAX_CACHE_ENTRIES) : MAX_CACHE_ENTRIES;
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? Math.min(options.maxBytes, MAX_CACHE_BYTES) : MAX_CACHE_BYTES;
  const entries = new Map();
  let totalBytes = 0;
  const remove = key => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes;
  };
  const get = file => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    if (!stat.isFile()) return null;
    const key = cacheKey(file);
    const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = entries.get(key);
    if (cached && cached.fingerprint === fingerprint) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.data;
    }
    const data = extractExecutableIcon(file);
    remove(key);
    const bytes = dataUrlBytes(data);
    if (bytes <= maxBytes) {
      entries.set(key, { fingerprint, data, bytes });
      totalBytes += bytes;
      while (entries.size > maxEntries || totalBytes > maxBytes) remove(entries.keys().next().value);
    }
    return data;
  };
  const clear = file => { if (typeof file === 'string') remove(cacheKey(file)); };
  return Object.freeze({ get, clear, size: () => entries.size, bytes: () => totalBytes });
}

module.exports = {
  MAX_ICON_CANDIDATES,
  MAX_ICON_DIMENSION,
  MAX_ICON_GROUPS,
  MAX_ICON_BYTES,
  MAX_CACHE_BYTES,
  MAX_TOTAL_READ_BYTES,
  createExecutableIconCache,
  extractExecutableIcon,
  parseGroupIcon
};
