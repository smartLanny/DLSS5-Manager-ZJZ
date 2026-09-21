'use strict';
const fs = require('node:fs');
const { DEFAULT_RESHADE_KEY, PREVIOUS_RESHADE_DEFAULT_KEY, MANAGED_RESHADE_DEFAULT_KEYS, ensureDefaultReShadeHotkey, hasKeyOverlay } = require('./hotkeys');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { noLinks, inside, atomicJson } = require('./launch-safety');
const { hashRegularFile, deploymentHashLimit } = require('./streamed-file-digest');
const { readManifest, manifestPath, newManifest, backupPath, assertManifestExecutable } = require('./manifest');
const { requireAddonLayout, inspectAddonLayout } = require('./reshade-layout');
const { externalConfig, localConfig, loaderConfig, inspectProfile } = require('./external-profile-config');
const { INSTALLED_NAMES } = require('./constants');
const { classifyApi } = require('./game-support');
const { classifyAddon } = require('./conflicts');
const { snapshotAddonLoadingLayout, assertAddonSnapshot } = require('./addon-loading-layout');
const { planAddonCompatibility } = require('./addon-compatibility');
const { sourceBinding, validSourceBinding, sourceAllows } = require('./addon-source-binding');
const { HOYO_RECIPE, validHoYoProfile } = require('./hoyoshade-profiles');

const PRODUCT = 'xiaofeng-external-runtime';
const RECEIPT = '_DLSS5_Backup/xiaofeng-external.json';
const PENDING = '_DLSS5_Backup/xiaofeng-external-pending.json';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_FILE = 768 * 1024 * 1024;
const MANAGED = new Set(['addon', 'bridge', 'runtime', 'carrier', 'config', 'companion']);
const companionPolicy = require('./payload-companions');
const MUTABLE = /\.(?:ini|json|toml|ya?ml)$/i;
const ADDON = /\.addon(?:32|64)?$/i;
const PROTECTED = /^(?:dxgi|d3d9|d3d10|d3d11|d3d12|opengl32|dinput8|version|winmm|dsound|nvngx_dlss|nvngx_dlssg|_nvngx)\.dll$/i;
const key = value => path.resolve(value).toLowerCase();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: 'DEPLOYMENT_' + code, details }); };
const active = new Set();
const HOYO_PROXIES = ['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d9.dll', 'opengl32.dll', 'ReShade64.dll', 'ReShade32.dll'];
function leaf(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 220 &&
    path.basename(value) === value && !/[<>:"|?*\0\\/]/.test(value) && !/[. ]$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function noLinksSync(file) {
  const full = path.resolve(file), root = path.parse(full).root; let cursor = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) fail('LINK', '运行目录含链接，已保留文件和记录。');
      if (key(cursor) !== key(full) && !stat.isDirectory()) fail('PATH_PREFIX', '目标路径的上级位置是文件，未创建部署记录。', { file: cursor });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function readJson(file) {
  noLinksSync(file);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail('RECORD', '部署记录大小无效。');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function digest(file) {
  // Shared by native and external plan/commit EXE checks (MGR#28). The larger
  // EXE budget never relaxes DLL, config, backup or package size limits.
  return hashRegularFile(file, { assertPath: noLinks, maxBytes: deploymentHashLimit(file), fail });
}
function createExternalRuntime(options) {
  if (!path.isAbsolute(options.userData || '')) fail('CONFIG', '外置运行目录需要绝对用户目录。');
  const base = path.join(path.resolve(options.userData), 'external-runtime'), plans = new Map(), rescuePlans = new Map();
  const copy = options.copyFile || fsp.copyFile;
  const guards = options.guards || require('../core/install-guards');
  const pe = options.pe || require('../core/pe');
  function target(game, recovering = false) {
    const gameRoot = path.resolve(game.dir || game.gameRoot || '.');
    const previous = readJson(path.join(gameRoot, RECEIPT)), interrupted = readJson(path.join(gameRoot, PENDING));
    let exe = game.scan?.chosen?.path || game.chosen?.path || game.exe;
    if (recovering) exe = (interrupted || previous)?.exe || exe;
    if (!exe) exe = (previous || interrupted)?.exe;
    if (!path.isAbsolute(game.dir || game.gameRoot || '') || !path.isAbsolute(exe || '') ||
        !inside(gameRoot, exe) || !/\.exe$/i.test(exe)) fail('TARGET', '请先确认实际游戏 EXE。');
    exe = path.resolve(exe);
    const id = hash(Buffer.from(key(exe))), ownerRoot = path.join(base, id);
    const binding = recovering && interrupted ? interrupted : previous;
    const profileId = binding?.exe && key(binding.exe) === key(exe) ? binding.profileId : undefined;
    if (profileId !== undefined && !UUID.test(profileId)) fail('RECORD', '外置运行目录代次无效。');
    const expectedRuntime = path.join(ownerRoot, profileId ? 'active-' + profileId : 'active');
    // Windows path identity ignores case, while the INI byte hash does not.
    // Keep the validated receipt spelling so a worker cannot rewrite the
    // original loader configuration merely by normalizing userData casing.
    const runtimeDir = typeof binding?.runtimeDir === 'string' && path.isAbsolute(binding.runtimeDir) &&
      key(binding.runtimeDir) === key(expectedRuntime) ? binding.runtimeDir : expectedRuntime;
    return { id, gameId: game.id, gameRoot, exe, dir: path.dirname(exe), ownerRoot,
      profileId, sourceBinding: binding?.sourceBinding,
      runtimeDir, receipt: path.join(gameRoot, RECEIPT), pending: path.join(gameRoot, PENDING) };
  }
  function allowed(t, file, role) {
    const absolute = path.resolve(file);
    if (role === 'source-addon') return sourceAllows(t.sourceBinding, absolute, t.dir);
    if (role === 'receipt') return key(absolute) === key(t.receipt);
    if (role === 'manifest') return key(absolute) === key(manifestPath(t.gameRoot));
    if (role === 'original-backup') {
      const rel = path.relative(t.gameRoot, absolute), match = rel.match(/^_DLSS5_Backup[\\/]xiaofeng-originals[\\/]([a-f0-9-]{36})[\\/](.+)$/i);
      if (!match || !UUID.test(match[1])) return false;
      const original = path.resolve(t.gameRoot, match[2]);
      return inside(t.gameRoot, original) && (allowed(t, original, 'managed') || allowed(t, original, 'game-proxy'));
    }
    if (role === 'game-proxy') return key(path.dirname(absolute)) === key(t.dir) && HOYO_PROXIES.some(name => name.toLowerCase() === path.basename(absolute).toLowerCase());
    if (role === 'profile-loader') return key(absolute) === key(path.join(t.runtimeDir, 'ReShade64.dll'));
    if (role === 'managed' && [t.dir, t.runtimeDir].some(dir => companionPolicy.isCompanionName(path.relative(dir, absolute).replaceAll('\\', '/')))) return true;
    if (![t.dir, t.runtimeDir].some(dir => key(path.dirname(absolute)) === key(dir))) return false;
    const name = path.basename(absolute);
    if (!leaf(name) || /\.exe$/i.test(name) || PROTECTED.test(name)) return false;
    if (role === 'reshade-config') return name === 'ReShade.ini';
    if (role === 'managed') return Object.entries(INSTALLED_NAMES).some(([kind, value]) => MANAGED.has(kind) && value === name);
    if (role === 'user-addon') return ADDON.test(name);
    if (role === 'user-sidecar') return MUTABLE.test(name);
    if (role === 'user-dependency') return /\.dll$/i.test(name);
    return false;
  }
  function validateReceipt(t, value) {
    if (!value) return null;
    if (value.product !== PRODUCT || value.version !== 1 || value.id !== t.id ||
        key(value.gameRoot || '.') !== key(t.gameRoot) || key(value.exe || '.') !== key(t.exe) ||
        key(value.runtimeDir || '.') !== key(t.runtimeDir) || !['local', 'external'].includes(value.mode) ||
        !UUID.test(value.generation || '') || !['dx11', 'dx12'].includes(value.api) ||
        !value.localManifest || !Array.isArray(value.files) || value.files.length > 128 ||
        typeof value.originalReShadeConfig !== 'string' || !HASH.test(value.loaderConfigHash || '') ||
        value.loadingMode !== undefined && !['helper', 'proxy'].includes(value.loadingMode) ||
        value.proxy && (!/^(?:dxgi|d3d12)\.dll$/.test(value.proxy.name || '') || !HASH.test(value.proxy.sha256 || '')))
      fail('RECORD', '外置部署记录与当前游戏不一致，已保留恢复入口。');
    if (value.proxyBaseline && (!/^(?:dxgi|d3d12)\.dll$/.test(value.proxyBaseline.name || '') || !HASH.test(value.proxyBaseline.sha256 || '')))
      fail('RECORD', '原加载入口记录无效。');
    if (value.panelDefaultAdded !== undefined && typeof value.panelDefaultAdded !== 'boolean') fail('RECORD', '外置面板默认键记录无效。');
    if (value.panelDefaultKey !== undefined && !MANAGED_RESHADE_DEFAULT_KEYS.includes(value.panelDefaultKey)) fail('RECORD', '外置面板默认键版本无效。');
    if (value.origin !== undefined && !['direct', 'direct_hoyo'].includes(value.origin)) fail('RECORD', '外置来源记录无效。');
    if (value.hoyoProfile && (!validHoYoProfile(value.hoyoProfile, t.exe) || !HASH.test(value.profileGeneration || '') ||
        value.mode === 'external' && value.loadingMode !== 'helper')) fail('RECORD', '米哈游客户端绑定与部署记录不一致。');
    if (value.origin === 'direct_hoyo') {
      if (!validHoYoProfile(value.hoyoProfile, t.exe) || !HASH.test(value.profileGeneration || '') || !UUID.test(value.initialOperation || '') ||
          value.mode === 'external' && value.loadingMode !== 'helper' || value.proxy !== null ||
          !Array.isArray(value.initialProxies) || value.initialProxies.length > HOYO_PROXIES.length)
        fail('RECORD', '米哈游专用部署身份或加载方式无效。');
      const initial = readJson(path.join(t.ownerRoot, 'history', value.initialOperation, 'operation.json'));
      const config = initial?.files?.find(row => row.role === 'reshade-config' && key(row.file) === key(path.join(t.dir, 'ReShade.ini')));
      const loader = initial?.files?.find(row => row.role === 'profile-loader' && key(row.file) === key(path.join(t.runtimeDir, 'ReShade64.dll')));
      if (!initial || initial.product !== PRODUCT || initial.operation !== value.initialOperation || initial.id !== t.id || key(initial.exe || '.') !== key(t.exe) ||
          key(initial.gameRoot || '.') !== key(t.gameRoot) ||
          (initial.profileId || null) !== (value.profileId || null) || !config || !loader || loader.after !== HOYO_RECIPE.loaderSha256 ||
          config.before !== (value.originalConfigExisted ? hash(Buffer.from(value.originalReShadeConfig)) : null) ||
          config.after !== hash(Buffer.from(loaderConfig(value.originalReShadeConfig, t.runtimeDir))) ||
          value.mode === 'external' && config.after !== value.loaderConfigHash)
        fail('RECORD', '米哈游首装配置与原事务映射不一致。');
      const seen = new Set();
      for (const row of value.initialProxies) {
        const proof = initial.files.find(item => item.role === 'game-proxy' && key(item.file) === key(path.join(t.dir, row.name || '')));
        if (!HOYO_PROXIES.includes(row.name) || seen.has(row.name.toLowerCase()) || !HASH.test(row.sha256 || '') ||
            !proof || proof.before !== row.sha256 || proof.after !== null || proof.snapshot !== row.snapshot)
          fail('RECORD', '米哈游原加载器恢复映射无效。');
        seen.add(row.name.toLowerCase());
      }
    }
    if (value.sourceBinding && !validSourceBinding(value.sourceBinding, t.dir)) fail('RECORD', '原插件加载范围记录无效。');
    if (value.isolatedAddons !== undefined) {
      if (!Array.isArray(value.isolatedAddons) || value.isolatedAddons.length > 128 || !value.sourceBinding) fail('RECORD', '插件隔离记录无效。');
      const isolated = new Set();
      for (const row of value.isolatedAddons) {
        if (!row || !sourceAllows(value.sourceBinding, row.path, t.dir) || !HASH.test(row.sha256 || '') || isolated.has(key(row.path)) ||
            !UUID.test(row.operation || '') || !/^before\/[0-9]+\.bin$/.test(row.snapshot || '')) fail('RECORD', '插件隔离位置未绑定原加载范围。');
        const original = readJson(path.join(t.ownerRoot, 'history', row.operation, 'operation.json'));
        const proof = original?.files?.find(item => item.role === 'source-addon' && key(item.file) === key(row.path));
        if (!original || original.product !== PRODUCT || original.id !== t.id || original.sourceBinding?.fingerprint !== value.sourceBinding.fingerprint ||
            !proof || proof.before !== row.sha256 || proof.after !== null || proof.snapshot !== row.snapshot)
          fail('RECORD', '插件隔离恢复映射与原事务不一致。');
        isolated.add(key(row.path));
      }
    }
    if (value.origin === 'direct' && (!UUID.test(value.initialOperation || '') || !value.initialProxy ||
        !/^(?:dxgi|d3d12)\.dll$/.test(value.initialProxy.name || '') || !HASH.test(value.initialProxy.after || '') ||
        value.initialProxy.before !== null && !HASH.test(value.initialProxy.before || '') ||
        !/^before\/[0-9]+\.bin$/.test(value.initialProxy.snapshot || '') ||
        typeof value.initialProxy.owned !== 'boolean')) fail('RECORD', '首次外置部署的原始加载器记录无效。');
    assertManifestExecutable(t.gameRoot, value.localManifest, t.exe);
    if (value.origin === 'direct') {
      const initial = readJson(path.join(t.ownerRoot, 'history', value.initialOperation, 'operation.json'));
      const proxyFile = path.join(t.dir, value.initialProxy.name), configFile = path.join(t.dir, 'ReShade.ini');
      if (!initial || initial.product !== PRODUCT || initial.operation !== value.initialOperation || initial.id !== t.id ||
          key(initial.exe || '.') !== key(t.exe) || key(initial.gameRoot || '.') !== key(t.gameRoot) ||
          (initial.profileId || null) !== (value.profileId || null) || !Array.isArray(initial.files))
        fail('RECORD', '首次外置部署的原始事务映射缺失。');
      const proxy = initial.files.find(row => row.role === 'game-proxy' && key(row.file) === key(proxyFile));
      const config = initial.files.find(row => row.role === 'reshade-config' && key(row.file) === key(configFile));
      if (!proxy || !config || proxy.snapshot !== value.initialProxy.snapshot || proxy.before !== value.initialProxy.before ||
          proxy.after !== value.initialProxy.after || value.initialProxy.owned !== (proxy.before !== proxy.after) ||
          config.before !== (value.originalConfigExisted ? hash(Buffer.from(value.originalReShadeConfig)) : null) ||
          value.mode === 'external' && (proxy.after !== value.proxy.sha256 || config.after !== value.loaderConfigHash))
        fail('RECORD', '首次外置恢复目标与原事务映射不一致。');
      if (value.retiredProxy) {
        const row = value.retiredProxy, proof = initial.files.find(item => item.role === 'game-proxy' && key(item.file) === key(path.join(t.dir, row.name || '')));
        if (!/^(?:dxgi|d3d12)\.dll$/.test(row.name || '') || row.name === value.initialProxy.name || !HASH.test(row.sha256 || '') ||
            !proof || proof.before !== row.sha256 || proof.after !== null || proof.snapshot !== row.snapshot)
          fail('RECORD', '原加载入口的备份映射无效。');
      }
    }
    const names = new Set();
    for (const row of value.files) {
      if (!row || !(leaf(row.name) || row.role === 'managed' && row.kind === 'companion' && companionPolicy.isCompanionName(row.name)) || names.has(row.name.toLowerCase()) || !HASH.test(row.sha256 || '') ||
          !HASH.test(row.originHash || '') || !allowed(t, path.join(t.runtimeDir, row.name), row.role) ||
          typeof row.mutable !== 'boolean' || typeof row.localOwned !== 'boolean')
        fail('RECORD', '外置部署记录含未知或重复文件，已保留现状。');
      names.add(row.name.toLowerCase());
    }
    return value;
  }
  function record(t) {
    const value = readJson(t.receipt);
    if (value?.mode === 'local' && typeof value.exe === 'string' && key(value.exe) !== key(t.exe)) {
      // An inactive external history for EXE A must not prevent a new,
      // separately confirmed EXE B after A's ordinary installation is removed.
      validateReceipt(target({ dir: t.gameRoot, exe: value.exe }), value); return null;
    }
    return validateReceipt(t, value);
  }
  function pending(t) {
    const value = readJson(t.pending);
    if (value && (value.product !== PRODUCT || value.version !== 1 || value.id !== t.id)) fail('RECOVERY_INVALID', '外置待恢复记录归属不符。');
    return value;
  }
  async function closed(t) { await noLinks(t.exe); await guards.assertGameClosed(t.gameRoot, t.exe); }
  async function assertReady(game) {
    const t = target(game);
    if (pending(t)) fail('RECOVERY_REQUIRED', '上次部署未完成，请先恢复未完成部署。');
    for (const rel of ['_DLSS5_Backup/pending-switch.json', '_DLSS5_Backup/xiaofeng-environment-pending.json']) {
      if (fs.existsSync(path.join(t.gameRoot, rel))) fail('OTHER_RECOVERY', '游戏有其他未完成文件操作，请先使用对应恢复入口。');
    }
    if (fs.existsSync(path.join(t.runtimeDir, '_DLSS5_Backup/pending-switch.json')))
      fail('OTHER_RECOVERY', '外置组件有未完成文件操作，请先使用对应恢复入口。');
  }
  function getLayout(game) {
    const t = target(game), saved = record(t), interrupted = pending(t), external = saved?.mode === 'external';
    const runtimeDir = external ? t.runtimeDir : t.dir;
    if (external) {
      noLinksSync(t.runtimeDir);
      const ini = path.join(t.dir, 'ReShade.ini');
      if (!interrupted && (!fs.existsSync(ini) || hash(fs.readFileSync(ini)) !== saved.loaderConfigHash))
        fail('FILE_CHANGED', '游戏的 ReShade 运行目录指向已被修改，未猜测配置位置。', { file: ini });
      if (!interrupted && saved.loadingMode === 'helper' && (saved.hoyoProfile ? HOYO_PROXIES : ['dxgi.dll', 'd3d12.dll']).some(name => fs.existsSync(path.join(t.dir, name))))
        fail('HELPER_PROXY_CONFLICT', '助手加载时游戏目录出现代理 DLL，已阻止重复加载。');
      if (!interrupted && saved.hoyoProfile) {
        const loader = path.join(t.runtimeDir, 'ReShade64.dll'); noLinksSync(loader);
        const stat = fs.statSync(loader);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || hash(fs.readFileSync(loader)) !== HOYO_RECIPE.loaderSha256)
          fail('FILE_CHANGED', '米哈游加载器与固定配套不一致。');
      }
      if (!interrupted && saved.origin === 'direct' && saved.loadingMode !== 'helper') {
        const proxy = path.join(t.dir, saved.proxy.name); noLinksSync(proxy);
        const stat = fs.statSync(proxy);
        if (!stat.isFile() || stat.size > MAX_FILE || hash(fs.readFileSync(proxy)) !== saved.proxy.sha256)
          fail('FILE_CHANGED', '首次外置部署的游戏加载器已被修改，未接管新文件。', { file: proxy });
      }
    }
    const profile = inspectProfile(t.dir, options.environment || process.env);
    if (external && !interrupted && profile.ok && (key(profile.baseDir) !== key(t.runtimeDir) || key(profile.addonDir) !== key(t.runtimeDir)))
      fail('FILE_CHANGED', '当前 ReShade 运行或插件目录与受管外置目录不一致，请先核对配置。');
    const local = external ? { ok: profile.ok } : inspectAddonLayout(t.dir);
    const configured = profile.configured, addonDir = profile.addonDir;
    const desired = external ? { loaderDir: t.dir, baseDir: t.runtimeDir, addonDir: t.runtimeDir, activeConfigPath: path.join(t.runtimeDir, 'ReShade.ini') } : configured;
    return { mode: external ? 'external' : 'local', source: external ? PRODUCT : 'game-directory', exe: t.exe,
      gameRoot: t.gameRoot, loaderDir: t.dir, runtimeDir: external ? runtimeDir : profile.baseDir, addonDir, addonDirectory: addonDir,
      activeConfigPath: configured.activeConfigPath, reshadeConfigDir: configured.baseDir, nrConfigDir: addonDir,
      configured, sourceLayout: saved?.sourceLayout || profile.configured, desired,
      hoyoProfile: saved?.hoyoProfile || null, profileGeneration: saved?.profileGeneration || null,
      knownComponents: profileKnownComponents(t, saved),
      loadingBackend: saved?.mode === 'external' && saved.hoyoProfile ? 'hoyoshade' : 'local',
      warnings: profile.warnings, origin: saved?.origin || 'native',
      logDirs: [...new Set([configured.baseDir, addonDir])], verified: !interrupted && local.ok && profile.ok,
      blockers: interrupted ? ['上次部署尚未恢复'] : !profile.ok ? profile.blockers : local.ok ? [] : [local.code],
      needsRecovery: Boolean(interrupted), generation: saved?.generation || null, version: external ? saved.payloadVersion : readManifest(t.gameRoot)?.payloadVersion || null, api: saved?.api || null,
      loadingMode: external ? saved.loadingMode || 'proxy' : 'proxy',
      loaderPath: external && saved.loadingMode === 'helper' ? path.join(t.runtimeDir, 'ReShade64.dll') : null,
      proxyPaths: saved?.proxy ? [path.join(t.dir, saved.proxy.name)] : [],
      moduleManifest: external ? saved.files.filter(row => !row.mutable).map(row => ({ path: path.join(t.runtimeDir, row.name),
        name: row.name, kind: row.kind, role: ({ addon: 'core', bridge: 'chain', runtime: 'nr-runtime', carrier: 'carrier', loader: 'reshade' })[row.kind] || row.role,
        sha256: row.sha256, architecture: row.architecture ?? (row.kind === 'companion' ? /\.dll$/i.test(row.name) ? 64 : null : MANAGED.has(row.kind) || row.kind === 'loader' ? 64 : null) })) : [] };
  }
  function profileKnownComponents(t, saved) {
    if (!saved || saved.origin !== 'direct_hoyo') return [];
    return saved.files.filter(row => !row.mutable && row.originPath).flatMap(row => {
      const decision = saved.compatibility?.decisions?.find(value => key(value.path) === key(row.originPath) && value.sha256 === row.originHash);
      if (decision?.action !== 'keep') return [];
      return [{ path: path.join(t.runtimeDir, row.name), sha256: row.sha256, role: row.role, owned: true, owner: PRODUCT,
        compatibility: 'compatible', compatibilitySource: decision.explicitKeep ? 'user-choice' : 'verified-profile',
        sourcePath: row.originPath, sourceFingerprint: saved.compatibility.sourceFingerprint }];
    });
  }
  async function inspect(game) {
    const t = target(game), saved = record(t), interrupted = pending(t), localManifest = readManifest(t.gameRoot);
    const localPending = fs.existsSync(path.join(t.gameRoot, '_DLSS5_Backup/pending-switch.json'));
    let layout; try { layout = getLayout(game); } catch (error) {
      layout = { mode: saved?.mode || 'local', runtimeDir: saved?.mode === 'external' ? t.runtimeDir : t.dir,
        verified: false, blockers: [error.message], needsRecovery: Boolean(interrupted),
        errorCode: error.code, errorDetails: error.details };
    }
    const files = [];
    if (saved?.mode === 'external' && !interrupted) for (const row of saved.files) {
      let actual = null, reason = null;
      try { actual = await digest(path.join(t.runtimeDir, row.name)); } catch (error) { reason = error.message; }
      files.push({ ...row, actual, valid: actual !== null && (row.mutable || actual === row.sha256), reason });
    }
    return { ...layout, installed: Boolean(saved?.mode === 'external' || localManifest), pending: Boolean(interrupted || localPending),
      needsRecovery: Boolean(interrupted || localPending),
      canRestore: Boolean(interrupted || saved?.mode === 'external'), version: saved?.mode === 'external' ? saved.payloadVersion : localManifest?.payloadVersion || null,
      api: saved?.api || classifyApi(game.scan?.chosen || game.chosen), baseline: saved?.baseline || null,
      previous: saved?.previous || null, current: saved ? { generation: saved.generation, mode: saved.mode, version: saved.payloadVersion,
        runtimeDir: saved.mode === 'external' ? t.runtimeDir : t.dir } : null,
      rescue: { available: Boolean(interrupted || saved?.mode === 'external'), pending: Boolean(interrupted) },
      files, ready: Boolean(saved?.mode === 'external' || localManifest) && !interrupted && !localPending && layout.verified && files.every(row => row.valid), runtimeVerified: false };
  }
  async function publish(temp, destination, replacing) {
    if (options.publish) return options.publish(temp, destination, replacing);
    if (process.platform !== 'win32') { await fsp.rename(temp, destination); return; }
    const literal = file => "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from(file).toString('base64') + "'))";
    const script = "$ErrorActionPreference='Stop'; [IO.File]::" + (replacing ? 'Replace' : 'Move') +
      '(' + literal(temp) + ',' + literal(destination) + (replacing ? ',[NullString]::Value' : '') + ');';
    await execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 8192 });
  }
  async function atomicCopy(t, source, destination, expected, before) {
    await noLinks(destination); await fsp.mkdir(path.dirname(destination), { recursive: true });
    const staging = path.join(path.dirname(destination), '.xiaofeng-' + crypto.randomUUID() + '.part');
    try {
      await copy(source, staging, fs.constants.COPYFILE_EXCL);
      if (await digest(staging) !== expected || await digest(source) !== expected) fail('FILE_CHANGED', '复制内容校验失败，未提交目标文件。');
      const handle = await fsp.open(staging, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await closed(t);
      if (await digest(destination) !== before) fail('FILE_CHANGED', '提交前目标被外部修改，未覆盖。', { file: destination });
      await publish(staging, destination, before !== null);
    } finally { await fsp.unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function snapshot(source, destination, expected) {
    await noLinks(source); await noLinks(destination); await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    if (await digest(destination) !== expected || await digest(source) !== expected) fail('FILE_CHANGED', '创建恢复快照时文件改变。');
    const file = await fsp.open(destination, 'r+'); try { await file.sync(); } finally { await file.close(); }
  }
  function historyFile(t, operation, name) {
    if (!UUID.test(operation) || !/^(?:before|after)\/[0-9]+\.bin$/.test(name)) fail('RECOVERY_INVALID', '外置快照位置无效。');
    return path.join(t.ownerRoot, 'history', operation, name);
  }
  async function validateWal(t, wal, allowChanged = false) {
    if (!wal || wal.product !== PRODUCT || wal.version !== 1 || wal.id !== t.id || !UUID.test(wal.operation || '') ||
        key(wal.exe || '.') !== key(t.exe) || key(wal.gameRoot || '.') !== key(t.gameRoot) ||
        (wal.profileId || null) !== (t.profileId || null) ||
        !Array.isArray(wal.files) || wal.files.length > 256) fail('RECOVERY_INVALID', '外置恢复记录不完整。');
    if (wal.sourceBinding) {
      if (!validSourceBinding(wal.sourceBinding, t.dir)) fail('RECOVERY_INVALID', '插件来源快照未绑定原配置。');
      t = { ...t, sourceBinding: wal.sourceBinding };
    }
    if (wal.pid !== process.pid && Number.isInteger(wal.pid)) {
      try { process.kill(wal.pid, 0); fail('BUSY', '另一管理器仍在执行部署。'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const seen = new Set();
    for (let i = 0; i < wal.files.length; i++) {
      const row = wal.files[i];
      if (!allowed(t, row.file, row.role) || seen.has(key(row.file)) || row.before !== null && !HASH.test(row.before || '') ||
          row.after !== null && !HASH.test(row.after || '') || row.snapshot !== 'before/' + i + '.bin' || row.prepared !== 'after/' + i + '.bin')
        fail('RECOVERY_INVALID', '外置恢复记录含未授权目标。');
      seen.add(key(row.file));
      if (row.before !== null && await digest(historyFile(t, wal.operation, row.snapshot)) !== row.before)
        fail('BACKUP_CHANGED', '原始快照缺失或被修改，已保留恢复记录。');
      const current = await digest(row.file);
      if (!allowChanged && current !== row.before && current !== row.after) fail('FILE_CHANGED', '部署目标被外部改变，未覆盖。', { file: row.file });
    }
  }
  async function rollback(t, wal) {
    await closed(t); await validateWal(t, wal);
    for (const row of [...wal.files].reverse()) {
      const current = await digest(row.file); if (current === row.before) continue;
      if (current !== row.after) fail('FILE_CHANGED', '恢复前目标已变化，已保留记录。', { file: row.file });
      if (row.before === null) {
        await closed(t); await noLinks(row.file);
        if (await digest(row.file) !== row.after) throw Object.assign(new Error('删除前目标已变化，已保留外部文件和恢复记录。'),
          { code: 'DEPLOYMENT_FILE_CHANGED', details: { file: row.file }, preservePending: true });
        await fsp.unlink(row.file);
      }
      else await atomicCopy(t, historyFile(t, wal.operation, row.snapshot), row.file, row.before, current);
    }
    await fsp.unlink(t.pending);
    return { recovered: true, runtimeVerified: false };
  }
  async function transaction(t, plan) {
    const wal = { version: 1, product: PRODUCT, id: t.id, operation: plan.operation, exe: t.exe,
      gameRoot: t.gameRoot, profileId: t.profileId, sourceBinding: t.sourceBinding,
      pid: process.pid, createdAt: new Date().toISOString(), files: [] };
    for (let i = 0; i < plan.operations.length; i++) {
      const row = plan.operations[i];
      if (!allowed(t, row.file, row.role)) fail('TARGET', '部署计划含未知目标。');
      if (await digest(row.file) !== row.before) fail('PLAN_CHANGED', '部署预览后的文件已经改变，请重新检查。', { file: row.file });
      const snapshotName = 'before/' + i + '.bin', prepared = 'after/' + i + '.bin';
      if (row.before !== null) await snapshot(row.file, historyFile(t, plan.operation, snapshotName), row.before);
      if (row.after !== null) {
        const preparedFile = historyFile(t, plan.operation, prepared);
        if (row.bytes !== undefined) {
          await noLinks(preparedFile); await fsp.mkdir(path.dirname(preparedFile), { recursive: true });
          await fsp.writeFile(preparedFile, row.bytes, { flag: 'wx' });
          const file = await fsp.open(preparedFile, 'r+'); try { await file.sync(); } finally { await file.close(); }
        } else await snapshot(row.source, preparedFile, row.after);
      }
      wal.files.push({ file: row.file, role: row.role, before: row.before, after: row.after, snapshot: snapshotName, prepared });
    }
    await validateWal(t, wal);
    // Keep the mapping from every saved byte snapshot to its original target,
    // including successful operations. A previous-version identity is not
    // useful recovery evidence if only anonymous numbered .bin files remain.
    await atomicJson(path.join(t.ownerRoot, 'history', plan.operation, 'operation.json'), wal);
    await atomicJson(t.pending, wal);
    try {
      for (let i = 0; i < wal.files.length; i++) {
        const row = wal.files[i];
        if (row.role === 'source-addon') await plan.beforeSourceIsolation?.();
        if (plan.sourceGuard && (row.role === 'game-proxy' || row.role === 'reshade-config' && key(row.file) === key(path.join(t.dir, 'ReShade.ini'))))
          await plan.sourceGuard();
        const current = await digest(row.file);
        if (current !== row.before) fail('FILE_CHANGED', '部署开始后目标被外部修改，未覆盖。', { file: row.file });
        if (row.after !== row.before) {
          await closed(t);
          if (row.after === null) {
            await noLinks(row.file);
            if (await digest(row.file) !== row.before) throw Object.assign(new Error('删除前目标已变化，已保留外部文件和恢复记录。'),
              { code: 'DEPLOYMENT_FILE_CHANGED', details: { file: row.file }, preservePending: true });
            await fsp.unlink(row.file);
          }
          else await atomicCopy(t, historyFile(t, wal.operation, row.prepared), row.file, row.after, current);
        }
        await options.afterWrite?.({ index: i, row, target: t });
      }
      await fsp.unlink(t.pending);
    } catch (error) {
      if (!error.preservePending) try { await rollback(t, wal); } catch (recoveryError) { error.recoveryError = recoveryError; error.preservePending = true; }
      if (error.preservePending) { error.details = { ...error.details, needsRecovery: true }; }
      throw error;
    }
  }
  async function collectLocal(t, manifest) {
    const files = [], names = new Set();
    for (const row of manifest.files) {
      if (!MANAGED.has(row.kind)) continue;
      const file = path.resolve(t.gameRoot, row.rel);
      if (!allowed(t, file, 'managed')) fail('LAYOUT', '当前安装含其他运行目录，请先恢复普通安装。');
      const actual = await digest(file);
      if (!actual || row.kind !== 'config' && actual !== row.installedSha256) fail('FILE_CHANGED', '已安装文件缺失或被修改，未迁移。', { file });
      const name = path.relative(t.dir, file).replaceAll('\\', '/');
      files.push({ name, role: 'managed', kind: row.kind, mutable: row.kind === 'config',
        sha256: actual, originHash: actual, localOwned: true, source: file }); names.add(name.toLowerCase());
    }
    const config = path.join(t.dir, INSTALLED_NAMES.config);
    if (!names.has(INSTALLED_NAMES.config.toLowerCase()) && await digest(config)) {
      const actual = await digest(config);
      files.push({ name: INSTALLED_NAMES.config, role: 'managed', kind: 'config', mutable: true, sha256: actual,
        originHash: actual, localOwned: false, source: config }); names.add(INSTALLED_NAMES.config.toLowerCase());
    }
    const entries = await fsp.readdir(t.dir, { withFileTypes: true });
    for (const entry of entries) if (ADDON.test(entry.name) && !names.has(entry.name.toLowerCase())) {
      if (!entry.isFile()) fail('LAYOUT', 'Add-on 不是普通文件，未迁移。');
      const file = path.join(t.dir, entry.name);
      if (classifyAddon(entry.name, file)) fail('CONFLICT', '目录仍有另一 NR 或旧桥接器，请先检查冲突。', { file });
      const actual = await digest(file);
      files.push({ name: entry.name, role: 'user-addon', kind: 'user-addon', mutable: false,
        sha256: actual, originHash: actual, localOwned: false, source: file }); names.add(entry.name.toLowerCase());
      const stem = entry.name.replace(ADDON, '').toLowerCase();
      for (const sidecar of entries) if (sidecar.isFile() && MUTABLE.test(sidecar.name) &&
          sidecar.name.replace(/\.[^.]+$/, '').toLowerCase() === stem && !names.has(sidecar.name.toLowerCase())) {
        const source = path.join(t.dir, sidecar.name), sideHash = await digest(source);
        files.push({ name: sidecar.name, role: 'user-sidecar', kind: 'user-sidecar', mutable: true,
          sha256: sideHash, originHash: sideHash, localOwned: false, source }); names.add(sidecar.name.toLowerCase());
      }
    }
    // Preserve statically imported sidecar DLLs alongside copied user Add-ons.
    // Their original files remain in place; system/game loaders are never copied.
    for (let index = 0; index < files.length; index++) if (['user-addon', 'user-dependency'].includes(files[index].role)) {
      let imports = []; try { imports = pe.getImports(files[index].source) || []; } catch {}
      for (const imported of imports) {
        const name = path.basename(imported);
        if (!leaf(name) || PROTECTED.test(name) || names.has(name.toLowerCase()) || !/\.dll$/i.test(name)) continue;
        const source = path.join(t.dir, name), actual = await digest(source); if (!actual) continue;
        files.push({ name, role: 'user-dependency', kind: 'user-dependency', mutable: false,
          sha256: actual, originHash: actual, localOwned: false, source }); names.add(name.toLowerCase());
      }
      if (files.length > 128) fail('LAYOUT', '同目录组件过多，未扩大迁移范围。');
    }
    return files;
  }
  async function sourceAddons(profile, context = {}) {
    const rows = [], names = new Map(), directNames = [], checks = [];
    const snapshot = await snapshotAddonLoadingLayout({ exeDir: profile.configured.loaderDir, gameId: context.game?.id || null,
      architecture: context.architecture || 64, environment: options.environment || process.env });
    const knownComponents = [...(context.knownComponents || []), ...(typeof options.knownComponents === 'function'
      ? await options.knownComponents(context.game) : options.knownComponents || [])];
    const compatibility = planAddonCompatibility(snapshot, { knownComponents, keep: context.keep || [], selectedCore: context.selectedCore,
      selectedComponents: context.selectedComponents || [] });
    if (compatibility.blockers.length) fail('SOURCE_POLICY', '插件隔离或保留选择需要重新核对。', { compatibility });
    const isolated = [...compatibility.isolate, ...compatibility.retire], isolatedPaths = new Set(isolated.map(row => key(row.path)));
    const binding = sourceBinding(snapshot);
    if (!validSourceBinding(binding, profile.configured.loaderDir)) fail('SOURCE_LAYOUT', '原插件范围无法建立可恢复映射。');
    const entries = fs.existsSync(profile.addonDir) ? await fsp.readdir(profile.addonDir, { withFileTypes: true }) : [];
    const excluded = new Set((context.excludePaths || []).map(key));
    const searched = row => ['.addon', context.architecture === 32 ? '.addon32' : '.addon64'].includes(path.extname(row.name));
    const inventory = entries.filter(searched).map(row => `${row.name}:${row.isFile() ? 'file' : 'other'}`).sort();
    async function add(source, role, mutable = false) {
      const name = path.basename(source), previous = names.get(name.toLowerCase());
      if (!leaf(name) || PROTECTED.test(name) || name.toLowerCase() === 'reshade.ini' ||
          Object.values(INSTALLED_NAMES).some(value => value.toLowerCase() === name.toLowerCase()))
        fail('SOURCE_CONFLICT', '原活动插件与新外置配套存在同名文件，未覆盖。', { file: source });
      if (previous) { if (key(previous.source) !== key(source)) fail('SOURCE_CONFLICT', '多个原插件目录有同名文件，无法安全合并。', { file: source }); return previous; }
      const actual = await digest(source); if (!actual) fail('SOURCE_CHANGED', '原活动插件缺失，未修改加载目录。', { file: source });
      const row = { name, role, kind: role, mutable, sha256: actual, originHash: actual, originPath: source, localOwned: false, source };
      names.set(name.toLowerCase(), row); rows.push(row); checks.push({ file: source, sha256: actual });
      if (rows.length > 128) fail('LAYOUT', '原活动插件范围过大。');
      return row;
    }
    for (const entry of entries) if (searched(entry)) {
      if (isolatedPaths.has(key(path.join(profile.addonDir, entry.name)))) continue;
      if (excluded.has(key(path.join(profile.addonDir, entry.name)))) continue;
      if (!entry.isFile()) fail('SOURCE_LAYOUT', '原插件目录包含链接或非普通插件文件。');
      await add(path.join(profile.addonDir, entry.name), 'user-addon');
    }
    for (const explicit of profile.directLoads) {
      if (isolatedPaths.has(key(explicit.path))) continue;
      if (excluded.has(key(explicit.path))) { directNames.push(path.basename(explicit.path)); continue; }
      if (!ADDON.test(explicit.path) && !/\.dll$/i.test(explicit.path)) fail('SOURCE_LAYOUT', '无法识别显式加载的插件类型。');
      const row = await add(explicit.path, ADDON.test(explicit.path) ? 'user-addon' : 'user-dependency'); directNames.push(row.name);
    }
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!['user-addon', 'user-dependency'].includes(row.role)) continue;
      const directory = path.dirname(row.source), stem = row.name.replace(/\.(?:addon(?:32|64)?|dll)$/i, '').toLowerCase();
      const siblings = await fsp.readdir(directory, { withFileTypes: true });
      for (const sibling of siblings) if (sibling.isFile() && MUTABLE.test(sibling.name) && sibling.name.replace(/\.[^.]+$/, '').toLowerCase() === stem)
        await add(path.join(directory, sibling.name), 'user-sidecar', true);
      let imports = []; try { imports = pe.getImports(row.source) || []; } catch {}
      for (const imported of imports) {
        if (!leaf(imported) || PROTECTED.test(imported) || !/\.dll$/i.test(imported)) continue;
        const source = path.join(directory, imported);
        if (fs.existsSync(source)) await add(source, 'user-dependency'); else checks.push({ file: source, sha256: null });
      }
    }
    const guard = async ({ afterIsolation = false, published = [] } = {}) => {
      for (const identity of profile.identities) if (await digest(identity.file) !== identity.sha256)
        fail('PLAN_CHANGED', '预览后原 ReShade 配置改变，请重新核对。');
      const current = fs.existsSync(profile.addonDir) ? await fsp.readdir(profile.addonDir, { withFileTypes: true }) : [];
      const expectedInventory = afterIsolation ? inventory.filter(item => !isolated.some(row =>
        key(path.dirname(row.path)) === key(profile.addonDir) && item === row.name + ':file' && !fs.existsSync(row.path))) : inventory;
      for (const row of published) if (row.after && key(path.dirname(row.file)) === key(profile.addonDir) && searched({ name: path.basename(row.file) }) &&
        !expectedInventory.includes(path.basename(row.file) + ':file')) expectedInventory.push(path.basename(row.file) + ':file');
      expectedInventory.sort();
      if (JSON.stringify(current.filter(searched).map(row => `${row.name}:${row.isFile() ? 'file' : 'other'}`).sort()) !== JSON.stringify(expectedInventory))
        fail('PLAN_CHANGED', '预览后原插件目录内容改变，请重新核对。');
      for (const check of checks) if (await digest(check.file) !== check.sha256) fail('PLAN_CHANGED', '预览后原插件文件改变。', { file: check.file });
      for (const row of snapshot.files) {
        const actual = await digest(row.path);
        const changed = published.find(value => key(value.file) === key(row.path));
        if (actual !== (changed ? changed.after : row.sha256) && !(afterIsolation && isolatedPaths.has(key(row.path)) && actual === null))
          fail('PLAN_CHANGED', '预览后插件加载清单的文件发生变化。', { file: row.path });
      }
    };
    await guard();
    return { rows, directNames, guard, snapshot, compatibility, isolated, binding };
  }
  async function directPlan(t, game, next, operations, extras = {}) {
    if (operations.length > 256) fail('LAYOUT', '外置变更范围过大。');
    for (const row of operations) {
      if (!allowed(t, row.file, row.role)) fail('TARGET', '外置预览含未知目标。');
      if (row.file.length > 259) fail('PATH_LENGTH', '外置路径过长。');
      noLinksSync(row.file); await noLinks(row.file);
    }
    const planId = crypto.randomUUID();
    plans.set(planId, { planId, game, target: t, operation: next.generation, operations, next,
      ...extras, exeHash: await digest(t.exe), expires: Date.now() + 5 * 60 * 1000 });
    const desired = { loaderDir: t.dir, baseDir: next.mode === 'external' ? t.runtimeDir : next.sourceLayout?.baseDir || t.dir,
      addonDir: next.mode === 'external' ? t.runtimeDir : next.sourceLayout?.addonDir || t.dir,
      activeConfigPath: next.mode === 'external' ? path.join(t.runtimeDir, 'ReShade.ini') : next.sourceLayout?.activeConfigPath || path.join(t.dir, 'ReShade.ini') };
    return { planId, gameId: game.id, fromMode: extras.fromMode || 'local', toMode: next.mode, mode: next.mode,
      api: next.api, version: next.payloadVersion, loadingMode: next.loadingMode, origin: next.origin,
      requiresFgRestore: extras.requiresFgRestore === true, requiresConfirmation: true,
      requiresAntiCheat: Boolean(guards.antiCheatPresent?.(t.gameRoot)), blockers: [], warnings: extras.warnings || [],
      compatibility: extras.compatibility || next.compatibility || null,
      configured: extras.configured || next.sourceLayout, sourceLayout: next.sourceLayout, desired,
      layout: { mode: next.mode, source: PRODUCT, runtimeDir: desired.baseDir, addonDir: desired.addonDir, addonDirectory: desired.addonDir,
        activeConfigPath: desired.activeConfigPath, configured: desired, sourceLayout: next.sourceLayout, desired,
        projectedConfig: (() => { const row = operations.find(value => key(value.file) === key(desired.activeConfigPath));
          return row?.bytes ? { sha256: row.after, text: row.bytes.toString('utf8') } : null; })(),
        projectedFiles: operations.filter(row => row.role !== 'receipt').map(row => ({ path: row.file, sha256: row.after })),
        knownComponents: profileKnownComponents(t, next),
        hoyoProfile: next.hoyoProfile || null, profileGeneration: next.profileGeneration || null,
        loadingMode: next.loadingMode, loaderPath: next.loadingMode === 'helper' ? path.join(t.runtimeDir, 'ReShade64.dll') : null,
        proxyPaths: next.proxy && next.loadingMode !== 'helper' ? [path.join(t.dir, next.proxy.name)] : [], verified: true, blockers: [] },
      retainedAddons: next.files.filter(row => row.role === 'user-addon').map(row => ({ name: row.name, origin: row.originPath, searched: true })),
      inactiveAddons: extras.inactiveAddons || [],
      changes: operations.map(row => ({ path: row.file, name: path.basename(row.file), role: row.role, beforeSha256: row.before, afterSha256: row.after,
        action: row.before === row.after ? 'keep' : row.after === null ? 'remove' : row.before === null ? 'create' : 'replace' })), runtimeVerified: false };
  }
  async function preserveInactiveProfile(t, profile) {
    const saved = record(t);
    if (!saved || saved.mode !== 'local' || inside(t.runtimeDir, profile.baseDir) || inside(t.runtimeDir, profile.addonDir) ||
        profile.directLoads.some(row => inside(t.runtimeDir, row.path)))
      fail('PROFILE_EXISTS', '旧外置目录没有完整停用记录，或当前配置仍在使用它，请先核对。');
    const history = readJson(path.join(t.ownerRoot, 'history', saved.generation, 'operation.json'));
    if (!history || history.product !== PRODUCT || history.id !== t.id || history.operation !== saved.generation ||
        key(history.exe || '.') !== key(t.exe) || key(history.gameRoot || '.') !== key(t.gameRoot) ||
        (history.profileId || null) !== (t.profileId || null) || !Array.isArray(history.files) ||
        !history.files.some(row => row.role === 'receipt' && key(row.file) === key(t.receipt) && row.after === hash(jsonBytes(saved))))
      fail('PROFILE_EXISTS', '旧停用收据无法由原事务映射核对，已保留旧目录。');
    const expected = new Map();
    for (const row of saved.files) {
      const file = path.join(t.runtimeDir, row.name), last = history.files.find(item => key(item.file) === key(file));
      expected.set(row.name.toLowerCase(), { file, sha256: last?.after === null ? null : row.sha256 });
    }
    const profileIni = path.join(t.runtimeDir, 'ReShade.ini'), iniRow = history.files.find(row => key(row.file) === key(profileIni));
    let iniHash, beta1IniHash;
    if (iniRow) iniHash = iniRow.after;
    else {
      // Older local restorations retained the profile INI rather than touching
      // it. Reconstruct its expected bytes from the committed local INI copy.
      const restored = history.files.find(row => row.role === 'reshade-config' && key(row.file) === key(path.join(t.dir, 'ReShade.ini')));
      if (!restored) fail('PROFILE_EXISTS', '旧配置没有可核对的恢复快照。');
      let text = '';
      if (restored.after !== null) {
        const file = historyFile(t, saved.generation, restored.prepared);
        if (await digest(file) !== restored.after) fail('BACKUP_CHANGED', '旧配置恢复快照已变化。');
        text = await fsp.readFile(file, 'utf8');
      }
      iniHash = hash(Buffer.from(externalConfig(text, t.dir, options.environment || process.env)));
      beta1IniHash = hash(Buffer.from(externalConfig(text, t.dir, options.environment || process.env, { pathVersion: 'beta1' })));
    }
    expected.set('reshade.ini', { file: profileIni, sha256: iniHash, beta1Sha256: beta1IniHash });
    for (const row of expected.values()) {
      const actual = await digest(row.file);
      if (actual !== row.sha256 && actual !== row.beta1Sha256)
        fail('PROFILE_EXISTS', '旧停用运行文件身份发生变化，未接管或移动。', { file: row.file });
    }
    const logs = new Set(['nr-before-sr.log', 'nr-before-sr.previous.log', 'reshade.log']);
    async function emptyShaderTree(directory, budget = { remaining: 128 }, depth = 0) {
      if (depth > 8 || --budget.remaining < 0) return false;
      noLinksSync(directory);
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name); noLinksSync(child);
        if (!entry.isDirectory() || !await emptyShaderTree(child, budget, depth + 1)) return false;
      }
      return true;
    }
    if (saved.uninstallMode === 'rescue-clean') {
      const proof = history.files.find(row => row.role === 'receipt' && key(row.file) === key(t.receipt));
      if (!proof || proof.after !== await digest(t.receipt)) fail('PROFILE_EXISTS', '环境清理记录与归档不一致，未复用旧目录。');
      // Explicit rescue detached this entire profile. Unknown files remain in
      // the inactive directory; the next install gets a separate generation.
    } else for (const entry of await fsp.readdir(t.runtimeDir, { withFileTypes: true })) {
      const file = path.join(t.runtimeDir, entry.name); noLinksSync(file);
      if (entry.name === '_DLSS5_Backup' && entry.isDirectory()) continue;
      // Feeder restores its owned shader files but deliberately leaves empty
      // parent directories. They stay in the inactive profile; the next
      // installation uses a new generation and never adopts their contents.
      if (entry.name.toLowerCase() === 'reshade-shaders' && entry.isDirectory() && await emptyShaderTree(file)) continue;
      if (entry.isFile() && (expected.has(entry.name.toLowerCase()) || logs.has(entry.name.toLowerCase()))) continue;
      fail('PROFILE_EXISTS', '旧外置目录含未归属的额外文件，已保留现状。', { file });
    }
    const backup = path.join(t.runtimeDir, '_DLSS5_Backup');
    if (['pending-switch.json', 'xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json'].some(name => fs.existsSync(path.join(backup, name))))
      fail('OTHER_RECOVERY', '旧外置目录仍有活动组件或未完成记录，请先恢复对应组件。');
    return { ...t, profileId: saved.generation, runtimeDir: path.join(t.ownerRoot, 'active-' + saved.generation) };
  }
  async function previewInitial(t, game, request) {
    await require('./installation-adoption').assertAdoption(request.adoption);
    const hoyo = request.deploymentBackend === 'hoyoshade';
    if (hoyo && (!validHoYoProfile(request.hoyoProfile, t.exe) || request.loadingMode !== 'helper')) fail('HOYO_PROFILE', '米哈游首装需要固定正式客户端与启动器绑定。');
    if (!hoyo && request.loadingMode && request.loadingMode !== 'proxy') fail('INITIAL_LOADING_MODE', '首次外置部署请先使用代理加载，再按独立预览切换助手加载。');
    const profile = inspectProfile(t.dir, options.environment || process.env);
    if (!profile.ok) fail('SOURCE_LAYOUT', profile.blockers.map(row => row.message).join('；'));
    const api = request.api || classifyApi(game.scan?.chosen || game.chosen), payload = request.payload;
    if (!['dx11', 'dx12'].includes(api)) fail('API', '首次外置部署需要明确的 DX11 或 DX12 路线。');
    if (fs.existsSync(t.runtimeDir) && (await fsp.readdir(t.runtimeDir)).length) {
      // Derive the next profile from a committed removal, so separately
      // compiled previews refer to the same paths. The old history stays put.
      t = await preserveInactiveProfile(t, profile);
    }
    const operation = crypto.randomUUID(), operations = [], rows = [], kinds = hoyo && request.inputRoute === 'feeder' ? ['reshade'] :
      ['addon', 'bridge', 'runtime', 'config', 'reshade', ...(api === 'dx11' ? ['carrier'] : [])];
    for (const kind of kinds) {
      const spec = payload?.[kind];
      if (!spec?.file || !HASH.test(spec.actual || '') || await digest(spec.file) !== spec.actual) fail('PACKAGE', '首次外置部署缺少完整且可验证的配套。', { kind });
      if (kind !== 'config' && typeof pe.getBitness === 'function' && pe.getBitness(spec.file) !== 64) fail('ARCHITECTURE', '外置配套必须为 x64。', { kind });
      if (kind !== 'reshade') rows.push({ name: INSTALLED_NAMES[kind], kind, role: 'managed', mutable: kind === 'config',
        sha256: spec.actual, originHash: spec.actual, localOwned: false, originAbsent: true, source: spec.file, architecture: kind === 'config' ? null : 64 });
      else if (hoyo) {
        if (spec.actual !== HOYO_RECIPE.loaderSha256) fail('HOYO_LOADER', '米哈游需要固定 ReShade 6.8 配套。');
        rows.push({ name: 'ReShade64.dll', kind: 'loader', role: 'profile-loader', mutable: false,
          sha256: spec.actual, originHash: spec.actual, localOwned: false, originAbsent: true, source: spec.file, architecture: 64 });
      }
    }
    if (!(hoyo && request.inputRoute === 'feeder')) for (const spec of companionPolicy.validateRows(payload?.companions, payload?.version)) {
      if (await digest(spec.file) !== spec.actual || /\.dll$/i.test(spec.name) && typeof pe.getBitness === 'function' && pe.getBitness(spec.file) !== 64)
        fail('PACKAGE', 'Core 附属资源来源或位数无效。');
      rows.push({ name: spec.name, kind: 'companion', role: 'managed', mutable: false, sha256: spec.actual,
        originHash: spec.actual, localOwned: false, originAbsent: true, source: spec.file, architecture: /\.dll$/i.test(spec.name) ? 64 : null });
    }
    const marker = file => { const bytes = fs.readFileSync(file); return bytes.includes(Buffer.from('Searching for add-ons')) || bytes.includes(Buffer.from('Searching for add-ons', 'utf16le')); };
    if (!marker(payload.reshade.file)) fail('PACKAGE', '首次外置部署需要支持 Add-on 的 ReShade。');
    const proxies = [];
    for (const name of hoyo ? HOYO_PROXIES : ['dxgi.dll', 'd3d12.dll']) {
      const file = path.join(t.dir, name), actual = await digest(file); if (!actual) continue;
      const replacement = request.adoption?.replaceProxy;
      const authorized = replacement && key(replacement.path) === key(file) && replacement.sha256 === actual;
      if ((!marker(file) && !authorized) || typeof pe.getBitness === 'function' && pe.getBitness(file) !== 64)
        fail('PROXY_CONFLICT', '游戏目录含无法确认的代理，未替换。', { file });
      proxies.push({ name, actual });
    }
    if (!hoyo && proxies.length > 1) fail('PROXY_CONFLICT', '游戏目录存在多个加载器，未猜测当前入口。');
    const source = await sourceAddons(profile, { game, keep: request.addonKeep || request.keepAddons || [],
      knownComponents: [...Object.entries(payload).filter(([_kind, value]) => value?.actual && value.file).map(([kind, value]) => ({ sha256: value.actual, role: kind })), ...(request.knownComponents || [])] });
    t = { ...t, sourceBinding: source.binding }; rows.push(...source.rows);
    const personalConfig = path.join(profile.addonDir, INSTALLED_NAMES.config);
    let personalConfigHash = null;
    if (rows.some(row => row.kind === 'config') && fs.existsSync(personalConfig)) {
      const stat = await fsp.stat(personalConfig);
      if (!stat.isFile() || stat.size > 1024 * 1024) fail('SOURCE_LAYOUT', '原 NR 配置不是可检查的文件。');
      personalConfigHash = await digest(personalConfig);
      Object.assign(rows.find(row => row.kind === 'config'), { source: personalConfig, sha256: personalConfigHash,
        originHash: personalConfigHash, originPath: personalConfig, originAbsent: false });
    }
    let isolationStarted = false;
    const sourceGuard = async () => {
      await source.guard({ afterIsolation: isolationStarted });
      if (rows.some(row => row.kind === 'config') && await digest(personalConfig) !== personalConfigHash) fail('PLAN_CHANGED', '原 NR 配置在预览后改变，未覆盖。');
    };
    await sourceGuard();
    if (fs.existsSync(t.runtimeDir) && (await fsp.readdir(t.runtimeDir)).length) fail('PROFILE_EXISTS', '目标外置目录已有未接管文件，请先核对旧记录。');
    async function change(file, role, source, bytes, after) {
      const before = await digest(file), value = bytes === undefined ? undefined : Buffer.from(bytes);
      operations.push({ file, role, source, ...(value === undefined ? {} : { bytes: value }), before, after: value === undefined ? after : hash(value) });
    }
    for (const row of rows) await change(path.join(t.runtimeDir, row.name), row.role, row.source, undefined, row.sha256);
    const activeConfig = ensureDefaultReShadeHotkey(externalConfig(profile.config, profile.baseDir, options.environment || process.env, { directLoads: source.directNames }));
    await change(path.join(t.runtimeDir, 'ReShade.ini'), 'reshade-config', null, activeConfig);
    const isolatedAddons = [];
    for (const row of source.isolated) {
      const index = operations.length;
      await change(row.path, 'source-addon', null, undefined, null);
      isolatedAddons.push({ path: row.path, sha256: row.sha256, operation, snapshot: `before/${index}.bin`, reason: row.reason,
        action: row.action, mandatory: row.mandatory, originalOwned: row.owned });
    }
    const entry = request.proxyEntry || 'auto';
    if (!hoyo && entry === 'd3d12' && api !== 'dx12') fail('PROXY_ENTRY', 'D3D12 加载入口只适用于已确认的 DX12 路线。');
    const proxy = hoyo ? null : { name: entry === 'auto' ? proxies[0]?.name || 'dxgi.dll' : entry + '.dll', sha256: payload.reshade.actual };
    let retiredProxy = null;
    if (!hoyo && proxies[0] && proxies[0].name !== proxy.name) {
      const index = operations.length;
      await change(path.join(t.dir, proxies[0].name), 'game-proxy', null, undefined, null);
      retiredProxy = { name: proxies[0].name, sha256: proxies[0].actual, snapshot: `before/${index}.bin` };
      if (operations[index].before !== retiredProxy.sha256) fail('PLAN_CHANGED', '原加载器在检查后改变。');
    }
    const proxyBefore = !hoyo && proxies[0]?.name === proxy.name ? proxies[0].actual : null;
    const proxyIndex = operations.length;
    const initialProxies = [];
    if (hoyo) for (const row of proxies) {
      const index = operations.length; await change(path.join(t.dir, row.name), 'game-proxy', null, undefined, null);
      if (operations[index].before !== row.actual) fail('PLAN_CHANGED', '检查期间原加载器改变。');
      initialProxies.push({ name: row.name, sha256: row.actual, snapshot: `before/${index}.bin` });
    } else {
      await change(path.join(t.dir, proxy.name), 'game-proxy', payload.reshade.file, undefined, proxy.sha256);
      if (operations[proxyIndex].before !== proxyBefore) fail('PLAN_CHANGED', '检查期间原加载器改变。');
    }
    const rootConfig = loaderConfig(profile.rootConfig, t.runtimeDir);
    await change(profile.rootConfigPath, 'reshade-config', null, rootConfig);
    const manifest = newManifest(t.gameRoot, t.exe, api); manifest.payloadVersion = payload.version; manifest.deploymentApi = api; manifest.metadataOnly = true;
    manifest.files = rows.filter(row => row.role === 'managed').map(row => ({ rel: path.relative(t.gameRoot, path.join(t.dir, row.name)), kind: row.kind,
      installedSha256: row.sha256, original: { existed: false } }));
    const next = { version: 1, product: PRODUCT, id: t.id, exe: t.exe, gameRoot: t.gameRoot, runtimeDir: t.runtimeDir,
      profileId: t.profileId,
      generation: operation, mode: 'external', loadingMode: hoyo ? 'helper' : 'proxy', proxy, api, payloadVersion: payload.version || HOYO_RECIPE.id, updatedAt: new Date().toISOString(),
      origin: hoyo ? 'direct_hoyo' : 'direct', initialOperation: operation,
      ...(hoyo ? { hoyoProfile: request.hoyoProfile, initialProxies,
        profileGeneration: hash(Buffer.from(JSON.stringify({ owner: t.id, profileId: t.profileId || null, binding: request.hoyoProfile.bindingId, source: source.snapshot.fingerprint }))) } : {}),
      sourceBinding: source.binding, isolatedAddons, compatibility: source.compatibility,
      panelDefaultAdded: !hasKeyOverlay(profile.config),
      panelDefaultKey: DEFAULT_RESHADE_KEY,
      ...(!hoyo ? { initialProxy: { name: proxy.name, before: proxyBefore, after: proxy.sha256, owned: proxyBefore !== proxy.sha256, snapshot: `before/${proxyIndex}.bin` } } : {}),
      ...(retiredProxy ? { retiredProxy } : {}),
      localManifest: manifest, currentManifest: structuredClone(manifest), sourceLayout: profile.configured,
      originalReShadeConfig: profile.rootConfig, originalConfigExisted: profile.identities.find(row => row.file === profile.rootConfigPath)?.sha256 !== null, loaderConfigHash: hash(Buffer.from(rootConfig)),
      baseline: { installed: false, version: null, ordinarySnapshot: operation, ordinarySnapshotDirectory: path.join(t.ownerRoot, 'history', operation) },
      previous: { mode: 'local', version: null, generation: null }, files: rows.map(({ source, ...row }) => row) };
    await change(t.receipt, 'receipt', null, jsonBytes(next));
    const activeOrigins = new Set(source.rows.map(row => key(row.originPath))), inactiveAddons =
      (await fsp.readdir(t.dir, { withFileTypes: true })).filter(row => row.isFile() && ADDON.test(row.name) && !activeOrigins.has(key(path.join(t.dir, row.name))))
        .map(row => ({ name: row.name, path: path.join(t.dir, row.name), active: false, action: 'preserve' }));
    return directPlan(t, game, next, operations, { sourceGuard, beforeSourceIsolation: () => { isolationStarted = true; },
      compatibility: source.compatibility, warnings: profile.warnings, inactiveAddons, configured: profile.configured });
  }
  async function previewLocalDirect(t, game, saved, request, internal) {
    const resources = request.payload ? companionPolicy.validateRows(request.payload.companions, request.payload.version) : [];
    if (key(saved.sourceLayout?.baseDir || '.') !== key(t.dir) || key(saved.sourceLayout?.addonDir || '.') !== key(t.dir))
      fail('DIRECT_LOCAL_UNSUPPORTED', '原配置使用自定义插件目录，普通目录路线尚不能接入。可继续外置部署，或使用独立卸载恢复原配置。');
    getLayout(game);
    const requiresFgRestore = ['xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json'].some(name => fs.existsSync(path.join(t.runtimeDir, '_DLSS5_Backup', name)));
    if (requiresFgRestore && internal.plannedFgRestore !== true) fail('FG_RESTORE_FIRST', '请先恢复外置补帧组件。');
    const operation = crypto.randomUUID(), operations = [], manifest = newManifest(t.gameRoot, t.exe, saved.api);
    manifest.installId = saved.generation;
    manifest.payloadVersion = request.payload?.version || saved.payloadVersion; manifest.deploymentApi = saved.api;
    async function change(file, role, source, bytes, after) {
      const before = await digest(file), value = bytes === undefined ? undefined : Buffer.from(bytes);
      if (role === 'original-backup' && before !== null) fail('BACKUP_CONFLICT', '新普通安装的备份位置已有文件，未覆盖。', { file });
      operations.push({ file, role, source, ...(value === undefined ? {} : { bytes: value }), before, after: value === undefined ? after : hash(value) });
    }
    for (const row of saved.files) {
      const source = path.join(t.runtimeDir, row.name), actual = await digest(source);
      if (!actual || !row.mutable && actual !== row.sha256) fail('FILE_CHANGED', '外置组件已变动，未迁移到普通目录。', { file: source });
      if (row.role === 'profile-loader') continue;
      const destination = path.join(t.dir, row.name), before = await digest(destination);
      if (row.role === 'managed') {
        // Existing same-byte DLLs remain unowned after a direct installation.
        // A local conversion must not acquire them merely by matching a hash.
        if (before && !row.mutable) fail('DIRECT_LOCAL_CONFLICT', '普通目录已有未归本管理器所有的配套文件，请继续外置或核对原文件。', { file: destination });
        const entry = { rel: path.relative(t.gameRoot, destination), kind: row.kind, installedSha256: actual, original: { existed: before !== null } };
        if (before) {
          const backup = backupPath(t.gameRoot, manifest.installId, entry.rel);
          entry.original = { existed: true, sha256: before, backupRel: path.relative(t.gameRoot, backup) };
          await change(backup, 'original-backup', destination, undefined, before);
        }
        const replacement = row.kind === 'companion' ? request.payload?.companions?.find(item => item.name === row.name) : request.payload?.[row.kind];
        if (replacement && !row.mutable) {
          if (await digest(replacement.file) !== replacement.actual || (row.kind !== 'companion' || /\.dll$/i.test(row.name)) && typeof pe.getBitness === 'function' && pe.getBitness(replacement.file) !== 64) fail('PACKAGE', '普通目录配套来源改变。');
          entry.installedSha256 = replacement.actual;
        }
        await change(destination, row.role, replacement && !row.mutable ? replacement.file : source, undefined, entry.installedSha256);
        manifest.files.push(entry);
      } else if (row.originAbsent || row.mutable && actual !== row.originHash) {
        if (before !== (row.originAbsent ? null : row.originHash)) fail('FILE_CHANGED', '原用户插件或设置已变化，未覆盖。', { file: destination });
        await change(destination, row.role, source, undefined, actual);
      }
    }
    for (const resource of resources.filter(item => !saved.files.some(row => row.kind === 'companion' && row.name === item.name))) {
      const destination = path.join(t.dir, resource.name);
      if (await digest(destination) !== null) fail('DIRECT_LOCAL_CONFLICT', '普通目录已有未受管资源，未覆盖。', { file: destination });
      if (await digest(resource.file) !== resource.actual || /\.dll$/i.test(resource.name) && typeof pe.getBitness === 'function' && pe.getBitness(resource.file) !== 64)
        fail('PACKAGE', '普通目录 Core 附属资源来源改变。');
      await change(destination, 'managed', resource.file, undefined, resource.actual);
      manifest.files.push({ rel: path.relative(t.gameRoot, destination), kind: 'companion', installedSha256: resource.actual, original: { existed: false } });
    }
    const initial = saved.retiredProxy ? { name: saved.retiredProxy.name, before: saved.retiredProxy.sha256, snapshot: saved.retiredProxy.snapshot, owned: true } : saved.initialProxy;
    const proxyFile = path.join(t.dir, initial.name), activeProxy = path.join(t.dir, saved.proxy.name);
    if (saved.loadingMode === 'helper' || initial.name !== saved.proxy.name) {
      if (await digest(proxyFile) !== null) fail('FILE_CHANGED', '原加载入口出现其他文件，未迁移到普通目录。');
      await change(proxyFile, 'game-proxy', saved.loadingMode === 'helper' ? path.join(t.runtimeDir, 'ReShade64.dll') : activeProxy, undefined, saved.proxy.sha256);
      if (saved.loadingMode !== 'helper') await change(activeProxy, 'game-proxy', null, undefined, null);
    }
    if (initial.owned) {
      const entry = { rel: path.relative(t.gameRoot, proxyFile), kind: 'reshade', installedSha256: saved.proxy.sha256, original: { existed: initial.before !== null } };
      if (initial.before) {
        const source = historyFile(t, saved.initialOperation, initial.snapshot), backup = backupPath(t.gameRoot, manifest.installId, entry.rel);
        if (await digest(source) !== initial.before) fail('BACKUP_CHANGED', '原加载器快照已变化。');
        entry.original = { existed: true, sha256: initial.before, backupRel: path.relative(t.gameRoot, backup) };
        await change(backup, 'original-backup', source, undefined, initial.before);
      }
      manifest.files.push(entry); manifest.reshadeRoute = path.basename(proxyFile, '.dll');
    }
    const currentConfig = await fsp.readFile(path.join(t.runtimeDir, 'ReShade.ini'), 'utf8');
    const restoredConfig = localConfig(currentConfig, saved.originalReShadeConfig, t.dir, options.environment || process.env,
      { panelDefaultAdded: saved.panelDefaultAdded === true, panelDefaultKey: saved.panelDefaultKey ?? PREVIOUS_RESHADE_DEFAULT_KEY });
    await change(path.join(t.dir, 'ReShade.ini'), 'reshade-config', null, restoredConfig || saved.originalConfigExisted ? restoredConfig : undefined, null);
    await change(manifestPath(t.gameRoot), 'manifest', null, jsonBytes(manifest));
    for (const row of saved.files) await change(path.join(t.runtimeDir, row.name), row.role, null, undefined, null);
    await change(path.join(t.runtimeDir, 'ReShade.ini'), 'reshade-config', null, undefined, null);
    const next = { ...saved, mode: 'local', loadingMode: 'proxy', proxy: { ...saved.proxy, name: initial.name }, generation: operation, payloadVersion: manifest.payloadVersion,
      localManifest: manifest, currentManifest: manifest, loaderConfigHash: hash(Buffer.from(restoredConfig)),
      previous: { mode: 'external', version: saved.payloadVersion, generation: saved.generation, snapshot: operation,
        snapshotDirectory: path.join(t.ownerRoot, 'history', operation) } };
    await change(t.receipt, 'receipt', null, jsonBytes(next));
    const result = await directPlan(t, game, next, operations, { fromMode: 'external', requiresFgRestore });
    return { ...result, projectedManifest: manifest };
  }
  async function preview(game, request = {}, internal = {}) {
    const t = target(game); if (internal.readOnlyWhileRunning !== true) await closed(t); await assertReady(game);
    if (!['local', 'external'].includes(request.mode) || request.loadingMode !== undefined && !['proxy', 'helper'].includes(request.loadingMode) ||
        request.proxyEntry !== undefined && !['auto', 'dxgi', 'd3d12'].includes(request.proxyEntry))
      fail('INPUT', '请选择普通或外置部署及加载方式。');
    const saved = record(t), external = saved?.mode === 'external';
    const hoyo = request.deploymentBackend === 'hoyoshade';
    if (hoyo && (!validHoYoProfile(request.hoyoProfile, t.exe) || request.loadingMode !== 'helper' || request.payload?.reshade?.actual !== HOYO_RECIPE.loaderSha256))
      fail('HOYO_PROFILE', '米哈游专用部署需要已绑定的正式客户端及固定加载器。');
    if (external && saved.hoyoProfile && request.inputRoute && request.inputRoute !== saved.hoyoProfile.inputRoute)
      fail('INPUT_RESTORE_FIRST', '请先恢复当前输入配套，再切换米哈游输入路线。');
    let manifest = readManifest(t.gameRoot);
    if (!manifest && !external && request.mode === 'external') return previewInitial(t, game, request);
    if (external && ['direct', 'direct_hoyo'].includes(saved.origin)) {
      if (saved.origin === 'direct_hoyo' && request.mode === 'local') fail('HOYO_RESTORE_FIRST', '米哈游专用部署需先恢复原配置，再切换普通加载方式。');
      if (request.mode === 'local') return previewLocalDirect(t, game, saved, request, internal);
      manifest = saved.currentManifest || saved.localManifest;
    }
    if (!manifest) fail('INSTALL_FIRST', '请先完成本管理器的普通安装，再迁移运行目录。');
    assertManifestExecutable(t.gameRoot, manifest, t.exe);
    const api = request.api || saved?.api || manifest.deploymentApi || classifyApi(game.scan?.chosen || game.chosen);
    if (!['dx11', 'dx12'].includes(api)) fail('API', '本外置部署仅支持已有 DLSS 的 DX11 / DX12 路线。');
    const installedApi = external ? saved.api : manifest.deploymentApi || classifyApi(game.scan?.chosen || game.chosen);
    if (installedApi !== api) fail('API_CHANGE', '请先恢复普通目录，再应用新的 API 配套。');
    let requiresFgRestore = false;
    if (external !== (request.mode === 'external')) {
      const fromRoot = external ? t.runtimeDir : t.gameRoot;
      for (const name of ['xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json']) {
        if (fs.existsSync(path.join(fromRoot, '_DLSS5_Backup', name))) {
          requiresFgRestore = true;
          if (internal.plannedFgRestore !== true) fail('FG_RESTORE_FIRST', '切换运行目录前请先恢复当前补帧组件，再在新目录重新准备。');
        }
      }
    }
    const loadingMode = request.mode === 'external' ? request.loadingMode || saved?.loadingMode || 'proxy' : 'proxy';
    if (loadingMode === 'proxy' && request.proxyEntry === 'd3d12' && api !== 'dx12') fail('PROXY_ENTRY', 'D3D12 加载入口只适用于已确认的 DX12 路线。');
    const operation = crypto.randomUUID(), operations = [], rows = external ? saved.files.map(row => ({ ...row, source: path.join(t.runtimeDir, row.name) })) : await collectLocal(t, manifest);
    if (external) {
      getLayout(game);
      for (const row of rows) {
        const actual = await digest(row.source);
        const replacement = row.kind === 'companion' ? request.payload?.companions?.find(item => item.name === row.name) : request.payload?.[row.kind];
        if (!actual && !replacement || actual && !row.mutable && actual !== row.sha256)
          fail('FILE_CHANGED', '外置组件缺失或被修改，未覆盖。', { file: row.source });
        row.sha256 = actual;
      }
      // Newly installed independent Add-ons are copied back as user-owned
      // files, rather than discarded merely because the NR receipt predates them.
      const known = new Set(rows.map(row => row.name.toLowerCase()));
      for (const entry of await fsp.readdir(t.runtimeDir, { withFileTypes: true })) {
        if (known.has(entry.name.toLowerCase()) || entry.name.toLowerCase() === 'reshade.ini' || !ADDON.test(entry.name) && !MUTABLE.test(entry.name)) continue;
        if (!entry.isFile()) fail('LAYOUT', '外置目录含无法迁移的组件。');
        const role = ADDON.test(entry.name) ? 'user-addon' : 'user-sidecar', source = path.join(t.runtimeDir, entry.name);
        const actual = await digest(source), origin = await digest(path.join(t.dir, entry.name));
        const separateOwner = (request.knownComponents || []).filter(row => row.path && row.owned === true && row.owner && row.owner !== PRODUCT && key(row.path) === key(source));
        if (separateOwner.length) {
          if (separateOwner.some(row => row.sha256 !== actual)) fail('FILE_CHANGED', '独立输入或补帧组件与其所有者记录不一致。', { file: source });
          continue;
        }
        if (saved.hoyoProfile?.inputRoute === 'feeder' && MUTABLE.test(entry.name)) continue;
        if (origin) fail('CONFLICT', '新外置组件在游戏目录已有同名文件，未覆盖。', { file: entry.name });
        rows.push({ name: entry.name, role, kind: role, mutable: MUTABLE.test(entry.name), sha256: actual,
          originHash: actual, originAbsent: true, localOwned: false, source });
      }
    } else requireAddonLayout(t.dir);
    const originalConfig = external ? saved.originalReShadeConfig : await fsp.readFile(path.join(t.dir, 'ReShade.ini'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error;
    });
    const currentConfig = external ? await fsp.readFile(path.join(t.runtimeDir, 'ReShade.ini'), 'utf8') : originalConfig;
    const currentManifest = external ? structuredClone(saved.currentManifest || saved.localManifest) : structuredClone(manifest);
    let proxy = saved?.proxy || null;
    if (!proxy) {
      const candidates = [];
      for (const name of ['dxgi.dll', 'd3d12.dll']) {
        const file = path.join(t.dir, name), actual = await digest(file); if (!actual) continue;
        const bytes = await fsp.readFile(file);
        if (!bytes.includes(Buffer.from('Searching for add-ons')) && !bytes.includes(Buffer.from('Searching for add-ons', 'utf16le')))
          fail('PROXY_CONFLICT', '游戏目录含无法确认的加载入口，未覆盖。', { file });
        candidates.push({ name, sha256: actual });
      }
      if (candidates.length > 1) fail('PROXY_CONFLICT', '游戏目录存在多个加载入口，未猜测活动入口。');
      proxy = candidates[0] || null;
    }
    const proxyBaseline = saved?.proxyBaseline || proxy;
    if (loadingMode === 'helper' && (!external || saved.loadingMode !== 'helper')) {
      const candidates = [];
      for (const name of ['dxgi.dll', 'd3d12.dll']) {
        const file = path.join(t.dir, name), actual = await digest(file);
        if (!actual) continue;
        let addonLoader = false;
        try {
          const bytes = await fsp.readFile(file);
          addonLoader = bytes.includes(Buffer.from('Searching for add-ons')) || bytes.includes(Buffer.from('Searching for add-ons', 'utf16le'));
        } catch {}
        if (!addonLoader) fail('HELPER_PROXY_CONFLICT', '游戏目录含无法确认的代理 DLL，未切换助手加载。', { file });
        candidates.push({ name, file, sha256: actual });
      }
      if (candidates.length !== 1) fail('HELPER_LOADER', '助手加载需要唯一、已确认支持 Add-on 的 ReShade 加载器。');
      proxy = { name: candidates[0].name, sha256: candidates[0].sha256 };
      const existingLoader = rows.find(row => row.role === 'profile-loader');
      const loader = { name: 'ReShade64.dll', role: 'profile-loader', kind: 'loader', mutable: false,
        sha256: proxy.sha256, originHash: proxy.sha256, localOwned: false, source: candidates[0].file };
      if (existingLoader) Object.assign(existingLoader, loader); else rows.push(loader);
    }
    let payloadVersion = external ? saved.payloadVersion : manifest.payloadVersion;
    if (request.payload) {
      const payload = request.payload;
      if (api === 'dx11' && saved?.hoyoProfile?.inputRoute !== 'feeder' && !payload.carrier) fail('PACKAGE', 'DX11 外置部署需要完整配套桥接器。');
      for (const kind of saved?.hoyoProfile?.inputRoute === 'feeder' ? [] : ['addon', 'bridge', 'runtime', ...(api === 'dx11' ? ['carrier'] : [])]) {
        const spec = payload[kind];
        if (!spec?.file || !HASH.test(spec.actual || '') || await digest(spec.file) !== spec.actual) fail('PACKAGE', '配套来源或摘要无效。', { kind });
        if (typeof pe.getBitness === 'function' && pe.getBitness(spec.file) !== 64) fail('ARCHITECTURE', '外置 Core 配套必须为 x64。', { kind });
        const row = rows.find(value => value.kind === kind);
        if (!row) fail('PACKAGE', '当前安装记录缺少必要组件，请先修复普通安装。', { kind });
        row.source = spec.file; row.sha256 = spec.actual;
        const entry = currentManifest.files.find(value => value.kind === kind);
        if (entry) entry.installedSha256 = spec.actual;
      }
      payloadVersion = payload.version || request.version || payloadVersion;
      if (saved?.hoyoProfile?.inputRoute !== 'feeder') for (const spec of companionPolicy.validateRows(payload.companions, payload.version)) {
        if (await digest(spec.file) !== spec.actual) fail('PACKAGE', 'Core 附属资源摘要无效。');
        let row = rows.find(value => value.kind === 'companion' && value.name === spec.name);
        if (row) { row.source = spec.file; row.sha256 = spec.actual; }
        else {
          row = { name: spec.name, kind: 'companion', role: 'managed', mutable: false, sha256: spec.actual,
            originHash: spec.actual, localOwned: false, originAbsent: true, source: spec.file };
          rows.push(row);
        }
        let entry = currentManifest.files.find(value => value.kind === 'companion' && value.rel === path.relative(t.gameRoot, path.join(t.dir, spec.name)));
        if (entry) entry.installedSha256 = spec.actual;
        else currentManifest.files.push({ rel: path.relative(t.gameRoot, path.join(t.dir, spec.name)), kind: 'companion',
          installedSha256: spec.actual, original: { existed: false } });
      }
      currentManifest.payloadVersion = payloadVersion;
      currentManifest.updatedAt = new Date().toISOString();
    }
    for (const row of rows.filter(row => !row.mutable)) {
      if (row.kind === 'companion' && !/\.dll$/i.test(row.name)) { row.architecture = null; continue; }
      if (typeof pe.getBitness === 'function') {
        row.architecture = pe.getBitness(row.source);
        if ((MANAGED.has(row.kind) || row.kind === 'loader') && row.architecture !== 64)
          fail('ARCHITECTURE', '当前 Core 或 ReShade 加载器不是 x64。', { file: row.name });
      }
    }
    async function change(file, role, source, bytes, after) {
      const before = await digest(file), value = bytes === undefined ? undefined : Buffer.from(bytes);
      operations.push({ file, role, source, ...(value === undefined ? {} : { bytes: value }), before,
        after: value !== undefined ? hash(value) : after });
    }
    const toExternal = request.mode === 'external', activeConfig = toExternal ? external ? currentConfig : ensureDefaultReShadeHotkey(externalConfig(originalConfig, t.dir))
      : localConfig(currentConfig, originalConfig, t.dir, options.environment || process.env,
        { panelDefaultAdded: saved?.panelDefaultAdded === true, panelDefaultKey: saved?.panelDefaultKey ?? PREVIOUS_RESHADE_DEFAULT_KEY });
    if (toExternal) {
      for (const row of rows) await change(path.join(t.runtimeDir, row.name), row.role, row.source, undefined, row.sha256);
      await change(path.join(t.runtimeDir, 'ReShade.ini'), 'reshade-config', null, activeConfig);
      if (!external) for (const row of rows.filter(value => value.localOwned)) await change(path.join(t.dir, row.name), row.role, null, undefined, null);
    } else if (external) {
      for (const row of rows.filter(value => value.role !== 'profile-loader')) {
        const destination = path.join(t.dir, row.name), current = await digest(destination);
        const allowedOrigin = row.localOwned || row.originAbsent ? null : row.originHash;
        if (current !== allowedOrigin) fail('FILE_CHANGED', '普通目录出现外部修改，未覆盖。', { file: destination });
        await change(destination, row.role, row.source, undefined, row.sha256);
      }
      await change(manifestPath(t.gameRoot), 'manifest', null, jsonBytes(currentManifest));
    }
    const requestedProxy = proxy && loadingMode === 'proxy' ?
      (!toExternal && saved?.origin !== 'direct' ? proxyBaseline?.name : request.proxyEntry && request.proxyEntry !== 'auto' ? request.proxyEntry + '.dll' : proxy.name) : null;
    if (proxy && loadingMode === 'helper' && (!external || saved.loadingMode !== 'helper'))
      await change(path.join(t.dir, proxy.name), 'game-proxy', null, undefined, null);
    else if (proxy && external && saved.loadingMode === 'helper' && loadingMode !== 'helper') {
      const destination = path.join(t.dir, requestedProxy);
      if (await digest(destination) !== null) fail('FILE_CHANGED', '游戏目录出现新的加载器，未覆盖。', { file: destination });
      await change(destination, 'game-proxy', path.join(t.runtimeDir, 'ReShade64.dll'), undefined, proxy.sha256);
      proxy = { ...proxy, name: requestedProxy };
    } else if (proxy && requestedProxy && requestedProxy !== proxy.name) {
      const source = path.join(t.dir, proxy.name), destination = path.join(t.dir, requestedProxy);
      if (await digest(source) !== proxy.sha256) fail('FILE_CHANGED', '当前加载入口已变动，未移动。', { file: source });
      if (await digest(destination) !== null) fail('PROXY_CONFLICT', '目标加载入口已有文件，未覆盖。', { file: destination });
      await change(destination, 'game-proxy', source, undefined, proxy.sha256);
      await change(source, 'game-proxy', null, undefined, null);
      proxy = { ...proxy, name: requestedProxy };
    }
    const rootConfig = toExternal ? loaderConfig(originalConfig, t.runtimeDir) : activeConfig;
    const originalConfigExisted = external ? saved.originalConfigExisted !== false : fs.existsSync(path.join(t.dir, 'ReShade.ini'));
    if (toExternal || external) {
      if (!toExternal && !originalConfigExisted && !rootConfig) await change(path.join(t.dir, 'ReShade.ini'), 'reshade-config', null, undefined, null);
      else await change(path.join(t.dir, 'ReShade.ini'), 'reshade-config', null, rootConfig);
    }
    const next = { version: 1, product: PRODUCT, id: t.id, exe: t.exe, gameRoot: t.gameRoot, runtimeDir: t.runtimeDir,
      profileId: t.profileId,
      generation: operation, mode: request.mode, loadingMode, proxy, proxyBaseline, api, payloadVersion, updatedAt: new Date().toISOString(),
      panelDefaultAdded: external ? saved.panelDefaultAdded === true : toExternal && !hasKeyOverlay(originalConfig),
      panelDefaultKey: external ? saved.panelDefaultKey ?? PREVIOUS_RESHADE_DEFAULT_KEY : DEFAULT_RESHADE_KEY,
      localManifest: saved?.mode === 'external' ? saved.localManifest : manifest, currentManifest,
      sourceLayout: saved?.mode === 'external' && saved.sourceLayout || { loaderDir: t.dir, baseDir: t.dir, addonDir: t.dir, activeConfigPath: path.join(t.dir, 'ReShade.ini') },
      originalReShadeConfig: originalConfig, originalConfigExisted, loaderConfigHash: hash(Buffer.from(rootConfig)),
      baseline: saved?.mode === 'external' ? saved.baseline : { installId: manifest.installId, version: manifest.payloadVersion,
        api: installedApi, ordinarySnapshot: operation, ordinarySnapshotDirectory: path.join(t.ownerRoot, 'history', operation),
        originalBackupDirectory: path.join(t.gameRoot, '_DLSS5_Backup', 'xiaofeng-originals', manifest.installId) },
      previous: { mode: external ? 'external' : 'local', version: saved?.payloadVersion || manifest.payloadVersion,
        generation: saved?.generation || null, snapshot: operation, snapshotDirectory: path.join(t.ownerRoot, 'history', operation) },
      files: rows.map(({ source, ...row }) => row) };
    if (external && ['direct', 'direct_hoyo'].includes(saved?.origin)) Object.assign(next, { origin: saved.origin, initialOperation: saved.initialOperation,
      initialProxy: saved.initialProxy, retiredProxy: saved.retiredProxy, sourceLayout: saved.sourceLayout, sourceBinding: saved.sourceBinding,
      isolatedAddons: saved.isolatedAddons, compatibility: saved.compatibility });
    if (hoyo || saved?.hoyoProfile && request.mode === 'external') Object.assign(next, {
      hoyoProfile: request.hoyoProfile || saved.hoyoProfile,
      profileGeneration: saved?.profileGeneration || hash(Buffer.from(JSON.stringify({ owner: t.id, binding: request.hoyoProfile.bindingId, profileId: t.profileId || null }))),
      ...(saved?.origin === 'direct_hoyo' ? { initialProxies: saved.initialProxies } : {})
    });
    await change(t.receipt, 'receipt', null, jsonBytes(next));
    if (operations.length > 256 || rows.length > 128) fail('LAYOUT', '迁移范围过大。');
    for (const file of [...operations.map(row => row.file), path.join(t.runtimeDir, 'nr-before-sr.previous.log')]) {
      if (file.length > 259) fail('PATH_LENGTH', '外置运行路径过长，请使用较短的管理器数据目录。');
      noLinksSync(file); await noLinks(file);
    }
    const planId = crypto.randomUUID();
    plans.set(planId, { planId, game, target: t, operation, operations, next, requiresFgRestore, expires: Date.now() + 5 * 60 * 1000,
      exeHash: await digest(t.exe) });
    const configured = getLayout(game).configured;
    const desired = { loaderDir: t.dir, baseDir: toExternal ? t.runtimeDir : t.dir, addonDir: toExternal ? t.runtimeDir : t.dir,
      activeConfigPath: path.join(toExternal ? t.runtimeDir : t.dir, 'ReShade.ini') };
    return { planId, gameId: game.id, fromMode: external ? 'external' : 'local', toMode: request.mode, mode: request.mode,
      api, version: payloadVersion, loadingMode, requiresFgRestore, requiresConfirmation: true, requiresAntiCheat: Boolean(guards.antiCheatPresent?.(t.gameRoot)),
      configured, sourceLayout: next.sourceLayout, desired, blockers: [], warnings: getLayout(game).warnings,
      layout: { mode: request.mode, runtimeDir: toExternal ? t.runtimeDir : t.dir, addonDir: desired.addonDir, addonDirectory: toExternal ? t.runtimeDir : t.dir,
        projectedConfig: { sha256: hash(Buffer.from(activeConfig)), text: activeConfig },
        projectedFiles: operations.filter(row => row.role !== 'receipt').map(row => ({ path: row.file, sha256: row.after })),
        knownComponents: profileKnownComponents(t, next),
        hoyoProfile: next.hoyoProfile || null, profileGeneration: next.profileGeneration || null,
        configured: desired, sourceLayout: next.sourceLayout, desired, verified: true, blockers: [],
        activeConfigPath: path.join(toExternal ? t.runtimeDir : t.dir, 'ReShade.ini'),
        loadingMode, loaderPath: loadingMode === 'helper' ? path.join(t.runtimeDir, 'ReShade64.dll') : null,
        proxyPaths: proxy ? [path.join(t.dir, proxy.name)] : [] },
      retainedAddons: rows.filter(row => row.role === 'user-addon').map(row => ({ name: row.name, origin: path.join(t.dir, row.name) })),
      changes: operations.map(row => ({ path: row.file, name: path.basename(row.file), role: row.role,
        beforeSha256: row.before, afterSha256: row.after, action: row.before === row.after ? 'keep' : row.after === null ? 'remove' : row.before === null ? 'create' : 'replace' })),
      projectedManifest: currentManifest, runtimeVerified: false };
  }
  async function apply(planId, consent = {}) {
    const plan = plans.get(planId); plans.delete(planId);
    if (!plan || plan.expires < Date.now()) fail('PLAN_EXPIRED', '部署预览已失效，请重新检查。');
    const t = plan.target;
    if (active.has(t.id)) fail('BUSY', '该游戏正在部署。');
    active.add(t.id);
    try {
      await closed(t); await assertReady(plan.game);
      if (plan.requiresFgRestore) fail('PLAN_CHANGED', '补帧恢复后需要按同一请求重新生成部署计划。');
      if (guards.antiCheatPresent?.(t.gameRoot) && consent.allowAntiCheat !== true) {
        const error = new Error('该游戏含反作弊组件，请先明确确认部署风险。');
        error.code = 'ERR_ANTI_CHEAT_CONFIRM'; throw error;
      }
      if (await digest(t.exe) !== plan.exeHash) fail('PLAN_CHANGED', '预览后游戏 EXE 已改变。');
      if (plan.sourceGuard) await plan.sourceGuard();
      await transaction(t, plan);
      return { applied: true, mode: plan.next.mode, version: plan.next.payloadVersion, api: plan.next.api,
        generation: plan.next.generation, layout: getLayout(plan.game), runtimeVerified: false };
    } finally { active.delete(t.id); }
  }
  async function recover(game) {
    const t = target(game, true); if (active.has(t.id)) fail('BUSY', '该游戏正在部署。');
    active.add(t.id); try { const wal = pending(t); return wal ? await rollback(t, wal) : { recovered: false }; }
    finally { active.delete(t.id); }
  }
  // An edited loader INI is a binding conflict, not proof of a running file
  // transaction. Rescue uses receipt/WAL paths only, never paths from that INI.
  // It has a separate preview token so ordinary apply cannot bypass consent.
  async function rescueSource(t, saved, file, expected) {
    const root = path.join(t.ownerRoot, 'history'); await noLinks(root);
    const entries = await fsp.readdir(root, { withFileTypes: true });
    if (entries.length > 512) fail('RESCUE_HISTORY_LIMIT', '恢复历史过多，请先保存反馈；仍可只移出游戏库。');
    const ids = [...new Set([saved.generation, saved.initialOperation, ...entries.filter(row => row.isDirectory() && UUID.test(row.name)).map(row => row.name)])].filter(value => UUID.test(value || ''));
    for (const id of ids) {
      const wal = readJson(path.join(root, id, 'operation.json'));
      if (wal?.product !== PRODUCT || wal.id !== t.id || wal.operation !== id || key(wal.exe || '.') !== key(t.exe) ||
          key(wal.gameRoot || '.') !== key(t.gameRoot) || !Array.isArray(wal.files) || wal.files.length > 256) continue;
      const row = wal.files.find(value => typeof value.file === 'string' && key(value.file) === key(file) && value.after === expected);
      if (row && /^after\/[0-9]+\.bin$/.test(row.prepared || '')) {
        const source = historyFile(t, id, row.prepared);
        if (await digest(source) === expected) return source;
      }
    }
    fail('RESCUE_SOURCE_MISSING', '该组件的已验证快照缺失，无法补齐；可选择备份清理受管环境后重新安装。', { file });
  }
  async function previewRescue(game, mode) {
    if (!['repair', 'clean', 'recover'].includes(mode)) fail('RESCUE_REQUEST', '请选择修复、清理或处理未完成部署。');
    const t = target(game, true); await closed(t);
    if (active.has(t.id)) fail('BUSY', '该游戏正在部署。');
    const wal = pending(t), saved = mode === 'recover' ? null : record(t);
    const operation = crypto.randomUUID(), operations = [], warnings = [];
    const receiptHash = await digest(t.receipt), pendingHash = await digest(t.pending), exeHash = await digest(t.exe);
    if (!exeHash) fail('TARGET', '游戏程序已缺失，请重新定位正式 EXE；也可以只移出游戏库并保留文件。');
    const add = async (file, role, after, source, bytes) => {
      if (!allowed(t, file, role)) fail('TARGET', '恢复计划含未知目标。');
      if (operations.some(row => key(row.file) === key(file))) return;
      const before = await digest(file);
      operations.push({ file, role, before, after, ...(source ? { source } : {}), ...(bytes !== undefined ? { bytes } : {}) });
    };
    if (mode === 'recover') {
      if (!wal) fail('RESCUE_NO_PENDING', '没有未完成的外置事务；请使用“修复运行目录”。');
      await validateWal(t, wal, true);
      for (const row of wal.files) await add(row.file, row.role, row.before,
        row.before === null ? null : historyFile(t, wal.operation, row.snapshot));
    } else {
      await assertReady(game);
      if (saved?.mode !== 'external') fail('RESCUE_NOT_EXTERNAL', '没有可核实的受管外置环境；可以只移出游戏库，保留文件与恢复记录。');
      const rootIni = path.join(t.dir, 'ReShade.ini');
      if (mode === 'repair') {
        const bytes = Buffer.from(loaderConfig(saved.originalReShadeConfig, t.runtimeDir));
        if (hash(bytes) !== saved.loaderConfigHash) fail('RESCUE_RECORD', '原运行目录配置与记录不一致，未重建路径。');
        await add(rootIni, 'reshade-config', saved.loaderConfigHash, null, bytes);
        for (const row of saved.files) {
          const file = path.join(t.runtimeDir, row.name), current = await digest(file);
          if (current === row.sha256 || row.mutable && current !== null) continue;
          await add(file, row.role, row.sha256, await rescueSource(t, saved, file, row.sha256));
        }
        const config = path.join(t.runtimeDir, 'ReShade.ini');
        if (await digest(config) === null) {
          const history = readJson(path.join(t.ownerRoot, 'history', saved.generation, 'operation.json'));
          const proof = history?.files?.find(row => key(row.file || '.') === key(config) && row.role === 'reshade-config' && HASH.test(row.after || ''));
          if (!proof) fail('RESCUE_SOURCE_MISSING', '运行目录配置快照缺失，请备份清理后重新安装。', { file: config });
          await add(config, 'reshade-config', proof.after, await rescueSource(t, saved, config, proof.after));
        }
        if (saved.loadingMode !== 'helper' && saved.proxy) {
          const file = path.join(t.dir, saved.proxy.name);
          if (await digest(file) !== saved.proxy.sha256) await add(file, 'game-proxy', saved.proxy.sha256, await rescueSource(t, saved, file, saved.proxy.sha256));
        }
        warnings.push({ message: '恢复记录对应的版本和路径；保留现有个人 INI。需要切换 Core 时，请在修复后再应用所选版本。' });
      } else {
        // Do not orphan an independent FG owner by silently detaching its
        // runtime. Repair the binding first so its own recovery stays reachable.
        for (const name of ['xiaofeng-fg-components.json', 'xiaofeng-fg-sm86.json', 'xiaofeng-fg-migration.json']) {
          if (fs.existsSync(path.join(t.runtimeDir, '_DLSS5_Backup', name)))
            fail('RESCUE_COMPONENTS_FIRST', '外置目录仍有补帧恢复记录。请先修复运行目录并恢复补帧；只移出库始终可用。', { file: path.join(t.runtimeDir, '_DLSS5_Backup', name) });
        }
        for (const row of saved.files) await add(path.join(t.runtimeDir, row.name), row.role, null);
        await add(path.join(t.runtimeDir, 'ReShade.ini'), 'reshade-config', null);
        if (saved.proxy && saved.loadingMode !== 'helper') await add(path.join(t.dir, saved.proxy.name), 'game-proxy', null);
        const bytes = saved.originalConfigExisted ? Buffer.from(saved.originalReShadeConfig) : undefined;
        await add(rootIni, 'reshade-config', bytes === undefined ? null : hash(bytes), null, bytes);
        const next = { ...saved, generation: operation, mode: 'local', loadingMode: 'proxy', removed: true, uninstallMode: 'rescue-clean',
          updatedAt: new Date().toISOString(), loaderConfigHash: hash(Buffer.from(saved.originalReShadeConfig)),
          previous: { mode: 'external', version: saved.payloadVersion, generation: saved.generation, snapshot: operation,
            snapshotDirectory: path.join(t.ownerRoot, 'history', operation) } };
        const receiptBytes = jsonBytes(next); await add(t.receipt, 'receipt', hash(receiptBytes), null, receiptBytes);
        warnings.push({ message: '现有受管文件（包括被改过的文件）先归档再移除；原来隔离的旧插件继续保留在备份，不重新启用。未知目录与无关插件不处理。' });
      }
    }
    const planId = crypto.randomUUID(), archiveDirectory = path.join(t.ownerRoot, 'history', operation);
    rescuePlans.set(planId, { game, target: t, operation, mode, operations, wal, receiptHash, pendingHash, exeHash, expires: Date.now() + 5 * 60 * 1000 });
    return { planId, mode, gameId: game.id, archiveDirectory, requiresConfirmation: true, requiresAntiCheat: Boolean(guards.antiCheatPresent?.(t.gameRoot)),
      scope: '仅处理原部署记录绑定的文件。当前文件逐项备份，未知 ReShade 路径不扫描、不删除；取消不改文件。', warnings, blockers: [],
      changes: operations.map(row => ({ path: row.file, name: path.basename(row.file), beforeSha256: row.before, afterSha256: row.after,
        action: row.before === row.after ? 'keep' : row.after === null ? 'remove' : row.before === null ? 'create' : 'replace' })) };
  }
  async function applyRescue(game, planId, consent = {}) {
    if (consent.confirm !== true) fail('RESCUE_CONFIRM_REQUIRED', '请先确认逐文件恢复清单。');
    const plan = rescuePlans.get(planId), t = target(game, true);
    if (!plan || plan.game.id !== game.id || plan.target.id !== t.id || plan.expires < Date.now()) fail('PLAN_EXPIRED', '恢复预览已失效，请重新检查。');
    if (active.has(t.id)) fail('BUSY', '该游戏正在部署。');
    rescuePlans.delete(planId); active.add(t.id);
    try {
      await closed(t);
      if (guards.antiCheatPresent?.(t.gameRoot) && consent.allowAntiCheat !== true)
        throw Object.assign(new Error('请先确认本次部署风险。'), { code: 'ERR_ANTI_CHEAT_CONFIRM' });
      if (await digest(t.exe) !== plan.exeHash || await digest(t.receipt) !== plan.receiptHash || await digest(t.pending) !== plan.pendingHash)
        fail('PLAN_CHANGED', '预览后游戏或恢复记录已改变，请重新检查。');
      for (const row of plan.operations) if (await digest(row.file) !== row.before) fail('PLAN_CHANGED', '预览后文件已改变，请重新检查。', { file: row.file });
      const archiveDirectory = path.join(t.ownerRoot, 'history', plan.operation);
      if (plan.mode === 'recover') {
        await validateWal(t, plan.wal, true);
        const adjusted = structuredClone(plan.wal), conflicts = [];
        for (let i = 0; i < adjusted.files.length; i++) {
          const row = adjusted.files[i], current = plan.operations[i].before;
          if (current === row.before || current === row.after) continue;
          const archive = path.join(archiveDirectory, 'conflicts', i + '.bin');
          if (current !== null) await snapshot(row.file, archive, current);
          conflicts.push({ path: row.file, sha256: current, archive: current === null ? null : archive });
          row.after = current;
        }
        // Archive both the old mapping and conflicting bytes before replacing
        // the WAL. After a crash normal recovery can finish this exact rollback.
        await atomicJson(path.join(archiveDirectory, 'rescue.json'), { mode: plan.mode, originalWal: plan.wal, conflicts });
        for (const row of plan.operations) if (await digest(row.file) !== row.before) fail('PLAN_CHANGED', '归档期间文件已改变，请重新检查。', { file: row.file });
        if (await digest(t.pending) !== plan.pendingHash) fail('PLAN_CHANGED', '恢复记录已改变。');
        await closed(t); await atomicJson(t.pending, adjusted);
        await rollback(t, adjusted);
      } else {
        await assertReady(game);
        await transaction(t, plan);
      }
      return { applied: true, rescued: true, mode: plan.mode, recovered: plan.mode === 'recover', removed: plan.mode === 'clean',
        archiveDirectory, runtimeVerified: false, notice: plan.mode === 'clean' ? '已归档并清理受管外置环境；可重新预览安装。'
          : plan.mode === 'recover' ? '已归档外部改动并恢复文件事务；请继续检查其他未完成操作。' : '已重连原运行目录并补齐可核实文件；请重新检查后应用所选 Core。' };
    } finally { active.delete(t.id); }
  }
  function direct(game) { const saved = record(target(game)); return saved?.mode === 'external' && ['direct', 'direct_hoyo'].includes(saved.origin); }
  async function previewRemove(game, mode = 'restore', internal = {}) {
    const t = target(game), saved = record(t); await closed(t); await assertReady(game);
    if (!['direct', 'direct_hoyo'].includes(saved?.origin) || saved.mode !== 'external' || !['clean', 'restore'].includes(mode)) fail('REMOVE', '该部署没有可使用的首次外置卸载记录。');
    getLayout(game);
    const requiresFgRestore = ['xiaofeng-fg-components.json', 'xiaofeng-fg-migration.json'].some(name => fs.existsSync(path.join(t.runtimeDir, '_DLSS5_Backup', name)));
    if (requiresFgRestore && internal.plannedFgRestore !== true) fail('FG_RESTORE_FIRST', '请先恢复外置目录中的补帧组件。');
    const operation = crypto.randomUUID(), operations = [], warnings = [];
    async function change(file, role, source, bytes, after) {
      const before = await digest(file), value = bytes === undefined ? undefined : Buffer.from(bytes);
      operations.push({ file, role, source, ...(value === undefined ? {} : { bytes: value }), before, after: value === undefined ? after : hash(value) });
    }
    for (const row of saved.files) {
      const file = path.join(t.runtimeDir, row.name), actual = await digest(file);
      if (!actual || !row.mutable && actual !== row.sha256) fail('FILE_CHANGED', '外置文件已变动，未删除或覆盖。', { file });
      await change(file, row.role, null, undefined, null);
    }
    await change(path.join(t.runtimeDir, 'ReShade.ini'), 'reshade-config', null, undefined, null);
    if (mode === 'restore') for (const row of saved.isolatedAddons || []) {
      const current = await digest(row.path), source = historyFile(t, row.operation, row.snapshot);
      if (await digest(source) !== row.sha256) fail('BACKUP_CHANGED', '插件隔离快照缺失或被修改。');
      if (current === row.sha256) continue;
      if (current !== null) { warnings.push({ code: 'ADDON_RESTORE_CONFLICT', path: row.path, archive: source,
        message: '原位置已有不同文件，保留当前文件和插件隔离快照。' }); continue; }
      await change(row.path, 'source-addon', source, undefined, row.sha256);
    }
    if (saved.origin === 'direct_hoyo') {
      for (const row of saved.initialProxies) {
        const proxyFile = path.join(t.dir, row.name), current = await digest(proxyFile), source = historyFile(t, saved.initialOperation, row.snapshot);
        if (await digest(source) !== row.sha256) fail('BACKUP_CHANGED', '原米哈游加载器快照缺失或已改变。');
        if (mode !== 'restore' || current === row.sha256) continue;
        if (current !== null) { warnings.push({ code: 'HOYO_PROXY_RESTORE_CONFLICT', path: proxyFile, archive: source,
          message: '原加载器位置已有不同文件，保留当前文件和原快照。' }); continue; }
        await change(proxyFile, 'game-proxy', source, undefined, row.sha256);
      }
    } else {
      const initial = saved.initialProxy, proxyFile = path.join(t.dir, initial.name), activeProxyFile = path.join(t.dir, saved.proxy.name), currentProxy = await digest(activeProxyFile);
      const expectedProxy = saved.loadingMode === 'helper' ? null : saved.proxy.sha256;
      if (currentProxy !== expectedProxy) fail('FILE_CHANGED', '当前游戏加载器已变动，未覆盖。', { file: activeProxyFile });
      if (initial.name !== saved.proxy.name) {
        if (await digest(proxyFile) !== null) fail('FILE_CHANGED', '原加载入口出现其他文件，保留当前文件和原快照。', { file: proxyFile });
        if (saved.loadingMode !== 'helper') await change(activeProxyFile, 'game-proxy', null, undefined, null);
      }
      const restoreOriginal = mode === 'restore' || !initial.owned;
      if (restoreOriginal && initial.before !== null) {
        const source = historyFile(t, saved.initialOperation, initial.snapshot);
        if (await digest(source) !== initial.before) fail('BACKUP_CHANGED', '原加载器快照缺失或已改变。');
        await change(proxyFile, 'game-proxy', source, undefined, initial.before);
      } else await change(proxyFile, 'game-proxy', null, undefined, null);
      if (mode === 'restore' && saved.retiredProxy) {
        const retired = saved.retiredProxy, file = path.join(t.dir, retired.name), source = historyFile(t, saved.initialOperation, retired.snapshot);
        if (await digest(source) !== retired.sha256) fail('BACKUP_CHANGED', '原加载入口备份已变化。');
        const current = await digest(file);
        if (file !== activeProxyFile && current !== null) fail('FILE_CHANGED', '原加载入口出现其他文件，未覆盖。', { file });
        const planned = operations.find(row => key(row.file) === key(file));
        if (planned) Object.assign(planned, { source, after: retired.sha256 });
        else await change(file, 'game-proxy', source, undefined, retired.sha256);
      }
    }
    await change(path.join(t.dir, 'ReShade.ini'), 'reshade-config', null,
      saved.originalConfigExisted ? saved.originalReShadeConfig : undefined, null);
    const next = { ...saved, generation: operation, mode: 'local', loadingMode: 'proxy', updatedAt: new Date().toISOString(),
      previous: { mode: 'external', version: saved.payloadVersion, generation: saved.generation, snapshot: operation,
        snapshotDirectory: path.join(t.ownerRoot, 'history', operation) }, removed: true, uninstallMode: mode,
      loaderConfigHash: hash(Buffer.from(saved.originalReShadeConfig)) };
    await change(t.receipt, 'receipt', null, jsonBytes(next));
    const result = await directPlan(t, game, next, operations, { fromMode: 'external', requiresFgRestore, warnings });
    return { ...result, mode, phases: ['external-uninstall'], changes: result.changes.map(row => ({ ...row, phase: 'external-uninstall' })), removed: true, archiveDirectory: path.join(t.ownerRoot, 'history', operation) };
  }
  async function remove(game, mode = 'restore', consent = {}) {
    await recover(game);
    const plan = await previewRemove(game, mode), result = await apply(plan.planId, consent);
    return { ...result, mode, deploymentMode: 'local', removed: true, restored: mode === 'restore', uninstallMode: mode, archiveDirectory: plan.archiveDirectory };
  }
  async function restore(game, consent = {}) {
    await recover(game);
    const t = target(game, true), saved = record(t);
    if (saved?.mode !== 'external') return { restored: false, unchanged: true };
    const boundGame = { ...game, scan: { ...game.scan, chosen: { ...game.scan?.chosen, path: t.exe, bitness: 64, apiResolution: { api: saved.api } } } };
    if (['direct', 'direct_hoyo'].includes(saved.origin)) return remove(boundGame, 'restore', consent);
    const plan = await preview(boundGame, { mode: 'local' });
    return { ...await apply(plan.planId, consent), restored: true };
  }
  function owned(game) { return record(target(game))?.mode === 'external'; }
  return { getLayout, inspect, preview, apply, restore, recover, previewRescue, applyRescue, assertReady, owned, direct, previewRemove, remove,
    rescueState: game => { const t = target(game, true), interrupted = pending(t);
      return { available: Boolean(interrupted || record(t)?.mode === 'external'), pending: Boolean(interrupted) }; },
    planAddonMigration: (game, context = {}) => {
      const exe = game.scan?.chosen?.path || game.chosen?.path || game.exe;
      if (!path.isAbsolute(exe || '')) fail('TARGET', '插件迁移需要实际 EXE。');
      const profile = inspectProfile(path.dirname(exe), options.environment || process.env);
      if (!profile.ok) fail('SOURCE_LAYOUT', profile.blockers.map(row => row.message).join('；'));
      return sourceAddons(profile, { ...context, game });
    },
    location: game => { const t = target(game), desired = { loaderDir: t.dir, baseDir: t.runtimeDir, addonDir: t.runtimeDir,
      activeConfigPath: path.join(t.runtimeDir, 'ReShade.ini') };
      return { runtimeDir: t.runtimeDir, addonDir: t.runtimeDir, addonDirectory: t.runtimeDir,
        activeConfigPath: desired.activeConfigPath, desired }; } };
}
module.exports = { createExternalRuntime, PRODUCT, RECEIPT, PENDING, digest };
