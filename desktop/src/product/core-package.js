'use strict';

// Reads a Core handoff package: install/ holds the Chinese Core, nrchain, one
// DLSS5 model (nvngx_dlssnr.dll) and nr_face; manifest.json lists their digests.
// The archive digest must be registered in core-catalog.js, the listed digests
// must match the catalog, and every member used is hashed while it is read.
// The large DLSS5 model is streamed to a file instead of being held in memory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl');
const catalog = require('../shared/core-catalog');
const companions = require('./payload-companions');
const { hashRegularFile } = require('./streamed-file-digest');
const { noLinks } = require('./launch-safety');

const SCHEMA = 'dlss5-local-two-runtime-handoff/v1';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_SMALL_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const CORE = 'install/nr-before-sr.zh-CN.addon64';
const CHAIN = 'install/nrchain_nvngx.dll';
const RUNTIME = 'install/nvngx_dlssnr.dll';
const NOTICE = 'LICENSES.txt';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'ERR_CORE_PACKAGE' }); };

function archiveName(value) {
  const name = String(value || '').replace(/\\/g, '/');
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\0-\x1f\x7f]/.test(name) ||
      parts.some((part, index) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) fail('包内路径不安全。');
  return name;
}

// Visits every entry once. `take(name, entry)` returns 'buffer', a target file
// path, or null to skip. Buffers and files are size-checked against the header.
function readEntries(file, take) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const buffers = new Map(), files = new Map(), names = new Set();
      let settled = false;
      const stop = reason => { if (settled) return; settled = true; try { zip.close(); } catch {} reject(reason); };
      zip.on('error', stop);
      zip.on('end', () => { if (!settled) { settled = true; resolve({ buffers, files, names }); } });
      zip.on('entry', entry => {
        if (settled) return;
        let name;
        try { name = archiveName(entry.fileName); } catch (cause) { return stop(cause); }
        const key = name.replace(/\/$/, '').toLowerCase();
        if (names.has(key)) return stop(Object.assign(new Error(`包内有重复路径：${name}`), { code: 'ERR_CORE_PACKAGE' }));
        names.add(key);
        if (name.endsWith('/')) return zip.readEntry();
        if ((entry.generalPurposeBitFlag & 1) !== 0) return stop(Object.assign(new Error('包内文件被加密。'), { code: 'ERR_CORE_PACKAGE' }));
        const target = take(name, entry);
        if (!target) return zip.readEntry();
        const limit = target === 'buffer' ? MAX_SMALL_BYTES : MAX_RUNTIME_BYTES;
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > limit)
          return stop(Object.assign(new Error(`包内文件过大：${name}`), { code: 'ERR_CORE_PACKAGE' }));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return stop(streamError);
          const hash = crypto.createHash('sha256'), chunks = [];
          let size = 0, out = null;
          if (target !== 'buffer') out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('data', chunk => {
            size += chunk.length; hash.update(chunk);
            if (size > limit) { stream.destroy(Object.assign(new Error(`包内文件过大：${name}`), { code: 'ERR_CORE_PACKAGE' })); return; }
            if (out) { if (!out.write(chunk)) { stream.pause(); out.once('drain', () => stream.resume()); } } else chunks.push(chunk);
          });
          stream.on('error', cause => { out?.destroy(); stop(cause); });
          stream.on('end', () => {
            if (settled) return;
            const finish = () => {
              if (size !== entry.uncompressedSize) return stop(Object.assign(new Error(`包内文件大小不符：${name}`), { code: 'ERR_CORE_PACKAGE' }));
              if (out) files.set(name, { file: target, bytes: size, sha256: hash.digest('hex') });
              else buffers.set(name, Buffer.concat(chunks));
              zip.readEntry();
            };
            if (out) { out.on('error', stop); out.end(finish); } else finish();
          });
        });
      });
      zip.readEntry();
    });
  });
}

// runtimeFile: where to write the DLSS5 model (must not exist). Without it the
// model is skipped; the Core, nrchain, face assets and notice are always read.
async function readCorePackage(file, { runtimeFile = null } = {}) {
  await noLinks(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_BYTES) fail('这不是可用的 Core 包。');
  const archiveSha256 = await hashRegularFile(file, { assertPath: noLinks, maxBytes: MAX_ARCHIVE_BYTES });
  const registered = catalog.coreForPackage(archiveSha256);
  if (!registered || registered.bytes !== stat.size) fail('这个 Core 包未在 src/shared/core-catalog.js 登记，或文件与登记不符。');
  const { core, variant } = registered;
  if (runtimeFile && fs.existsSync(runtimeFile)) fail('DLSS5 模型输出位置已存在。');
  const wanted = new Set([CORE, CHAIN, NOTICE, 'manifest.json', ...companions.NAMES.map(name => `install/${name}`)]);
  const read = await readEntries(file, name => name === RUNTIME ? runtimeFile : wanted.has(name) ? 'buffer' : null);
  const buffer = name => { const data = read.buffers.get(name); if (!data) fail(`包内缺少 ${name}。`); return data; };

  const manifestBytes = buffer('manifest.json');
  if (manifestBytes.length > MAX_METADATA_BYTES) fail('manifest.json 过大。');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^﻿/, '')); } catch { fail('manifest.json 无法解析。'); }
  if (manifest?.schema !== SCHEMA || manifest.version !== core.displayVersion || manifest.gpu_family !== variant ||
      String(manifest.source_commit || '').toLowerCase() !== core.sourceCommit) fail('manifest.json 与登记的 Core 身份不符。');
  const listed = new Map([...(manifest.install_files || []), ...(manifest.face_assets || [])].map(row => [String(row?.path || ''), row]));
  const expect = { [CORE]: core.addon['zh-CN'], [CHAIN]: core.chain, [RUNTIME]: registered.runtime };
  for (const [name, sha256] of Object.entries(expect))
    if (listed.get(name)?.sha256 !== sha256) fail(`manifest.json 中 ${name} 的摘要与登记不符。`);
  const checked = name => {
    const data = buffer(name), row = listed.get(name);
    if (!row || digest(data) !== String(row.sha256 || '').toLowerCase() || row.bytes !== data.length) fail(`${name} 的摘要与 manifest.json 不符。`);
    return { data, sha256: digest(data) };
  };
  const addon = checked(CORE), bridge = checked(CHAIN);
  const faces = companions.NAMES.map(name => ({ name, ...checked(`install/${name}`) }));
  if (listed.size !== 3 + companions.NAMES.length) fail('manifest.json 列出了未知文件。');
  const notice = buffer(NOTICE);
  if (manifest.licenses_sha256 && digest(notice) !== manifest.licenses_sha256) fail('LICENSES.txt 的摘要与 manifest.json 不符。');

  let runtime = { sha256: registered.runtime, series: [...registered.series], file: null, bytes: listed.get(RUNTIME).bytes };
  if (runtimeFile) {
    const written = read.files.get(RUNTIME);
    if (!written) fail(`包内缺少 ${RUNTIME}。`);
    if (written.sha256 !== registered.runtime || written.bytes !== listed.get(RUNTIME).bytes) {
      fs.rmSync(runtimeFile, { force: true }); fail('DLSS5 模型的摘要与登记不符。');
    }
    runtime = { ...runtime, file: path.resolve(runtimeFile) };
  }
  return { archiveSha256, core, variant, addon: addon.data, addonSha256: addon.sha256, bridge: bridge.data, bridgeSha256: bridge.sha256,
    companions: faces.map(row => ({ name: row.name, data: row.data, sha256: row.sha256 })),
    notices: [{ name: NOTICE, data: notice, sha256: digest(notice) }], runtime };
}

module.exports = { readCorePackage, SCHEMA };
