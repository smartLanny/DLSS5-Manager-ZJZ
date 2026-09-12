'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { classifyApi } = require('./game-support');
const { createFeederService } = require('./feeder-service');
const { createLegacyService, RECEIPT: MODERN_RECEIPT, PENDING: MODERN_PENDING } = require('./legacy-service');
const { RECEIPT: HISTORICAL_RECEIPT, regularJson } = require('./feeder-runtime');
const { createLegacyRuntime } = require('./legacy-runtime');
const fail = message => { throw Object.assign(new Error(message), { code: 'FEEDER_OWNER_CONFLICT' }); };

// Receipt ownership selects recovery and repair. A new default never claims or
// upgrades a historical deployment; its original runtime remains available.
function createFeederRoutingService(options) {
  const historical = options.historical || createFeederService(options), modern = options.modern || createLegacyService(options);
  const runtime = options.runtime || createLegacyRuntime(options);
  function requireHardware(game, request = {}) {
    const external = request.providerId || runtime.externalProviders?.selectedId?.(selection(game, request));
    if (external) {
      if (!['RTX40', 'RTX50'].includes(options.hardware?.family))
        throw Object.assign(new Error('所选外部 Provider 需要已识别的兼容硬件族。'), { code: 'LEGACY_HARDWARE_UNSUPPORTED' });
      return;
    }
    if (Array.isArray(options.hardware?.series) && (!options.hardware.series.length || options.hardware.series.some(row => !['RTX40', 'RTX50'].includes(row))))
      throw Object.assign(new Error('本轮 Feeder 配套面向已确认的 RTX 40／50 系列。'), { code: 'LEGACY_HARDWARE_UNSUPPORTED' });
  }
  function owner(game, request = {}) {
    const journal = regularJson(path.join(game.dir, '_DLSS5_Backup/pending-switch.json'), 2 * 1024 * 1024);
    const old = fs.existsSync(path.join(game.dir, HISTORICAL_RECEIPT)) || journal?.files?.some(row => typeof row.rel === 'string' && row.rel.replaceAll('\\', '/').toLowerCase() === HISTORICAL_RECEIPT.toLowerCase());
    const current = fs.existsSync(path.join(game.dir, MODERN_RECEIPT)) || fs.existsSync(path.join(game.dir, MODERN_PENDING));
    if (old && current) fail('同一游戏存在两代 Feeder 记录，请先恢复未完成的组件操作。');
    if (old) {
      if (request.loadingBackend === 'hoyoshade' || String(request.version || '').startsWith('feeder-0151-')) fail('请先恢复旧 Feeder 配套，再安装新输入路线。');
      return historical;
    }
    return modern;
  }
  function selection(game, request = {}) {
    return { api: request.api && request.api !== 'auto' ? request.api : classifyApi(game.scan?.chosen),
      architecture: Number(game.scan?.chosen?.bitness) === 32 ? 'x86' : Number(game.scan?.chosen?.bitness) === 64 ? 'x64' : null, hardwareFamily: options.hardware?.family,
      loadingBackend: request.loadingBackend || 'local', ...(request.proxyEntry ? { proxyEntry: request.proxyEntry } : {}),
      ...(request.providerId ? { providerId: request.providerId } : {}) };
  }
  function providerRoute(game, request = {}) {
    const api = request.api && request.api !== 'auto' ? request.api : classifyApi(game.scan?.chosen);
    const wanted = { api,
      architecture: Number(game.scan?.chosen?.bitness) === 32 ? 'x86' : Number(game.scan?.chosen?.bitness) === 64 ? 'x64' : null,
      hardwareFamily: options.hardware?.family, ...(request.loadingBackend ? { loadingBackend: request.loadingBackend } : {}),
      proxyEntry: request.proxyEntry || 'auto' };
    const selectedId = request.providerId || runtime.externalProviders?.selectedId?.(wanted);
    if (!selectedId) return { matched: false, declared: false, reason: `尚未为 ${api || '当前 API'} 选择外部 Provider 配套。` };
    const context = { currentCore: options.getCurrentCore?.() || options.currentCore,
      currentRuntime: options.getCurrentRuntime?.() || options.currentRuntime };
    const inventory = runtime.externalProviders.inspect(context);
    const provider = inventory.packages.find(row => row.id === selectedId);
    if (!provider || !provider.selectable) return { matched: false, declared: false, providerPackageId: selectedId,
      reason: provider?.reason || inventory.reason || '已选 Provider 当前不可用。' };
    const declared = (provider.routeDescriptors || []).filter(route => route.api === wanted.api &&
      route.architecture === wanted.architecture && route.hardwareFamilies.includes(wanted.hardwareFamily) &&
      (!request.providerRouteId || route.id === request.providerRouteId) &&
      (!request.loadingBackend || route.loadingBackend === request.loadingBackend) &&
      (!route.proxyEntries.length || route.proxyEntries.includes(wanted.proxyEntry)));
    if (declared.length !== 1) return { matched: false, declared: declared.length > 0,
      ambiguous: declared.length > 1, providerPackageId: selectedId,
      reason: declared.length ? '外部 Provider 有多条匹配路线，需要明确加载后端。' : '外部 Provider 未声明匹配路线。' };
    const route = declared[0];
    try {
      const pkg = runtime.load({ providerId: selectedId, selection: { ...wanted, loadingBackend: route.loadingBackend, routeId: route.id }, ...context });
      return { matched: true, declared: true, providerPackageId: selectedId,
        providerRouteId: route.id, loadingBackend: route.loadingBackend,
        transportOwner: route.loadingBackend === 'vulkan-profile' ? 'vulkan-profile' : 'legacy-feeder',
        hostRequired: pkg.recipe.hostRequired === true, transport: pkg.recipe.transport,
        coreVersion: pkg.recipe.coreVersion, runtimeVerified: false };
    } catch (error) {
      return { matched: false, declared: true, providerPackageId: selectedId,
        providerRouteId: route.id, loadingBackend: route.loadingBackend,
        reason: error.message, code: error.code, runtimeVerified: false };
    }
  }
  function vulkanProfilePackage(game, request = {}) {
    const route = providerRoute(game, { ...request, api: 'vulkan', loadingBackend: 'vulkan-profile' });
    if (!route.matched) return null;
    const context = { currentCore: options.getCurrentCore?.() || options.currentCore,
      currentRuntime: options.getCurrentRuntime?.() || options.currentRuntime };
    const wanted = { api: 'vulkan', architecture: 'x64', hardwareFamily: options.hardware?.family,
      loadingBackend: 'vulkan-profile', proxyEntry: 'auto', routeId: route.providerRouteId };
    const pkg = runtime.load({ providerId: route.providerPackageId, selection: wanted, ...context });
    const files = pkg.recipe.files.map(file => {
      if (file.base === 'game') throw Object.assign(new Error('Vulkan profile Provider 不能把文件写入游戏目录。'), { code: 'EXTERNAL_PROVIDER_ROUTE' });
      return { source: file.source, target: file.base === 'addon' ? path.posix.join('addons', file.target.replaceAll('\\', '/')) : file.target,
        sha256: file.sha256, mutable: file.mutable };
    });
    return { packageRoot: pkg.root, providerPackageId: route.providerPackageId, providerRouteId: route.providerRouteId,
      recipe: { version: 1, id: `nr-vulkan-${pkg.fingerprint.slice(0, 16)}`, coreVersion: pkg.recipe.coreVersion,
        sourceRevision: pkg.recipe.externalProvider.definition.sha256, architecture: 64, files,
        acceptance: { status: 'candidate', hardwareFamily: options.hardware?.family, realGameVerified: false } } };
  }
  function summary(game, request = {}) {
    try {
      const chosen = owner(game, request), state = chosen.summary(game);
      if (chosen === historical) return { ...state, generation: 'historical-0131' };
      if (state.installed || state.needsRecovery) {
        const external = chosen.profile?.(game)?.recipe?.externalProvider;
        return { ...state, generation: external ? 'external-provider-v1' : 'feeder-0151' };
      }
      requireHardware(game, request);
      const pkg = runtime.load(selection(game, request));
      return { ...state, available: true, packageId: pkg.recipe.id, providerPackageId: pkg.recipe.providerPackageId || null,
        coreVersion: pkg.recipe.coreVersion, api: pkg.recipe.gameApi,
        architecture: pkg.recipe.architecture, loadingBackend: pkg.recipe.loadingBackend, hostRequired: pkg.recipe.hostRequired,
        generation: pkg.recipe.externalProvider ? 'external-provider-v1' : 'feeder-0151', runtimeVerified: false };
    } catch (error) { return { installed: false, available: false, ready: false, needsRecovery: /OWNER|RECORD|RECEIPT|RECOVERY/.test(error.code || ''),
      reason: error.message, code: error.code, runtimeVerified: false }; }
  }
  const dispatch = method => (game, request, ...args) => { const selected = owner(game, request);
    if (selected === modern && ['previewInstall', 'install'].includes(method)) requireHardware(game, request);
    return selected[method](game, request, ...args); };
  return {
    summary, selections: game => Object.fromEntries(['dx9', 'dx10', 'dx11', 'dx12', 'vulkan'].map(api => {
      const route = providerRoute(game, { api });
      return [api, summary(game, { api, ...(route.matched ? { loadingBackend: route.loadingBackend } : {}) })];
    })),
    previewInstall: dispatch('previewInstall'), install: dispatch('install'), inspect: dispatch('inspect'), diagnose: dispatch('inspect'),
    previewRestore: dispatch('previewRestore'), restore: dispatch('restore'), launch: dispatch('launch'),
    recover: (game, request) => { const chosen = owner(game, request); return chosen.recover ? chosen.recover(game, request) : chosen.restore(game, request); },
    profile: game => { const chosen = owner(game); return chosen.profile ? chosen.profile(game) : null; },
    ownedModuleManifest: game => { const chosen = owner(game); return chosen.ownedModuleManifest ? chosen.ownedModuleManifest(game) : []; },
    configDir: (game, kind) => owner(game).configDir(game, kind),
    feedbackLogDirectory: game => owner(game).feedbackLogDirectory(game),
    prepareLaunch: async (game, session) => { const chosen = owner(game); if (chosen.prepareLaunch) return chosen.prepareLaunch(game, session);
      const state = await chosen.inspect(game); if (!state.ready) throw Object.assign(new Error(state.reason || 'Feeder 配套未就绪。'), { code: 'FEEDER_NOT_READY' }); },
    recordLaunch: (game, session) => owner(game).recordLaunch?.(game, session),
    runtimeOwner: game => owner(game),
    generation: game => {
      const chosen = owner(game); if (chosen !== modern) return 'historical-0131';
      const installed = chosen.profile?.(game)?.recipe?.externalProvider;
      const api = classifyApi(game.scan?.chosen);
      return installed || !chosen.summary(game).installed && runtime.externalProviders?.selectedId?.(selection(game, { api }))
        ? 'external-provider-v1' : 'feeder-0151';
    },
    inspectProviders: context => runtime.externalProviders?.inspect(context) || { root: null, selectedId: null,
      selectedByApi: {}, selectedByRoute: {}, packages: [], ready: true, runtimeVerified: false },
    providerRoute,
    vulkanProfilePackage,
    selectProvider: (id, context) => {
      if (!runtime.externalProviders?.select) throw Object.assign(new Error('当前运行源不支持外部 Provider 库存。'), { code: 'EXTERNAL_PROVIDER_UNAVAILABLE' });
      return runtime.externalProviders.select(id, context);
    },
    providerLibraryRoot: runtime.externalProviders?.root || null
  };
}
module.exports = { createFeederRoutingService };
