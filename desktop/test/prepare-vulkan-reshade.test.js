'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { extractZipEntries, prepare, sha256 } = require('../scripts/prepare-vulkan-reshade');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-reshade-recipe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function syntheticZip(entries, prefix = Buffer.alloc(23, 0x5a)) {
  const locals = [], central = []; let offset = prefix.length;
  for (const [name, content] of entries) {
    const bytes = Buffer.from(content), compressed = zlib.deflateRawSync(bytes), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30);
    locals.push(Buffer.concat([local, compressed]));
    const row = Buffer.alloc(46 + nameBytes.length);
    row.writeUInt32LE(0x02014b50, 0); row.writeUInt16LE(20, 4); row.writeUInt16LE(20, 6); row.writeUInt16LE(8, 10);
    row.writeUInt32LE(compressed.length, 20); row.writeUInt32LE(bytes.length, 24); row.writeUInt16LE(nameBytes.length, 28); row.writeUInt32LE(offset - prefix.length, 42); nameBytes.copy(row, 46);
    central.push(row); offset += local.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central), centralOffset = offset;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(centralOffset - prefix.length, 16);
  return Buffer.concat([prefix, ...locals, centralBytes, eocd]);
}

test('bounded ZIP reader handles the SFX prefix and extracts only named ReShade files', () => {
  const dll = Buffer.from('dll'), manifest = Buffer.from('{"layer":{}}');
  const entries = extractZipEntries(syntheticZip([['ReShade64.dll', dll], ['ReShade64.json', manifest], ['other.txt', 'ignore']]), new Set(['ReShade64.dll', 'ReShade64.json']));
  assert.deepEqual(entries.get('ReShade64.dll'), dll); assert.deepEqual(entries.get('ReShade64.json'), manifest); assert.equal(entries.size, 2);
});

test('source hash failure happens before destination creation', async t => {
  const root = tempRoot(t), source = path.join(root, 'setup.exe'), destination = path.join(root, 'resources', 'vulkan-reshade');
  fs.writeFileSync(source, 'tampered');
  assert.throws(() => prepare(source, destination), { code: 'VULKAN_RESHADE_SOURCE_HASH' });
  assert.equal(fs.existsSync(destination), false);
});

test('fixed Setup extraction is reproducible when a reviewed source is supplied', { skip: !process.env.RESHADE_SETUP_EXE }, async t => {
  const root = tempRoot(t), destination = path.join(root, 'resources', 'vulkan-reshade');
  const result = prepare(process.env.RESHADE_SETUP_EXE, destination);
  assert.equal(result.sourceSha256, 'afe4c8f13048306307983b8b3d41d5bf00a86820440b0e57dea10950e1176445');
  assert.equal(result.files['ReShade64.dll'].sha256, '0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7');
  assert.equal(result.files['ReShade64.json'].sha256, 'aa21713718843e531da396e2bfc80772c9cb3c369d6c30b836be6b0ae812d503');
  assert.equal(result.files['LICENSE.md'].sha256, 'd2bb5eb908e9aa7ac2f7f4cf6441d62e1f6ac1256cf22bb5289516c9f30e5f0a');
  const second = prepare(process.env.RESHADE_SETUP_EXE, destination);
  assert.deepEqual(second.files, result.files);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, 'recipe.json'), 'utf8')), result.recipe);
  assert.equal(sha256(fs.readFileSync(path.join(destination, 'ReShade64.dll'))), result.files['ReShade64.dll'].sha256);
});
