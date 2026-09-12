'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const peDefault = require('../core/pe');
const { inside, noLinks, digestFile, atomicJson } = require('./launch-safety');
const { ensureDefaultReShadeHotkey } = require('./hotkeys');

const PRODUCT = 'xiaofeng-vulkan-runtime-profile';
const RECEIPT = '.xiaofeng-vulkan-runtime.json';
const HASH = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{7,64}$/i;
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const PE_EXTENSIONS = new Set(['.dll', '.exe', '.asi', '.addon64']);
// MAX_PATH includes the terminating WCHAR. The pinned Core uses fixed
// WCHAR[260] arrays for its module, INI and rotated log paths.
const MAX_PATH_CHARS = 259;

function fail(code, message, details) {
  throw Object.assign(new Error(message), { code, details });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function jsonHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function pathHash(value) {
  return crypto.createHash('sha256').update(path.resolve(value).toLowerCase()).digest('hex');
}
function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function localAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return false;
  return process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value);
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || path.isAbsolute(value) || /[\0<>:"|?*]/.test(value) ||
      value.split(/[\\/]+/).some(part => part === '..' || part === '')) return false;
  const normalized = path.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith(`..${path.sep}`) && !path.isAbsolute(normalized);
}

function createVulkanRuntimeProfile(options = {}) {
  if (!localAbsolute(options.userData)) {
    fail('VULKAN_RUNTIME_BAD_CONFIG', 'Vulkan 运行目录需要绝对的用户数据路径。');
  }
  const userData = path.resolve(options.userData);
  const runtimeRoot = path.join(userData, 'vulkan-runtime');
  const archiveRoot = path.join(userData, 'vulkan-runtime-archive');
  const pe = options.pe || peDefault;
  const copyFile = options.copyFile || fsp.copyFile;
  const realpath = options.realpath || fs.realpathSync.native;

  function validateExe(exe) {
    if (!localAbsolute(exe)) fail('VULKAN_RUNTIME_BAD_EXE', '游戏 EXE 路径无效。');
    return path.resolve(exe);
  }

  function normalizeRecipe(recipe) {
    if (!recipe || recipe.version !== 1 || !ID.test(recipe.id || '') || !ID.test(recipe.coreVersion || '') || !REVISION.test(recipe.sourceRevision || '') || recipe.architecture !== 64 ||
        !Array.isArray(recipe.files) || recipe.files.length === 0 || recipe.files.length > 64) {
      fail('VULKAN_RUNTIME_RECIPE_INVALID', 'Vulkan 运行资产 recipe 身份、架构或文件列表无效。');
    }
    const sources = new Set(), targets = new Set();
    const files = recipe.files.map(row => {
      if (!row || !safeRelative(row.source) || !safeRelative(row.target) || !HASH.test(row.sha256 || '') || typeof row.mutable !== 'boolean') {
        fail('VULKAN_RUNTIME_RECIPE_INVALID', 'Vulkan 运行资产 recipe 包含无效路径或摘要。');
      }
      const source = path.normalize(row.source), target = path.normalize(row.target);
      const sourceKey = source.toLowerCase(), targetKey = target.toLowerCase();
      if (sources.has(sourceKey) || targets.has(targetKey) || targetKey === RECEIPT.toLowerCase()) {
        fail('VULKAN_RUNTIME_RECIPE_INVALID', 'Vulkan 运行资产 recipe 包含重复或保留路径。');
      }
      sources.add(sourceKey); targets.add(targetKey);
      return { source, target, sha256: row.sha256.toLowerCase(), mutable: row.mutable };
    });
    const identity = { version: 1, id: recipe.id, coreVersion: recipe.coreVersion, sourceRevision: recipe.sourceRevision.toLowerCase(), architecture: 64, files };
    return { ...identity, fingerprint: jsonHash(identity) };
  }

  function locations(exe, recipe) {
    const exeId = pathHash(exe);
    const packageId = recipe.fingerprint.slice(0, 16);
    const exeRoot = path.join(runtimeRoot, exeId.slice(0, 16));
    const basePath = path.join(exeRoot, packageId);
    return { exeId, packageId, exeRoot, basePath };
  }

  function location(input) {
    const exe = validateExe(input?.exe), recipe = normalizeRecipe(input?.recipe), place = locations(exe, recipe);
    return { basePath: place.basePath, coreVersion: recipe.coreVersion, packageId: recipe.id,
      exeId: place.exeId, fingerprint: recipe.fingerprint };
  }

  function locationKind(exe, basePath, recipe) {
    const exeId = pathHash(exe), parent = path.dirname(basePath), leaf = path.basename(basePath);
    const short = samePath(parent, path.join(runtimeRoot, exeId.slice(0, 16))) && /^[a-f0-9]{16}$/.test(leaf) &&
      (!recipe || leaf === recipe.fingerprint.slice(0, 16));
    const legacy = samePath(parent, path.join(runtimeRoot, exeId)) &&
      (recipe ? leaf === `${recipe.id}-${recipe.fingerprint.slice(0, 16)}` : /^[a-z0-9][a-z0-9._-]{0,79}-[a-f0-9]{16}$/i.test(leaf));
    if (!short && !legacy) fail('VULKAN_RUNTIME_PATH_INVALID', 'Vulkan 运行资产目录不属于该 EXE 或固定配套。');
    return short ? 'short' : 'legacy';
  }

  function canonicalPath(file) {
    let current = path.resolve(file); const suffix = [];
    while (true) {
      try {
        let resolved = realpath(current);
        if (process.platform === 'win32' && resolved.startsWith('\\\\?\\')) resolved = resolved.slice(4);
        if (!localAbsolute(resolved)) fail('VULKAN_RUNTIME_PATH_INVALID', '无法确认 Vulkan 实际运行目录。');
        return path.resolve(resolved, ...suffix);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        suffix.unshift(path.basename(current)); current = parent;
      }
    }
  }

  function pathBudget(input) {
    const recipe = normalizeRecipe(input.recipe), basePath = path.resolve(input.basePath);
    const actual = canonicalPath(basePath);
    const relatives = new Set(recipe.files.map(row => row.target));
    relatives.add('ReShade.ini'); relatives.add('ReShade.log');
    const dirs = new Set(['addons', ...recipe.files.filter(row => PE_EXTENSIONS.has(path.extname(row.target).toLowerCase())).map(row => path.dirname(row.target))]);
    for (const dir of dirs) for (const name of ['nr-before-sr.log', 'nr-before-sr.previous.log', 'nr_before_sr.ini', 'dlss5-feed.log']) relatives.add(path.join(dir, name));
    const candidates = [...new Set([basePath, actual])].flatMap(root => [...relatives].map(relative => path.resolve(root, relative)));
    const longest = candidates.reduce((a, b) => a.length >= b.length ? a : b);
    return { safe: longest.length <= MAX_PATH_CHARS, maxChars: MAX_PATH_CHARS, longestChars: longest.length,
      longestPath: longest, canonicalBasePath: actual };
  }
  function assertPathBudget(input) {
    const result = pathBudget(input);
    if (!result.safe) fail('VULKAN_RUNTIME_PATH_TOO_LONG', 'Vulkan 运行路径超过 Core 的 Windows 路径上限；请先恢复旧配套，再使用较短的用户数据路径重新安装。',
      { pathBudget: result, restoreOnly: true });
    return result;
  }

  function resolveContained(root, relative, code = 'VULKAN_RUNTIME_RECIPE_INVALID') {
    const result = path.resolve(root, relative);
    if (!inside(root, result) || samePath(root, result)) fail(code, 'Vulkan 运行资产路径越过允许目录。', { file: relative });
    return result;
  }

  async function assertX64(file) {
    if (!PE_EXTENSIONS.has(path.extname(file).toLowerCase())) return;
    let bitness;
    try { bitness = pe.getBitness(file); } catch { fail('VULKAN_RUNTIME_ARCH', 'Vulkan 运行二进制不是有效的 x64 PE。', { file: path.basename(file) }); }
    if (bitness !== 64) fail('VULKAN_RUNTIME_ARCH', 'Vulkan 运行二进制不是 x64。', { file: path.basename(file) });
  }

  function receiptFor(exe, recipe, place) {
    return {
      version: 1,
      product: PRODUCT,
      exe,
      exeId: place.exeId,
      packageId: place.packageId,
      recipe: {
        version: 1,
        id: recipe.id,
        coreVersion: recipe.coreVersion,
        sourceRevision: recipe.sourceRevision,
        architecture: 64,
        fingerprint: recipe.fingerprint,
        files: recipe.files
      }
    };
  }

  function identifyReceipt({ receipt: value, basePath, exe }) {
    if (!value || value.version !== 1 || value.product !== PRODUCT || typeof value.exe !== 'string' || !path.isAbsolute(value.exe) ||
        !/^[a-f0-9]{64}$/.test(value.exeId || '') || !ID.test(value.recipe?.id || '') || !ID.test(value.recipe?.coreVersion || '') || !REVISION.test(value.recipe?.sourceRevision || '') ||
        value.recipe?.architecture !== 64 || !HASH.test(value.recipe?.fingerprint || '') || !Array.isArray(value.recipe?.files)) {
      fail('VULKAN_RUNTIME_RECEIPT_INVALID', 'Vulkan 运行资产记录内容无效，已停止操作。');
    }
    const recipe = normalizeRecipe(value.recipe);
    if (recipe.fingerprint !== value.recipe.fingerprint || value.exeId !== pathHash(value.exe) ||
        ![recipe.fingerprint.slice(0, 16), `${recipe.id}-${recipe.fingerprint.slice(0, 16)}`].includes(value.packageId)) {
      fail('VULKAN_RUNTIME_RECEIPT_INVALID', 'Vulkan 运行资产记录身份不一致，已停止操作。');
    }
    if (exe && !samePath(value.exe, exe)) fail('VULKAN_RUNTIME_EXE_CHANGED', '运行资产绑定到另一游戏 EXE，已停止操作。');
    const layout = locationKind(value.exe, path.resolve(basePath), recipe);
    if (path.basename(basePath).toLowerCase() !== value.packageId.toLowerCase()) fail('VULKAN_RUNTIME_RECEIPT_INVALID', '运行资产目录与记录身份不一致。');
    return { value, recipe, layout };
  }
  async function readReceipt(basePath) {
    const file = path.join(basePath, RECEIPT); await noLinks(file);
    let value;
    try {
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('size');
      value = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') fail('VULKAN_RUNTIME_NOT_PREPARED', 'Vulkan 运行资产尚未准备。');
      fail('VULKAN_RUNTIME_RECEIPT_INVALID', 'Vulkan 运行资产记录损坏，已停止操作。');
    }
    return identifyReceipt({ receipt: value, basePath });
  }

  async function assertExeBucket(exe, exeRoot, ownStage = null) {
    await noLinks(exeRoot);
    let entries;
    try { entries = await fsp.readdir(exeRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (entries.length > 128) fail('VULKAN_RUNTIME_IDENTITY_COLLISION', 'Vulkan 短目录条目超出归属确认范围，未覆盖资产。');
    for (const entry of entries) {
      const child = path.join(exeRoot, entry.name);
      if (ownStage && samePath(child, ownStage)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{16}$/.test(entry.name))
        fail('VULKAN_RUNTIME_IDENTITY_COLLISION', 'Vulkan 短目录有未确认归属或进行中的资产，未覆盖文件。');
      const received = await readReceipt(child);
      if (!samePath(received.value.exe, exe) || received.value.exeId !== pathHash(exe))
        fail('VULKAN_RUNTIME_IDENTITY_COLLISION', 'Vulkan 短目录已绑定另一完整 EXE 身份，未覆盖文件。');
    }
  }

  async function inspect(input) {
    const exe = validateExe(input?.exe);
    await noLinks(exe);
    let recipe = input?.recipe ? normalizeRecipe(input.recipe) : null;
    let basePath;
    if (input?.basePath !== undefined) {
      if (typeof input.basePath !== 'string' || !path.isAbsolute(input.basePath)) fail('VULKAN_RUNTIME_PATH_INVALID', 'Vulkan 运行资产目录无效。');
      basePath = path.resolve(input.basePath);
      locationKind(exe, basePath);
    } else {
      if (!recipe) fail('VULKAN_RUNTIME_RECIPE_INVALID', '检查 Vulkan 运行资产需要 recipe 或准备结果目录。');
      basePath = locations(exe, recipe).basePath;
    }
    await noLinks(basePath);
    if (!fs.existsSync(basePath)) return { ready: false, exists: false, basePath, coreVersion: recipe?.coreVersion || null, packageId: recipe?.id || null, files: [], blockers: ['运行资产目录尚未准备。'] };
    const received = await readReceipt(basePath);
    if (!samePath(received.value.exe, exe)) fail('VULKAN_RUNTIME_EXE_CHANGED', '运行资产绑定到另一游戏 EXE，已停止操作。');
    if (recipe && recipe.fingerprint !== received.recipe.fingerprint) fail('VULKAN_RUNTIME_PACKAGE_CHANGED', '运行资产目录属于另一固定 package。');
    recipe = received.recipe;
    if (path.basename(basePath).toLowerCase() !== received.value.packageId.toLowerCase()) fail('VULKAN_RUNTIME_RECEIPT_INVALID', '运行资产目录与记录身份不一致。');
    const budget = pathBudget({ basePath, recipe }), files = [], blockers = [];
    if (!budget.safe) blockers.push('旧 Vulkan 运行路径过长。请先在设置中点击“卸载插件”，再用新版管理器重新安装；新配套会自动使用短目录。');
    for (const row of recipe.files) {
      const file = resolveContained(basePath, row.target, 'VULKAN_RUNTIME_RECEIPT_INVALID');
      try {
        await noLinks(file);
        const stat = await fsp.stat(file);
        if (!stat.isFile()) throw Object.assign(new Error('not-file'), { code: 'ENOENT' });
        await assertX64(file);
        const actual = row.mutable ? null : await digestFile(file);
        const valid = row.mutable || actual === row.sha256;
        files.push({ target: row.target, file, mutable: row.mutable, valid });
        if (!valid) blockers.push(`${row.target} 的摘要与固定 recipe 不一致。`);
      } catch (error) {
        if (error.code !== 'ENOENT' && !['VULKAN_RUNTIME_ARCH', 'SETTINGS_LINK_BLOCKED'].includes(error.code)) throw error;
        files.push({ target: row.target, file, mutable: row.mutable, valid: false });
        blockers.push(error.code === 'VULKAN_RUNTIME_ARCH' ? error.message : `${row.target} 缺失或不可安全读取。`);
      }
    }
    return { ready: blockers.length === 0, exists: true, basePath, coreVersion: recipe.coreVersion, packageId: recipe.id, files, blockers,
      layout: received.layout, pathBudget: budget, restoreOnly: !budget.safe };
  }

  async function validateSource(packageRoot, recipe) {
    if (!localAbsolute(packageRoot)) fail('VULKAN_RUNTIME_SOURCE_INVALID', '运行资产 packageRoot 必须是本机绝对目录。');
    const root = path.resolve(packageRoot);
    await noLinks(root);
    let stat;
    try { stat = await fsp.stat(root); } catch { fail('VULKAN_RUNTIME_SOURCE_MISSING', '找不到 Vulkan 运行资产来源目录。'); }
    if (!stat.isDirectory()) fail('VULKAN_RUNTIME_SOURCE_INVALID', 'Vulkan 运行资产来源不是目录。');
    const sources = [];
    for (const row of recipe.files) {
      const file = resolveContained(root, row.source);
      await noLinks(file);
      let fileStat;
      try { fileStat = await fsp.stat(file); } catch { fail('VULKAN_RUNTIME_SOURCE_MISSING', 'Vulkan 运行资产来源缺少文件。', { file: row.source }); }
      if (!fileStat.isFile() || await digestFile(file) !== row.sha256) fail('VULKAN_RUNTIME_SOURCE_HASH', 'Vulkan 运行资产来源文件校验不匹配。', { file: row.source });
      await assertX64(file);
      let content = null;
      if (row.mutable && row.target.toLowerCase() === 'reshade.ini') {
        const original = await fsp.readFile(file);
        const text = new (require('node:util').TextDecoder)('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
        const prepared = ensureDefaultReShadeHotkey(text);
        if (prepared !== text) content = Buffer.from(prepared, 'utf8');
      }
      sources.push({ ...row, file, content, installedSha256: content ? crypto.createHash('sha256').update(content).digest('hex') : row.sha256 });
    }
    return { root, sources };
  }

  async function prepare(input, previewOnly = false) {
    const exe = validateExe(input?.exe);
    await noLinks(exe);
    let exeStat;
    try { exeStat = await fsp.stat(exe); } catch { fail('VULKAN_RUNTIME_BAD_EXE', '找不到游戏 EXE。'); }
    if (!exeStat.isFile()) fail('VULKAN_RUNTIME_BAD_EXE', '游戏 EXE 不是普通文件。');
    await assertX64(exe);
    const recipe = normalizeRecipe(input?.recipe);
    const place = locations(exe, recipe);
    await noLinks(place.basePath);
    assertPathBudget({ basePath: place.basePath, recipe });
    await assertExeBucket(exe, place.exeRoot);
    const source = await validateSource(input?.packageRoot, recipe);
    if (fs.existsSync(place.basePath)) {
      const current = await inspect({ exe, recipe, basePath: place.basePath });
      if (!current.ready) fail('VULKAN_RUNTIME_CHANGED', '已有 Vulkan 运行资产缺失或被修改，未覆盖用户文件。', { blockers: current.blockers });
      return { ...location({ exe, recipe }), files: current.files, reused: true,
        ...(previewOnly ? { changes: await Promise.all(current.files.map(async file => {
          const digest = await digestFile(file.file);
          return { path: file.file, name: path.basename(file.file), role: 'vulkan-runtime', beforeSha256: digest, afterSha256: digest, action: 'keep' };
        })) } : {}) };
    }
    if (previewOnly) return { ...location({ exe, recipe }), reused: false, changes: [
      ...source.sources.map(file => ({ path: resolveContained(place.basePath, file.target), name: path.basename(file.target), role: 'vulkan-runtime',
        beforeSha256: null, afterSha256: file.installedSha256, action: 'create' })),
      { path: path.join(place.basePath, RECEIPT), name: RECEIPT, role: 'receipt', beforeSha256: null, action: 'create' }
    ] };
    await noLinks(place.exeRoot);
    await fsp.mkdir(place.exeRoot, { recursive: true });
    const stage = path.join(place.exeRoot, `.${place.packageId}.${crypto.randomUUID()}.stage`);
    await noLinks(stage);
    await fsp.mkdir(stage, { recursive: false, mode: 0o700 });
    try {
      for (const row of source.sources) {
        const target = resolveContained(stage, row.target);
        await noLinks(target);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await noLinks(row.file);
        if (await digestFile(row.file) !== row.sha256) fail('VULKAN_RUNTIME_SOURCE_CHANGED', 'Vulkan 运行资产来源在复制前发生变化。', { file: row.source });
        await copyFile(row.file, target, fs.constants.COPYFILE_EXCL);
        await noLinks(row.file); await noLinks(target);
        if (await digestFile(row.file) !== row.sha256 || await digestFile(target) !== row.sha256) {
          fail('VULKAN_RUNTIME_SOURCE_CHANGED', 'Vulkan 运行资产在复制期间发生变化。', { file: row.source });
        }
        if (row.content) {
          await fsp.writeFile(target, row.content);
          if (await digestFile(target) !== row.installedSha256) fail('VULKAN_RUNTIME_SOURCE_CHANGED', 'ReShade 默认键写入后摘要不符。', { file: row.source });
        }
        await assertX64(target);
      }
      await atomicJson(path.join(stage, RECEIPT), receiptFor(exe, recipe, place));
      await noLinks(place.basePath);
      assertPathBudget({ basePath: place.basePath, recipe });
      await assertExeBucket(exe, place.exeRoot, stage);
      // A concurrently published directory must never be replaced by a
      // different full identity that happens to share either short prefix.
      if (fs.existsSync(place.basePath)) fail('VULKAN_RUNTIME_IDENTITY_COLLISION', 'Vulkan 短目录已被另一操作占用，未覆盖已有资产。');
      await fsp.rename(stage, place.basePath);
    } catch (error) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const result = await inspect({ exe, recipe, basePath: place.basePath });
    if (!result.ready) fail('VULKAN_RUNTIME_WRITE_VERIFY', 'Vulkan 运行资产发布后校验失败。', { blockers: result.blockers });
    return { ...location({ exe, recipe }), files: result.files, reused: false };
  }

  async function archive(input) {
    const exe = validateExe(input?.exe);
    if (typeof input?.basePath !== 'string' || !path.isAbsolute(input.basePath)) fail('VULKAN_RUNTIME_PATH_INVALID', '归档目录无效。');
    const basePath = path.resolve(input.basePath), exeRoot = path.dirname(basePath);
    locationKind(exe, basePath);
    await noLinks(exeRoot); await noLinks(basePath);
    const received = await readReceipt(basePath);
    if (!samePath(received.value.exe, exe) || path.basename(basePath).toLowerCase() !== received.value.packageId.toLowerCase()) {
      fail('VULKAN_RUNTIME_EXE_CHANGED', '归档记录与游戏 EXE 不一致，未移动文件。');
    }
    const destinationRoot = path.join(archiveRoot, received.value.exeId, received.value.packageId);
    await noLinks(destinationRoot);
    await fsp.mkdir(destinationRoot, { recursive: true });
    const archivePath = path.join(destinationRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
    await noLinks(archivePath);
    await fsp.rename(basePath, archivePath);
    return { archived: true, archivePath, basePath, coreVersion: received.recipe.coreVersion, packageId: received.recipe.id };
  }

  async function previewArchive(input) {
    const exe = validateExe(input?.exe), basePath = path.resolve(input?.basePath || '');
    locationKind(exe, basePath); await noLinks(basePath);
    const received = await readReceipt(basePath);
    if (!samePath(received.value.exe, exe) || path.basename(basePath).toLowerCase() !== received.value.packageId.toLowerCase())
      fail('VULKAN_RUNTIME_EXE_CHANGED', '归档记录与游戏 EXE 不一致。');
    const destinationRoot = path.join(archiveRoot, received.value.exeId, received.value.packageId), changes = [];
    async function visit(dir) {
      await noLinks(dir);
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name); await noLinks(file);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) {
          if (changes.length >= 4096) fail('VULKAN_RUNTIME_ARCHIVE_TOO_LARGE', '运行目录文件数量超出可检查范围。');
          changes.push({ path: file, name: entry.name, role: entry.name === RECEIPT ? 'receipt' : 'vulkan-runtime',
            action: 'archive', beforeSha256: await digestFile(file), afterSha256: null, destinationDirectory: destinationRoot, relativePath: path.relative(basePath, file) });
        } else fail('VULKAN_RUNTIME_ARCHIVE_INVALID', '运行目录出现非普通文件，未归档。');
      }
    }
    await visit(basePath);
    return { basePath, destinationRoot, changes, runtimeVerified: false };
  }
  return { location, prepare, inspect, archive, previewPrepare: input => prepare(input, true), previewArchive,
    identifyReceipt, pathBudget, assertPathBudget, runtimeRoot, archiveRoot };
}

module.exports = { createVulkanRuntimeProfile, MAX_PATH_CHARS };
