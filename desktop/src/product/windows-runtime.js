'use strict';

const fsDefault = require('fs');
const path = require('path');
const peDefault = require('../core/pe');

const VC_RUNTIME_FILES = Object.freeze([
  'msvcp140.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll'
]);

function inspectVcRuntime(options = {}) {
  const fs = options.fs || fsDefault;
  const pe = options.pe || peDefault;
  const platform = options.platform || process.platform;
  const systemDirectory = options.systemDirectory || (platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32') : null);
  const applicationDirectory = options.applicationDirectory;

  if (!systemDirectory || !path.isAbsolute(systemDirectory) || applicationDirectory !== undefined && !path.isAbsolute(applicationDirectory)) {
    return {
      status: 'unknown', ready: false, missing: [],
      message: '无法确定 Windows x64 系统运行库目录。'
    };
  }

  const missing = [], localInvalid = [];
  function isX64(file, size) {
    const fd = fs.openSync(file, 'r');
    try {
      const dos = Buffer.alloc(64), coff = Buffer.alloc(6);
      if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) return false;
      const offset = dos.readUInt32LE(0x3c);
      if (offset < 64 || offset > size - coff.length || fs.readSync(fd, coff, 0, coff.length, offset) !== coff.length) return false;
      return coff.readUInt32LE(0) === 0x4550 && coff.readUInt16LE(4) === 0x8664 && pe.getBitness(file) === 64;
    } finally { fs.closeSync(fd); }
  }
  try {
    for (const name of VC_RUNTIME_FILES) {
      let selected = null;
      // A DLL beside the game's EXE takes precedence over System32. Never
      // claim that installing a system runtime repairs an invalid local DLL.
      for (const directory of [applicationDirectory, systemDirectory].filter(Boolean)) {
        const file = path.join(directory, name);
        try {
          const stat = fs.statSync(file);
          fs.accessSync(file, fsDefault.constants.R_OK);
          selected = { file, stat, local: directory === applicationDirectory }; break;
        } catch (error) {
          if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
          throw error;
        }
      }
      if (!selected || !selected.stat.isFile() || !isX64(selected.file, selected.stat.size)) {
        missing.push(name);
        if (selected?.local) localInvalid.push(name);
      }
    }
  } catch {
    return {
      status: 'unknown', ready: false, missing: [],
      message: '无法读取或验证 Windows x64 VC++ 运行库文件。'
    };
  }

  if (missing.length) {
    return {
      status: 'missing', ready: false, missing, repair: localInvalid.length ? 'game-files' : 'vc-redist',
      message: localInvalid.length ? `游戏 EXE 旁的运行库文件无效或架构不匹配：${localInvalid.join('、')}。请核对游戏安装文件；安装系统运行库不会覆盖这些文件。`
        : `缺少有效的 Windows x64 VC++ 运行库文件：${missing.join('、')}。`
    };
  }
  return {
    status: 'available', ready: true, missing: [],
    message: '已找到基础 x64 VC++ 运行库文件；尚未验证组件实际加载或游戏兼容性。'
  };
}

module.exports = { inspectVcRuntime, VC_RUNTIME_FILES };
