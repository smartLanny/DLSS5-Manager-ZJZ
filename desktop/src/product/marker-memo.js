'use strict';

// A library scan looks for graphics-API names inside game EXEs and DLLs
// (pe.findMarkers). When none is found early, the whole file is read, and a
// protected EXE can be hundreds of MB, read again on every scan. The answer
// depends only on the file's bytes and the names asked for, so it is kept per
// file identity (volume, file id, size, modified and changed time) and read
// again as soon as any of these differ. Folder walks are never kept: new,
// removed and renamed files are always seen. A failed or incomplete read is
// never kept and falls back to the original reader, so its result is unchanged.
const fs = require('node:fs');
const path = require('node:path');

const MEMO_VERSION = 1;
const MAX_ENTRIES = 2048;
const CHUNK_BYTES = 4 * 1024 * 1024;

const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const keyFor = (file, markers) => {
  const resolved = path.resolve(file);
  return [process.platform === 'win32' ? resolved.toLowerCase() : resolved, ...markers].join('\0');
};

// Same search as the upstream pe.findMarkers, except that a failed or short
// read throws instead of returning what was found so far.
function readMarkers(file, markers) {
  const needles = markers.map(text => ({ text, buf: Buffer.from(text, 'latin1') }));
  const longest = Math.max(...needles.map(needle => needle.buf.length));
  const found = new Set();
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK_BYTES + longest);
    let pos = 0, carry = 0;
    while (pos < size) {
      const read = fs.readSync(fd, buf, carry, CHUNK_BYTES, pos);
      if (read <= 0) throw Object.assign(new Error('文件在读取时被截短。'), { code: 'ERR_MARKER_SHORT_READ' });
      const view = buf.subarray(0, carry + read);
      for (const needle of needles) if (!found.has(needle.text) && view.includes(needle.buf)) found.add(needle.text);
      if (found.size === needles.length) break;
      carry = Math.min(longest, view.length);
      view.subarray(view.length - carry).copy(buf, 0);
      pos += read;
    }
  } finally { fs.closeSync(fd); }
  return found;
}

function createMarkerMemo({ original, file: storeFile = null, appVersion = '' } = {}) {
  if (typeof original !== 'function') throw new TypeError('Marker memo needs the original reader.');
  const entries = new Map();
  let dirty = false;

  function remember(key, value) {
    entries.delete(key); entries.set(key, value);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  }

  function findMarkers(file, markers) {
    const list = Array.isArray(markers) ? markers.map(String) : null;
    if (typeof file !== 'string' || !list || !list.length || list.some(text => !text)) return original(file, markers);
    let before;
    try { before = fs.statSync(file); } catch { return original(file, markers); }
    if (!before.isFile()) return original(file, markers);
    const key = keyFor(file, list), id = identity(before), hit = entries.get(key);
    if (hit && hit.id === id) { remember(key, hit); return new Set(hit.found); }
    let found;
    try { found = readMarkers(file, list); } catch { return original(file, markers); }
    try {
      // A file that changed while it was read is answered but not kept.
      if (identity(fs.statSync(file)) === id) { remember(key, { id, found: [...found] }); dirty = true; }
    } catch {}
    return found;
  }

  function clear() { if (entries.size) dirty = true; entries.clear(); }

  function load() {
    if (!storeFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      if (data?.version !== MEMO_VERSION || data.appVersion !== appVersion || !Array.isArray(data.entries)) return;
      for (const row of data.entries.slice(-MAX_ENTRIES)) {
        if (Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string' &&
            Array.isArray(row[2]) && row[2].every(text => typeof text === 'string')) entries.set(row[0], { id: row[1], found: row[2] });
      }
    } catch { entries.clear(); }
  }

  // Written after a scan. A lost or damaged file only means the next scan reads again.
  function save() {
    if (!storeFile || !dirty) return;
    const temp = `${storeFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: MEMO_VERSION, appVersion,
        entries: [...entries].map(([key, value]) => [key, value.id, value.found]) }));
      fs.renameSync(temp, storeFile);
      dirty = false;
    } catch { try { fs.unlinkSync(temp); } catch {} }
  }

  load();
  return { findMarkers, clear, save, get size() { return entries.size; } };
}

module.exports = { createMarkerMemo, readMarkers, MEMO_VERSION };
