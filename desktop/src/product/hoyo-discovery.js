'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { getBitness } = require('../core/pe');
const { noLinks } = require('./launch-safety');
const { HOYO_CLIENTS, validHoYoProfile, selectedExe } = require('./hoyoshade-profiles');

const BY_BIZ = new Map(HOYO_CLIENTS.map(row => [row.gameBiz, row]));
const EXES = [...new Set(HOYO_CLIENTS.map(row => row.exeName))];
const FOLDERS = ['Genshin Impact Game', 'Genshin Impact', '原神', 'Honkai Impact 3rd Game', 'Honkai Impact 3rd', '崩坏3',
  'Star Rail Game', 'Star Rail', '崩坏：星穹铁道', 'ZenlessZoneZero Game', 'ZenlessZoneZero', '绝区零'];
const LAUNCHER_FOLDERS = ['miHoYo Launcher', 'HoYoPlay', 'HoYoPlay Launcher', 'Starward'];
const BRANDS = ['miHoYo', 'Cognosphere'];
const key = value => path.resolve(value).toLowerCase();
const id = value => crypto.createHash('sha256').update(key(value)).digest('hex').slice(0, 24);
const cleanPath = value => typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value) && path.isAbsolute(value) ? path.resolve(value) : null;
const warn = (code, file, message) => ({ code, path: file || null, message });
const list = async value => { const result = typeof value === 'function' ? await value() : value; return Array.isArray(result) ? result.slice(0, 256) : []; };
const present = async file => { try { return await fs.stat(file); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; } };
const unchanged = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

async function readSmall(file, limit = 1024 * 1024) {
  await noLinks(file);
  const before = await present(file);
  if (!before) return null;
  if (!before.isFile() || before.size > limit) throw Error('文件类型或大小超出发现范围。');
  const bytes = await fs.readFile(file);
  const after = await fs.stat(file);
  if (!unchanged(before, after) || bytes.length !== before.size) throw Error('读取期间文件发生变化。');
  return bytes;
}
async function fileHash(file) {
  await noLinks(file);
  const before = await fs.stat(file);
  if (!before.isFile() || before.size > 512 * 1024 * 1024) throw Error('可执行文件超出检查范围。');
  const hash = crypto.createHash('sha256'), handle = await fs.open(file, 'r');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  if (!unchanged(before, await fs.stat(file))) throw Error('检查期间可执行文件发生变化。');
  return hash.digest('hex');
}
function iniValues(bytes, section, allowed) {
  const out = {}; let current = '';
  for (const line of (bytes?.toString('utf8') || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) { current = heading[1].toLowerCase(); continue; }
    const entry = line.match(/^\s*([^=;#]+?)\s*=\s*(.*?)\s*$/);
    if (entry && current === section && allowed.includes(entry[1].toLowerCase())) out[entry[1].toLowerCase()] = entry[2];
  }
  return out;
}
function varint(bytes, cursor, end) {
  let value = 0, shift = 0;
  for (let n = 0; n < 5; n++) {
    if (cursor.at >= end) throw Error('MMKV 长度记录不完整。');
    const byte = bytes[cursor.at++];
    if (n === 4 && byte > 15) throw Error('MMKV 长度记录溢出。');
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
  throw Error('MMKV 长度记录无效。');
}
function take(bytes, cursor, end, length) {
  if (length > end - cursor.at) throw Error('MMKV 记录不完整。');
  const out = bytes.subarray(cursor.at, cursor.at + length); cursor.at += length; return out;
}
// Tencent/MMKV ad7657ef9d120dbcdd7432d75aa6c59391149b22:
// Core/MMKV_IO.cpp stores actualSize before the data; MiniPBCoder.cpp decodeOneMap
// skips the root varint, uses the last value for a key, and erases zero-size values.
// Only the eleven public game keys are decoded. Account/telemetry keys and values
// are skipped as opaque byte spans, never parsed, returned, or included in errors.
function parseHoYoGameData(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes.length > 4 * 1024 * 1024) throw Error('HoYoPlay 安装记录格式无效。');
  if (bytes.readUInt32LE(0) === 0) return [];
  const end = 4 + bytes.readUInt32LE(0), cursor = { at: 4 }, values = new Map();
  if (end > bytes.length || end < 5) throw Error('HoYoPlay 安装记录不完整。');
  varint(bytes, cursor, end);
  let count = 0;
  while (cursor.at < end) {
    if (++count > 4096) throw Error('HoYoPlay 安装记录数量超限。');
    const keySize = varint(bytes, cursor, end), rawKey = take(bytes, cursor, end, keySize);
    const valueSize = varint(bytes, cursor, end), value = take(bytes, cursor, end, valueSize);
    const name = keySize <= 64 ? rawKey.toString('ascii') : '';
    if (!BY_BIZ.has(name) || !rawKey.equals(Buffer.from(name))) continue;
    if (!valueSize) { values.delete(name); continue; }
    if (valueSize > 256 * 1024) throw Error('HoYoPlay 游戏安装记录过大。');
    values.set(name, value);
  }
  const records = [], utf8 = new TextDecoder('utf-8', { fatal: true });
  for (const [gameBiz, value] of values) {
    const inner = { at: 0 }, textSize = varint(value, inner, value.length);
    const textBytes = take(value, inner, value.length, textSize);
    if (inner.at !== value.length) throw Error('HoYoPlay 游戏安装记录封装无效。');
    let parsed;
    try { parsed = JSON.parse(utf8.decode(textBytes)); } catch { throw Error('HoYoPlay 游戏安装记录无法解析。'); }
    if (!parsed || Array.isArray(parsed) || parsed.gameBiz !== gameBiz) throw Error('HoYoPlay 游戏类型记录冲突。');
    for (const field of ['installPath', 'persistentInstallPath']) {
      const gameRoot = cleanPath(parsed[field]);
      if (gameRoot && !records.some(row => row.gameBiz === gameBiz && key(row.gameRoot) === key(gameRoot))) records.push({ gameBiz, gameRoot });
    }
  }
  return records;
}

// Starward 3e2da5ffecde252211edb74b850ee13d6b93f6dd, AppConfig.Setting.cs:
// install_path_<gameBiz> in KVT; AppConfig.Configuration.cs resolves UserDataFolder.
// Immutable read-only SQLite prevents journal/SHM writes beside another app's DB.
// A live WAL is rejected so an old main-file snapshot cannot silently bind a game.
async function readStarwardInstalls(file) {
  await noLinks(file);
  const before = await present(file); if (!before) return [];
  if (!before.isFile() || before.size > 64 * 1024 * 1024) throw Error('Starward 安装记录超出读取范围。');
  for (const suffix of ['-wal', '-journal']) if ((await present(file + suffix))?.size) throw Error('Starward 安装记录正在写入，请稍后刷新。');
  const { DatabaseSync } = require('node:sqlite');
  const uri = pathToFileURL(file); uri.search = '?mode=ro&immutable=1';
  const db = new DatabaseSync(uri.href, { readOnly: true, allowExtension: false });
  try {
    const schema = db.prepare("SELECT type FROM sqlite_schema WHERE name='KVT'").get();
    if (schema?.type !== 'table') throw Error('Starward 安装记录表不可用。');
    const query = db.prepare('SELECT Key, Value FROM KVT WHERE Key = ? LIMIT 1'), records = [];
    for (const gameBiz of BY_BIZ.keys()) {
      const row = query.get('install_path_' + gameBiz), gameRoot = cleanPath(row?.Value);
      if (gameRoot) records.push({ gameBiz, gameRoot });
    }
    if (!unchanged(before, await fs.stat(file))) throw Error('Starward 安装记录读取期间发生变化。');
    for (const suffix of ['-wal', '-journal']) if ((await present(file + suffix))?.size) throw Error('Starward 安装记录正在写入，请稍后刷新。');
    return records;
  } finally { db.close(); }
}

function commandExe(value) {
  if (typeof value !== 'string') return null;
  const quoted = value.match(/^\s*"([^"\r\n]+\.exe)"(?:\s|,|$)/i);
  if (quoted) return cleanPath(quoted[1]);
  // Registry strings are data, never evaluated. Unquoted commands with spaces
  // cannot identify their target reliably and are ignored.
  return cleanPath(value.match(/^\s*([^\s",]+\.exe)(?:\s|,|$)/i)?.[1]);
}
async function readDiscoveryRegistry() {
  if (process.platform !== 'win32') return { launchers: [], gameRoots: [], starwardUserData: [] };
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = String.raw`$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$rows=@();$roots=@('Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall','Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall','Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')
foreach($root in $roots){if(Test-Path -LiteralPath $root){foreach($k in (Get-ChildItem -LiteralPath $root | Select-Object -First 2048)){$name=[string]$k.GetValue('DisplayName');if($name -match '^(HoYoPlay|miHoYo Launcher|Starward|米哈游启动器|原神|Genshin Impact|崩坏3|Honkai Impact 3rd?|崩坏：星穹铁道|Star Rail|绝区零|ZenlessZoneZero)(\s|$)'){$rows+=@{name=$name;location=[string]$k.GetValue('InstallLocation');icon=[string]$k.GetValue('DisplayIcon')}}}}}
$s=Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Starward' -ErrorAction SilentlyContinue
$p=Get-Item -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Classes\Starward\Shell\Open\Command' -ErrorAction SilentlyContinue
@{uninstall=@($rows|Select-Object -First 256);starwardUserData=$(if($s){[string]$s.GetValue('UserDataFolder')}else{''});starwardCommand=$(if($p){[string]$p.GetValue('')}else{''})}|ConvertTo-Json -Compress -Depth 4`;
  const raw = await new Promise((resolve, reject) => execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 256 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const parsed = JSON.parse(raw), launchers = [], gameRoots = [];
  for (const row of parsed.uninstall || []) {
    const location = cleanPath(row.location), icon = commandExe(row.icon);
    const kind = /^Starward(?:\s|$)/i.test(row.name) ? 'starward' : /^(HoYoPlay|miHoYo Launcher|米哈游启动器)(?:\s|$)/i.test(row.name) ? 'hoyoplay' : null;
    if (kind) { if (icon) launchers.push({ kind, path: icon, source: 'registry' }); if (location) launchers.push({ kind, path: location, source: 'registry' }); }
    else if (location) gameRoots.push(location);
  }
  const protocol = commandExe(parsed.starwardCommand);
  if (protocol && /^Starward\.exe$/i.test(path.basename(protocol))) launchers.push({ kind: 'starward', path: protocol, source: 'registry-protocol' });
  return { launchers, gameRoots, starwardUserData: [cleanPath(parsed.starwardUserData)].filter(Boolean) };
}

function createHoYoDiscovery(options = {}) {
  const appData = options.appData ?? process.env.APPDATA;
  const programFiles = (Array.isArray(options.programFiles) ? options.programFiles : options.programFiles ? [options.programFiles] :
    [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]).filter(cleanPath);
  const readRegistry = options.readRegistry || readDiscoveryRegistry;

  async function inspectLauncher(input, requestedKind) {
    const full = cleanPath(input); if (!full) return null;
    const stat = await present(full); if (!stat) return null;
    if (stat.isDirectory()) {
      const names = requestedKind === 'starward' ? ['Starward.exe'] : requestedKind === 'hoyoplay' ? ['launcher.exe', 'HYP.exe'] : ['launcher.exe', 'HYP.exe', 'Starward.exe'];
      for (const name of names) { const found = await inspectLauncher(path.join(full, name), requestedKind); if (found) return found; }
      return null;
    }
    const name = path.basename(full).toLowerCase();
    const kind = name === 'starward.exe' ? 'starward' : ['launcher.exe', 'hyp.exe'].includes(name) ? 'hoyoplay' : null;
    if (!kind || requestedKind && requestedKind !== kind) return null;
    // HYP.exe in a version directory is an alias of that installation's launcher.
    if (name === 'hyp.exe') {
      const parentLauncher = path.join(path.dirname(path.dirname(full)), 'launcher.exe');
      if (/^\d+\.\d+/.test(path.basename(path.dirname(full))) && await present(parentLauncher)) return inspectLauncher(parentLauncher, kind);
    }
    await noLinks(full);
    if (![32, 64].includes(getBitness(full))) return null;
    return { id: id(full), kind, path: full, source: 'manual', architecture: getBitness(full), sha256: await fileHash(full), matched: false, available: true };
  }

  async function inspectGame(input) {
    const full = cleanPath(input), games = [], warnings = [];
    if (!full) return { games, warnings: [warn('HOYO_PATH_INVALID', null, '请选择游戏目录或正式版游戏 EXE。')] };
    let stat;
    try { stat = await present(full); } catch { return { games, warnings: [warn('HOYO_GAME_UNREADABLE', full, '游戏路径无法读取。')] }; }
    if (!stat) return { games, warnings };
    const files = stat.isDirectory() ? EXES.map(name => path.join(full, name)) : [full];
    for (const exePath of files) {
      const clients = HOYO_CLIENTS.filter(row => row.exeName.toLowerCase() === path.basename(exePath).toLowerCase());
      if (!clients.length) continue;
      try {
        if (!await present(exePath)) continue;
        await noLinks(exePath);
        const architecture = getBitness(exePath);
        if (architecture !== 64) { warnings.push(warn('HOYO_ARCHITECTURE', exePath, '当前仅收录 64 位公开版客户端。')); continue; }
        const gameRoot = path.dirname(exePath), configPath = path.join(gameRoot, 'config.ini');
        const config = iniValues(await readSmall(configPath, 128 * 1024), 'general', ['game_version', 'game_biz', 'gamebiz', 'biz', 'channel', 'sub_channel']);
        const declared = config.game_biz || config.gamebiz || config.biz;
        if (declared && !clients.some(row => row.gameBiz === declared)) { warnings.push(warn('HOYO_PUBLIC_CLIENT_ONLY', exePath, '此客户端的游戏类型不属于已支持的公开版。')); continue; }
        const channelCandidates = [...new Set(clients.map(row => row.channel))];
        const certain = declared ? BY_BIZ.get(declared) : clients.length === 1 ? clients[0] : null;
        games.push({ id: id(exePath), exePath, gameRoot, family: clients[0].family, familyLabel: clients[0].familyLabel,
          channel: certain?.channel || null, channelCandidates, gameBiz: certain?.gameBiz || null,
          gameVersion: /^\d+(?:\.\d+){1,4}$/.test(config.game_version || '') ? config.game_version : null,
          architecture, releaseCategory: 'public', exeSha256: await fileHash(exePath), launchers: [], automaticBinding: null,
          evidence: [{ source: 'executable', path: exePath, reason: '公开版客户端 EXE 与 64 位 PE 已确认。' },
            ...(declared ? [{ source: 'game-config', path: configPath, gameBiz: declared, reason: '游戏配置声明的公开版客户端类型。' }] : [])], warnings: [] });
      } catch { warnings.push(warn('HOYO_GAME_UNREADABLE', exePath, '无法稳定读取此游戏，请关闭更新程序后刷新。')); }
    }
    return { games, warnings };
  }

  async function discover() {
    const warnings = [], launchers = new Map(), games = new Map(), inspectedPaths = new Map(), associations = [], saved = [], invalidSaved = new Set();
    let registry = { launchers: [], gameRoots: [], starwardUserData: [] };
    try { registry = await readRegistry() || registry; } catch { warnings.push(warn('HOYO_REGISTRY_UNREADABLE', null, '注册表安装位置读取失败，可手动选择游戏和启动器。')); }
    const getSource = async (value, name) => { try { return await list(value); } catch { warnings.push(warn('HOYO_SAVED_UNREADABLE', null, name + '读取失败。')); return []; } };
    const bindings = await getSource(options.savedBindings, '已保存绑定');
    const knownGames = await getSource(options.knownGames, '已保存游戏');
    const knownLaunchers = await getSource(options.knownLaunchers, '已保存启动器');
    async function addLauncher(candidate, source) {
      const file = cleanPath(typeof candidate === 'string' ? candidate : candidate?.path); if (!file) return null;
      try {
        const inspected = await inspectLauncher(file, candidate?.kind); if (!inspected) return null;
        const old = launchers.get(key(inspected.path));
        if (old) return old;
        const result = { ...inspected, source: candidate?.source || source }; launchers.set(key(result.path), result); return result;
      } catch { warnings.push(warn('HOYO_LAUNCHER_UNREADABLE', file, '无法稳定读取此启动器，请稍后刷新。')); return null; }
    }
    async function addGame(file) {
      if (!cleanPath(file)) return [];
      if (games.has(key(file))) return [games.get(key(file))];
      if (inspectedPaths.has(key(file))) return inspectedPaths.get(key(file));
      const result = await inspectGame(file); warnings.push(...result.warnings);
      const found = result.games.map(game => { const previous = games.get(key(game.exePath)); if (previous) return previous; games.set(key(game.exePath), game); return game; });
      inspectedPaths.set(key(file), found); return found;
    }
    // Seed sources have finite lists. No drive traversal or account/cache search.
    for (const row of bindings) {
      const profile = row?.hoyoProfile || row?.profile || row;
      if (!cleanPath(profile?.exePath)) continue;
      const foundGames = await addGame(profile.exePath);
      let launcher = await addLauncher(profile.launcher, 'saved-binding');
      if (!launcher && cleanPath(profile.launcher?.path) && ['hoyoplay', 'starward'].includes(profile.launcher?.kind)) {
        const file = path.resolve(profile.launcher.path);
        launcher = { id: id(file), kind: profile.launcher.kind, path: file, source: 'saved-binding', available: false, matched: false, sha256: null };
        launchers.set(key(file), launcher);
      }
      for (const game of foundGames) {
        const verified = row?.verified !== false && validHoYoProfile(profile, game.exePath) && profile.exeSha256 === game.exeSha256 && launcher?.sha256 === profile.launcher.sha256;
        if (verified) saved.push({ game, launcher, profile });
        else { invalidSaved.add(key(game.exePath)); game.warnings.push(warn('HOYO_BINDING_RECONFIRM', game.exePath, '已保存绑定的游戏或启动器需要重新确认。')); }
        if (launcher) associations.push({ gameRoot: game.gameRoot, gameBiz: profile.gameBiz || HOYO_CLIENTS.find(c => c.family === profile.family && c.channel === profile.channel)?.gameBiz,
          launcher, source: 'saved-binding', authoritative: verified, reason: verified ? '已保存绑定与当前文件哈希一致。' : '保留原启动器选项，等待重新确认。' });
      }
    }
    for (const game of knownGames) await addGame(typeof game === 'string' ? game : selectedExe(game));
    for (const launcher of [...knownLaunchers, ...(registry.launchers || [])].slice(0, 256)) await addLauncher(launcher, 'saved-launcher');
    for (const root of (registry.gameRoots || []).slice(0, 256)) {
      if (!cleanPath(root)) continue;
      await addGame(root);
      for (const folder of FOLDERS) await addGame(path.join(root, folder));
    }
    for (const root of programFiles) for (const folder of LAUNCHER_FOLDERS) await addLauncher({ path: path.join(root, folder) }, 'known-location');

    // Each launcher contributes only its own documented installation records.
    for (const launcher of launchers.values()) {
      if (!launcher.available) continue;
      const directory = path.dirname(launcher.path);
      if (launcher.kind === 'hoyoplay') {
        let hyp = {};
        try { hyp = iniValues(await readSmall(path.join(directory, 'config.ini'), 128 * 1024), 'hyp', ['channel', 'sub_channel', 'primary_game']); }
        catch { warnings.push(warn('HOYO_LAUNCHER_CONFIG', launcher.path, '启动器配置无法读取，安装关联需手动确认。')); }
        if (appData) for (const brand of BRANDS) {
          const root = path.join(appData, brand, 'HYP');
          let entries = [];
          try { await noLinks(root); entries = await fs.readdir(root, { withFileTypes: true }); }
          catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) warnings.push(warn('HOYO_INSTALL_RECORDS', root, 'HoYoPlay 安装记录无法读取。')); }
          for (const entry of entries.filter(row => row.isDirectory() && /^\d+_\d+$/.test(row.name)).slice(0, 32)) {
            const recordFile = path.join(root, entry.name, 'data', 'gamedata.dat');
            const match = /^\d+$/.test(hyp.channel || '') && /^\d+$/.test(hyp.sub_channel || '') && entry.name === `${hyp.channel}_${hyp.sub_channel}`;
            // primary_game is another whitelisted gameBiz, and identifies the
            // CN/global record store even when a launcher was installed elsewhere.
            // Directory names alone never prove the distribution or association.
            const primary = BY_BIZ.get(hyp.primary_game);
            const brandMatch = primary && (primary.channel === 'global' ? brand === 'Cognosphere' : brand === 'miHoYo');
            try {
              const bytes = await readSmall(recordFile, 4 * 1024 * 1024); if (!bytes) continue;
              for (const record of parseHoYoGameData(bytes)) associations.push({ ...record, launcher, source: 'hoyoplay-install-record', sourcePath: recordFile,
                authoritative: Boolean(match && brandMatch), reason: match && brandMatch ? 'HoYoPlay 安装记录与此启动器配置匹配。' : '发现 HoYoPlay 安装路径，启动器关联需确认。' });
            } catch { warnings.push(warn('HOYO_INSTALL_RECORDS', recordFile, 'HoYoPlay 安装记录不完整或正在更新，可稍后刷新。')); }
          }
        }
      } else {
        const dirs = new Set();
        for (const configDir of [directory, path.dirname(directory)]) {
          try {
            const bytes = await readSmall(path.join(configDir, 'config.ini'), 128 * 1024);
            const config = iniValues(bytes, 'general', ['userdatafolder']);
            // Starward writes UserDataFolder without a section in portable config.
            const plain = iniValues(bytes, '', ['userdatafolder']);
            const value = config.userdatafolder || plain.userdatafolder;
            if (value && !/[\0\r\n]/.test(value)) dirs.add(path.resolve(configDir, value));
          } catch { warnings.push(warn('HOYO_STARWARD_CONFIG', configDir, 'Starward 数据目录配置无法读取。')); }
        }
        // The registry setting belongs to the registered installation, while
        // portable installations use their adjacent config or database only.
        const registered = (registry.launchers || []).some(row => row.kind === 'starward' && cleanPath(row.path) && key(row.path) === key(launcher.path));
        if (registered) for (const dir of (registry.starwardUserData || []).slice(0, 16)) if (cleanPath(dir)) dirs.add(path.resolve(dir));
        dirs.add(directory);
        for (const dir of dirs) {
          const recordFile = path.join(dir, 'StarwardDatabase.db');
          try {
            for (const record of await readStarwardInstalls(recordFile)) associations.push({ ...record, launcher, source: 'starward-install-record', sourcePath: recordFile,
              authoritative: true, reason: 'Starward 白名单安装路径记录与此启动器对应。' });
          } catch { warnings.push(warn('HOYO_STARWARD_RECORDS', recordFile, 'Starward 安装记录无法只读检查或正在写入，请稍后刷新。')); }
        }
      }
      for (const base of [directory, path.join(directory, 'games')]) for (const folder of FOLDERS) await addGame(path.join(base, folder));
    }
    for (const association of associations) {
      const client = BY_BIZ.get(association.gameBiz); if (!client) continue;
      for (const game of await addGame(path.join(association.gameRoot, client.exeName))) {
        if (game.family !== client.family) continue;
        const link = { id: association.launcher.id, kind: association.launcher.kind, path: association.launcher.path, source: association.source,
          matched: association.authoritative, gameBiz: client.gameBiz, channel: client.channel, reason: association.reason };
        if (!game.launchers.some(row => row.id === link.id && row.gameBiz === link.gameBiz && row.matched === link.matched)) game.launchers.push(link);
        game.evidence.push({ source: association.source, path: association.sourcePath || association.launcher.path, gameBiz: client.gameBiz, reason: association.reason });
      }
    }
    for (const game of games.values()) {
      const previous = saved.filter(row => row.game.id === game.id);
      const channels = new Set(game.launchers.filter(row => row.matched).map(row => row.channel));
      if (game.channel) channels.add(game.channel);
      const compatible = game.launchers.filter(row => row.matched && (!game.channel || row.channel === game.channel));
      const unique = [...new Map(compatible.map(row => [row.id + ':' + row.gameBiz, row])).values()];
      const previousBindings = [...new Map(previous.map(row => [row.profile.bindingId, row])).values()];
      if (previousBindings.length === 1 && !invalidSaved.has(key(game.exePath))) {
        const chosen = previousBindings[0];
        game.channel = chosen.profile.channel; game.gameBiz = HOYO_CLIENTS.find(row => row.family === game.family && row.channel === game.channel).gameBiz;
        game.automaticBinding = { family: game.family, channel: game.channel, launcher: { kind: chosen.launcher.kind, path: chosen.launcher.path } };
      } else if (channels.size === 1 && unique.length === 1 && !invalidSaved.has(key(game.exePath))) {
        const chosen = unique[0]; game.channel = chosen.channel; game.gameBiz = chosen.gameBiz;
        game.automaticBinding = { family: game.family, channel: game.channel, launcher: { kind: chosen.kind, path: chosen.path } };
      } else {
        if (channels.size === 1) { game.channel = [...channels][0]; game.gameBiz = HOYO_CLIENTS.find(row => row.family === game.family && row.channel === game.channel)?.gameBiz || null; }
        if (channels.size > 1) { game.channel = null; game.gameBiz = null; game.warnings.push(warn('HOYO_CHANNEL_CONFLICT', game.exePath, '安装记录中的渠道不一致，请选择当前客户端渠道。')); }
        if (unique.length > 1 || previousBindings.length > 1) game.warnings.push(warn('HOYO_LAUNCHER_AMBIGUOUS', game.exePath, '多个启动器关联此游戏，请确认本次使用的启动器。'));
      }
      for (const launcher of launchers.values()) if (!game.launchers.some(row => row.id === launcher.id)) game.launchers.push({ id: launcher.id, kind: launcher.kind,
        path: launcher.path, source: launcher.source, matched: false, reason: '可选启动器，尚未确认与此游戏的关联。' });
      if (!game.channel) game.warnings.push(warn('HOYO_CHANNEL_CONFIRM', game.exePath, '仅凭 EXE 名称无法确认渠道，请选择实际客户端渠道。'));
    }
    for (const launcher of launchers.values()) launcher.matched = [...games.values()].some(game => game.launchers.some(row => row.id === launcher.id && row.matched));
    return { games: [...games.values()].sort((a, b) => a.exePath.localeCompare(b.exePath)), launchers: [...launchers.values()], warnings };
  }
  return { discover, inspectGame, inspectLauncher };
}
module.exports = { createHoYoDiscovery, parseHoYoGameData, readStarwardInstalls, readDiscoveryRegistry };
