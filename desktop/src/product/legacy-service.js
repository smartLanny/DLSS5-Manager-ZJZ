'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { noLinks, inside, atomicJson } = require('./launch-safety');
const { createGameLaunchBroker } = require('./game-launch-broker');
const { createLegacyRuntime, DIRECTORY, RECEIPT } = require('./legacy-runtime');
const catalog = require('./legacy-runtime-catalog');
const { HASH, PE, relative, resolveFile, fileDigest, regularJson, fingerprint } = require('./feeder-runtime');
const { readLegacyFeederEvidence } = require('./feeder-runtime-evidence');
const { createExternalRuntime } = require('./external-runtime');
const { externalConfig, PATH_KEYS } = require('./external-profile-config');
const { sourceAllows, validSourceBinding } = require('./addon-source-binding');
const { snapshotAddonLoadingLayout } = require('./addon-loading-layout');
const { planAddonCompatibility } = require('./addon-compatibility');
const { isProtectedName } = require('./conflicts');
const ini = require('./launch-ini');
const { DEFAULT_RESHADE_KEY, MANAGED_RESHADE_DEFAULT_KEYS, ensureDefaultReShadeHotkey, hasKeyOverlay } = require('./hotkeys');

const PRODUCT = 'xiaofeng-feeder-0151';
const PENDING = '_DLSS5_Backup/xiaofeng-feeder-v2-pending.json';
const HISTORY = '_DLSS5_Backup/feeder-v2-history';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const locks = new Set();
const key = value => path.resolve(value).toLowerCase();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code: 'LEGACY_' + code, details }); };
const baseState = { route: 'feeder', provenance: 'Synthetic', scope: 'post-process', srInjected: false,
  fgInjected: false, runtimeVerified: false, loaded: 'unknown', processed: 'unknown' };

function selected(game) {
  const exe = game?.scan?.chosen?.path || game?.chosen?.path || game?.exe;
  if (typeof game?.id !== 'string' || !game.id || !path.isAbsolute(game.dir || '') || !path.isAbsolute(exe || '') ||
      !inside(game.dir, exe) || !/\.exe$/i.test(exe)) fail('GAME', '请先选择实际游戏 EXE。');
  const root = path.resolve(game.dir), exact = path.resolve(exe);
  return { id: game.id, root, exe: exact, dir: path.dirname(exact), receipt: resolveFile(root, RECEIPT), pending: resolveFile(root, PENDING) };
}
function localLayout(game, recipe = {}) {
  const t = selected(game), runtimeDir = path.join(t.dir, DIRECTORY);
  const chosen = game.scan?.chosen || game.chosen || {}, host = recipe.hostRequired ?? (Number(chosen.bitness) === 32 || ['dx9', 'dx10'].includes(chosen.apiResolution?.api));
  return { source: 'local', verified: true, gameDir: t.root, exePath: t.exe, runtimeDir,
    addonDirectory: path.join(runtimeDir, 'addons'), nrConfigDir: path.join(runtimeDir, 'addons', ...(host ? ['host64', 'addons'] : [])),
    activeConfigPath: path.join(t.dir, 'ReShade.ini'), generation: fingerprint({ product: PRODUCT, exe: key(t.exe), root: key(t.root) }) };
}
function layoutIdentity(layout) {
  return Object.fromEntries(['source', 'gameDir', 'exePath', 'runtimeDir', 'addonDirectory', 'nrConfigDir', 'activeConfigPath', 'generation']
    .map(name => [name, /(?:Dir|Directory|Path)$/.test(name) ? key(layout[name]) : layout[name]]));
}
function layoutRecord(layout) {
  return { ...Object.fromEntries(['source', 'gameDir', 'exePath', 'runtimeDir', 'addonDirectory', 'nrConfigDir', 'activeConfigPath', 'generation']
    .map(name => [name, layout[name]])), verified: true };
}
function pathFor(t, layout, spec) {
  if (!['game', 'runtime', 'addon'].includes(spec.base) || !relative(spec.target)) fail('TARGET', 'Feeder 文件目标无效。');
  return resolveFile(spec.base === 'game' ? t.dir : spec.base === 'runtime' ? layout.runtimeDir : layout.addonDirectory, spec.target);
}
function textBytes(bytes) {
  if (bytes.length > 256 * 1024) fail('CONFIG_SIZE', '配置文件超出可核对范围。');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('CONFIG_ENCODING', '配置不是可无损处理的 UTF-8 文本，已保留原文件。'); }
}
function valueOf(text, section, name) {
  let active = '', sections = 0, found = 0;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = ini.sectionHeader(line);
    if (header !== null) { active = header; if (header === section.toLowerCase()) sections++; continue; }
    const match = line.match(/^\s*([^;#][^=]*?)\s*=/);
    if (active === section.toLowerCase() && match?.[1].trim().toLowerCase() === name.toLowerCase()) found++;
  }
  if (sections > 1 || found > 1) fail('CONFIG_AMBIGUOUS', 'Feeder 需要的配置节或键重复，未猜测活动值。', { section, key: name });
  return ini.getIni(text, section, name);
}
function setValue(text, section, name, value) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  if (value !== null) return bom + ini.setIni(text, section, name, value);
  const newline = text.includes('\r\n') ? '\r\n' : '\n', lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let active = '';
  return bom + lines.filter(line => {
    const header = ini.sectionHeader(line); if (header !== null) { active = header; return true; }
    const match = line.match(/^\s*([^;#][^=]*?)\s*=/);
    return !(active === section.toLowerCase() && match?.[1].trim().toLowerCase() === name.toLowerCase());
  }).join(newline);
}
const tokens = value => (value || '').split(',').map(row => row.trim()).filter(Boolean);
function sameConfigValue(row, actual, expected, record) {
  if (actual === expected) return true;
  if (typeof actual !== 'string' || !actual || typeof expected !== 'string' || !expected || !path.isAbsolute(record.path || '')) return false;
  if (!['ADDON/AddonPath', 'GENERAL/PresetPath', 'GENERAL/EffectSearchPaths', 'GENERAL/TextureSearchPaths'].includes(`${row.section}/${row.name}`)) return false;
  const base = path.dirname(record.path);
  return same(path.resolve(base, actual), path.resolve(base, expected));
}
function panelOptions(config) {
  return { legacyDefaults: Boolean(config && config.panelDefault === undefined), panelDefault: config?.panelDefault ?? DEFAULT_RESHADE_KEY };
}
function configure(text, layout, recipe, seedText = text, { legacyDefaults = false, panelDefault = DEFAULT_RESHADE_KEY } = {}) {
  let result = seedText; const deltas = [];
  const settings = [
    ['ADDON', 'AddonPath', layout.addonDirectory, false],
    ['GENERAL', 'EffectSearchPaths', path.join(layout.runtimeDir, 'reshade-shaders', 'Shaders') + path.sep + '**', true],
    ['GENERAL', 'TextureSearchPaths', path.join(layout.runtimeDir, 'reshade-shaders', 'Textures') + path.sep + '**', true],
    ['GENERAL', 'PresetPath', path.join(layout.runtimeDir, 'ReShadePreset.ini'), false],
    ['GENERAL', 'PreprocessorDefinitions', recipe.defaults.definitions, true],
    ...(!legacyDefaults && !hasKeyOverlay(seedText) ? [['INPUT', 'KeyOverlay', `${panelDefault},0,0,0`, false]] : []),
    ...(recipe.gameApi === 'dx9' ? [['GENERAL', 'NoReloadOnInit', '1', false]] : [])
  ];
  for (const [section, name, desired, list] of settings) {
    const before = valueOf(result, section, name); let after = desired, removed = [], added = [];
    if (list) {
      const old = tokens(before), required = tokens(desired), ids = new Set(required.map(value => name === 'PreprocessorDefinitions' ? value.split('=')[0] : value));
      removed = old.filter(value => ids.has(name === 'PreprocessorDefinitions' ? value.split('=')[0] : value) && !required.includes(value));
      const retained = old.filter(value => !removed.includes(value)); added = required.filter(value => !retained.includes(value));
      after = [...retained, ...added].join(',');
    }
    if (before !== after) {
      result = setValue(result, section, name, after);
    }
  }
  const affected = new Map(settings.map(([section, name, , list]) => [section + '/' + name, { section, name, list }]));
  if (seedText !== text) for (const identity of [...PATH_KEYS, 'INSTALL/BasePath', 'ADDON/LoadFromDllMain']) {
    if (identity === 'SCREENSHOT/PostSaveCommand') continue;
    const [section, name] = identity.split('/'); if (!affected.has(identity)) affected.set(identity, { section, name, list: name === 'LoadFromDllMain' });
  }
  for (const { section, name, list } of affected.values()) {
    const before = valueOf(text, section, name), after = valueOf(result, section, name);
    if (before === after) continue;
    const a = list ? tokens(before) : [], b = list ? tokens(after) : [];
    deltas.push({ section, name, before, after, list, removed: a.filter(value => !b.includes(value)), added: b.filter(value => !a.includes(value)) });
  }
  return { text: result, deltas, seedText, beforeText: text, beforeHash: sha(Buffer.from(text)), afterHash: sha(Buffer.from(result)),
    ...(!legacyDefaults ? { panelDefault } : {}) };
}
function restoreConfiguration(current, record) {
  if (sha(Buffer.from(current)) === record.afterHash) return { text: record.beforeText, warnings: [] };
  let result = current; const warnings = [];
  for (const row of [...record.deltas].reverse()) {
    const now = valueOf(result, row.section, row.name);
    if (sameConfigValue(row, now, row.after, record)) { result = setValue(result, row.section, row.name, row.before); continue; }
    if (row.list) {
      let next = tokens(now).filter(value => !row.added.some(added => sameConfigValue(row, value, added, record)));
      for (const old of row.removed) {
        const occupied = row.name === 'PreprocessorDefinitions' && next.some(value => value.split('=')[0] === old.split('=')[0]);
        if (!occupied && !next.some(value => sameConfigValue(row, value, old, record))) next.push(old);
      }
      result = setValue(result, row.section, row.name, next.length ? next.join(',') : row.before === null ? null : '');
    } else warnings.push({ code: 'LEGACY_CONFIG_USER_CHANGE', section: row.section, key: row.name,
      message: '该配置值已由用户或另一组件修改，恢复时保留当前值。' });
  }
  return { text: result, warnings };
}

function createLegacyService(options = {}) {
  const overrides = options.overrides || {}, runtime = overrides.runtime || options.runtime || createLegacyRuntime(options);
  const guards = overrides.guards || options.guards || require('../core/install-guards'), pe = overrides.pe || options.pe || require('../core/pe');
  const copy = overrides.copyFile || options.copyFile || fsp.copyFile, writeJson = overrides.writeJson || options.writeJson || atomicJson;
  const plans = new Map(); let broker = overrides.broker || options.broker;
  const sourcePlanner = createExternalRuntime({ userData: options.userData || path.join(options.appDir || path.resolve(__dirname, '../..'), '.legacy-profile-context'),
    environment: options.environment, pe, guards });
  const getBroker = () => broker || (broker = createGameLaunchBroker({ resourcesPath: options.resourcesPath }));
  const validateStored = recipe => (runtime.validateStored || runtime.validate)(recipe);
  async function serial(t, fn) {
    const lock = key(t.root); if (locks.has(lock)) fail('BUSY', '该游戏正在处理 Feeder 文件。'); locks.add(lock);
    try { return await fn(); } finally { locks.delete(lock); }
  }
  async function closed(t) { await noLinks(t.root); await noLinks(t.exe); await guards.assertGameClosed(t.root, t.exe); }
  function pending(t) { return regularJson(t.pending, 2 * 1024 * 1024); }
  async function layoutFor(game, request = {}, recipe, live = false) {
    const expected = recipe.selection.loadingBackend;
    if (expected === 'local') {
      const derived = localLayout(game, recipe);
      if (request.layout && request.layout.source !== 'local') fail('LAYOUT', '本地 Feeder 不能写入另一加载后端的目录。');
      return derived;
    }
    const supplied = live ? await options.getLayout?.(game) || request.layout : request.layout || await options.getLayout?.(game);
    const layout = catalog.validateLayout(game, supplied);
    if (layout.source !== 'hoyoshade-profile' || layout.loadingBackend && layout.loadingBackend !== 'hoyoshade') fail('LAYOUT', '米哈游 Feeder 只能使用对应游戏已核验的外置配置。');
    if (live && typeof options.getLayout !== 'function') fail('LAYOUT', '应用米哈游 Feeder 前必须重新核对已落地的共享布局。');
    return { ...layout };
  }
  function validateReceipt(game, row) {
    const t = selected(game); if (!row) return null;
    if (row.schema !== 2 || row.product !== PRODUCT || !UUID.test(row.installId || '') || !same(row.game?.dir, t.root) || !same(row.game?.exe, t.exe) ||
        !HASH.test(row.exeSha256 || '') || !Array.isArray(row.files) || row.files.length > 160 || !row.config || !HASH.test(row.recipeFingerprint || '') ||
        fingerprint(row.recipe) !== row.recipeFingerprint) fail('RECEIPT', 'Feeder 收据与当前游戏或固定组件不一致。');
    validateStored(row.recipe); catalog.validateLayout(game, { ...row.layout, verified: true });
    if (row.recipe.selection.loadingBackend === 'local' && fingerprint(layoutIdentity(row.layout)) !== fingerprint(layoutIdentity(localLayout(game, row.recipe)))) fail('RECEIPT', '本地 Feeder 记录含其他目录。');
    if (!same(row.config.path, row.layout.activeConfigPath) || typeof row.config.beforeText !== 'string' || Buffer.byteLength(row.config.beforeText) > 256 * 1024 ||
        !HASH.test(row.config.afterHash || '') || !Array.isArray(row.config.deltas) || row.config.deltas.length > 32 ||
        typeof row.config.originalExisted !== 'boolean' || row.config.beforeHash !== sha(Buffer.from(row.config.beforeText))) fail('RECEIPT', '共享配置恢复记录无效。');
    const bindings = row.sourceBindings || [], sourceCopies = row.sourceCopies || [], isolated = row.isolatedAddons || [];
    if (!Array.isArray(bindings) || bindings.length > 32 || new Set(bindings.map(value => value.fingerprint)).size !== bindings.length ||
        bindings.some(value => !validSourceBinding(value, t.dir)) || !Array.isArray(sourceCopies) || sourceCopies.length > 128 ||
        !Array.isArray(isolated) || isolated.length > 128) fail('RECEIPT', '插件兼容恢复范围无效。');
    let seed = row.config.beforeText;
    if (row.config.sourceBinding) {
      const binding = bindings.find(value => value.fingerprint === row.config.sourceBinding), directNames = row.config.directNames;
      if (!binding || !Array.isArray(directNames) || directNames.length > 64 || directNames.some(name => typeof name !== 'string' || path.basename(name) !== name)) fail('RECEIPT', '插件显式加载恢复记录无效。');
      seed = externalConfig(binding.config, binding.configured.baseDir, binding.environment, { directLoads: directNames });
    }
    if (row.config.seedText !== undefined && row.config.seedText !== seed) fail('RECEIPT', 'ReShade 原路径重映射与源配置不一致。');
    if (row.config.panelDefault !== undefined && !MANAGED_RESHADE_DEFAULT_KEYS.includes(row.config.panelDefault)) fail('RECEIPT', 'ReShade 默认键配置版本无效。');
    const specOptions = panelOptions(row.config);
    const expected = configure(row.config.beforeText, row.layout, row.recipe, seed, specOptions);
    if (expected.afterHash !== row.config.afterHash || fingerprint(expected.deltas) !== fingerprint(row.config.deltas)) fail('RECEIPT', '共享配置恢复范围未匹配固定配置。');
    const specs = specifications(row.recipe, specOptions), seen = new Set();
    if (specs.length !== row.files.length) fail('RECEIPT', 'Feeder 收据的组件数量不匹配。');
    for (const item of row.files) {
      const spec = specs.find(value => value.base === item.base && value.target === item.target), file = spec && pathFor(t, row.layout, spec);
      if (!spec || !same(item.path, file) || seen.has(key(file)) || item.role !== spec.role || item.sha256 !== spec.sha256 || item.mutable !== spec.mutable || typeof item.owned !== 'boolean' ||
          !HASH.test(item.installedHash || '') || !item.mutable && item.installedHash !== spec.sha256) fail('RECEIPT', 'Feeder 收据含未知文件或错误身份。');
      seen.add(key(file));
    }
    const proof = item => {
      if (!UUID.test(item.operation || '') || !/^before\/\d+\.bin$/.test(item.snapshot || '')) fail('RECEIPT', '插件恢复快照标记无效。');
      const file = resolveFile(t.root, `${HISTORY}/${item.operation}/operation.json`);
      require('../core/file-journal').safePath(t.root, path.relative(t.root, file));
      const operation = regularJson(file, 2 * 1024 * 1024), index = Number(item.snapshot.slice(7, -4)), entry = operation?.files?.[index];
      if (!operation || operation.product !== PRODUCT || operation.operation !== item.operation || !same(operation.exe, t.exe) ||
          !entry || !same(entry.file, item.path)) fail('RECEIPT', '插件恢复记录与原文件事务不一致。');
      return { operation, entry };
    };
    for (const item of sourceCopies) {
      if (!item || !same(path.dirname(item.path || ''), row.layout.addonDirectory) || !path.isAbsolute(item.originPath || '') ||
          path.basename(item.path) !== path.basename(item.originPath) || isProtectedName(path.basename(item.path)) ||
          !['user-addon', 'user-sidecar', 'user-dependency'].includes(item.role) || !HASH.test(item.sha256 || '') ||
          !(item.role === 'user-addon' ? /\.addon(?:32|64)?$/i.test(item.path) : item.role === 'user-dependency' ? /\.dll$/i.test(item.path) : /\.(?:ini|json|toml|ya?ml)$/i.test(item.path)) ||
          item.mutable !== (item.role === 'user-sidecar') || !['explicit-keep', 'known-compatible', 'inactive'].includes(item.preservedBy) ||
          typeof item.owned !== 'boolean' || typeof item.mutable !== 'boolean' || seen.has(key(item.path))) fail('RECEIPT', '保留插件副本归属无效。');
      const binding = bindings.find(value => value.fingerprint === item.sourceBinding);
      if (!binding || !binding.files.some(value => same(value.path, item.originPath) || same(path.dirname(value.path), path.dirname(item.originPath)))) fail('RECEIPT', '保留插件副本未绑定原插件目录。');
      if (item.owned) { const { entry } = proof(item); if (entry.before !== null || entry.after !== item.sha256) fail('RECEIPT', '保留插件副本不是本轮创建的文件。'); }
      seen.add(key(item.path));
    }
    const isolatedSeen = new Set();
    for (const item of isolated) {
      const binding = bindings.find(value => value.fingerprint === item.sourceBinding);
      if (!item || !binding || !sourceAllows(binding, item.path, t.dir) || isolatedSeen.has(key(item.path)) || !HASH.test(item.sha256 || '')) fail('RECEIPT', '隔离插件未绑定原加载范围。');
      const { entry, operation } = proof(item);
      if (entry.before !== item.sha256 || !operation.receipt.sourceBindings?.some(value => value.fingerprint === binding.fingerprint)) fail('RECEIPT', '隔离插件恢复目标与原事务不同。');
      isolatedSeen.add(key(item.path));
    }
    return row;
  }
  function readReceipt(game) { return validateReceipt(game, regularJson(selected(game).receipt, 1024 * 1024)); }
  function specifications(recipe, { legacyDefaults = false, panelDefault = DEFAULT_RESHADE_KEY } = {}) {
    const files = recipe.files.map(row => ({ ...row }));
    const cfg = Buffer.from(recipe.defaults.feeder);
    files.push({ base: 'addon', target: 'dlss5-feed.cfg', role: 'provider-config', mutable: true, sha256: sha(cfg), bytes: cfg.length, content: cfg });
    if (recipe.hostRequired) {
      const original = '[ADDON]\r\nAddonPath=.\\addons\r\n';
      const data = Buffer.from(legacyDefaults ? original : ensureDefaultReShadeHotkey(original, panelDefault));
      files.push({ base: 'addon', target: 'host64/ReShade.ini', role: 'host-config', mutable: false, sha256: sha(data), bytes: data.length, content: data });
    }
    if (recipe.gameApi === 'dx9') {
      if (typeof recipe.defaults.hostGuides !== 'string' || Buffer.byteLength(recipe.defaults.hostGuides) > 64 * 1024) fail('PACKAGE', 'DX9 配套缺少固定宿主引导配置。');
      const data = Buffer.from(recipe.defaults.hostGuides);
      files.push({ base: 'addon', target: 'host64/NRGuides.ini', role: 'host-guides', mutable: false, sha256: sha(data), bytes: data.length, content: data });
    }
    return files;
  }
  function isHostConfiguration(spec) {
    return spec?.base === 'addon' && (spec.role === 'host-config' && spec.target === 'host64/ReShade.ini' ||
      spec.role === 'host-guides' && spec.target === 'host64/NRGuides.ini');
  }
  async function hostConfigurationBytes(file) {
    await noLinks(file);
    if ((await fsp.stat(file)).size > 256 * 1024) fail('CONFIG_SIZE', '宿主配置超出可核对范围，保留原文件。', { file });
    return bytesAt(file);
  }
  function savedHostConfiguration(spec, bytes) {
    if (!isHostConfiguration(spec)) return false;
    const text = textBytes(bytes), original = textBytes(spec.content), seen = new Set(); let section = '';
    for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const header = ini.sectionHeader(line);
      if (header !== null) { section = header; continue; }
      if (!line.trim() || /^\s*[;#]/.test(line)) continue;
      const match = line.match(/^\s*([^;#][^=]*?)\s*=\s*(.*)$/);
      if (!match) fail('HOST_CONFIG_CHANGED', '宿主配置含无法核对的 INI 内容，保留原文件。');
      const name = match[1].trim().toLowerCase(), identity = `${section}/${name}`;
      if (seen.has(identity)) fail('HOST_CONFIG_CHANGED', '宿主配置含重复配置键，保留原文件。');
      seen.add(identity);
      if (section === 'addon' && name !== 'addonpath' && (match[2].trim() || !['loadfromdllmain', 'disabledaddons'].includes(name)))
        fail('HOST_CONFIG_CHANGED', '宿主插件加载清单已改变，保留原文件。');
    }
    const required = [['ADDON', 'AddonPath'], ['GENERAL', 'EffectSearchPaths'], ['GENERAL', 'TextureSearchPaths'],
      ['GENERAL', 'PresetPath'], ['GENERAL', 'PreprocessorDefinitions'], ['GENERAL', 'NoReloadOnInit']];
    for (const [group, name] of required) {
      const actual = valueOf(text, group, name), expected = valueOf(original, group, name);
      if ((actual || '') !== (expected || '')) fail('HOST_CONFIG_CHANGED', '宿主所需的插件、着色器或引导配置已改变，保留原文件。', { section: group, key: name });
    }
    return true;
  }
  async function currentHash(file) { const value = await fileDigest(file); return value || null; }
  async function bytesAt(file) { await noLinks(file); return fsp.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); }
  async function assertNoOtherOwner(t, layout) {
    if (pending(t)) fail('RECOVERY_FIRST', 'Feeder 有未完成事务，请先恢复。');
    for (const file of [path.join(t.root, '_DLSS5_Backup/pending-switch.json'), path.join(layout.runtimeDir, '_DLSS5_Backup/pending-switch.json')])
      if (fs.existsSync(file)) fail('OTHER_OWNER', '当前游戏或共享目录有其他未完成事务。');
    if (fs.existsSync(path.join(t.root, '_DLSS5_Backup/xiaofeng-manager.json'))) fail('OTHER_OWNER', '原生输入配套仍有活动记录，请先恢复后再准备 Feeder。');
    const external = fs.existsSync(path.join(t.root, '_DLSS5_Backup/xiaofeng-external.json'));
    if (external && layout.source !== 'hoyoshade-profile') fail('OTHER_OWNER', '已有外置加载所有者，请先选择其绑定的 Feeder 布局。');
  }
  function selectionFor(game, request, old) {
    const chosen = game.scan?.chosen || game.chosen || {}, supplied = request.selection || request;
    const inferred = { api: supplied.api || chosen.apiResolution?.api || chosen.api,
      architecture: supplied.architecture || (Number(chosen.bitness) === 32 ? 'x86' : Number(chosen.bitness) === 64 ? 'x64' : null),
      hardwareFamily: supplied.hardwareFamily || options.hardware?.family,
      loadingBackend: supplied.loadingBackend || (request.layout?.source === 'hoyoshade-profile' ? 'hoyoshade' : 'local'), proxyEntry: supplied.proxyEntry || 'auto' };
    if (old) {
      const value = { ...old.recipe.selection };
      for (const name of Object.keys(value)) if (supplied[name] !== undefined) value[name] = supplied[name];
      const sameSelection = old.recipe.externalProvider
        ? fingerprint(value) === fingerprint(old.recipe.selection)
        : fingerprint(catalog.resolve(value)) === fingerprint(catalog.resolve(old.recipe.selection));
      if (!sameSelection) fail('RESTORE_FIRST', '修复保留原配套版本和加载路线；切换前请先恢复。');
      return old.recipe.selection;
    }
    // External V1 packages own their route schema and can add an API without
    // teaching the frozen bundled catalog about a new hard-coded recipe. The
    // runtime verifies that strict route and every source digest immediately
    // below; the old catalog remains authoritative when no external package is
    // selected.
    if (!runtime.externalProviders?.selectedId?.()) catalog.resolve(inferred);
    return inferred;
  }
  async function verifySource(game, request = {}) {
    const t = selected(game), old = readReceipt(game), selection = selectionFor(game, request, old);
    const pkg = await runtime.verify(old ? { root: runtime.root, recipe: old.recipe, fingerprint: old.recipeFingerprint } : selection);
    if (old && pkg.fingerprint !== old.recipeFingerprint) fail('PINNED_PACKAGE_UNAVAILABLE', '原配套来源当前不可用，等待不会改装另一版本。');
    if (request.version !== undefined && ![pkg.recipe.id, pkg.recipe.coreVersion].includes(request.version)) fail('VERSION', '所选版本没有对应完整 Feeder 配套。');
    if (pe.getBitness(t.exe) !== (selection.architecture === 'x86' ? 32 : 64)) fail('ARCHITECTURE', 'Feeder 位数必须匹配实际 EXE。');
    return { ready: true, packageId: pkg.recipe.id, coreVersion: pkg.recipe.coreVersion, identity: pkg.fingerprint, runtimeVerified: false };
  }
  async function compile(game, request = {}) {
    const t = selected(game); await closed(t); const old = readReceipt(game), selection = selectionFor(game, request, old);
    const pkg = await runtime.verify(old ? { root: runtime.root, recipe: old.recipe, fingerprint: old.recipeFingerprint } : selection), recipe = pkg.recipe;
    if (old && pkg.fingerprint !== old.recipeFingerprint) fail('PINNED_PACKAGE_UNAVAILABLE', '原配套来源当前不可用，修复不会改装另一版本；可先恢复。');
    if (request.version !== undefined && ![recipe.id, recipe.coreVersion].includes(request.version)) fail('VERSION', '所选版本没有对应完整 Feeder 配套，未替换原选择。');
    if (pe.getBitness(t.exe) !== (selection.architecture === 'x86' ? 32 : 64)) fail('ARCHITECTURE', 'Feeder 位数必须匹配实际 EXE。');
    const layout = await layoutFor(game, request, recipe); await noLinks(layout.runtimeDir); await noLinks(layout.addonDirectory); await noLinks(layout.activeConfigPath);
    await assertNoOtherOwner(t, layout);
    if (old && fingerprint(layoutIdentity(layout)) !== fingerprint(layoutIdentity(old.layout))) fail('LAYOUT_CHANGED', '共享加载布局已变更，请先恢复原 Feeder 配套。');
    // MGR#27: copying a local proxy/Feeder recipe is not a launch request.
    // Target, PE bitness, closed-game, ownership and full-file identity checks
    // remain mandatory. Actual startup still uses the ordinary-token broker.
    // HoYo has a separate bound/elevated launch workflow; keep its preflight.
    if (layout.source === 'hoyoshade-profile') {
      const level = require('./game-launch-broker').executionLevel(t.exe);
      const needsHoYoElevation = ['requireAdministrator', 'highestAvailable'].includes(level);
      const launch = needsHoYoElevation ? { launchable: true, elevated: true } : await getBroker().inspect({ exe: t.exe });
      if (launch?.launchable !== true || launch.elevated !== false && !needsHoYoElevation) fail('LAUNCH', '尚不能确认此 EXE 的已支持启动方式，未写入配套。');
    }
    const projected = layout.projectedFiles || [], projectedConfig = layout.projectedConfig;
    if (projected.length > 256 || projected.some(row => !path.isAbsolute(row.path || '') || row.sha256 !== null && !HASH.test(row.sha256 || ''))) fail('LAYOUT', '共享配置预览文件无效。');
    const expectedBefore = async file => {
      const planned = projected.find(row => same(row.path, file));
      return planned ? planned.sha256 : currentHash(file);
    };
    const observedConfig = await bytesAt(layout.activeConfigPath);
    const specOptions = panelOptions(old?.config);
    const materialized = layout.source === 'local' || observedConfig !== null;
    let migration = null;
    if (materialized) {
      const declared = [...(layout.source === 'hoyoshade-profile' ? layout.knownComponents || [] : []), ...(options.getKnownComponents ? await options.getKnownComponents(game) : [])];
      const chosen = specifications(recipe, specOptions).filter(row => ['core', 'provider'].includes(row.role)).map(row => ({ path: pathFor(t, layout, row), sha256: row.sha256 }));
      const known = [...declared, ...specifications(recipe, specOptions).filter(row => ['core', 'provider'].includes(row.role)).map(row => ({ role: row.role, sha256: row.sha256 })),
        ...(old?.sourceCopies || []).filter(row => ['explicit-keep', 'known-compatible'].includes(row.preservedBy)).map(row => ({ path: row.path, sha256: row.sha256,
          role: 'user-addon', compatibility: 'compatible', compatibilitySource: row.preservedBy }))];
      migration = await sourcePlanner.planAddonMigration(game, { architecture: selection.architecture === 'x86' ? 32 : 64,
        knownComponents: known, keep: request.addonKeep || request.keepAddons || [], selectedComponents: chosen,
        excludePaths: [...specifications(recipe, specOptions).map(row => pathFor(t, layout, row)), ...(old?.sourceCopies || []).map(row => row.path)]
          .filter(file => same(path.dirname(file), layout.addonDirectory)) });
      if (layout.source === 'local' && migration.binding.environment.RESHADE_BASE_PATH_OVERRIDE)
        fail('GLOBAL_PATH_OVERRIDE', '全局 ReShade 路径覆盖仍在使用，请先恢复该覆盖后再建立独立本地 Feeder 配置。');
    }
    let original = observedConfig ? textBytes(observedConfig) : '';
    if (projectedConfig) {
      if (typeof projectedConfig.text !== 'string' || Buffer.byteLength(projectedConfig.text) > 256 * 1024 || sha(Buffer.from(projectedConfig.text)) !== projectedConfig.sha256)
        fail('LAYOUT', '共享配置预览内容与摘要不一致。');
      original = projectedConfig.text;
    }
    const seed = !old && migration && layout.source === 'local' ? externalConfig(migration.binding.config, migration.binding.configured.baseDir,
      migration.binding.environment, { directLoads: migration.directNames }) : original;
    const config = old ? old.config : { ...configure(original, layout, recipe, seed), originalExisted: projectedConfig ? true : observedConfig !== null,
      path: layout.activeConfigPath, ...(seed !== original ? { sourceBinding: migration.binding.fingerprint, directNames: migration.directNames } : {}) };
    if (old) validateConfig(original, old.config);
    const planId = crypto.randomUUID(), rows = [], changes = [], isolatedByPath = new Map((migration?.isolated || []).map(row => [key(row.path), row]));
    for (const spec of specifications(recipe, specOptions)) {
      const file = pathFor(t, layout, spec), before = await expectedBefore(file), previous = old?.files.find(row => same(row.path, file));
      const hostSaved = Boolean(old && before && before !== spec.sha256 && isHostConfiguration(spec) && savedHostConfiguration(spec, await hostConfigurationBytes(file)));
      if (before && spec.mutable && fs.existsSync(file) && (await fsp.stat(file)).size > 256 * 1024) fail('CONFIG_SIZE', 'Feeder 配置超出可核对范围，保留原文件。', { file });
      if (before && !spec.mutable && !hostSaved && before !== spec.sha256 && (old || !isolatedByPath.has(key(file)))) fail('FILE_CHANGED', 'Feeder 目标已有不同文件，未覆盖。', { file });
      if (old && !before && previous.owned !== true) fail('BORROWED_MISSING', '安装前已有的用户文件已缺失，修复不会接管它。', { file });
      const after = before && (spec.mutable || hostSaved) ? before : spec.sha256;
      const owned = previous ? previous.owned : before === null || isolatedByPath.has(key(file));
      rows.push({ base: spec.base, target: spec.target, path: file, role: spec.role, sha256: spec.sha256,
        installedHash: previous?.installedHash || after, mutable: spec.mutable, owned });
      changes.push({ file, role: spec.role, before, after, mutable: spec.mutable || hostSaved, source: spec.content ? null : resolveFile(pkg.root, spec.source), content: spec.content || null });
    }
    const sourceCopies = structuredClone(old?.sourceCopies || []), sourceBindings = structuredClone(old?.sourceBindings || []);
    for (const saved of sourceCopies) {
      const before = await expectedBefore(saved.path);
      if (before && !saved.mutable && before !== saved.sha256) fail('FILE_CHANGED', '受管保留插件副本被外部修改，未覆盖。', { file: saved.path });
      if (!before && !saved.owned) fail('BORROWED_MISSING', '原本已有的插件缺失，修复不会接管它。', { file: saved.path });
      const source = saved.owned ? historyFile(t, saved.operation, saved.snapshot.replace('before/', 'after/')) : saved.originPath;
      changes.push({ file: saved.path, role: saved.role, before, after: before || saved.sha256, mutable: saved.mutable, source });
    }
    if (migration && !sourceBindings.some(row => row.fingerprint === migration.binding.fingerprint) &&
        (migration.rows.length || migration.isolated.length || config.sourceBinding === migration.binding.fingerprint)) sourceBindings.push(migration.binding);
    for (const source of migration?.rows || []) {
      const file = path.join(layout.addonDirectory, source.name), before = await expectedBefore(file), previous = sourceCopies.find(row => same(row.path, file));
      if (changes.some(row => same(row.file, file))) fail('ADDON_COLLISION', '保留插件与 Feeder 组件同名，未猜测覆盖顺序。', { file });
      if (before && before !== source.sha256) fail('ADDON_COLLISION', '保留插件目标已有不同文件，未覆盖。', { file });
      const decision = migration.compatibility.decisions.find(row => same(row.path, source.originPath));
      const row = previous || { path: file, originPath: source.originPath, role: source.role, mutable: source.mutable,
        sha256: source.sha256, owned: before === null, sourceBinding: migration.binding.fingerprint,
        preservedBy: decision?.explicitKeep ? 'explicit-keep' : decision?.action === 'keep' ? 'known-compatible' : 'inactive', operation: planId, snapshot: null };
      if (!previous) sourceCopies.push(row);
      changes.push({ file, role: source.role, before, after: source.sha256, mutable: source.mutable, source: source.source });
    }
    const isolatedAddons = structuredClone(old?.isolatedAddons || []);
    for (const source of migration?.isolated || []) {
      if (isolatedAddons.some(row => same(row.path, source.path))) fail('ADDON_REAPPEARED', '已隔离插件在原位置重新出现，请先核对保留的恢复快照。', { file: source.path });
      if (!changes.some(row => same(row.file, source.path))) changes.unshift({ file: source.path, role: 'source-addon', before: source.sha256, after: null });
      isolatedAddons.push({ path: source.path, sha256: source.sha256, sourceBinding: migration.binding.fingerprint,
        operation: planId, snapshot: null, reason: source.reason, action: source.action });
    }
    const configBefore = await expectedBefore(layout.activeConfigPath), configAfter = old ? configBefore : config.afterHash;
    changes.push({ file: layout.activeConfigPath, role: 'shared-config', before: configBefore, after: configAfter,
      content: old ? Buffer.from(original) : Buffer.from(config.text), mutable: true });
    const exeHash = await currentHash(t.exe), receipt = old ? structuredClone(old) : { schema: 2, product: PRODUCT, installId: crypto.randomUUID(),
      game: { dir: t.root, exe: t.exe }, exeSha256: exeHash, recipe, recipeFingerprint: pkg.fingerprint, layout: layoutRecord(layout),
      files: rows, config: Object.fromEntries(Object.entries(config).filter(([name]) => !['text'].includes(name))), installedAt: new Date().toISOString(), lastLaunch: null };
    receipt.sourceBindings = sourceBindings; receipt.sourceCopies = sourceCopies; receipt.isolatedAddons = isolatedAddons;
    const effects = changes.filter(row => row.before !== row.after);
    for (const row of [...sourceCopies.filter(row => row.owned && row.operation === planId), ...isolatedAddons.filter(row => row.operation === planId)]) {
      const index = effects.findIndex(value => same(value.file, row.path)); if (index < 0) fail('ADDON_RECORD', '插件操作缺少恢复快照映射。');
      row.snapshot = `before/${index}.bin`;
    }
    receipt.exeSha256 = exeHash; receipt.updatedAt = new Date().toISOString(); receipt.antiCheatConfirmed ||= request.allowAntiCheat === true;
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    if (receiptBytes.length > 1024 * 1024 || sourceBindings.length > 32 || sourceCopies.length > 128 || isolatedAddons.length > 128)
      fail('LIMIT', 'Feeder 恢复记录超出可可靠保存的范围，请先恢复已有配套。');
    changes.push({ file: t.receipt, role: 'receipt', before: await currentHash(t.receipt), after: sha(receiptBytes), content: receiptBytes });
    if (changes.length > 256 || changes.some(row => row.file.length > 259)) fail('LIMIT', 'Feeder 目录或文件数量超出可用范围。');
    const plan = { id: planId, game, t, pkg, recipe, layout: layoutRecord(layout), migration, projected,
      exeHash, changes, receipt, old: Boolean(old), requiresAntiCheat: guards.antiCheatPresent?.(t.root) === true && !receipt.antiCheatConfirmed };
    plan.fingerprint = fingerprint({ game: t.exe, exeHash, recipe: pkg.fingerprint, layout: layoutIdentity(layout),
      changes: changes.map(row => ({ path: key(row.file), before: row.before, after: row.after })) });
    return plan;
  }
  function publicPlan(plan, operation = 'install') {
    return { ...baseState, planId: plan.id, fingerprint: plan.fingerprint, packageId: plan.recipe.id, version: plan.recipe.coreVersion,
      coreVersion: plan.recipe.coreVersion, api: plan.recipe.gameApi, architecture: plan.recipe.architecture, loadingBackend: plan.recipe.loadingBackend,
      mode: plan.layout.source === 'local' ? 'local' : 'hoyoshade', layout: plan.layout, hostRequired: plan.recipe.hostRequired,
      compatibility: plan.migration?.compatibility || null,
      validation: plan.recipe.acceptance, requiresAntiCheat: plan.requiresAntiCheat === true, requiresConfirmation: true,
      changes: plan.changes.map(row => ({ path: row.file, name: path.basename(row.file), role: row.role, beforeSha256: row.before, afterSha256: row.after,
        mutable: row.mutable === true, action: row.before === row.after ? 'keep' : row.after === null ? 'remove' : row.before === null ? 'create' : 'replace' })), operation };
  }
  async function previewInstall(game, request = {}) {
    const plan = await compile(game, request); if (plans.size >= 32) plans.delete(plans.keys().next().value);
    plans.set(plan.id, plan); return publicPlan(plan);
  }
  function validateConfig(text, config) {
    for (const row of config.deltas) {
      const value = valueOf(text, row.section, row.name);
      // This is an editable initial UI binding, not a loading dependency.
      if (row.section === 'INPUT' && row.name === 'KeyOverlay') continue;
      if (row.list ? row.added.some(token => !tokens(value).some(actual => sameConfigValue(row, actual, token, config))) : !sameConfigValue(row, value, row.after, config))
        fail('CONFIG_CHANGED', 'Feeder 所需的活动配置已改变，请核对或恢复。', { section: row.section, key: row.name });
    }
  }
  async function inspect(game) {
    const t = selected(game), row = readReceipt(game), state = pending(t);
    if (!row) return { ...baseState, installed: false, ready: false, available: !state, needsRecovery: Boolean(state),
      reason: state ? 'Feeder 有未完成事务，请先恢复。' : null };
    const blockers = [];
    if (state) blockers.push('Feeder 有未完成事务，请先恢复。');
    if (await currentHash(t.exe) !== row.exeSha256) blockers.push('游戏 EXE 已更新，请重新预览并修复绑定。');
    let layout;
    try { layout = await layoutFor(game, { layout: row.layout }, row.recipe, row.layout.source !== 'local');
      if (fingerprint(layoutIdentity(layout)) !== fingerprint(layoutIdentity(row.layout))) fail('LAYOUT_CHANGED', '共享加载布局已改变。'); }
    catch (error) { blockers.push(error.message); }
    const components = [];
    const specs = specifications(row.recipe, panelOptions(row.config));
    for (const file of [...row.files, ...(row.sourceCopies || [])]) {
      let actual = null; try { actual = await currentHash(file.path); } catch (error) { blockers.push(error.message); }
      let valid = actual !== null && (file.mutable ? (await fsp.stat(file.path)).size <= 256 * 1024 : actual === file.sha256);
      const spec = specs.find(value => value.base === file.base && value.target === file.target);
      if (actual && !valid && isHostConfiguration(spec)) try {
        valid = savedHostConfiguration(spec, await hostConfigurationBytes(file.path));
      } catch (error) { blockers.push(error.message); }
      if (!valid) blockers.push(`${path.basename(file.path)} 缺失或已变化。`);
      components.push({ ...file, actual, valid });
    }
    try { const bytes = await bytesAt(row.config.path); if (!bytes) fail('CONFIG_MISSING', 'Feeder 活动配置缺失。'); validateConfig(textBytes(bytes), row.config); }
    catch (error) { blockers.push(error.message); }
    let compatibility = null;
    try {
      const snapshot = await snapshotAddonLoadingLayout({ exeDir: t.dir, gameId: game.id, architecture: row.recipe.architecture === 'x86' ? 32 : 64,
        environment: options.environment || process.env });
      if (!same(snapshot.profile.activeConfigPath, row.layout.activeConfigPath) || !same(snapshot.profile.addonDir, row.layout.addonDirectory))
        fail('CONFIG_CHANGED', 'ReShade 实际使用的配置和插件目录与 Feeder 收据不一致。');
      const known = [...(layout?.source === 'hoyoshade-profile' ? layout.knownComponents || [] : []), ...(options.getKnownComponents ? await options.getKnownComponents(game) : []),
        ...row.files.filter(file => ['provider', 'core'].includes(file.role)).map(file => ({ path: file.path, sha256: file.sha256, role: file.role })),
        ...(row.sourceCopies || []).filter(file => ['explicit-keep', 'known-compatible'].includes(file.preservedBy)).map(file => ({ path: file.path,
          sha256: file.sha256, role: 'user-addon', compatibility: 'compatible' }))];
      compatibility = planAddonCompatibility(snapshot, { knownComponents: known,
        selectedComponents: row.files.filter(file => ['provider', 'core'].includes(file.role)).map(file => ({ path: file.path, sha256: file.sha256 })) });
      if (compatibility.blockers.length || compatibility.isolate.length || compatibility.retire.length) blockers.push('活动插件清单出现未确认项目，请重新预览兼容处理。');
    } catch (error) { blockers.push(error.message); }
    const evidence = await readLegacyFeederEvidence({ layout: row.layout, lastLaunch: row.lastLaunch, hostRequired: row.recipe.hostRequired });
    return { ...baseState, ...evidence, installed: true, ready: blockers.length === 0, available: true, needsRecovery: Boolean(state), blockers,
      reason: blockers[0] || null, api: row.recipe.gameApi, architecture: row.recipe.architecture, loadingBackend: row.recipe.loadingBackend,
      packageId: row.recipe.id, coreVersion: row.recipe.coreVersion, version: row.recipe.coreVersion, recipeFingerprint: row.recipeFingerprint,
      validation: row.recipe.acceptance, layout: row.layout, components, compatibility, lastLaunch: row.lastLaunch, hostRequired: row.recipe.hostRequired };
  }
  function summary(game) {
    try { const t = selected(game), row = readReceipt(game), state = pending(t);
      return { ...baseState, installed: Boolean(row), ready: false, available: !state, needsRecovery: Boolean(state),
        packageId: row?.recipe.id || null, coreVersion: row?.recipe.coreVersion || null, api: row?.recipe.gameApi || null,
        architecture: row?.recipe.architecture || null, loadingBackend: row?.recipe.loadingBackend || null,
        reason: state ? 'Feeder 有未完成事务，请先恢复。' : null }; }
    catch (error) { return { ...baseState, installed: false, ready: false, available: false, needsRecovery: /RECEIPT|RECOVERY/.test(error.code || ''), reason: error.message }; }
  }
  function historyFile(t, operation, leaf) {
    if (!UUID.test(operation) || !/^(?:before|after)\/\d+\.bin$/.test(leaf)) fail('RECOVERY', 'Feeder 快照位置无效。');
    return resolveFile(t.root, `${HISTORY}/${operation}/${leaf}`);
  }
  function claimPath(file, operation, index) { return path.join(path.dirname(file), `.dlss5-feeder-${operation}-${index}.held`); }
  function recoveryClaimPath(file, operation, index) {
    return path.join(path.dirname(file), `.dlss5-feeder-${operation}-${index}.recovery`, 'after.bin');
  }
  async function checkPlan(plan, live = true) {
    await closed(plan.t);
    if (await currentHash(plan.t.exe) !== plan.exeHash) fail('PLAN_CHANGED', '预览后游戏 EXE 已变更。');
    const layout = await layoutFor(plan.game, { layout: plan.layout }, plan.recipe, live && plan.layout.source !== 'local');
    if (fingerprint(layoutIdentity(layout)) !== fingerprint(layoutIdentity(plan.layout))) fail('PLAN_CHANGED', '预览后共享加载布局已变更。');
    for (const row of plan.changes) if (await currentHash(row.file) !== row.before) fail('PLAN_CHANGED', '预览后目标文件已变化，请重新预览。', { file: row.file });
    if (plan.migration) await plan.migration.guard();
    for (const row of plan.projected || []) if (await currentHash(row.path) !== row.sha256) fail('PLAN_CHANGED', '共享配置发布结果与已确认预览不同。', { file: row.path });
    if (plan.layout.source === 'hoyoshade-profile' && !plan.migration && plan.projected?.length) {
      const snapshot = await snapshotAddonLoadingLayout({ exeDir: plan.t.dir, gameId: plan.game.id,
        architecture: plan.recipe.architecture === 'x86' ? 32 : 64, environment: options.environment || process.env });
      const expected = new Map([...plan.projected.map(row => [key(row.path), row.sha256]), ...plan.changes.map(row => [key(row.file), row.before])]);
      if (snapshot.blockers.length || snapshot.files.some(row => row.moduleMayLoad && expected.get(key(row.path)) !== row.sha256))
        fail('PLAN_CHANGED', '米哈游配置发布后出现未在预览中确认的插件，未扩大操作范围。');
    }
  }
  async function recoverState(game, state) {
    const t = selected(game); await closed(t);
    if (!state || state.schema !== 1 || state.product !== PRODUCT || !UUID.test(state.operation || '') ||
        !same(state.exe, t.exe) || !same(state.root, t.root) || !['install', 'restore'].includes(state.kind) ||
        !Array.isArray(state.files) || state.files.length > 256 || !state.receipt || state.receipt.product !== PRODUCT)
      fail('RECOVERY', 'Feeder 恢复记录归属无效。');
    validateReceipt(game, state.receipt);
    const layout = await layoutFor(game, { layout: state.receipt.layout }, state.receipt.recipe, state.receipt.layout.source !== 'local');
    if (fingerprint(layoutIdentity(layout)) !== fingerprint(layoutIdentity(state.receipt.layout))) fail('RECOVERY', '恢复记录的共享布局不匹配。');
    const specs = new Map(specifications(state.receipt.recipe, panelOptions(state.receipt.config)).map(spec => [key(pathFor(t, layout, spec)), spec]));
    const allowed = new Set(specs.keys());
    for (const row of [...(state.receipt.sourceCopies || []), ...(state.receipt.isolatedAddons || [])]) allowed.add(key(row.path));
    allowed.add(key(t.receipt)); allowed.add(key(layout.activeConfigPath)); const seen = new Set();
    for (let i = 0; i < state.files.length; i++) {
      const row = state.files[i];
      if (!allowed.has(key(row.file || '')) || seen.has(key(row.file)) || row.before !== null && !HASH.test(row.before || '') || row.after !== null && !HASH.test(row.after || ''))
        fail('RECOVERY', 'Feeder 恢复记录含其他组件文件。');
      seen.add(key(row.file)); await noLinks(row.file);
      for (const side of ['before', 'after']) if (row[side] !== null && await currentHash(historyFile(t, state.operation, `${side}/${i}.bin`)) !== row[side]) fail('RECOVERY', 'Feeder 恢复快照缺失或变化。');
      const spec = specs.get(key(row.file));
      const isolated = state.receipt.isolatedAddons?.find(value => same(value.path, row.file));
      const copied = state.receipt.sourceCopies?.find(value => same(value.path, row.file));
      if (spec) {
        const ownership = state.receipt.files.find(value => same(value.path, row.file));
        const hostSaved = state.kind === 'restore' && row.before !== null && row.before !== spec.sha256 && isHostConfiguration(spec) &&
          savedHostConfiguration(spec, await hostConfigurationBytes(historyFile(t, state.operation, `before/${i}.bin`)));
        if (!ownership || state.kind === 'install' && row.after !== spec.sha256 ||
            state.kind === 'restore' && (!ownership.owned || row.after !== (isolated?.sha256 || null)) ||
            !spec.mutable && !hostSaved && row.before !== null && row.before !== spec.sha256 && !(state.kind === 'install' && isolated?.operation === state.operation && row.before === isolated.sha256))
          fail('RECOVERY', '恢复动作与固定组件及原所有权不一致。');
      } else if (copied) {
        if (state.kind === 'install' ? row.after !== copied.sha256 || row.before !== null : !copied.owned || row.after !== null || !copied.mutable && row.before !== copied.sha256)
          fail('RECOVERY', '保留插件副本动作与原归属不一致。');
      } else if (isolated) {
        if (state.kind === 'install' ? row.before !== isolated.sha256 || row.after !== null : row.before !== null || row.after !== isolated.sha256)
          fail('RECOVERY', '隔离插件恢复动作与原件不一致。');
      } else if (same(row.file, t.receipt)) {
        const expected = sha(Buffer.from(JSON.stringify(state.receipt, null, 2) + '\n'));
        if (state.kind === 'install' ? row.after !== expected : row.before !== expected || row.after !== null) fail('RECOVERY', '恢复收据不匹配原事务。');
      } else if (state.kind === 'install') {
        if (row.after !== state.receipt.config.afterHash || row.before !== (state.receipt.config.originalExisted ? state.receipt.config.beforeHash : null)) fail('RECOVERY', '共享配置动作与首装原件不一致。');
      } else {
        const original = textBytes(await fsp.readFile(historyFile(t, state.operation, `before/${i}.bin`)));
        const restored = restoreConfiguration(original, state.receipt.config).text;
        const expected = !state.receipt.config.originalExisted && !restored.trim() ? null : sha(Buffer.from(restored));
        if (row.after !== expected) fail('RECOVERY', '共享配置恢复动作超出原变更范围。');
      }
      const recoveryClaim = recoveryClaimPath(row.file, state.operation, i); await noLinks(recoveryClaim);
      const current = await currentHash(row.file), held = await currentHash(claimPath(row.file, state.operation, i)), displaced = await currentHash(recoveryClaim);
      if (current !== row.before && current !== row.after && current !== null || held !== null && held !== row.before || displaced !== null && displaced !== row.after)
        fail('FILE_CHANGED', '中断后目标文件被外部修改，保留当前文件和恢复快照。', { file: row.file });
    }
    for (let i = state.files.length - 1; i >= 0; i--) {
      const row = state.files[i], current = await currentHash(row.file), claim = claimPath(row.file, state.operation, i), recoveryClaim = recoveryClaimPath(row.file, state.operation, i);
      await closed(t);
      if (current !== row.before) {
        if (current !== null) {
          if (await currentHash(row.file) !== row.after) fail('FILE_CHANGED', '恢复前文件再次变化。');
          await noLinks(recoveryClaim);
          const directory = path.dirname(recoveryClaim);
          try { await fsp.mkdir(directory); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // An empty directory is the only pre-claim interrupted state. Never
            // rename over a retained candidate, even when its bytes are known.
            if ((await fsp.readdir(directory)).length) fail('FILE_CHANGED', '恢复暂存已有文件，保留当前目标及暂存文件。', { file: row.file, retainedAt: recoveryClaim });
          }
          await fsp.rename(row.file, recoveryClaim);
          if (await currentHash(recoveryClaim) !== row.after)
            fail('FILE_CHANGED', '目标在恢复取得时被替换，保留取得的文件及恢复记录。', { file: row.file, retainedAt: recoveryClaim });
        }
        if (row.before !== null) {
          const source = historyFile(t, state.operation, `before/${i}.bin`);
          if (await currentHash(source) !== row.before) fail('RECOVERY', '原文件快照在恢复前变化。');
          await fsp.mkdir(path.dirname(row.file), { recursive: true }); await copy(source, row.file, fs.constants.COPYFILE_EXCL);
        }
      }
      if (await currentHash(row.file) !== row.before) fail('RECOVERY', 'Feeder 恢复校验未通过。');
      if (await currentHash(recoveryClaim) !== null) {
        if (await currentHash(recoveryClaim) !== row.after) fail('FILE_CHANGED', '恢复暂存文件已变化，保留文件及恢复记录。', { retainedAt: recoveryClaim });
        await fsp.unlink(recoveryClaim);
      }
      await fsp.rmdir(path.dirname(recoveryClaim)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (await currentHash(claim) !== null) { if (await currentHash(claim) !== row.before) fail('RECOVERY', 'Feeder 暂存原件已变化。'); await fsp.unlink(claim); }
    }
    await fsp.unlink(t.pending); return { recovered: true, runtimeVerified: false };
  }
  async function execute(plan, kind) {
    await checkPlan(plan); await assertNoOtherOwner(plan.t, plan.layout);
    const operation = plan.id, files = plan.changes.filter(row => row.before !== row.after), state = { schema: 1, product: PRODUCT,
      operation, kind, exe: plan.t.exe, root: plan.t.root, receipt: plan.receipt, files: files.map(row => ({ file: row.file, role: row.role, before: row.before, after: row.after })) };
    for (let i = 0; i < files.length; i++) {
      const row = files[i]; await noLinks(row.file);
      if (await currentHash(row.file) !== row.before) fail('PLAN_CHANGED', '准备备份时文件变化。');
      const before = historyFile(plan.t, operation, `before/${i}.bin`), after = historyFile(plan.t, operation, `after/${i}.bin`);
      await noLinks(before); await noLinks(after);
      await fsp.mkdir(path.dirname(before), { recursive: true }); await fsp.mkdir(path.dirname(after), { recursive: true });
      if (row.before !== null) { await copy(row.file, before, fs.constants.COPYFILE_EXCL); if (await currentHash(before) !== row.before) fail('SNAPSHOT', '原文件备份校验失败。'); }
      if (row.after !== null) {
        if (row.content) await fsp.writeFile(after, row.content, { flag: 'wx' });
        else { await noLinks(row.source); if (await currentHash(row.source) !== row.after) fail('PACKAGE_CHANGED', 'Feeder 来源在预览后改变。'); await copy(row.source, after, fs.constants.COPYFILE_EXCL); }
        if (await currentHash(after) !== row.after) fail('SNAPSHOT', '准备文件校验失败。');
      }
      for (const file of [row.before !== null && before, row.after !== null && after].filter(Boolean)) {
        const handle = await fsp.open(file, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    await checkPlan(plan);
    await writeJson(resolveFile(plan.t.root, `${HISTORY}/${operation}/operation.json`), state);
    await writeJson(plan.t.pending, state);
    try {
      for (let i = 0; i < files.length; i++) {
        const row = files[i], claim = claimPath(row.file, operation, i); await closed(plan.t);
        if (plan.migration && (row.role === 'shared-config' || row.role === 'receipt' && !files.slice(0, i).some(value => value.role === 'shared-config')))
          await plan.migration.guard({ afterIsolation: true, published: files.slice(0, i) });
        const staged = historyFile(plan.t, operation, `after/${i}.bin`);
        if (row.after !== null && await currentHash(staged) !== row.after) fail('PACKAGE_CHANGED', '准备文件在发布前变化。');
        if (await currentHash(row.file) !== row.before) fail('PLAN_CHANGED', '发布前文件变化。');
        if (await currentHash(claim) !== null) fail('PLAN_CHANGED', '发布前文件变化。');
        await fsp.mkdir(path.dirname(row.file), { recursive: true });
        if (row.before !== null) { await fsp.rename(row.file, claim); if (await currentHash(claim) !== row.before) fail('FILE_CHANGED', '原件在发布时变化，保留恢复记录。'); }
        if (row.after !== null) await copy(staged, row.file, fs.constants.COPYFILE_EXCL);
        if (await currentHash(row.file) !== row.after) fail('WRITE_VERIFY', 'Feeder 文件写入校验失败。');
        await (overrides.afterWrite || options.afterWrite)?.({ row, index: i, operation });
      }
      for (let i = 0; i < files.length; i++) {
        const claim = claimPath(files[i].file, operation, i), held = await currentHash(claim);
        if (held !== null) { if (held !== files[i].before) fail('FILE_CHANGED', 'Feeder 暂存原件变化。'); await fsp.unlink(claim); }
      }
      await fsp.unlink(plan.t.pending);
      return { operation, archiveDirectory: resolveFile(plan.t.root, `${HISTORY}/${operation}`) };
    } catch (error) {
      if (error.preservePending) throw error;
      try { await recoverState(plan.game, state); } catch (recovery) { error.recoveryError = recovery; error.code = 'LEGACY_RECOVERY_REQUIRED'; }
      throw error;
    }
  }
  async function install(game, request = {}, beforeWrite) {
    const t = selected(game); return serial(t, async () => {
      let plan;
      if (request.expectedPlanId) {
        plan = plans.get(request.expectedPlanId); if (!plan || !same(plan.t.exe, t.exe)) fail('PLAN_EXPIRED', 'Feeder 预览已过期，请重新预览。');
        plans.delete(request.expectedPlanId);
        if (request.version !== undefined && ![plan.recipe.id, plan.recipe.coreVersion].includes(request.version)) fail('PLAN_CHANGED', '配套版本与已确认预览不同。');
        const supplied = request.selection || request, selection = { ...plan.recipe.selection };
        for (const name of Object.keys(selection)) if (supplied[name] !== undefined) selection[name] = supplied[name];
        const sameSelection = plan.recipe.externalProvider
          ? fingerprint(selection) === fingerprint(plan.recipe.selection)
          : fingerprint(catalog.resolve(selection)) === fingerprint(catalog.resolve(plan.recipe.selection));
        if (!sameSelection) fail('PLAN_CHANGED', '输入或加载路线与已确认预览不同。');
      } else plan = await compile(game, request);
      await runtime.verify(plan.pkg);
      if (plan.requiresAntiCheat && request.allowAntiCheat !== true) throw Object.assign(new Error('需要确认该游戏的受保护环境使用条件。'), { code: 'ERR_ANTI_CHEAT_CONFIRM' });
      if (beforeWrite) await beforeWrite();
      const result = await execute(plan, 'install');
      return { ...baseState, ...result, installed: true, ready: true, repaired: plan.old, packageId: plan.recipe.id,
        coreVersion: plan.recipe.coreVersion, api: plan.recipe.gameApi, architecture: plan.recipe.architecture, layout: plan.layout };
    });
  }
  async function compileRestore(game) {
    const t = selected(game); await closed(t); const row = readReceipt(game);
    if (!row) return null;
    const layout = await layoutFor(game, { layout: row.layout }, row.recipe, row.layout.source !== 'local');
    if (fingerprint(layoutIdentity(layout)) !== fingerprint(layoutIdentity(row.layout))) fail('LAYOUT_CHANGED', 'Feeder 恢复布局与原记录不同。');
    await assertNoOtherOwner(t, layout); const changes = [], warnings = [];
    const specs = specifications(row.recipe, panelOptions(row.config));
    for (const item of [...row.files].reverse()) {
      const before = await currentHash(item.path), spec = specs.find(value => value.base === item.base && value.target === item.target);
      const hostSaved = Boolean(before && before !== item.sha256 && isHostConfiguration(spec) && savedHostConfiguration(spec, await hostConfigurationBytes(item.path)));
      if (before && !item.mutable && !hostSaved && before !== item.sha256) fail('FILE_CHANGED', 'Feeder 文件已被外部替换，保留当前文件。', { file: item.path });
      const isolated = row.isolatedAddons?.find(value => same(value.path, item.path));
      changes.push({ file: item.path, role: item.role, before, after: item.owned ? isolated?.sha256 || null : before, mutable: item.mutable || hostSaved,
        source: isolated ? historyFile(t, isolated.operation, isolated.snapshot) : null });
    }
    for (const item of row.sourceCopies || []) {
      const before = await currentHash(item.path);
      if (before && !item.mutable && before !== item.sha256) fail('FILE_CHANGED', '受管插件副本已变化，保留当前文件。', { file: item.path });
      changes.push({ file: item.path, role: item.role, before, after: item.owned ? null : before, mutable: item.mutable });
    }
    for (const item of row.isolatedAddons || []) {
      if (changes.some(value => same(value.file, item.path))) continue;
      const before = await currentHash(item.path), source = historyFile(t, item.operation, item.snapshot);
      if (await currentHash(source) !== item.sha256) fail('RECOVERY', '原隔离插件快照缺失或变化。');
      if (before !== null && before !== item.sha256) { warnings.push({ code: 'LEGACY_ADDON_RESTORE_CONFLICT', path: item.path, archive: source,
        message: '原插件位置已有其他文件，保留当前文件和隔离快照。' }); continue; }
      changes.push({ file: item.path, role: 'source-addon', before, after: item.sha256, source });
    }
    const configBytes = await bytesAt(row.config.path); if (!configBytes) fail('CONFIG_MISSING', '活动配置缺失，保留恢复记录。');
    const restored = restoreConfiguration(textBytes(configBytes), row.config), configText = restored.text;
    const configAfter = !row.config.originalExisted && !configText.trim() ? null : sha(Buffer.from(configText));
    changes.push({ file: row.config.path, role: 'shared-config', before: sha(configBytes), after: configAfter, content: configAfter ? Buffer.from(configText) : null, mutable: true });
    changes.push({ file: t.receipt, role: 'receipt', before: await currentHash(t.receipt), after: null });
    const plan = { id: crypto.randomUUID(), game, t, recipe: row.recipe, receipt: row, layout: row.layout, exeHash: await currentHash(t.exe), changes, warnings: [...warnings, ...restored.warnings] };
    plan.fingerprint = fingerprint({ recipe: row.recipeFingerprint, layout: layoutIdentity(layout), changes: changes.map(value => ({ file: key(value.file), before: value.before, after: value.after })) });
    return plan;
  }
  async function previewRestore(game) {
    const plan = await compileRestore(game); if (!plan) return { ...baseState, changes: [], unchanged: true };
    plans.set(plan.id, plan); return { ...publicPlan(plan, 'restore'), warnings: plan.warnings, settingsArchived: true };
  }
  async function restore(game, request = {}) {
    const t = selected(game); return serial(t, async () => {
      if (pending(t)) await recoverState(game, pending(t));
      const plan = request.expectedPlanId ? plans.get(request.expectedPlanId) : await compileRestore(game);
      if (!plan) return { ...baseState, restored: false, unchanged: true };
      if (!same(plan.t.exe, t.exe) || request.expectedPlanId && plan.pkg) fail('PLAN_CHANGED', '恢复预览与当前操作不同。');
      plans.delete(plan.id); const result = await execute(plan, 'restore');
      return { ...baseState, ...result, restored: true, settingsArchived: true, warnings: plan.warnings,
        retainedFiles: plan.receipt.files.filter(row => !row.owned).map(row => row.path) };
    });
  }
  async function recover(game) { const t = selected(game); return serial(t, async () => { const state = pending(t); return state ? recoverState(game, state) : { recovered: false, unchanged: true }; }); }
  async function previewRecovery(game) {
    const t = selected(game), state = pending(t); await closed(t);
    return { ...baseState, needsRecovery: Boolean(state), changes: state?.product === PRODUCT && Array.isArray(state.files)
      ? state.files.map(row => ({ path: row.file, role: row.role, beforeSha256: row.after, afterSha256: row.before, action: 'restore' })) : [] };
  }
  async function launch(game) {
    const t = selected(game); return serial(t, async () => {
      await closed(t); const status = await inspect(game); if (!status.ready) fail('NOT_READY', status.reason || 'Feeder 配套尚未准备好。');
      const row = readReceipt(game);
      if (row.layout.source === 'hoyoshade-profile') {
        if (typeof options.launchHoYo !== 'function') fail('HOYO_LAUNCH', '米哈游 Feeder 必须通过已绑定的启动协调器启动。');
        return options.launchHoYo(game, { legacy: row, layout: row.layout });
      }
      row.lastLaunch = null; await writeJson(t.receipt, row);
      const startedAt = new Date().toISOString(), result = await getBroker().launch({ exe: t.exe, args: [], cwd: t.dir });
      if (!Number.isInteger(result.pid) || result.pid <= 0) fail('LAUNCH', '启动请求没有返回可核对的游戏进程。');
      row.lastLaunch = { startedAt, pid: result.pid }; await writeJson(t.receipt, row); return { ...result, ...baseState };
    });
  }
  async function recordLaunch(game, launch) {
    const t = selected(game), row = readReceipt(game); if (!row || !Number.isInteger(launch?.pid) || launch.pid <= 0 || !Number.isFinite(Date.parse(launch.startedAt))) fail('LAUNCH', '启动记录缺少真实游戏进程身份。');
    row.lastLaunch = { pid: launch.pid, startedAt: launch.startedAt }; await writeJson(t.receipt, row);
  }
  async function prepareLaunch(game) {
    const t = selected(game); return serial(t, async () => {
      await closed(t); const status = await inspect(game); if (!status.ready) fail('NOT_READY', status.reason || 'Feeder 配套尚未准备好。');
      const row = readReceipt(game); row.lastLaunch = null; await writeJson(t.receipt, row);
      // Host creation belongs to the game provider and is bound to its actual
      // PID and adapter. The manager never starts or terminates host processes.
      return { ...baseState, prepared: true, hostRequired: row.recipe.hostRequired, managerStartedHost: false,
        layout: row.layout, modules: await ownedModuleManifest(game) };
    });
  }
  function profile(game) { const row = readReceipt(game); return row ? { ...row.layout, installed: true, recipe: row.recipe, inputRoute: 'feeder', hostRequired: row.recipe.hostRequired,
    api: row.recipe.gameApi, loadingBackend: row.recipe.loadingBackend, version: row.recipe.coreVersion, runtimeVerified: false } : { ...localLayout(game), installed: false }; }
  async function ownedModuleManifest(game) {
    const row = readReceipt(game); if (!row) return [];
    const result = [];
    for (const file of row.files.filter(value => !value.mutable && PE.test(value.path) && value.role !== 'host' && value.role !== 'host-loader' &&
      (!row.recipe.hostRequired || ['provider', 'game-loader', 'api-wrapper'].includes(value.role)))) {
      if (await currentHash(file.path) !== file.sha256) fail('FILE_CHANGED', 'Feeder 组件与其收据不一致。');
      const spec = row.recipe.files.find(value => value.base === file.base && value.target === file.target);
      result.push({ role: file.role === 'game-loader' ? 'reshade' : file.role, name: path.basename(file.path), path: file.path, sha256: file.sha256,
        architecture: spec?.architecture || row.recipe.architecture, owned: file.owned, owner: PRODUCT, status: 'enabled' });
    }
    for (const file of row.sourceCopies || []) if (!file.mutable && PE.test(file.path)) {
      if (await currentHash(file.path) !== file.sha256) fail('FILE_CHANGED', '受管保留插件副本与其收据不一致。');
      result.push({ role: file.role, name: path.basename(file.path), path: file.path, sha256: file.sha256, owned: file.owned, owner: PRODUCT, status: 'enabled' });
    }
    return result;
  }
  return Object.freeze({ summary, inspect, diagnose: inspect, verifySource, previewInstall, install, previewRestore, restore, previewRecovery, recover,
    launch, prepareLaunch, recordLaunch, profile, getLayout: profile, localLayout, ownedModuleManifest, receipt: readReceipt, receiptFile: game => selected(game).receipt,
    configDir: (game, kind = 'nr') => { const row = readReceipt(game), layout = row?.layout || localLayout(game); return kind === 'nr' ? row?.recipe.hostRequired ? path.join(layout.addonDirectory, 'host64/addons') : layout.addonDirectory : path.dirname(layout.activeConfigPath); },
    feedbackLogDirectory: async game => { const row = readReceipt(game); return row ? row.layout.addonDirectory : null; } });
}

module.exports = { createLegacyService, createFeederService: createLegacyService, PRODUCT, RECEIPT, PENDING, localLayout,
  configure, restoreConfiguration };
