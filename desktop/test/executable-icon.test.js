'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MAX_CACHE_BYTES,
  MAX_ICON_BYTES,
  MAX_TOTAL_READ_BYTES,
  createExecutableIconCache,
  extractExecutableIcon
} = require('../src/product/executable-icon');

function png(width, height, size = 1024) {
  const value = Buffer.alloc(size);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.writeUInt32BE(13, 8); value.write('IHDR', 12, 'ascii');
  value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20);
  return value;
}

function directory(buffer, offset, id, child, childDirectory = true) {
  buffer.writeUInt16LE(0, offset + 12);
  buffer.writeUInt16LE(1, offset + 14);
  buffer.writeUInt32LE(id, offset + 16);
  buffer.writeUInt32LE(childDirectory ? (child | 0x80000000) >>> 0 : child, offset + 20);
}

function syntheticPeIcon(file, options = {}) {
  const width = options.width || 256;
  const height = options.height || 256;
  const icon = png(width, height);
  const group = Buffer.alloc(20);
  group.writeUInt16LE(0, 0); group.writeUInt16LE(1, 2); group.writeUInt16LE(1, 4);
  group[6] = width >= 256 ? 0 : width; group[7] = height >= 256 ? 0 : height;
  group.writeUInt16LE(1, 10); group.writeUInt16LE(32, 12); group.writeUInt32LE(icon.length, 14); group.writeUInt16LE(1, 18);

  const resource = Buffer.alloc(0x800);
  directory(resource, 0, 3, 32);
  resource.writeUInt16LE(2, 14);
  resource.writeUInt32LE(14, 24); resource.writeUInt32LE((96 | 0x80000000) >>> 0, 28);
  directory(resource, 32, 1, 56);
  directory(resource, 56, 0x409, 80, false);
  resource.writeUInt32LE(0x1000 + 192, 80); resource.writeUInt32LE(icon.length, 84);
  directory(resource, 96, 1, 120);
  directory(resource, 120, 0x409, 144, false);
  resource.writeUInt32LE(0x1000 + 160, 144); resource.writeUInt32LE(group.length, 148);
  group.copy(resource, 160); icon.copy(resource, 192);

  const fileValue = Buffer.alloc(0x400 + 0x1000);
  fileValue.writeUInt16LE(0x5a4d, 0); fileValue.writeUInt32LE(0x80, 0x3c);
  fileValue.writeUInt32LE(0x00004550, 0x80);
  const coff = 0x84; fileValue.writeUInt16LE(0x8664, coff); fileValue.writeUInt16LE(1, coff + 2); fileValue.writeUInt16LE(0xf0, coff + 16);
  const optional = coff + 20; fileValue.writeUInt16LE(0x20b, optional); fileValue.writeUInt32LE(16, optional + 108);
  const resourceDirectory = optional + 112 + 2 * 8; fileValue.writeUInt32LE(0x1000, resourceDirectory); fileValue.writeUInt32LE(resource.length, resourceDirectory + 4);
  const section = optional + 0xf0; fileValue.write('.rsrc', section, 'ascii'); fileValue.writeUInt32LE(resource.length, section + 8);
  fileValue.writeUInt32LE(0x1000, section + 12); fileValue.writeUInt32LE(0x1000, section + 16); fileValue.writeUInt32LE(0x400, section + 20);
  resource.copy(fileValue, 0x400);
  fs.writeFileSync(file, fileValue);
}

function writeDirectory(buffer, offset, ids, children, directories = []) {
  buffer.writeUInt16LE(0, offset + 12);
  buffer.writeUInt16LE(ids.length, offset + 14);
  ids.forEach((id, index) => {
    buffer.writeUInt32LE(id, offset + 16 + index * 8);
    const child = children[index];
    const directory = directories[index] ?? true;
    buffer.writeUInt32LE(directory ? (child | 0x80000000) >>> 0 : child, offset + 20 + index * 8);
  });
}

function syntheticPeWithAliasedGroups(file, groupCount, groupBytes, candidateCount = 1) {
  const icon = png(256, 256);
  const groupBlob = Buffer.alloc(groupBytes);
  groupBlob.writeUInt16LE(0, 0); groupBlob.writeUInt16LE(1, 2); groupBlob.writeUInt16LE(candidateCount, 4);
  for (let index = 0; index < candidateCount; index++) {
    const offset = 6 + index * 14;
    groupBlob[offset] = 0; groupBlob[offset + 1] = 0;
    groupBlob.writeUInt16LE(1, offset + 4); groupBlob.writeUInt16LE(32, offset + 6);
    groupBlob.writeUInt32LE(icon.length, offset + 8); groupBlob.writeUInt16LE(1, offset + 12);
  }

  const groupType = 32;
  const groupNameStart = groupType + 16 + groupCount * 8;
  const iconType = groupNameStart + groupCount * 24;
  const iconName = iconType + 24;
  const iconDataEntry = iconName + 24;
  const groupData = Math.ceil((iconDataEntry + 16) / 16) * 16;
  const iconData = groupData + groupBytes;
  const resource = Buffer.alloc(iconData + icon.length);
  const groupNames = Array.from({ length: groupCount }, (_, index) => groupNameStart + index * 24);

  writeDirectory(resource, 0, [3, 14], [iconType, groupType]);
  writeDirectory(resource, groupType, Array.from({ length: groupCount }, (_, index) => index + 1), groupNames);
  groupNames.forEach((nameOffset, index) => {
    const dataEntry = nameOffset + 16;
    writeDirectory(resource, nameOffset, [0x409], [dataEntry], [false]);
    resource.writeUInt32LE(0x1000 + groupData, dataEntry);
    resource.writeUInt32LE(groupBytes, dataEntry + 4);
  });
  writeDirectory(resource, iconType, [1], [iconName]);
  writeDirectory(resource, iconName, [0x409], [iconDataEntry], [false]);
  resource.writeUInt32LE(0x1000 + iconData, iconDataEntry);
  resource.writeUInt32LE(icon.length, iconDataEntry + 4);
  groupBlob.copy(resource, groupData);
  icon.copy(resource, iconData);

  const fileValue = Buffer.alloc(0x400 + resource.length);
  fileValue.writeUInt16LE(0x5a4d, 0); fileValue.writeUInt32LE(0x80, 0x3c);
  fileValue.writeUInt32LE(0x00004550, 0x80);
  const coff = 0x84; fileValue.writeUInt16LE(0x8664, coff); fileValue.writeUInt16LE(1, coff + 2); fileValue.writeUInt16LE(0xf0, coff + 16);
  const optional = coff + 20; fileValue.writeUInt16LE(0x20b, optional); fileValue.writeUInt32LE(16, optional + 108);
  const resourceDirectory = optional + 112 + 2 * 8; fileValue.writeUInt32LE(0x1000, resourceDirectory); fileValue.writeUInt32LE(resource.length, resourceDirectory + 4);
  const section = optional + 0xf0; fileValue.write('.rsrc', section, 'ascii'); fileValue.writeUInt32LE(resource.length, section + 8);
  fileValue.writeUInt32LE(0x1000, section + 12); fileValue.writeUInt32LE(resource.length, section + 16); fileValue.writeUInt32LE(0x400, section + 20);
  resource.copy(fileValue, 0x400);
  fs.writeFileSync(file, fileValue);
}

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-executable-icon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('extracts the largest RT_GROUP_ICON resource without executing the PE', t => {
  const file = path.join(temp(t), 'HTGame.exe');
  syntheticPeIcon(file);
  const data = extractExecutableIcon(file);
  assert.match(data, /^data:image\/x-icon;base64,/);
  const ico = Buffer.from(data.split(',')[1], 'base64');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico[6], 0, '256px icon uses the ICO zero dimension marker');
  assert.equal(ico[7], 0);
  assert.deepEqual(ico.subarray(22, 30), png(256, 256).subarray(0, 8));
});

test('cache is bounded and invalidates on executable size/mtime changes', t => {
  const root = temp(t), first = path.join(root, 'a.exe'), second = path.join(root, 'b.exe');
  syntheticPeIcon(first); fs.writeFileSync(second, Buffer.from('not a PE'));
  const cache = createExecutableIconCache({ maxEntries: 1 });
  assert.ok(cache.get(first));
  assert.equal(cache.size(), 1);
  assert.equal(cache.get(second), null);
  assert.equal(cache.size(), 1);
  fs.appendFileSync(first, Buffer.from([0]));
  assert.ok(cache.get(first), 'a changed executable is parsed again and remains valid');
  assert.equal(cache.size(), 1);
});

test('cache enforces a fixed total data URL budget and skips oversized entries', t => {
  const root = temp(t), first = path.join(root, 'a.exe'), second = path.join(root, 'b.exe');
  syntheticPeIcon(first); syntheticPeIcon(second);
  const firstData = extractExecutableIcon(first);
  const firstBytes = Buffer.byteLength(firstData, 'utf8');
  assert.ok(firstBytes > 100);
  assert.ok(MAX_CACHE_BYTES > firstBytes * 2);

  const cache = createExecutableIconCache({ maxBytes: 100 });
  assert.ok(cache.get(first));
  assert.equal(cache.size(), 0, 'an item over the test budget is returned but not cached');
  assert.equal(cache.bytes(), 0);

  const bounded = createExecutableIconCache({ maxBytes: firstBytes * 2 - 1 });
  assert.ok(bounded.get(first));
  assert.equal(bounded.size(), 1);
  assert.equal(bounded.bytes(), firstBytes);
  assert.ok(bounded.get(second));
  assert.equal(bounded.size(), 1, 'oldest item is evicted when the total byte budget is exceeded');
  assert.equal(bounded.bytes(), firstBytes);
});

test('malformed or non-PE files fail closed without a fallback guess', t => {
  const file = path.join(temp(t), 'not-a-game.exe');
  fs.writeFileSync(file, Buffer.from('MZ but truncated'));
  assert.equal(extractExecutableIcon(file), null);
});

test('cumulative read budget rejects repeated large resource blobs', t => {
  const file = path.join(temp(t), 'over-budget.exe');
  const groupBytes = MAX_ICON_BYTES;
  const groupCount = Math.ceil(MAX_TOTAL_READ_BYTES / groupBytes) + 1;
  syntheticPeWithAliasedGroups(file, groupCount, groupBytes);
  assert.equal(extractExecutableIcon(file), null);
});

test('group and candidate limits fail closed before broad resource traversal', t => {
  const tooManyGroups = path.join(temp(t), 'too-many-groups.exe');
  syntheticPeWithAliasedGroups(tooManyGroups, 129, 1024);
  assert.equal(extractExecutableIcon(tooManyGroups), null);

  const tooManyCandidates = path.join(temp(t), 'too-many-candidates.exe');
  syntheticPeWithAliasedGroups(tooManyCandidates, 2, 4096, 129);
  assert.equal(extractExecutableIcon(tooManyCandidates), null);
});

test('optional real HTGame extraction is read-only when a path is supplied', { skip: !process.env.XIAOFENG_HTGAME_EXE }, () => {
  assert.ok(extractExecutableIcon(path.resolve(process.env.XIAOFENG_HTGAME_EXE)));
});
