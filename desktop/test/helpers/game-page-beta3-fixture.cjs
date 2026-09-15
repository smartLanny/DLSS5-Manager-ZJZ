'use strict';

function installMock(features, options = {}) {
  const { ipcRenderer } = require('electron');
  const clone = structuredClone, ok = value => ({ ok: true, value: clone(value) });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const game = { id: 'fixture', name: '博德之门 3 · 界面测试', dir: 'C:\\UI-fixture\\Baldurs Gate 3', installed: true, supported: true, launcher: 'Steam',
    addonVersion: '0.4.7beta', apiOverride: 'auto', nativeDlssAvailable: true, nativeFgAvailable: true,
    chosen: { path: 'C:\\UI-fixture\\Baldurs Gate 3\\bin\\bg3_dx11.exe', bitness: 64, apiResolution: { api: 'dx11', source: 'entry' } } };
  game.dir = options.paths.gameDir; game.chosen.path = options.paths.exe;
  const hardware = { family: 'RTX40', series: ['RTX40'], names: ['NVIDIA RTX 4070 Ti SUPER'], source: 'fixture' };
  const assessment = { schema: 1, gameId: game.id, game, hardware,
    defaults: { api: 'auto', version: '0.4.7beta', deployment: 'local', loadingMode: 'proxy', proxyEntry: 'auto' },
    api: { capabilities: ['dx11'], configuredApi: null, effectiveApi: 'dx11', observedApi: null, presentationApi: null, confidence: 'high',
      bridgeStatus: { required: true, kind: 'DX11 桥接', verified: false }, evidence: [{ api: 'dx11', source: 'selected-executable', path: game.chosen.path, message: '已验证 BG3 DX11 独立入口。' }], conflicts: [], coverage: { complete: true, exeImports: true } },
    layout: { mode: 'local', loadingBackend: 'local', loadingMode: 'proxy', activeConfigPath: options.paths.ini, runtimeDir: options.paths.gameDir + '\\bin' },
    deployment: { mode: 'local', loadingMode: 'proxy', version: '0.4.7beta', verified: true, needsRecovery: false },
    enhancements: { hardware, featureStates: clone(features.on40), requests: {}, applied: {}, pending: [],
      fgComponents: { backend: 'mfgunlock', installed: false, defaultProvider: 'mfgunlock-0.9-zh-CN', installedProvider: null,
        catalog: [{ id: 'mfgunlock-0.9-zh-CN', label: 'MFG Unlock 0.9 · 中文面板（推荐）', ready: true },
          { id: 'mfgunlock-0.9', label: 'MFG Unlock 0.9 · 官方原版', ready: true }] } },
    nr: { Enabled: 1, Intensity: 1, LocalToneStrength: 1, LocalStructureStrength: 1, WorkMode: 0, CustomWorkScale: 1, Style: 0, AutoMask: 0, ColorStrength: .75, SkinStructureStrength: -1, TransferStrength: 1, PostTransferStrength: 1,
      capabilities: { Intensity: true, LocalToneStrength: true, LocalStructureStrength: true, AutoMask: true, WorkMode: true, Style: true, CustomWorkScale: true, ColorStrength: true, SkinStructureStrength: true, TransferStrength: true, PostTransferStrength: true } },
    hotkeys: { nr: { label: 'F6 开关' }, reshade: { key: 36, ctrl: false, shift: false, alt: false } },
    operation: { pending: false }, launch: { selected: 'auto', effective: 'steam', steamAvailable: true, session: null },
    verification: { helper: { status: 'not-applicable', detail: '当前代理路线无需加载助手。' }, reshade: { status: 'unverified', detail: '等待本次游戏进程确认固定 ReShade。' }, core: { status: 'unverified', detail: '等待本次游戏进程确认指定 Core。' },
      nr: { status: 'unverified', detail: '等待成功与提交计数持续增长。' }, visual: { status: 'unverified', detail: '需同场景开关对照与 F8 记录。' } },
    maintenance: { remainingFiles: [{ name: 'other-addon.addon64', kind: '其他模组，保留', sha256: 'c'.repeat(64) }], files: [], isolated: false, scope: '只检查所选 EXE 同目录图形代理与 Add-on。' },
    helperModules: { modules: [] }, components: { files: [], conflicts: [], warnings: [] }, antiCheat: { detected: false }, failures: [],
    componentChoices: { bridges: [{ id: 'nigos-1.4.12-nr', label: 'NIGos Bridge 1.4.12 · NR 适配', ready: true, compatible: true },
      { id: 'nigos-1.4.11-nr', label: 'NIGos Bridge 1.4.11 · 回退', ready: true, compatible: true }], selected: { bridge: 'nigos-1.4.12-nr' } },
    coreVersions: [{ id: '0.4.7beta', label: 'beta0.4.7', ready: true }, { id: 'fixture-core-alternative', label: '另一已核验 Core · 测试', ready: true },
      { id: '0.5-dline13', label: '0.5 D13 · 测试', ready: true, comparisonOnly: false, coreUpdateOnly: true, addonOnly: true },
      { id: '0.4.7beta-corefix.8', label: '0.4.7 Corefix8 · 测试', ready: true, comparisonOnly: false, coreUpdateOnly: true, addonOnly: true },
      { id: '0.4.7beta-bg3-bridge1411', label: 'beta0.4.7 · BG3 桥接 1.4.11 对照', ready: true, comparisonOnly: true }] };
  const second = clone(assessment); second.gameId = second.game.id = 'fixture-two'; second.game.name = '第二款游戏 · DX12';
  second.game.dir = 'C:\\UI-fixture\\Second'; second.game.chosen.path = 'C:\\UI-fixture\\Second\\Game.exe';
  second.game.chosen.apiResolution.api = second.api.effectiveApi = 'dx12'; second.api.capabilities = ['dx12']; second.nr.Intensity = .9;
  const hoyo = clone(assessment); hoyo.gameId = hoyo.game.id = 'fixture-hoyo'; hoyo.game.name = '崩坏：星穹铁道 · 正式客户端界面测试';
  hoyo.game.dir = 'C:\\UI-fixture\\StarRail'; hoyo.game.chosen.path = hoyo.game.dir + '\\StarRail.exe';
  hoyo.game.installed = false; hoyo.game.nativeDlssAvailable = false; hoyo.nr = null;
  hoyo.game.hoyo = { profileOptions: clone(features.hoyoProfiles), selected: null };
  hoyo.game.feeder = { installed: false, available: true, packageId: 'fixture-feeder-dx11-x64', coreVersion: '0.4.7beta',
    selections: { dx11: { api: 'dx11', available: true, packageId: 'fixture-feeder-dx11-x64', coreVersion: '0.4.7beta' } } };
  const dx9 = clone(assessment); dx9.gameId = dx9.game.id = 'fixture-dx9'; dx9.game.name = 'DX9 x86 · Feeder 入口测试';
  dx9.game.dir = 'C:\\UI-fixture\\Legacy'; dx9.game.chosen.path = dx9.game.dir + '\\Legacy.exe'; dx9.game.chosen.bitness = 32;
  dx9.game.supported = false; dx9.game.installed = false; dx9.game.nativeDlssAvailable = false; dx9.game.nativeFgAvailable = false;
  dx9.game.chosen.apiResolution.api = dx9.api.effectiveApi = 'dx9'; dx9.api.capabilities = ['dx9']; dx9.nr = null;
  dx9.game.feeder = { installed: false, available: true, selections: { dx9: { api: 'dx9', architecture: 'x86', available: true, packageId: 'fixture-dx9-x86-on12', coreVersion: '0.4.7beta' } } };
  const mock = window.__gpMock = { calls: [], plans: new Map(), assessments: { fixture: assessment, 'fixture-two': second, 'fixture-hoyo': hoyo, 'fixture-dx9': dx9 },
    baseline: clone(assessment), secondBaseline: clone(second), features, removed: new Set(), delays: options.captureOnly ? {} : { 'fixture:installation': 5000 }, pending: 0,
    failApply: false, listeners: new Set(), mounts: new Map(), plan: null, policyEnabled: false, policyApplied: 0,
    settings: { animationsEnabled: true, theme: process.env.GAME_UI_THEME || 'system', scanDrives: false, addonVersion: null },
    selectedLauncher: 'C:\\UI-fixture\\HoYoPlay\\launcher.exe',
    resetPolicy: () => ipcRenderer.invoke('game-page-fixture-native-policy', 'reset'),
    mutatePolicy: kind => ipcRenderer.invoke('game-page-fixture-native-policy', 'mutate', { kind }) };
  Object.defineProperty(mock, 'assessment', { get: () => mock.assessments.fixture, set: value => { mock.assessments.fixture = value; } });
  const sectionFields = {
    installation: ['game', 'api', 'defaults', 'layout', 'deployment', 'nr', 'hotkeys', 'operation', 'launch', 'antiCheat', 'coreVersions', 'componentChoices', 'hardware'],
    enhancements: ['enhancements'], diagnostics: ['maintenance', 'verification', 'helperModules', 'components', 'layout', 'deployment']
  };
  let ui, page;
  Object.defineProperty(window, 'launchSettingsUi', { configurable: true, get: () => ui, set: value => {
    ui = value; value.mount = () => { mock.calls.push(['legacy-mount']); throw Error('production inline path must not mount the legacy writer'); };
  } });
  Object.defineProperty(window, 'GamePageUi', { configurable: true, get: () => page, set: value => {
    const originalFactory = !page;
    page = value; const mount = value.mount;
    value.mount = (host, manager, options) => { const controller = mount(host, manager, options); host.__gpController = controller;
      // Composition adapters call the original factory; count actual base
      // controller creation once, while exposing the final wrapped controller.
      if (originalFactory) { const id = host.dataset.gameDetail; mock.mounts.set(id, (mock.mounts.get(id) || 0) + 1); }
      return controller; };
  } });
  const payload = { ready: true, selectedVersion: '0.4.7beta', versions: { '0.4.7beta': { label: 'beta0.4.7', variants: { RTX40: { ready: true, files: [] } } } }, source: { mode: 'bundled', path: 'C:\\UI-fixture\\payload', ready: true } };
  const games = () => Object.values(mock.assessments).filter(row => !mock.removed.has(row.gameId)).map(row => row.game);
  const componentCatalog = [
    ['mfg', '0.9'], ['bridge', '1.4.13-pre7'], ['bridge', '1.4.13-pre8'], ['bridge', '1.4.13-pre6'],
    ['feeder', '1.16.0-beta.1'], ['feeder', '0.15.1'], ['feeder', '0.15.0']
  ].map(([kind, version], index) => ({ id: `fixture-component-${index}`, kind, version, variant: index % 2 ? 'x64' : '', downloadUrl: `https://github.com/fixture/component-${index}` }));
  const empty = async () => ok(null);
  const forbidden = name => async (...args) => { mock.calls.push([name, ...args]); throw Error('unexpected direct mutation: ' + name); };
  window.manager = {
    boot: async () => ok({ product: { name: 'DLSS 5 AI 超分管理器', edition: '装机宅版', version: '0.4.8-beta.3 · UI fixture' }, settings: mock.settings, hardware, payload, addons: assessment.coreVersions, games: games() }),
    updateSettings: async patch => { mock.settings = { ...mock.settings, ...clone(patch) }; mock.calls.push(['update-settings', clone(patch)]); return ok(mock.settings); },
    listGames: async () => ok(games()), refresh: async () => { mock.calls.push(['refresh']); return ok(games()); },
    assessGame: async (id, options) => {
      const sections = options?.sections;
      if (!Array.isArray(sections) || sections.length !== 1 || !sectionFields[sections[0]]) throw Error('UI must request exactly one known assessment section');
      const section = sections[0], ticket = mock.calls.filter(row => row[0] === 'assess').length + 1;
      const snapshot = { schema: 1, gameId: id, sections: [section] };
      for (const key of sectionFields[section]) snapshot[key] = clone(mock.assessments[id][key]);
      mock.calls.push(['assess', id, section, ticket]); mock.pending++;
      try { await delay(mock.delays[id + ':' + section] || 0); mock.calls.push(['assess-resolved', id, section, ticket]); return ok(snapshot); }
      finally { mock.pending--; }
    },
    readPayloadSource: async () => ok({ settings: {}, payload, addons: assessment.coreVersions }), getStartupContext: async () => ok({ mode: 'normal', sandbox: true, privilege: 'standard', operation: {} }),
    getGameIcon: empty, fetchGameArt: empty, listAddons: async () => ok([]), onAddonImported() {}, onSrModelApplied() {}, onLaunchSettingsApplied() {},
    listComponents: async () => ok({ warnings: ['尚未导入运行库，请选择与显卡对应的组件。'], packages: [], catalog: { checkedAt: new Date().toISOString(), packages: componentCatalog } }),
    checkComponentUpdates: async () => ok([]), downloadComponent: async () => ok({ changedGames: false }),
    inspectComponentProviders: async () => ok({ packages: [], selectedId: null, selectedByRoute: {}, reason: '尚未导入输入桥配套。' }),
    componentChoices: async () => ok({ bridges: [] }), pickComponent: empty,
    activateComponentRuntime: empty, activateComponentCore: empty, moveComponentLibrary: empty, selectComponentProvider: empty, applyBridgeComponent: empty,
    startupReady() {}, startupFailed: message => { mock.calls.push(['startup-failed', message]); },
    minimize() { if (options.demo) ipcRenderer.send('game-page-fixture-window', 'minimize'); },
    maximize() { if (options.demo) ipcRenderer.send('game-page-fixture-window', 'maximize'); },
    close() { if (options.demo) ipcRenderer.send('game-page-fixture-window', 'close'); },
    diagnose: async () => ok({ components: [], checks: [], issues: [] }),
    onLaunchSession: callback => { mock.listeners.add(callback); return () => mock.listeners.delete(callback); },
    previewOperation: async (id, request) => {
      mock.calls.push(['preview', clone(request), id]);
      const nativeOperations = request.sr ? await ipcRenderer.invoke('game-page-fixture-sr-plan', request.sr, mock.assessments[id].hardware) : [];
      const plan = { request: clone(request), planId: 'fixture-plan-' + mock.calls.length, fingerprint: 'd'.repeat(64), blockers: [], nativeOperations,
        changes: request.uninstall ? [{ action: request.uninstall, name: 'nr-before-sr.zh-CN.addon64', path: mock.assessments[id].game.dir, beforeSha256: 'a'.repeat(64), afterSha256: null }]
          : [...nativeOperations.map(row => ({ ...row, domain: 'sr' })), ...Object.entries(request.nr || {}).map(([key, value]) => ({ action: 'set-config-key', key, value, path: 'nr_before_sr.ini' }))] };
      if (mock.policyEnabled) {
        const actual = await ipcRenderer.invoke('game-page-fixture-native-policy', 'preview', { id, keep: request.addonKeep || [] });
        plan.policyToken = actual.token; plan.fingerprint = actual.plan.fingerprint; plan.deployment = { addonCompatibility: actual.plan };
        plan.changes.push(...actual.changes); plan.blockers.push(...actual.plan.blockers);
      }
      mock.plan = plan; mock.plans.set(plan.planId, plan); return ok(plan);
    },
    applyOperation: async (id, planId, consent) => {
      mock.calls.push(['apply', clone(consent), id]); const value = mock.assessments[id], plan = mock.plans.get(planId);
      if (plan.policyToken) {
        try {
          const checked = await ipcRenderer.invoke('game-page-fixture-native-policy', 'assert', { token: plan.policyToken });
          if (!checked.ok) return checked;
          mock.policyApplied++;
        }
        catch (error) { return { ok: false, error: { message: error.message } }; }
      }
      if (mock.failApply) { value.operation = { pending: true, record: { error: { message: '测试文件被占用' }, stages: [{ kind: 'deployment', status: 'complete' }] } }; return { ok: false, error: { message: '测试文件被占用；请恢复未完成操作。' } }; }
      if (Object.hasOwn(plan.request, 'api')) {
        const detected = value.api.detectedApi || value.game.chosen.detectedApiResolution?.api ||
          (value.game.chosen.apiResolution?.source !== 'override' ? value.game.chosen.apiResolution?.api : null) || 'unknown';
        value.game.apiOverride = value.defaults.api = plan.request.api;
        value.api.configuredApi = plan.request.api === 'auto' ? null : plan.request.api;
        value.api.detectedApi = detected;
        value.api.effectiveApi = plan.request.api === 'auto' ? detected : plan.request.api;
        value.game.chosen.apiResolution = plan.request.api === 'auto'
          ? clone(value.game.chosen.detectedApiResolution || { api: detected, source: 'entry' }) : { api: plan.request.api, source: 'override' };
      }
      if (plan.request.nr) Object.assign(value.nr, plan.request.nr);
      if (plan.request.components?.bridge) value.componentChoices.selected.bridge = plan.request.components.bridge;
      if (plan.request.components?.mfgUnlock) { value.enhancements.fgComponents.installedProvider = plan.request.components.mfgUnlock; value.enhancements.fgComponents.installed = true; }
      if (plan.request.version) value.game.addonVersion = value.deployment.version = value.defaults.version = plan.request.version;
      if (plan.request.hotkeys) Object.assign(value.hotkeys, clone(plan.request.hotkeys));
      for (const domain of ['sr', 'fg']) if (plan.request[domain]) {
        value.enhancements.requests[domain] = { request: clone(plan.request[domain]) };
        value.enhancements.applied[domain] = { request: clone(plan.request[domain]), readbackVerified: true };
      }
      if (plan.request.uninstall) value.game.installed = false; return ok({ applied: true, notice: '测试配置已应用。' });
    },
    applyOperationElevated: async () => { mock.calls.push(['elevated']); return ok({ applied: true }); },
    previewEnvironmentCleanup: async id => { mock.calls.push(['cleanup-preview', id]); return ok({ planId: 'fixture-cleanup-plan', scope: '只隔离已勾选文件。',
      candidates: [{ name: 'other-addon.addon64', kind: '其他 Add-on', note: '明确选择后备份隔离。', sha256: 'c'.repeat(64), selectable: true, selectedByDefault: true }] }); },
    applyEnvironmentCleanup: async (id, planId, names) => { mock.calls.push(['cleanup-apply', id, planId, clone(names)]);
      mock.assessments[id].maintenance.isolated = true; mock.assessments[id].maintenance.canRestore = true; return ok({ isolated: true }); },
    confirmGameFeature: forbidden('direct-retired-feature-confirmation'),
    pickHoYoLauncher: async () => { mock.calls.push(['pick-hoyo-launcher']); return ok(mock.selectedLauncher); },
    recoverOperation: async id => { mock.calls.push(['recover', id]); mock.assessments[id].operation = { pending: false }; return ok({ recovered: true }); },
    recoverFgComponents: async id => { mock.calls.push(['recover-fg-components', id]); const value = mock.assessments[id], fg = value.enhancements.fgComponents; fg.fileRecoveryPending = false; fg.fileOperationActive = false; fg.migrationPending = false; value.launch.readiness = { state: 'ready', known: true, source: 'metadata', blockers: [], pending: [], requests: {} }; return ok({ recovered: true }); },
    recordVisualComparison: async (id, input) => { mock.calls.push(['visual-record', id, clone(input)]);
      mock.assessments[id].verification.visual = { status: input.result === 'changed' ? 'passed' : input.result === 'unchanged' ? 'not-observed' : 'unverified', source: 'user-comparison',
        automaticVerification: false, detail: input.result === 'changed' ? '用户观察：同场景发现画面变化。' : input.result === 'unchanged' ? '用户观察：未发现画面变化。' : '用户观察：暂时无法确认。' };
      return ok({ recorded: true, notice: '已保存本次用户观察。' }); },
    removeGame: async id => { mock.calls.push(['remove-game', id]); mock.removed.add(id); return ok({ removed: true }); },
    writeGameHotkey: forbidden('direct-hotkey-write'), uninstall: forbidden('direct-uninstall'), updateLaunchSettings: forbidden('direct-launch-settings-write'),
    saveParameters: forbidden('direct-parameter-write'), writeConfig: forbidden('direct-config-write'),
    exportFeedback: async id => { mock.calls.push(['feedback', id]); return ok('fixture.txt'); },
    openFolder: async id => { mock.calls.push(['open-folder', id]); return ok(null); },
    openExternal: async key => { mock.calls.push(['external', key]); return ok(true); },
    launch: async id => { mock.calls.push(['launch', id]); return ok({ launched: { gameId: id, status: 'waiting-enhancement' } }); }, cancelLaunch: async id => { mock.calls.push(['cancel-launch', id]); return ok({ cancelled: true }); }
  };
}

async function smoke() {
  const mock = window.__gpMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertionCount = 0;
  const assert = (value, message) => { assertionCount++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 6500) => { const start = performance.now(); while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); } throw Error('UI timeout: ' + label); };
  const card = (id = 'fixture') => document.querySelector(`.game-card[data-id="${id}"]`);
  const host = () => document.querySelector('.game-card.expanded .game-detail.gp-inline');
  const state = () => host()?.__gpController.getState();
  const field = (group, key) => host()?.querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"]`);
  const button = action => host()?.querySelector(`[data-gp-action="${action}"]`) || (action === 'launch' ? host()?.closest('.game-card').querySelector('.unified-launch-btn') : null);
  const count = kind => mock.calls.filter(row => row[0] === kind).length;
  const click = action => { const item = button(action); assert(item && !item.disabled, 'action unavailable: ' + action);
    const closed = []; for (let parent = item.parentElement; parent && parent !== host(); parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) closed.push(parent);
    for (const details of closed.reverse()) details.querySelector(':scope > summary').click();
    assert(item.getClientRects().length > 0, 'action is visible after opening its details: ' + action); item.click(); };
  const set = (group, key, value) => { const input = field(group, key); assert(input && !input.disabled, 'field unavailable: ' + group + '.' + key);
    const closed = []; for (let parent = input.parentElement; parent && parent !== host(); parent = parent.parentElement) if (parent.tagName === 'DETAILS' && !parent.open) closed.push(parent);
    for (const details of closed.reverse()) details.querySelector(':scope > summary').click();
    assert(input.getClientRects().length > 0, 'field is visible: ' + group + '.' + key);
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value;
    input.dispatchEvent(new Event(input.type === 'range' || input.type === 'number' ? 'input' : 'change', { bubbles: true })); };
  const tab = async key => { const item = host()?.querySelector(`[data-gp-tab="${key}"]`); assert(item, 'tab exists: ' + key); item.click();
    await until(() => host()?.querySelector(`[data-gp-tab="${key}"]`)?.getAttribute('aria-selected') === 'true', 'tab ' + key); };
  const open = async id => { const item = card(id)?.querySelector('.open-game-page-btn'); assert(item, 'card can open: ' + id); item.click();
    await until(() => host()?.dataset.gameDetail === id, 'inline card ' + id, 1000); };
  const fold = async selector => { await until(() => host()?.querySelector(selector), 'details ' + selector); const details = host().querySelector(selector);
    if (!details.open) details.querySelector('summary').click(); assert(details.open, 'details can open: ' + selector); };
  const maintenance = async () => { await tab('maintenance'); await until(() => state().loaded.includes('diagnostics') && state().loaded.includes('enhancements'), 'advanced sections'); await fold('.gp-maintenance-details'); };
  const diagnostics = async () => { await tab('maintenance'); await until(() => state().loaded.includes('diagnostics') && state().loaded.includes('enhancements'), 'diagnostic sections'); await fold('.gp-diagnostics-details'); };
  const settled = async () => until(() => !state()?.busy && !host()?.querySelector('.gp-modal'), 'operation settled');
  const preview = async (action = 'preview') => { click(action); await until(() => host()?.querySelector('.gp-modal [data-gp-action="modal-apply"]'), 'preview dialog'); };
  const discard = () => { if (button('discard')) click('discard'); };
  const scenario = async (label, change) => {
    discard(); mock.policyEnabled = false; mock.assessment = structuredClone(mock.baseline); mock.assessment.game.name = label; change?.(mock.assessment);
    await maintenance(); click('refresh'); await until(() => state().data.game.name === label && mock.pending === 0, 'fresh scenario ' + label); await settled();
  };
  await until(() => card()?.querySelector('.open-game-page-btn') && card('fixture-two'), 'library cards');
  await open('fixture-dx9'); await until(() => state().loaded.includes('installation'), 'DX9 Feeder assessment');
  assert(state().data.game.supported === false && state().data.game.chosen.bitness === 32 && field('route', 'version').value === 'fixture-dx9-x86-on12', 'old unsupported marker does not suppress an available DX9 x86 Feeder package');
  await preview('prepare');
  assert(mock.plan.request.route === 'feeder' && mock.plan.request.api === 'auto' && mock.plan.request.version === 'fixture-dx9-x86-on12', 'DX9 x86 card reaches managed Feeder preview');
  click('modal-cancel'); discard(); click('back');
  const openAt = performance.now(); await open('fixture');
  assert(performance.now() - openAt < 500, 'five-second installation check must not delay inline expansion');
  assert(document.getElementById('view-games').classList.contains('active'), 'library remains active');
  assert(!document.getElementById('view-game-detail').classList.contains('active'), 'independent detail view is never activated');
  assert(host().querySelectorAll('[data-gp-tab]').length === 3, 'three tabs appear from the seed');
  assert(host().querySelector('[data-detail-tab="enhance"]') && host().querySelector('[data-detail-tab="graphics"]') && host().querySelector('[data-detail-tab="advanced"]'), 'existing accessible tab identities are reused');
  assert(!state().loaded.includes('installation'), 'seed appears while installation is unresolved');
  await until(() => state().loaded.includes('installation'), 'five-second installation response'); mock.delays['fixture:installation'] = 0;
  assert(!mock.calls.some(row => row[0] === 'assess' && row[2] !== 'installation'), 'first tab does not start expensive enhancement or diagnostic work');
  assert(['Intensity', 'LocalToneStrength', 'LocalStructureStrength'].every(key => field('nr', key)?.getClientRects().length > 0), 'three primary NR sliders are visible on first tab');
  assert(host().querySelectorAll('.gp-nr-primary input[type="range"]').length === 3 && !host().querySelector('.gp-nr-details').open && field('nr', 'WorkMode').closest('details') === host().querySelector('.gp-nr-details'), 'advanced NR starts collapsed below the three primary sliders');
  assert(![...field('route', 'version').options].some(row => row.value.includes('bridge1411')), 'bridge comparison is absent from basic Core choices');
  for (const id of ['0.5-dline13', '0.4.7beta-corefix.8']) {
    const candidate = [...field('route', 'version').options].find(row => row.value === id);
    assert(candidate && !candidate.disabled, id + ' core-update candidate is visible and selectable');
  }
  set('route', 'version', '0.5-dline13'); assert(state().draft.version === '0.5-dline13', 'ordinary Core dropdown accepts the D13 candidate'); discard();
  const firstHost = host(), firstController = firstHost.__gpController;
  set('nr', 'Intensity', '.65'); set('nr', 'WorkMode', '5'); mock.delays['fixture:diagnostics'] = 5000;
  await tab('maintenance');
  await until(() => mock.calls.some(row => row[0] === 'assess' && row[2] === 'diagnostics'), 'diagnostic request started');
  const diagnosticTicket = mock.calls.filter(row => row[0] === 'assess' && row[2] === 'diagnostics').at(-1)[3];
  const backAt = performance.now(); await tab('overview');
  assert(performance.now() - backAt < 500 && field('nr', 'Intensity').value === '0.65', 'slow diagnostics never block the basic tab or erase its draft');
  mock.delays['fixture-two:installation'] = 30; await open('fixture-two');
  await until(() => state().loaded.includes('installation'), 'second game installs first');
  set('nr', 'Intensity', '.8');
  await until(() => mock.calls.some(row => row[0] === 'assess-resolved' && row[3] === diagnosticTicket), 'older first-game diagnostic response');
  assert(state().id === 'fixture-two' && state().data.api.effectiveApi === 'dx12' && field('nr', 'Intensity').value === '0.8', 'late first-game response cannot replace the second game or its draft');
  await open('fixture');
  assert(host() === firstHost && host().__gpController === firstController && mock.mounts.get('fixture') === 1, 'same host and controller survive cross-game expansion');
  assert(field('nr', 'Intensity').value === '0.65', 'first-game draft survives returning from another game');
  assert(field('nr', 'WorkMode').value === '5', 'advanced NR draft survives delayed diagnostics'); await tab('maintenance');
  click('back'); assert(!host() && !document.querySelector('.gp-modal'), 'collapse keeps drafts without a leave confirmation');
  await open('fixture'); assert(state().draft.nr.Intensity === .65 && state().draft.nr.WorkMode === 5, 'collapsed draft is retained');
  mock.delays['fixture:diagnostics'] = 0; discard(); await tab('enhance');
  await until(() => state().loaded.includes('enhancements'), 'SR/FG lazy section');
  assert(field('sr', 'preset').value === 'M' && field('sr', 'quality').value === 'preserve', 'RTX40 starts with explicit M and preserves the game quality');
  assert(!field('sr', 'renderPercent') && !field('fg', 'multiplier') && !field('fg', 'targetFps'), 'dormant ratio, multiplier and dynamic fields are hidden');
  await preview('preview-sr');
  assert(JSON.stringify(mock.plan.request) === JSON.stringify({ sr: { backend: 'native', quality: 'preserve', preset: 'M' } }), 'default SR can preview without changing any selector');
  assert(mock.plan.nativeOperations.length === 2 && mock.plan.nativeOperations.some(row => row.value === 13), 'production SR compiler emits two operations including model M');
  click('modal-cancel'); discard();
  set('sr', 'preset', 'L'); const recommendationWrites = count('apply'); click('recommend-sr');
  assert(field('sr', 'preset').value === 'M' && field('sr', 'quality').value === 'preserve' && count('apply') === recommendationWrites, 'Restore recommendation only updates the explicit draft');
  discard(); await tab('overview'); set('nr', 'Intensity', '.65'); set('nr', 'WorkMode', '5'); await tab('enhance');
  set('sr', 'quality', 'performance'); set('fg', 'mode', 'fixed'); set('fg', 'multiplier', '3');
  const passiveWrites = count('apply'), passivePreviews = count('preview'); await delay(800);
  assert(count('apply') === passiveWrites && count('preview') === passivePreviews && count('legacy-mount') === 0, 'control changes never mount the old writer or auto-apply');
  assert(field('fg', 'mode').querySelector('option[value="dynamic"]').disabled, 'RTX40 Dynamic stays disabled');
  assert(field('fg', 'multiplier').querySelector('option[value="6"]').disabled, 'unverified multiplier stays disabled');
  assert(button('launch').disabled, 'dirty draft blocks launch');
  const dirtyBar = host().querySelector('.gp-apply-bar'), gameCard = host().closest('.game-card'), view = host().closest('.view');
  assert(host().firstElementChild === dirtyBar && dirtyBar.classList.contains('is-dirty'), 'dirty actions are immediately below the card header and before all tabs');
  assert(!host().querySelector('[data-gp-action="launch"]') && gameCard.querySelectorAll('.button.primary').length === 1 && button('preview').classList.contains('primary'), 'a dirty card has one prominent operation and no duplicate launch button');
  const originalScroll = view.scrollTop;
  view.scrollTop += dirtyBar.getBoundingClientRect().top - view.getBoundingClientRect().top + 120; await delay(40);
  const pinnedBar = dirtyBar.getBoundingClientRect(), viewport = view.getBoundingClientRect();
  assert(pinnedBar.top >= viewport.top - 1 && pinnedBar.bottom <= viewport.bottom && button('preview').getBoundingClientRect().right <= viewport.right, 'dirty preview and discard stay in the visible top area while scrolling');
  view.scrollTop = originalScroll;
  await preview();
  assert(mock.plan.request.nr.Intensity === .65 && mock.plan.request.nr.WorkMode === 5 && mock.plan.request.sr.preset === 'M' && mock.plan.request.sr.quality === 'performance' && mock.plan.request.fg.multiplier === 3, 'one preview includes numeric NR, explicit SR and FG');
  click('modal-apply'); await settled(); assert(!button('launch').disabled && count('elevated') === 0, 'successful ordinary Apply clears draft without elevation');

  await scenario('跨页签 SR 应用 · UI fixture', value => {
    const request = { backend: 'native', quality: 'preserve', preset: 'M' };
    value.enhancements.requests.sr = { request: structuredClone(request) };
    value.enhancements.applied.sr = { request: structuredClone(request), readbackVerified: true };
  });
  await tab('enhance'); assert(field('sr', 'preset').value === 'M', 'cross-tab SR starts from persisted M');
  set('sr', 'preset', 'K'); await tab('overview'); await preview();
  assert(mock.plan.request.sr.preset === 'K', 'overview unified preview includes the SR tab draft');
  const beforeCrossTabEnhancements = mock.calls.filter(row => row[0] === 'assess' && row[2] === 'enhancements').length;
  click('modal-apply'); await settled();
  assert(mock.assessment.enhancements.requests.sr.request.preset === 'K' && mock.assessment.enhancements.applied.sr.request.preset === 'K', 'cross-tab Apply persists both requested and applied SR K');
  assert(mock.calls.filter(row => row[0] === 'assess' && row[2] === 'enhancements').length === beforeCrossTabEnhancements, 'overview Apply leaves enhancement reading lazy');
  await tab('enhance'); await until(() => state().loaded.includes('enhancements'), 'enhancement reload after overview Apply');
  assert(mock.calls.filter(row => row[0] === 'assess' && row[2] === 'enhancements').length === beforeCrossTabEnhancements + 1 && field('sr', 'preset').value === 'K', 'returning to SR reads and displays persisted K');
  await preview('preview-sr'); assert(mock.plan.request.sr.preset === 'K', 'subsequent SR preview cannot revert the applied preset to M');
  click('modal-apply'); await settled();
  assert(mock.assessment.enhancements.applied.sr.request.preset === 'K' && field('sr', 'preset').value === 'K', 'reapplying displayed SR retains K in storage and UI');

  await scenario('已应用设置 · 启动时回读', value => {
    const request = { backend: 'native', quality: 'preserve', preset: 'M' };
    value.enhancements.requests.sr = { request: structuredClone(request) }; value.enhancements.applied.sr = { request: structuredClone(request), readbackVerified: true };
    value.launch.readiness = { state: 'unknown', known: false, source: 'metadata', blockers: [], pending: [], requests: { sr: { request: structuredClone(request) } } };
  }); await tab('overview');
  assert(!button('launch').disabled && host().textContent.includes('启动时检查设置'), 'metadata-only unknown keeps the existing launch path while describing the startup check');

  await scenario('启动前旧 SR 阻塞 · UI fixture', value => {
    const readiness = { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '仍有旧版 SR 选择或恢复记录；请先在增强设置中预览并应用或恢复。', action: { kind: 'open-settings' }, recovery: true }], pending: [], requests: {}, legacy: { configured: true } };
    value.launch.readiness = structuredClone(readiness); value.enhancements.launchReadiness = structuredClone(readiness);
  }); await tab('overview');
  assert(state().readiness?.state === 'blocked' && host().textContent.includes('旧版 SR'), 'old SR readiness is visible before launch without a new draft');
  assert(button('resolve-readiness')?.textContent === '前往超分补帧设置' && button('launch')?.disabled, 'old SR blocks launch and exposes the settings entry');
  click('resolve-readiness'); await until(() => state().tab === 'enhance', 'old SR settings entry');
  mock.assessment.enhancements.launchReadiness = { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: {} };
  click('refresh'); await until(() => state().readiness?.state === 'ready' && !state().busy, 'newer settings readiness'); await tab('overview');
  assert(!button('launch').disabled && !host().textContent.includes('旧版 SR'), 'newer enhancement readiness clears the stale installation blocker');

  await scenario('启动前旧 FG 阻塞 · UI fixture', value => {
    const request = { backend: 'rtx40', mode: 'fixed', multiplier: 2 };
    value.enhancements.requests.fg = { request: structuredClone(request) }; value.enhancements.applied.fg = { request: structuredClone(request), readbackVerified: true };
    value.enhancements.launchReadiness = { state: 'blocked', known: true, source: 'settings-inspection', blockers: [{ domain: 'fg', code: 'SETTINGS_FG_MIGRATION_REQUIRED', message: '旧补帧设置只保留恢复能力，请先迁移或撤销后再启动。', action: { kind: 'migrate' }, recovery: true }], pending: [], requests: { fg: { request: structuredClone(request) } } };
  }); await tab('overview');
  assert(button('resolve-readiness')?.textContent === '前往补帧设置' && button('launch')?.disabled, 'old FG blocks launch with a migration entry');
  click('resolve-readiness'); await until(() => state().tab === 'enhance' && button('restore-fg'), 'old FG restore entry');

  await scenario('启动前回读失配 · UI fixture', value => {
    const request = { backend: 'native', quality: 'preserve', preset: 'M' };
    value.enhancements.requests.sr = { request: structuredClone(request) }; value.enhancements.applied.sr = { request: structuredClone(request), readbackVerified: false, requiresReapply: true };
    value.enhancements.launchReadiness = { state: 'blocked', known: true, source: 'settings-inspection', blockers: [{ domain: 'sr', code: 'SETTINGS_REQUIRE_REAPPLY', message: '当前设置已被其他程序改变，请重新预览并明确应用。', action: { kind: 'reapply' } }], pending: [], requests: { sr: { request: structuredClone(request) } } };
  }); await tab('overview');
  assert(button('resolve-readiness')?.textContent === '重新预览设置' && button('launch')?.disabled, 'readback mismatch blocks launch with a reapply entry');
  click('resolve-readiness'); await until(() => state().tab === 'enhance' && button('reapply'), 'readback reapply entry');

  discard(); mock.assessment = structuredClone(mock.baseline); mock.assessment.game.name = 'FG 文件恢复 · metadata 阶段';
  mock.assessment.enhancements.fgComponents.fileRecoveryPending = true; mock.assessment.enhancements.fgComponents.fileOperationActive = false;
  mock.assessment.launch.readiness = { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'fg', code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED', message: '补帧组件文件操作尚未完成，请先恢复。', action: { kind: 'recover' }, recovery: true }], pending: [], requests: {} };
  await tab('overview'); click('refresh'); await until(() => state().data.game.name === 'FG 文件恢复 · metadata 阶段' && !state().busy, 'FG metadata readiness');
  assert(!state().loaded.includes('enhancements') && button('resolve-readiness')?.textContent === '前往补帧恢复', 'metadata FG recovery points to the owner flow before enhancement details load');
  click('resolve-readiness'); await until(() => state().tab === 'maintenance' && state().loaded.includes('enhancements'), 'FG recovery owner section'); await fold('.gp-maintenance-details');
  assert(button('recover-fg-components') && !button('recover-operation'), 'FG file recovery exposes its dedicated component owner action');
  click('recover-fg-components'); await settled();
  assert(mock.calls.some(row => row[0] === 'recover-fg-components') && !button('recover-fg-components') && state().readiness?.state === 'ready', 'FG component recovery reaches the owner API and clears the launch blocker');

  await scenario('仅有 DLL · 自动条件不足', value => { value.enhancements.featureStates.sr = structuredClone(mock.features.unknownSr); }); await tab('enhance');
  assert(field('sr', 'quality').disabled && button('preview-sr').disabled && !button('confirm-sr'), 'unknown native integration remains blocked without a manual confirmation escape');
  assert(state().data.enhancements.featureStates.sr.canConfirm === false, 'a supplied obsolete user confirmation does not create production support');
  mock.delays['fixture:enhancements'] = 5000; click('refresh');
  await until(() => mock.pending > 0, 'old unsupported response in flight'); const automaticApply = count('apply');
  mock.assessment.enhancements.featureStates.sr = structuredClone(mock.features.activationUnknownSr); mock.delays['fixture:enhancements'] = 20;
  const automaticAt = performance.now(); click('refresh');
  await until(() => !field('sr', 'quality').disabled, 'fresh automatic evidence enables controls', 800);
  assert(performance.now() - automaticAt < 800 && mock.pending > 0, 'fresh automatic evidence overtakes the slow obsolete assessment');
  assert(state().data.enhancements.featureStates.sr.activation.state === 'unknown' && !button('confirm-sr') && !host().querySelector('.gp-confirmed'), 'unknown game switch is displayed separately without a manual support declaration');
  assert(count('apply') === automaticApply, 'automatic reassessment does not apply settings');
  await until(() => mock.pending === 0, 'stale unsupported response drained');
  assert(!button('confirm-sr') && !field('sr', 'quality').disabled, 'late unsupported result cannot replace the newer automatic evidence'); mock.delays['fixture:enhancements'] = 0;
  await scenario('原生支持 · 游戏开关未开', value => { value.enhancements.featureStates.sr = structuredClone(mock.features.activationOffSr); }); await tab('enhance');
  assert(!field('sr', 'quality').disabled && state().data.enhancements.featureStates.sr.activation.state === 'off' && !button('confirm-sr'), 'verified support remains editable while the game-switch warning stays explicit');
  await scenario('RTX40 · MFG 入口未证实', value => { value.enhancements.featureStates.fg = structuredClone(mock.features.noMfgContract); }); await tab('enhance');
  assert(field('fg', 'mode').disabled && !button('confirm-fg'), 'native FG without the MFG Unlock entry contract cannot enable RTX40 controls');

  await maintenance(); await preview('uninstall-clean'); assert(mock.plan.request.uninstall === 'clean', 'clean uninstall is selected explicitly'); click('modal-cancel');
  await preview('uninstall-restore'); assert(mock.plan.request.uninstall === 'restore', 'restore mode is freshly selected'); click('modal-cancel');
  await tab('overview'); set('nr', 'Intensity', '.7'); await preview(); mock.failApply = true; click('modal-apply'); await settled();
  await maintenance(); assert(button('recover-operation'), 'partial apply failure exposes recovery'); click('recover-operation');
  await until(() => count('recover') === 1 && !state().busy && !state().data.operation.pending, 'recover operation'); discard(); mock.failApply = false;
  const beforeLaunchApply = count('apply'); click('launch');
  await until(() => count('launch') === 1 && !state().launching, 'explicit launch');
  assert(mock.calls.find(row => row[0] === 'launch')[1] === 'fixture' && count('apply') === beforeLaunchApply, 'launch targets the current game without applying settings');

  await scenario('折叠卡片启动 · 旧 SR 守卫', value => {
    const readiness = { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '旧版 SR 模型 M 仍有恢复记录，请先处理。', action: { kind: 'open-settings' }, recovery: true }], pending: [], requests: {} };
    value.launch.readiness = structuredClone(readiness); value.enhancements.launchReadiness = structuredClone(readiness);
  }); await tab('overview'); await until(() => state().readiness?.state === 'blocked' && !state().busy, 'collapsed launch blocker');
  const blockedLaunches = count('launch'); click('back');
  const collapsedBlockedCard = card('fixture'), collapsedBlockedLaunch = collapsedBlockedCard.querySelector('.unified-launch-btn');
  assert(collapsedBlockedLaunch?.disabled === false, 'collapsed old SR card keeps its routed launch entry'); collapsedBlockedLaunch.click();
  await until(() => host()?.__gpController.getState().tab === 'enhance' && !state().launching, 'collapsed old SR routes to settings');
  assert(count('launch') === blockedLaunches, 'collapsed old SR launch entry cannot call manager.launch');
  const readyReadiness = { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: {} };
  mock.assessment.launch.readiness = structuredClone(readyReadiness); mock.assessment.enhancements.launchReadiness = structuredClone(readyReadiness);
  await tab('overview'); click('refresh'); await until(() => state().readiness?.state === 'ready' && !state().busy, 'collapsed launch ready state');
  click('back'); const collapsedReadyCard = card('fixture'), collapsedReadyLaunch = collapsedReadyCard.querySelector('.unified-launch-btn'), readyLaunches = count('launch');
  assert(collapsedReadyLaunch?.disabled === false, 'normal collapsed card keeps its launch entry enabled'); collapsedReadyLaunch.click();
  await until(() => count('launch') === readyLaunches + 1 && !state().launching, 'collapsed normal launch');
  assert(mock.calls.filter(row => row[0] === 'launch').at(-1)[1] === 'fixture', 'collapsed normal launch reaches the current game only');

  const session = { sessionId: 'b4aa3424-4828-40cd-9b5b-a49e566c5130', gameId: 'fixture', targetExe: mock.baseline.game.chosen.path,
    requestedAt: new Date().toISOString(), status: 'waiting-enhancement', process: { pid: 24001, exe: mock.baseline.game.chosen.path, startedAt: new Date().toISOString() } };
  await scenario('本次画面对照 · UI fixture', value => { value.launch.session = { ...session, historical: true }; }); await diagnostics();
  assert(host().querySelectorAll('.gp-verification article').length === 5 && button('record-visual').disabled, 'five independent layers reject historical visual recording');
  assert(JSON.stringify([...host().querySelectorAll('.gp-verification article h4')].map(row => row.textContent)) === JSON.stringify(['加载助手就绪', 'ReShade 已加载', '本 Core 已加载', 'NR 完成并回填', '同场景画面变化']), 'five verification cards have distinct, ordered contracts');
  mock.assessment.launch.session = structuredClone(session); click('refresh'); await until(() => !button('record-visual')?.disabled, 'current visual recording'); await diagnostics();
  const originalLayers = JSON.stringify(Object.fromEntries(['helper', 'reshade', 'core', 'nr'].map(key => [key, mock.assessment.verification[key]])));
  const beforeVisualApply = count('apply'), beforeVisualPreview = count('preview');
  for (const result of ['changed', 'unchanged', 'uncertain']) {
    await diagnostics(); const cards = [...host().querySelectorAll('.gp-verification article')].slice(0, 4).map(row => row.textContent), prior = count('visual-record'); click('record-visual');
    const modal = host().querySelector('.gp-modal'); assert(modal.getAttribute('role') === 'dialog' && modal.querySelector('h3').textContent.includes('画面对照'), 'dedicated visual dialog');
    for (const input of modal.querySelectorAll('input,select,textarea')) assert(input.labels.length > 0, 'visual inputs have labels');
    click('save-visual'); await delay(30); assert(count('visual-record') === prior && modal.querySelector('.gp-modal-message').textContent.includes('同场景'), 'same-scene confirmation is mandatory');
    modal.querySelector('[data-gp-same-scene]').checked = true; modal.querySelector('[data-gp-visual-result]').value = result;
    const note = '<script>plain user note</script> 同场景 ' + result, evidenceLabel = 'C:\\UI-fixture\\evidence label only.png';
    modal.querySelector('[data-gp-visual-note]').value = note; modal.querySelector('[data-gp-visual-evidence]').value = evidenceLabel;
    const controls = [...modal.querySelectorAll('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled])')], first = controls[0], last = controls.at(-1);
    last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); assert(document.activeElement === first, 'Tab is trapped inside modal');
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); assert(document.activeElement === last, 'Shift+Tab wraps inside modal');
    click('save-visual'); await settled(); await diagnostics();
    const call = mock.calls.filter(row => row[0] === 'visual-record').at(-1);
    assert(call[1] === 'fixture' && JSON.stringify(call[2]) === JSON.stringify({ sessionId: session.sessionId, sameScene: true, result, note, evidenceLabel }), 'visual request preserves session and plain-text evidence');
    assert(JSON.stringify(Object.fromEntries(['helper', 'reshade', 'core', 'nr'].map(key => [key, mock.assessment.verification[key]]))) === originalLayers, 'visual recording does not promote helper/ReShade/Core/NR');
    assert([...host().querySelectorAll('.gp-verification article')].slice(0, 4).every((row, index) => row.textContent === cards[index]), 'only visual card changes');
    assert(host().querySelectorAll('.gp-verification article')[4].textContent.includes(result === 'changed' ? '已确认' : result === 'unchanged' ? '未观察到变化' : '待确认'), 'visual status follows observation');
  }
  assert(count('apply') === beforeVisualApply && count('preview') === beforeVisualPreview, 'visual observations never submit deployment or driver operations');
  await scenario('Feeder 宿主 · ReShade 与 Core 分层', value => {
    value.layout.hostRequired = true;
    value.verification.reshade = { status: 'passed', detail: '本次进程已加载匹配 ReShade。' };
    value.verification.core = { status: 'failed', detail: '宿主 Core 的摘要不匹配。' };
  }); await diagnostics();
  let runtimeCards = [...host().querySelectorAll('.gp-verification article')];
  assert(runtimeCards[1].querySelector('.badge').textContent === '已确认' && runtimeCards[1].textContent.includes('本次进程已加载匹配 ReShade。'), 'verified ReShade displays its own evidence');
  assert(runtimeCards[2].querySelector('h4').textContent === '宿主 Core 已加载' && runtimeCards[2].querySelector('.badge').textContent === '失败' && runtimeCards[2].textContent.includes('摘要不匹配'), 'host Core keeps its independent failure and host identity');
  assert(runtimeCards[3].querySelector('.badge').textContent === '待确认' && runtimeCards[4].querySelector('.badge').textContent === '待确认', 'ReShade success cannot promote NR or visual comparison');
  mock.assessment.verification.core = { status: 'passed', detail: '宿主 Core 已按固定摘要确认。' };
  mock.assessment.verification.nr = { status: 'passed', detail: '本次宿主 NR 完成并回填计数持续增长。' };
  click('refresh'); await until(() => state().data.verification?.nr?.status === 'passed' && mock.pending === 0, 'host NR success evidence'); await diagnostics();
  runtimeCards = [...host().querySelectorAll('.gp-verification article')];
  assert(runtimeCards[2].querySelector('.badge').textContent === '已确认' && runtimeCards[3].querySelector('.badge').textContent === '已确认' && runtimeCards[3].textContent.includes('完成并回填计数持续增长'), 'host Core and successful NR readback display separately');
  assert(runtimeCards[4].querySelector('.badge').textContent === '待确认', 'actual NR success still requires separate visual observation');
  await scenario('快捷键暂存 · UI fixture'); await tab('maintenance');
  const beforeHotkeyApply = count('apply'); click('capture-hotkey');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Insert', code: 'Insert', keyCode: 45, bubbles: true, cancelable: true })); await delay(100);
  assert(mock.assessment.hotkeys.reshade.key === 36 && count('direct-hotkey-write') === 0 && count('apply') === beforeHotkeyApply, 'shortcut only changes the draft');
  await preview(); assert(JSON.stringify(mock.plan.request) === JSON.stringify({ hotkeys: { reshade: { key: 45, ctrl: false, shift: false, alt: false } } }), 'Insert binding travels through unified preview');
  click('modal-cancel'); assert(mock.assessment.hotkeys.reshade.key === 36, 'cancel retains Home'); await preview(); click('modal-apply'); await settled();
  assert(mock.assessment.hotkeys.reshade.key === 45, 'unified Apply owns shortcut mutation');
  await tab('maintenance');
  assert(button('panel-default').textContent === '恢复默认 Home' && !button('panel-home'), 'default action clearly uses Home');
  click('panel-default');
  assert(mock.assessment.hotkeys.reshade.key === 45, 'reset to Home is a draft until unified Apply');
  await preview(); assert(JSON.stringify(mock.plan.request) === JSON.stringify({ hotkeys: { reshade: { key: 36, ctrl: false, shift: false, alt: false } } }), 'restore default submits Home with no modifiers');
  click('modal-apply'); await settled();
  assert(mock.assessment.hotkeys.reshade.key === 36, 'restoring the default persists Home after explicit Apply');

  await scenario('反作弊游戏 · 卸载后清理', value => { value.game.installed = false; value.antiCheat.detected = true; }); await maintenance();
  const cleanupOperations = count('apply'); click('clean-environment'); await until(() => host().querySelector('[data-gp-clean]'), 'cleanup preview');
  assert(!host().querySelector('.gp-modal [data-gp-consent]'), 'cleanup does not contain an unrelated deployment consent'); click('modal-apply'); await settled();
  assert(JSON.stringify(mock.calls.find(row => row[0] === 'cleanup-apply').slice(1)) === JSON.stringify(['fixture', 'fixture-cleanup-plan', ['other-addon.addon64']]), 'cleanup sends reviewed IDs and selected filenames');
  assert(count('apply') === cleanupOperations, 'cleanup uses its own owner');
  await scenario('反作弊游戏 · 普通应用确认', value => { value.antiCheat.detected = true; }); await tab('overview'); set('nr', 'Intensity', '.6'); await preview();
  const consent = host().querySelector('[data-gp-consent]'), beforeConsentApply = count('apply'); assert(consent && consent.getClientRects().length > 0 && !consent.checked, 'normal Apply shows visible unchecked consent');
  click('modal-apply'); await delay(30); assert(count('apply') === beforeConsentApply && host().querySelector('.gp-modal-message').textContent.includes('反作弊'), 'normal Apply still requires its visible consent'); click('modal-cancel'); discard();

  await scenario('SR 自定义比例 · 无效输入'); await tab('enhance'); set('sr', 'quality', 'custom'); set('sr', 'renderPercent', '75');
  const invalidSrPreviews = count('preview'); set('sr', 'renderPercent', '76.5');
  assert(host().querySelector('.gp-message.error[role="alert"]')?.textContent.includes('整数') && button('preview').disabled, 'invalid SR value immediately blocks preview');
  button('preview').click(); await delay(30); assert(count('preview') === invalidSrPreviews, 'invalid SR cannot reuse previous valid input');
  set('sr', 'renderPercent', '76'); await preview(); assert(mock.plan.request.sr.renderPercent === 76, 'corrected SR previews current value'); click('modal-cancel'); discard();
  await scenario('FG 动态目标 · 无效输入', value => { value.hardware = value.enhancements.hardware = { family: 'RTX50', series: ['RTX50'], names: ['NVIDIA RTX 5090'], source: 'fixture' }; value.enhancements.featureStates = structuredClone(mock.features.on50); });
  await tab('enhance'); set('fg', 'mode', 'dynamic'); assert(field('fg', 'targetFps') && !field('fg', 'multiplier'), 'dynamic shows only its target'); set('fg', 'targetFps', '120');
  const invalidFgPreviews = count('preview'); set('fg', 'targetFps', '120.5');
  assert(host().querySelector('.gp-message.error[role="alert"]')?.textContent.includes('整数') && button('preview').disabled, 'invalid FG value immediately blocks preview');
  button('preview').click(); await delay(30); assert(count('preview') === invalidFgPreviews, 'invalid FG cannot reuse previous target');
  set('fg', 'targetFps', '121'); await preview(); assert(mock.plan.request.fg.backend === 'nvidia' && mock.plan.request.fg.targetFps === 121, 'corrected FG retains backend and current target'); click('modal-cancel'); discard();

  await scenario('API 未确定 · 需要手选', value => { value.game.installed = false; value.api.effectiveApi = 'mixed'; value.api.capabilities = ['dx11', 'dx12']; value.game.chosen.apiResolution.api = 'mixed'; }); await tab('overview');
  assert(field('route', 'api').selectedOptions[0].textContent.includes('需要手动选择') && button('prepare').disabled, 'unresolved automatic API requests manual selection and blocks installation');
  set('route', 'api', 'dx12'); await preview(); assert(mock.plan.request.api === 'dx12', 'manual API reaches unified preview'); click('modal-cancel'); discard();
  await scenario('手动 API 恢复自动 · UI fixture', value => {
    value.game.apiOverride = value.defaults.api = value.api.configuredApi = value.api.effectiveApi = 'dx11';
    value.api.detectedApi = 'dx12'; value.api.capabilities = ['dx11', 'dx12'];
    value.game.chosen.apiResolution = { api: 'dx11', source: 'override' };
    value.game.chosen.detectedApiResolution = { api: 'dx12', source: 'entry' };
  });
  await tab('overview'); assert(field('route', 'api').value === 'dx11' && state().data.api.detectedApi === 'dx12', 'manual API preference is separate from independently detected DX12');
  set('route', 'api', 'auto'); await preview();
  assert(mock.plan.request.api === 'auto', 'returning to automatic API preserves auto in the unified request');
  click('modal-apply'); await settled();
  assert(mock.assessment.game.apiOverride === 'auto' && mock.assessment.defaults.api === 'auto' && mock.assessment.api.configuredApi === null, 'Apply persists automatic preference instead of a resolved manual API');
  assert(field('route', 'api').value === 'auto' && state().data.api.detectedApi === 'dx12' && state().data.api.effectiveApi === 'dx12', 'post-Apply refresh keeps automatic selection while using detected DX12');
  const beforeAutomaticRefresh = count('assess'); click('refresh');
  await until(() => count('assess') > beforeAutomaticRefresh && mock.pending === 0 && state().loaded.includes('installation'), 'explicit automatic API refresh');
  assert(field('route', 'api').value === 'auto' && state().data.api.effectiveApi === 'dx12', 'explicit recheck does not convert automatic API back to manual');
  await scenario('游戏目录默认安装 · UI fixture', value => { value.game.installed = false; }); await tab('overview'); await preview('prepare');
  assert(mock.plan.request.api === 'auto' && mock.plan.request.version === '0.4.7beta' && mock.plan.request.deployment === 'local' && mock.plan.request.loadingMode === undefined, 'prepare preserves automatic API and local layout while binding the displayed Core'); click('modal-cancel'); discard();
  await tab('maintenance'); set('component', 'bridge', 'nigos-1.4.11-nr'); await tab('overview');
  assert(field('route', 'version').value === '0.4.7beta', 'advanced bridge choice does not appear as a second Core'); await preview();
  assert(JSON.stringify(mock.plan.request) === JSON.stringify({ components: { bridge: 'nigos-1.4.11-nr' } }), 'bridge version is an independent component request and leaves Core identity implicit'); click('modal-cancel'); discard();
  for (const route of ['vulkan', 'feeder']) {
    const packageId = 'fixture-' + route + '-fixed', api = route === 'vulkan' ? 'vulkan' : 'dx12';
    await scenario(route + ' 固定配套', value => { value.game.installed = false; value.game.chosen.apiResolution.api = value.api.effectiveApi = api; value.game.nativeDlssAvailable = route !== 'feeder';
      value.game[route] = { installed: false, available: true, selectionAvailable: true, packageId, coreVersion: route + '-core' };
      value.layout.source = route; value.layout.mode = value.deployment.mode = route === 'vulkan' ? 'external' : 'local'; });
    await tab('overview'); assert(field('route', 'version').disabled && field('route', 'version').value === packageId && field('route', 'version').options.length === 1, 'fixed route exposes only its package');
    await preview('prepare'); assert(mock.plan.request.route === route && mock.plan.request.api === 'auto' && mock.plan.request.version === packageId && mock.plan.request.loadingMode === undefined, 'fixed route follows automatic detection and sends its fixed package without a native Core or helper choice'); click('modal-cancel'); discard();
    await tab('maintenance'); assert(field('route', 'deployment').disabled && field('route', 'loadingMode').disabled, 'fixed route blocks unrelated layout and helper choices');
  }

  await scenario('三滑块与人脸强度 · UI fixture'); await tab('overview');
  const nrPassiveWrites = count('apply');
  set('nr', 'Intensity', '1.15'); set('nr', 'LocalToneStrength', '.75'); set('nr', 'LocalStructureStrength', '1.25');
  assert(!field('nr', 'SkinStructureStrength') && !field('face', 'enabled').checked, 'disabled AutoMask hides the face strength control');
  set('face', 'enabled', true); assert(field('nr', 'SkinStructureStrength').value === '0', 'enabling a legacy negative face value exposes zero instead of an invalid slider value');
  set('nr', 'SkinStructureStrength', '.8'); set('face', 'enabled', false);
  assert(!field('nr', 'SkinStructureStrength') && state().draft.nr.SkinStructureStrength === .8, 'disabling face controls retains the draft strength');
  set('face', 'enabled', true); assert(field('nr', 'SkinStructureStrength').value === '0.8', 're-enabling face controls restores the retained strength');
  assert(count('apply') === nrPassiveWrites, 'all NR changes remain drafts');
  await preview();
  assert(JSON.stringify(mock.plan.request.nr) === JSON.stringify({ Intensity: 1.15, LocalToneStrength: .75, LocalStructureStrength: 1.25, SkinStructureStrength: .8, AutoMask: 1 }), 'three numeric sliders and AutoMask share one precise NR request');
  click('modal-apply'); await settled();
  assert(mock.assessment.nr.AutoMask === 1 && mock.assessment.nr.SkinStructureStrength === .8, 'applied face enable and strength read back together');
  set('face', 'enabled', false); await preview();
  assert(JSON.stringify(mock.plan.request) === JSON.stringify({ nr: { AutoMask: 0 } }), 'disabling an applied face adjustment preserves its saved intensity'); click('modal-cancel'); discard();
  await scenario('旧 Core 缺少新参数 · UI fixture', value => {
    value.nr.capabilities.LocalToneStrength = value.nr.capabilities.LocalStructureStrength = value.nr.capabilities.SkinStructureStrength = false;
    delete value.nr.LocalToneStrength; delete value.nr.LocalStructureStrength;
  }); await tab('overview');
  assert(field('nr', 'LocalToneStrength').disabled && field('nr', 'LocalStructureStrength').disabled && field('face', 'enabled').disabled, 'absent Core capabilities stay disabled instead of fabricated by fixture defaults');
  await scenario('能力结果缺失 · UI fixture', value => { delete value.enhancements.featureStates.sr; }); await tab('enhance');
  assert(field('sr', 'preset').disabled && button('preview-sr').disabled && !button('confirm-sr'), 'missing automatic feature evidence cannot inherit old boolean support flags');

  await scenario('任意快捷键录入 · UI fixture'); await tab('maintenance');
  click('capture-hotkey'); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true, keyCode: 17, bubbles: true, cancelable: true }));
  assert(!state().draft.hotkeys && button('capture-hotkey').textContent.includes('请按组合键'), 'modifier alone is not accepted as a hotkey');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
  assert(!state().draft.hotkeys && button('capture-hotkey').textContent.includes('点击录入'), 'Escape cancels capture without changing the saved binding');
  click('capture-hotkey'); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', code: 'KeyK', keyCode: 75, ctrlKey: true, shiftKey: true, altKey: true, bubbles: true, cancelable: true }));
  await preview(); assert(JSON.stringify(mock.plan.request) === JSON.stringify({ hotkeys: { reshade: { key: 75, ctrl: true, shift: true, alt: true } } }), 'custom keyboard capture preserves all modifiers in unified preview');
  click('modal-cancel'); discard();

  await scenario('MFG 面板读回与独立版本 · UI fixture', value => {
    value.enhancements.fgComponents.installed = true; value.enhancements.fgComponents.installedProvider = 'mfgunlock-0.9';
    value.enhancements.requests.fg = { request: { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 } };
    value.enhancements.applied.fg = { request: { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 }, readbackVerified: true };
    value.enhancements.current = { fg: { source: 'active-ini', valid: true, differsFromLastApplied: true, request: { backend: 'mfgunlock', mode: 'fixed', multiplier: 4 } } };
  }); await tab('enhance');
  assert(field('fg', 'multiplier').value === '4' && field('component', 'mfgUnlock').value === 'mfgunlock-0.9', 'actual game-panel INI takes priority over old multiplier while installed provider remains selected');
  assert(host().textContent.includes('与上次管理器请求不同'), 'external game-panel change is visible');
  set('fg', 'multiplier', '2');
  mock.assessment.enhancements.current.fg.request.multiplier = 3; click('discard');
  set('fg', 'multiplier', '2');
  await host().__gpController.refresh(true);
  assert(field('fg', 'multiplier').value === '2' && state().draft.fg.multiplier === 2, 'fresh INI readback preserves a dirty FG draft');
  await preview(); assert(mock.plan.request.fg.multiplier === 2 && !mock.plan.request.components && mock.plan.request.version === undefined, 'FG setting change preserves the installed MFG plugin version');
  click('modal-cancel'); discard();
  assert(field('fg', 'multiplier').value === '3', 'discard returns to the newest actual INI value');
  set('component', 'mfgUnlock', 'mfgunlock-0.9-zh-CN'); await tab('maintenance'); set('component', 'bridge', 'nigos-1.4.11-nr'); await tab('overview');
  assert(field('route', 'version').value === '0.4.7beta', 'independent MFG and bridge selections keep the Core visible');
  await preview(); assert(JSON.stringify(mock.plan.request) === JSON.stringify({ components: { mfgUnlock: 'mfgunlock-0.9-zh-CN', bridge: 'nigos-1.4.11-nr' } }), 'component choices combine without synthesizing a Core, NR or FG request');
  click('modal-apply'); await settled(); await tab('enhance'); await until(() => state().loaded.includes('enhancements'), 'provider refresh');
  assert(field('component', 'mfgUnlock').value === 'mfgunlock-0.9-zh-CN' && field('fg', 'multiplier').value === '3', 'provider update reads back independently from the actual multiplier');

  await scenario('DX12 入口独立选择 · UI fixture', value => {
    value.game.chosen.apiResolution.api = value.api.effectiveApi = 'dx12'; value.api.capabilities = ['dx12'];
  }); await tab('maintenance'); set('route', 'proxyEntry', 'd3d12');
  await preview(); assert(JSON.stringify(mock.plan.request) === JSON.stringify({ proxyEntry: 'd3d12' }) && state().data.api.effectiveApi === 'dx12', 'proxy filename is independent from graphics API and Core version'); click('modal-cancel'); discard();
  await scenario('DX11 入口不伪造 API · UI fixture'); await tab('maintenance');
  assert(field('route', 'proxyEntry').querySelector('option[value="d3d12"]').disabled, 'DX11 cannot choose the DX12-only proxy entry');
  set('component', 'bridge', 'nigos-1.4.11-nr'); await tab('overview'); set('route', 'api', 'dx12');
  assert(!state().draft.components?.bridge && state().draft.api === 'dx12', 'moving from DX11 to DX12 clears only the inapplicable bridge draft'); discard();

  await scenario('Feeder 随 API 选择完整配套', value => {
    value.game.installed = false; value.game.nativeDlssAvailable = false;
    value.game.feeder = { installed: false, available: true, selections: {
      dx11: { api: 'dx11', available: true, packageId: 'fixture-feeder-dx11', coreVersion: '0.4.7beta' },
      dx12: { api: 'dx12', available: true, packageId: 'fixture-feeder-dx12', coreVersion: '0.4.7beta' },
      dx10: { api: 'dx10', available: true, packageId: 'fixture-feeder-dx10', coreVersion: '0.4.7beta' }
    } };
  }); await tab('overview');
  assert(field('route', 'version').value === 'fixture-feeder-dx11', 'automatic DX11 selects its complete Feeder package');
  set('route', 'api', 'dx10'); assert(field('route', 'version').value === 'fixture-feeder-dx10', 'DX10 selection changes only to a matching Feeder package');
  await preview(); assert(mock.plan.request.route === 'feeder' && mock.plan.request.api === 'dx10' && mock.plan.request.version === 'fixture-feeder-dx10', 'matching Feeder selection submits the displayed API-specific package'); click('modal-cancel'); discard();
  await tab('maintenance'); set('input-route', 'route', 'native'); await preview();
  assert(mock.plan.request.route === 'native' && mock.plan.request.version === '0.4.7beta', 'explicit native input binds the displayed Core for production eligibility to validate'); click('modal-cancel'); discard();

  await open('fixture-hoyo'); await until(() => state().loaded.includes('installation'), 'HoYo client assessment');
  assert(field('route', 'loadingBackend').value === 'local' && !field('hoyo', 'channel'), 'HoYo clients retain ordinary loading as the initial visible choice');
  set('route', 'loadingBackend', 'hoyoshade');
  assert(field('hoyo', 'channel').options.length === 3 && [...field('hoyo', 'channel').options].every(row => ['cn', 'bilibili', 'global'].includes(row.value)), 'formal channels come from production HoYo profile options');
  set('hoyo', 'channel', 'bilibili'); click('pick-hoyo-launcher'); await until(() => state().draft.hoyo?.launcher.path, 'HoYoPlay path binding');
  assert(state().draft.hoyo.launcher.kind === 'hoyoplay' && state().draft.hoyo.launcher.path === mock.selectedLauncher, 'picker binds the selected launcher program');
  set('hoyo', 'kind', 'starward'); assert(!state().draft.hoyo.launcher.path, 'changing launcher type clears the previous program identity');
  mock.selectedLauncher = 'C:\\UI-fixture\\Starward\\Starward.exe'; click('pick-hoyo-launcher'); await until(() => state().draft.hoyo?.launcher.path === mock.selectedLauncher, 'Starward path binding');
  await tab('maintenance');
  assert(field('route', 'deployment').disabled && field('route', 'deployment').value === 'external' && field('route', 'loadingMode').disabled && field('route', 'loadingMode').value === 'helper' && !field('route', 'proxyEntry'), 'HoYo external helper controls do not expose a conflicting proxy entry');
  await preview();
  assert(mock.plan.request.loadingBackend === 'hoyoshade' && mock.plan.request.route === 'feeder' && mock.plan.request.version === 'fixture-feeder-dx11-x64' && JSON.stringify(mock.plan.request.hoyo) === JSON.stringify({ family: 'starrail', channel: 'bilibili', launcher: { kind: 'starward', path: mock.selectedLauncher } }), 'HoYo preview preserves family, public channel, launcher type and program path');
  click('modal-cancel'); discard(); await tab('overview');
  assert(field('route', 'loadingBackend').value === 'local' && !field('hoyo', 'kind'), 'discard restores the ordinary HoYo loading choice');
  await open('fixture');

  await scenario('未知插件先预览后保留', value => { value.game.installed = false; }); await tab('overview');
  await mock.resetPolicy(); mock.policyEnabled = true; await preview('prepare');
  let keepInput = host().querySelector('[data-gp-addon-keep]');
  assert(host().querySelectorAll('[data-gp-addon-keep]').length === 1 && !keepInput.checked, 'production policy offers only the unknown active plugin as an unchecked exception');
  assert(mock.plan.deployment.addonCompatibility.decisions.filter(row => row.mandatory && row.action === 'retire-core').length === 2, 'renamed known Core and carrier remain mandatory retirement rows without a keep checkbox');
  const firstPolicy = mock.plan, unknown = firstPolicy.deployment.addonCompatibility.decisions.find(row => row.name === 'personal-addon.addon64');
  keepInput.checked = true; keepInput.dispatchEvent(new Event('change', { bubbles: true }));
  const beforeKeepApply = count('apply');
  assert(button('modal-apply').disabled && button('apply-elevated').disabled && host().querySelector('.gp-modal-message').textContent.includes('重新预览'), 'changed keep selection disables both execution buttons until a new preview exists');
  button('modal-apply').click(); await delay(30); assert(count('apply') === beforeKeepApply, 'disabled old preview cannot apply an unreviewed keep choice');
  click('repreview-addons'); await until(() => mock.plan.planId !== firstPolicy.planId && !state().busy, 'new bound keep preview');
  assert(JSON.stringify(mock.plan.request.addonKeep) === JSON.stringify([{ path: unknown.path, sha256: unknown.sha256, configFingerprint: unknown.configFingerprint }]), 'repreview sends the exact observed path, SHA and configuration binding');
  assert(mock.plan.deployment.addonCompatibility.decisions.find(row => row.path === unknown.path).explicitKeep === true && !button('modal-apply').disabled, 'production policy accepts the bound keep and enables the new preview');
  assert(mock.plan.fingerprint !== firstPolicy.fingerprint, 'keep change creates a new production policy fingerprint');
  const beforeVerifiedKeep = mock.policyApplied; click('modal-apply'); await settled();
  assert(mock.policyApplied === beforeVerifiedKeep + 1, 'Apply rechecks the actual production file snapshot');
  for (const mutation of ['config', 'plugin']) {
    await scenario('保留插件预览过期 · ' + mutation, value => { value.game.installed = false; }); await tab('overview');
    await mock.resetPolicy(); mock.policyEnabled = true; await preview('prepare');
    keepInput = host().querySelector('[data-gp-addon-keep]'); keepInput.checked = true; keepInput.dispatchEvent(new Event('change', { bubbles: true }));
    await mock.mutatePolicy(mutation); const oldPlan = mock.plan.planId, beforeStaleApply = count('apply');
    click('repreview-addons'); await until(() => mock.plan.planId !== oldPlan && !state().busy, 'stale keep preview ' + mutation);
    assert(mock.plan.blockers.some(row => row.code === 'ADDON_KEEP_STALE') && button('modal-apply').disabled && button('apply-elevated').disabled, 'changed ' + mutation + ' makes the old keep identity stale in production policy');
    button('modal-apply').click(); await delay(30); assert(count('apply') === beforeStaleApply, 'stale keep cannot invoke Apply'); click('modal-cancel'); discard();
  }
  await scenario('最终 Apply 前插件变更', value => { value.game.installed = false; }); await tab('overview');
  await mock.resetPolicy(); mock.policyEnabled = true; await preview('prepare');
  keepInput = host().querySelector('[data-gp-addon-keep]'); keepInput.checked = true; keepInput.dispatchEvent(new Event('change', { bubbles: true }));
  const finalBefore = mock.plan.planId; click('repreview-addons'); await until(() => mock.plan.planId !== finalBefore && !state().busy, 'final bound keep preview');
  const verifiedBeforeChange = mock.policyApplied; await mock.mutatePolicy('plugin'); click('modal-apply'); await settled();
  assert(mock.policyApplied === verifiedBeforeChange && host().querySelector('.gp-message.error[role="alert"]')?.textContent, 'last-moment mutation is rejected by production snapshot assertion and shown as an error'); discard();

  await scenario('库条目移出 · 已有覆盖', value => { value.game.installed = false; value.enhancements.applied.sr = { request: { backend: 'native', quality: 'quality', preset: 'K' }, readbackVerified: true }; }); await maintenance();
  assert(button('remove-game').disabled, 'owned settings block library removal');
  await scenario('库条目移出 · 无受管状态', value => { value.game.installed = false; }); await maintenance();
  const beforeRemoveApply = count('apply'), beforeRemovePreview = count('preview'); click('remove-game');
  assert(button('remove-confirm') && !button('modal-apply') && count('remove-game') === 0, 'library removal has a separate metadata-only dialog'); click('modal-cancel'); assert(count('remove-game') === 0, 'cancel retains entry');
  click('remove-game'); click('remove-confirm'); await until(() => !card('fixture') && count('remove-game') === 1, 'library removal');
  assert(card('fixture-two') && count('apply') === beforeRemoveApply && count('preview') === beforeRemovePreview && count('direct-uninstall') === 0, 'only selected metadata entry is removed');
  mock.removed.clear(); mock.assessment = structuredClone(mock.baseline); document.getElementById('refreshBtn').click(); await until(() => card('fixture'), 'restore screenshot fixture'); await open('fixture');
  await until(() => state().loaded.includes('installation'), 'final screenshot installation');
  const finalToast = document.getElementById('toast');
  assert(!finalToast.classList.contains('error'), 'successful library refresh must not report an error toast');
  if (finalToast.classList.contains('show')) {
    assert(finalToast.textContent === '扫描完成', 'only the known successful refresh toast is cleared for screenshot');
    finalToast.classList.remove('show');
  }
  assert(!mock.calls.some(row => row[0] === 'startup-failed' || row[0] === 'legacy-mount' || row[0].startsWith('direct-')), 'no legacy controller, direct writers or startup failure ran');
  assert(document.getElementById('view-games').classList.contains('active') && !document.getElementById('view-game-detail').classList.contains('active'), 'all flows remain inside the library');
  return { assertionCount, writes: count('apply'), previews: count('preview'), retiredConfirmations: count('direct-retired-feature-confirmation'), visualRecords: count('visual-record'), removals: count('remove-game'), productionPolicyApplies: mock.policyApplied,
    assertions: 'inline seed, 5s lazy sections, reverse cross-game responses, controller reuse, drafts, production automatic support and SR compiler, unified Apply, recovery, visual provenance, custom hotkeys, three NR sliders and AutoMask, actual MFG INI, independent bridge/MFG versions, proxy/API separation, DX9 x86 static unsupported Feeder, API package selection, formal HoYo launcher binding, production addon keep repreview/stale/CAS, fixed routes and metadata removal' };
}

async function captureBaseline({ tab = 'overview', diagnostics = false, dirty = false } = {}) {
  const mock = window.__gpMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertionCount = 0;
  const assert = (value, message) => { assertionCount++; if (!value) throw Error(message); };
  const until = async (predicate, label) => { for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await delay(20); } throw Error('Short UI timeout: ' + label); };
  const card = () => document.querySelector('.game-card[data-id="fixture"]');
  const host = () => document.querySelector('.game-card.expanded .game-detail.gp-inline');
  const state = () => host()?.__gpController.getState();
  const field = (group, key) => host()?.querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"]`);
  const button = action => host()?.querySelector(`[data-gp-action="${action}"]`);
  const click = action => { const item = button(action); assert(item && !item.disabled && item.getClientRects().length, 'short action available: ' + action); item.click(); };
  await until(() => card()?.querySelector('.open-game-page-btn'), 'library ready'); card().querySelector('.open-game-page-btn').click();
  await until(() => state()?.loaded.includes('installation'), 'installation baseline');
  assert(document.getElementById('view-games').classList.contains('active') && !document.getElementById('view-game-detail').classList.contains('active'), 'short baseline stays in library');

  // Test the actual global refresh path that previously returned an unwrapped
  // boolean to runAction, producing a false failure after a successful scan.
  const beforeRefresh = mock.calls.filter(row => row[0] === 'refresh').length;
  document.getElementById('refreshBtn').click();
  await until(() => mock.calls.filter(row => row[0] === 'refresh').length === beforeRefresh + 1 && document.getElementById('toast').classList.contains('show'), 'global refresh notification');
  const toast = document.getElementById('toast');
  assert(!toast.classList.contains('error') && toast.textContent === '扫描完成', 'successful refresh reports scan completion without an error');

  // Existing installations retain their version until the user explicitly
  // selects another Core. Repair is a dedicated request, without normalization.
  mock.assessment.game.addonVersion = mock.assessment.deployment.version = '0.4.5-ota';
  mock.assessment.defaults.version = '0.4.5-ota';
  mock.assessment.coreVersions.push({ id: '0.4.5-ota', label: '原有 0.4.5 OTA', ready: true });
  mock.assessment.deployment.verified = false;
  const originalLayout = JSON.stringify(mock.assessment.layout), originalDeployment = JSON.stringify(mock.assessment.deployment);
  click('refresh'); await until(() => state().data.deployment.version === '0.4.5-ota' && mock.pending === 0, 'legacy version baseline');
  assert(field('route', 'version').value === '0.4.5-ota' && !state().draft.version, 'installed Core identity remains visible without a user dropdown change');
  assert(!button('prepare') && button('repair-install'), 'incomplete installed state exposes dedicated repair');
  const beforeApply = mock.calls.filter(row => row[0] === 'apply').length;
  click('repair-install'); await until(() => host().querySelector('.gp-modal'), 'legacy repair preview');
  assert(JSON.stringify(mock.plan.request) === JSON.stringify({ repair: true }), 'legacy repair preserves the installed package through its dedicated request');
  assert(mock.calls.filter(row => row[0] === 'apply').length === beforeApply && JSON.stringify(mock.assessment.layout) === originalLayout && JSON.stringify(mock.assessment.deployment) === originalDeployment, 'preview neither applies nor migrates existing files');
  click('modal-cancel');
  field('route', 'version').value = '0.4.7beta'; field('route', 'version').dispatchEvent(new Event('change', { bubbles: true }));
  click('preview'); await until(() => host().querySelector('.gp-modal'), 'explicit Core change preview');
  assert(mock.plan.request.version === '0.4.7beta' && mock.plan.request.deployment === 'local', 'only an explicit Core selection enters the version request');
  click('modal-cancel'); click('discard');
  mock.assessment = structuredClone(mock.baseline); click('refresh'); await until(() => state().data.deployment.version === '0.4.7beta' && mock.pending === 0, 'restored normal screenshot baseline');

  mock.delays['fixture:enhancements'] = 120;
  host().querySelector('[data-gp-tab="enhance"]').click();
  await until(() => state().loaded.includes('enhancements'), 'short lazy enhancement load');
  assert(document.activeElement === host().querySelector('[data-gp-tab="enhance"]'), 'tab keyboard focus survives asynchronous section rendering');
  assert(field('sr', 'preset').value === 'M' && field('sr', 'quality').value === 'preserve' && !field('sr', 'renderPercent'), 'short enhancement baseline shows explicit M without changing game quality');
  host().querySelector(`[data-gp-tab="${tab}"]`).click();
  if (tab === 'maintenance') {
    await until(() => state().loaded.includes('diagnostics'), 'short diagnostic load');
    assert(button('panel-default')?.textContent === '恢复默认 Home' && host().textContent.includes('ReShade：Home'), 'capture displays Home as the active and reset-default panel key');
    if (!diagnostics) button('panel-default').closest('.gp-section').scrollIntoView({ block: 'center' });
  }
  if (diagnostics) {
    assert(tab === 'maintenance', 'expanded diagnostic capture uses the maintenance tab');
    const detail = host().querySelector('.gp-diagnostics-details'); detail.querySelector('summary').click();
    assert(detail.open && detail.querySelectorAll('.gp-verification article').length === 5, 'expanded capture contains exactly five verification cards');
    assert(JSON.stringify([...detail.querySelectorAll('.gp-verification article h4')].map(row => row.textContent)) === JSON.stringify(['加载助手就绪', 'ReShade 已加载', '本 Core 已加载', 'NR 完成并回填', '同场景画面变化']), 'expanded diagnostic card labels retain the frozen contracts');
    detail.querySelector('.gp-verification').scrollIntoView({ block: 'center' });
  }
  if (dirty) {
    const input = tab === 'enhance' ? field('sr', 'preset') : field('nr', 'Intensity');
    assert(input && !input.disabled, 'dirty capture has an editable setting'); input.value = tab === 'enhance' ? 'K' : '1.45';
    input.dispatchEvent(new Event(input.type === 'range' ? 'input' : 'change', { bubbles: true }));
    const view = document.getElementById('view-games'), bar = host().querySelector('.gp-apply-bar');
    view.scrollTop += card().getBoundingClientRect().top - view.getBoundingClientRect().top;
    assert(host().firstElementChild === bar && button('preview') && button('discard'), 'dirty action row appears directly below the card header');
    assert(card().querySelectorAll('.button.primary').length === 1 && !host().querySelector('[data-gp-action="launch"]'), 'dirty capture highlights one operation without repeated launch');
    await delay(40); const box = bar.getBoundingClientRect(), viewport = view.getBoundingClientRect();
    assert(box.top >= viewport.top && box.bottom < viewport.bottom, 'both dirty actions are visible without scrolling to the card bottom');
  }
  await delay(40);
  assert(!toast.classList.contains('error'), 'no unrecognized error toast is hidden');
  if (toast.classList.contains('show')) { assert(toast.textContent === '扫描完成', 'only the known refresh success notification is cleared'); toast.classList.remove('show'); }
  const nodes = [document.documentElement, document.body, document.getElementById('view-games'), card(), host(), ...host().querySelectorAll('.gp-controls')];
  const widths = nodes.filter(node => node.getClientRects().length).map(node => ({ node: node.id || node.className || node.tagName, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  assert(widths.every(row => row.scrollWidth <= row.clientWidth + 1), 'narrow baseline has no horizontal overflow: ' + JSON.stringify(widths));
  assert(!mock.calls.some(row => row[0] === 'startup-failed' || row[0] === 'legacy-mount' || row[0].startsWith('direct-')), 'short baseline invokes no legacy or direct writers');
  return { scope: 'capture-only', assertionCount, tab, diagnostics, dirty, viewport: { width: innerWidth, height: innerHeight }, horizontalOverflow: false,
    writes: mock.calls.filter(row => row[0] === 'apply').length, previews: mock.calls.filter(row => row[0] === 'preview').length,
    assertions: 'global refresh success notification, preserved installed Core repair, explicit version selection, local layout, lazy tab focus, explicit SR baseline and narrow overflow', widths };
}

async function captureReadiness({ readiness = 'blocked', tab = 'enhance' } = {}) {
  const mock = window.__gpMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertionCount = 0;
  const assert = (value, message) => { assertionCount++; if (!value) throw Error(message); };
  const until = async (predicate, label) => { for (let attempt = 0; attempt < 150; attempt++) { if (predicate()) return; await delay(20); } throw Error('Readiness capture timeout: ' + label); };
  const card = () => document.querySelector('.game-card[data-id="fixture"]');
  const host = () => card()?.querySelector('.game-detail.gp-inline');
  const state = () => host()?.__gpController.getState();
  await until(() => card()?.querySelector('.open-game-page-btn'), 'library ready'); card().querySelector('.open-game-page-btn').click();
  await until(() => state()?.loaded.includes('installation'), 'installation readiness');
  const blocked = readiness !== 'ready', value = mock.assessment;
  const request = { backend: 'native', quality: 'preserve', preset: 'M' };
  value.enhancements.requests.sr = { request: structuredClone(request) };
  value.enhancements.applied.sr = { request: structuredClone(request), readbackVerified: readiness === 'ready' };
  value.launch.readiness = blocked ? { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '旧版 SR 模型 M 仍有恢复记录，请先在超分设置中处理。', action: { kind: 'open-settings' }, recovery: true }], pending: [], requests: {}, legacy: { configured: true, effective: 'm' } } : { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: { sr: { request: structuredClone(request) } }, legacy: { managed: true } };
  await host().__gpController.refresh(true); await until(() => state()?.readiness?.state === (blocked ? 'blocked' : 'ready') && !state()?.busy, 'readiness state');
  if (tab !== 'overview') { host().__gpController.selectTab(tab); await until(() => state()?.tab === tab && state()?.loaded.includes('enhancements'), 'readiness tab'); }
  const unified = card().querySelector('.unified-launch-btn');
  assert(blocked ? unified?.disabled === true : unified?.disabled === false, blocked ? 'old M disables the external launch entry' : 'ready state re-enables the external launch entry');
  assert(blocked ? host().textContent.includes('旧版 SR') && host().querySelector('[data-gp-action="resolve-readiness"]') : host().textContent.includes('设置已就绪'), blocked ? 'old M reason and entry are visible' : 'ready state clears the old M reason');
  return { scope: 'readiness contract screenshot · normal GamePageUi', assertionCount, readiness, tab, launchDisabled: Boolean(unified?.disabled), entry: Boolean(host().querySelector('[data-gp-action="resolve-readiness"]')) };
}

async function captureHoYoReadiness({ readiness = 'blocked' } = {}) {
  const gp = window.__gpMock, mock = window.__hoyoMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertionCount = 0;
  const assert = (value, message) => { assertionCount++; if (!value) throw Error(message); };
  const until = async (predicate, label) => { for (let attempt = 0; attempt < 180; attempt++) { if (predicate()) return; await delay(20); } throw Error('HoYo readiness capture timeout: ' + label); };
  const blocked = readiness !== 'ready', flow = mock.flow, game = gp.assessments['fixture-hoyo'];
  const launcher = flow.binding.launchers[0];
  flow.binding = { ...flow.binding, status: 'confirmed', launcher, channels: [{ channel: 'cn', channelLabel: '国服' }] };
  flow.channel = 'cn'; flow.channelLabel = '国服'; flow.api = { api: 'dx11', source: 'user', requiresConfirmation: false, evidence: [] };
  flow.installation = { installed: true, ready: true, needsRecovery: false, error: null }; flow.phase = 'ready'; flow.nextAction = 'start'; flow.error = null;
  const readinessResult = blocked ? { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '旧版 SR 模型 M 仍有恢复记录，请先在超分设置中处理。', action: { kind: 'open-settings' }, recovery: true }], pending: [], requests: {}, legacy: { configured: true, effective: 'm' } } : { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: {}, legacy: { managed: true } };
  flow.launchReadiness = structuredClone(readinessResult); game.game.installed = true; game.launch.readiness = structuredClone(readinessResult); game.nr = structuredClone(gp.baseline.nr);
  document.querySelector('[data-view="hoyo"]').click();
  const host = () => document.getElementById('hoyoWorkspace'), card = () => host()?.querySelector('.hoyo-game-card.expanded'), anyCard = () => host()?.querySelector('.hoyo-game-card');
  await until(() => anyCard() && host().querySelector('.hoyo-settings-host')?.__gpController && !host().querySelector('.hoyo-settings-host').__gpController.getState().busy, 'HoYo readiness card');
  const start = () => host().querySelector('[data-hoyo-action="start"]'), resolve = () => host().querySelector('[data-hoyo-action="resolve-readiness"]');
  assert(blocked ? resolve() && start()?.disabled !== false : start() && !start().disabled, blocked ? 'HoYo old M keeps a reachable readiness entry' : 'HoYo ready state enables launch');
  assert(blocked ? host().textContent.includes('旧版 SR') : !host().textContent.includes('旧版 SR'), blocked ? 'HoYo old M reason is visible' : 'HoYo ready state clears the old M reason');
  if (blocked) {
    const outer = anyCard(); outer.querySelector('[data-hoyo-toggle]')?.click();
    await until(() => !host().querySelector('.hoyo-game-card.expanded') && anyCard()?.querySelector('.hoyo-header-action [data-hoyo-action="resolve-readiness"]'), 'collapsed HoYo readiness entry');
    const outerResolve = anyCard().querySelector('.hoyo-header-action [data-hoyo-action="resolve-readiness"]');
    assert(outerResolve && !outerResolve.disabled, 'collapsed HoYo readiness entry is actionable');
    outerResolve.click();
    await until(() => card() && host().querySelector('.hoyo-settings-host'), 'HoYo readiness card expansion');
    const settings = host().querySelector('.hoyo-settings-host');
    await until(() => settings.__gpController?.getState().tab === 'enhance' && settings.__gpController.getState().loaded.includes('enhancements') && settings.querySelector('[data-gp-action="preview-sr"]') && !settings.querySelector('[data-gp-action="preview-sr"]').disabled, 'HoYo settings owner tab');
    settings.querySelector('[data-gp-action="preview-sr"]').click();
    await until(() => settings.querySelector('.gp-modal') && !settings.__gpController.getState().busy, 'HoYo nested SR preview');
    assert(gp.plan?.request?.sr?.preset === 'M' && gp.calls.some(row => row[0] === 'preview'), 'HoYo readiness resolves into the shared SR preview path');
    assert(settings.querySelector('.gp-apply-bar'), 'HoYo screenshot contains the shared settings operation bar');
  } else {
    await until(() => card() && host().querySelector('.hoyo-settings-host'), 'HoYo ready editor');
    assert(host().querySelector('.hoyo-settings-host .gp-apply-bar'), 'HoYo screenshot contains the shared settings operation bar');
  }
  return { scope: 'readiness contract screenshot · HoYoPageUi + GamePageUi', assertionCount, readiness, launchDisabled: Boolean(start()?.disabled), entry: Boolean(resolve()) };
}

async function smokeTargetedHoYo() {
  const gp = window.__gpMock, mock = window.__hoyoMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertionCount = 0;
  const assert = (value, message) => { assertionCount++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 6500) => { const start = performance.now(); while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); } throw Error('Targeted HoYo UI timeout: ' + label); };
  const flow = mock.flow, game = gp.assessments['fixture-hoyo'], readiness = { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '旧版 SR 模型 M 仍有恢复记录，请先在超分设置中处理。', action: { kind: 'open-settings' }, recovery: true }], pending: [], requests: {}, legacy: { configured: true, effective: 'm' } };
  const launcher = flow.binding.launchers[0];
  flow.binding = { ...flow.binding, status: 'confirmed', launcher, channels: [{ channel: 'cn', channelLabel: '国服' }] };
  flow.channel = 'cn'; flow.channelLabel = '国服'; flow.api = { api: 'dx12', source: 'user', requiresConfirmation: false, evidence: [] };
  flow.installation = { installed: true, ready: true, needsRecovery: false, error: null }; flow.phase = 'ready'; flow.nextAction = 'start'; flow.error = null; flow.launchReadiness = structuredClone(readiness);
  game.game.installed = true; game.game.nativeDlssAvailable = true; game.game.feeder = null;
  game.game.chosen.apiResolution = { api: 'dx12', source: 'entry' }; game.game.chosen.detectedApiResolution = { api: 'dx12', source: 'entry' };
  game.api.effectiveApi = 'dx12'; game.api.detectedApi = 'dx12'; game.api.capabilities = ['dx12'];
  game.defaults = { ...game.defaults, deployment: 'external', loadingMode: 'helper' };
  game.layout = { ...game.layout, mode: 'external', loadingMode: 'helper', loadingBackend: 'hoyoshade', source: 'hoyoshade-profile', inputRoute: 'native' };
  game.deployment = { ...game.deployment, mode: 'external', loadingMode: 'helper', version: '0.4.7beta' };
  game.launch.readiness = structuredClone(readiness); game.nr = structuredClone(gp.baseline.nr);
  const secondGameId = 'fixture-hoyo-second', secondGame = structuredClone(game), secondFlow = structuredClone(flow);
  secondGame.gameId = secondGame.game.id = secondGameId; secondGame.game.name = '崩坏：星穹铁道 · 旧 M blocker';
  secondGame.game.chosen.path = 'C:\\UI-fixture\\StarRail\\StarRail-second.exe'; secondGame.game.dir = 'C:\\UI-fixture\\StarRail-second';
  secondGame.launch.readiness = structuredClone(readiness); secondGame.enhancements.launchReadiness = structuredClone(readiness);
  secondFlow.id = 'client-two'; secondFlow.gameId = secondGameId; secondFlow.name = '崩坏：星穹铁道 · 旧 M blocker'; secondFlow.exePath = secondGame.game.chosen.path; secondFlow.launchReadiness = structuredClone(readiness);
  mock.extraFlow = secondFlow; gp.assessments[secondGameId] = secondGame;
  document.querySelector('[data-view="hoyo"]').click();
  const workspace = () => document.getElementById('hoyoWorkspace'), anyCard = () => workspace()?.querySelector('.hoyo-game-card'), secondCard = () => workspace()?.querySelector('[data-hoyo-card="client-two"]'), expanded = () => workspace()?.querySelector('.hoyo-game-card.expanded'), settings = () => workspace()?.querySelector('.hoyo-settings-host'), controller = () => settings()?.__gpController;
  await until(() => anyCard() && settings() && controller(), 'HoYo shared editor');
  await until(() => controller().getState().loaded.includes('installation') && controller().getState().readiness?.state === 'blocked', 'HoYo metadata blocker');
  const ready = { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: {} };
  const aResolvedBefore = gp.calls.filter(row => row[0] === 'assess-resolved' && row[1] === 'fixture-hoyo').length;
  gp.assessments['fixture-hoyo'].launch.readiness = structuredClone(ready); gp.assessments['fixture-hoyo'].enhancements.launchReadiness = structuredClone(ready);
  gp.delays['fixture-hoyo:installation'] = 180; gp.delays['fixture-hoyo:enhancements'] = 220;
  controller().selectTab('enhance'); const delayedA = controller().refresh(true); await delay(25);
  await until(() => workspace().querySelector('[data-hoyo-card="client-two"]'), 'second HoYo card'); workspace().querySelector('[data-hoyo-card="client-two"] [data-hoyo-toggle="client-two"]')?.click();
  await until(() => expanded()?.dataset.hoyoCard === 'client-two' && settings() && controller().getState().id === secondGameId, 'switch to HoYo B while A responses are pending');
  await until(() => expanded().querySelector('[data-hoyo-action="resolve-readiness"]') && expanded().textContent.includes('旧版 SR'), 'B old-M blocker');
  await delayedA; await until(() => gp.calls.filter(row => row[0] === 'assess-resolved' && row[1] === 'fixture-hoyo').length >= aResolvedBefore + 2, 'A delayed readiness responses');
  assert(Boolean(expanded().querySelector('[data-hoyo-action="resolve-readiness"]')) && !expanded().querySelector('[data-hoyo-action="start"]') && expanded().textContent.includes('旧版 SR'), 'A ready response cannot promote selected B old-M blocker to start');
  gp.assessments[secondGameId].launch.readiness = structuredClone(ready); gp.assessments[secondGameId].enhancements.launchReadiness = structuredClone(ready);
  await controller().refresh(true); await until(() => controller().getState().readiness?.state === 'ready' && !controller().getState().busy, 'B editor ready baseline');
  mock.extraFlow = { ...mock.extraFlow, launchReadiness: structuredClone(readiness) }; gp.assessments[secondGameId].launch.readiness = structuredClone(readiness); gp.assessments[secondGameId].enhancements.launchReadiness = structuredClone(readiness);
  const discoverCallsBefore = mock.calls.filter(row => row[0] === 'discover').length, discoverButton = workspace().querySelector('.library-actions [data-hoyo-action="discover"]');
  assert(discoverButton && !discoverButton.disabled, 'same-client discover is available for the cached ready editor'); discoverButton.click();
  await until(() => mock.calls.filter(row => row[0] === 'discover').length === discoverCallsBefore + 1 && expanded()?.dataset.hoyoCard === 'client-two' && expanded().querySelector('[data-hoyo-action="resolve-readiness"]') && expanded().textContent.includes('旧版 SR'), 'same-client blocked discover');
  controller().selectTab('overview'); await until(() => controller().getState().tab === 'overview', 'same-client cached editor redraw');
  assert(Boolean(expanded().querySelector('[data-hoyo-action="resolve-readiness"]')) && !expanded().querySelector('[data-hoyo-action="start"]'), 'same-client blocked discover preserves the blocker over the cached ready editor');
  expanded().querySelector('[data-hoyo-action="resolve-readiness"]').click();
  await until(() => controller().getState().tab === 'enhance' && controller().getState().loaded.includes('enhancements') && settings().querySelector('[data-gp-action="preview-sr"]') && !settings().querySelector('[data-gp-action="preview-sr"]').disabled, 'new HoYo blocker refresh to SR');
  settings().querySelector('[data-gp-action="preview-sr"]').click(); await until(() => settings().querySelector('.gp-modal') && !controller().getState().busy, 'new HoYo blocker SR preview');
  assert(gp.plan.request.sr?.preset === 'M', 'new HoYo blocker reaches SR preview after refresh');
  settings().querySelector('[data-gp-action="modal-cancel"]').click(); settings().querySelector('[data-gp-action="discard"]')?.click(); await until(() => !controller().getState().draft.version, 'HoYo readiness preview discard');
  gp.delays['fixture-hoyo:installation'] = 0; gp.delays['fixture-hoyo:enhancements'] = 0;
  const version = () => settings()?.querySelector('[data-gp-group="route"][data-gp-field="version"]');
  controller().selectTab('overview'); await until(() => controller().getState().tab === 'overview' && version(), 'HoYo Core picker tab');
  const candidates = ['0.5-dline13', '0.4.7beta-corefix.8'];
  for (const id of candidates) {
    const option = [...(version()?.options || [])].find(row => row.value === id);
    assert(option && !option.disabled, id + ' is visible and selectable in the HoYo Core picker');
  }
  const selected = version(); selected.value = candidates[0]; selected.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => controller().getState().draft.version === candidates[0], 'HoYo Core draft');
  const previewBefore = gp.calls.filter(row => row[0] === 'preview').length;
  settings().querySelector('[data-gp-action="preview"]').click();
  await until(() => settings().querySelector('.gp-modal') && !controller().getState().busy, 'HoYo Core preview');
  assert(gp.calls.filter(row => row[0] === 'preview').length === previewBefore + 1, 'HoYo Core uses the shared preview operation');
  assert(gp.plan.request.version === candidates[0] && gp.plan.request.api === 'auto' && gp.plan.request.deployment === 'external' && gp.plan.request.loadingMode === 'helper', 'HoYo Core preview includes the external/helper version, API and deployment request');
  const corePreviewRequest = structuredClone(gp.plan.request);
  settings().querySelector('[data-gp-action="modal-cancel"]').click();
  settings().querySelector('[data-gp-action="discard"]')?.click(); await until(() => !controller().getState().draft.version, 'HoYo Core draft discard');
  secondCard().querySelector('[data-hoyo-toggle="client-two"]').click();
  await until(() => !expanded() && secondCard().querySelector('.hoyo-header-action [data-hoyo-action="resolve-readiness"]'), 'collapsed HoYo old-M entry');
  secondCard().querySelector('.hoyo-header-action [data-hoyo-action="resolve-readiness"]').click();
  await until(() => expanded() && settings() && controller().getState().tab === 'enhance' && controller().getState().loaded.includes('enhancements'), 'collapsed HoYo entry to SR owner');
  const sr = settings().querySelector('[data-gp-action="preview-sr"]'); assert(sr && !sr.disabled, 'collapsed HoYo entry exposes an enabled SR preview'); sr.click();
  await until(() => settings().querySelector('.gp-modal') && !controller().getState().busy, 'collapsed HoYo SR preview');
  assert(gp.plan.request.sr?.preset === 'M', 'collapsed HoYo entry reaches the real SR preview request');
  return { scope: 'targeted HoYo readiness/Core UI', assertionCount, candidates, corePreviewRequest, srPreviewRequest: structuredClone(gp.plan.request), collapsedResolveToSr: true };
}

async function smokeTargeted() {
  if (window.__hoyoMock) return smokeTargetedHoYo();
  const mock = window.__gpMock, delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let assertionCount = 0;
  const assert = (value, message) => { assertionCount++; if (!value) throw Error(message); };
  const until = async (predicate, label, timeout = 8000) => { const start = performance.now(); while (performance.now() - start < timeout) { if (predicate()) return; await delay(20); } throw Error('Targeted UI timeout: ' + label); };
  const card = id => document.querySelector(`.game-card[data-id="${id}"]`), host = () => document.querySelector('.game-card.expanded .game-detail.gp-inline'), state = () => host()?.__gpController.getState(), countLaunch = () => mock.calls.filter(row => row[0] === 'launch').length;
  await until(() => card('fixture')?.querySelector('.open-game-page-btn') && card('fixture-two')?.querySelector('.open-game-page-btn'), 'ordinary cards');
  card('fixture').querySelector('.open-game-page-btn').click(); await until(() => state()?.loaded.includes('installation') && !state().busy, 'ordinary installation');
  const controller = () => host().__gpController;
  const ready = { state: 'ready', known: true, source: 'settings-inspection', blockers: [], pending: [], requests: {} };
  mock.assessment.launch.readiness = structuredClone(ready); mock.assessment.enhancements.launchReadiness = structuredClone(ready);
  controller().selectTab('enhance'); await until(() => state().loaded.includes('enhancements') && state().readiness?.state === 'ready', 'ordinary ready enhancements');
  const blocked = { state: 'blocked', known: true, source: 'metadata', blockers: [{ domain: 'sr', code: 'SETTINGS_LEGACY_APPLY_REQUIRED', message: '新的 installation metadata 发现旧版 SR 需要处理。', action: { kind: 'open-settings' }, recovery: true }], pending: [], requests: {} };
  mock.assessment.launch.readiness = structuredClone(blocked); const blockedLaunches = countLaunch(); const blockedAttempt = controller().launchGame();
  await blockedAttempt; await until(() => !state().launching, 'metadata blocker launch gate');
  assert(state().readiness?.state === 'blocked' && countLaunch() === blockedLaunches, 'new installation metadata blocker wins over previously ready enhancements without launch');
  mock.assessment.launch.readiness = structuredClone(ready); mock.delays['fixture:installation'] = 90; await controller().refresh(true); await until(() => state().readiness?.state === 'ready' && !state().busy, 'fresh ready metadata');
  const beforeDouble = countLaunch(), first = controller().launchGame(), second = controller().launchGame();
  await delay(15); assert(state().launching === true && countLaunch() === beforeDouble, 'double click keeps one in-flight launch while metadata is pending');
  await Promise.all([first, second]); await until(() => !state().launching, 'double launch settled'); assert(countLaunch() === beforeDouble + 1, 'double click produces exactly one manager.launch');
  controller().selectTab('overview'); await until(() => state().tab === 'overview', 'ordinary overview for dirty race');
  const beforeDirty = countLaunch(), dirtyAttempt = controller().launchGame(); await until(() => state().launching, 'dirty race launch pending');
  const input = host().querySelector('[data-gp-group="nr"][data-gp-field="Intensity"]'); input.value = '0.8'; input.dispatchEvent(new Event('input', { bubbles: true })); await dirtyAttempt; await until(() => !state().launching, 'dirty race settled');
  assert(countLaunch() === beforeDirty && state().draft.nr?.Intensity === 0.8, 'new dirty draft cancels the waiting launch without a backend call');
  host().querySelector('[data-gp-action="discard"]')?.click(); await until(() => !state().draft.nr, 'dirty draft cleared');
  const beforeSwitch = countLaunch(), switchAttempt = controller().launchGame(); await until(() => state().launching, 'switch race launch pending');
  await controller().open('fixture-two', 'overview', { game: structuredClone(mock.assessments['fixture-two'].game) }); await until(() => state().id === 'fixture-two' && state().loaded.includes('installation') && !state().launching, 'new game controller state'); await switchAttempt;
  assert(countLaunch() === beforeSwitch && state().id === 'fixture-two' && !state().launching, 'switching game cancels the old launch and leaves no lock on the new game');
  mock.delays['fixture:installation'] = 0;
  return { scope: 'targeted ordinary readiness/race UI', assertionCount, launchCalls: countLaunch(), blockedLaunchCalls: blockedLaunches, switchedTo: state().id };
}

module.exports = { installMock, smoke, captureBaseline, captureReadiness, captureHoYoReadiness, smokeTargeted, smokeTargetedHoYo };
