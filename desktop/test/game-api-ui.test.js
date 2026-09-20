'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
const gamePageSource = fs.readFileSync(path.join(__dirname, '../src/renderer/game-page-ui.js'), 'utf8');
const operationApiSource = fs.readFileSync(path.join(__dirname, '../src/shared/api-resolution.js'), 'utf8');
const product = JSON.parse(fs.readFileSync(path.join(__dirname, '../product.json'), 'utf8'));

function runRouteHelpers(context, endMarker) {
  vm.runInContext(operationApiSource, context);
  vm.runInContext(source.slice(source.indexOf('function feederOwnsVulkan('), source.indexOf(endMarker)), context);
}

test('DXGI awaiting confirmation is never labeled temporarily unsupported', () => {
  const context = {}; vm.createContext(context);
  runRouteHelpers(context, 'function hardwareLabel(');
  context.game = { supported: false, installed: false, supportCode: 'ERR_API_SELECTION_REQUIRED' };
  const html = vm.runInContext('supportBadge(game)', context);
  assert.match(html, /API 待确认/); assert.doesNotMatch(html, /暂不支持/);
});

test('an unmanaged existing Core is visible before opening its required preview', () => {
  const context = { state: { expanded: null }, escapeHtml: String, inlineGameDetails: new Map(), window: { manager: { assessGame() {} } } }; vm.createContext(context);
  runRouteHelpers(context, 'function hardwareLabel(');
  vm.runInContext(source.slice(source.indexOf('function cardAction('), source.indexOf('const API_LABELS')), context);
  context.game = { supported: true, installed: false, existingInstallation: { detected: true } };
  assert.match(vm.runInContext('supportBadge(game)', context), /已有插件待确认/);
  const action = vm.runInContext('cardAction(game)', context);
  assert.match(action, /检查已有安装/); assert.doesNotMatch(action, /安装与设置/);
  assert.match(action, /unified-launch-btn[^>]*>应用/);
  assert.doesNotMatch(action, /rename-game-btn|>改名</);
});

test('modern cards offer Apply before installation and keep rename inside expanded advanced controls', () => {
  const context = { state: { expanded: null }, escapeHtml: String, inlineGameDetails: new Map(), window: { manager: { assessGame() {} } } }; vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function cardAction('), source.indexOf('const API_LABELS')), context);
  const html = vm.runInContext("cardAction({ installed:false, existingInstallation:{detected:false} })", context);
  assert.match(html, /^<button[^>]*unified-launch-btn[^>]*>应用<\/button><button[^>]*open-game-page-btn[^>]*>安装与设置<\/button>$/);
  assert.match(gamePageSource, /act\('rename-game', '修改游戏名称'/);
  assert.match(source, /onRename: gameId => confirmRenameGame\(gameId\)/);
});

function uiContext() {
  const context = { escapeHtml: String, state: { addons: [], payload: {
    selectedVersion: '0.4.6-hotfix.1',
    versions: { '0.2.0-beta.2': {}, '0.3.3.5': {}, '0.4.6-hotfix.1': {} },
    bundle: { supersededVersions: { '0.4.6': '0.4.6-hotfix.1' } }
  } } };
  vm.createContext(context);
  vm.runInContext(operationApiSource, context);
  vm.runInContext(source.slice(source.indexOf('function coreVersionLabel('), source.indexOf('function poster(')), context);
  vm.runInContext(source.slice(source.indexOf('const API_LABELS'), source.indexOf('function gameDetail(')), context);
  runRouteHelpers(context, 'function hardwareLabel(');
  return context;
}

test('automatic API label retains detection while a manual override controls the route', () => {
  const context = uiContext();
  context.game = { apiOverride: 'dx11', chosen: { path: 'C:/Games/Current.exe', detectedApi: 'dx12',
    detectedApiResolution: { api: 'dx12', source: 'imports', evidence: ['d3d12.dll'] },
    apiResolution: { api: 'dx11', source: 'override' } } };
  let html = vm.runInContext('apiControls(game)', context);
  assert.match(html, /value="auto">DX12（自动）/);
  assert.match(html, /value="dx11" selected/);
  assert.match(html, /兼容桥接随 DirectX 11 自动部署/);
  assert.match(html, /检测线索：d3d12\.dll/);
  assert.match(html, /不会替你修改游戏启动参数/);
  assert.match(html, /选择绑定当前 EXE 保存，重新扫描不会覆盖/);
  assert.match(html, /<details class="api-help">/); assert.doesNotMatch(html, /<details[^>]*open/);
  assert.doesNotMatch(html, /carrier-component-check/);
  context.game.chosen.detectedApiResolution = { api: 'unknown', source: 'none', evidence: [] };
  html = vm.runInContext('apiControls(game)', context);
  assert.match(html, /value="auto">API 待确认（自动）/);
  assert.match(html, /value="dx11" selected/);
  delete context.game.chosen.detectedApiResolution; delete context.game.chosen.detectedApi;
  assert.match(vm.runInContext('apiControls(game)', context), /value="auto">API 待确认（自动）/);
  context.game = { apiOverride: 'dx12', chosen: { detectedApiResolution: { api: 'dx11' }, apiResolution: { api: 'dx12', source: 'override' } } };
  html = vm.runInContext('apiControls(game)', context);
  assert.match(html, /value="auto">DX11 桥接（自动）/);
  assert.match(html, /value="dx12" selected/);
  assert.match(html, /DirectX 12 无需兼容桥接/);
  const optionValues = [...html.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(optionValues, ['auto', 'dx12', 'dx11', 'vulkan', 'dx10', 'dx9', 'opengl']);
  assert.equal(vm.runInContext('gameApiLabel(game.chosen)', context), 'DX12（已指定）');
  context.game.chosen.apiResolution = { api: 'dx11', source: 'imports' };
  assert.equal(vm.runInContext('gameApiLabel(game.chosen)', context), 'DX11 桥接（自动）');
});

test('manual API choices retain their names and unsupported NR routes do not offer a bridge switch', () => {
  const context = uiContext();
  for (const [api, label] of [['dx9', 'DirectX 9'], ['dx10', 'DirectX 10'], ['vulkan', 'Vulkan'], ['opengl', 'OpenGL']]) {
    context.game = { apiOverride: api, chosen: { detectedApi: 'dx12', apiResolution: { api, source: 'override' } } };
    const html = vm.runInContext('apiControls(game)', context);
    assert.ok(html.includes(`value="${api}" selected`));
    assert.match(html, api === 'vulkan' ? /Vulkan 试验桥接当前不可用/ : /当前 API 暂不支持 NR，不部署兼容桥接/);
    assert.equal(vm.runInContext('gameApiLabel(game.chosen)', context), `${label}（已指定）`);
    for (const choice of ['auto', 'dx9', 'dx10', 'dx11', 'dx12', 'vulkan', 'opengl']) assert.ok(html.includes(`value="${choice}"`));
  }
  assert.doesNotMatch(source, /carrier-component-check|carrier-save-btn|setGameCarrier/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), /game-carrier-set/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), /game-carrier-set|setGameCarrier/);
});

test('one application submits the selected API and Core together without replacing the EXE', async () => {
  const context = uiContext(), calls = [];
  context.state.installing = new Set(); context.setInstallBusy = () => {};
  context.state.payload.versions['0.4.7beta'] = {}; context.state.payload.selectedVersion = '0.4.7beta';
  context.window = { manager: { prepareGame: (...args) => { calls.push(args); return { ok: true, value: { installed: true } }; } } };
  context.runConfirmedAction = work => work(true);
  context.game = { id: 'current-game', chosen: { path: 'C:/Games/Chosen.exe', detectedApiResolution: { api: 'dx12' } }, vulkan: { packageId: 'fixed-vulkan-r5', coreVersion: '0.4.6-hotfix.1', available: true } };
  for (const api of ['auto', 'dx11', 'dx12', 'vulkan']) {
    context.patch = { api }; vm.runInContext('updateRouteDraft(game, patch)', context);
    await vm.runInContext('applyCardRoute(game)', context);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['current-game', { api, version: api === 'vulkan' ? 'fixed-vulkan-r5' : '0.4.7beta', route: 'native', allowAntiCheat: true }]);
    assert.equal(context.game.chosen.path, 'C:/Games/Chosen.exe'); assert.equal(context.state.routeDrafts.size, 0);
  }
  assert.doesNotMatch(source, /api-save-btn|version-apply-btn|window\.manager\.setGameApi/);
});

test('known multiple-API games show their supported choices and a stable Vulkan label with saved-game synchronization', () => {
  const context = uiContext();
  context.game = { apiOverride: 'auto', chosen: { supportedApis: ['vulkan', 'dx12'],
    apiSettings: { kind: 'rdr2-system-xml', canSync: true },
    detectedApiResolution: { api: 'vulkan', source: 'game-settings' }, apiResolution: { api: 'vulkan' } }, vulkan: { available: false } };
  const before = vm.runInContext('apiControls(game)', context);
  assert.deepEqual([...before.matchAll(/<option value="([^"]+)"/g)].map(row => row[1]), ['auto', 'dx12', 'vulkan']);
  assert.match(before, /value="vulkan">Vulkan<\/option>/);
  assert.match(before, /会同步游戏设置/);
  context.game.vulkan.available = true;
  const after = vm.runInContext('apiControls(game)', context);
  assert.match(after, /value="vulkan">Vulkan<\/option>/);
  assert.doesNotMatch(after, /Vulkan（当前不可用）|Vulkan（试验版）/);
});

test('an unknown or mixed API draft uses Vulkan selection readiness without the saved-route rejection', () => {
  const context = uiContext(); context.state.installing = new Set();
  runRouteHelpers(context, 'function supportBadge(');
  vm.runInContext(source.slice(source.indexOf('function cardAction('), source.indexOf('const API_LABELS')), context);
  for (const api of ['unknown', 'mixed']) {
    context.game = { id: api, installed: false, apiOverride: 'auto', chosen: { path: `C:/Fixture/${api}.exe`,
      detectedApiResolution: { api }, apiResolution: { api } }, vulkan: { coreVersion: '0.4.7beta', packageId: 'fixed-beta047-fixture',
      available: false, reason: '当前路线尚未确认为 Vulkan', selectionAvailable: true, selectionReason: '' } };
    vm.runInContext("updateRouteDraft(game, { api: 'vulkan' })", context);
    const html = vm.runInContext('routeControlsMarkup(game)', context);
    assert.match(html, /可准备/); assert.match(html, /0\.4\.7beta · Vulkan 桥接/);
    assert.doesNotMatch(html, /当前路线尚未确认为 Vulkan|Vulkan 试验桥接当前不可用/);
    assert.match(html, /route-apply-btn[^>]*data-base-disabled="false"/);
    assert.match(vm.runInContext('cardAction(game)', context), /install-btn/);
    assert.equal(context.game.apiOverride, 'auto'); assert.equal(context.game.chosen.apiResolution.api, api);
  }
});

test('Vulkan hard selection blockers disable apply and collapsed install without submitting IPC', async () => {
  const context = uiContext(), calls = []; context.state.installing = new Set();
  context.window = { manager: { applyGameRoute: (...args) => calls.push(args) } };
  runRouteHelpers(context, 'function supportBadge(');
  vm.runInContext(source.slice(source.indexOf('function cardAction('), source.indexOf('const API_LABELS')), context);
  for (const reason of ['Vulkan 配套文件缺失', '当前只支持 RTX 50', '需要先恢复配套']) {
    context.game = { id: reason, installed: false, chosen: { path: 'C:/Fixture/Blocked.exe', detectedApiResolution: { api: 'mixed' } },
      vulkan: { available: true, reason: '旧路线信息', selectionAvailable: false, selectionReason: reason,
        coreVersion: '0.4.7beta', packageId: 'fixed-beta047-fixture', needsRecovery: reason === '需要先恢复配套' } };
    vm.runInContext("updateRouteDraft(game, { api: 'vulkan' })", context);
    const html = vm.runInContext('routeControlsMarkup(game)', context);
    assert.ok(html.includes(reason)); assert.doesNotMatch(html, /旧路线信息/);
    assert.match(html, /route-apply-btn[^>]* disabled/);
    assert.doesNotMatch(vm.runInContext('cardAction(game)', context), /install-btn/);
    assert.equal(await vm.runInContext('applyCardRoute(game)', context), false);
  }
  assert.deepEqual(calls, []);
});

test('an unreadable RDR2 settings file keeps API selection manual without claiming game-settings sync', () => {
  const context = uiContext();
  context.game = { apiOverride: 'auto', chosen: { supportedApis: ['vulkan', 'dx12'],
    apiSettings: { kind: 'rdr2-system-xml', canSync: false },
    detectedApiResolution: { api: 'unknown', source: 'game-settings' }, apiResolution: { api: 'unknown' } } };
  const html = vm.runInContext('apiControls(game)', context);
  assert.match(html, /选择只配置插件路线/);
  assert.match(html, /不会改写游戏设置/);
  assert.doesNotMatch(html, /会同步游戏设置|点击保存后同步/);
});

test('game refresh restores the focused API action at the same viewport position', () => {
  const view = { scrollTop: 400, classList: { contains: value => value === 'active' } };
  const oldButton = { getClientRects: () => [1], getBoundingClientRect: () => ({ top: 420 }), matches: selector => selector === '.route-apply-btn' };
  const newButton = { focused: null, getClientRects: () => [1], getBoundingClientRect: () => ({ top: 980 - view.scrollTop }), focus(options) { this.focused = options; } };
  const head = { getClientRects: () => [1], getBoundingClientRect: () => ({ top: 250 }) };
  const card = button => ({ dataset: { id: 'middle-game' }, contains: node => node === button,
    querySelector: selector => selector === '.route-apply-btn' ? button : selector === '.game-card-head' ? head : null });
  let current = card(oldButton);
  const context = { state: { expanded: 'middle-game' }, $: id => id === 'view-games' ? view : null,
    document: { activeElement: oldButton, querySelectorAll: selector => selector === '.game-card' ? [current] : [] },
    requestAnimationFrame: callback => callback() };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/api-resolution.js"), "utf8"), context);
  vm.runInContext(source.slice(source.indexOf('function captureGameViewAnchor('), source.indexOf('function visualKey(')), context);
  const saved = vm.runInContext('captureGameViewAnchor()', context);
  current = card(newButton);
  context.saved = saved;
  vm.runInContext('restoreGameViewAnchor(saved)', context);
  assert.equal(view.scrollTop, 560);
  assert.equal(newButton.focused?.preventScroll, true);
  assert.equal(newButton.getBoundingClientRect().top, 420);
});

test('game cards keep rename available and show a real pending install state', () => {
  const context = uiContext();
  context.state.installing = new Set(); context.payloadReadyForHardware = () => true;
  vm.runInContext(source.slice(source.indexOf('function cardAction('), source.indexOf('const API_LABELS')), context);
  context.game = { id: 'game-1', installed: false, supported: true };
  let html = vm.runInContext('cardAction(game)', context);
  assert.match(html, /rename-game-btn/);
  assert.match(html, /一键安装/);
  assert.doesNotMatch(html, /正在安装/);
  context.state.installing.add('game-1');
  html = vm.runInContext('cardAction(game)', context);
  assert.match(html, /rename-game-btn/);
  assert.match(html, /disabled/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /button-spinner/);
  assert.match(html, /正在安装/);
  assert.doesNotMatch(html, /\d+%/);
  assert.doesNotMatch(source, /window\.prompt/);
  const render = source.slice(source.indexOf('function renderGames('), source.indexOf('function captureGameViewAnchor('));
  assert.match(render, /class="game-exe-path" title="\$\{escapeHtml\(game\.chosen\.path\)\}"/);
  const markup = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  assert.match(markup, /id="renameGameInput"/);
});

test('Vulkan uses its fixed package and retains a read-only-capable graphics panel for scoped restoration', () => {
  const context = { escapeHtml: String, state: { installing: new Set(), addons: [], payload: { selectedVersion: 'ordinary-core', versions: { 'ordinary-core': {} } }, detailTabs: new Map() },
    payloadReadyForHardware: () => false, hardwareLabel: () => 'RTX 50' };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/api-resolution.js"), "utf8"), context);
  runRouteHelpers(context, 'function renderGames(');
  context.game = { id: 'vk-game', name: 'VK', installed: true, supported: false, nativeDlssAvailable: false, nativeFgAvailable: false,
    chosen: { path: 'C:/Games/VK.exe', bitness: 64, apiResolution: { api: 'vulkan', source: 'override' } },
    vulkan: { available: true, installed: true, coreVersion: '0.4.6-hotfix.1-vulkan-provider', packageId: 'nr-vulkan-e7df0fc', experimental: true } };
  const html = vm.runInContext('gameDetail(game)', context);
  assert.ok(html.indexOf('游戏图形 API') < html.indexOf('Vulkan 使用按游戏保存的独立配套'));
  assert.match(html, /0\.4\.6-hotfix\.1 · Beta · Vulkan 桥接/);
  assert.match(html, /value="nr-vulkan-e7df0fc" selected/);
  assert.equal(vm.runInContext('vulkanVersionOption(game)', context), '<option value="nr-vulkan-e7df0fc" selected>0.4.6-hotfix.1 · Beta · Vulkan 桥接</option>');
  assert.doesNotMatch(html, /value="ordinary-core"/);
  assert.match(html, /通过画面和深度估算运动/);
  assert.match(html, /未检测到游戏自带的 DLSS/);
  assert.match(html, /launch-settings-host/); assert.doesNotMatch(html, /调整超分补帧|d3d12-btn|使用 D3D12 兼容修复/);
  assert.match(vm.runInContext('cardAction(game)', context), /启动游戏/);
  context.game.vulkan.coreVersion = '0.4.7beta'; context.game.vulkan.packageId = 'nr-vulkan-beta047-fixture';
  assert.equal(vm.runInContext('vulkanVersionOption(game)', context), '<option value="nr-vulkan-beta047-fixture" selected>0.4.7beta · Vulkan 桥接</option>');
  assert.match(vm.runInContext('vulkanRouteMarkup(game)', context), /当前核心为 0\.4\.7beta/);
  assert.doesNotMatch(vm.runInContext('vulkanVersionOption(game)', context), /0\.4\.6|Beta · Vulkan/);
  context.game = { id: 'dx-game', installed: true, supported: true, addonVersion: 'ordinary-core', nativeDlssAvailable: true,
    chosen: { path: 'C:/Games/DX.exe', bitness: 64, apiResolution: { api: 'dx12', source: 'override' } } };
  assert.match(vm.runInContext('gameDetail(game)', context), /d3d12-btn|使用 D3D12 兼容修复/);
});

test('unavailable Vulkan gives the backend reason and cannot render an install action', () => {
  const context = { escapeHtml: value => String(value).replaceAll('<', '&lt;'), state: { installing: new Set(), addons: [], payload: null, detailTabs: new Map() },
    payloadReadyForHardware: () => true, hardwareLabel: () => 'RTX 50' };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/api-resolution.js"), "utf8"), context);
  runRouteHelpers(context, 'function renderGames(');
  context.game = { id: 'vk-missing', installed: false, supported: true, nativeDlssAvailable: false,
    chosen: { path: 'C:/Games/VK.exe', bitness: 64, apiResolution: { api: 'vulkan', source: 'override' } },
    vulkan: { available: false, installed: false, coreVersion: '0.4.6-hotfix.1-vulkan-provider', packageId: 'nr-vulkan-e7df0fc', reason: '固定运行资产<缺失>', experimental: true } };
  const html = vm.runInContext('gameDetail(game)', context);
  assert.match(html, /固定运行资产&lt;缺失>/);
  assert.doesNotMatch(html, /固定运行资产<缺失>/);
  assert.match(vm.runInContext('supportBadge(game)', context), /Vulkan 暂不可用/);
  const action = vm.runInContext('cardAction(game)', context);
  assert.match(action, /disabled>Vulkan 暂不可用/); assert.doesNotMatch(action, /install-btn|payload-open-btn/);
  Object.assign(context.game.vulkan, { installed: true, needsRecovery: true, reason: '旧 Vulkan 运行路径过长，请先卸载插件后重新安装。' });
  const recoveryAction = vm.runInContext('cardAction(game)', context);
  assert.match(recoveryAction, /card-open">恢复配套/); assert.doesNotMatch(recoveryAction, /launch-btn|install-btn/);
  assert.match(vm.runInContext('supportBadge(game)', context), /Vulkan 需恢复/);
  const recoveryDetail = vm.runInContext('gameDetail(game)', context);
  assert.match(recoveryDetail, /旧 Vulkan 运行路径过长/);
  assert.match(recoveryDetail, /卸载插件/);
  assert.match(vm.runInContext('vulkanRouteMarkup(game)', context), /badge bad">需恢复/);
  context.game.installed = true;
  context.game.chosen.apiResolution = { api: 'dx11', source: 'override' };
  const rolledBackApi = vm.runInContext('cardAction(game)', context);
  assert.match(rolledBackApi, /card-open">恢复配套/);
  assert.doesNotMatch(rolledBackApi, /launch-btn|install-btn/);
});

test('collapsed Vulkan install passes the exact package ID and maintenance opens its single entry', async () => {
  const calls = [], head = {}, install = {}, repair = {};
  const game = { id: 'vk-game', chosen: { apiResolution: { api: 'vulkan' } }, vulkan: { packageId: 'nr-vulkan-e7df0fc', available: true } };
  const card = { dataset: { id: game.id }, querySelector: selector => ({ '.game-card-head': head, '.install-btn': install, '.maintenance-inline-btn': repair })[selector] || null };
  const context = uiContext(); Object.assign(context, { document: { querySelectorAll: selector => selector === '#gameList .game-card' ? [card] : [] },
    window: { manager: { prepareGame: (...args) => { calls.push(['prepare', ...args]); return { ok: true, value: {} }; } } },
    setInstallBusy() {}, runConfirmedAction: work => Promise.resolve(work(true)), openMaintenance: id => calls.push(['maintenance', id]), confirmRenameGame() {}, confirmDismissGame() {}, confirmUninstall() {} });
  context.state.games = [game]; context.state.installing = new Set();
  runRouteHelpers(context, 'function supportBadge(');
  vm.runInContext(source.slice(source.indexOf('function bindGameCards('), source.indexOf('async function loadExpanded(')), context);
  vm.runInContext('bindGameCards()', context);
  install.onclick({ stopPropagation() {} }); repair.onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['prepare', 'vk-game', { api: 'auto', version: 'nr-vulkan-e7df0fc', route: 'native', allowAntiCheat: true }],
    ['maintenance', 'vk-game']
  ]);
});

test('install busy state updates only the existing button and restores it', () => {
  const button = {
    disabled: false,
    innerHTML: '一键安装',
    attributes: {},
    classList: { values: new Map(), toggle(name, value) { this.values.set(name, value); } },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
  const card = { dataset: { id: 'game-1' }, querySelector: selector => selector === '.install-btn' ? button : null };
  const context = {
    state: { installing: new Set() },
    document: { querySelectorAll: selector => selector === '.game-card' ? [card] : [] }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/api-resolution.js"), "utf8"), context);
  vm.runInContext(source.slice(source.indexOf('function setInstallBusy('), source.indexOf('function supportBadge(')), context);
  vm.runInContext("setInstallBusy('game-1', true)", context);
  assert.equal(button.disabled, true);
  assert.match(button.innerHTML, /button-spinner/);
  assert.match(button.innerHTML, /正在安装/);
  assert.equal(button.attributes['aria-busy'], 'true');
  vm.runInContext("setInstallBusy('game-1', false)", context);
  assert.equal(button.disabled, false);
  assert.equal(button.innerHTML, '一键安装');
  assert.equal(button.attributes['aria-busy'], 'false');
  assert.equal(context.state.installing.has('game-1'), false);
});

test('rename modal saves entered names and cancel leaves the manager untouched', async () => {
  const classList = () => ({ hidden: true, add() { this.hidden = true; }, remove() { this.hidden = false; } });
  const elements = {
    modal: { classList: classList() }, modalTitle: { textContent: '' }, modalBody: { textContent: '' },
    renameGameLine: { classList: classList() }, renameGameInput: { value: '', focus() {}, select() {} },
    removeSettingsLine: { classList: classList() }, removeSettingsCheck: { checked: false },
    modalConfirm: { textContent: '', disabled: false, onclick: null, classList: classList(), click() { return this.onclick?.(); } },
    modalCancel: { onclick: null }
  };
  const calls = [], notices = [];
  const context = {
    state: { pendingModal: null, games: [{ id: 'game-1', name: '旧名称', chosen: { path: 'C:/Games/Game.exe' } }] },
    $: id => elements[id], requestAnimationFrame: callback => callback(), toast: (message, error) => notices.push({ message, error }),
    document: { addEventListener() {} },
    window: { manager: { renameGame: async (...args) => { calls.push(args); return { ok: true, value: [] }; } } },
    runAction: async work => work()
  };
  context.showOverlay = element => element?.classList.remove('is-closing', 'hidden');
  context.hideOverlay = element => element?.classList.add('hidden');
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/shared/api-resolution.js"), "utf8"), context);
  vm.runInContext(source.slice(source.indexOf('function confirmRenameGame('), source.indexOf('async function dismissGameFromList(')), context);
  vm.runInContext(source.slice(source.indexOf('function closeModal('), source.indexOf('function switchView(')), context);
  vm.runInContext(source.slice(source.indexOf("$('modalCancel').onclick = closeModal;"), source.indexOf("$('minBtn').onclick")), context);

  vm.runInContext("confirmRenameGame('game-1')", context);
  assert.equal(context.state.pendingModal.type, 'rename-game');
  assert.equal(elements.renameGameInput.value, '旧名称');
  assert.equal(elements.renameGameLine.classList.hidden, false);
  assert.match(elements.modalBody.textContent, /API\/EXE/);
  elements.renameGameInput.value = '新名称';
  await elements.modalConfirm.onclick();
  assert.deepEqual(calls, [['game-1', '新名称']]);
  assert.equal(context.state.pendingModal, null);
  assert.equal(elements.renameGameLine.classList.hidden, true);

  vm.runInContext("confirmRenameGame('game-1')", context);
  elements.renameGameInput.value = '取消后的名称';
  elements.modalCancel.onclick();
  assert.deepEqual(calls, [['game-1', '新名称']]);
  assert.equal(context.state.pendingModal, null);
  assert.equal(notices.length, 0);
});

test('retired catalog selection offers its replacement while preserving the actual installed version', () => {
  const context = uiContext();
  assert.equal(vm.runInContext("coreVersionLabel('0.2.0-beta.2')", context), '0.2.0');
  assert.equal(vm.runInContext("coreVersionLabel('0.3.3.5')", context), '0.3.3.5 · 历史对照');
  assert.equal(vm.runInContext("coreVersionLabel('0.4.6-hotfix.1')", context), '0.4.6-hotfix.1 · Beta');
  context.game = { installed: true, addonVersion: '0.4.6' };
  const html = vm.runInContext('addonVersionRow(game, true)', context);
  assert.match(html, /已安装：0\.4\.6 · Beta/);
  assert.match(html, /可更新为 0\.4\.6-hotfix\.1 · Beta/);
  assert.match(html, /点击“应用设置”后才会更换核心/);
  assert.match(html, /value="0\.4\.6" selected disabled/);
  assert.doesNotMatch(html, /value="0\.4\.6-hotfix\.1" selected/);
  assert.equal(context.game.addonVersion, '0.4.6');
  assert.match(vm.runInContext("actionSuccessMessage('修复完成', {payloadReplacement:{from:'0.4.6',to:'0.4.6-hotfix.1'}})", context), /已应用替代核心 0\.4\.6-hotfix\.1/);
  assert.equal(vm.runInContext("actionSuccessMessage('修复完成', {})", context), '修复完成');
  const installer = fs.readFileSync(path.join(__dirname, '../src/product/installer.js'), 'utf8');
  vm.runInContext(installer.slice(installer.indexOf('const coreVersionText'), installer.indexOf('const { scanConflicts')), context);
  assert.equal(vm.runInContext("coreVersionText('0.2.0-beta.2')", context), '0.2.0');
  assert.equal(vm.runInContext("coreVersionText('0.3.3.5')", context), '0.3.3.5 · 历史对照');
});

test('product metadata exposes the second QQ group number', () => {
  assert.equal(product.qqGroup, '392308850');
});

test('a lost imported source remains visibly selected instead of masquerading as the default core', () => {
  const context=uiContext();context.game={installed:true,addonVersion:'imported-123456789abc'};
  const html=vm.runInContext('addonVersionRow(game,true)',context);
  assert.match(html,/value="imported-123456789abc" selected disabled/);
  assert.match(html,/原安装源不可用/);assert.doesNotMatch(html,/value="0\.4\.6-hotfix\.1" selected/);
});


test('runtime evidence awaiting verification is neutral and distinct from a broken installation', () => {
  const context = { escapeHtml: value => String(value) }; vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function diagnosticRows('), source.indexOf('async function loadRepairDiagnostic(')), context);
  context.rows = [{label:'Runtime',ok:null,detail:'待验证'},{label:'Binary',ok:true},{label:'Broken',ok:false}];
  const html=vm.runInContext('diagnosticRows(rows)',context);
  assert.match(html,/diag-icon pending">○/);assert.match(html,/diag-icon bad">×/);assert.match(html,/1 项文件检查通过/);
});

test('manual DX12 Feeder selection uses candidate eligibility and submits the selected API', async () => {
  const context=uiContext(),calls=[];
  vm.runInContext(source.slice(source.indexOf('function cardAction('),source.indexOf('const API_LABELS')),context);
  runRouteHelpers(context, 'function hardwareLabel(');
  context.state.installing=new Set();context.setInstallBusy=()=>{};context.runConfirmedAction=work=>work(true);
  context.window={manager:{prepareGame:(...args)=>{calls.push(args);return {ok:true,value:{prepared:true}};}}};
  context.game={id:'unknown-feeder',nativeDlssAvailable:false,nativeFgAvailable:false,chosen:{path:'C:/Games/Old.exe',bitness:64,apiResolution:{api:'unknown'},detectedApiResolution:{api:'unknown'}},
    feeder:{available:false,reason:'current API unknown',selectionAvailable:true,selectionReason:'',coreVersion:'0.4.7beta'}};
  vm.runInContext("updateRouteDraft(game,{api:'dx12'})",context);
  assert.match(vm.runInContext('routeApplyRow(game)',context),/data-base-disabled="false"/);
  assert.match(vm.runInContext('cardAction(game)',context),/install-btn/);
  await vm.runInContext('applyCardRoute(game)',context);
  assert.equal(calls[0][1].api,'dx12');assert.equal(calls[0][1].route,'feeder');
  context.game.feeder.selectionAvailable=false;context.game.feeder.selectionReason='hardware blocked';
  vm.runInContext("updateRouteDraft(game,{api:'dx12'})",context);
  assert.match(vm.runInContext('routeApplyRow(game)',context),/data-base-disabled="true"/);
  assert.match(vm.runInContext('cardAction(game)',context),/disabled>Feeder/);
  assert.equal(await vm.runInContext('applyCardRoute(game)',context),false);assert.equal(calls.length,1);
});

test('a Feeder recovery card exposes its dedicated owner action instead of launch', async () => {
  const context=uiContext(),button={},calls=[];
  vm.runInContext(source.slice(source.indexOf('function cardAction('),source.indexOf('const API_LABELS')),context);
  context.game={id:'pending-feeder',installed:true,feeder:{installed:true,needsRecovery:true},chosen:{apiResolution:{api:'dx12'}}};
  runRouteHelpers(context, 'function hardwareLabel(');
  const html=vm.runInContext('cardAction(game)',context);assert.match(html,/恢复并卸载 Feeder/);assert.doesNotMatch(html,/launch-btn|install-btn/);
  context.card={querySelector:selector=>selector==='.feeder-recover-btn'?button:null};
  context.window={manager:{restoreFeeder:id=>{calls.push(id);return {ok:true,value:{restored:true}};}}};context.runAction=work=>work();
  vm.runInContext('bindCardHeaderActions(card,game)',context);await button.onclick({stopPropagation(){}});
  assert.deepEqual(calls,['pending-feeder']);
});

for (const scenario of [
  { name: 'native DLSS', detected: 'unknown', api: 'dx12', nativeDlss: true, present: false, route: 'native' },
  { name: 'D16 Present', detected: 'unknown', api: 'dx12', nativeDlss: false, present: true, route: 'native' },
  { name: 'DX11 override', detected: 'dx12', api: 'dx11', nativeDlss: false, present: true, route: 'feeder' }
]) test(`card route submission keeps the selected API and Core capability for ${scenario.name}`, async () => {
  const context = uiContext(), calls = [];
  context.state.payload.versions['0.4.6-hotfix.1'].supportsPresent = scenario.present;
  context.state.installing = new Set(); context.setInstallBusy = () => {};
  context.runConfirmedAction = work => work(true);
  context.window = { manager: { prepareGame: (...args) => { calls.push(args); return { ok: true, value: { prepared: true } }; } } };
  context.game = { id: scenario.name, nativeDlssAvailable: scenario.nativeDlss,
    chosen: { path: 'C:/Fixture/Game.exe', bitness: 64, apiResolution: { api: scenario.detected }, detectedApiResolution: { api: scenario.detected } },
    feeder: { available: false, selectionAvailable: false } };
  context.selectedApi = scenario.api;
  vm.runInContext('updateRouteDraft(game, {api: selectedApi})', context);
  await vm.runInContext('applyCardRoute(game)', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].api, scenario.api);
  assert.equal(calls[0][1].route, scenario.route);
});
