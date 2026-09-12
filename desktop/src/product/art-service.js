'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const art = require('../../vendor/DLSS5-Swapper/src/steamart');

const COVER_CACHE_VERSION = 2;
const MIN_COVER_BYTES = 8 * 1024;
const MIN_COVER_WIDTH = 600;
const MIN_COVER_HEIGHT = 900;
const IMAGE_HEADER_BYTES = 64 * 1024;

function keyFor(dir) {
  return crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 20);
}

function imageDimensions(file) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 24) return null;
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(IMAGE_HEADER_BYTES, stat.size));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        buffer.length >= 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset++; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset++;
      if (offset >= buffer.length) break;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      const isFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isFrame && segmentLength >= 7) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += segmentLength;
    }
  } catch {}
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
}

function isHighResolutionCover(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < MIN_COVER_BYTES) return false;
    const dimensions = imageDimensions(file);
    return Boolean(dimensions && dimensions.width >= MIN_COVER_WIDTH && dimensions.height >= MIN_COVER_HEIGHT);
  } catch {
    return false;
  }
}

function removeCache(file) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
}

function cachedCover(artDir, key) {
  const current = path.join(artDir, `${key}-cover-v${COVER_CACHE_VERSION}.jpg`);
  if (isHighResolutionCover(current)) return current;
  removeCache(current);

  // Migrate a verified old cache once. A byte-size-only old cache is removed
  // so a blurry Steam placeholder can never remain the preferred artwork.
  const legacy = path.join(artDir, `${key}-cover.jpg`);
  if (isHighResolutionCover(legacy)) {
    try {
      fs.renameSync(legacy, current);
      if (isHighResolutionCover(current)) return current;
    } catch {}
    if (isHighResolutionCover(legacy)) return legacy;
  }
  removeCache(legacy);
  return null;
}

function createArtService({ userData, provider = art }) {
  const artDir = path.join(userData, 'art');

  async function fetchGameArt(game) {
    if (!game || typeof game.dir !== 'string') return null;
    const key = keyFor(game.dir);
    const cached = cachedCover(artDir, key);
    if (cached) return pathToFileURL(cached).href;

    // Steam entries already carry an authoritative app id. This avoids the
    // name search used for loose/Epic/GOG games and keeps the common path fast.
    const hit = game.launcher === 'Steam' && game.id
      ? {
          coverUrl: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${game.id}/library_600x900.jpg`
        }
      : await provider.look(game.name || path.basename(game.dir), game.launcher === 'Steam' ? game.id || null : null);
    if (!hit || !hit.coverUrl) return null;

    const cover = path.join(artDir, `${key}-cover-v${COVER_CACHE_VERSION}.jpg`);
    try {
      await provider.download(hit.coverUrl, cover);
      if (!isHighResolutionCover(cover)) throw new Error('downloaded artwork is below the Steam cover resolution');
      return pathToFileURL(cover).href;
    } catch {
      removeCache(cover);
      return null;
    }
  }

  return { fetchGameArt };
}

module.exports = { COVER_CACHE_VERSION, createArtService, imageDimensions, isHighResolutionCover, keyFor };
