'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2500;
const EPIC_MANIFEST_ROOT = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
const NOT_A_GAME = /redistributabl|steamworks common|directx|vcredist|proton|steam linux runtime|soundtrack/i;

function warning(code, message, details) { return { code, message, source: 'launcher-locations', ...(details ? { details } : {}) }; }
function uniquePaths(paths) {
  const seen = new Set(); const result = [];
  for (const value of paths || []) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    const key = resolved.toLowerCase();
    if (!seen.has(key)) { seen.add(key); result.push(resolved); }
  }
  return result;
}

function defaultSteamRoots(env = process.env, fsImpl = fs) {
  const systemDrive = env.SystemDrive || 'C:';
  const roots = [
    path.join(env['ProgramFiles(x86)'] || path.join(systemDrive, 'Program Files (x86)'), 'Steam'),
    path.join(env.ProgramFiles || path.join(systemDrive, 'Program Files'), 'Steam'),
    path.join(systemDrive, 'Steam')
  ];
  return uniquePaths(roots).filter(root => {
    try { return fsImpl.existsSync(path.join(root, 'steamapps')); } catch { return false; }
  });
}

function normalizeSnapshot(value) {
  const row = value && typeof value === 'object' ? value : {};
  const warnings = Array.isArray(row.warnings) ? row.warnings.filter(item => item && typeof item.code === 'string') : [];
  const gog = Array.isArray(row.gog) ? row.gog.filter(item => item && typeof item.path === 'string' && path.isAbsolute(item.path))
    .map(item => ({ id: String(item.id || ''), name: String(item.name || item.id || ''), path: path.resolve(item.path) })) : [];
  return {
    version: 1,
    steamPath: typeof row.steamPath === 'string' && path.isAbsolute(row.steamPath) ? path.resolve(row.steamPath) : null,
    gog,
    warnings
  };
}

function sourceScript(options = {}) {
  if (options.scriptPath) return path.resolve(options.scriptPath);
  const candidates = [];
  if (options.resourcesPath || process.resourcesPath) candidates.push(path.join(options.resourcesPath || process.resourcesPath, 'launcher-locations.ps1'));
  if (/(?:^|[\\/])app[.]asar(?:[\\/]|$)/i.test(__dirname)) return candidates[0];
  candidates.push(path.join(__dirname, 'launcher-locations.ps1'));
  return candidates.find(file => fs.existsSync(file)) || candidates[candidates.length - 1];
}

function readRegistrySnapshot(options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    return { version: 1, steamPath: null, gog: [], warnings: [warning('LAUNCHER_REGISTRY_UNAVAILABLE', '当前平台没有 Windows 启动器注册表快照。')] };
  }
  const powershell = path.resolve(options.powershell || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const scriptPath = sourceScript(options);
  const timeout = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 100 && options.timeoutMs <= 30000 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxBuffer = Number.isInteger(options.maxOutputBytes) && options.maxOutputBytes >= 4096 && options.maxOutputBytes <= 1024 * 1024 ? options.maxOutputBytes : MAX_OUTPUT_BYTES;
  try {
    const runner = options.runner || execFileSync;
    // This is the shipped read-only query, not caller-provided code or data.
    // Running it as a command avoids requiring a machine-wide script policy
    // change; application-control denial still returns the ordinary warning.
    const script = fs.readFileSync(scriptPath, 'utf8').replace(/^\uFEFF/, '');
    const command = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n' + script;
    const output = runner(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout, maxBuffer, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (Buffer.byteLength(output, 'utf8') > maxBuffer) throw Object.assign(new Error('output limit'), { code: 'OUTPUT_LIMIT' });
    return normalizeSnapshot(JSON.parse(String(output).trim().replace(/^\uFEFF/, '')));
  } catch (error) {
    return { version: 1, steamPath: null, gog: [], warnings: [warning('LAUNCHER_REGISTRY_SNAPSHOT_FAILED', '启动器注册表快照失败，继续使用默认目录与已保存路径。', { cause: error.code || 'snapshot' })] };
  }
}

function readEpicGames(options = {}) {
  const root = options.epicRoot || EPIC_MANIFEST_ROOT;
  const warnings = [];
  let files;
  try { files = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.item')).slice(0, 512); }
  catch (error) { return { games: [], warnings: error.code === 'ENOENT' ? [] : [warning('LAUNCHER_EPIC_READ_FAILED', 'Epic 游戏清单读取失败。', { cause: error.code || 'read' })] }; }
  const games = [];
  for (const entry of files) {
    const file = path.join(root, entry.name);
    try {
      const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 256 * 1024) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data.InstallLocation !== 'string' || !path.isAbsolute(data.InstallLocation) || !fs.existsSync(data.InstallLocation) || NOT_A_GAME.test(data.DisplayName || '')) continue;
      games.push({ launcher: 'Epic Games', id: data.AppName || null, name: data.DisplayName || path.basename(data.InstallLocation), dir: data.InstallLocation, poster: null });
    } catch { warnings.push(warning('LAUNCHER_EPIC_MANIFEST_INVALID', 'Epic 游戏清单无法读取，已跳过一个条目。', { file: entry.name })); }
  }
  return { games, warnings };
}

function createLauncherLocations(options = {}) {
  const read = typeof options.snapshot === 'function' ? options.snapshot : () => readRegistrySnapshot(options);
  return Object.freeze({
    snapshot() {
      try { return normalizeSnapshot(read()); }
      catch (error) { return { version: 1, steamPath: null, gog: [], warnings: [warning('LAUNCHER_REGISTRY_SNAPSHOT_FAILED', '启动器注册表快照失败，继续使用默认目录与已保存路径。', { cause: error.code || 'snapshot' })] }; }
    },
    defaultSteamRoots: () => defaultSteamRoots(options.env || process.env, options.fs || fs),
    epic: () => readEpicGames(options)
  });
}

module.exports = { EPIC_MANIFEST_ROOT, MAX_OUTPUT_BYTES, createLauncherLocations, defaultSteamRoots, normalizeSnapshot, readEpicGames, readRegistrySnapshot };
