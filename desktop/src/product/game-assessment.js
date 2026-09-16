'use strict';

const { inspectNativeEnhancementCapabilities } = require('./game-enhancement-capabilities');
const { emptyVerification } = require('./runtime-verification');
const { resolveOperationApi } = require('./operation-api');
const { coreMenu } = require('./core-menu');

const SECTIONS = Object.freeze(['installation', 'enhancements', 'diagnostics']);
function assessmentSections(options) {
  if (options === undefined) return [...SECTIONS];
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Object.keys(options).some(key => key !== 'sections') || !Array.isArray(options.sections) ||
      options.sections.length < 1 || options.sections.length > SECTIONS.length ||
      options.sections.some(section => !SECTIONS.includes(section)) || new Set(options.sections).size !== options.sections.length)
    throw Object.assign(new Error('检查分区无效，请选择安装设置、超分补帧或高级检查。'), { code: 'ASSESSMENT_BAD_REQUEST' });
  return SECTIONS.filter(section => options.sections.includes(section));
}

function createGameAssessment({ service, coordinator, environment, operations, launches, verification, launchMode, helper, records, components,
  hardware = () => null, antiCheatPresent = dir => require('../core/install-guards').antiCheatPresent(dir) }) {
  async function assess(id, options) {
    const sections = assessmentSections(options), full = options === undefined, failures = [];
    const optional = async (name, fn, fallback) => {
      try { return await fn(); } catch (error) { failures.push({ section: name, code: error.code || 'UNAVAILABLE', message: error.message }); return fallback; }
    };
    const seed = !full && typeof service.assessmentSeed === 'function' ? await service.assessmentSeed(id) :
      (await service.listGames()).find(row => row.id === id);
    if (!seed) throw Object.assign(new Error('游戏不在当前库中。'), { code: 'ASSESSMENT_GAME_MISSING' });
    const scan = seed.scan || service.gameScan(id), { scan: ignoredScan, ...game } = seed;
    const selection = resolveOperationApi({ ...game, scan });
    const api = { ...(scan.chosen?.apiAssessment || game.chosen?.apiAssessment || {
      capabilities: [], effectiveApi: selection.effectiveApi, confidence: 'none', conflicts: [], evidence: [], observedApi: null,
      bridgeStatus: { status: 'unknown', verified: false } }), effectiveApi: selection.effectiveApi,
      detectedApi: selection.detectedApi, requiresManualSelection: selection.requiresManualSelection };
    const value = { schema: 1, gameId: id, assessedAt: new Date().toISOString(), sections, failures, runtimeVerified: false };
    let sessionPromise, layoutPromise;
    const session = () => sessionPromise ||= optional('session', () => launches.inspect(id), null);
    const layout = () => layoutPromise ||= optional('layout', () => service.getLayout(id), null);

    async function installation() {
      // This section reads small configuration/ownership records only. Full
      // binary, environment and runtime verification belongs to diagnostics.
      const [currentLayout, operation, launch, currentSession, launchReadiness, nr, hotkeys, coreVersions, defaults, antiCheat, componentChoices] = await Promise.all([
        layout(), optional('operation', () => operations.inspect(id), { pending: true, unavailable: true }),
        optional('launch', () => launchMode(id), {}), session(),
        coordinator?.inspectLaunchReadiness ? optional('launchReadiness', () => coordinator.inspectLaunchReadiness(id), null) : null,
        optional('nr', () => service.readNrSettings(id), null), optional('hotkeys', () => service.readGameHotkeys(id), null),
        optional('coreVersions', () => !full && service.coreVersionCatalog ? service.coreVersionCatalog() : service.listAddonVersions(), []),
        optional('defaults', () => service.installationDefaults ? service.installationDefaults(id) : null, null),
        optional('antiCheat', () => antiCheatPresent(service.gameDirectory(id)), false),
        optional('componentChoices', () => service.componentChoices?.(id), null)
      ]);
      const nativeIntegration = inspectNativeEnhancementCapabilities(scan);
      const layoutFailed = !currentLayout || currentLayout.needsRecovery === true || Boolean(currentLayout.blockers?.length) ||
        failures.some(row => row.section === 'layout');
      const owned = !layoutFailed && Boolean(game.installed || currentLayout?.source === 'xiaofeng-external-runtime' ||
        ['feeder', 'vulkan', 'hoyoshade-profile'].includes(currentLayout?.source));
      const publicGame = { ...game, installed: owned, addonVersion: currentLayout?.version || game.addonVersion || null,
        nativeDlssAvailable: game.nativeDlssAvailable ?? nativeIntegration.nativeDlssAvailable,
        nativeFgAvailable: game.nativeFgAvailable ?? nativeIntegration.nativeFgAvailable };
      const resolvedDefaults = { api: selection.api,
        version: publicGame.addonVersion || null,
        deployment: owned ? currentLayout?.mode || 'local' : 'local', loadingMode: owned ? currentLayout?.loadingMode || 'proxy' : 'proxy',
        ...defaults, effectiveApi: selection.effectiveApi, requiresApiSelection: selection.requiresManualSelection };
      const deployment = { ...currentLayout, installed: owned, version: publicGame.addonVersion,
        pending: layoutFailed || Boolean(currentLayout?.needsRecovery), needsRecovery: layoutFailed || currentLayout?.needsRecovery === true,
        inspection: 'summary', layoutVerified: currentLayout?.verified === true,
        verified: false, filesVerified: false, runtimeVerified: false };
      Object.assign(value, { game: publicGame, api, hardware: hardware(), nativeIntegration, layout: currentLayout,
        deployment, defaults: resolvedDefaults,
        coreVersions: coreMenu(coreVersions, { installedVersion: publicGame.addonVersion, defaultVersion: resolvedDefaults.version,
          existingUnmanaged: !owned && publicGame.existingInstallation?.detected === true }),
        componentChoices, nr, hotkeys, operation, launch: { ...launch, session: currentSession, readiness: launchReadiness },
        antiCheat: { detected: antiCheat,
          message: '反作弊或游戏保护可能阻止加载，当前路线也可能暂时无法启用；使用模组有账号处罚风险，请自行决定。',
          officialUrl: 'https://help.steampowered.com/zh-cn/faqs/view/571A-97DA-70E9-FF74',
          searchQuery: `${game.name || '游戏'} ReShade 反作弊 兼容性` } });
    }

    async function enhancements() {
      value.enhancements = await optional('enhancements', async () => {
        const inspected = await coordinator.inspect(id);
        if (coordinator.inspectLaunchReadiness) inspected.launchReadiness = await coordinator.inspectLaunchReadiness(id, inspected);
        return inspected;
      }, { unavailable: true, featureStates: {} });
    }

    async function diagnostics() {
      const currentSession = await session();
      const [deployment, maintenance, runtime, visual, componentState, helperModules, currentLayout] = await Promise.all([
        optional('deployment', () => service.inspectDeployment(id), { mode: 'unknown', verified: false }),
        optional('maintenance', () => environment.inspect(id), { unavailable: true }),
        optional('verification', () => verification.assess(id, currentSession), emptyVerification(currentSession?.helper, currentSession)),
        records ? optional('visualRecord', () => records.inspect(id, currentSession), null) : null,
        components ? optional('components', () => components.inspect(id), { files: [], conflicts: [], warnings: [], unavailable: true }) : null,
        helper ? optional('helperModules', () => helper.inspect(id), { ready: false, modules: [] }) : { ready: false, modules: [] }, layout()
      ]);
      if (visual) runtime.visual = visual;
      return { deployment, layout: currentLayout, maintenance, verification: runtime, components: componentState, helperModules,
        conflicts: { api: api.conflicts || [], files: componentState?.conflicts || [], source: 'current-inspection' } };
    }

    // A requested diagnostic result replaces the lightweight deployment summary
    // only after all selected work finishes, regardless of completion order.
    const tasks = [sections.includes('installation') ? installation() : null,
      sections.includes('enhancements') ? enhancements() : null,
      sections.includes('diagnostics') ? diagnostics() : null];
    const [, , detailed] = await Promise.all(tasks);
    if (detailed) Object.assign(value, detailed);
    return value;
  }
  return { assess };
}
module.exports = { createGameAssessment, assessmentSections };
