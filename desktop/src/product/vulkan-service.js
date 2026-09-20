'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { appError } = require('./errors');
const { inside, noLinks, atomicJson } = require('./launch-safety');
const { createVulkanRuntimeProfile } = require('./vulkan-runtime-profile');
const { createVulkanDeployment } = require('./vulkan-deployment');
const { createReshadeVulkanActivation } = require('./reshade-vulkan-activation');
const { createWindowsRegistryValues } = require('./windows-registry-values');
const { createGameLaunchBroker, executionLevel } = require('./game-launch-broker');
const { createVulkanRuntimeEvidence } = require('./vulkan-runtime-evidence');
const { detectGpuAsync } = require('./gpu');
const guardsDefault = require('../core/install-guards');
const peDefault = require('../core/pe');

const PRODUCT = 'xiaofeng-vulkan-bindings';
const ID = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._+-]{0,127}$/i;
const HASH = /^[a-f0-9]{64}$/;
const queues = new Map();
const key = value => path.resolve(value).toLowerCase();
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && key(a) === key(b);
const exeHash = exe => crypto.createHash('sha256').update(key(exe)).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const errorData = error => ({ code: error?.code || 'VULKAN_OPERATION_FAILED', message: error?.message || 'Vulkan 操作失败。' });
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') &&
  (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value));

function readJson(file, max = 256 * 1024) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > max) fail('VULKAN_RECORD_INVALID', 'Vulkan 记录不是安全的普通文件或大小无效。');
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('VULKAN_')) throw error;
    fail('VULKAN_RECORD_INVALID', 'Vulkan 记录无法读取，请保留文件并提交反馈。', { file: path.basename(file), cause: error.code || 'json' });
  }
}

function createVulkanService(options = {}) {
  if (!absolute(options.userData) || !absolute(options.appDir)) fail('VULKAN_BAD_CONFIG', 'Vulkan 服务缺少绝对的应用或用户数据路径。');
  const userData = path.resolve(options.userData), overrides = options.overrides || {};
  const bindingPath = path.join(userData, 'vulkan-bindings.json');
  const profile = overrides.profile || createVulkanRuntimeProfile({ userData, pe: overrides.pe || peDefault });
  const identity = createVulkanRuntimeProfile({ userData });
  const evidence = overrides.evidence || createVulkanRuntimeEvidence({ userData });
  const guards = overrides.guards || guardsDefault, pe = overrides.pe || peDefault;
  const readExecutionLevel = overrides.executionLevel || executionLevel;
  const writeBinding = overrides.writeBinding || atomicJson;
  let hardware = options.hardware && typeof options.hardware !== 'function' ? options.hardware : null;
  const detectHardware = typeof options.hardware === 'function' ? options.hardware : overrides.detectHardware || detectGpuAsync;
  if (!hardware) void Promise.resolve().then(detectHardware).then(value => { hardware = value; }, () => {});
  let deployment = overrides.deployment, broker = overrides.broker;

  function bindingIdentity(row) {
    const fullExeId = exeHash(row.exe), leaf = path.basename(row.basePath);
    const short = same(path.dirname(row.basePath), path.join(userData, 'vulkan-runtime', fullExeId.slice(0, 16))) &&
      row.exeId === fullExeId && HASH.test(row.fingerprint || '') && leaf === row.fingerprint.slice(0, 16);
    const legacy = same(path.dirname(row.basePath), path.join(userData, 'vulkan-runtime', fullExeId)) &&
      leaf.startsWith(`${row.packageId}-`) && /^[a-f0-9]{16}$/.test(leaf.slice(row.packageId.length + 1)) &&
      (row.exeId === undefined || row.exeId === fullExeId) &&
      (row.fingerprint === undefined || HASH.test(row.fingerprint) && leaf.endsWith(row.fingerprint.slice(0, 16)));
    if (!short && !legacy) return false;
    const receipt = readJson(path.join(row.basePath, '.xiaofeng-vulkan-runtime.json'), 128 * 1024);
    if (!receipt) return true; // an interrupted archive is recovered from its full receipt below
    try {
      const checked = identity.identifyReceipt({ receipt, exe: row.exe, basePath: row.basePath });
      return checked.recipe.id === row.packageId && checked.recipe.coreVersion === row.coreVersion &&
        (!short || checked.recipe.fingerprint === row.fingerprint);
    } catch { return false; }
  }

  function bindings() {
    let state;
    try { state = readJson(bindingPath, 2 * 1024 * 1024); }
    catch (error) { error.details = { ...error.details, needsRecovery: true }; throw error; }
    if (!state) return { version: 1, product: PRODUCT, bindings: [] };
    if (state.version !== 1 || state.product !== PRODUCT || !Array.isArray(state.bindings) || state.bindings.length > 4096)
      fail('VULKAN_BINDING_INVALID', 'Vulkan 绑定记录损坏，未修改任何游戏。', { needsRecovery: true });
    const exes = new Set(), groups = new Set();
    for (const row of state.bindings) {
      const external = row?.sourceKind === 'external-provider';
      const acceptanceValid = external
        ? ['candidate', 'processed'].includes(row?.acceptance?.status) && ['RTX40', 'RTX50'].includes(row?.acceptance?.hardwareFamily)
        : row?.acceptance?.status === 'processed' && row?.acceptance?.hardwareFamily === 'RTX50';
      if (!row || typeof row.gameId !== 'string' || !row.gameId || row.gameId.length > 256 || !absolute(row.exe) ||
          !absolute(row.dir) || !inside(row.dir, row.exe) || !/\.exe$/i.test(row.exe) || !absolute(row.basePath) ||
          !ID.test(row.coreVersion || '') || !ID.test(row.packageId || '') ||
          row.sourceKind !== undefined && !['bundled', 'external-provider'].includes(row.sourceKind) ||
          row.sourceKind === 'external-provider' && (!PROVIDER_ID.test(row.providerPackageId || '') || !PROVIDER_ID.test(row.providerRouteId || '')) ||
          !bindingIdentity(row) ||
          !['prepared', 'installed', 'deactivated', 'archived'].includes(row.phase) ||
          row.archiveBefore !== undefined && (!Array.isArray(row.archiveBefore) || row.archiveBefore.length > 256 || row.archiveBefore.some(name => typeof name !== 'string' || path.basename(name) !== name)) ||
          !acceptanceValid)
        fail('VULKAN_BINDING_INVALID', 'Vulkan 绑定的 EXE、profile 或验收身份无效。', { needsRecovery: true });
      const group = key(path.dirname(row.exe));
      if (exes.has(key(row.exe)) || groups.has(group)) fail('VULKAN_BINDING_INVALID', 'Vulkan 绑定包含重复 EXE 或冲突的 ReShade.ini 作用域。', { needsRecovery: true });
      exes.add(key(row.exe)); groups.add(group);
    }
    return state;
  }
  function bound(game, state = bindings()) {
    const exe = game?.scan?.chosen?.path;
    return state.bindings.find(row => absolute(exe) && same(row.exe, exe)) || state.bindings.find(row => row.gameId === game?.id) || null;
  }
  function selected(game) {
    const exe = game?.scan?.chosen?.path;
    if (!game || typeof game.id !== 'string' || !game.id || game.id.length > 256 || !absolute(game.dir) ||
        !absolute(exe) || !inside(game.dir, exe) || !/\.exe$/i.test(exe)) throw appError('ERR_NO_GAME_EXE');
    return { id: game.id, exe: path.resolve(exe), dir: path.resolve(game.dir) };
  }
  function assertSelected(row, target) {
    if (row && !same(row.exe, target.exe)) fail('VULKAN_BOUND_EXE_CHANGED', '该游戏已绑定另一 Vulkan EXE，请先恢复原绑定再切换程序。');
  }
  function vulkanRoute(game) { return game?.scan?.chosen?.apiResolution?.api === 'vulkan'; }
  function rtx50(value) {
    if (value?.family !== 'RTX50') return false;
    if (Array.isArray(value.series)) return [...new Set(value.series)].length === 1 && value.series[0] === 'RTX50';
    return Array.isArray(value.families) && value.families.length === 1 && value.families[0] === 'RTX50';
  }
  function hardwareAccepted(source) {
    const acceptance = source?.recipe?.acceptance || source?.acceptance;
    if (source?.sourceKind === 'external-provider')
      return ['candidate', 'processed'].includes(acceptance?.status) && acceptance.hardwareFamily === hardware?.family;
    return rtx50(hardware);
  }
  async function assertHardware(source) {
    if (!options.hardware || typeof options.hardware === 'function') hardware = await detectHardware();
    if (!hardwareAccepted(source)) fail('VULKAN_GPU_UNSUPPORTED', source?.sourceKind === 'external-provider'
      ? '当前外部 Provider Vulkan 候选与已识别硬件族不匹配。'
      : '当前 Vulkan 固定运行包仅验收了 RTX 50，尚未确认该设备匹配。');
  }
  function recipeFile(folder) {
    const packaged = options.resourcesPath && path.join(options.resourcesPath, folder, 'recipe.json');
    if (packaged && fs.existsSync(packaged)) return packaged;
    return path.join(options.appDir, 'resources', folder, 'recipe.json');
  }
  function packages(exe, game, row = null) {
    const runtimeFile = recipeFile('vulkan-runtime'), layerFile = recipeFile('vulkan-reshade');
    let external = null;
    if (!row || row.sourceKind === 'external-provider')
      external = options.getExternalProviderPackage?.(game, row ? { providerId: row.providerPackageId, providerRouteId: row.providerRouteId } : {}) || null;
    if (row?.sourceKind === 'external-provider' && !external)
      fail('VULKAN_PACKAGE_MISSING', '原外部 Provider Vulkan 配套当前不完整；已安装 profile 仍可恢复。');
    const recipe = external?.recipe || readJson(runtimeFile), layer = readJson(layerFile);
    if (!recipe || !layer) fail('VULKAN_PACKAGE_MISSING', '尚未提供通过验收的 Vulkan 配套运行包。');
    const sourceKind = external ? 'external-provider' : 'bundled';
    if ((sourceKind === 'bundled' && (recipe.acceptance?.status !== 'processed' || recipe.acceptance?.hardwareFamily !== 'RTX50')) ||
        (sourceKind === 'external-provider' && (!['candidate', 'processed'].includes(recipe.acceptance?.status) || !['RTX40', 'RTX50'].includes(recipe.acceptance?.hardwareFamily))))
      fail('VULKAN_ACCEPTANCE_PENDING', '这份 Vulkan 运行包没有可登记的验收状态。');
    const place = profile.location({ exe, recipe }); // small recipe metadata only
    identity.assertPathBudget({ basePath: place.basePath, recipe });
    if (layer.version !== 1 || layer.architecture !== 64 || !ID.test(layer.id || '') || !layer.layer ||
        typeof layer.layer.manifest !== 'string' || path.basename(layer.layer.manifest) !== layer.layer.manifest ||
        typeof layer.layer.library !== 'string' || path.basename(layer.layer.library) !== layer.layer.library)
      fail('VULKAN_RECIPE_INVALID', 'Vulkan ReShade 配套清单无效。');
    const packageRoot = external?.packageRoot || path.dirname(runtimeFile), sourceRoot = path.dirname(layerFile);
    for (const file of [...recipe.files.map(row => path.resolve(packageRoot, row.source)),
      path.join(sourceRoot, layer.layer.manifest), path.join(sourceRoot, layer.layer.library)]) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail('VULKAN_PACKAGE_MISSING', 'Vulkan 配套运行包缺少文件。', { file: path.basename(file) });
    }
    return { recipe, packageRoot, layer: { ...layer, sourceRoot }, place, sourceKind,
      providerPackageId: external?.providerPackageId || null, providerRouteId: external?.providerRouteId || null };
  }
  function resolveBasePath(exe) {
    const row = bindings().bindings.find(item => same(item.exe, exe));
    if (!row) fail('VULKAN_BINDING_MISSING', '尚未保存该 EXE 的 Vulkan profile 绑定。');
    return row.basePath; // always the durable old binding, never current recipe
  }
  const activation = overrides.activation || createReshadeVulkanActivation({ userData, resolveBasePath });
  const getBroker = () => broker || (broker = createGameLaunchBroker({ resourcesPath: options.resourcesPath }));
  function getDeployment() {
    return deployment || (deployment = createVulkanDeployment({ userData, pe,
      registry: overrides.registry || createWindowsRegistryValues({ key: 'Software\\Khronos\\Vulkan\\ImplicitLayers', resourcesPath: options.resourcesPath }),
      activation, inspectLaunchContext: target => getBroker().inspect({ exe: target.exe }), externalLayer: overrides.externalLayer }));
  }
  function serial(work) {
    const queueKey = key(bindingPath), previous = queues.get(queueKey) || Promise.resolve();
    const next = previous.then(work, work), held = next.catch(() => {});
    queues.set(queueKey, held); void held.finally(() => { if (queues.get(queueKey) === held) queues.delete(queueKey); });
    return next;
  }
  async function save(row) {
    await noLinks(bindingPath);
    const state = bindings(), index = state.bindings.findIndex(item => same(item.exe, row.exe));
    if (index < 0) state.bindings.push(row); else state.bindings[index] = row;
    await writeBinding(bindingPath, state);
  }
  async function remove(row) {
    await noLinks(bindingPath);
    const state = bindings(); state.bindings = state.bindings.filter(item => !same(item.exe, row.exe));
    await writeBinding(bindingPath, state);
  }
  function assertNoNativeReceipt(target) {
    let dir = path.dirname(target.exe);
    for (let count = 0; count < 64 && inside(target.dir, dir); ++count) {
      if (fs.existsSync(path.join(dir, '_DLSS5_Backup', 'xiaofeng-manager.json')))
        fail('VULKAN_NATIVE_INSTALL_PRESENT', '该游戏仍有 DX11/DX12 安装记录，请先卸载再安装 Vulkan 配套。');
      if (same(dir, target.dir)) break;
      dir = path.dirname(dir);
    }
  }
  async function closed(target) {
    await noLinks(target.dir); await noLinks(target.exe);
    await guards.assertGameClosed(target.dir, target.exe);
  }
  function recoveryHint(game) {
    // These bounded metadata reads only keep an orphan visible. They never
    // authorize writes or reconstruct a lost binding from an INI.
    const exe = game?.scan?.chosen?.path;
    let matched = false, uncertain = false;
    if (absolute(exe)) {
      try {
        const ini = path.join(path.dirname(exe), 'ReShade.ini'), stat = fs.lstatSync(ini);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 256 * 1024) uncertain = true;
        else matched = /^\s*XiaofengVulkanMarker\s*=/mi.test(fs.readFileSync(ini, 'utf8'));
      } catch (error) { if (error.code !== 'ENOENT') uncertain = true; }
    }
    for (const name of ['receipt.json', 'pending.json']) {
      try {
        const record = readJson(path.join(userData, 'vulkan-deployment', name), 2 * 1024 * 1024);
        const refs = [record?.refs, record?.beforeReceipt?.refs, record?.targetReceipt?.refs].filter(Array.isArray).flat();
        matched ||= refs.some(ref => absolute(exe) && same(ref?.exe, exe) || ref?.id === game?.id);
      } catch { uncertain = true; }
    }
    return { matched, uncertain };
  }
  function assertNoOrphan(game) {
    const hint = recoveryHint(game);
    if (hint.matched || hint.uncertain) fail('VULKAN_BINDING_MISSING', 'Vulkan 来源记录或激活仍存在，但完整绑定无法确认；请保留记录并提交反馈后恢复。', { needsRecovery: true });
  }
  function summary(game) {
    let row = null, source = null, reason = null, needsRecovery = false;
    try {
      row = bound(game); const target = selected(game); assertSelected(row, target);
      source = packages(target.exe, game, row);
      if (!hardwareAccepted(source)) reason = source.sourceKind === 'external-provider'
        ? '外部 Provider Vulkan 候选与当前硬件族不匹配。' : '尚未确认唯一的 RTX 50 设备。';
      else if (game.scan.chosen.bitness !== 64) reason = '当前 Vulkan 配套仅支持 x64。';
      if (row && row.phase !== 'installed') { reason = 'Vulkan 绑定有未完成操作，请先诊断或恢复。'; needsRecovery = true; }
      else if (row && !same(row.basePath, source.place.basePath)) reason = '已安装旧固定配套；升级前需要先恢复。';
      if (row) {
        const receipt = readJson(path.join(row.basePath, '.xiaofeng-vulkan-runtime.json'), 128 * 1024);
        if (receipt && !identity.pathBudget({ basePath: row.basePath, recipe: receipt.recipe }).safe) {
          reason = '旧 Vulkan 运行路径过长。请先在设置中点击“卸载插件”，再用新版管理器重新安装；新配套会自动使用短目录。'; needsRecovery = true;
        }
      }
      if (!reason && ['requireAdministrator', 'highestAvailable'].includes(readExecutionLevel(target.exe)))
        reason = '该游戏 EXE 要求管理员权限；当前 Vulkan 用户加载层仅支持普通权限游戏。';
    } catch (error) { reason = error.message; needsRecovery ||= error.details?.needsRecovery === true; }
    const hint = row ? { matched: false, uncertain: false } : recoveryHint(game);
    if (hint.matched || hint.uncertain) { needsRecovery = true; reason ||= 'Vulkan 来源记录或激活仍存在，请先诊断绑定恢复状态。'; }
    needsRecovery ||= Boolean(row && row.phase !== 'installed');
    // Draft API choices have not changed the saved route yet. Report whether
    // this fixed package can be selected separately from current-route readiness.
    const selectionAvailable = !reason && !needsRecovery && Boolean(source) && hardwareAccepted(source) && game?.scan?.chosen?.bitness === 64;
    const selectionReason = reason;
    if (!reason && !vulkanRoute(game)) reason = '当前游戏路线不是已确认的 Vulkan。';
    return { available: selectionAvailable && vulkanRoute(game), selectionAvailable, selectionReason,
      installed: Boolean(row) || hint.matched, status: row?.phase || (needsRecovery ? 'recovery-required' : 'absent'), needsRecovery,
      coreVersion: row?.coreVersion || source?.recipe.coreVersion || null,
      packageId: row?.packageId || source?.recipe.id || null, reason, experimental: true,
      sourceKind: row?.sourceKind || source?.sourceKind || 'bundled',
      providerPackageId: row?.providerPackageId || source?.providerPackageId || null,
      providerRouteId: row?.providerRouteId || source?.providerRouteId || null,
      gameVerified: source?.recipe.acceptance?.realGameVerified === true };
  }
  function configDir(game) { return bound(game)?.basePath || null; }
  async function inspectBound(row, readOnly = false) {
    const target = { id: row.gameId, exe: row.exe };
    const results = await Promise.allSettled([profile.inspect({ exe: row.exe, basePath: row.basePath }),
      (readOnly ? getDeployment().peek(target) : getDeployment().inspect(target)), activation.read(row.exe)]);
    const components = Object.fromEntries(['profile', 'deployment', 'activation'].map((name, index) => [name,
      results[index].status === 'fulfilled' ? results[index].value : { ready: false, error: errorData(results[index].reason) }]));
    const blockers = Object.values(components).flatMap(value => value.error ? [value.error.message] : value.blockers || []);
    const ready = components.profile.ready === true && components.deployment.ready === true && components.activation.active === true;
    const runtime = await evidence.readEvidence({ basePath: row.basePath, startedAt: row.lastLaunch?.startedAt, pid: row.lastLaunch?.pid })
      .catch(() => ({ loaded: 'unknown', processed: 'unknown', detail: '本次运行日志暂时无法读取。' }));
    return { installed: row.phase === 'installed', ready, pending: row.phase !== 'installed' || components.deployment.status === 'pending',
      status: components.deployment.status === 'pending' || row.phase !== 'installed' ? 'pending' : ready ? 'installed' : 'blocked',
      coreVersion: row.coreVersion, packageId: row.packageId, configDir: row.basePath, ...runtime,
      runtimeVerified: false, experimental: true, blockers, components };
  }
  async function diagnose(game) {
    const row = bound(game);
    if (!row) {
      const info = summary(game);
      return { ...info, ready: false, pending: info.needsRecovery, loaded: 'unknown', processed: 'unknown', runtimeVerified: false,
        blockers: info.needsRecovery ? [info.reason] : [], components: {} };
    }
    return inspectBound(row);
  }
  async function verifySource(game, request = {}) {
    const target = selected(game), row = bound(game); assertSelected(row, target);
    if (game.scan.chosen.bitness !== 64 || pe.getBitness(target.exe) !== 64) fail('VULKAN_GAME_ARCH', '当前 Vulkan 配套仅支持 x64 游戏。');
    const source = packages(target.exe, game, row); await assertHardware(source);
    if (!vulkanRoute(game)) fail('VULKAN_API_REQUIRED', '请先确认所选 EXE 使用 Vulkan。');
    if (request.version !== undefined && ![source.recipe.id, source.recipe.coreVersion, source.providerPackageId].includes(request.version))
      fail('VULKAN_PACKAGE_LOCKED', 'Vulkan Core 必须使用当前固定配套。');
    // Existing preview-only owners verify source hashes and the layer without
    // creating runtime directories, activation or registry entries.
    await profile.previewPrepare({ exe: target.exe, recipe: source.recipe, packageRoot: source.packageRoot });
    await getDeployment().previewPrepare({ id: target.id, exe: target.exe }, source.layer);
    return { ready: true, packageId: source.recipe.id, coreVersion: source.recipe.coreVersion,
      identity: JSON.stringify({ recipe: source.recipe, layer: source.layer }), runtimeVerified: false };
  }
  async function previewInstall(game, installOptions = {}) {
    const target = selected(game), state = bindings(), row = bound(game, state);
    assertSelected(row, target);
    if (state.bindings.some(item => !same(item.exe, target.exe) && same(path.dirname(item.exe), path.dirname(target.exe))))
      fail('VULKAN_DIRECTORY_BOUND', '同目录的另一 EXE 已绑定 Vulkan profile，共享 ReShade.ini 不能指向不同配套。');
    if (!row) assertNoOrphan(game);
    if (!vulkanRoute(game)) fail('VULKAN_API_REQUIRED', '请先确认所选 EXE 使用 Vulkan，再安装该配套。');
    if (game.scan.chosen.bitness !== 64 || pe.getBitness(target.exe) !== 64) fail('VULKAN_GAME_ARCH', '当前 Vulkan 配套仅支持 x64 游戏。');
    const source = packages(target.exe, game, row); await assertHardware(source);
    const requested = installOptions.version ?? installOptions.packageId ?? installOptions.coreVersion;
    if (requested !== undefined && requested !== source.recipe.id && requested !== source.recipe.coreVersion && requested !== source.providerPackageId)
      fail('VULKAN_PACKAGE_LOCKED', 'Vulkan Core 必须使用当前固定配套，不能单独切换核心版本。');
    await closed(target); assertNoNativeReceipt(target);
    if (row) {
      if (row.phase !== 'installed') fail('VULKAN_RECOVERY_FIRST', '请先恢复未完成的 Vulkan 安装，再重试。');
      if (!same(row.basePath, source.place.basePath)) fail('VULKAN_PACKAGE_LOCKED', 'Vulkan Core 属于固定配套，切换版本前请先恢复原配套。');
      const current = await inspectBound(row, true);
      if (!current.ready) fail('VULKAN_STATE_CHANGED', '已有 Vulkan 配套未通过检查，请先诊断或恢复。', { blockers: current.blockers });
    } else if (fs.existsSync(path.join(path.dirname(target.exe), 'ReShade.ini')))
      fail('VULKAN_EXTERNAL_RESHADE', '游戏已有未知 ReShade.ini，未自动接管；请先核对并用原工具恢复。');
    const launch = await getBroker().inspect({ exe: target.exe });
    if (!launch || launch.elevated !== false || launch.launchable !== true)
      fail('VULKAN_ELEVATED_HKCU', '当前启动方式不能证明游戏以普通权限读取 Vulkan 用户加载层，未安装。');
    const runtime = await profile.previewPrepare({ exe: target.exe, recipe: source.recipe, packageRoot: source.packageRoot });
    const layer = await getDeployment().previewPrepare({ id: target.id, exe: target.exe }, source.layer);
    const changes = [...runtime.changes, ...layer.changes];
    for (const change of changes) if (change.role === 'vulkan-activation') change.destination = source.place.basePath;
    changes.push({ path: bindingPath, name: path.basename(bindingPath), role: 'receipt',
      beforeSha256: await require('./launch-safety').digestFile(bindingPath), action: row ? 'keep' : fs.existsSync(bindingPath) ? 'update' : 'create' });
    return { changes, route: 'vulkan', api: 'vulkan', mode: 'external', version: source.recipe.coreVersion,
      packageId: source.recipe.id, runtimeVerified: false, requiresAntiCheat: guards.antiCheatPresent(target.dir) === true && !row?.antiCheatConfirmed,
      requiresConfirmation: true, layout: { source: 'vulkan', exe: target.exe, runtimeDir: source.place.basePath, reshadeConfigDir: source.place.basePath } };
  }
  async function previewRestore(game) {
    const row = bound(game);
    if (!row) { assertNoOrphan(game); return { changes: [], route: 'vulkan', unchanged: true, runtimeVerified: false }; }
    const target = { id: row.gameId, exe: row.exe, dir: row.dir }; await closed(target);
    if (row.phase !== 'installed') fail('VULKAN_RECOVERY_FIRST', 'Vulkan 有未完成操作，请先恢复后重新预览。');
    const layer = await getDeployment().previewRestore(target), runtime = await profile.previewArchive({ exe: row.exe, basePath: row.basePath });
    const changes = [...layer.changes, ...runtime.changes,
      { path: bindingPath, name: path.basename(bindingPath), role: 'receipt', beforeSha256: await require('./launch-safety').digestFile(bindingPath), action: 'update' }];
    return { changes, route: 'vulkan', mode: 'external', runtimeVerified: false, requiresConfirmation: true, archived: true };
  }
  async function install(game, installOptions = {}) {
    return serial(async () => {
      const target = selected(game), state = bindings(); let row = bound(game, state);
      assertSelected(row, target);
      if (state.bindings.some(item => !same(item.exe, target.exe) && same(path.dirname(item.exe), path.dirname(target.exe))))
        fail('VULKAN_DIRECTORY_BOUND', '同目录的另一 EXE 已绑定 Vulkan profile，共享 ReShade.ini 不能指向不同配套。');
      if (!row) assertNoOrphan(game);
      if (!vulkanRoute(game)) fail('VULKAN_API_REQUIRED', '请先确认所选 EXE 使用 Vulkan，再安装该配套。');
      if (game.scan.chosen.bitness !== 64 || pe.getBitness(target.exe) !== 64) fail('VULKAN_GAME_ARCH', '当前 Vulkan 配套仅支持 x64 游戏。');
      const source = packages(target.exe, game, row); await assertHardware(source);
      const requested = installOptions.version ?? installOptions.packageId ?? installOptions.coreVersion;
      if (requested !== undefined && requested !== source.recipe.id && requested !== source.recipe.coreVersion && requested !== source.providerPackageId)
        fail('VULKAN_PACKAGE_LOCKED', 'Vulkan Core 必须使用当前固定配套，不能单独切换核心版本。');
      await closed(target); assertNoNativeReceipt(target);
      const antiCheat = guards.antiCheatPresent(target.dir);
      if (antiCheat && installOptions.allowAntiCheat !== true && !row?.antiCheatConfirmed) throw appError('ERR_ANTI_CHEAT_CONFIRM', { operation: 'vulkan-install' });
      if (row) {
        if (row.phase !== 'installed') fail('VULKAN_RECOVERY_FIRST', '请先恢复未完成的 Vulkan 安装，再重试。');
        if (!same(row.basePath, source.place.basePath)) fail('VULKAN_PACKAGE_LOCKED', 'Vulkan Core 属于固定配套，切换版本前请先恢复原配套。');
        const current = await inspectBound(row);
        if (!current.ready) fail('VULKAN_STATE_CHANGED', '已有 Vulkan 配套未通过检查，请先诊断或恢复。', { blockers: current.blockers });
        if (antiCheat && !row.antiCheatConfirmed) { row = { ...row, antiCheatConfirmed: true }; await save(row); }
        return { installed: true, unchanged: true, coreVersion: row.coreVersion, packageId: row.packageId, runtimeVerified: false };
      }
      if (fs.existsSync(path.join(path.dirname(target.exe), 'ReShade.ini')))
        fail('VULKAN_EXTERNAL_RESHADE', '游戏已有未知 ReShade.ini，未自动接管；请先核对并用原工具恢复。');
      // Prove launch compatibility before publishing a profile or durable binding.
      // Deployment repeats the check at its own write boundary to reject drift.
      const launch = await getBroker().inspect({ exe: target.exe });
      if (!launch || launch.elevated !== false || launch.launchable !== true)
        fail('VULKAN_ELEVATED_HKCU', '当前启动方式不能证明游戏以普通权限读取 Vulkan 用户加载层，未安装。');
      let phase = 'profile', profilePublished = false, bindingSaved = false;
      try {
        const published = await profile.prepare({ exe: target.exe, recipe: source.recipe, packageRoot: source.packageRoot });
        if (!same(published.basePath, source.place.basePath)) fail('VULKAN_PROFILE_INVALID', '发布的 Vulkan profile 与固定配套位置不一致。');
        profilePublished = true;
        const exact = identity.location({ exe: target.exe, recipe: source.recipe });
        row = { gameId: target.id, dir: target.dir, exe: target.exe, basePath: published.basePath,
          exeId: exact.exeId, fingerprint: exact.fingerprint,
          packageId: source.recipe.id, coreVersion: source.recipe.coreVersion, phase: 'prepared',
          sourceKind: source.sourceKind, ...(source.sourceKind === 'external-provider'
            ? { providerPackageId: source.providerPackageId, providerRouteId: source.providerRouteId } : {}),
          acceptance: { status: source.recipe.acceptance.status, hardwareFamily: source.recipe.acceptance.hardwareFamily },
          antiCheatConfirmed: Boolean(antiCheat) };
        phase = 'binding'; await save(row); bindingSaved = true;
        phase = 'deployment'; await getDeployment().prepare({ id: target.id, exe: target.exe }, source.layer);
        const layer = await getDeployment().inspect({ id: target.id, exe: target.exe });
        if (!layer.ready || !(await activation.read(target.exe)).active) fail('VULKAN_INSTALL_VERIFY', 'Vulkan 激活尚未通过读回检查。');
        phase = 'binding'; row.phase = 'installed'; await save(row);
        return { installed: true, coreVersion: row.coreVersion, packageId: row.packageId, configDir: row.basePath, runtimeVerified: false };
      } catch (error) { error.details = { ...error.details, phase, recoveryRequired: bindingSaved, bindingRetained: bindingSaved, profileRetained: profilePublished }; throw error; }
    });
  }
  function pendingBelongsTo(row) {
    const file = getDeployment().pendingPath;
    if (!file) return false;
    const pending = readJson(file, 2 * 1024 * 1024); if (!pending) return false;
    const before = pending.beforeReceipt?.refs || [], after = pending.targetReceipt?.refs || [];
    const changed = [...before, ...after].filter(ref => before.some(a => same(a.exe, ref.exe)) !== after.some(a => same(a.exe, ref.exe)));
    return (!pending.activation || same(pending.activation.exe, row.exe)) && changed.length > 0 && changed.every(ref => same(ref.exe, row.exe));
  }
  async function archiveOrFind(row) {
    if (fs.existsSync(row.basePath)) return profile.archive({ exe: row.exe, basePath: row.basePath });
    // A crash after the profile rename but before clearing the binding must be
    // retryable. Look only in this EXE/package's bounded archive bucket.
    const bucket = path.join(userData, 'vulkan-runtime-archive', exeHash(row.exe), path.basename(row.basePath));
    await noLinks(bucket);
    let entries; try { entries = await fsp.readdir(bucket, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
    if (entries.length > 256) fail('VULKAN_ARCHIVE_AMBIGUOUS', '该配套的归档数量超出自动恢复范围，请保留反馈。');
    const matches = [];
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !row.archiveBefore?.includes(entry.name)) {
      const archivePath = path.join(bucket, entry.name); await noLinks(archivePath);
      const receipt = readJson(path.join(archivePath, '.xiaofeng-vulkan-runtime.json'));
      try {
        const checked = identity.identifyReceipt({ receipt, exe: row.exe, basePath: row.basePath });
        if (checked.recipe.id === row.packageId && checked.recipe.coreVersion === row.coreVersion &&
            (!row.fingerprint || checked.recipe.fingerprint === row.fingerprint)) matches.push(archivePath);
      } catch { /* this archive does not have the complete expected identity */ }
    }
    if (matches.length !== 1) fail('VULKAN_ARCHIVE_MISSING', '原 profile 已消失，尚不能确认唯一的完整归档；绑定已保留。');
    return { archived: true, archivePath: matches[0], recovered: true };
  }
  async function restore(game) {
    return serial(async () => {
      const row = bound(game); if (!row) { assertNoOrphan(game); return { restored: false, unchanged: true }; }
      const target = { id: row.gameId, exe: row.exe, dir: row.dir }; await closed(target);
      const service = getDeployment();
      const check = await service.inspect(target);
      if (check.status === 'pending') {
        if (!pendingBelongsTo(row)) fail('VULKAN_RECOVERY_OTHER_GAME', '另一游戏有未完成的 Vulkan 事务，请先恢复对应游戏。');
        await service.recover();
      }
      await service.restore(target);
      if ((await activation.read(row.exe)).active) fail('VULKAN_RESTORE_VERIFY', '该 EXE 的 Vulkan 激活仍然存在，未归档运行资产。');
      if (fs.existsSync(row.basePath) && !row.archiveBefore) {
        const bucket = path.join(userData, 'vulkan-runtime-archive', exeHash(row.exe), path.basename(row.basePath));
        await noLinks(bucket);
        try { row.archiveBefore = await fsp.readdir(bucket); } catch (error) { if (error.code !== 'ENOENT') throw error; row.archiveBefore = []; }
        if (row.archiveBefore.length > 256) fail('VULKAN_ARCHIVE_AMBIGUOUS', '该配套的归档数量超出自动恢复范围，请保留反馈。');
      }
      row.phase = 'deactivated'; await save(row);
      const archived = await archiveOrFind(row);
      row.phase = 'archived'; row.archivePath = archived.archivePath; await save(row);
      await remove(row);
      return { restored: true, archived: true, archivePath: archived.archivePath, runtimeVerified: false };
    });
  }
  async function launch(game, args = []) {
    return serial(async () => {
      const target = selected(game), row = bound(game); assertSelected(row, target);
      if (!row || row.phase !== 'installed') fail('VULKAN_NOT_INSTALLED', '请先完成该 EXE 的 Vulkan 配套安装或恢复。');
      if (!vulkanRoute(game)) fail('VULKAN_API_REQUIRED', '当前 EXE 路线已改变，请先恢复 Vulkan 配套再切换 API。');
      await assertHardware({ sourceKind: row.sourceKind || 'bundled', acceptance: row.acceptance }); await closed(target); assertNoNativeReceipt(target);
      if (guards.antiCheatPresent(target.dir) && !row.antiCheatConfirmed) throw appError('ERR_ANTI_CHEAT_CONFIRM', { operation: 'vulkan-launch' });
      const current = await inspectBound(row);
      if (!current.ready) fail('VULKAN_NOT_READY', 'Vulkan profile 或 layer 未就绪，未启动游戏。', { blockers: current.blockers });
      // Recheck the real Windows path immediately before handing off to the
      // broker, including a userData path whose physical mapping has changed.
      const receipt = readJson(path.join(row.basePath, '.xiaofeng-vulkan-runtime.json'), 128 * 1024);
      const checked = identity.identifyReceipt({ receipt, exe: row.exe, basePath: row.basePath });
      identity.assertPathBudget({ basePath: row.basePath, recipe: checked.recipe });
      row.lastLaunch = null; await save(row);
      const startedAt = new Date().toISOString();
      const launched = await getBroker().launch({ exe: row.exe, args, cwd: path.dirname(row.exe) });
      row.lastLaunch = { startedAt, pid: launched.pid };
      let evidenceSaved = true;
      try { await save(row); } catch { evidenceSaved = false; }
      return { ...launched, gameStarted: true, evidenceSaved, loaded: 'unknown', processed: 'unknown', runtimeVerified: false };
    });
  }
  return Object.freeze({ summary, verifySource, install, diagnose, restore, previewInstall, previewRestore, launch, configDir, bindingPath });
}

module.exports = { createVulkanService };
