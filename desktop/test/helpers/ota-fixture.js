'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sha256Buffer } = require('../../src/product/ota');

const CORE = 'DLSS5-AI渲染超分版-beta0.4.5-dx11-compat-@野生的装机宅-Bilibili.addon64';
const CARRIER = 'dlss5-native-carrier-045-dx11-compat.addon64';
const BRIDGE = 'nrchain_nvngx.dll';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; ++bit) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(file, rows) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.name, 'utf8');
    const data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(String(row.data));
    const size = row.declaredSize === undefined ? data.length : row.declaredSize;
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(size, 18); header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(size, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(rows.length, 8); end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...local, centralBytes, end]));
  return file;
}

function tempZip(name = 'fixture.zip') {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-ota-')), name);
}

function standardFixture(options = {}) {
  const payload = new Map([
    ['core.addon64', Buffer.from('standard-core')],
    [BRIDGE, Buffer.from('standard-bridge')],
    ['Instructions.txt', Buffer.from('standard instructions')]
  ]);
  if (options.carrier) payload.set(CARRIER, Buffer.from('must-not-fallback'));
  if (options.extraCore) payload.set('second-core.addon64', Buffer.from('second'));
  const files = [...payload].map(([name, data]) => ({ name, bytes: data.length, sha256: sha256Buffer(data) }));
  if (options.unhashedInstructions) files.splice(files.findIndex(row => row.name === 'Instructions.txt'), 1);
  if (options.badBytes) files[0].bytes += 1;
  if (options.badHash) files[0].sha256 = '0'.repeat(64);
  if (options.duplicateRow) files.push({ ...files[0], name: files[0].name.toUpperCase() });
  const manifest = {
    schema: 'nr-branch-ota-v1', version: options.unhashedInstructions ? 'Beta0.3.8' : 'fixture-standard',
    api: 'D3D12-x64', includesDx11: false, files
  };
  const rows = [{ name: 'ota-manifest.json', data: JSON.stringify(manifest) },
    ...[...payload].map(([name, data]) => ({ name, data }))];
  if (options.unlisted) rows.push({ name: 'extra.txt', data: 'unverified' });
  return rows;
}

function dx11Fixture(options = {}) {
  const buildInfo = Buffer.from(JSON.stringify({
    display_version: '0.4.5-DX11-兼容增强', version: 'beta0.4.5-dx11-compat',
    source_commit: 'd'.repeat(40), packaging_commit: 'c'.repeat(40), language: 'zh-CN',
    core_pe_version: '0.4.5.104', carrier_upstream_file_version: '1.4.12.0'
  }));
  const payload = new Map([
    ['build-info.json', buildInfo],
    [CARRIER, Buffer.from('matched-carrier')], // Deliberately precedes the core in ZIP order.
    [CORE, Buffer.from('dx11-core')],
    [BRIDGE, Buffer.from('matched-bridge')],
    ['安装说明.txt', Buffer.from('成套安装', 'utf8')]
  ]);
  if (options.noCarrier) payload.delete(CARRIER);
  if (options.noBridge) payload.delete(BRIDGE);
  if (options.extraCore) payload.set('another-core.addon64', Buffer.from('ambiguous-core'));
  const hashes = [...payload].map(([file, data]) => ({ file, sha256: sha256Buffer(data) }));
  if (options.badHash) hashes.find(row => row.file === CORE).sha256 = '0'.repeat(64);
  const rows = [...payload].map(([name, data]) => ({ name, data }));
  rows.push({ name: 'SHA256.json', data: JSON.stringify(hashes) });
  return rows;
}

module.exports = { CORE, CARRIER, BRIDGE, zip, tempZip, standardFixture, dx11Fixture };
