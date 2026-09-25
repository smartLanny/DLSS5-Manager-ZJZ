'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const journalDefault = require('../core/file-journal');
const peDefault = require('../core/pe');
const { createInstallGuards } = require('../core/install-guards');
const { detectGpuAsync } = require('./gpu');
const { noLinks, atomicJson } = require('./launch-safety');
const { appError } = require('./errors');
const { inspectAddonLayout, addonValues } = require('./reshade-layout');
const { createFgComponents: createLegacyFgComponents } = require('./fg-legacy-components');
const { ID, BACKEND, ADDON, SHA256, sha256 } = require('./fg-mfgunlock-resources');
const { createNativeEnhancementProbe } = require('./native-enhancement-probe');
const { createMigrationStore, copyNewFile, hashFile, same } = require('./fg-migration-components');
const { createFgPendingRecovery, jsonHash } = require('./fg-pending-recovery');

const COMPETING = /(?:rtx[-_ ]?40[-_ ]?mfg|mfg[-_ ]?unlock|mfgadaunlock|(?:^|[\\/._ -])mfg(?:[._ -]|$))/i;
function fail(code, message, details) { throw Object.assign(new Error(message), { code, details }); }

function createMfgUnlockComponents(options = {}) {
  const providerLibrary = require('./mfg-provider-library').createMfgProviderLibrary(options);
  const { providerById, recoveryProviderById, knownProviderForHash, readMfgUnlockResources, readMfgUnlockCatalog } = providerLibrary;
  if (typeof options.gameDirectory !== 'function' || typeof options.gameExecutable !== 'function') fail('SETTINGS_FG_INIT', 'FG 组件服务缺少游戏路径依赖。');
  const journal = options.journal || journalDefault, pe = options.pe || peDefault;
  const guards = options.guards || createInstallGuards();
  const rawAssertClosed = options.assertGameClosed || guards.assertGameClosed;
  const sourceRoots = new Map();
  const assertGameClosed = (root, exe) => rawAssertClosed(sourceRoots.get(path.resolve(root).toLowerCase()) || root, exe);
  const antiCheatPresent = options.antiCheatPresent || guards.antiCheatPresent;
  const scan = options.scan || (async () => ({})), detectHardware = options.detectHardware || detectGpuAsync;
  const nativeProbe = typeof options.getFeatureEvidence === 'function' ? null : createNativeEnhancementProbe({ ...options, scan });
  const getFeatureEvidence = options.getFeatureEvidence || ((id, domain) => nativeProbe.inspect(id, domain));
  const legacy = createLegacyFgComponents(options);
  const fileRecovery = createFgPendingRecovery({ journal, assertGameClosed, providerLibrary });
  const migrations = createMigrationStore({ journal, assertGameClosed, fileRecovery, knownProviderForHash });
  const undos = new Map();
  const resources = fs.existsSync(path.join(options.resourcesPath || '', 'fg-mfgunlock', 'manifest.json'))
    ? path.join(options.resourcesPath, 'fg-mfgunlock') : path.join(options.appDir || '', 'resources', 'fg-mfgunlock');
  function target(id, originalLayout = false) {
    const game = options.gameDirectory(id), exe = options.gameExecutable(id);
    if (typeof game !== 'string' || typeof exe !== 'string' || !path.isAbsolute(game) || !path.isAbsolute(exe) || path.extname(exe).toLowerCase() !== '.exe') fail('SETTINGS_FG_TARGET', '游戏 EXE 无效。');
    const rel = path.relative(path.resolve(game), path.resolve(exe));
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('SETTINGS_FG_TARGET', '游戏 EXE 不在所选目录内。');
    const sourceGame = path.resolve(game), exeDir = path.dirname(path.resolve(exe));
    let dir = exeDir, transactionRoot = sourceGame, configFile = path.join(exeDir, 'ReShade.ini'), layout = null;
    if (!originalLayout && typeof options.getLayout === 'function') {
      layout = options.getLayout(id);
      if (layout?.verified !== true || layout.needsRecovery || layout.blockers?.length || !same(layout.exe, exe) ||
          typeof layout.addonDirectory !== 'string' || !path.isAbsolute(layout.addonDirectory) ||
          typeof layout.activeConfigPath !== 'string' || !path.isAbsolute(layout.activeConfigPath))
        fail('SETTINGS_FG_LAYOUT_UNVERIFIED', '尚未确认此游戏实际使用的 ReShade Add-on 与配置目录。');
      dir = path.resolve(layout.addonDirectory); configFile = path.resolve(layout.activeConfigPath);
      const relative = path.relative(sourceGame, dir);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        if (layout.mode !== 'external' || !same(path.dirname(configFile), dir)) fail('SETTINGS_FG_LAYOUT_UNVERIFIED', '外置 MFG 布局没有可核对的专属配置范围。');
        transactionRoot = dir;
      }
    }
    sourceRoots.set(transactionRoot.toLowerCase(), sourceGame);
    return { id, sourceGame, game: transactionRoot, exe: path.resolve(exe), exeDir, dir, configFile, layout };
  }
  const receiptFile = t => journal.safePath(t.game, path.join('_DLSS5_Backup', 'xiaofeng-fg-components.json'));
  async function recoveryContext(id) {
    const layout = typeof options.getLayout === 'function' ? options.getLayout(id) : null;
    if (!['vulkan', 'feeder'].includes(layout?.source)) return { t: target(id), special: false, applicable: true };
    const original = target(id, true);
    if (!same(layout.exe, original.exe) || !path.isAbsolute(layout.addonDirectory || '') || !path.isAbsolute(layout.activeConfigPath || '') || !path.isAbsolute(layout.runtimeDir || ''))
      fail('SETTINGS_FG_LAYOUT_UNVERIFIED', '专属运行目录没有可核对的目标身份。');
    const candidates = new Map([[original.game.toLowerCase(), original]]);
    for (const root of [layout.runtimeDir, layout.addonDirectory, path.dirname(layout.activeConfigPath)]) {
      const game = path.resolve(root); if (candidates.has(game.toLowerCase())) continue;
      const t = { ...original, game, dir: path.resolve(layout.addonDirectory), configFile: path.resolve(layout.activeConfigPath), layout };
      // Only the fixed deployment's declared scope is inspected. Receipt paths
      // never choose a new recovery directory.
      journal.safePath(t.game, path.relative(t.game, path.join(t.dir, ADDON)));
      sourceRoots.set(game.toLowerCase(), original.sourceGame); candidates.set(game.toLowerCase(), t);
    }
    const owned = [];
    for (const t of candidates.values()) {
      await noLinks(t.game); await noLinks(receiptFile(t));
      const migration = journal.safePath(t.game, path.join('_DLSS5_Backup', 'xiaofeng-fg-migration.json')); await noLinks(migration);
      const pending = await fileRecovery.inspect(t);
      if (fs.existsSync(receiptFile(t)) || fs.existsSync(migration) || pending.fileRecoveryPending || pending.fileOperationActive) owned.push({ t, pending });
    }
    if (owned.length > 1) fail('SETTINGS_FG_OWNER_CONFLICT', '多个原目录仍有 FG 恢复记录，请先处理各自恢复入口；未忽略或合并记录。');
    const chosen = owned[0];
    if (chosen && !same(chosen.t.game, original.game) && (layout.verified !== true || layout.needsRecovery || layout.blockers?.length))
      fail('SETTINGS_FG_LAYOUT_UNVERIFIED', '专属目录中的旧 FG 记录需要先恢复有效部署身份。');
    return { t: chosen?.t || original, pending: chosen?.pending, special: true, applicable: Boolean(chosen), source: layout.source };
  }
  function specialStatus(context, extra = {}) {
    return { backend: BACKEND, id: ID, route: 'not-applicable', ready: !context.applicable, managed: context.applicable, receipt: false,
      needsCleanup: context.applicable, legacyNeedsMigration: false, migrationReady: false, migrationPending: false, canPrepare: false,
      conflicts: [], blockers: context.applicable ? ['专属运行路线仍有原 FG 记录，需要先按原归属恢复。'] : [], missing: [], components: [],
      exe: context.t.exe, api: context.source, runtimeVerified: false, notApplicable: !context.applicable, ...context.pending, ...extra };
  }
  async function receipt(t) {
    const file = receiptFile(t); await noLinks(file); if (!fs.existsSync(file)) return null;
    let value;
    try { if (fs.statSync(file).size > 512 * 1024) throw new Error(); value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { fail('SETTINGS_FG_RECEIPT', 'FG 组件恢复记录损坏。'); }
    if (value?.version === 1) return value;
    const row = value?.files?.[0];
    const provider = recoveryProviderById(value?.id), old = value?.version === 2;
    if (![2, 3].includes(value?.version) || value.backend !== BACKEND || !provider || old && value.id !== 'mfgunlock-0.6.1' || !same(value.exe, t.exe) ||
        !Array.isArray(value.files) || value.files.length !== 1 || row?.role !== 'addon' ||
        row.rel !== path.relative(t.game, path.join(t.dir, ADDON)) || !(old ? ['created', 'adopted'] : ['created', 'adopted', 'replaced']).includes(row.mode) ||
        row.after !== provider.sha256 || value.releaseVersion !== provider.version) fail('SETTINGS_FG_RECEIPT', 'MFG Unlock 恢复记录身份或文件摘要无效。');
    if (row.mode === 'replaced') {
      const original = row.original;
      if (!/^_DLSS5_Backup\/\.fg-originals\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/addon\.bin$/.test(original?.snapshot || '') ||
          !knownProviderForHash(original?.sha256) || recoveryProviderById(original?.providerId)?.sha256 !== original.sha256)
        fail('SETTINGS_FG_RECEIPT', 'MFG 原组件快照身份无效。');
      await noLinks(journal.safePath(t.game, original.snapshot));
    } else if (row.original !== undefined) fail('SETTINGS_FG_RECEIPT', 'MFG 组件归属与原件记录不一致。');
    await noLinks(journal.safePath(t.game, row.rel)); return value;
  }
  async function checkRuntime(t, observed) {
    if (options.inspectFgRuntime) return options.inspectFgRuntime({ applicationDirectory: t.dir, gameDirectory: t.game, exe: t.exe, observed });
    const suppliedValue = observed?.fgRuntime?.file;
    const supplied = typeof suppliedValue === 'string' && path.isAbsolute(suppliedValue) ? suppliedValue : null;
    const candidates = [supplied, ...(observed?.dlssgFiles || []).map(row => typeof row === 'string' ? row : row.path), path.join(t.exeDir, 'nvngx_dlssg.dll')]
      .filter(value => typeof value === 'string' && path.isAbsolute(value));
    const found = [...new Set(candidates)].filter(file => fs.existsSync(file));
    const local = path.join(t.exeDir, 'nvngx_dlssg.dll');
    const file = supplied && fs.existsSync(supplied) ? supplied : fs.existsSync(local) ? local : found.length === 1 ? found[0] : null;
    if (!file) return { status: 'unknown', ready: false, message: found.length > 1 ? '发现多个 DLSS-G 运行库，尚未确定游戏采用的版本。' : '未找到可验证的 DLSS-G 运行库；需要游戏已有 310.x 或更新版本。' };
    try {
      await noLinks(file);
      const version = pe.getFileVersion?.(file), match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)(?:\.\d+){0,2}$/);
      if (pe.getBitness(file) !== 64 || !match) return { status: 'unknown', ready: false, file, version: version || null, message: 'DLSS-G 的 x64 架构或版本无法验证。' };
      if (Number(match[1]) < 310) return { status: 'outdated', ready: false, file, version, message: `DLSS-G ${version} 不包含此方案要求的现代 MFG 运行库；请核对游戏配套文件。` };
      return { status: 'available', ready: true, file, version, runtimeVerified: false, message: '已验证磁盘上的 x64 DLSS-G 版本；实际加载版本和生成帧仍需游戏内验证。' };
    } catch { return { status: 'unknown', ready: false, file, message: '无法安全读取 DLSS-G 运行库。' }; }
  }
  async function inventory(t) {
    const files = [], problems = [], pending = [...new Set([t.dir, t.exeDir])].map(dir => ({ dir, depth: 0 })), visited = new Set(); let count = 0;
    while (pending.length) {
      const next = pending.pop(); if (visited.has(next.dir.toLowerCase())) continue; visited.add(next.dir.toLowerCase()); await noLinks(next.dir);
      if (!fs.existsSync(next.dir)) continue;
      for (const entry of fs.readdirSync(next.dir, { withFileTypes: true })) {
        if (++count > 20000) return { files, problems: [...problems, '组件目录过大，无法排除第二套 MFG。'] };
        const file = path.join(next.dir, entry.name), rel = path.relative(t.game, file);
        if (entry.isSymbolicLink()) { if (COMPETING.test(rel) || /^(scripts|plugins|addons)$/i.test(entry.name)) problems.push(`组件路径是链接：${rel}`); continue; }
        if (entry.isFile() && /\.(?:dll|asi|addon64|addon32|json|lua)$/i.test(entry.name)) {
          // Directory names do not turn a separate NR/HDR addon into MFG.
          // The pinned binary's hash still catches renamed duplicate copies.
          const named = COMPETING.test(entry.name) || /^init\.lua$/i.test(entry.name) && COMPETING.test(path.basename(path.dirname(file)));
          if (named || /\.addon64$/i.test(entry.name)) {
            await noLinks(file); const hash = hashFile(file);
            if (named || knownProviderForHash(hash)) files.push({ rel, file, hash });
          }
        }
        if (entry.isDirectory() && next.depth < 6 && (next.depth > 0 || /^(scripts|plugins|addons|asi|reframework)$/i.test(entry.name) || COMPETING.test(entry.name))) pending.push({ dir: file, depth: next.depth + 1 });
      }
    }
    return { files, problems };
  }
  async function inspect(id) {
    const context = await recoveryContext(id);
    if (context.special) {
      if (!context.applicable) return specialStatus(context);
      const owned = await receipt(context.t), pending = await migrations.read(context.t);
      return specialStatus(context, { receipt: Boolean(owned), legacyNeedsMigration: owned?.version === 1, migrationPending: Boolean(pending), migrationToken: pending?.token || null });
    }
    const t = target(id); await noLinks(t.exe);
    const fileState = await fileRecovery.inspect(t);
    const observed = await scan(id), hardware = await detectHardware();
    const series = [...new Set(Array.isArray(hardware?.series) ? hardware.series : [])];
    const route = series.length === 1 && series[0] === 'RTX50' ? 'native' : series.length === 1 && series[0] === 'RTX40' ? 'compatibility' : 'unsupported';
    const conflicts = [], blockers = [], missing = [], components = [];
    if (!same(t.game, t.sourceGame) && fs.existsSync(path.join(t.sourceGame, '_DLSS5_Backup', 'xiaofeng-fg-components.json')))
      blockers.push('旧本地 MFG 组件仍有受管记录，请先在原布局恢复后再使用外置 MFG。');
    let owned = null, pending = null, legacyPlan = null, manifest = null, fgRuntime = null;
    try { owned = await receipt(t); } catch (error) { conflicts.push(error.message); }
    try { pending = await migrations.read(t); } catch (error) { conflicts.push(error.message); }
    const legacyNeedsMigration = owned?.version === 1;
    if (legacyNeedsMigration) {
      try { legacyPlan = await legacy.inspectRestore(id, { retainSharedLoaders: true }); }
      catch (error) { conflicts.push(error.message); }
    }
    const found = await inventory(t); conflicts.push(...found.problems);
    const managedOld = new Map((legacyPlan?.receipt?.files || []).map(row => [row.rel.toLowerCase(), row]));
    for (const row of found.files) {
      if (same(row.file, path.join(t.dir, ADDON))) {
        if (!knownProviderForHash(row.hash)) conflicts.push(`${ADDON} 已存在且不属于已验证版本，未覆盖。`);
        continue;
      }
      const old = managedOld.get(row.rel.toLowerCase());
      if (!old || old.mode === 'adopted' || old.after !== row.hash) conflicts.push(`检测到未受本工具管理或已修改的 MFG 组件：${row.rel}。`);
      components.push({ role: 'legacy', name: row.rel, status: old && old.mode !== 'adopted' ? 'legacy-managed' : 'external', owned: Boolean(old && old.mode !== 'adopted') });
    }
    const actual = hashFile(path.join(t.dir, ADDON));
    const installedProvider = knownProviderForHash(actual), ownedRow = owned?.version >= 2 ? owned.files[0] : null;
    if (ownedRow && actual !== null && actual !== ownedRow.after) conflicts.push('受管 MFG 文件与恢复记录不一致，请先处理外部修改。');
    if (ownedRow?.mode === 'replaced' && hashFile(journal.safePath(t.game, ownedRow.original.snapshot)) !== ownedRow.original.sha256)
      conflicts.push('MFG 原组件恢复快照缺失或发生变化，请先恢复有效原件。');
    components.push({ role: 'addon', name: ADDON, status: actual === null ? 'missing' : installedProvider ? 'ready' : 'external', owned: Boolean(ownedRow && ownedRow.mode !== 'adopted'), providerId: installedProvider?.id || null });
    let featureEvidence = null;
    if (route === 'compatibility') {
      try { manifest = readMfgUnlockResources(resources, installedProvider?.id || ID); } catch (error) { blockers.push(error.message); }
      if (pe.getBitness(t.exe) !== 64) blockers.push('所选程序不是 Windows x64 游戏 EXE。');
      if (observed?.api !== 'dx12') blockers.push(observed?.api === 'vulkan' ? 'MFG Unlock 的 Vulkan 路径仍属实验性，此准备入口仅支持 DirectX 12。' : '请先确认游戏实际使用 DirectX 12。');
      try { featureEvidence = await getFeatureEvidence(id, 'fg'); } catch { /* Missing evidence remains blocked. */ }
      const support = featureEvidence?.support;
      if (support?.status !== 'supported' || !['native-integration', 'catalog', 'trusted-mod', 'runtime'].includes(support?.source) ||
          support?.capabilities?.mfgUnlock?.available !== true)
        blockers.push(support?.message || '未确认所选游戏已有可信 Streamline 帧生成集成及兼容 MFG 运行库；此组件不会添加游戏原本没有的 FG。');
      // HoYoShade layouts load the Manager's fixed full add-on ReShade from their
      // external runtime directory (its hash is checked when the layout is read),
      // so the game-directory scan cannot see that loader.
      const managedExternalLoader = t.layout?.mode === 'external' && t.layout.verified === true && t.layout.loadingBackend === 'hoyoshade';
      if (observed?.reshadeAddon !== true && !managedExternalLoader) blockers.push('请先准备并确认支持完整 Add-on 的 ReShade。');
      if (!managedExternalLoader && observed?.reshadeAddonDirectory && !same(observed.reshadeAddonDirectory, t.dir)) blockers.push('扫描到的 Add-on 目录与已确认活动布局不同，请先刷新布局。');
      const iniFile = t.configFile; await noLinks(iniFile);
      const layout = t.layout ? { ok: true } : inspectAddonLayout(t.dir, options.environment || process.env);
      // NR owns its own direct-load compatibility checks. MFG needs the actual
      // local INI/add-on directory and separately checks competing MFG entries.
      if (!layout.ok && layout.code !== 'ERR_ADDON_DIRECT_LOAD') blockers.push('ReShade 的活动配置或 Add-on 目录不是已确认的游戏 EXE 目录。');
      if (layout.ok || layout.code === 'ERR_ADDON_DIRECT_LOAD') {
        const direct = fs.existsSync(iniFile) ? addonValues(fs.readFileSync(iniFile, 'utf8')).get('LoadFromDllMain') || [] : [];
        for (const entry of direct) {
          const file = path.resolve(path.dirname(iniFile), entry);
          if (fs.existsSync(file) && !same(file, path.join(t.dir, ADDON))) {
            await noLinks(file);
            if ((COMPETING.test(entry) || knownProviderForHash(hashFile(file))) && !managedOld.has(path.relative(t.game, file).toLowerCase())) conflicts.push(`ReShade 直接加载了另一套 MFG：${entry}。`);
          }
        }
      }
      try { fgRuntime = await checkRuntime(t, observed); } catch { fgRuntime = { ready: false, status: 'unknown', message: '无法验证 DLSS-G 运行库。' }; }
      if (fgRuntime?.ready !== true || fgRuntime.status !== 'available') blockers.push(fgRuntime?.message || 'DLSS-G 运行库尚未验证。');
      if (actual === null) missing.push(ADDON);
    } else if (route === 'unsupported') blockers.push('仅 RTX 40 使用 MFG Unlock；RTX 50 使用原生帧生成。');
    if (pending?.state === 'removing') blockers.push('FG 文件事务尚未完成，需要先恢复共享文件日志。');
    const migrationReady = Boolean(legacyNeedsMigration && legacyPlan && conflicts.length === 0 && blockers.length === 0);
    const needsCleanup = route !== 'compatibility' && Boolean(owned || actual);
    if (route === 'native' && actual && !owned) conflicts.push('检测到外部 MFG Unlock；原生 FG 路线不会自动移除它。');
    if (fileState.fileRecoveryPending) blockers.push(fileState.fileRecoveryBlocker);
    const ready = !legacyNeedsMigration && !needsCleanup && !blockers.length && !conflicts.length && (route === 'native' || route === 'compatibility' && Boolean(installedProvider));
    const allBlockers = [...blockers, ...conflicts, ...(legacyNeedsMigration ? ['旧 RTX40 MFG 需要先恢复旧设置并迁移受管组件。'] : [])];
    return { backend: BACKEND, id: ID, route, ready, managed: Boolean(owned), receipt: Boolean(owned), needsCleanup, ...fileState,
      legacyNeedsMigration, migrationReady, migrationPending: Boolean(pending), migrationToken: pending?.token || null, migrationState: pending?.state || null,
      conflicts: [...new Set(conflicts)], blockers: [...new Set(allBlockers)], missing, canPrepare: route === 'compatibility' && !legacyNeedsMigration && !blockers.length && !conflicts.length && !ready,
      components, api: observed?.api || 'unknown', exe: t.exe, fgRuntime, runtimeVerified: false, panel: 'MFG Unlock', configurationReadAt: 'process-attach',
      addonDirectory: t.dir, activeConfigPath: t.configFile, transactionRoot: t.game,
      retained: legacyPlan?.retained || [], resourceId: manifest?.id || null, featureEvidence,
      catalog: readMfgUnlockCatalog(resources), defaultProvider: ID, installedProvider: installedProvider?.id || null,
      installedProviderDetails: installedProvider, canUpgrade: route === 'compatibility' && ready && installedProvider?.id !== ID };
  }
  async function guard(t, operation, allowAntiCheat) {
    await assertGameClosed(t.game, t.exe);
    if (antiCheatPresent(t.sourceGame) && allowAntiCheat !== true) throw appError('ERR_ANTI_CHEAT_CONFIRM', { operation });
  }

  async function previewProvider(id, providerId = null) {
    const t = target(id), status = await inspect(id), before = hashFile(path.join(t.dir, ADDON));
    const selectedId = providerId || knownProviderForHash(before)?.id || ID;
    const blockers = [...status.blockers]; let selected = null;
    try { selected = readMfgUnlockResources(resources, selectedId); } catch (error) { blockers.push(error.message); }
    if (status.route !== 'compatibility') blockers.push('当前显卡不使用 RTX40 MFG Unlock。');
    const after = selected?.files.addon.sha256 || null;
    const action = before === after ? status.receipt ? 'unchanged' : 'adopt' : before === null ? 'create' : 'replace';
    const file = path.join(t.dir, ADDON);
    return { providerId: selectedId, installedProvider: status.installedProvider, file, beforeSha256: before, afterSha256: after,
      action, files: [{ path: file, role: 'mfgunlock', action, beforeSha256: before, afterSha256: after }],
      blockers: [...new Set(blockers)], canApply: blockers.length === 0, requiresRestart: action !== 'unchanged',
      activeConfigPath: t.configFile, transactionRoot: t.game, gameStarted: false };
  }
  async function snapshotAddon(t, addon, expected) {
    const rel = '_DLSS5_Backup/.fg-originals/' + crypto.randomUUID() + '/addon.bin', file = journal.safePath(t.game, rel);
    await noLinks(file); await fileRecovery.capture(t, file, expected);
    await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.copyFile(addon, file, fs.constants.COPYFILE_EXCL);
    if (hashFile(file) !== expected || hashFile(addon) !== expected) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'MFG 原组件在保存快照时发生变化。');
    return rel;
  }
  async function prepare(id, { allowAntiCheat = false, migrationToken = null, providerId = null } = {}) {
    const t = target(id); await guard(t, 'prepare-fg-components', allowAntiCheat);
    const status = await inspect(id);
    if (status.legacyNeedsMigration) fail('SETTINGS_FG_MIGRATION_REQUIRED', '请先恢复旧 FG 设置并迁移受管组件。', status);
    if (status.route !== 'compatibility') fail('SETTINGS_FG_UNSUPPORTED', '当前无需 RTX40 MFG Unlock。');
    if (status.blockers.length) fail('SETTINGS_FG_BLOCKED', status.blockers.join('\n'), status);
    const pending = await migrations.read(t);
    if (pending && (pending.token !== migrationToken || pending.state !== 'removed')) fail('SETTINGS_FG_MIGRATION_PENDING', '请完成或恢复当前迁移，不能另起一轮组件安装。');
    if (!pending && migrationToken) fail('SETTINGS_FG_MIGRATION_TOKEN', 'FG 迁移凭据已失效。');
    const prior = await receipt(t), addon = journal.safePath(t.game, path.relative(t.game, path.join(t.dir, ADDON)));
    const before = hashFile(addon), selectedId = providerId || knownProviderForHash(before)?.id || prior?.id || ID;
    const manifest = readMfgUnlockResources(resources, selectedId), after = manifest.files.addon.sha256;
    if (status.ready && prior?.version >= 2 && before === after)
      return { ...status, prepared: false, unchanged: true, changed: false, created: [], adopted: [], undoToken: null };
    const receiptBeforeText = fs.existsSync(receiptFile(t)) ? fs.readFileSync(receiptFile(t), 'utf8') : null;
    const undoToken = crypto.randomUUID(); let delta;
    const result = await fileRecovery.transaction(t, 'prepare', async () => {
      await noLinks(addon); await noLinks(receiptFile(t));
      if (hashFile(addon) !== before || hashFile(receiptFile(t)) !== (receiptBeforeText === null ? null : sha256(Buffer.from(receiptBeforeText)))) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 文件在准备前改变。');
      const fresh = await inspect(id);
      if (fresh.blockers.length) fail('SETTINGS_FG_BLOCKED', fresh.blockers.join('\n'));
      const verified = readMfgUnlockResources(resources, selectedId);
      await assertGameClosed(t.game, t.exe);
      let backupRel = null;
      if (before !== after) {
        if (before !== null) {
          if (!knownProviderForHash(before)) fail('SETTINGS_FG_EXTERNAL_CHANGE', '未替换未知 MFG 文件。');
          backupRel = await snapshotAddon(t, addon, before);
        }
        await fileRecovery.capture(t, addon, after);
        if (before !== null) {
          if (hashFile(addon) !== before) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 文件在替换前改变。');
          await fsp.unlink(addon);
        }
        await copyNewFile({ journal, game: t.game, source: verified.files.addon.source, dest: addon, copyFile: options.copyFile });
      }
      if (hashFile(addon) !== after) fail('SETTINGS_FG_WRITE', 'MFG Unlock 写入后摘要不匹配。');
      const originalRow = prior?.files?.[0];
      let mode = originalRow?.mode || (before === null ? 'created' : 'adopted'), original = originalRow?.original;
      if (mode === 'adopted' && before !== after) {
        mode = 'replaced'; original = { snapshot: backupRel, sha256: before, providerId: knownProviderForHash(before).id };
      }
      const row = { role: 'addon', rel: path.relative(t.game, addon), mode, after, ...(original ? { original } : {}) };
      const next = { version: 3, backend: BACKEND, id: selectedId, releaseVersion: manifest.releaseVersion, exe: t.exe, preparedAt: new Date().toISOString(), files: [row] };
      await fileRecovery.capture(t, receiptFile(t), jsonHash(next)); await (options.writeReceipt || atomicJson)(receiptFile(t), next);
      const receiptAfter = hashFile(receiptFile(t));
      if (JSON.stringify(await receipt(t)) !== JSON.stringify(next)) fail('SETTINGS_FG_WRITE', 'MFG Unlock 收据写入校验失败。');
      delta = { undoToken, addonRel: row.rel, addonBefore: before, addonAfter: after, addonBeforeSnapshot: backupRel, receiptBeforeText, receiptAfter };
      if (pending) await migrations.prepared(t, migrationToken, delta);
      return { backend: BACKEND, id: selectedId, providerId: selectedId, route: 'compatibility', prepared: true, changed: true,
        created: before === null ? [ADDON] : [], replaced: before !== null && before !== after ? [ADDON] : [],
        adopted: before === after ? [ADDON] : [], components: [row], undoToken, migrationToken, runtimeVerified: false, restartRequired: true };
    });
    undos.set(undoToken, { t, delta, migrationToken }); return result;
  }
  async function rollbackPrepare(id, token) {
    if (!token) return { restored: false, unchanged: true };
    const undo = undos.get(token), t = target(id);
    if (!undo || !same(undo.t.exe, t.exe)) fail('SETTINGS_FG_UNDO_TOKEN', '本轮 FG 准备撤销凭据无效。');
    await assertGameClosed(t.game, t.exe);
    const { delta } = undo, addon = journal.safePath(t.game, delta.addonRel);
    const check = async () => { await noLinks(addon); await noLinks(receiptFile(t));
      if (hashFile(addon) !== delta.addonAfter || hashFile(receiptFile(t)) !== delta.receiptAfter) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 准备后文件已被外部修改，未撤销。');
      if (delta.addonBeforeSnapshot) {
        const original = journal.safePath(t.game, delta.addonBeforeSnapshot); await noLinks(original);
        if (hashFile(original) !== delta.addonBefore) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 撤销原件已发生变化。');
      }
    };
    await check();
    const result = await fileRecovery.transaction(t, 'undo-prepare', async () => {
      await check();
      await assertGameClosed(t.game, t.exe);
      if (delta.addonBefore === null) { await fileRecovery.capture(t, addon, null); await fsp.unlink(addon); }
      else if (delta.addonBeforeSnapshot) {
        await fileRecovery.capture(t, addon, delta.addonBefore);
        await fsp.copyFile(journal.safePath(t.game, delta.addonBeforeSnapshot), addon);
        if (hashFile(addon) !== delta.addonBefore) fail('SETTINGS_FG_WRITE', 'MFG 撤销原件摘要不符。');
      }
      await fileRecovery.capture(t, receiptFile(t), delta.receiptBeforeText === null ? null : sha256(Buffer.from(delta.receiptBeforeText)));
      if (delta.receiptBeforeText === null) await fsp.unlink(receiptFile(t)); else await fsp.writeFile(receiptFile(t), delta.receiptBeforeText, 'utf8');
      if (undo.migrationToken) await migrations.unprepare(t, undo.migrationToken);
      return { restored: true, removed: delta.addonBefore === null ? [ADDON] : [], retained: delta.addonBefore !== null ? [ADDON] : [], runtimeVerified: false };
    });
    undos.delete(token); return result;
  }
  async function restoreLegacy(id, restoreOptions = {}, recoveryTarget = null) {
    const t = recoveryTarget || target(id);
    if (!same(t.game, t.sourceGame)) fail('SETTINGS_FG_RECEIPT', '旧版 FG 的恢复记录必须保留在原游戏目录。');
    const adapter = createLegacyFgComponents({ ...options, journal: { ...journal,
      transaction: (_game, work) => fileRecovery.transaction(t, 'legacy-restore', work) } });
    return adapter.restore(id, { ...restoreOptions, beforeMutation: async plan => {
      const retained = new Set(plan.retained.map(rel => rel.toLowerCase()));
      for (const row of plan.receipt.files) {
        if (row.mode === 'adopted' || retained.has(row.rel.toLowerCase())) continue;
        await fileRecovery.capture(t, journal.safePath(t.game, row.rel), row.mode === 'created' ? null : row.before);
      }
      await fileRecovery.capture(t, receiptFile(t), null);
      await restoreOptions.beforeMutation?.(plan);
    } });
  }
  async function migrateLegacy(id, { allowAntiCheat = false } = {}) {
    const t = target(id); await guard(t, 'migrate-fg-components', allowAntiCheat);
    const pending = await migrations.read(t);
    if (pending) fail('SETTINGS_FG_MIGRATION_PENDING', '已有待完成的 FG 迁移。', { migrationToken: pending.token });
    const status = await inspect(id);
    if (!status.legacyNeedsMigration) return { migrated: false, unchanged: true, migrationToken: null };
    if (!status.migrationReady) fail('SETTINGS_FG_MIGRATION_BLOCKED', status.blockers.join('\n'), status);
    let record;
    const result = await restoreLegacy(id, { retainSharedLoaders: true,
      beforeMutation: async plan => { record = await migrations.begin(t, plan); await assertGameClosed(t.game, t.exe); },
      afterMutation: async () => { record = await migrations.removed(t); } });
    return { ...result, migrated: true, backend: BACKEND, id: ID, migrationToken: record.token, migrationPending: true };
  }
  async function restore(id) {
    const context = await recoveryContext(id), t = context.t; await noLinks(t.exe);
    if (context.special && !context.applicable) return { restored: false, unchanged: true, notApplicable: true, source: context.source };
    if (context.pending?.fileRecoveryPending || context.pending?.fileOperationActive) fail('SETTINGS_FG_FILE_RECOVERY_REQUIRED', 'FG 文件操作尚未恢复，请先处理原组件事务。');
    if (await migrations.read(t)) fail('SETTINGS_FG_MIGRATION_PENDING', '迁移快照仍在，请使用迁移恢复入口。');
    const prior = await receipt(t); if (!prior) return { restored: false, unchanged: true };
    if (prior.version === 1) return restoreLegacy(id, { retainSharedLoaders: true }, t);
    await assertGameClosed(t.game, t.exe);
    const row = prior.files[0], addon = journal.safePath(t.game, row.rel);
    const check = async () => { await noLinks(addon); const now = await receipt(t);
      if (JSON.stringify(now) !== JSON.stringify(prior)) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'FG 收据已改变。');
      const actual = hashFile(addon); if (row.mode !== 'adopted' && actual !== null && actual !== row.after) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'MFG Unlock 已被外部修改，未恢复。');
      if (row.mode === 'replaced') {
        const original = journal.safePath(t.game, row.original.snapshot); await noLinks(original);
        if (hashFile(original) !== row.original.sha256) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'MFG 原组件快照缺失或已修改，未恢复。');
      }
    };
    await check();
    return fileRecovery.transaction(t, 'restore', async () => {
      await check();
      await assertGameClosed(t.game, t.exe);
      if (row.mode === 'created' && fs.existsSync(addon)) { await fileRecovery.capture(t, addon, null); await fsp.unlink(addon); }
      if (row.mode === 'replaced') {
        await fileRecovery.capture(t, addon, row.original.sha256);
        await fsp.copyFile(journal.safePath(t.game, row.original.snapshot), addon);
        if (hashFile(addon) !== row.original.sha256) fail('SETTINGS_FG_WRITE', 'MFG 原组件恢复摘要不符。');
      }
      await fileRecovery.capture(t, receiptFile(t), null); await fsp.unlink(receiptFile(t));
      return { restored: true, retained: row.mode === 'adopted' ? [row.rel] : [], originalsRestored: row.mode === 'replaced' ? [row.rel] : [], runtimeVerified: false };
    });
  }
  async function noOwnershipInUnverifiedLayout(id) {
    if (typeof options.getLayout !== 'function') return false;
    function scopes() {
      const original = target(id, true), layout = options.getLayout(id);
      if (layout?.verified !== false || layout.needsRecovery || ['vulkan', 'feeder'].includes(layout.source)) return null;
      if (!same(layout.exe, original.exe) || !['local', 'external'].includes(layout.mode) ||
          typeof layout.addonDirectory !== 'string' || !path.isAbsolute(layout.addonDirectory) ||
          typeof layout.activeConfigPath !== 'string' || !path.isAbsolute(layout.activeConfigPath) ||
          layout.runtimeDir !== undefined && (typeof layout.runtimeDir !== 'string' || !path.isAbsolute(layout.runtimeDir)))
        fail('SETTINGS_FG_LAYOUT_UNVERIFIED', '尚未确认此游戏实际使用的 ReShade Add-on 与配置目录。');
      const roots = [...new Map([original.sourceGame, original.exeDir, layout.runtimeDir, layout.addonDirectory, path.dirname(layout.activeConfigPath)]
        .filter(Boolean).map(root => [path.resolve(root).toLowerCase(), path.resolve(root)])).values()];
      return { roots, identity: JSON.stringify([original.sourceGame.toLowerCase(), original.exe.toLowerCase(), layout.source, layout.mode,
        ...roots.map(root => root.toLowerCase()), path.resolve(layout.activeConfigPath).toLowerCase()]) };
    }
    const before = scopes(); if (!before) return false;
    // This proves only that this read-only query has no component owner to
    // report. An unverified layout never becomes an MFG write/recovery target.
    // Inspect fixed metadata names in at most five independently known scopes;
    // neither directory contents nor receipt fields can add search roots.
    for (const game of before.roots) {
      for (const file of [receiptFile({ game }), migrations.recordFile({ game }), journal.pendingPath(game)]) {
        await noLinks(file);
        try { await fsp.lstat(file); return false; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const after = scopes();
    if (!after || after.identity !== before.identity)
      fail('SETTINGS_FG_LAYOUT_UNVERIFIED', 'ReShade 目录在 FG 归属检查期间改变，请重新检查。');
    return true;
  }
  async function ownedModuleManifest(id) {
    if (await noOwnershipInUnverifiedLayout(id)) return [];
    const context = await recoveryContext(id), t = context.t;
    if (context.special && !context.applicable) return [];
    if (context.special) fail('SETTINGS_FG_UNSUPPORTED', '专属运行路线的旧 FG 记录仅供恢复，不能用作当前加载允许清单。');
    const fileState = await fileRecovery.inspect(t);
    if (fileState.fileRecoveryPending || fileState.fileOperationActive || await migrations.read(t)) fail('SETTINGS_FG_FILE_RECOVERY_REQUIRED', 'FG 记录尚未恢复，不能签发加载允许清单。');
    if (!same(t.game, t.sourceGame) && fs.existsSync(path.join(t.sourceGame, '_DLSS5_Backup', 'xiaofeng-fg-components.json')))
      fail('SETTINGS_FG_OWNER_CONFLICT', '旧本地 FG 记录尚未恢复，不能为外置组件签发允许清单。');
    const owned = await receipt(t); if (!owned) return [];
    if (![2, 3].includes(owned.version)) fail('SETTINGS_FG_MIGRATION_REQUIRED', '旧 FG 记录需要先恢复或迁移，不能当作 MFG Unlock 的加载身份。');
    const row = owned.files[0], file = journal.safePath(t.game, row.rel); await noLinks(file);
    if (hashFile(file) !== row.after || pe.getBitness(file) !== 64) fail('SETTINGS_FG_EXTERNAL_CHANGE', 'MFG Unlock 文件与受管记录的固定摘要或位数不一致。');
    return [{ path: file, name: ADDON, role: 'mfgunlock', sha256: row.after, architecture: 64, owner: 'fg-mfgunlock' }];
  }
  return Object.freeze({ inspect, prepare, restore, migrateLegacy, rollbackPrepare, ownedModuleManifest, previewProvider, catalog: () => readMfgUnlockCatalog(resources),
    inspectPending: async id => { const context = await recoveryContext(id); return fileRecovery.inspect(context.t); },
    recoverPending: async id => { const context = await recoveryContext(id); return fileRecovery.recover(context.t); },
    inspectMigration: async id => { const { t } = await recoveryContext(id), pending = await migrations.read(t); return { migrationPending: Boolean(pending), migrationToken: pending?.token || null, ...await fileRecovery.inspect(t) }; },
    commitPrepare: (id, token) => { const t = target(id), undo = undos.get(token); if (undo && !same(undo.t.exe, t.exe)) fail('SETTINGS_FG_UNDO_TOKEN', 'FG 撤销凭据属于另一游戏。'); undos.delete(token); return { committed: true }; },
    rollbackMigration: async (id, token) => migrations.finish(id, (await recoveryContext(id)).t, token, true),
    commitMigration: async (id, token) => migrations.finish(id, (await recoveryContext(id)).t, token, false),
    receiptFile: id => receiptFile(target(id)) });
}
module.exports = { createMfgUnlockComponents };
