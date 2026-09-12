'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArtService, COVER_CACHE_VERSION, isHighResolutionCover, keyFor } = require('../src/product/art-service');

function fakePng(width, height, bytes = 8192) {
  const value = Buffer.alloc(bytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.writeUInt32BE(13, 8);
  value.write('IHDR', 12, 'ascii');
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

function fixture(t, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-art-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'Game'), service: createArtService({ userData: root, provider }) };
}

test('Steam cover cache rejects a blurry old image and downloads only the high-resolution cover', async t => {
  const downloads = [];
  const provider = {
    look: async () => { throw new Error('Steam app id should avoid name search'); },
    download: async (url, file) => { downloads.push(url); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, fakePng(600, 900)); }
  };
  const f = fixture(t, provider), key = keyFor(f.dir), artDir = path.join(f.root, 'art');
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(path.join(artDir, `${key}-cover.jpg`), fakePng(128, 192));
  assert.equal(isHighResolutionCover(path.join(artDir, `${key}-cover.jpg`)), false);

  const result = await f.service.fetchGameArt({ dir: f.dir, launcher: 'Steam', id: '12345' });
  assert.match(result, new RegExp(`${key}-cover-v${COVER_CACHE_VERSION}\\.jpg$`));
  assert.deepEqual(downloads, ['https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/12345/library_600x900.jpg']);
  assert.equal(fs.existsSync(path.join(artDir, `${key}-cover.jpg`)), false);
  assert.equal(isHighResolutionCover(path.join(artDir, `${key}-cover-v${COVER_CACHE_VERSION}.jpg`)), true);
});

test('a verified legacy high-resolution cache is migrated without a network request', async t => {
  let downloads = 0;
  const f = fixture(t, { look: async () => null, download: async () => { downloads++; } });
  const key = keyFor(f.dir), artDir = path.join(f.root, 'art'), legacy = path.join(artDir, `${key}-cover.jpg`);
  fs.mkdirSync(artDir, { recursive: true });
  fs.writeFileSync(legacy, fakePng(600, 900));
  const result = await f.service.fetchGameArt({ dir: f.dir, launcher: 'Steam', id: '12345' });
  assert.match(result, new RegExp(`${key}-cover-v${COVER_CACHE_VERSION}\\.jpg$`));
  assert.equal(downloads, 0);
  assert.equal(fs.existsSync(legacy), false);
});

test('a low-resolution downloaded placeholder is rejected without a small-image fallback', async t => {
  const f = fixture(t, {
    look: async () => null,
    download: async (_url, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, fakePng(128, 192)); }
  });
  const result = await f.service.fetchGameArt({ dir: f.dir, launcher: 'Steam', id: '12345' });
  assert.equal(result, null);
  assert.equal(fs.existsSync(path.join(f.root, 'art', `${keyFor(f.dir)}-cover-v${COVER_CACHE_VERSION}.jpg`)), false);
});

test('non-Steam numeric identifiers are not treated as Steam app ids', async t => {
  const calls = [];
  const f = fixture(t, {
    look: async (name, appid) => { calls.push({ name, appid }); return { coverUrl: 'https://example.invalid/library_600x900.jpg' }; },
    download: async (_url, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, fakePng(600, 900)); }
  });
  await f.service.fetchGameArt({ dir: f.dir, launcher: 'Epic', id: '12345', name: 'Known Game' });
  assert.deepEqual(calls, [{ name: 'Known Game', appid: null }]);
});
