'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

// EXEs are identity inputs, never deployment payloads. Keep the existing
// component budget separate from modern games' much larger executables.
const MAX_COMPONENT_BYTES = 768 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 8 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const deploymentHashLimit = file => /\.exe$/i.test(file) ? MAX_EXECUTABLE_BYTES : MAX_COMPONENT_BYTES;
const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]);
const defaultFail = (code, message, details) => { throw Object.assign(new Error(message), { code: 'FILE_DIGEST_' + code, details }); };

/** Full-file SHA-256 with bounded memory. No content cache or prefix sampling.
 * assertPath is supplied by the existing owner so link/alias policy stays in
 * one place; its failures are preserved. Missing at first inspection is null,
 * whereas disappearance/replacement during an established read is a change.
 */
async function hashRegularFile(file, { assertPath, maxBytes = Number.MAX_SAFE_INTEGER, fail = defaultFail } = {}) {
  if (typeof assertPath !== 'function' || typeof fail !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new TypeError('Invalid file digest policy');
  await assertPath(file);
  let before;
  try { before = await fsp.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1 || !Number.isSafeInteger(before.size) || before.size < 0)
    fail('FILE', '目标不是可校验的独立普通文件。', { file });
  if (before.size > maxBytes)
    fail('FILE_TOO_LARGE', `文件大小 ${before.size} 字节，超过当前完整校验上限 ${maxBytes} 字节；未跳过身份校验。`, { file, bytes: before.size, maxBytes });

  let handle;
  try {
    // O_NOFOLLOW/O_NONBLOCK are effective where available. Descriptor and path
    // identity checks remain necessary on Windows and for intermediate paths.
    handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !unchanged(before, opened)) fail('FILE_CHANGED', '打开校验文件时身份发生变化，请重新预览。', { file });
    const sha = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, before.size)));
    let offset = 0;
    while (offset < before.size) {
      const length = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > length)
        fail('FILE_CHANGED', '文件在完整校验期间被截短或无法完整读取。', { file });
      sha.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    await assertPath(file);
    const current = await fsp.lstat(file);
    if (!current.isFile() || current.isSymbolicLink() || !unchanged(before, after) || !unchanged(after, current))
      fail('FILE_CHANGED', '文件在完整校验期间被修改或替换，请重新预览。', { file });
    return sha.digest('hex');
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code))
      fail('FILE_CHANGED', '文件在完整校验期间消失或路径发生变化，请重新预览。', { file });
    throw error;
  } finally { if (handle) await handle.close(); }
}

module.exports = { hashRegularFile, deploymentHashLimit, MAX_COMPONENT_BYTES, MAX_EXECUTABLE_BYTES, CHUNK_BYTES };
