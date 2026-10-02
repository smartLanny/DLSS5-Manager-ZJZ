'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const pe = require('../src/core/pe');
const { createMarkerMemo, MEMO_VERSION } = require('../src/product/marker-memo');
const { createLibraryWorkerClient } = require('../src/product/library-worker-client');

const MARKERS = ['D3D12CreateDevice', 'D3D11CreateDevice', 'vkCreateInstance', 'wglCreateContext'];
const CHUNK = 4 * 1024 * 1024;
const original = pe.findMarkers;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function temporary(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'marker-memo-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Bytes with markers at chosen offsets; offsets near CHUNK straddle a read boundary.
function file(root, name, size, placed = []) {
  const bytes = crypto.randomBytes(size).map(value => value & 0x3f);
  for (const [offset, text] of placed) bytes.write(text, offset, 'latin1');
  const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  return target;
}

// Readable PE headers/import tables without executable code (as in api-assessment-production.test.js).
function binary(target, { imports = [], markers = [], size = 8192 } = {}) {
  const b = Buffer.alloc(8192), optional = 0x98, optionalSize = 240;
  b.writeUInt16LE(0x5a4d); b.writeUInt32LE(0x80, 0x3c); b.writeUInt32LE(0x4550, 0x80);
  b.writeUInt16LE(0x8664, 0x84); b.writeUInt16LE(1, 0x86); b.writeUInt16LE(optionalSize, 0x94);
  b.writeUInt16LE(0x20b, optional);
  const section = optional + optionalSize, directory = optional + 112 + 8;
  b.write('.idata', section); b.writeUInt32LE(0x1000, section + 8); b.writeUInt32LE(0x1000, section + 12);
  b.writeUInt32LE(0x1000, section + 16); b.writeUInt32LE(0x400, section + 20);
  if (imports.length) { b.writeUInt32LE(0x1000, directory); b.writeUInt32LE((imports.length + 1) * 20, directory + 4); }
  imports.forEach((name, index) => { b.writeUInt32LE(0x1200 + index * 128, 0x400 + index * 20 + 12); b.write(name, 0x600 + index * 128); });
  b.write(markers.join(' '), 0x1800);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, b);
  if (size > b.length) { const fd = fs.openSync(target, 'r+'); try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); } }
  return target;
}

test('the memo answers exactly like the upstream reader, including markers across read boundaries', t => {
  const root = temporary(t), memo = createMarkerMemo({ original });
  const cases = [
    file(root, 'none.exe', CHUNK + 1000),
    file(root, 'early.exe', 5000, [[100, 'D3D12CreateDevice'], [200, 'D3D11CreateDevice'], [300, 'vkCreateInstance'], [400, 'wglCreateContext']]),
    file(root, 'boundary.exe', CHUNK * 2 + 77, [[CHUNK - 8, 'D3D12CreateDevice'], [CHUNK * 2 - 3, 'wglCreateContext']]),
    file(root, 'tail.exe', CHUNK + 50, [[CHUNK + 50 - 'vkCreateInstance'.length, 'vkCreateInstance']]),
    file(root, 'empty.exe', 0)
  ];
  for (const target of cases) {
    const expected = [...original(target, MARKERS)].sort();
    assert.deepEqual([...memo.findMarkers(target, MARKERS)].sort(), expected, path.basename(target));
    assert.deepEqual([...memo.findMarkers(target, MARKERS)].sort(), expected, `${path.basename(target)} remembered`);
  }
});

test('an unchanged file is not read again; a changed or replaced file is', async t => {
  const root = temporary(t), memo = createMarkerMemo({ original });
  const target = file(root, 'Game.exe', 64 * 1024, [[1000, 'D3D11CreateDevice']]);
  const pinned = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(target, pinned, pinned);
  const reads = t.mock.method(fs, 'readSync');
  assert.deepEqual([...memo.findMarkers(target, MARKERS)], ['D3D11CreateDevice']);
  const first = reads.mock.callCount();
  assert.ok(first > 0);
  assert.deepEqual([...memo.findMarkers(target, MARKERS)], ['D3D11CreateDevice']);
  assert.equal(reads.mock.callCount(), first, 'a second scan does not read the file');
  assert.deepEqual([...memo.findMarkers(target, ['D3D11CreateDevice'])], ['D3D11CreateDevice']);
  assert.ok(reads.mock.callCount() > first, 'a different marker list is its own entry');

  // Same size, rewritten in place, with the exact old modified time put back:
  // only the changed time differs, and the file is still read again.
  const before = fs.statSync(target);
  await sleep(50);
  const bytes = fs.readFileSync(target); bytes.write('D3D12CreateDevice', 3000, 'latin1'); fs.writeFileSync(target, bytes);
  fs.utimesSync(target, pinned, pinned);
  const after = fs.statSync(target);
  assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  assert.deepEqual([...memo.findMarkers(target, MARKERS)].sort(), ['D3D11CreateDevice', 'D3D12CreateDevice']);

  // Replaced by rename, as updaters do.
  const next = file(root, 'next.bin', 64 * 1024, [[10, 'vkCreateInstance']]);
  fs.renameSync(next, target);
  assert.deepEqual([...memo.findMarkers(target, MARKERS)], ['vkCreateInstance']);
});

test('failed reads, folders and odd arguments go to the original reader and are never remembered', t => {
  const root = temporary(t), target = file(root, 'Game.exe', 4096, [[10, 'D3D12CreateDevice']]);
  const calls = [];
  const memo = createMarkerMemo({ original: (...args) => { calls.push(args); return original(...args); } });
  const open = fs.openSync;
  let failOnce = true;
  t.mock.method(fs, 'openSync', (...args) => {
    if (failOnce && args[0] === target) { failOnce = false; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
    return open(...args);
  });
  assert.deepEqual([...memo.findMarkers(target, MARKERS)], ['D3D12CreateDevice']);
  assert.equal(calls.length, 1, 'a failed read falls back to the original reader');
  assert.equal(memo.size, 0, 'and is not remembered');
  memo.findMarkers(target, MARKERS);
  assert.equal(calls.length, 1); assert.equal(memo.size, 1);
  memo.findMarkers(root, MARKERS); memo.findMarkers(path.join(root, 'missing.exe'), MARKERS); memo.findMarkers(target, []);
  assert.equal(calls.length, 4); assert.equal(memo.size, 1);
});

test('remembered reads survive a restart of the same version only, and a damaged store is ignored', t => {
  const root = temporary(t), store = path.join(root, 'state', 'library-marker-cache.json');
  const target = file(root, 'Game.exe', 64 * 1024, [[500, 'D3D12CreateDevice']]);
  const first = createMarkerMemo({ original, file: store, appVersion: '1.0.0' });
  first.findMarkers(target, MARKERS); first.save();
  assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).version, MEMO_VERSION);
  const reads = t.mock.method(fs, 'readSync');
  const again = createMarkerMemo({ original, file: store, appVersion: '1.0.0' });
  assert.deepEqual([...again.findMarkers(target, MARKERS)], ['D3D12CreateDevice']);
  assert.equal(reads.mock.callCount(), 0);
  const updated = createMarkerMemo({ original, file: store, appVersion: '1.0.1' });
  assert.equal(updated.size, 0, 'a new app version starts empty');
  fs.writeFileSync(store, '{"version":1,"appVersion":"1.0.0","entries":[[1,2');
  assert.equal(createMarkerMemo({ original, file: store, appVersion: '1.0.0' }).size, 0);
  again.clear(); again.save();
  assert.equal(createMarkerMemo({ original, file: store, appVersion: '1.0.0' }).size, 0, 'a cleared memo is saved empty');
});

test('the library worker remembers marker reads between scans and a fresh scan clears them', async t => {
  const root = temporary(t), store = path.join(root, 'library-marker-cache.json');
  const game = path.join(root, 'Protected Game');
  // No graphics import: the scanner falls back to reading the whole EXE for API names.
  binary(path.join(game, 'Game.exe'), { imports: ['kernel32.dll'], markers: ['D3D12CreateDevice'], size: 256 * 1024 });
  const client = createLibraryWorkerClient({ documentsDir: root, markerCache: { file: store, version: 'test' } });
  t.after(() => client.dispose());
  const state = { manualGames: [game] };
  const first = await client.scanAll(state);
  assert.equal(first.length, 1);
  assert.match(first[0].chosen.via, /strings/);
  const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
  assert.equal(saved.appVersion, 'test');
  assert.ok(saved.entries.some(row => row[0].toLowerCase().includes('game.exe') && row[2].includes('D3D12CreateDevice')));
  const second = await client.scanAll(state, 1);
  assert.deepEqual(second.map(row => [row.id, row.chosen.api, row.chosen.via]), first.map(row => [row.id, row.chosen.api, row.chosen.via]));
  fs.writeFileSync(store, JSON.stringify({ ...saved, entries: saved.entries.map(row => [row[0], row[1], []]) }));
  await client.scanAll(state, 2, { fresh: true });
  assert.ok(JSON.parse(fs.readFileSync(store, 'utf8')).entries.some(row => row[2].includes('D3D12CreateDevice')), 'a fresh scan reads again and saves the real result');
});
