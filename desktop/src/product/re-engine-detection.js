'use strict';

const fsDefault = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REFRAMEWORK_ADAPTERS, OFFICIAL_REFRAMEWORK_01417: OFFICIAL } = require('./reframework-compatibility');

const REF_SOURCE = `https://github.com/praydog/REFramework/blob/${OFFICIAL.source_commit}`;
const SOURCES = Object.freeze({
  gameIdentity: `${REF_SOURCE}/shared/sdk/GameIdentity.cpp`,
  storage: `${REF_SOURCE}/src/REFramework.cpp`,
  rhiManifest: 'https://github.com/RankFTW/RHI/blob/b2044965806d2ed01ff6f214da53f720aab4ff3e/manifest.json',
  pakHeader: 'https://github.com/Ekey/REE.PAK.Tool/blob/63b28bfeb066de001f393fdcd1c67512c943b8c8/REE.Unpacker/REE.Unpacker/FileSystem/Package/PakHeader.cs'
});
const LIMITS = Object.freeze({ directoryEntries: 1024, logBytes: 64 * 1024, metadataChars: 512, peOffset: 1024 * 1024 });

// Exact stems from the pinned upstream GameIdentity table. Its substring
// fallback is deliberately not used to authorize a deployment. Engine
// detection below needs independent local evidence even for these names.
const GAME_ROWS = [
  ['re2', 'Resident Evil 2', ['re2', 'bhd2'], 70],
  ['re3', 'Resident Evil 3', ['re3', 'bhd3'], 70],
  ['re4', 'Resident Evil 4', ['re4', 'bhd4'], 71],
  ['re7', 'Resident Evil 7', ['re7', 'bhd7'], 70],
  ['re8', 'Resident Evil Village', ['re8', 'village'], 69],
  ['re9', 'Resident Evil Requiem', ['re9'], 83, '3764200', 'rhi'],
  ['dmc5', 'Devil May Cry 5', ['devilmaycry5', 'dmc5'], 67],
  ['mhrise', 'Monster Hunter Rise', ['monsterhunterrise', 'mhrise', 'mhrisesunbreakdemo'], 71],
  ['sf6', 'Street Fighter 6', ['streetfighter6', 'sf6'], 71, '1364780', 'rhi'],
  ['dd2', "Dragon's Dogma 2", ['dd2'], 83, '2054970', 'rhi'],
  ['drdr', 'Dead Rising Deluxe Remaster', ['drdr'], 73],
  ['ggr', "Ghosts 'n Goblins Resurrection", ['makaimura_gg_re', 'makaimura'], 69],
  ['gs456', 'Apollo Justice: Ace Attorney Trilogy', ['gs456'], 73],
  ['kunitsu', 'Kunitsu-Gami: Path of the Goddess', ['kunitsugami'], 73],
  ['onimusha2', "Onimusha 2: Samurai's Destiny", ['onimusha2'], 74],
  ['mhwilds', 'Monster Hunter Wilds', ['monsterhunterwilds', 'mhwilds'], 81, '2246340', 'rhi'],
  ['mhstories3', 'Monster Hunter Stories 3: Twisted Reflection', ['monster_hunter_stories_3_twisted_reflection', 'monster_hunter_stories_3_twisted_reflection_trial'], 82],
  ['starforce', 'Mega Man Star Force Legacy Collection', ['starforce', 'megamanstarforce', 'mmstarforce'], 78],
  ['pragmata', 'Pragmata', ['pragmata'], 83],
  ['onimusha_wots', 'Onimusha: Way of the Sword', ['onimushawots', 'onimushawots_demo'], 82, '2638890', 'owner-validated']
];
const PROFILES = Object.freeze(GAME_ROWS.map(([gameId, name, stems, tdbVersion, steamAppId, requirement]) => Object.freeze({
  id: gameId, gameId, name, executables: Object.freeze(stems.map(stem => `${stem}.exe`)), tdbVersion,
  steamAppId: steamAppId || null, steamSource: steamAppId ? `https://store.steampowered.com/app/${steamAppId}/` : null,
  supportedByPinned: true, source: SOURCES.gameIdentity,
  // SF6's TDB71 does not satisfy this condition, although RHI requires REF.
  storage: gameId === 'dd2' || gameId === 'mhrise' || tdbVersion >= 74 ? '_storage_' : null,
  storageSource: SOURCES.storage,
  requirement: requirement || null,
  requirementSource: requirement === 'rhi' ? SOURCES.rhiManifest : null
})));

function localAbsolute(value) {
  return typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value) &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
}
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function metadataEngine(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  for (const key of ['engine', 'engineName', 'Engine', 'EngineName', 'fileDescription', 'FileDescription', 'productName', 'ProductName']) {
    const value = metadata[key];
    if (typeof value !== 'string' || value.length > LIMITS.metadataChars) continue;
    if (/(?:^|[^a-z0-9])re[ _-]*engine(?:$|[^a-z0-9])|\bRE[\s_-]*引擎|REエンジン/i.test(value)) return key;
  }
  return null;
}

function createReEngineDetection(options = {}) {
  const fs = options.fs || fsDefault;

  // Only plain paths belonging to this root supply evidence. Access failures,
  // links, aliases and changed files leave the engine unknown.
  function plain(file, directory = false) {
    const full = path.resolve(file), parsed = path.parse(full);
    let current = parsed.root, stat;
    try {
      for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part); stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) return null;
      }
      return stat && (directory ? stat.isDirectory() : stat.isFile()) ? stat : null;
    } catch { return null; }
  }
  function names(dir) {
    if (!plain(dir, true)) return null;
    let handle;
    try {
      handle = fs.opendirSync(dir);
      const found = new Map(); let entry, count = 0;
      while ((entry = handle.readSync())) {
        if (++count > LIMITS.directoryEntries || found.has(entry.name.toLowerCase())) return null;
        found.set(entry.name.toLowerCase(), entry.name);
      }
      return found;
    } catch { return null; }
    finally { if (handle) try { handle.closeSync(); } catch {} }
  }
  function read(file, limit, position = 0) {
    const before = plain(file); let fd;
    if (!before) return null;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink > 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) return null;
      const data = Buffer.alloc(Math.min(limit, Math.max(0, stat.size - position)));
      const count = fs.readSync(fd, data, 0, data.length, position);
      const after = fs.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
      return data.subarray(0, count);
    } catch { return null; }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
  function bitness(file) {
    const dos = read(file, 64);
    if (!dos || dos.length !== 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > LIMITS.peOffset) return null;
    const pe = read(file, 26, offset);
    if (!pe || pe.length !== 26 || pe.readUInt32LE(0) !== 0x4550) return null;
    return pe.readUInt16LE(4) === 0x8664 && pe.readUInt16LE(24) === 0x20b ? 64 :
      pe.readUInt16LE(4) === 0x14c && pe.readUInt16LE(24) === 0x10b ? 32 : null;
  }
  function officialLoader(file) {
    const stat = plain(file);
    if (!stat || stat.size !== OFFICIAL.dll_bytes) return false;
    if (options.fileDigest) return options.fileDigest(file) === OFFICIAL.dll_sha256;
    // Hash this one fixed-size DLL only when a bound REF log is the fallback.
    // Neither game executable nor asset archive is ever hashed or scanned.
    const data = read(file, OFFICIAL.dll_bytes);
    return !!data && data.length === OFFICIAL.dll_bytes && crypto.createHash('sha256').update(data).digest('hex') === OFFICIAL.dll_sha256;
  }
  function inspect(input) {
    if (!localAbsolute(input?.gameDir) || !localAbsolute(input?.exe)) return null;
    const gameDir = path.resolve(input.gameDir), exe = path.resolve(input.exe);
    if (!samePath(path.dirname(exe), gameDir) || !/\.exe$/i.test(exe)) return null;
    const entries = names(gameDir);
    if (!entries || !plain(exe)) return null;
    const architecture = bitness(exe);
    if (!architecture) return null;
    const at = name => entries.has(name) ? path.join(gameDir, entries.get(name)) : null;
    const evidence = [];
    const exeProfile = PROFILES.find(row => row.executables.includes(path.basename(exe).toLowerCase()));
    const appId = String(input.metadata?.steamAppId || '');
    const steamProfile = /^\d{1,10}$/.test(appId) ? PROFILES.find(row => row.steamAppId === appId) : null;
    const conflict = !!(exeProfile && appId && exeProfile.steamAppId && appId !== exeProfile.steamAppId);
    const profile = conflict ? null : exeProfile || steamProfile || null;

    const pak = at('re_chunk_000.pak');
    const header = pak && read(pak, 16);
    const validPak = !!header && header.length === 16 && header.readUInt32LE(0) === 0x414b504b &&
      [2, 4].includes(header[4]) && [0, 1, 2].includes(header[5]);
    if (validPak) evidence.push({ kind: 're-pak-header', source: 're_chunk_000.pak', detail: 'RE 资源包名称及 KPKA 文件头匹配；仅读取 16 字节。', reference: SOURCES.pakHeader });

    const natives = at('natives'), platforms = natives && names(natives);
    const nativePlatform = platforms && ['stm', 'x64'].find(name => platforms.has(name) && plain(path.join(natives, platforms.get(name)), true));
    const engineField = metadataEngine(input.metadata);
    if (nativePlatform && engineField) {
      evidence.push({ kind: 'engine-metadata', source: `metadata.${engineField}`, detail: '明确包含 RE Engine 引擎标记，并有对应原生资源目录。' });
      evidence.push({ kind: 're-native-directory', source: `natives/${nativePlatform}`, detail: '检测到 RE 原生资源目录。', reference: `${REF_SOURCE}/src/mods/IntegrityCheckBypass.cpp` });
    }

    if (!evidence.length && exeProfile && !conflict) {
      const logFile = at('re2_framework_log.txt'), loader = at('dinput8.dll');
      const bytes = logFile && read(logFile, LIMITS.logBytes);
      const log = bytes ? bytes.toString('utf8').replace(/^\uFEFF/, '') : '';
      // Require one complete pinned startup, the exact local root and the
      // exact game ID. A copied/stale log or filename alone is insufficient.
      const entriesInLog = log.split(/\r?\n/).filter(line => /\[REFramework\]\s+\[info\]/.test(line));
      const values = label => entriesInLog.filter(line => line.includes(`${label}: `)).map(line => line.slice(line.indexOf(`${label}: `) + label.length + 2).trim());
      const commits = values('Commit hash'), games = values('Game name'), roots = values('Current game path');
      const boundLog = entriesInLog.filter(line => /\bREFramework entry\s*$/.test(line)).length === 1 &&
        commits.length === 1 && commits[0] === OFFICIAL.source_commit && games.length === 1 && games[0].toLowerCase() === exeProfile.gameId &&
        roots.length === 1 && localAbsolute(roots[0]) && samePath(roots[0], gameDir);
      if (boundLog && loader && officialLoader(loader)) {
        evidence.push({ kind: 'bound-reframework-log', source: 're2_framework_log.txt', detail: '固定官方版本启动记录与本目录、游戏身份一致。', reference: SOURCES.storage });
        evidence.push({ kind: 'official-reframework-file', source: 'dinput8.dll', detail: '现有 REFramework 大小和 SHA256 与固定官方版本一致。', reference: OFFICIAL.source_url });
      }
    }
    if (!evidence.length) return null;

    if (exeProfile) evidence.push({ kind: 'exact-game-executable', source: path.basename(exe), detail: `官方固定版本识别为 ${exeProfile.name}。`, reference: SOURCES.gameIdentity });
    if (steamProfile) evidence.push({ kind: 'steam-app-id', source: 'metadata.steamAppId', detail: `${appId}：${steamProfile.name}`, reference: steamProfile.steamSource });
    if (conflict) evidence.push({ kind: 'identity-conflict', source: 'metadata.steamAppId', detail: '游戏 EXE 与 Steam 应用身份冲突，未选择自动兼容配套。' });
    const adapter = profile && REFRAMEWORK_ADAPTERS.find(row => row.executable.toLowerCase() === path.basename(exe).toLowerCase() && row.engine === 're-engine' && row.architecture === architecture && row.storage === profile.storage);
    // compatibilityKnown is the deployable, implemented exact profile. RHI's
    // broader required list remains separately visible on profile.requirement.
    const compatibilityKnown = !!(profile?.requirement && adapter && architecture === 64);
    return {
      id: 're-engine', label: '卡普空 RE 引擎', evidence, compatibilityKnown,
      profile: profile ? { ...profile, executable: path.basename(exe), adapterId: adapter?.id || null, automatic: compatibilityKnown, gameRuntimeVerified: false } : null
    };
  }
  return Object.freeze({ inspect });
}

const detector = createReEngineDetection();
module.exports = { detectReEngine: input => detector.inspect(input), createReEngineDetection,
  RE_ENGINE_PROFILES: PROFILES, REFRAMEWORK_REQUIRED_PROFILES: Object.freeze(PROFILES.filter(row => row.requirement)),
  RE_ENGINE_DETECTION_SOURCES: SOURCES, RE_ENGINE_DETECTION_LIMITS: LIMITS };
