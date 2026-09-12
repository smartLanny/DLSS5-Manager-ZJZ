'use strict';
// Real renderer, hidden software-only Electron window, mock IPC throughout.
// No real game, registry, runtime binary or user configuration is accessed.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'game-route-ui-'));
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
const harness = fs.readFileSync(path.join(__dirname, 'launch-settings-frontend.electron.cjs'), 'utf8');
const installMock = harness.slice(harness.indexOf('function installMock()'), harness.indexOf('async function smoke()'));
const preload = path.join(temporary, 'preload.cjs');
fs.writeFileSync(preload, `${installMock}\ninstallMock();\n(${function routeMock() {
  const ok = value => ({ ok: true, value: structuredClone(value) });
  const mock = window.__routeMock = { games: null, calls: [], methods: [], resolve: null, nrResolve: null, holdNr: false, lists: 0 };
  const boot = window.manager.boot, readNr = window.manager.readNr;
  const vk = { packageId: 'nr-vulkan-sdr-r5-20260909', coreVersion: '0.4.6-hotfix.1', available: false, installed: false, selectionAvailable: true, selectionReason: '' };
  window.manager.boot = async () => {
    const result = await boot(), seed = result.value.games[0];
    const variants = { RTX40: { ready: true, files: [] }, RTX50: { ready: true, files: [] } };
    result.value.payload.versions = { '0.4.7beta': { label: 'beta0.4.7', variants }, '0.3.3-dev-r4': { label: '0.3.3.4', variants } };
    result.value.hardware = { family: 'RTX50', series: ['RTX50'], names: ['Fixture RTX 50'], source: 'fixture' };
    result.value.payload.selectedVersion = '0.4.7beta'; result.value.settings.addonVersion = '0.4.7beta';
    result.value.payload.supersededVersions = { '0.4.6-hotfix.1': '0.4.7beta' };
    const chosen = { ...seed.chosen, path: 'C:/Fixture/Native/Game.exe', bitness: 64,
      apiResolution: { api: 'dx12', source: 'fixture' }, detectedApiResolution: { api: 'dx12', source: 'fixture', evidence: [] } };
    mock.games = [
      { ...seed, id: 'route-installed', name: 'API 与核心共同应用', dir: 'C:/Fixture/Native', installed: true, addonVersion: '0.4.6-hotfix.1', supported: true, chosen, apiOverride: 'auto', vulkan: { ...vk } },
      { ...seed, id: 'route-new', name: 'RDR2 草稿测试', dir: 'C:/Fixture/RDR2', installed: false, addonVersion: null, supported: true, apiOverride: 'auto',
        chosen: { ...chosen, path: 'C:/Fixture/RDR2/RDR2.exe', supportedApis: ['vulkan', 'dx12'], apiSettings: { kind: 'rdr2-system-xml', api: 'dx12', canSync: true } }, vulkan: { ...vk } },
      { ...seed, id: 'route-default', name: '默认安装测试', dir: 'C:/Fixture/Default', installed: false, addonVersion: null, supported: true, apiOverride: 'auto', chosen: { ...chosen, path: 'C:/Fixture/Default/Game.exe' }, vulkan: { ...vk } },
      { ...seed, id: 'route-recovery', name: '旧 Vulkan 恢复测试', dir: 'C:/Fixture/Recovery', installed: true, supported: false, apiOverride: 'vulkan',
        chosen: { ...chosen, path: 'C:/Fixture/Recovery/Game.exe', apiResolution: { api: 'vulkan', source: 'override' } },
        vulkan: { ...vk, installed: true, needsRecovery: true, selectionAvailable: false, selectionReason: '旧 Vulkan 运行路径过长。', reason: '旧 Vulkan 运行路径过长。请先在设置中点击“卸载插件”，再用新版管理器重新安装；新配套会自动使用短目录。' } },
      ...['mixed', 'unknown'].map(api => ({ ...seed, id: `route-${api}`, name: `Endfield ${api} 草稿测试`, dir: `C:/Fixture/${api}`, installed: false,
        supported: false, supportCode: 'ERR_API_SELECTION_REQUIRED', addonVersion: null, apiOverride: 'auto',
        chosen: { ...chosen, path: `C:/Fixture/${api}/Endfield.exe`, apiResolution: { api }, detectedApiResolution: { api } },
        vulkan: { ...vk, coreVersion: '0.4.7beta', packageId: 'nr-vulkan-beta047-fixture', reason: '当前路线尚未确认为 Vulkan' } })),
      { ...seed, id: 'route-blocked', name: 'Vulkan 硬限制测试', dir: 'C:/Fixture/Blocked', installed: false, supported: true, addonVersion: null,
        apiOverride: 'auto', chosen: { ...chosen, path: 'C:/Fixture/Blocked/Game.exe' },
        vulkan: { ...vk, coreVersion: '0.4.7beta', packageId: 'nr-vulkan-beta047-fixture', selectionAvailable: false, selectionReason: '当前只支持 RTX 50', reason: '旧路线未确认' } }
    ];
    result.value.games = structuredClone(mock.games); return result;
  };
  window.manager.listGames = async () => { mock.lists++; return ok(mock.games); };
  window.manager.readNr = id => mock.holdNr ? new Promise(resolve => { mock.nrResolve = async () => { mock.holdNr = false; resolve(await readNr(id)); }; }) : readNr(id);
  window.manager.setGameApi = () => { throw new Error('Separate API save must not be called'); };
  window.manager.repair = () => { throw new Error('Separate version repair must not be called'); };
  window.manager.install = () => { throw new Error('Separate installation must not be called'); };
  const submit = (method, id, options) => new Promise(resolve => {
    mock.methods.push(method);
    mock.calls.push({ id, options: structuredClone(options) });
    mock.resolve = success => {
      if (success) {
        const game = mock.games.find(row => row.id === id), api = options.api === 'auto' ? game.chosen.detectedApiResolution.api : options.api;
        game.installed = true; game.apiOverride = options.api; game.chosen.apiResolution = { api, source: options.api === 'auto' ? 'fixture' : 'override' };
        if (api === 'vulkan') game.vulkan = { ...game.vulkan, installed: true, available: true };
        else game.addonVersion = options.version;
        resolve(ok({ complete: true, appliedRoute: { api, version: options.version, gameSettingsSynced: Boolean(game.chosen.apiSettings?.canSync) },
          ...(method === 'prepareGame' ? { prepared: true, runtimeVerified: false, stages: [
            { domain: 'nr', status: 'prepared', message: '已准备 NR 配套。' },
            { domain: 'sr', status: 'retained', message: '保留已有超分选择。' },
            { domain: 'fg', status: 'unavailable', message: '此游戏未确认原生 FG。' }
          ] } : {}) }));
      } else resolve({ ok: false, error: { code: 'FIXTURE_APPLY_FAILED', message: '模拟应用失败，原设置保留' } });
      mock.resolve = null;
    };
  });
  window.manager.applyGameRoute = (id, options) => submit('applyGameRoute', id, options);
  window.manager.prepareGame = (id, options) => submit('prepareGame', id, options);
}.toString()})();\n`, 'utf8');

async function smoke() {
  const checks = [], mock = window.__routeMock;
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const waitUntil = async predicate => { const limit = Date.now() + 6000; while (!predicate()) { if (Date.now() > limit) throw new Error('Timed out waiting for route UI'); await new Promise(resolve => setTimeout(resolve, 12)); } };
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  const card = id => document.querySelector(`[data-id="${id}"]`);
  const field = (id, selector) => card(id).querySelector(selector);
  const change = (id, selector, value) => { const control = field(id, selector); control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); };
  const expand = id => card(id).querySelector('.game-card-head').click();
  const api = id => field(id, '.game-api-select');
  const core = id => field(id, '.game-version-select');
  await waitUntil(() => card('route-installed') && card('route-new'));
  assert(!card('route-recovery').querySelector('.launch-btn') && card('route-recovery').textContent.includes('恢复配套'), 'Legacy Vulkan recovery keeps launch disabled and its recovery entry visible');
  assert(card('route-installed').querySelector('.game-exe-path').textContent.includes('Native/Game.exe'), 'Selected EXE remains visible in the card header');

  mock.holdNr = true; expand('route-installed'); await waitUntil(() => mock.nrResolve);
  const detail = field('route-installed', '.game-detail'), nr = field('route-installed', '.nr-model-strength');
  assert(core('route-installed').value === '0.4.7beta', 'An installed native 0.4.6 defaults its pending upgrade to beta0.4.7');
  const route = field('route-installed', '.game-route-controls');
  assert(route.querySelectorAll('button').length === 1 && route.querySelector('.route-apply-btn').textContent === '应用设置', 'API and Core share one bottom Apply Settings action');
  assert(!route.querySelector('.api-save-btn') && !route.querySelector('.version-apply-btn'), 'Separate API and Core apply buttons are absent');
  const a = api('route-installed').getBoundingClientRect(), c = core('route-installed').getBoundingClientRect();
  assert(Math.abs(a.top - c.top) < 3 && c.left > a.right, 'API and Core selectors align on the same row');
  const lists = mock.lists;
  change('route-installed', '.game-version-select', '0.3.3-dev-r4'); change('route-installed', '.game-api-select', 'dx11');
  assert(core('route-installed').value === '0.3.3-dev-r4', 'Changing API retains a deliberately selected stable Core');
  change('route-installed', '.game-version-select', '0.4.7beta'); change('route-installed', '.game-api-select', 'dx12');
  assert(core('route-installed').value === '0.4.7beta' && mock.calls.length === 0 && mock.lists === lists, 'Choosing 0.4.7 then API preserves the pair without IPC or list refresh');
  await mock.nrResolve(); await settle();
  assert(field('route-installed', '.game-detail') === detail && field('route-installed', '.nr-model-strength') === nr && core('route-installed').value === '0.4.7beta', 'Late NR reads neither replace the detail nor reset the selected Core');
  field('route-installed', '.route-apply-btn').click(); await waitUntil(() => mock.calls.length === 1);
  assert(JSON.stringify(mock.calls[0]) === JSON.stringify({ id: 'route-installed', options: { api: 'dx12', version: '0.4.7beta', allowAntiCheat: false } }), 'One request submits the chosen API and 0.4.7 version together');
  assert(mock.methods[0] === 'applyGameRoute', 'An installed game updates only its selected NR route instead of preparing unrelated settings');
  assert(field('route-installed', '.route-apply-btn').disabled && field('route-installed', '.route-apply-btn').textContent.includes('正在应用'), 'The joint apply button exposes the pending operation');
  mock.resolve(true); await waitUntil(() => !document.body.classList.contains('is-busy')); await settle();
  assert(core('route-installed').value === '0.4.7beta' && field('route-installed', '.installed-version-note').textContent.includes('beta0.4.7'), 'Successful application refreshes to the actual applied 0.4.7');
  assert(!/beta0\.4\.7.*Beta/.test(core('route-installed').selectedOptions[0].textContent), 'The 0.4.7 label contains no duplicate Beta suffix');

  expand('route-new');
  assert(JSON.stringify([...api('route-new').options].map(option => option.value)) === JSON.stringify(['auto', 'dx12', 'vulkan']), 'RDR2 keeps only its supported API choices plus automatic');
  assert(field('route-new', '.api-config-block').textContent.includes('会同步游戏设置'), 'RDR2 synchronization guidance remains visible');
  change('route-new', '.game-version-select', '0.3.3-dev-r4'); change('route-new', '.game-api-select', 'vulkan');
  assert(core('route-new').disabled && core('route-new').value === 'nr-vulkan-sdr-r5-20260909' && core('route-new').selectedOptions[0].textContent.includes('0.4.6-hotfix.1'), 'A Vulkan draft shows the exact fixed package and its actual 0.4.6 Core');
  assert(![...core('route-new').options].some(option => option.value === '0.4.7beta'), 'Vulkan never presents native 0.4.7 as the installed fixed Core');
  change('route-new', '.game-api-select', 'dx12'); assert(core('route-new').value === '0.3.3-dev-r4', 'Returning from Vulkan restores the native Core draft');
  change('route-new', '.game-version-select', '0.4.7beta'); change('route-new', '.game-api-select', 'vulkan'); expand('route-new');
  assert(!field('route-new', '.game-detail'), 'Folding the card keeps a collapsed layout');
  field('route-new', '.install-btn').click(); await waitUntil(() => mock.calls.length === 2);
  assert(mock.calls[1].options.api === 'vulkan' && mock.calls[1].options.version === 'nr-vulkan-sdr-r5-20260909', 'Collapsed one-click installation submits the saved Vulkan draft pair');
  assert(mock.methods[1] === 'prepareGame' && mock.calls[1].options.route === 'native', 'A new installation uses the durable one-click preparation IPC with its route');
  mock.resolve(false); await waitUntil(() => !document.body.classList.contains('is-busy')); expand('route-new');
  assert(api('route-new').value === 'vulkan' && core('route-new').value === 'nr-vulkan-sdr-r5-20260909', 'A failed apply retains the draft across collapse and reopen');
  change('route-new', '.game-api-select', 'dx12'); change('route-new', '.game-version-select', '0.3.3-dev-r4');
  const changed = mock.games.find(row => row.id === 'route-new'); changed.chosen.path = 'C:/Fixture/RDR2/Other.exe'; changed.chosen.apiSettings = { kind: 'rdr2-system-xml', canSync: false };
  await refreshGames(); await settle();
  assert(core('route-new').value === '0.4.7beta' && api('route-new').value === 'auto', 'Changing the selected executable discards its old API/Core draft');
  assert(field('route-new', '.api-config-block').textContent.includes('不会改写游戏设置'), 'Unreadable RDR2 settings retain the manual-only guidance');

  field('route-default', '.install-btn').click(); await waitUntil(() => mock.calls.length === 3);
  assert(mock.calls[2].options.version === '0.4.7beta' && mock.calls[2].options.api === 'auto', 'A collapsed new installation without drafts explicitly requests default native 0.4.7');
  mock.resolve(true); await waitUntil(() => !document.body.classList.contains('is-busy')); expand('route-installed'); await settle();
  change('route-installed', '.game-api-select', 'vulkan');
  assert(field('route-installed', '.route-apply-btn').disabled && field('route-installed', '.route-draft-note').textContent.includes('先卸载'), 'A native-to-Vulkan draft preserves the restore-first boundary');
  change('route-installed', '.game-api-select', 'dx12'); await settle();

  for (const detected of ['mixed', 'unknown']) {
    const id = `route-${detected}`; expand(id); await settle();
    const beforeDetail = field(id, '.game-detail'), beforeLists = mock.lists, beforeCalls = mock.calls.length;
    change(id, '.game-api-select', 'vulkan');
    const selectedRoute = field(id, '.game-route-controls');
    assert(selectedRoute.textContent.includes('可准备') && selectedRoute.textContent.includes('beta0.4.7 · Vulkan 桥接') &&
      !selectedRoute.textContent.includes('当前路线尚未确认为 Vulkan') && !selectedRoute.textContent.includes('Vulkan 试验桥接当前不可用'), `${detected} to Vulkan shows ready beta0.4.7 without the saved-route rejection`);
    assert(field(id, '.game-detail') === beforeDetail && mock.calls.length === beforeCalls && mock.lists === beforeLists &&
      !field(id, '.route-apply-btn').disabled && field(id, '.install-btn') && !field(id, '.install-btn').disabled, `${detected} draft updates both available actions without IPC or replacing the detail`);
    field(id, '.route-apply-btn').click(); await waitUntil(() => mock.calls.length === beforeCalls + 1);
    assert(mock.calls.at(-1).options.api === 'vulkan' && mock.calls.at(-1).options.version === 'nr-vulkan-beta047-fixture', `${detected} application submits the exact beta0.4.7 Vulkan package`);
    mock.resolve(true); await waitUntil(() => !document.body.classList.contains('is-busy')); await settle();
    assert(field(id, '.launch-btn') && api(id).value === 'vulkan' && field(id, '.vulkan-route-block .badge').textContent === '已安装' &&
      core(id).selectedOptions[0].textContent === 'beta0.4.7 · Vulkan 桥接' && !field(id, '.game-route-controls').textContent.includes('当前路线尚未确认为 Vulkan'), `${detected} successful application refreshes to the installed Vulkan route without contradictory status`);
  }
  expand('route-blocked'); await settle();
  assert(field('route-blocked', '.install-btn') && !field('route-blocked', '.install-btn').disabled, 'A native-ready fixture initially has an install action');
  const beforeBlockedCalls = mock.calls.length, beforeBlockedLists = mock.lists;
  change('route-blocked', '.game-api-select', 'vulkan');
  const blockedApply = field('route-blocked', '.route-apply-btn');
  assert(blockedApply.disabled && field('route-blocked', '.vulkan-route-block').textContent.includes('当前只支持 RTX 50') &&
    !field('route-blocked', '.install-btn'), 'A hard Vulkan limit disables apply and replaces the existing header install action immediately');
  blockedApply.click(); expand('route-blocked'); await settle();
  assert(!field('route-blocked', '.install-btn') && mock.calls.length === beforeBlockedCalls && mock.lists === beforeBlockedLists, 'A hard-blocked collapsed Vulkan draft has no install action and submits no IPC');
  assert(!window.__launchMock.error, 'The renderer finishes without a startup or interaction error');
  // Return the isolated fixture to the reported pre-apply state for the image.
  const screenshotGame = mock.games.find(row => row.id === 'route-mixed');
  screenshotGame.installed = false; screenshotGame.apiOverride = 'auto'; screenshotGame.chosen.apiResolution = { api: 'mixed' };
  screenshotGame.vulkan.installed = false; screenshotGame.vulkan.available = false;
  state.preparationResults?.delete('route-mixed');
  await refreshGames(); expand('route-mixed'); change('route-mixed', '.game-api-select', 'vulkan');
  await settle(); document.getElementById('toast').className = 'toast';
  card('route-mixed').scrollIntoView({ block: 'start' }); await settle();
  return { checks, calls: mock.calls };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 940, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadFile(path.join(process.env.MANAGER_UI_ROOT || path.resolve(__dirname, '..'), 'src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${smoke.toString()})()`);
    win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 250));
    const screenshot = path.resolve(process.argv[2] || path.join(temporary, 'route-apply.png')); fs.mkdirSync(path.dirname(screenshot), { recursive: true }); fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, screenshot, sandbox: win.webContents.getLastWebPreferences().sandbox, softwareRendering: app.getGPUFeatureStatus().gpu_compositing !== 'enabled', gpuFeatureStatus: app.getGPUFeatureStatus(), ...result }, null, 2)); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); win.destroy(); app.exit(1); }
});
