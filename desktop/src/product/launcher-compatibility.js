'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, inside } = require('./launch-safety');

const APIS = new Set(['dx11', 'dx12', 'vulkan']);
const PLAN_TTL = 10 * 60 * 1000;
const MAX_CONFIG = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const PROTECTION = Object.freeze([
  ['ace', /(?:^|[\\/])(?:ace|slauncher|anti[-_ ]?cheat expert)(?:[\\/. _-]|$)/i, 'ACE'],
  ['pgameprotect', /pgameprotect/i, 'PGameProtect'],
  ['hoyokprotect', /hoyokprotect/i, 'HoYoKProtect'],
  ['eac', /easyanticheat|easy_anti_cheat/i, 'Easy Anti-Cheat'],
  ['battleye', /battleye|beservice/i, 'BattlEye'],
  ['eaac', /eaanticheat|ea anti.?cheat/i, 'EA AntiCheat']
]);

function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function text(value) { return typeof value === 'string' ? value : ''; }
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') ? path.resolve(value) : null; }
function same(left, right) { return Boolean(left && right) && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function chosen(game) { return game?.scan?.chosen || game?.chosen || {}; }
function launchEvidence(game) { return chosen(game).launchProfile || chosen(game).launcherProfile || game?.launchProfile || {}; }

function protectionEvidence(game) {
  const values = [...(game?.antiCheatFiles || []), ...(game?.scan?.antiCheatFiles || []), ...(game?.scan?.protectionFiles || [])]
    .filter(value => typeof value === 'string').slice(0, 128);
  return PROTECTION.filter(([, pattern]) => values.some(value => pattern.test(value))).map(([id,, label]) => ({ id, label }));
}

function apiState(game, targetApi) {
  const item = chosen(game), resolution = item.apiResolution || item.detectedApiResolution || {};
  const observedApi = text(item.observedApi || resolution.observedApi || resolution.detectedApi || resolution.api || game?.observedApi).toLowerCase() || null;
  const configuredApi = text(item.configuredApi || item.apiSettings?.api || game?.configuredApi).toLowerCase() || null;
  const preferredApi = text(targetApi || game?.apiOverride || 'auto').toLowerCase();
  const effectiveApi = preferredApi !== 'auto' ? preferredApi : configuredApi || observedApi || 'unknown';
  return { observedApi, configuredApi, preferredApi, effectiveApi };
}

function clientId(game, evidence, exe) {
  const hint = `${text(evidence.kind)} ${text(evidence.client)} ${text(game?.launcher)} ${exe}`.toLowerCase();
  if (/hoyoplay|starward|mihoyo|hoyoverse|zenless|genshin|starrail/.test(hint)) return 'hoyo';
  if (/wuthering|kuro|鸣潮/.test(hint)) return 'wuthering-waves';
  if (/neverness|nte|完美/.test(hint)) return 'neverness';
  if (/yysls|燕云|netease|网易/.test(hint)) return 'netease-yysls';
  if (/wegame|tencent/.test(hint)) return 'wegame';
  if (/steam/.test(hint)) return 'steam';
  return 'generic';
}

function verifiedSteam(game, item) {
  const appId = String(game?.verifiedSteamAppId || item.verifiedSteamAppId || game?.steamAppId || '');
  const root = absolute(game?.steamRoot || item.steamRoot);
  return /^\d{1,10}$/.test(appId) && root ? { appId, root } : null;
}

function apiControl(game, evidence, client, state) {
  const supplied = evidence.apiControl || chosen(game).apiSettings || null;
  if (supplied?.kind) return structuredClone(supplied);
  if (client === 'neverness' && absolute(evidence.settingsFile)) return { kind:'ini-boolean', file:absolute(evidence.settingsFile), section:'Game', key:'Dx11',
    values:{ dx11:'true', dx12:'false' }, supportedApis:['dx11','dx12'], requiresGameClosed:true };
  if (client === 'netease-yysls' && absolute(evidence.settingsFile)) return { kind:'yysls-graphics-api', file:absolute(evidence.settingsFile),
    dx12Tag:absolute(evidence.dx12Tag), graphicsTag:absolute(evidence.graphicsTag), supportedApis:['dx11','dx12'], requiresGameClosed:true };
  return { kind:'none', supportedApis:APIS.has(state.effectiveApi) ? [state.effectiveApi] : [], requiresGameClosed:false };
}

function resolveLaunchProfile(gameId, targetApi, options = {}) {
  const game = options.game || gameId;
  if (!game || typeof game !== 'object') fail('LAUNCH_PROFILE_GAME', '缺少游戏启动资料。');
  const id = text(game.id || gameId);
  const item = chosen(game), realExecutable = absolute(item.path || game.exe);
  if (!id || !realExecutable || !/\.exe$/i.test(realExecutable)) fail('LAUNCH_PROFILE_GAME', '游戏没有可验证的真实 EXE。');
  const evidence = launchEvidence(game), launcherExecutable = absolute(evidence.launcherPath || evidence.launcher?.path || game.launcherExecutable);
  const state = apiState(game, targetApi), steam = verifiedSteam(game, item), client = clientId(game, evidence, realExecutable);
  const preference = ['auto','steam','exe'].includes(options.preference) ? options.preference : 'auto';
  const protection = protectionEvidence(game);
  let launchMode, launchRequest, reason;
  if (preference === 'exe') {
    if (protection.length) fail('LAUNCH_PROTECTION_OFFICIAL_REQUIRED', `检测到 ${protection.map(row => row.label).join('、')}，必须使用经过验证的官方入口。`);
    launchMode = 'exe'; launchRequest = { exe:realExecutable, args:Array.isArray(evidence.directArgs) ? evidence.directArgs : [], cwd:path.dirname(realExecutable) };
    reason = '用户在高级设置中明确选择直接启动游戏 EXE。';
  } else if (steam && preference !== 'exe') {
    launchMode = 'steam'; launchRequest = { exe:path.join(steam.root, 'steam.exe'), args:['-applaunch', steam.appId], cwd:steam.root };
    reason = '使用已验证的 Steam 安装身份启动，不改写 localconfig.vdf。';
  } else if (launcherExecutable) {
    const launcherArgs = Array.isArray(evidence.launcherArgs) ? evidence.launcherArgs.filter(value => typeof value === 'string') : [];
    if (client === 'hoyo' && evidence.gameBiz && !launcherArgs.some(value => /^--game=/.test(value))) launcherArgs.push(`--game=${evidence.gameBiz}`);
    launchMode = 'official'; launchRequest = { exe:launcherExecutable, args:launcherArgs, cwd:absolute(evidence.launcherCwd) || path.dirname(launcherExecutable) };
    reason = `使用已验证的${client === 'generic' ? '官方客户端' : '官方启动器'}，并等待真实游戏进程。`;
  } else {
    if (client !== 'generic' || protection.length) fail('LAUNCH_OFFICIAL_ENTRY_REQUIRED', '已识别游戏平台或保护组件，但没有可验证的官方启动入口；请重新扫描或选择官方启动器。');
    launchMode = 'exe'; launchRequest = { exe:realExecutable, args:[], cwd:path.dirname(realExecutable) };
    reason = '没有可验证的官方启动器记录，使用已绑定的游戏 EXE。';
  }
  if (preference === 'steam' && !steam) fail('LAUNCH_STEAM_UNVERIFIED', '当前游戏没有可验证的 Steam 安装身份。');
  return Object.freeze({ version:1, gameId:id, client, launchMode, launchRequest:Object.freeze(launchRequest), realExecutable,
    processNames:Object.freeze([path.basename(realExecutable), ...(Array.isArray(evidence.processNames) ? evidence.processNames : [])].filter((value,index,array) => array.indexOf(value) === index)),
    ...state, apiControl:Object.freeze(apiControl(game, evidence, client, state)), protection:Object.freeze(protection),
    officialEntry:launchMode !== 'exe', directOptIn:preference === 'exe', reason,
    warning:protection.length ? `检测到 ${protection.map(row => row.label).join('、')}；坚持官方入口，不尝试绕过。` : null });
}

function replaceIni(textValue, section, key, value) {
  const lines = String(textValue).replace(/^\uFEFF/, '').split(/\r?\n/), header = `[${section}]`.toLowerCase();
  let inSection = false, sectionSeen = false, keySeen = false, inserted = false;
  const output = [];
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      if (inSection && !keySeen) { output.push(`${key}=${value}`); inserted = true; }
      inSection = `[${match[1]}]`.toLowerCase() === header;
      sectionSeen ||= inSection; output.push(line); continue;
    }
    const entry = inSection && line.match(/^\s*([^;#][^=]*?)\s*=/);
    if (entry && entry[1].trim().toLowerCase() === key.toLowerCase()) {
      if (keySeen) fail('LAUNCH_API_CONFIG_AMBIGUOUS', `配置中存在重复的 ${section}/${key}。`);
      keySeen = true; output.push(`${key}=${value}`);
    } else output.push(line);
  }
  if (inSection && !keySeen && !inserted) output.push(`${key}=${value}`);
  if (!sectionSeen) output.push('', `[${section}]`, `${key}=${value}`);
  return output.join('\r\n');
}

function createLauncherCompatibility(options = {}) {
  const userData = absolute(options.userData);
  if (!userData) fail('LAUNCH_PROFILE_CONFIG', '统一启动器需要有效的数据目录。');
  const assertGameClosed = options.assertGameClosed;
  const broker = options.broker;
  const now = options.now || Date.now;
  const plans = new Map();

  async function readConfig(file) {
    if (!absolute(file)) fail('LAUNCH_API_CONFIG_PATH', '图形 API 配置路径无效。');
    await noLinks(file); const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG) fail('LAUNCH_API_CONFIG_FILE', '图形 API 配置不是有界普通文件。');
    const bytes = await fsp.readFile(file); return { bytes, sha256:sha256(bytes) };
  }

  async function previewApiChange(profile, requestedApi = profile?.preferredApi) {
    if (!profile || profile.version !== 1) fail('LAUNCH_API_PROFILE', '启动档案无效。');
    const api = text(requestedApi).toLowerCase(), control = profile.apiControl;
    if (!APIS.has(api) || !control.supportedApis?.includes(api)) return { version:1, gameId:profile.gameId, api, changed:false,
      applicable:false, blockers:[`此游戏没有经过验证的 ${api.toUpperCase()} 配置方式。`], changes:[] };
    if (control.kind === 'none') return { version:1, gameId:profile.gameId, api, changed:false, applicable:false,
      blockers:['没有可验证的游戏配置可修改；不会猜测启动参数。'], changes:[] };
    const files = [];
    if (control.kind === 'ini-boolean') {
      const before = await readConfig(control.file), after = Buffer.from(replaceIni(before.bytes.toString('utf8'), control.section, control.key, control.values[api]), 'utf8');
      files.push({ file:path.resolve(control.file), before:before.bytes, beforeSha256:before.sha256, after, afterSha256:sha256(after) });
    } else if (control.kind === 'yysls-graphics-api') {
      const before = await readConfig(control.file), after = Buffer.from(replaceIni(before.bytes.toString('utf8'), 'Graphics', 'DX12', api === 'dx12' ? 'true' : 'false'), 'utf8');
      files.push({ file:path.resolve(control.file), before:before.bytes, beforeSha256:before.sha256, after, afterSha256:sha256(after) });
      for (const [file, content] of [[control.dx12Tag, api === 'dx12' ? '1' : '0'], [control.graphicsTag, api]]) if (file) {
        const old = fs.existsSync(file) ? await readConfig(file) : { bytes:null, sha256:null }, next = Buffer.from(content, 'utf8');
        files.push({ file:path.resolve(file), before:old.bytes, beforeSha256:old.sha256, after:next, afterSha256:sha256(next) });
      }
    } else return { version:1, gameId:profile.gameId, api, changed:false, applicable:false, blockers:[`配置 Adapter ${control.kind} 尚未接入统一事务。`], changes:[] };
    const plan = { version:1, planId:crypto.randomUUID(), gameId:profile.gameId, realExecutable:profile.realExecutable, api,
      createdAt:now(), expiresAt:now() + PLAN_TTL, files, changed:files.some(row => row.beforeSha256 !== row.afterSha256) };
    plans.set(plan.planId, plan);
    return { version:1, planId:plan.planId, gameId:plan.gameId, api, changed:plan.changed, applicable:true, blockers:[],
      changes:files.filter(row => row.beforeSha256 !== row.afterSha256).map(row => ({ path:row.file, action:row.before ? 'update' : 'create', beforeSha256:row.beforeSha256, afterSha256:row.afterSha256 })) };
  }

  async function publish(file, bytes) {
    await noLinks(file); await fsp.mkdir(path.dirname(file), { recursive:true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`; await fsp.writeFile(temp, bytes, { flag:'wx' });
    try { await fsp.rename(temp, file); } finally { await fsp.rm(temp, { force:true }); }
  }

  async function applyApiChange(planId) {
    const plan = plans.get(planId); plans.delete(planId);
    if (!plan || plan.expiresAt < now()) fail('LAUNCH_API_PLAN_EXPIRED', '图形 API 修改预览已过期。');
    if (typeof assertGameClosed !== 'function') fail('LAUNCH_API_CLOSED_CHECK', '无法确认游戏已关闭。');
    await assertGameClosed(path.dirname(plan.realExecutable), plan.realExecutable);
    for (const row of plan.files) {
      const current = fs.existsSync(row.file) ? await readConfig(row.file) : { sha256:null };
      if (current.sha256 !== row.beforeSha256) fail('LAUNCH_API_CONFIG_CHANGED', '图形 API 配置在预览后发生变化。');
    }
    const backupRoot = path.join(userData, 'launcher-api-backups', crypto.createHash('sha256').update(plan.realExecutable).digest('hex'));
    if (!inside(userData, backupRoot)) fail('LAUNCH_API_BACKUP_PATH', '图形 API 备份路径越界。');
    await fsp.mkdir(backupRoot, { recursive:true });
    const applied = [];
    try {
      for (const row of plan.files) {
        if (row.before) {
          const backup = path.join(backupRoot, `${row.beforeSha256}-${path.basename(row.file)}`);
          if (!fs.existsSync(backup)) await fsp.writeFile(backup, row.before, { flag:'wx' });
          else if (sha256(await fsp.readFile(backup)) !== row.beforeSha256) fail('LAUNCH_API_BACKUP_CONFLICT', '图形 API 备份摘要冲突。');
        }
        await publish(row.file, row.after); applied.push(row);
        if ((await readConfig(row.file)).sha256 !== row.afterSha256) fail('LAUNCH_API_WRITE_VERIFY', '图形 API 配置写入后校验失败。');
      }
      return { applied:true, changed:plan.changed, api:plan.api, files:applied.length };
    } catch (error) {
      for (const row of applied.reverse()) {
        try { if (row.before) await publish(row.file, row.before); else await fsp.rm(row.file, { force:true }); } catch { /* Keep original error and durable backup. */ }
      }
      throw error;
    }
  }

  async function launch(profile, controls) {
    if (!profile || profile.version !== 1 || !profile.launchRequest) fail('LAUNCH_PROFILE_INVALID', '启动档案无效。');
    if (!broker?.launch) fail('LAUNCH_PROFILE_BROKER', '普通权限启动入口不可用。');
    return broker.launch(profile.launchRequest, controls);
  }

  return Object.freeze({ resolveLaunchProfile:(game, targetApi, resolveOptions) => resolveLaunchProfile(game, targetApi, { ...resolveOptions, game }),
    previewApiChange, applyApiChange, launch });
}

module.exports = { APIS, PROTECTION, resolveLaunchProfile, createLauncherCompatibility, replaceIni };
