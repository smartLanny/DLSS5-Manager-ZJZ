'use strict';

// Read the executable's actual RT_MANIFEST / CREATEPROCESS_MANIFEST_RESOURCE_ID
// resource. No execution, DLL loading, full-file string search, or extraction.
const fs = require('node:fs');
const path = require('node:path');
const LEVELS = new Set(['asInvoker', 'highestAvailable', 'requireAdministrator']);

function readApplicationManifests(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    function read(size, offset) {
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size < 0 || offset < 0 || offset + size > fileSize)
        throw new Error('PE 资源位置越界。');
      const buffer = Buffer.alloc(size);
      if (fs.readSync(fd, buffer, 0, size, offset) !== size) throw new Error('PE 资源读取不完整。');
      return buffer;
    }
    const dos = read(64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error('文件不是 Windows PE 程序。');
    const peOffset = dos.readUInt32LE(0x3c), coff = read(24, peOffset);
    if (coff.readUInt32LE(0) !== 0x4550) throw new Error('PE 签名无效。');
    const count = coff.readUInt16LE(6), optionalSize = coff.readUInt16LE(20);
    if (!count || count > 96 || optionalSize < 2) throw new Error('PE 文件头无效。');
    const optional = read(optionalSize, peOffset + 24), magic = optional.readUInt16LE(0);
    const directoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : null;
    if (directoryOffset === null || optionalSize < directoryOffset + 24) throw new Error('PE 可选文件头无效。');
    const resourceRva = optional.readUInt32LE(directoryOffset + 16), resourceSize = optional.readUInt32LE(directoryOffset + 20);
    if (!resourceRva || resourceSize < 16) throw new Error('EXE 没有资源清单。');
    const table = read(count * 40, peOffset + 24 + optionalSize);
    const sections = [];
    for (let index = 0; index < count; index++) {
      const offset = index * 40;
      sections.push({ rva: table.readUInt32LE(offset + 12), size: table.readUInt32LE(offset + 16), raw: table.readUInt32LE(offset + 20) });
    }
    function fileOffset(rva, size) {
      const section = sections.find(row => rva >= row.rva && rva - row.rva + size <= row.size);
      if (!section) throw new Error('PE 资源未映射到实际文件区段。');
      return section.raw + rva - section.rva;
    }
    function resourceRead(size, offset) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > resourceSize) throw new Error('PE 资源目录越界。');
      return read(size, fileOffset(resourceRva + offset, size));
    }
    let entryCount = 0;
    function entries(offset) {
      const header = resourceRead(16, offset), length = header.readUInt16LE(12) + header.readUInt16LE(14);
      entryCount += length;
      if (entryCount > 8192) throw new Error('PE 资源目录超过校验范围。');
      const buffer = resourceRead(length * 8, offset + 16), rows = [];
      for (let index = 0; index < length; index++) {
        const name = buffer.readUInt32LE(index * 8), target = buffer.readUInt32LE(index * 8 + 4);
        rows.push({ id: name & 0x80000000 ? null : name, directory: Boolean(target & 0x80000000), offset: target & 0x7fffffff });
      }
      return rows;
    }
    const types = entries(0).filter(row => row.id === 24);
    if (types.length !== 1 || !types[0].directory) throw new Error('EXE 缺少唯一的 RT_MANIFEST 资源类型。');
    const applications = entries(types[0].offset).filter(row => row.id === 1);
    if (applications.length !== 1 || !applications[0].directory) throw new Error('EXE 缺少唯一的应用程序 manifest（资源 ID 1）。');
    const manifests = [];
    for (const language of entries(applications[0].offset)) {
      if (language.directory) throw new Error('应用程序 manifest 的资源层级无效。');
      const data = resourceRead(16, language.offset), size = data.readUInt32LE(4);
      if (!size || size > 1024 * 1024) throw new Error('应用程序 manifest 大小无效。');
      const blob = read(size, fileOffset(data.readUInt32LE(0), size));
      const encoding = blob[0] === 0xfe && blob[1] === 0xff ? 'utf-16be'
        : blob[0] === 0xff && blob[1] === 0xfe || blob[1] === 0 ? 'utf-16le' : 'utf-8';
      const xml = new TextDecoder(encoding, { fatal: true }).decode(blob);
      manifests.push({ resourceId: 1, languageId: language.id, xml });
    }
    if (!manifests.length) throw new Error('应用程序 manifest 没有语言资源。');
    return manifests;
  } finally { fs.closeSync(fd); }
}

function readExecutionLevels(file) {
  return readApplicationManifests(file).map(manifest => {
    const xml = manifest.xml.replace(/<!--[\s\S]*?-->/g, '');
    const elements = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?requestedExecutionLevel\b([^>]*)>/g)];
    if (elements.length !== 1) throw new Error('每个应用程序 manifest 必须声明一个 requestedExecutionLevel。');
    const attribute = elements[0][1].match(/\blevel\s*=\s*(["'])(.*?)\1/);
    if (!attribute || !LEVELS.has(attribute[2])) throw new Error('requestedExecutionLevel 的 level 属性无效。');
    return { resourceId: manifest.resourceId, languageId: manifest.languageId, level: attribute[2] };
  });
}

function verifyExecutable(file, expected = 'requireAdministrator') {
  if (!LEVELS.has(expected)) throw new Error(`无效的预期权限：${expected}`);
  const absolute = path.resolve(file), manifests = readExecutionLevels(absolute);
  const ok = manifests.every(row => row.level === expected);
  return { file: absolute, expected, manifests, ok };
}

function parseArguments(args) {
  const requests = []; let expected = 'requireAdministrator';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--expect') {
      expected = args[++index];
      if (!LEVELS.has(expected)) throw new Error('--expect 需要 asInvoker、highestAvailable 或 requireAdministrator。');
    } else if (args[index].startsWith('--')) throw new Error(`未知参数：${args[index]}`);
    else requests.push({ file: args[index], expected });
  }
  if (!requests.length) throw new Error('请指定待校验的实际 EXE。');
  return requests;
}

if (require.main === module) {
  try {
    const requests = parseArguments(process.argv.slice(2));
    for (const request of requests) {
      try {
        const result = verifyExecutable(request.file, request.expected);
        console.log(JSON.stringify(result));
        if (!result.ok) process.exitCode = 1;
      } catch (error) { console.error(JSON.stringify({ file: path.resolve(request.file), ok: false, error: error.message })); process.exitCode = 1; }
    }
  } catch (error) {
    console.error(error.message);
    console.error('用法：node scripts/verify-execution-level.js [--expect requireAdministrator] portable.exe unpacked.exe --expect asInvoker Setup.exe');
    process.exitCode = 2;
  }
}

module.exports = { readApplicationManifests, readExecutionLevels, verifyExecutable, parseArguments };
