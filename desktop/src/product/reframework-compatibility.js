'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const peDefault = require('../core/pe');

const HASH = /^[a-f0-9]{64}$/i;
const OFFICIAL = Object.freeze({
  schema: 1,
  component: 'REFramework',
  publisher: 'praydog',
  release: 'nightly-01417-b6baf6b406efc65e077b99cb4d9ad25b0a0a9095',
  source_commit: 'b6baf6b406efc65e077b99cb4d9ad25b0a0a9095',
  source_url: 'https://github.com/praydog/REFramework/commit/b6baf6b406efc65e077b99cb4d9ad25b0a0a9095',
  asset_url: 'https://github.com/praydog/REFramework-nightly/releases/download/nightly-01417-b6baf6b406efc65e077b99cb4d9ad25b0a0a9095/REFramework.zip',
  archive_sha256: 'ae8208c299422ae88ec520082ac1721fc7c06f41ef163ca1eeef10650fee0e7c',
  dll_sha256: '504f2eb1cf98fad0b43ed95bcc4f457afeea676912b90889ac03f797c5acf23c',
  dll_bytes: 23055872,
  install_leaf: 'dinput8.dll',
  game_runtime_verified: false
});
function requiredAdapter(id, executable, storage, sourceLine, manifestLine) {
  return Object.freeze({ id, executable, engine: 're-engine', architecture: 64, storage,
    evidence: Object.freeze({ component: OFFICIAL.source_url, rhiExplicitEntry: true,
      rhiManifest: `https://github.com/RankFTW/RHI/blob/b2044965806d2ed01ff6f214da53f720aab4ff3e/manifest.json#L${manifestLine}`,
      gameSupport: `https://github.com/praydog/REFramework/blob/${OFFICIAL.source_commit}/shared/sdk/GameIdentity.cpp#L${sourceLine}`,
      storageContract: `https://github.com/praydog/REFramework/blob/${OFFICIAL.source_commit}/src/REFramework.cpp#L356`,
      ownerResult: '固定官方版本支持此游戏，RHI 明确要求 REFramework；游戏运行验收仍需单独确认。',
      gameRuntimeVerified: false
    })
  });
}
const ADAPTERS = Object.freeze([Object.freeze({
  id: 'onimusha-wots-reframework-01417',
  executable: 'OnimushaWotS.exe',
  engine: 're-engine',
  architecture: 64,
  storage: '_storage_',
  evidence: Object.freeze({
    component: OFFICIAL.source_url,
    rhiManifest: 'https://github.com/RankFTW/RHI/blob/main/manifest.json',
    rhiExplicitEntry: false,
    ownerResult: '维护者已确认 Onimusha dev15/dev16 + 官方 REF 01417 测试通过；仅对应明确组合，不代表其他 RE 游戏或性能验收。',
    ownerCoreSha256: 'd38400472424cc52883a154e0995a4ddd552ab3d90afa4aa5ccf19693c34e8af',
    ownerCoreSource: 'e7261752e8eab9cf63aba1c6d56d9f54eb409ee3',
    priorOwnerCoreSha256: '49fea7d7922d4f91dcd6f2b69652147434cfda9c5c28523839c58ab117ef2a0a',
    storageContract: 'https://github.com/praydog/REFramework/blob/b6baf6b406efc65e077b99cb4d9ad25b0a0a9095/src/REFramework.cpp#L214',
    modulePathHelper: 'https://github.com/cursey/kananlib/blob/8c27b656734355db0f2893581fd62e838fa130ad/src/Module.cpp#L479'
  })
}), Object.freeze({
  id: 're9-reframework-01417',
  executable: 're9.exe',
  engine: 're-engine',
  architecture: 64,
  storage: '_storage_',
  evidence: Object.freeze({
    component: OFFICIAL.source_url,
    rhiManifest: 'https://github.com/RankFTW/RHI/blob/main/manifest.json',
    rhiExplicitEntry: true,
    ownerResult: '官方 REFramework 固定源码包含 RE9 支持；本机已有相同官方加载器。未将组件就绪等同于新 Core 的游戏验收。',
    storageContract: 'https://github.com/praydog/REFramework/blob/b6baf6b406efc65e077b99cb4d9ad25b0a0a9095/src/REFramework.cpp#L214',
    gameSupport: 'https://github.com/praydog/REFramework/blob/b6baf6b406efc65e077b99cb4d9ad25b0a0a9095/src/REFramework.cpp#L489'
  })
}),
requiredAdapter('dd2-reframework-01417', 'DD2.exe', '_storage_', 249, 974),
requiredAdapter('mhwilds-reframework-01417', 'MonsterHunterWilds.exe', '_storage_', 309, 1027),
requiredAdapter('mhwilds-alias-reframework-01417', 'MHWILDS.exe', '_storage_', 309, 1027),
requiredAdapter('sf6-reframework-01417', 'StreetFighter6.exe', null, 239, 1044),
requiredAdapter('sf6-alias-reframework-01417', 'SF6.exe', null, 239, 1044)
]);

function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function inside(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
function localAbsolute(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));
}
function engineId(value) { return String(value || '').trim().toLowerCase().replace(/[ _-]+/g, '-'); }
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !path.isAbsolute(value) &&
    !/[\0<>:"|?*]/.test(value) && !value.split(/[\\/]+/).some(part => !part || part === '..');
}
function noLinks(file) {
  const full = path.resolve(file), parsed = path.parse(full); let current = parsed.root;
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) fail('REF_LINK_BLOCKED', '检测到链接或硬链接，未生成自动处理计划。', { file: path.basename(current) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function plainFile(file, maxBytes = 64 * 1024 * 1024) {
  noLinks(file);
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size <= maxBytes ? stat : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function readJson(file) {
  const stat = plainFile(file, 64 * 1024);
  if (!stat) fail('REF_COMPONENT_MISSING', '找不到有效的 REFramework component.json。', { file: 'component.json' });
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { fail('REF_COMPONENT_INVALID', 'REFramework component.json 无法解析。', { file: 'component.json' }); }
}
function exactComponent(value) {
  return Object.entries(OFFICIAL).every(([key, expected]) => value && value[key] === expected) &&
    Object.keys(value).every(key => Object.hasOwn(OFFICIAL, key));
}
function item(file, fileDigest = digest, maxHashBytes = 256 * 1024 * 1024) {
  noLinks(file);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return { exists: true, type: 'link', hash: null };
    return { exists: true, type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      hash: stat.isFile() && stat.size <= maxHashBytes ? fileDigest(file) : null, bytes: stat.isFile() ? stat.size : null };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, type: 'missing', hash: null, bytes: null }; throw error; }
}

function createReframeworkCompatibility(options = {}) {
  const pe = options.pe || peDefault;
  const fileDigest = options.fileDigest || digest;

  function identify(input) {
    if (!localAbsolute(input?.gameDir) || !localAbsolute(input?.exe)) fail('REF_BAD_TARGET', '游戏目录或 EXE 路径无效。');
    const gameDir = path.resolve(input.gameDir), exe = path.resolve(input.exe);
    noLinks(gameDir); noLinks(exe);
    if (!inside(gameDir, exe) || !samePath(path.dirname(exe), gameDir)) return { gameDir, exe, adapter: null, reason: 'REFramework 配套只允许绑定已核验的游戏根目录 EXE。' };
    const adapter = ADAPTERS.find(row => row.executable.toLowerCase() === path.basename(exe).toLowerCase() && row.engine === engineId(input.engine));
    if (!adapter) return { gameDir, exe, adapter: null, reason: '该 EXE 与引擎组合没有精确核验的 REFramework 配套。' };
    // Architecture inspection reads bounded PE headers, not the full game EXE.
    // Requiem's legitimate executable is larger than 512 MiB.
    const stat = plainFile(exe, Number.MAX_SAFE_INTEGER);
    if (!stat) return { gameDir, exe, adapter: null, reason: '核验的游戏 EXE 不存在或不是普通文件。' };
    let bitness;
    try { bitness = pe.getBitness(exe); } catch { return { gameDir, exe, adapter: null, reason: '无法确认游戏 EXE 的 PE 架构。' }; }
    if (bitness !== adapter.architecture) return { gameDir, exe, adapter: null, reason: '该 REFramework 配套只核验了 x64 游戏 EXE。' };
    return { gameDir, exe, adapter };
  }

  function ownership(gameDir, rows) {
    if (rows === undefined) return new Map();
    if (!Array.isArray(rows) || rows.length > 256) fail('REF_OWNERSHIP_INVALID', 'REFramework 文件归属记录无效。');
    const result = new Map();
    for (const row of rows) {
      if (!row || !safeRelative(row.rel) || !HASH.test(row.sha256 || '') || typeof row.role !== 'string' || row.role.length > 64) {
        fail('REF_OWNERSHIP_INVALID', 'REFramework 文件归属记录包含无效路径或摘要。');
      }
      const file = path.resolve(gameDir, row.rel);
      if (!inside(gameDir, file) || samePath(gameDir, file)) fail('REF_OWNERSHIP_INVALID', 'REFramework 文件归属记录越过游戏目录。');
      const key = file.toLowerCase(); if (result.has(key)) fail('REF_OWNERSHIP_INVALID', 'REFramework 文件归属记录包含重复路径。');
      result.set(key, { rel: path.normalize(row.rel), sha256: row.sha256.toLowerCase(), role: row.role });
    }
    return result;
  }

  function inspect(input) {
    const target = identify(input);
    if (!target.adapter) return { matched: false, ready: false, canPrepare: false, reason: target.reason, blockers: [{ code: 'REF_UNSUPPORTED_TARGET', message: target.reason }], plan: null };
    if (!localAbsolute(input.componentRoot)) fail('REF_COMPONENT_INVALID', 'REFramework 组件目录必须是本机绝对路径。');
    const componentRoot = path.resolve(input.componentRoot); noLinks(componentRoot);
    const manifest = readJson(path.join(componentRoot, 'component.json'));
    if (!exactComponent(manifest)) fail('REF_COMPONENT_INVALID', 'REFramework 组件身份、来源或固定摘要不一致。');
    const source = path.join(componentRoot, OFFICIAL.install_leaf), sourceStat = plainFile(source, 64 * 1024 * 1024);
    if (!sourceStat || sourceStat.size !== OFFICIAL.dll_bytes || fileDigest(source) !== OFFICIAL.dll_sha256) {
      fail('REF_COMPONENT_HASH', 'REFramework dinput8.dll 与固定官方摘要不一致。', { file: OFFICIAL.install_leaf });
    }
    let sourceBitness;
    try { sourceBitness = pe.getBitness(source); } catch { fail('REF_COMPONENT_ARCH', 'REFramework dinput8.dll 不是有效的 x64 PE。'); }
    if (sourceBitness !== 64) fail('REF_COMPONENT_ARCH', 'REFramework dinput8.dll 不是 x64。');

    const owned = ownership(target.gameDir, input.managedFiles), blockers = [], operations = [];
    const rootLoader = path.join(target.gameDir, OFFICIAL.install_leaf), loader = item(rootLoader, fileDigest);
    let loaderState = 'absent';
    if (loader.exists && loader.type !== 'file') loaderState = 'conflict';
    else if (loader.exists && loader.hash === OFFICIAL.dll_sha256) loaderState = owned.has(rootLoader.toLowerCase()) ? 'managed-matching' : 'matching-external';
    else if (loader.exists) loaderState = 'conflict';
    if (loaderState === 'conflict') blockers.push({ code: 'REF_DINPUT8_CONFLICT', message: 'dinput8.dll 已被其他加载器占用，不会覆盖。', file: OFFICIAL.install_leaf });
    else if (loaderState === 'absent') operations.push({ kind: 'copy', role: 'reframework-loader', source, target: rootLoader, sha256: OFFICIAL.dll_sha256 });
    else operations.push({ kind: 'preserve', role: 'reframework-loader', target: rootLoader, sha256: OFFICIAL.dll_sha256,
      ownership: loaderState === 'managed-matching' ? 'managed' : 'external' });

    const rootEntries = fs.readdirSync(target.gameDir, { withFileTypes: true });
    if (rootEntries.length > 4096) fail('REF_DIRECTORY_UNBOUNDED', '游戏根目录条目过多，未继续生成 REFramework 计划。');
    const frameworkEntries = rootEntries.filter(entry => /^(?:reframework|ref(?:\.|$))/i.test(entry.name))
      .slice(0, 128).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' }));
    if (frameworkEntries.length && loaderState === 'absent') blockers.push({ code: 'REF_EXISTING_FRAMEWORK', message: '发现没有加载器收据对应的 REF/REFramework 文件，需要先核对归属。', files: frameworkEntries.map(row => row.name) });

    if (!target.adapter.storage) {
      // SF6 uses TDB71 and is not in the pinned DD2/MHRise exceptions.
      // REF only supplies the loader here: _storage_ has no runtime meaning
      // for this profile and must never be inspected, seeded or adopted.
      const rootConfig = path.join(target.gameDir, 'nr_before_sr.ini');
      return {
        matched: true, ready: (loaderState === 'managed-matching' || loaderState === 'matching-external') && blockers.length === 0,
        canPrepare: blockers.length === 0, adapter: target.adapter,
        component: { ...OFFICIAL, root: componentRoot, file: source, verified: true },
        existing: { loader: { file: rootLoader, state: loaderState, hash: loader.hash }, frameworkEntries,
          storage: { path: null, exists: false, entries: [], reviewRequired: false } },
        runtime: { storageDir: null, rootConfig, storageConfig: null, effectiveConfig: rootConfig, seed: null, existingStorageConfigPreferred: false },
        managedLocations: [], blockers,
        plan: { readonly: true, requiresGameClosed: true, requiresTransaction: true, writesRegistry: false,
          operations, deletes: [], preserve: frameworkEntries.map(row => row.name).concat('nr_before_sr.ini') }
      };
    }

    const storageDir = path.join(target.gameDir, target.adapter.storage), storageState = item(storageDir, fileDigest);
    const storageEntries = [];
    if (storageState.exists) {
      if (storageState.type !== 'directory') blockers.push({ code: 'REF_STORAGE_CONFLICT', message: '_storage_ 不是目录，未自动处理。', file: target.adapter.storage });
      else {
        const entries = fs.readdirSync(storageDir, { withFileTypes: true });
        if (entries.length > 512) blockers.push({ code: 'REF_STORAGE_UNBOUNDED', message: '_storage_ 条目过多，未自动更新或清理。' });
        for (const entry of entries.slice(0, 512)) {
          const file = path.join(storageDir, entry.name), record = owned.get(file.toLowerCase());
          let state = 'unowned';
          if (entry.isFile() && record) state = item(file, fileDigest).hash === record.sha256 ? 'managed-matching' : 'managed-drift';
          storageEntries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', state, role: record?.role || null });
        }
      }
    }

    const rootConfig = path.join(target.gameDir, 'nr_before_sr.ini'), storageConfig = path.join(storageDir, 'nr_before_sr.ini');
    const rootConfigState = item(rootConfig, fileDigest, 64 * 1024), storageConfigState = storageState.type === 'directory' ? item(storageConfig, fileDigest, 64 * 1024) : { exists: false, type: 'missing', hash: null };
    const rootConfigReceipt = owned.get(rootConfig.toLowerCase()), storageConfigReceipt = owned.get(storageConfig.toLowerCase());
    const rootConfigValid = rootConfigState.type === 'file' && rootConfigState.bytes <= 64 * 1024 && /\[NRBeforeSR\]/i.test(fs.readFileSync(rootConfig, 'utf8'));
    const storageConfigValid = storageConfigState.type === 'file' && storageConfigState.bytes <= 64 * 1024 && /\[NRBeforeSR\]/i.test(fs.readFileSync(storageConfig, 'utf8'));
    let effectiveConfig = null, seed = null;
    if (storageConfigState.exists) {
      effectiveConfig = storageConfig;
      if (!storageConfigValid) blockers.push({ code: 'REF_STORAGE_CONFIG_INVALID', message: '_storage_/nr_before_sr.ini 无法作为有效配置读取；不会覆盖。', file: '_storage_/nr_before_sr.ini' });
    } else if (rootConfigState.exists) {
      if (!rootConfigValid) blockers.push({ code: 'REF_ROOT_CONFIG_INVALID', message: '原 nr_before_sr.ini 无法作为有效配置预置。', file: 'nr_before_sr.ini' });
      else if (!rootConfigReceipt || rootConfigReceipt.sha256 !== rootConfigState.hash) blockers.push({ code: 'REF_CONFIG_OWNERSHIP_REQUIRED', message: '原 nr_before_sr.ini 没有匹配的归属收据，不会复制到 _storage_。', file: 'nr_before_sr.ini' });
      else {
        seed = { kind: 'seed-config', source: rootConfig, target: storageConfig, sha256: rootConfigState.hash };
        if (!storageState.exists) operations.push({ kind: 'ensure-directory', target: storageDir });
        operations.push(seed); effectiveConfig = storageConfig;
      }
    }

    const unknownCache = storageEntries.filter(row => row.name.toLowerCase() !== 'nr_before_sr.ini' && row.state !== 'managed-matching');
    const drift = storageEntries.filter(row => row.state === 'managed-drift');
    if (drift.length) blockers.push({ code: 'REF_STORAGE_OWNED_DRIFT', message: '_storage_ 中受管文件与收据摘要不一致，不会更新或删除。', files: drift.map(row => row.name) });
    if (unknownCache.length) blockers.push({ code: 'REF_STORAGE_REVIEW_REQUIRED', message: '_storage_ 含未确认归属的缓存；不会自动更新或删除。', files: unknownCache.map(row => row.name) });

    // The pinned loaded-module callback also mirrors addon64 files; the
    // startup loop's .dll-only filter is not the complete cache contract.
    const managedLocations = [...owned.values()].filter(row => /\.(?:dll|addon64)$/i.test(row.rel)).map(row => {
      const file = path.join(target.gameDir, row.rel), actual = item(file, fileDigest);
      return { rel: row.rel, role: row.role, exists: actual.exists, valid: actual.type === 'file' && actual.hash === row.sha256, expected: row.sha256, actual: actual.hash };
    });
    if (managedLocations.some(row => row.exists && !row.valid)) blockers.push({ code: 'REF_MANAGED_FILE_CHANGED', message: '游戏根目录或 _storage_ 中受管组件已被外部修改。' });

    return {
      matched: true,
      ready: (loaderState === 'managed-matching' || loaderState === 'matching-external') && blockers.length === 0,
      canPrepare: blockers.length === 0,
      adapter: target.adapter,
      component: { ...OFFICIAL, root: componentRoot, file: source, verified: true },
      existing: { loader: { file: rootLoader, state: loaderState, hash: loader.hash }, frameworkEntries,
        storage: { path: storageDir, exists: storageState.type === 'directory', entries: storageEntries, reviewRequired: unknownCache.length > 0 } },
      runtime: { storageDir, rootConfig, storageConfig, effectiveConfig, seed, existingStorageConfigPreferred: storageConfigState.exists },
      managedLocations,
      blockers,
      plan: { readonly: true, requiresGameClosed: true, requiresTransaction: true, writesRegistry: false,
        operations, deletes: [], preserve: frameworkEntries.map(row => row.name).concat(storageEntries.map(row => `_storage_/${row.name}`)) }
    };
  }

  return Object.freeze({ inspect, adapters: ADAPTERS, component: OFFICIAL });
}

module.exports = { createReframeworkCompatibility, REFRAMEWORK_ADAPTERS: ADAPTERS, OFFICIAL_REFRAMEWORK_01417: OFFICIAL };
