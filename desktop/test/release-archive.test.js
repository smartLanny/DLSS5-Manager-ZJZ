'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { verify } = require('../scripts/verify-release-archive');

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const [name, text, deflated] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(text), payload = deflated ? zlib.deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(deflated ? 8 : 0, 8);
    header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); header.copy(record, 6, 4, 28); record.writeUInt32LE(offset, 42);
    local.push(header, filename, payload); central.push(record, filename); offset += header.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-archive-')), source = path.join(root, 'source'), archive = path.join(root, 'release.zip');
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.mkdirSync(source);
  const entries = [['image.png', 'stored already-compressed bytes', false], ['使用说明.txt', 'deflated documentation bytes', true]];
  for (const [name, text] of entries) fs.writeFileSync(path.join(source, name), text);
  fs.writeFileSync(archive, zip(entries)); return { source, archive, entries };
}

test('release verification completes every stored and deflated entry including Unicode names', async t => {
  const f = fixture(t), result = await verify(f.archive, f.source);
  assert.equal(result.ok, true); assert.equal(result.verifiedFiles, 2); assert.equal(result.extracted, false);
  assert.deepEqual(result.files.map(row => row.file), f.entries.map(row => row[0]));
});

test('release verification rejects changed archive bytes even when the file size matches', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, 'image.png'), 'Stored already-compressed bytes');
  await assert.rejects(verify(f.archive, f.source), /Archive content changed: image\.png/);
});
