'use strict';

// Run with: electron test/game-card-actions.electron.cjs
// This loads the real renderer in an isolated offscreen window. The manager
// IPC is mocked; no game directory, driver, registry, or installation file is touched.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'game-card-ui-smoke-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();

const launchHarness = fs.readFileSync(path.join(__dirname, 'launch-settings-frontend.electron.cjs'), 'utf8');
const installMock = launchHarness.slice(launchHarness.indexOf('function installMock()'), launchHarness.indexOf('async function smoke()'));
const preload = path.join(temporary, 'preload.cjs');
fs.writeFileSync(preload, `${installMock}
installMock();
(() => {
  const ok = value => ({ ok: true, value: structuredClone(value) });
  const mock = window.__cardMock = { games: null, calls: [], installResolve: null, pending: {}, failRecovery: false };
  const originalBoot = window.manager.boot;
  const clone = () => structuredClone(mock.games || []);
  const seedGames = rows => {
    const seed = rows[0];
    const chosen = { ...seed.chosen, path: 'C:\\\\Games\\\\Scanned\\\\Game.exe', apiResolution: { api: 'dx12', source: 'fixture', evidence: [] }, detectedApiResolution: { api: 'dx12', source: 'fixture', evidence: [] } };
    return [
      { ...seed, id: 'ui-scanned', name: '扫描游戏', dir: 'C:\\\\Games\\\\Scanned', installed: false, supported: true, supportCode: null, supportText: '支持安装', chosen, apiOverride: 'auto' },
      { ...seed, id: 'ui-added', name: '已添加游戏', dir: 'C:\\\\Games\\\\Added', installed: true, supported: true, supportCode: null, supportText: '支持安装', chosen: { ...chosen, path: 'C:\\\\Games\\\\Added\\\\Game.exe' }, apiOverride: 'auto' },
      { ...seed, id: 'ui-feeder', name: 'Feeder · 无原生超分补帧', dir: 'C:\\\\Games\\\\Feeder', installed: false, supported: false,
        chosen: { ...chosen, path: 'C:\\\\Games\\\\Feeder\\\\Game.exe' }, apiOverride: 'auto', hasNativeDlss: false, nativeDlssAvailable: false, nativeFgAvailable: false,
        enhancementCapabilities: { nativeDlssAvailable: false, nativeFgAvailable: false, staticOnly: true },
        feeder: { installed: false, available: true, coreVersion: '0.4.7-beta', reason: '固定成品帧 NR 试验配套；不会增加原生超分或补帧。' } }
    ];
  };
  window.manager.boot = async () => {
    const response = await originalBoot();
    if (!mock.games) {
      mock.games = seedGames(response.value.games);
      const feeder = mock.games.find(row => row.id === 'ui-feeder');
      mock.games.push({ ...structuredClone(feeder), id: 'ui-feeder-api', name: 'Feeder · 手动确认 API',
        chosen: { ...feeder.chosen, apiResolution: { api: 'unknown', source: 'fixture' }, detectedApiResolution: { api: 'unknown', source: 'fixture' } },
        supportCode: 'ERR_API_SELECTION_REQUIRED', feeder: { ...feeder.feeder, available: false,
          reason: '先确认所选 EXE 使用 DirectX 12。', selectionAvailable: true, selectionReason: null } });
      mock.games.push({ ...structuredClone(feeder), id: 'ui-feeder-recovery', name: 'Feeder · 恢复未完成安装', installed: true,
        feeder: { ...feeder.feeder, installed: true, available: false, needsRecovery: true,
          selectionAvailable: false, selectionReason: 'Feeder 有未完成操作，请先恢复。' } });
    }
    response.value.games = clone();
    response.value.hardware = { family: 'RTX50', series: ['RTX50'], names: ['NVIDIA GeForce RTX 5090'], source: 'fixture' };
    window.__launchMock.data.hardware = structuredClone(response.value.hardware);
    return response;
  };
  window.manager.listGames = async () => ok(clone());
  window.manager.renameGame = async (id, name) => {
    mock.calls.push(['rename', id, name]);
    const game = mock.games.find(row => row.id === id);
    if (game) game.name = name;
    return ok(clone());
  };
  window.manager.applyGameRoute = () => { throw new Error('New cards must use prepareGame, not an NR-only installation'); };
  window.manager.prepareGame = (id, options) => new Promise(resolve => {
    mock.calls.push(['prepare', id, options]);
    mock.installResolve = result => {
      if (result && result.ok === true) {
        const game = mock.games.find(row => row.id === id);
        if (game) {
          game.installed = true;
          if (options.route === 'feeder') {
            game.feeder.installed = true; game.feeder.available = true;
            if (options.api && options.api !== 'auto') {
              game.apiOverride = options.api;
              game.chosen.apiResolution = { api: options.api, source: 'override', evidence: [] };
            }
          }
        }
      }
      resolve(result);
      mock.installResolve = null;
    };
  });
  window.manager.inspectPreparation = async id => ok(mock.pending[id] || { pending: false, stages: [], runtimeVerified: false });
  window.manager.restoreFeeder = async id => {
    mock.calls.push(['restore-feeder', id]);
    const game = mock.games.find(row => row.id === id);
    game.installed = false; game.feeder.installed = false; game.feeder.needsRecovery = false; game.feeder.available = true;
    game.feeder.selectionAvailable = true; game.feeder.selectionReason = null;
    return ok({ restored: true, runtimeVerified: false });
  };
  const originalGenericRecovery = window.manager.recoverLaunchSettings;
  window.manager.recoverLaunchSettings = (...args) => { mock.calls.push(['generic-recovery', ...args]); return originalGenericRecovery(...args); };
  window.manager.recoverPreparation = async id => {
    mock.calls.push(['recover-preparation', id]);
    if (mock.failRecovery) return { ok: false, error: { code: 'PREPARATION_RECOVERY_REQUIRED', message: '模拟恢复失败，记录仍保留' } };
    delete mock.pending[id]; const game = mock.games.find(row => row.id === id); game.installed = false; if (game.feeder) game.feeder.installed = false;
    return ok({ restored: true, outcomes: [{ domain: 'nr', restored: true }], runtimeVerified: false });
  };
})();
`, 'utf8');

async function smoke() {
  const checks = [];
  const assert = (condition, description) => { if (!condition) throw new Error(description); checks.push(description); };
  const waitUntil = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for renderer state');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const card = id => document.querySelector(`[data-id="${id}"]`);
  const title = id => card(id)?.querySelector('h3')?.textContent;
  const waitForCall = (kind, id) => waitUntil(() => window.__cardMock.calls.some(row => row[0] === kind && (!id || row[1] === id)));
  const waitForModal = visible => waitUntil(() => document.getElementById('modal').classList.contains('hidden') !== visible);

  await waitUntil(() => card('ui-scanned') && card('ui-added'));
  assert(Boolean(card('ui-scanned').querySelector('.rename-game-btn')), 'Scanned games expose the rename entry');
  assert(Boolean(card('ui-added').querySelector('.rename-game-btn')), 'Added and installed games expose the same rename entry');
  assert(Boolean(card('ui-scanned').querySelector('.install-btn')), 'Supported uninstalled games expose one-click install');

  const scannedBefore = JSON.stringify(window.__cardMock.games.find(row => row.id === 'ui-scanned').chosen);
  card('ui-scanned').querySelector('.rename-game-btn').click();
  await waitForModal(true);
  const input = document.getElementById('renameGameInput');
  assert(input.value === '扫描游戏' && document.getElementById('modalBody').textContent.includes('API/EXE'), 'Rename modal pre-fills the scanned name and explains binding safety');
  input.value = '扫描游戏（新名称）';
  document.getElementById('modalConfirm').click();
  await waitForCall('rename', 'ui-scanned'); await waitForModal(false); await waitUntil(() => title('ui-scanned') === '扫描游戏（新名称）');
  assert(title('ui-scanned') === '扫描游戏（新名称）', 'Saving a scanned game name updates the visible card');
  assert(JSON.stringify(window.__cardMock.games.find(row => row.id === 'ui-scanned').chosen) === scannedBefore, 'Renaming preserves the scanned API/EXE binding');

  const renamesBeforeCancel = window.__cardMock.calls.filter(row => row[0] === 'rename').length;
  card('ui-added').querySelector('.rename-game-btn').click();
  await waitForModal(true);
  input.value = '取消不会保存';
  document.getElementById('modalCancel').click();
  await waitForModal(false);
  assert(window.__cardMock.calls.filter(row => row[0] === 'rename').length === renamesBeforeCancel && title('ui-added') === '已添加游戏', 'Cancel leaves an added game name unchanged');

  card('ui-added').querySelector('.rename-game-btn').click();
  await waitForModal(true);
  input.value = '按回车保存';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await waitForCall('rename', 'ui-added'); await waitForModal(false); await waitUntil(() => title('ui-added') === '按回车保存');
  assert(title('ui-added') === '按回车保存', 'Enter submits the rename modal');

  card('ui-added').querySelector('.rename-game-btn').click();
  await waitForModal(true);
  input.value = '   ';
  document.getElementById('modalConfirm').click();
  assert(!document.getElementById('modal').classList.contains('hidden') && window.__cardMock.calls.filter(row => row[0] === 'rename').length === renamesBeforeCancel + 1, 'Blank names keep the modal open without an IPC write');
  document.getElementById('modalCancel').click();
  await waitForModal(false);

  const installButton = () => card('ui-scanned')?.querySelector('.install-btn');
  installButton().click();
  await waitForCall('prepare', 'ui-scanned');
  const pending = installButton();
  assert(pending.disabled && pending.getAttribute('aria-busy') === 'true' && pending.getAttribute('aria-live') === 'polite', 'Install pending disables the button and exposes ARIA busy state');
  assert(pending.querySelector('.button-spinner') && pending.textContent.includes('正在安装') && !/\\d+%/.test(pending.textContent), 'Install pending shows the real spinner label without a fake percentage');
  window.__cardMock.installResolve({ ok: false, error: { code: 'ERR_TEST_INSTALL', message: '模拟安装失败' } });
  await waitUntil(() => installButton() && !installButton().disabled && installButton().getAttribute('aria-busy') === 'false');
  assert(!installButton().querySelector('.button-spinner') && installButton().textContent.includes('一键安装'), 'Failed install clears the busy state and restores the button');

  installButton().click();
  await waitUntil(() => window.__cardMock.calls.filter(row => row[0] === 'prepare' && row[1] === 'ui-scanned').length === 2);
  assert(installButton().disabled && installButton().querySelector('.button-spinner'), 'A second install attempt re-enters the visible pending state');
  window.__cardMock.installResolve({ ok: true, value: { prepared: true, runtimeVerified: false, stages: [
    { domain: 'nr', status: 'prepared', message: '本轮 NR 配套已准备。' },
    { domain: 'sr', status: 'retained', message: '保留原有质量档选择。' },
    { domain: 'fg', status: 'unavailable', message: 'MFG 资源摘要不匹配，未准备补帧。' }
  ] } });
  await waitUntil(() => card('ui-scanned')?.querySelector('.launch-btn'));
  assert(!card('ui-scanned').querySelector('.install-btn'), 'Completed install refreshes to the installed card and removes pending UI');
  await waitUntil(() => card('ui-scanned').querySelector('.preparation-host')?.hidden);
  const preparation = () => card('ui-scanned').querySelector('.preparation-host');
  assert(preparation().hidden && !card('ui-scanned').querySelector('.preparation-all-btn') && !card('ui-scanned').querySelector('.preparation-check-btn'),
    'Completed installation does not add a second preparation panel or duplicate preparation buttons');
  window.__cardMock.pending['ui-scanned'] = { pending: true, stages: [{ domain: 'nr', status: 'prepared', message: '需恢复本轮 NR。' }], failure: { message: 'SR 恢复尚未完成。' } };
  card('ui-scanned').querySelector('.game-card-head').click(); card('ui-scanned').querySelector('.game-card-head').click();
  await waitUntil(() => preparation().querySelector('.preparation-recover-btn'));
  assert(!preparation().hidden && preparation().querySelector('[role="alert"]').textContent.includes('恢复记录已保留') && preparation().textContent.includes('SR 恢复尚未完成'), 'A pending preparation exposes the durable recovery reason above both tabs');
  window.__cardMock.failRecovery = true; preparation().querySelector('.preparation-recover-btn').click();
  await waitUntil(() => !document.body.classList.contains('is-busy') && document.getElementById('toast').textContent.includes('模拟恢复失败'));
  assert(preparation().querySelector('.preparation-recover-btn') && window.__cardMock.pending['ui-scanned'], 'Failed recovery retains its action and pending state');
  window.__cardMock.failRecovery = false; preparation().querySelector('.preparation-recover-btn').click();
  await waitUntil(() => !document.body.classList.contains('is-busy') && !window.__cardMock.pending['ui-scanned'] && card('ui-scanned').querySelector('.install-btn'));
  assert(!preparation()?.querySelector('.preparation-recover-btn'), 'Confirmed recovery removes the pending recovery action');
  assert(!preparation()?.textContent.includes('NR · 已准备'), 'After rollback the card no longer presents a superseded prepared NR result');

  card('ui-feeder-api').querySelector('.game-card-head').click();
  const apiCard = () => card('ui-feeder-api'), apiSelect = apiCard().querySelector('.game-api-select');
  assert(apiSelect.value === 'auto' && apiCard().textContent.includes('API 待确认'), 'An unidentified Feeder API remains unconfirmed before an explicit selection');
  apiSelect.value = 'dx12'; apiSelect.dispatchEvent(new Event('change', { bubbles: true }));
  const apiApply = apiCard().querySelector('.route-apply-btn');
  assert(apiApply && !apiApply.disabled && apiApply.textContent.includes('一键准备 Feeder'), 'Selecting DX12 enables the Feeder detail action using candidate eligibility');
  assert(apiCard().querySelector('.install-btn') && !apiCard().querySelector('.install-btn').disabled, 'Selecting DX12 enables the matching card-header action');
  apiApply.click(); await waitForCall('prepare', 'ui-feeder-api');
  const selectedRequest = window.__cardMock.calls.find(row => row[0] === 'prepare' && row[1] === 'ui-feeder-api')[2];
  assert(selectedRequest.api === 'dx12' && selectedRequest.route === 'feeder', 'The real DOM submission carries both the manual DX12 selection and Feeder route');
  window.__cardMock.installResolve({ ok: true, value: { prepared: true, runtimeVerified: false, stages: [
    { domain: 'nr', status: 'prepared', message: '已按确认的 DX12 准备 Feeder。' }
  ] } });
  await waitUntil(() => !document.body.classList.contains('is-busy') && apiCard().querySelector('.launch-btn'));
  assert(apiCard().querySelector('.game-api-select').value === 'dx12', 'Successful preparation retains the committed DX12 selection after refresh');

  const recoveringCard = () => card('ui-feeder-recovery');
  const ownerRecovery = recoveringCard().querySelector('.feeder-recover-btn');
  assert(ownerRecovery && ownerRecovery.textContent.includes('恢复并卸载 Feeder') && !recoveringCard().querySelector('.launch-btn'), 'A pending Feeder transaction exposes its owner recovery action instead of game launch');
  ownerRecovery.click(); await waitForCall('restore-feeder', 'ui-feeder-recovery');
  await waitUntil(() => !document.body.classList.contains('is-busy') && !recoveringCard().querySelector('.feeder-recover-btn'));
  assert(window.__cardMock.calls.filter(row => row[0] === 'restore-feeder' && row[1] === 'ui-feeder-recovery').length === 1 &&
    !window.__cardMock.calls.some(row => row[0] === 'generic-recovery'), 'Feeder recovery invokes only its dedicated owner API once');
  assert(Boolean(recoveringCard().querySelector('.install-btn')), 'Confirmed owner recovery removes the pending state and restores the preparation entry');

  card('ui-feeder').querySelector('.game-card-head').click();
  const feederDetail = () => card('ui-feeder').querySelector('.game-detail');
  assert(feederDetail().textContent.includes('无原生 DLSS') && feederDetail().textContent.includes('成品帧') && !feederDetail().querySelector('.game-version-select'),
    'Feeder card identifies its fixed post-process NR route rather than a native DLSS core choice');
  feederDetail().querySelector('[data-detail-tab="graphics"]').click();
  const feederHost = feederDetail().querySelector('.launch-settings-host'); await feederHost.launchSettingsController.ready;
  assert(!feederHost.querySelector('fieldset') && !feederHost.querySelector('[data-ls-field]') && feederHost.textContent.includes('没有可准备的超分功能') && feederHost.textContent.includes('没有可准备的补帧功能'),
    'A Feeder-only card explains unavailable native features without showing inactive editors');
  assert(!feederHost.querySelector('[data-ls-action="prepare"]:not([disabled])'), 'No MFG prepare action is available without original FG');
  feederDetail().querySelector('[data-detail-tab="enhance"]').click(); card('ui-feeder').querySelector('.install-btn').click();
  await waitForCall('prepare', 'ui-feeder');
  assert(window.__cardMock.calls.filter(row => row[0] === 'prepare' && row[1] === 'ui-feeder').at(-1)[2].route === 'feeder', 'Feeder one-click submits the explicit Feeder preparation route');
  window.__cardMock.installResolve({ ok: true, value: { prepared: true, stages: [
    { domain: 'nr', status: 'prepared', message: '已准备成品帧 NR，尚未确认游戏内处理。' },
    { domain: 'sr', status: 'unavailable', message: '无原生 DLSS，未添加超分。' },
    { domain: 'fg', status: 'unavailable', message: '无原生 Streamline FG，未添加补帧。' }
  ], runtimeVerified: false } });
  await waitUntil(() => !document.body.classList.contains('is-busy') && card('ui-feeder').querySelector('.launch-btn'));
  assert(card('ui-feeder').querySelector('.preparation-host').hidden && !card('ui-feeder').querySelector('.route-options').open, 'An installed Feeder has no repeated preparation block and collapses advanced installation options');
  assert(!card('ui-feeder').querySelector('.route-apply-btn') && card('ui-feeder').querySelectorAll('.maintenance-inline-btn').length === 1, 'An installed Feeder exposes exactly one maintenance action');
  assert(card('ui-feeder').querySelector('.feeder-entry-note').textContent.includes('DXGI → D3D12'), 'Feeder explains its fixed loader entry inside installation options');
  card('ui-feeder').scrollIntoView({ block: 'start' });
  document.getElementById('toast').className = 'toast';
  return { checks };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: {
    preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true
  } });
  try {
    await win.loadFile(path.join(process.env.MANAGER_UI_ROOT || path.resolve(__dirname, '..'), 'src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${smoke.toString()})()`);
    win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 100));
    const screenshot = process.argv[2] && path.resolve(process.argv[2]);
    if (screenshot) { fs.mkdirSync(path.dirname(screenshot), { recursive: true }); fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG()); }
    console.log(JSON.stringify({ ok: true, screenshot: screenshot || null, sandbox: win.webContents.getLastWebPreferences().sandbox, softwareRendering: app.getGPUFeatureStatus().gpu_compositing !== 'enabled', gpuFeatureStatus: app.getGPUFeatureStatus(), ...result }, null, 2));
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    win.destroy(); app.exit(1);
  }
});
