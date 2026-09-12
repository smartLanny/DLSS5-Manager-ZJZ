'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, inside, atomicJson } = require('./launch-safety');
const { createGameLaunchBroker, executionLevel } = require('./game-launch-broker');
const { assessFeeder } = require('./game-support');
const { addonValues } = require('./reshade-layout');
const { readFeederEvidence } = require('./feeder-runtime-evidence');
const { createFeederRuntime, DIRECTORY, RECEIPT, HASH, regularJson, resolveFile, fileDigest, same, fail, fingerprint } = require('./feeder-runtime');

const PRODUCT = 'xiaofeng-feeder-dx12';
const PROXIES = ['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d9.dll', 'opengl32.dll', 'dinput8.dll', 'winmm.dll', 'version.dll', 'dsound.dll'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const routes = new Map();
const errorText = error => error?.message || 'Feeder 配套检查未完成。';

function createFeederService(options) {
  const overrides = options.overrides || {};
  const runtime = overrides.runtime || createFeederRuntime(options);
  const journal = overrides.journal || require('../core/file-journal');
  const guards = overrides.guards || require('../core/install-guards');
  const pe = overrides.pe || require('../core/pe');
  const level = overrides.executionLevel || executionLevel;
  const writeJson = overrides.writeJson || atomicJson;
  const copy = overrides.copyFile || fsp.copyFile;
  let broker = overrides.broker;
  const getBroker = () => broker || (broker = createGameLaunchBroker({ resourcesPath: options.resourcesPath }));
  const defaultState = { route: 'feeder-dx12', api: 'dx12', architecture: 64, provenance: 'Synthetic', scope: 'post-process',
    colorContract: 'rgba8-srgb-confirmed', experimental: true, runtimeVerified: false, loaded: 'unknown', processed: 'unknown' };

  function selected(game) {
    const exe = game?.scan?.chosen?.path;
    if (!game || typeof game.id !== 'string' || !path.isAbsolute(game.dir || '') || !path.isAbsolute(exe || '') ||
        !inside(game.dir, exe) || !/\.exe$/i.test(exe)) fail('FEEDER_GAME_REQUIRED', '请先选择真实的游戏 EXE。');
    const root = path.resolve(game.dir), exact = path.resolve(exe), dir = path.dirname(exact);
    return { id: game.id, root, exe: exact, dir, receipt: resolveFile(root, RECEIPT), configDir: path.join(dir, DIRECTORY), addonDir: path.join(dir, DIRECTORY, 'addons') };
  }
  function receipt(target) {
    const row = regularJson(target.receipt, 512 * 1024);
    if (!row) return null;
    if (row.version !== 1 || row.product !== PRODUCT || !UUID.test(row.installId || '') || !row.game ||
        !same(row.game.dir, target.root) || !same(path.resolve(target.root, row.game.exe || ''), target.exe) ||
        !Array.isArray(row.files) || !HASH.test(row.recipeFingerprint || ''))
      fail('FEEDER_RECEIPT_INVALID', 'Feeder 安装记录与所选 EXE 不符，请保留记录后恢复。');
    runtime.validate(row.recipe);
    if (fingerprint(row.recipe) !== row.recipeFingerprint || row.files.length !== row.recipe.files.length) fail('FEEDER_RECEIPT_INVALID', 'Feeder 收据的固定配套身份无效。');
    const seen = new Set();
    for (const item of row.files) {
      const spec = row.recipe.files.find(value => value.target === item.target);
      const rel = spec && path.relative(target.root, resolveFile(target.dir, spec.target)).replaceAll('\\', '/');
      if (!spec || item.rel !== rel || seen.has(item.target) || item.sha256 !== spec.sha256 || item.mutable !== spec.mutable ||
          typeof item.reused !== 'boolean' || item.reused && spec.role !== 'loader') fail('FEEDER_RECEIPT_INVALID', 'Feeder 文件收据无效。');
      seen.add(item.target);
    }
    return row;
  }
  function pending(target) {
    const state = regularJson(journal.pendingPath(target.root), 2 * 1024 * 1024);
    return state ? { state, ours: Array.isArray(state.files) && state.files.some(item => item.rel?.replaceAll('\\', '/').toLowerCase() === RECEIPT.toLowerCase()) } : null;
  }
  function rtx50() {
    const hardware = options.hardware;
    if (hardware?.family !== 'RTX50') return false;
    const list = hardware.series || hardware.families;
    return !Array.isArray(list) || list.length > 0 && list.every(value => value === 'RTX50');
  }
  function pathBudget(target, recipe) {
    // Core's existing module/config/log filenames must fit its WCHAR[260].
    // Resolve the real existing directory so an app-path alias cannot hide it.
    const physical = fs.realpathSync.native(target.dir);
    const names = [...recipe.files.map(file => resolveFile(physical, file.target)), path.join(physical, DIRECTORY, 'addons', 'nr-before-sr.previous.log')];
    if (names.some(file => file.length > 259)) fail('FEEDER_PATH_TOO_LONG', '游戏目录加 Feeder 组件路径过长，未部署可能在启动时失败的配套。');
  }
  function summary(game) {
    let row, target, pkg, reason = null, needsRecovery = false, installed = false, antiCheatDetected = false;
    try {
      target = selected(game); row = receipt(target); installed = Boolean(row);
      antiCheatDetected = guards.antiCheatPresent(target.root) === true;
      const interrupted = pending(target); needsRecovery = Boolean(interrupted?.ours || row && interrupted);
      installed ||= interrupted?.ours === true;
      if (interrupted) reason = interrupted.ours ? 'Feeder 有未完成操作，请先恢复。' : '游戏有其他未完成操作，请先恢复原安装。';
      pkg = runtime.load();
      const admission = assessFeeder(game.scan);
      if (!reason && !admission.supported) reason = admission.message;
      if (!reason && !rtx50()) reason = 'Feeder 首批配套仅面向已确认的 RTX 50。';
      if (!reason && process.env.RESHADE_BASE_PATH_OVERRIDE) reason = '已有 ReShade 全局路径覆盖，尚不能确认此游戏的独立配置。';
      if (!reason && ['requireAdministrator', 'highestAvailable'].includes(level(target.exe))) reason = '首批 Feeder 仅使用普通权限启动；该 EXE 要求管理员权限。';
      if (!reason) pathBudget(target, pkg.recipe);
      if (!reason && fs.existsSync(path.join(target.root, '_DLSS5_Backup', 'xiaofeng-manager.json'))) reason = '请先卸载原生 DLSS 配套，再准备 Feeder。';
      if (!reason && row && row.recipeFingerprint !== pkg.fingerprint) reason = '已安装另一固定 Feeder 配套，请先恢复。';
    } catch (error) { reason = errorText(error); needsRecovery ||= /RECEIPT|RECORD/.test(error.code || ''); }
    return { ...defaultState, available: !reason, installed, ready: false, needsRecovery, reason, antiCheatDetected,
      retainedFiles: (row?.files || []).filter(file => file.reused).map(file => file.target),
      launchWarning: antiCheatDetected ? '检测到反作弊组件，受保护启动兼容性尚未确认。离线设置不等于停用反作弊；它仍可能拒绝 ReShade。' : null,
      packageId: row?.recipe.id || pkg?.recipe.id || null, coreVersion: row?.recipe.coreVersion || pkg?.recipe.coreVersion || null,
      validation: row?.recipe.acceptance || pkg?.recipe.acceptance || null,
      status: needsRecovery ? 'recovery-required' : installed ? 'installed' : 'absent' };
  }
  async function serial(target, work) {
    const key = target.root.toLowerCase();
    if (routes.has(key)) fail('FEEDER_BUSY', '该游戏正在进行 Feeder 操作。');
    routes.set(key, true);
    try { return await work(); } finally { routes.delete(key); }
  }
  async function assertClosed(target) { await noLinks(target.root); await noLinks(target.exe); await guards.assertGameClosed(target.root, target.exe); }
  async function noOtherRoute(target, owned = false) {
    const native = resolveFile(target.root, '_DLSS5_Backup/xiaofeng-manager.json');
    if (fs.existsSync(native)) fail('FEEDER_ROUTE_CONFLICT', '请先恢复原生 DLSS 安装，再准备 Feeder。');
    for (const proxy of PROXIES) {
      const file = path.join(target.dir, proxy); await noLinks(file);
      if (!fs.existsSync(file)) continue;
      if (proxy === 'dxgi.dll') {
        const loader = runtime.load().recipe.files.find(row => row.role === 'loader');
        if (await fileDigest(file) === loader.sha256) continue;
      }
      fail('FEEDER_PROXY_CONFLICT', '已有加载器或图形代理未经本配套确认，未覆盖。', { file: proxy });
    }
    const ini = path.join(target.dir, 'ReShade.ini'); await noLinks(ini);
    if (!owned && fs.existsSync(ini)) fail('FEEDER_RESHADE_CONFLICT', '已有 ReShade 配置，首批 Feeder 不自动接管，请先用原工具恢复。');
    if (!owned && fs.existsSync(target.configDir)) fail('FEEDER_DIRECTORY_CONFLICT', 'Feeder 目标目录已有未受管理的文件，未覆盖。');
    // A Vulkan activation uses the same exact local INI. No silent route swap.
    if (fs.existsSync(ini) && fs.statSync(ini).size <= 256 * 1024 && /XiaofengVulkanMarker\s*=/i.test(fs.readFileSync(ini, 'utf8')))
      fail('FEEDER_ROUTE_CONFLICT', '请先恢复该 EXE 的 Vulkan 绑定，再准备 Feeder。');
  }
  async function checkedInstalled(target, row, repair = false) {
    const files = [], blockers = [];
    for (const item of row.files) {
      const file = resolveFile(target.root, item.rel), digest = await fileDigest(file);
      const valid = Boolean(digest) && (item.mutable || digest === item.sha256);
      if (digest && !item.mutable && !valid) fail('FEEDER_FILE_CHANGED', '已安装的 Feeder 文件被外部修改，未覆盖。', { file: item.target });
      if (item.mutable && digest && (await fsp.stat(file)).size > 256 * 1024) fail('FEEDER_FILE_CHANGED', 'Feeder 配置超出正常大小。', { file: item.target });
      files.push({ target: item.target, file, valid, digest, mutable: item.mutable });
      if (!valid && !repair) blockers.push(`${item.target} 缺失。`);
    }
    return { files, blockers };
  }
  async function validateConfiguration(target, recipe) {
    const reshade = path.join(target.dir, 'ReShade.ini');
    await noLinks(reshade);
    const text = await fsp.readFile(reshade, 'utf8');
    const addon = addonValues(text), general = addonValues(text, 'GENERAL'), install = addonValues(text, 'INSTALL');
    const exact = (values, key, expected) => {
      const rows = values.get(key) || [];
      if (rows.length !== 1 || !same(path.resolve(target.dir, rows[0].replace(/[/\\]\*\*$/, '')), expected))
        fail('FEEDER_CONFIG_CHANGED', 'ReShade 的 Feeder 路径配置已改变，请恢复受管路径后再启动。', { key });
    };
    exact(addon, 'AddonPath', target.addonDir);
    exact(general, 'EffectSearchPaths', path.join(target.configDir, 'reshade-shaders', 'Shaders'));
    exact(general, 'TextureSearchPaths', path.join(target.configDir, 'reshade-shaders', 'Textures'));
    exact(general, 'PresetPath', path.join(target.configDir, 'ReShadePreset.ini'));
    if ((addon.get('LoadFromDllMain') || []).length || (install.get('BasePath') || []).some(value => !same(path.resolve(target.dir, value), target.dir)) ||
        (general.get('StartupPresetPath') || []).some(Boolean)) fail('FEEDER_CONFIG_CHANGED', 'Feeder 检测到另一加载路径或启动预设，未自动覆盖。');
    const config = await fsp.readFile(path.join(target.addonDir, 'nr_before_sr.ini'), 'utf8');
    const nr = addonValues(config, 'NRBeforeSR');
    if (nr.get('R8OutputEncoding')?.length !== 1 || nr.get('R8OutputEncoding')[0] !== '2')
      fail('FEEDER_COLOR_CONFIG', '此固定配套需要 R8OutputEncoding=2，并由运行时核对真实 SDR/sRGB 颜色域。');
    const allowed = new Set(recipe.files.filter(row => path.dirname(row.target.replaceAll('/', path.sep)) === path.join(DIRECTORY, 'addons')).map(row => path.basename(row.target).toLowerCase()));
    const entries = await fsp.readdir(target.addonDir, { withFileTypes: true });
    if (entries.length > 256 || entries.some(entry => /\.(?:dll|exe|asi|addon(?:32|64)?)$/i.test(entry.name) && !allowed.has(entry.name.toLowerCase())))
      fail('FEEDER_ADDON_CONFLICT', 'Feeder 专用目录出现另一运行组件，未启动混合配套。');
  }
  async function inspect(game) {
    const info = summary(game), target = selected(game), row = receipt(target);
    if (info.needsRecovery) return info;
    if (!row) return info;
    const { files, blockers } = await checkedInstalled(target, row);
    await noOtherRoute(target, true);
    if (!blockers.length) await validateConfiguration(target, row.recipe);
    let sourceReason = null; try { await runtime.verify(); } catch (error) { sourceReason = errorText(error); }
    if (sourceReason) blockers.push(sourceReason);
    const ready = blockers.length === 0 && !info.reason;
    const evidence = await readFeederEvidence({ exeDir: target.dir, lastLaunch: row.lastLaunch });
    return { ...info, ...evidence, ready, components: files, blockers, reason: info.reason || blockers[0] || null };
  }
  async function previewInstall(game, installOptions = {}) {
    const target = selected(game), info = summary(game);
    if (!info.available) fail(info.needsRecovery ? 'FEEDER_RECOVERY_FIRST' : 'FEEDER_UNAVAILABLE', info.reason);
    await assertClosed(target);
    if (pe.getBitness(target.exe) !== 64) fail('FEEDER_GAME_ARCH', 'Feeder 首批只支持真实 x64 EXE。');
    const pkg = await runtime.verify(); pathBudget(target, pkg.recipe);
    if (installOptions.version !== undefined && ![pkg.recipe.id, pkg.recipe.coreVersion].includes(installOptions.version)) fail('FEEDER_PACKAGE_LOCKED', 'Feeder 必须使用完整固定配套。');
    const old = receipt(target); await noOtherRoute(target, Boolean(old));
    const launch = await getBroker().inspect({ exe: target.exe });
    if (launch?.elevated !== false || launch?.launchable !== true) fail('FEEDER_LAUNCH_UNCONFIRMED', '尚不能确认普通权限启动，未部署 Feeder。');
    const previous = old ? await checkedInstalled(target, old, true) : null;
    if (old && previous.files.every(file => file.valid)) await validateConfiguration(target, old.recipe);
    const changes = [];
    for (const spec of pkg.recipe.files) {
      const file = resolveFile(target.dir, spec.target), before = await fileDigest(file);
      const reused = !old && spec.role === 'loader' && before === spec.sha256;
      if (!old && before && !reused) fail('FEEDER_FILE_CHANGED', 'Feeder 目标文件已存在，未覆盖。');
      const after = old && before ? before : spec.sha256;
      changes.push({ path: file, name: path.basename(file), role: spec.role || 'feeder-runtime', mutable: spec.mutable, reused,
        beforeSha256: before, afterSha256: after, action: before === after ? 'keep' : 'create' });
    }
    changes.push({ path: target.receipt, name: path.basename(target.receipt), role: 'receipt', beforeSha256: await fileDigest(target.receipt), action: old ? 'update' : 'create' });
    return { ...defaultState, changes, api: 'dx12', mode: 'local', version: pkg.recipe.coreVersion, packageId: pkg.recipe.id,
      requiresAntiCheat: guards.antiCheatPresent(target.root) === true && !old?.antiCheatConfirmed, requiresConfirmation: true };
  }
  async function previewRestore(game) {
    const target = selected(game); await assertClosed(target);
    if (pending(target)) fail('FEEDER_RECOVERY_FIRST', 'Feeder 有未完成事务，请先恢复后重新预览。');
    const row = receipt(target); if (!row) return { ...defaultState, changes: [], unchanged: true };
    const checked = await checkedInstalled(target, row);
    if (checked.blockers.length) fail('FEEDER_RESTORE_INCOMPLETE', 'Feeder 文件缺失，请先修复后恢复，避免丢失配置。', { blockers: checked.blockers });
    const changes = [];
    for (const item of [...row.files].reverse()) {
      const file = resolveFile(target.root, item.rel), digest = checked.files.find(value => value.target === item.target).digest;
      if (item.mutable && !item.reused) {
        const archive = resolveFile(target.root, `_DLSS5_Backup/feeder-settings/${row.installId}/${item.target}`);
        await noLinks(archive);
        if (fs.existsSync(archive)) fail('FEEDER_ARCHIVE_EXISTS', 'Feeder 配置备份位置已有文件，未覆盖。');
        changes.push({ path: archive, name: path.basename(archive), role: 'settings-archive', beforeSha256: null, afterSha256: digest, action: 'create' });
      }
      changes.push({ path: file, name: path.basename(file), role: 'feeder-runtime', beforeSha256: digest,
        afterSha256: item.reused ? digest : null, action: item.reused ? 'keep' : 'remove', reused: item.reused });
    }
    changes.push({ path: target.receipt, name: path.basename(target.receipt), role: 'receipt', beforeSha256: await fileDigest(target.receipt), afterSha256: null, action: 'remove' });
    return { ...defaultState, changes, requiresConfirmation: true, settingsArchived: true };
  }
  async function install(game, installOptions = {}, beforeWrite = null) {
    const target = selected(game);
    return serial(target, async () => {
      const info = summary(game);
      if (!info.available) fail(info.needsRecovery ? 'FEEDER_RECOVERY_FIRST' : 'FEEDER_UNAVAILABLE', info.reason);
      await assertClosed(target);
      if (pe.getBitness(target.exe) !== 64) fail('FEEDER_GAME_ARCH', 'Feeder 首批只支持真实 x64 EXE。');
      const pkg = await runtime.verify(); pathBudget(target, pkg.recipe);
      if (installOptions.version !== undefined && ![pkg.recipe.id, pkg.recipe.coreVersion].includes(installOptions.version)) fail('FEEDER_PACKAGE_LOCKED', 'Feeder 必须使用完整固定配套。');
      const old = receipt(target); await noOtherRoute(target, Boolean(old));
      if (guards.antiCheatPresent(target.root) && installOptions.allowAntiCheat !== true && !old?.antiCheatConfirmed)
        throw Object.assign(new Error('该游戏有在线保护组件；请确认只在允许的离线环境中测试。'), { code: 'ERR_ANTI_CHEAT_CONFIRM', details: { operation: 'feeder-install' } });
      const launch = await getBroker().inspect({ exe: target.exe });
      if (launch?.elevated !== false || launch?.launchable !== true) fail('FEEDER_LAUNCH_UNCONFIRMED', '尚不能确认普通权限启动，未部署 Feeder。');
      const previous = old ? await checkedInstalled(target, old, true) : null;
      if (old && previous.files.every(file => file.valid)) await validateConfiguration(target, old.recipe);
      const row = old || { version: 1, product: PRODUCT, installId: crypto.randomUUID(), game: { dir: target.root, exe: path.relative(target.root, target.exe) },
        recipe: pkg.recipe, recipeFingerprint: pkg.fingerprint, files: [], lastLaunch: null, installedAt: new Date().toISOString() };
      if (beforeWrite) { await beforeWrite(); await assertClosed(target); }
      await journal.transaction(target.root, async () => {
        await journal.capture(target.root, target.receipt);
        for (const spec of pkg.recipe.files) {
          const source = resolveFile(pkg.root, spec.source), file = resolveFile(target.dir, spec.target);
          const existing = old && previous.files.find(item => item.target === spec.target);
          const digest = await fileDigest(file);
          if (old && existing?.digest !== digest) fail('FEEDER_FILE_CHANGED', 'Feeder 文件在安装预检后发生变化。');
          if (old && digest) continue; // keep user settings; immutable files were checked above
          const reused = !old && spec.role === 'loader' && digest === spec.sha256;
          if (!old && digest && !reused) fail('FEEDER_FILE_CHANGED', 'Feeder 目标文件在预检后出现，未覆盖。');
          if (!reused) {
            await noLinks(source); if (await fileDigest(source) !== spec.sha256) fail('FEEDER_PACKAGE_HASH', 'Feeder 来源在复制前发生变化。');
            await journal.capture(target.root, file); await fsp.mkdir(path.dirname(file), { recursive: true });
            await copy(source, file, fs.constants.COPYFILE_EXCL);
            if (await fileDigest(file) !== spec.sha256) fail('FEEDER_WRITE_VERIFY', 'Feeder 写入后校验失败。');
          }
          if (!old) row.files.push({ target: spec.target, rel: path.relative(target.root, file).replaceAll('\\', '/'), sha256: spec.sha256, mutable: spec.mutable, reused });
        }
        row.updatedAt = new Date().toISOString(); row.antiCheatConfirmed ||= installOptions.allowAntiCheat === true;
        await writeJson(target.receipt, row);
      });
      return { ...defaultState, installed: true, ready: true, repaired: Boolean(old), packageId: pkg.recipe.id, coreVersion: pkg.recipe.coreVersion };
    });
  }
  async function recoverPending(target) {
    const interrupted = pending(target); if (!interrupted) return false;
    if (!interrupted.ours) fail('FEEDER_RECOVERY_OTHER', '该游戏有其他安装事务，请用原路线恢复。');
    const state = interrupted.state, recipe = runtime.load().recipe;
    const allowed = new Map(recipe.files.map(spec => [path.relative(target.root, resolveFile(target.dir, spec.target)).replaceAll('\\', '/').toLowerCase(), spec]));
    allowed.set(RECEIPT.toLowerCase(), null); allowed.set('_dlss5_backup/manifest.json', null);
    if (state.version !== 1 || !Array.isArray(state.files) || state.files.length > 96 || !Array.isArray(state.dirs) || state.dirs.length > 160 ||
        !/^_DLSS5_Backup\/\.transactions\/[a-f0-9-]+$/i.test(state.folder || '')) fail('FEEDER_RECOVERY_INVALID', 'Feeder 事务记录无效。');
    const seen = new Set(), snapshots = new Set(), directories = new Set();
    for (const item of state.files) {
      const rel = item.rel?.replaceAll('\\', '/').toLowerCase(), spec = allowed.get(rel);
      const archive = rel?.match(/^_dlss5_backup\/feeder-settings\/([^/]+)\/(.+)$/);
      const ownArchive = archive && UUID.test(archive[1]) && recipe.files.some(file => file.mutable && file.target.toLowerCase() === archive[2]);
      if ((!allowed.has(rel) && !ownArchive) || seen.has(rel) || typeof item.existed !== 'boolean') fail('FEEDER_RECOVERY_INVALID', '事务包含非 Feeder 文件或重复目标，未执行恢复。');
      if (typeof item.snapshot !== 'string' || !item.snapshot.startsWith(state.folder + '/') || !/^\d+\.bin$/.test(item.snapshot.slice(state.folder.length + 1)) || snapshots.has(item.snapshot.toLowerCase())) fail('FEEDER_RECOVERY_INVALID', 'Feeder 恢复快照路径无效。');
      seen.add(rel); snapshots.add(item.snapshot.toLowerCase());
      let parent = path.posix.dirname(rel);
      while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
      const file = journal.safePath(target.root, item.rel), snapshot = journal.safePath(target.root, item.snapshot);
      const before = item.existed ? await fileDigest(snapshot) : null;
      if (item.existed && !before) fail('FEEDER_RECOVERY_INVALID', 'Feeder 恢复快照缺失。');
      const current = await fileDigest(file);
      if (rel === '_dlss5_backup/manifest.json' && current !== before) fail('FEEDER_FILE_CHANGED', '原安装清单在中断后发生变化，未覆盖。');
      if (spec && current && current !== before && current !== spec.sha256)
        fail('FEEDER_FILE_CHANGED', '中断后 Feeder 文件被外部修改，请保留文件后人工核对恢复。', { file: item.rel });
    }
    if (state.dirs.some(dir => typeof dir !== 'string' || !directories.has(dir.replaceAll('\\', '/').toLowerCase()))) fail('FEEDER_RECOVERY_INVALID', '事务包含非 Feeder 目录，未执行恢复。');
    return journal.recover(target.root);
  }
  async function restore(game) {
    const target = selected(game);
    return serial(target, async () => {
      await assertClosed(target);
      const recovered = await recoverPending(target), row = receipt(target);
      if (!row) return { restored: recovered, unchanged: !recovered, runtimeVerified: false };
      const checked = await checkedInstalled(target, row);
      if (checked.blockers.length) fail('FEEDER_RESTORE_INCOMPLETE', 'Feeder 文件缺失，请先修复后恢复，避免丢失配置。', { blockers: checked.blockers });
      await journal.transaction(target.root, async () => {
        await journal.capture(target.root, target.receipt);
        for (const item of [...row.files].reverse()) {
          if (item.reused) continue;
          const file = resolveFile(target.root, item.rel), expected = checked.files.find(value => value.target === item.target).digest;
          if (await fileDigest(file) !== expected) fail('FEEDER_FILE_CHANGED', '卸载前 Feeder 文件发生变化，保留原文件。');
          if (item.mutable) {
            const archive = resolveFile(target.root, `_DLSS5_Backup/feeder-settings/${row.installId}/${item.target}`);
            if (fs.existsSync(archive)) fail('FEEDER_ARCHIVE_EXISTS', 'Feeder 配置备份位置已有文件，未覆盖。');
            await journal.capture(target.root, archive); await fsp.mkdir(path.dirname(archive), { recursive: true }); await copy(file, archive, fs.constants.COPYFILE_EXCL);
            if (await fileDigest(archive) !== expected) fail('FEEDER_WRITE_VERIFY', 'Feeder 配置归档校验失败。');
          }
          await journal.capture(target.root, file); await fsp.unlink(file);
        }
        await fsp.unlink(target.receipt);
      });
      // Remove empty directories only. Unknown user files remain in place.
      const dirs = new Set(row.files.filter(file => !file.reused).map(file => path.dirname(resolveFile(target.dir, file.target))));
      for (const dir of [...dirs]) { let parent = dir; while (inside(target.configDir, parent)) { dirs.add(parent); if (same(parent, target.configDir)) break; parent = path.dirname(parent); } }
      for (const dir of [...dirs].filter(dir => inside(target.configDir, dir)).sort((a, b) => b.length - a.length)) await fsp.rmdir(dir).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
      const retainedFiles = row.files.filter(file => file.reused).map(file => file.target);
      return { restored: true, settingsArchived: true, runtimeVerified: false, route: 'feeder-dx12', retainedFiles,
        notice: retainedFiles.length ? `Feeder 已卸载，配置已归档；安装前已有的 ${retainedFiles.join('、')} 已保留。这是恢复安装前状态，反作弊仍可能拒绝原有 ReShade。` : 'Feeder 已卸载，配置已归档到安装备份。' };
    });
  }
  async function launch(game) {
    const target = selected(game);
    return serial(target, async () => {
      await assertClosed(target);
      const state = await inspect(game);
      if (!state.installed || !state.ready) fail('FEEDER_NOT_READY', state.reason || 'Feeder 配套尚未准备好。');
      const row = receipt(target); pathBudget(target, row.recipe);
      if (guards.antiCheatPresent(target.root) && !row.antiCheatConfirmed) throw Object.assign(new Error('需要确认游戏的离线使用条件。'), { code: 'ERR_ANTI_CHEAT_CONFIRM' });
      row.lastLaunch = null; await writeJson(target.receipt, row);
      const startedAt = new Date().toISOString();
      const result = await getBroker().launch({ exe: target.exe, args: [], cwd: target.dir });
      row.lastLaunch = { startedAt, pid: result.pid }; await writeJson(target.receipt, row);
      return { ...result, runtimeVerified: false };
    });
  }
  function configDir(game, kind = 'nr') { const target = selected(game); return kind === 'nr' ? target.addonDir : target.dir; }
  async function feedbackLogDirectory(game) {
    const target = selected(game);
    await noLinks(target.exe); await noLinks(target.receipt);
    // Read-only feedback remains useful when installed binaries need repair.
    // Authority comes from the code-pinned receipt bound to this exact EXE,
    // never from a caller-supplied directory or mutable ReShade configuration.
    if (!receipt(target)) return null;
    await noLinks(target.addonDir);
    return target.addonDir;
  }
  return Object.freeze({ summary, inspect, diagnose: inspect, install, restore, previewInstall, previewRestore, launch, configDir, feedbackLogDirectory });
}
module.exports = { createFeederService, PRODUCT, PROXIES };
