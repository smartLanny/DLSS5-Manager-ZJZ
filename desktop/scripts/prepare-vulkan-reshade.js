'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const SOURCE_SHA256 = 'afe4c8f13048306307983b8b3d41d5bf00a86820440b0e57dea10950e1176445';
const FILES = Object.freeze({
  'ReShade64.dll': '0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7',
  'ReShade64.json': 'aa21713718843e531da396e2bfc80772c9cb3c369d6c30b836be6b0ae812d503'
});
const LICENSE = Buffer.from([
  'Copyright 2014 Patrick Mours. All rights reserved.',
  '',
  'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:',
  '',
  '  * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.',
  '  * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.',
  '  * Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.',
  '',
  'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
  ''
].join('\r\n'), 'utf8');
const LICENSE_SHA256 = 'd2bb5eb908e9aa7ac2f7f4cf6441d62e1f6ac1256cf22bb5289516c9f30e5f0a';
const DESTINATION = path.resolve(__dirname, '../resources/vulkan-reshade');
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function safeSource(file) {
  const full = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(full); } catch (error) { fail('VULKAN_RESHADE_SOURCE_MISSING', '固定 ReShade Setup 不存在。', { file: full, cause: error.code }); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) fail('VULKAN_RESHADE_SOURCE_INVALID', '固定 ReShade Setup 不是安全的有限普通文件。', { file: full });
  return full;
}

function findEndOfCentralDirectory(source) {
  const minimum = Math.max(0, source.length - 0xffff - 22);
  for (let offset = Math.min(source.length - 22, minimum + 0xffff); offset >= minimum; offset--) {
    if (source.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = source.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength > source.length) continue;
    return {
      offset,
      entries: source.readUInt16LE(offset + 10),
      centralSize: source.readUInt32LE(offset + 12),
      centralOffset: source.readUInt32LE(offset + 16)
    };
  }
  fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 没有可验证的 ZIP 目录。');
}

function extractZipEntries(source, wanted) {
  const eocd = findEndOfCentralDirectory(source);
  if (!Number.isInteger(eocd.entries) || eocd.entries < 1 || eocd.entries > 128 || eocd.centralSize > eocd.offset) {
    fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的 ZIP 目录越界。');
  }
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const centralOffset = source.indexOf(centralSignature, Math.min(eocd.centralOffset, eocd.offset));
  if (centralOffset < 0 || centralOffset + eocd.centralSize > eocd.offset) fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的 ZIP 目录位置无效。');
  const archiveBase = centralOffset - eocd.centralOffset;
  const result = new Map(); let cursor = centralOffset;
  for (let index = 0; index < eocd.entries; index++) {
    if (cursor + 46 > source.length || source.readUInt32LE(cursor) !== 0x02014b50) fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的 ZIP 目录项无效。');
    const flags = source.readUInt16LE(cursor + 8), compression = source.readUInt16LE(cursor + 10);
    const compressedSize = source.readUInt32LE(cursor + 20), uncompressedSize = source.readUInt32LE(cursor + 24);
    const nameLength = source.readUInt16LE(cursor + 28), extraLength = source.readUInt16LE(cursor + 30), commentLength = source.readUInt16LE(cursor + 32);
    const localOffset = source.readUInt32LE(cursor + 42);
    const nameEnd = cursor + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > source.length || compressedSize > MAX_ENTRY_BYTES || uncompressedSize > MAX_ENTRY_BYTES || (flags & 0x1) !== 0) {
      fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的 ZIP 项大小或加密标记无效。');
    }
    const name = source.subarray(cursor + 46, nameEnd).toString('utf8');
    cursor = nameEnd + extraLength + commentLength;
    if (!wanted.has(name)) continue;
    const actualLocalOffset = archiveBase + localOffset;
    if (result.has(name) || actualLocalOffset + 30 > source.length || source.readUInt32LE(actualLocalOffset) !== 0x04034b50) fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的目标文件重复或本地头无效。');
    const localNameLength = source.readUInt16LE(actualLocalOffset + 26), localExtraLength = source.readUInt16LE(actualLocalOffset + 28);
    const dataOffset = actualLocalOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > source.length) fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的目标文件数据越界。');
    const compressed = source.subarray(dataOffset, dataOffset + compressedSize);
    let bytes;
    try {
      if (compression === 0) bytes = Buffer.from(compressed);
      else if (compression === 8) bytes = zlib.inflateRawSync(compressed);
      else fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 使用了不支持的压缩方式。');
    } catch (error) {
      if (error.code?.startsWith('VULKAN_')) throw error;
      fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的目标文件无法解压。');
    }
    if (bytes.length !== uncompressedSize) fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的目标文件长度不一致。');
    result.set(name, bytes);
  }
  if (cursor !== centralOffset + eocd.centralSize) fail('VULKAN_RESHADE_ZIP_INVALID', '固定 ReShade Setup 的 ZIP 目录长度不一致。');
  for (const name of wanted) if (!result.has(name)) fail('VULKAN_RESHADE_SOURCE_INVALID', `固定 ReShade Setup 缺少 ${name}。`);
  return result;
}

function validateManifest(bytes, expectedLibrary) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('VULKAN_RESHADE_MANIFEST_INVALID', 'ReShade Vulkan manifest 不是有效 JSON。'); }
  if (data?.layer?.name !== 'VK_LAYER_reshade' || data.layer.type !== 'GLOBAL' || data.layer.library_path !== '.\\ReShade64.dll' ||
      data.layer.disable_environment?.DISABLE_VK_LAYER_reshade_1 !== '1') fail('VULKAN_RESHADE_MANIFEST_INVALID', 'ReShade Vulkan manifest 的固定 layer 合同不匹配。');
  if (sha256(bytes) !== expectedLibrary.manifestSha256) fail('VULKAN_RESHADE_MANIFEST_INVALID', 'ReShade Vulkan manifest 摘要不匹配。');
  return data;
}

function recipeFor(destination, sourceSha256, fileHashes) {
  return {
    version: 1,
    id: 'reshade-vulkan-6.8.0.2155',
    release: '6.8.0.2155-addon',
    architecture: 64,
    sourceRoot: path.resolve(destination),
    source: { setupSha256: sourceSha256 },
    layer: { manifest: 'ReShade64.json', library: 'ReShade64.dll', manifestSha256: fileHashes.manifestSha256, librarySha256: fileHashes.librarySha256, name: 'VK_LAYER_reshade' },
    activation: { interface: 'reshade-ini-v1' },
    license: { file: 'LICENSE.md', sha256: LICENSE_SHA256 }
  };
}

function regularPath(file, allowMissing = true) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('VULKAN_RESHADE_DEST_INVALID', 'ReShade 资源目标必须是普通文件。', { file });
    return stat;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
}

function prepare(sourceFile, destination = DESTINATION, options = {}) {
  const source = safeSource(sourceFile);
  const sourceBytes = fs.readFileSync(source);
  const expectedSourceSha256 = String(options.expectedSourceSha256 || SOURCE_SHA256).toLowerCase();
  const actualSourceSha256 = sha256(sourceBytes);
  if (actualSourceSha256 !== expectedSourceSha256) fail('VULKAN_RESHADE_SOURCE_HASH', '固定 ReShade Setup 摘要不匹配，未写入资源。', { expected: expectedSourceSha256, actual: actualSourceSha256 });
  const expected = options.expectedFiles || FILES;
  const entries = extractZipEntries(sourceBytes, new Set(['ReShade64.dll', 'ReShade64.json']));
  const fileHashes = { librarySha256: sha256(entries.get('ReShade64.dll')), manifestSha256: sha256(entries.get('ReShade64.json')) };
  if (fileHashes.librarySha256 !== expected['ReShade64.dll'] || fileHashes.manifestSha256 !== expected['ReShade64.json']) fail('VULKAN_RESHADE_FILE_HASH', '固定 ReShade DLL 或 manifest 摘要不匹配，未写入资源。', { fileHashes });
  validateManifest(entries.get('ReShade64.json'), fileHashes);
  const license = options.licenseBytes ? Buffer.from(options.licenseBytes) : LICENSE;
  if (sha256(license) !== (options.licenseSha256 || LICENSE_SHA256)) fail('VULKAN_RESHADE_LICENSE_HASH', 'ReShade 许可文本摘要不匹配，未写入资源。');
  const destinationPath = path.resolve(destination), recipe = recipeFor(destinationPath, actualSourceSha256, fileHashes);
  const output = new Map([['ReShade64.dll', entries.get('ReShade64.dll')], ['ReShade64.json', entries.get('ReShade64.json')], ['LICENSE.md', license], ['recipe.json', Buffer.from(`${JSON.stringify(recipe, null, 2)}\n`, 'utf8')]]);
  if (fs.existsSync(destinationPath)) {
    const stat = fs.lstatSync(destinationPath); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('VULKAN_RESHADE_DEST_INVALID', 'ReShade 资源目标目录不是安全目录。');
    for (const name of fs.readdirSync(destinationPath)) if (!output.has(name)) fail('VULKAN_RESHADE_DEST_CHANGED', 'ReShade 资源目标包含未声明文件，未接管。', { file: name });
  } else fs.mkdirSync(destinationPath, { recursive: true });
  for (const [name, bytes] of output) {
    const target = path.join(destinationPath, name), current = regularPath(target);
    if (current) {
      if (!fs.readFileSync(target).equals(bytes)) fail('VULKAN_RESHADE_DEST_CHANGED', 'ReShade 资源目标字节已变化，未覆盖。', { file: name });
      continue;
    }
    const handle = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  }
  return { destination: destinationPath, sourceSha256: actualSourceSha256, recipe, files: Object.fromEntries([...output].map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])) };
}

if (require.main === module) {
  if (process.argv.length !== 3 && process.argv.length !== 4) throw new Error('Usage: node scripts/prepare-vulkan-reshade.js <ReShade_Setup_6.8.0_Addon.exe> [destination]');
  const result = prepare(process.argv[2], process.argv[3] || DESTINATION);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { DESTINATION, FILES, LICENSE, LICENSE_SHA256, SOURCE_SHA256, extractZipEntries, prepare, recipeFor, sha256 };
