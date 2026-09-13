'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const pe = require('../core/pe');
const { noLinks, assertLaunchNotCancelled } = require('./launch-safety');

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 8000;
const ENVIRONMENT_KEYS = new Set([
  'VK_LAYER_PATH', 'VK_ADD_LAYER_PATH', 'VK_IMPLICIT_LAYER_PATH', 'VK_ADD_IMPLICIT_LAYER_PATH',
  'VK_INSTANCE_LAYERS', 'VK_LOADER_LAYERS_ENABLE', 'VK_LOADER_LAYERS_DISABLE', 'VK_LOADER_LAYERS_ALLOW',
  'RESHADE_BASE_PATH', 'RESHADE_BASE_PATH_OVERRIDE'
]);

function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function localAbsolute(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value) || value.length > 32760 || value.includes('\0'))
    fail('GAME_LAUNCH_REQUEST_INVALID', `${label}必须是本机绝对路径。`);
  return path.resolve(value);
}
function validateTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('GAME_LAUNCH_REQUEST_INVALID', '游戏启动请求无效。');
  const exe = localAbsolute(input.exe, '游戏 EXE');
  if (!/\.exe$/i.test(exe)) fail('GAME_LAUNCH_REQUEST_INVALID', '游戏启动目标必须是 EXE。');
  let stat; try { stat = fs.statSync(exe); } catch { fail('GAME_LAUNCH_EXE_MISSING', '找不到已绑定的游戏 EXE。'); }
  if (!stat.isFile()) fail('GAME_LAUNCH_EXE_INVALID', '游戏 EXE 不是普通文件。');
  return exe;
}
function validateArgs(args) {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > 128 || args.some(value => typeof value !== 'string' || value.length > 32760 || value.includes('\0')))
    fail('GAME_LAUNCH_REQUEST_INVALID', '游戏启动参数无效。');
  return [...args];
}
function validateEnvironment(environment) {
  if (environment === undefined) return {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) fail('GAME_LAUNCH_ENV_INVALID', 'Vulkan 启动环境无效。');
  const output = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!ENVIRONMENT_KEYS.has(name) || typeof value !== 'string' || value.length > 32760 || /[\0\r\n]/.test(value))
      fail('GAME_LAUNCH_ENV_INVALID', `不允许传入启动环境变量 ${name}。`);
    output[name] = value;
  }
  return output;
}

function defaultRunner(file, args, options) {
  return new Promise(resolve => {
    const child = execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        timedOut: Boolean(error?.killed), signal: error?.signal || null, stdout: stdout || '', stderr: stderr || '', error }));
    child.stdin?.end(options.input);
  });
}
function sourceScript(options) {
  if (options.scriptPath) return path.resolve(options.scriptPath);
  const packaged = options.resourcesPath || process.resourcesPath;
  if (packaged) {
    const candidate = path.join(packaged, 'game-launch-broker.ps1');
    if (fs.existsSync(candidate) || options.packaged === true || /(?:^|[\\/])app\.asar(?:[\\/]|$)/i.test(__dirname)) return candidate;
  }
  return path.join(__dirname, 'game-launch-broker.ps1');
}

// Read only RT_MANIFEST resource text. An executable without a requested level
// uses Windows' default as-invoker behavior; malformed PE/resource data fails.
function executionLevel(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const read = (size, offset) => {
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || size < 0 || offset < 0 || offset + size > fileSize)
        fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 资源越界。');
      const buffer = Buffer.alloc(size);
      if (fs.readSync(fd, buffer, 0, size, offset) !== size) fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 资源读取不完整。');
      return buffer;
    };
    const dos = read(64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) fail('GAME_LAUNCH_EXE_INVALID', '游戏文件不是有效 Windows PE。');
    const peOffset = dos.readUInt32LE(0x3c), coff = read(24, peOffset);
    if (coff.readUInt32LE(0) !== 0x4550) fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 签名无效。');
    const sectionsCount = coff.readUInt16LE(6), optionalSize = coff.readUInt16LE(20), optionalOffset = peOffset + 24;
    if (!sectionsCount || sectionsCount > 96 || optionalSize < 2) fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 文件头无效。');
    const optional = read(optionalSize, optionalOffset), magic = optional.readUInt16LE(0), directoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : null;
    if (directoryOffset === null) fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 位数无效。');
    if (optionalSize < directoryOffset + 24) return 'asInvoker';
    const resourceRva = optional.readUInt32LE(directoryOffset + 16), resourceSize = optional.readUInt32LE(directoryOffset + 20);
    if (!resourceRva || resourceSize < 16) return 'asInvoker';
    const sectionTable = read(sectionsCount * 40, optionalOffset + optionalSize), sections = [];
    for (let i = 0; i < sectionsCount; i++) { const at = i * 40; sections.push({ rva: sectionTable.readUInt32LE(at + 12), size: Math.max(sectionTable.readUInt32LE(at + 8), sectionTable.readUInt32LE(at + 16)), raw: sectionTable.readUInt32LE(at + 20) }); }
    const fileOffset = (rva, size) => {
      const row = sections.find(item => rva >= item.rva && rva - item.rva + size <= item.size);
      if (!row) fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 资源未映射到文件。');
      const offset = row.raw + rva - row.rva;
      if (offset + size > fileSize) fail('GAME_LAUNCH_EXE_INVALID', '游戏 PE 资源越界。');
      return offset;
    };
    const resourceRead = (size, offset) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > resourceSize) fail('GAME_LAUNCH_EXE_INVALID', '游戏 manifest 资源越界。');
      return read(size, fileOffset(resourceRva + offset, size));
    };
    let entriesSeen = 0;
    const entries = offset => {
      const header = resourceRead(16, offset), count = header.readUInt16LE(12) + header.readUInt16LE(14);
      if ((entriesSeen += count) > 8192) fail('GAME_LAUNCH_EXE_INVALID', '游戏 manifest 资源过多。');
      const table = resourceRead(count * 8, offset + 16), rows = [];
      for (let i = 0; i < count; i++) { const name = table.readUInt32LE(i * 8), target = table.readUInt32LE(i * 8 + 4); rows.push({ id: name & 0x80000000 ? null : name, directory: Boolean(target & 0x80000000), offset: target & 0x7fffffff }); }
      return rows;
    };
    const type = entries(0).find(row => row.id === 24 && row.directory); if (!type) return 'asInvoker';
    const application = entries(type.offset).find(row => row.id === 1 && row.directory); if (!application) return 'asInvoker';
    const levels = [];
    for (const language of entries(application.offset)) {
      if (language.directory) continue;
      const item = resourceRead(16, language.offset), size = item.readUInt32LE(4), rva = item.readUInt32LE(0);
      if (!size || size > 1024 * 1024) fail('GAME_LAUNCH_EXE_INVALID', '游戏 manifest 大小无效。');
      const blob = read(size, fileOffset(rva, size));
      const encoding = blob[0] === 0xfe && blob[1] === 0xff ? 'utf-16be' : blob[0] === 0xff && blob[1] === 0xfe || blob[1] === 0 ? 'utf-16le' : 'utf8';
      const xml = new TextDecoder(encoding, { fatal: true }).decode(blob).replace(/<!--[\s\S]*?-->/g, '');
      const match = xml.match(/<(?:[A-Za-z_][\w.-]*:)?requestedExecutionLevel\b[^>]*\blevel\s*=\s*(["'])(.*?)\1/i);
      if (match) levels.push(match[2]);
    }
    const elevated = levels.find(level => level === 'requireAdministrator' || level === 'highestAvailable');
    if (elevated) return elevated;
    return 'asInvoker';
  } finally { fs.closeSync(fd); }
}

function createGameLaunchBroker(options = {}) {
  if ((options.platform || process.platform) !== 'win32') fail('GAME_LAUNCH_BROKER_UNAVAILABLE', '普通权限游戏启动 broker 仅支持 Windows。');
  const scriptPath = sourceScript(options);
  if (!path.isAbsolute(scriptPath) || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) fail('GAME_LAUNCH_HELPER_MISSING', '找不到游戏启动 helper。');
  const powershell = options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!path.isAbsolute(powershell)) fail('GAME_LAUNCH_REQUEST_INVALID', 'PowerShell 路径必须是绝对路径。');
  const runner = options.runner || defaultRunner, readLevel = options.executionLevel || executionLevel, getBitness = options.peBitness || pe.getBitness;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 500 && options.timeoutMs <= 30000 ? options.timeoutMs : DEFAULT_TIMEOUT;

  async function call(request) {
    let result;
    try { result = await runner(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { input: `${JSON.stringify({ version: 1, ...request })}\n`, timeoutMs, maxOutputBytes: MAX_OUTPUT }); }
    catch (error) { fail('GAME_LAUNCH_HELPER_FAILED', '游戏启动 helper 无法启动。', { cause: error?.code || 'spawn' }); }
    if (result?.timedOut || result?.error?.killed) fail('GAME_LAUNCH_HELPER_TIMEOUT', '游戏启动 helper 响应超时。');
    if (Buffer.byteLength(String(result?.stdout || '')) > MAX_OUTPUT || Buffer.byteLength(String(result?.stderr || '')) > MAX_OUTPUT) fail('GAME_LAUNCH_HELPER_PROTOCOL', '游戏启动 helper 输出超出限制。');
    let response; try { response = JSON.parse(String(result?.stdout || '').trim().replace(/^\uFEFF/, '')); }
    catch { fail('GAME_LAUNCH_HELPER_PROTOCOL', '游戏启动 helper 返回了无效 JSON。'); }
    if (!response || response.version !== 1 || typeof response.ok !== 'boolean') fail('GAME_LAUNCH_HELPER_PROTOCOL', '游戏启动 helper 返回结构无效。');
    if (!response.ok) fail(typeof response.code === 'string' ? response.code : 'GAME_LAUNCH_HELPER_FAILED', typeof response.error === 'string' ? response.error : '普通权限启动失败。');
    if (result.code !== 0) fail('GAME_LAUNCH_HELPER_FAILED', '游戏启动 helper 未正常退出。');
    const value = response.result;
    if (!value || value.elevated !== false || value.launchable !== true || typeof value.userSid !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+){1,15}$/.test(value.userSid) || !Number.isInteger(value.sessionId) || !Number.isInteger(value.shellPid))
      fail('GAME_LAUNCH_TOKEN_MISMATCH', '无法证明游戏使用同一用户和会话的普通权限 token。');
    return value;
  }
  async function inspect(input) {
    const exe = validateTarget(input); await noLinks(exe);
    let bitness; try { bitness = getBitness(exe); } catch { fail('GAME_LAUNCH_EXE_INVALID', '游戏文件不是有效 Windows PE。'); }
    const level = readLevel(exe);
    if (level === 'requireAdministrator' || level === 'highestAvailable') fail('GAME_LAUNCH_REQUIRES_ELEVATION', '该游戏请求提升权限，当前普通权限启动方式无法启动；请使用受支持的启动器确认权限。此检查不表示安装文件失败。', { level });
    return { ...(await call({ op: 'inspect', exe })), exe, bitness, executionLevel: level };
  }
  async function launch(input, controls) {
    assertLaunchNotCancelled(controls);
    const checked = await inspect(input), args = validateArgs(input.args), env = validateEnvironment(input.env);
    assertLaunchNotCancelled(controls);
    const cwd = input.cwd === undefined ? path.dirname(checked.exe) : localAbsolute(input.cwd, '工作目录');
    let stat; try { stat = fs.statSync(cwd); } catch { fail('GAME_LAUNCH_CWD_INVALID', '游戏工作目录不存在。'); }
    if (!stat.isDirectory()) fail('GAME_LAUNCH_CWD_INVALID', '游戏工作目录无效。');
    await noLinks(cwd);
    assertLaunchNotCancelled(controls);
    const result = await call({ op: 'launch', exe: checked.exe, args, env, cwd, expected: { userSid: checked.userSid, sessionId: checked.sessionId, shellPid: checked.shellPid } });
    if (!Number.isInteger(result.pid) || result.pid <= 0 || result.userSid !== checked.userSid || result.sessionId !== checked.sessionId)
      fail('GAME_LAUNCH_TOKEN_MISMATCH', '新游戏进程的普通权限 token 读回不一致。');
    return { pid: result.pid, elevated: false, userSid: result.userSid, sessionId: result.sessionId };
  }
  return Object.freeze({ inspect, launch });
}

module.exports = { createGameLaunchBroker, executionLevel, ENVIRONMENT_KEYS };
