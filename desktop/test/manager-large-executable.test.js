'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { loadOwner } = require('./helpers/manager-boundary-loader.cjs');
const safety = require('../src/product/launch-safety');
const policy = require('../src/product/streamed-file-digest');
const external = loadOwner(path.join(__dirname, '../src/product/external-runtime.js'), Object.fromEntries([
  './hotkeys','./manifest','./reshade-layout','./external-profile-config','./constants','./game-support',
  './conflicts','./addon-loading-layout','./addon-compatibility','./addon-source-binding','./hoyoshade-profiles'
].map(name => [name, {}])));
const feeder = loadOwner(path.join(__dirname, '../src/product/feeder-runtime.js'), { './feeder-package-lock': {}, '../core/pe': {} });
const hashes = { operation: safety.digestFile, external: external.digest, feeder: feeder.fileDigest };
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mgr28-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(root, name, bytes) { const file = path.join(root, name); fs.writeFileSync(file, bytes); return file; }
async function sparse(file, size) {
  const fd = await fsp.open(file, 'wx');
  try { await fd.truncate(size); await fd.write(Buffer.from('MZ'), 0, 2, 0); await fd.write(Buffer.from('TAIL'), 0, 4, size - 4); }
  finally { await fd.close(); }
}
// Independent logical content generator: does not read the implementation's
// result or reuse its stream/offset code. Memory is bounded for expected values too.
function expectedSparse(size) {
  const hash = crypto.createHash('sha256'); hash.update('MZ');
  const zero = Buffer.alloc(64 * 1024); let remaining = size - 6;
  while (remaining >= zero.length) { hash.update(zero); remaining -= zero.length; }
  if (remaining) hash.update(zero.subarray(0, remaining));
  hash.update('TAIL'); return hash.digest('hex');
}
for (const [owner, hashFile] of Object.entries(hashes)) {
  test(`${owner}: known full digest, empty file and initial missing-file contract`, async t => {
    const root = fixture(t);
    assert.equal(await hashFile(put(root, 'normal.exe', 'abc')), digest('abc'));
    assert.equal(await hashFile(put(root, 'empty.ini', '')), digest(''));
    assert.equal(await hashFile(path.join(root, 'absent.exe')), null);
  });
  test(`${owner}: directories and hard links are not accepted`, async t => {
    const root = fixture(t), file = put(root, 'target.exe', 'abc');
    await assert.rejects(hashFile(root));
    await fsp.link(file, path.join(root, 'alias.exe'));
    await assert.rejects(hashFile(file), { code: 'SETTINGS_LINK_BLOCKED' });
  });
  test(`${owner}: same size and restored mtime cannot hide a later edit`, async t => {
    const root = fixture(t), file = put(root, 'target.exe', Buffer.alloc(2 * policy.CHUNK_BYTES, 9));
    const before = fs.statSync(file), first = await hashFile(file);
    const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, Buffer.from([7]), 0, 1, before.size - 1); fs.closeSync(fd);
    fs.utimesSync(file, before.atime, before.mtime);
    assert.notEqual(await hashFile(file), first);
  });
}
test('size budget only expands EXE identity inputs, not component payloads', async t => {
  const root = fixture(t), size = policy.MAX_COMPONENT_BYTES + 1;
  const file = path.join(root, 'oversized.dll'); await sparse(file, size);
  await assert.rejects(external.digest(file), e => e.code === 'DEPLOYMENT_FILE_TOO_LARGE' && e.details.bytes === size && e.details.maxBytes === policy.MAX_COMPONENT_BYTES);
  await assert.rejects(feeder.fileDigest(file), { code: 'FEEDER_FILE_TOO_LARGE' });
  assert.equal(policy.deploymentHashLimit('UPPER.EXE'), policy.MAX_EXECUTABLE_BYTES);
  assert.equal(policy.deploymentHashLimit('game.exe.bak'), policy.MAX_COMPONENT_BYTES);
});
test('oversized EXE has a specific error without attempting to allocate or hash it', async t => {
  const root = fixture(t), file = path.join(root, 'huge.exe'); await sparse(file, policy.MAX_EXECUTABLE_BYTES + 1);
  await assert.rejects(external.digest(file), e => e.code === 'DEPLOYMENT_FILE_TOO_LARGE' && e.details.maxBytes === policy.MAX_EXECUTABLE_BYTES);
});
test('MGR#28: full 976121112-byte executable works through all three production hash entrypoints', { timeout: 60000 }, async t => {
  const root = fixture(t), file = path.join(root, 'Client-Win64-Shipping.exe'), size = 976121112;
  await sparse(file, size); const expected = expectedSparse(size);
  for (const [owner, hashFile] of Object.entries(hashes)) assert.equal(await hashFile(file), expected, owner);
  assert.equal(fs.statSync(file).size, size);
});
test('full identity beyond 2 GiB still includes the final bytes', { timeout: 60000 }, async t => {
  const root = fixture(t), file = path.join(root, 'large.exe'), size = 2 * 1024 * 1024 * 1024 + 257;
  await sparse(file, size);
  assert.equal(await external.digest(file), expectedSparse(size));
});
test('symlinked file and parent are blocked before reading', async t => {
  const root = fixture(t), file = put(root, 'game.exe', 'abc'), link = path.join(root, 'link.exe');
  try { await fsp.symlink(file, link); } catch (e) { if (['EPERM','EACCES'].includes(e.code)) { t.skip('OS does not permit creating a symlink in this test environment'); return; } throw e; }
  await assert.rejects(external.digest(link), { code: 'SETTINGS_LINK_BLOCKED' });
  const parent = path.join(root, 'linked-parent'); await fsp.symlink(root, parent, 'dir');
  await assert.rejects(external.digest(path.join(parent, 'game.exe')), { code: 'SETTINGS_LINK_BLOCKED' });
});
// The fake is only the trigger, not file IO or stat data: mutate a real file at
// an exact read boundary and check the production descriptor/path checks.
async function duringFirstRead(file, mutate, work) {
  const original = fsp.open; let fired = false;
  fsp.open = async (...args) => {
    const h = await original(...args);
    if (args[0] !== file || typeof args[1] !== 'number') return h;
    return new Proxy(h, { get(target, key) {
      if (key === 'read') return async (...readArgs) => {
        const result = await target.read(...readArgs);
        if (!fired) { fired = true; await mutate(); }
        return result;
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try { await work(); assert(fired); } finally { fsp.open = original; }
}
for (const kind of ['truncate', 'grow', 'rewrite-with-old-mtime']) test(`a real ${kind} during hashing is rejected`, async t => {
  const root = fixture(t), file = put(root, 'game.exe', Buffer.alloc(2 * policy.CHUNK_BYTES, 1)), before = fs.statSync(file);
  await duringFirstRead(file, async () => {
    if (kind === 'truncate') await fsp.truncate(file, 2);
    else if (kind === 'grow') await fsp.appendFile(file, 'later');
    else { const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, Buffer.from([8]), 0, 1, before.size - 1); fs.closeSync(fd); fs.utimesSync(file, before.atime, before.mtime); }
  }, () => assert.rejects(external.digest(file), { code: 'DEPLOYMENT_FILE_CHANGED' }));
});
test('a file disappearing mid-read is not returned as a harmless missing file', async t => {
  const root = fixture(t), file = put(root, 'game.exe', Buffer.alloc(2 * policy.CHUNK_BYTES));
  await duringFirstRead(file, () => fsp.unlink(file), () => assert.rejects(external.digest(file), { code: 'DEPLOYMENT_FILE_CHANGED' }));
});
test('whole-file readFile is never used by any production digest entrypoint', async t => {
  const root = fixture(t), file = put(root, 'game.exe', 'not a readFile buffer'), original = fsp.readFile;
  fsp.readFile = async () => { throw new Error('Unexpected whole-file allocation'); };
  try { for (const hashFile of Object.values(hashes)) assert.equal(await hashFile(file), digest('not a readFile buffer')); }
  finally { fsp.readFile = original; }
});
test('every descriptor is closed after success and rejected identity', async t => {
  const root = fixture(t), file = put(root, 'game.exe', 'abc'), original = fsp.open; let opened = 0, closed = 0;
  fsp.open = async (...args) => {
    const h = await original(...args); opened++;
    return new Proxy(h, { get(target, key) {
      if (key === 'close') return async () => { closed++; return target.close(); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try { await external.digest(file); } finally { fsp.open = original; }
  assert.equal(opened, closed); assert.equal(opened, 1);
});
