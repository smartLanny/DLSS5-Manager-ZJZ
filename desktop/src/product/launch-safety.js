'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { hashRegularFile } = require('./streamed-file-digest');

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function assertLaunchNotCancelled(controls) {
  if (controls?.cancelled?.()) fail('LAUNCH_CANCELLED', '已取消本次启动等待。');
}
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
async function noLinks(target) {
  const full = path.resolve(target), parsed = path.parse(full); let current = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) fail('SETTINGS_LINK_BLOCKED', '检测到链接或硬链接，未修改配置。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function digestFile(file) {
  // OperationPlan also hashes the game EXE: do not allocate it as one Buffer.
  return hashRegularFile(file, { assertPath: noLinks });
}
async function atomicJson(file, value) {
  await noLinks(file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let handle, created = false;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await noLinks(file);
    await fs.rename(temp, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
module.exports = { fail, sha256, inside, noLinks, digestFile, atomicJson, assertLaunchNotCancelled };
