'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(k => a[k] === b[k]);
function sha256(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw Object.assign(new Error('校验来源必须是普通文件。'), { code: 'FILE_DIGEST_FILE' });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!same(before, fs.fstatSync(fd))) throw new Error('文件在打开时发生变化。');
    const hash = crypto.createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!n) throw new Error('文件在校验时被截短。');
      hash.update(chunk.subarray(0, n)); offset += n;
    }
    if (!same(before, fs.fstatSync(fd)) || !same(before, fs.lstatSync(file))) throw new Error('文件在校验期间发生变化。');
    return hash.digest('hex');
  } catch (error) { error.code ||= 'FILE_DIGEST_CHANGED'; throw error; }
  finally { fs.closeSync(fd); }
}
module.exports = { sha256 };
