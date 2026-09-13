'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 5000;

function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function validateKey(key) {
  if (typeof key !== 'string' || key.length < 10 || key.length > 512 || !/^Software\\/i.test(key) ||
      /[\0-\x1f/]/.test(key) || key.split('\\').some(part => !part || part === '.' || part === '..')) {
    fail('REGISTRY_REQUEST_INVALID', 'HKCU 注册表 key 无效。');
  }
  return key;
}
function validateName(name) {
  if (typeof name !== 'string' || !name || name.length > 4096 || /[\0-\x1f]/.test(name)) fail('REGISTRY_REQUEST_INVALID', '注册表 value 名称无效。');
  return name;
}
function normalizeState(state) {
  if (!state || typeof state.exists !== 'boolean') fail('REGISTRY_REQUEST_INVALID', '注册表状态无效。');
  if (!state.exists) return { exists: false };
  if (state.type !== 'REG_DWORD' || !Number.isInteger(state.data) || state.data < 0 || state.data > 0xffffffff) {
    fail('REGISTRY_VALUE_TYPE', '仅支持 REG_DWORD 注册表值。');
  }
  return { exists: true, type: 'REG_DWORD', data: state.data };
}
function sameState(a, b) {
  return a.exists === b.exists && (!a.exists || a.type === b.type && a.data === b.data);
}

function defaultRunner(file, args, options) {
  return new Promise(resolve => {
    const child = execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, signal: error?.signal || null,
        timedOut: Boolean(error?.killed && error?.signal), stdout: stdout || '', stderr: stderr || '', error });
    });
    child.stdin?.end(options.input);
  });
}

function sourceScript(options) {
  if (options.scriptPath) return path.resolve(options.scriptPath);
  const packaged = options.resourcesPath || process.resourcesPath;
  if (packaged) {
    const candidate = path.join(packaged, 'windows-registry-values.ps1');
    if (fs.existsSync(candidate)) return candidate;
    if (options.packaged === true || /(?:^|[\\/])app\.asar(?:[\\/]|$)/i.test(__dirname)) return candidate;
  }
  return path.join(__dirname, 'windows-registry-values.ps1');
}

function createWindowsRegistryValues(options = {}) {
  if ((options.platform || process.platform) !== 'win32') fail('REGISTRY_UNAVAILABLE', 'Windows 注册表 adapter 只在 Windows 上可用。');
  const key = validateKey(options.key);
  if (options.view !== undefined && options.view !== '64') fail('REGISTRY_REQUEST_INVALID', '当前只支持 HKCU 64 位注册表视图。');
  const scriptPath = sourceScript(options);
  if (!path.isAbsolute(scriptPath) || !fs.existsSync(scriptPath) || !fs.statSync(scriptPath).isFile()) fail('REGISTRY_HELPER_MISSING', '找不到 Windows 注册表 helper。');
  const powershell = options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!path.isAbsolute(powershell)) fail('REGISTRY_REQUEST_INVALID', 'PowerShell 路径必须是绝对路径。');
  const runner = options.runner || defaultRunner;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 100 && options.timeoutMs <= 30000 ? options.timeoutMs : DEFAULT_TIMEOUT;
  const maxOutputBytes = Number.isInteger(options.maxOutputBytes) && options.maxOutputBytes >= 1024 && options.maxOutputBytes <= 1024 * 1024 ? options.maxOutputBytes : MAX_OUTPUT;

  async function call(request) {
    const input = `${JSON.stringify({ version: 1, key, view: '64', ...request })}\n`;
    let result;
    try {
      result = await runner(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { input, timeoutMs, maxOutputBytes });
    } catch (error) { fail('REGISTRY_HELPER_FAILED', 'Windows 注册表 helper 无法启动。', { cause: error?.code || 'spawn' }); }
    if (result?.timedOut || result?.signal === 'SIGTERM' && result?.error?.killed) fail('REGISTRY_HELPER_TIMEOUT', 'Windows 注册表 helper 响应超时。');
    const stdout = String(result?.stdout || '');
    if (Buffer.byteLength(stdout) > maxOutputBytes || Buffer.byteLength(String(result?.stderr || '')) > maxOutputBytes) fail('REGISTRY_HELPER_PROTOCOL', 'Windows 注册表 helper 输出超出限制。');
    if (!stdout.trim() && result?.error) fail('REGISTRY_HELPER_FAILED', 'Windows 注册表 helper 执行失败。', { cause: result.error.code || 'process' });
    let response;
    try { response = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')); }
    catch { fail('REGISTRY_HELPER_PROTOCOL', 'Windows 注册表 helper 返回了无效 JSON。'); }
    if (!response || response.version !== 1 || typeof response.ok !== 'boolean') fail('REGISTRY_HELPER_PROTOCOL', 'Windows 注册表 helper 返回结构无效。');
    if (!response.ok) fail(typeof response.code === 'string' ? response.code : 'REGISTRY_HELPER_FAILED',
      typeof response.error === 'string' ? response.error : 'Windows 注册表操作失败。');
    if (result.code !== 0) fail('REGISTRY_HELPER_FAILED', 'Windows 注册表 helper 未正常退出，未确认操作完成。');
    return response.result;
  }

  async function read(name) {
    const result = await call({ op: 'read', name: validateName(name) });
    if (result?.exists && result.type !== 'REG_DWORD') fail('REGISTRY_VALUE_TYPE', `注册表值 ${name} 不是 REG_DWORD，未转换或覆盖。`, { type: result.type });
    return normalizeState(result);
  }
  async function list() {
    const result = await call({ op: 'list' });
    return normalizeList(result);
  }
  function normalizeList(result) {
    if (!Array.isArray(result) || result.length > 4096) fail('REGISTRY_HELPER_PROTOCOL', '注册表 value 列表无效。');
    return result.map(row => {
      validateName(row?.name);
      if (row.type === 'REG_DWORD') return { name: row.name, ...normalizeState({ exists: true, type: row.type, data: row.data }), supported: true };
      if (typeof row.type !== 'string' || row.type.length > 64) fail('REGISTRY_HELPER_PROTOCOL', '注册表 value 类型无效。');
      return { name: row.name, type: row.type, supported: false };
    });
  }
  async function listMachine() {
    return normalizeList(await call({ op: 'listMachine' }));
  }
  async function write(name, expected, desired) {
    name = validateName(name); expected = normalizeState(expected); desired = normalizeState(desired);
    const result = normalizeState(await call({ op: 'write', name, expected, desired }));
    if (!sameState(result, desired)) fail('REGISTRY_WRITE_VERIFY', '注册表写入后读回不一致。');
    return result;
  }

  return Object.freeze({ identity: Object.freeze({ scope: 'HKCU', view: '64', key }), read, list, listMachine, write });
}

module.exports = { createWindowsRegistryValues, normalizeState };
