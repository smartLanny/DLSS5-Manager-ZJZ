'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assessEnhancementState } = require('../src/product/game-enhancement-capabilities');
const policy = require('../src/product/launch-settings-policy');
const { installMock, smoke, captureBaseline, captureReadiness, captureHoYoReadiness, smokeTargeted, smokeTargetedHoYo } = require('./helpers/game-page-beta3-fixture.cjs');
const { createPolicyFixture } = require('./helpers/game-page-policy-fixture.cjs');
const { supportedProfileOptions } = require('../src/product/hoyoshade-profiles');
const { installHoYoMock, smokeHoYo } = require('./helpers/hoyo-page-fixture.cjs');
const { smokeVersionContract } = require('./helpers/core-version-fixture.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'game-page-ui-'));
const addonPolicyFixture = createPolicyFixture(path.join(temporary, 'native-policy'));
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();

// Eligibility and activation use production assessment; a user declaration
// cannot create native integration or the RTX40 MFG entry-point contract.
function featureFixture(series, domain, setting = 'on', supported = true, mfg = true) {
  const exe = addonPolicyFixture.paths.exe, exeIdentity = 'a'.repeat(64);
  const driver = { available: true, version: 60000, settingIds: [...policy.IDS.sr, ...policy.IDS.fg] };
  return assessEnhancementState({ domain, request: { backend: domain === 'sr' ? 'native' : series === 'RTX40' ? 'mfgunlock' : 'nvidia' },
    hardware: { series: [series], source: 'fixture' }, driver,
    game: { exe, exeIdentity, support: { status: supported ? 'supported' : 'unknown', source: supported ? series === 'RTX40' ? 'native-integration' : 'catalog' : 'loose-dll',
      capabilities: series === 'RTX50' ? { dynamic: true, multipliers: [2, 3, 4] } : mfg ? { mfgUnlock: { available: true, multipliers: [2, 3, 4] } } : {} }, gameSetting: { state: setting, source: setting === 'on' ? 'fixture-game-config' : null } },
    confirmation: { domain, exe, exeIdentity, enabled: true, source: 'user-confirmation' } });
}
const features = { on40: { sr: featureFixture('RTX40', 'sr'), fg: featureFixture('RTX40', 'fg') },
  on50: { sr: featureFixture('RTX50', 'sr'), fg: featureFixture('RTX50', 'fg') },
  unknownSr: featureFixture('RTX40', 'sr', 'unknown', false), activationUnknownSr: featureFixture('RTX40', 'sr', 'unknown'),
  activationOffSr: featureFixture('RTX40', 'sr', 'off'), noMfgContract: featureFixture('RTX40', 'fg', 'on', true, false),
  hoyoProfiles: supportedProfileOptions({ exe: path.join(temporary, 'hoyo', 'StarRail.exe') }) };
const captureOnly = process.env.GAME_UI_CAPTURE_ONLY === '1';
const hoyoMode = process.env.GAME_UI_HOYO === '1';
const readinessMode = process.env.GAME_UI_READINESS_CAPTURE === '1';
const hoyoReadinessMode = process.env.GAME_UI_HOYO_READINESS_CAPTURE === '1';
const versionMode = process.env.GAME_UI_VERSION_CONTRACT === '1';
const targetedMode = process.env.GAME_UI_TARGETED === '1';
const maintenanceSwitchMode = process.env.GAME_UI_MAINTENANCE_SWITCH === '1';
const runtimeRequiredMode = process.env.GAME_UI_RUNTIME_REQUIRED === '1';
const inputRouteMode = process.env.GAME_UI_INPUT_ROUTE === '1';
const demoMode = process.argv.includes('--demo');
const captureArtworkUrl = process.env.GAME_UI_CAPTURE_ARTWORK
  ? `file:///${encodeURI(path.resolve(process.env.GAME_UI_CAPTURE_ARTWORK).replace(/\\/g, '/'))}`
  : '';
const preload = path.join(temporary, 'preload.cjs'); fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: captureOnly || hoyoMode || versionMode || readinessMode || hoyoReadinessMode || targetedMode || maintenanceSwitchMode || runtimeRequiredMode || inputRouteMode || demoMode, runtimeRequired: runtimeRequiredMode, demo: demoMode, paths: addonPolicyFixture.paths })});${hoyoMode || hoyoReadinessMode ? `(${installHoYoMock.toString()})();` : ''}`);
let win;
ipcMain.on('game-page-fixture-window', (event, action) => {
  if (!demoMode || event.sender !== win?.webContents) return;
  if (action === 'minimize') win.minimize();
  if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  if (action === 'close') win.close();
});
ipcMain.handle('game-page-fixture-sr-plan', (event, request, hardware) => {
  if (event.sender !== win?.webContents) throw Error('unexpected fixture renderer');
  const validated = policy.validateRequest('sr', request);
  return validated.quality === 'game' ? [] : policy.nativeSr(validated, hardware).operations;
});
ipcMain.handle('game-page-fixture-native-policy', async (event, action, input) => {
  if (event.sender !== win?.webContents) throw Error('unexpected fixture renderer');
  if (action === 'preview') return addonPolicyFixture.preview(input.id, input.keep);
  if (action === 'assert') {
    try { return { ok: true, value: await addonPolicyFixture.assert(input.token) }; }
    catch (error) { return { ok: false, error: { code: error.code, message: error.message } }; }
  }
  if (action === 'mutate') { addonPolicyFixture.mutate(input.kind); return true; }
  if (action === 'reset') { addonPolicyFixture.reset(); return true; }
  throw Error('unknown native policy fixture action');
});
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: Number(process.env.GAME_UI_WIDTH) || (demoMode ? 1440 : 1300), height: Number(process.env.GAME_UI_HEIGHT) || (demoMode ? 900 : 1000), show: demoMode, useContentSize: true,
    webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: !demoMode } });
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    if (process.env.GAME_UI_ZOOM) win.webContents.setZoomFactor(Number(process.env.GAME_UI_ZOOM));
    if (inputRouteMode) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const until = async (predicate, label) => {
          const deadline = Date.now() + 5000;
          while (!predicate()) { if (Date.now() > deadline) throw Error('timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
        };
        await until(() => window.GamePageUi && window.__gpMock, 'renderer');
        const fixture = window.__gpMock.assessments.fixture;
        fixture.coreVersions.push({ id: '0.5.1-beta-ui1', label: '0.5.1 · fixture', ready: true });
        fixture.game.installed = false; fixture.game.nativeDlssAvailable = false;
        fixture.game.apiOverride = 'auto'; fixture.game.chosen.apiResolution = { api: 'unknown' };
        fixture.api.effectiveApi = 'unknown'; fixture.api.detectedApi = 'unknown';
        fixture.layout = { mode: 'local' }; fixture.deployment = { installed: false };
        fixture.defaults = { api: 'auto', version: '0.4.7beta' };
        let uncertain = true, prepared = null;
        const view = document.createElement('div'); view.className = 'view active'; document.body.append(view);
        const host = document.createElement('div'); view.append(host);
        const controller = window.GamePageUi.mount(host, window.manager, { hoyoSettingsOnly: true,
          selectedApi: () => 'dx12', inputRouteUnconfirmed: () => uncertain,
          preparationRequired: () => true, onPrepare: request => { prepared = request; } });
        await controller.open('fixture', 'overview');
        await until(() => host.querySelector('[data-gp-action="input-native"]'), 'reachable input choice');
        const picker = host.querySelector('[data-gp-group="route"][data-gp-field="version"]');
        picker.value = '0.5.1-beta-ui1'; picker.dispatchEvent(new Event('change', { bubbles: true }));
        host.querySelector('[data-gp-action="input-native"]').click();
        if (controller.getState().draft.version !== '0.5.1-beta-ui1') throw Error('native choice discarded Core draft');
        await controller.runPrimary();
        if (prepared?.route !== 'native' || prepared.version !== '0.5.1-beta-ui1') throw Error('native preparation lost draft: ' + JSON.stringify(prepared));
        host.querySelector('[data-gp-action="input-feeder"]').click(); prepared = null;
        await controller.runPrimary();
        if (prepared?.route !== 'feeder' || prepared.version !== '0.5.1-beta-ui1') throw Error('Feeder preparation lost draft');
        controller.discard(); uncertain = false; prepared = null; controller.refreshView();
        await controller.runPrimary();
        if (prepared?.route !== undefined || prepared.version !== '0.4.7beta') throw Error('static absence forced a route: ' + JSON.stringify(prepared));
        if (window.__gpMock.calls.some(row => row[0] === 'apply')) throw Error('input choice wrote before unified apply');
        controller.dispose(); view.remove();
        return { assertions: 6, preservedCoreAndApi: true, implicitFeeder: false, writes: 0 };
      })()`);
      console.log(JSON.stringify({ ok: true, scope: 'input-route-choice', ...result }, null, 2));
      win.destroy(); app.exit(0); return;
    }
    if (runtimeRequiredMode) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const until = async (predicate, label) => {
          const end = Date.now() + 5000;
          while (!predicate()) { if (Date.now() > end) throw Error('timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
        };
        await until(() => document.getElementById('payloadImportRuntimeBtn'), 'runtime guidance');
        const notice = document.getElementById('payloadNotice');
        const text = notice.textContent;
        if (!text.includes('NR-Runtime-RTX40.zip') || !text.includes('立即导入运行库 DLC') || !text.includes('打开组件管理')) throw Error('runtime guidance is incomplete: ' + text);
        if (/CodexTemp|nvngx_dlssnr\.dll/i.test(text)) throw Error('internal build path leaked into runtime guidance: ' + text);
        document.getElementById('payloadImportRuntimeBtn').click();
        await until(() => window.__gpMock.calls.some(row => row[0] === 'pick-runtime-dlc'), 'runtime picker action');
        document.getElementById('payloadOpenComponentsBtn').click();
        await until(() => document.getElementById('view-addons').classList.contains('active'), 'component view');
        const guide = document.getElementById('componentRuntimeGuide');
        if (guide.classList.contains('hidden') || !guide.textContent.includes('RTX 40 系') || !guide.textContent.includes('NR-Runtime-RTX40.zip')) throw Error('component runtime guide is incomplete: ' + guide.textContent);
        return { assertionCount: 8, writes: 0, notice: text.replace(/\s+/g, ' ').trim(), componentGuide: guide.textContent.replace(/\s+/g, ' ').trim() };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 120));
      if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, scope: 'runtime-dlc-guidance', sandbox: win.webContents.getLastWebPreferences().sandbox, ...result }, null, 2));
      win.destroy(); app.exit(0); return;
    }
    if (maintenanceSwitchMode) {
      const result = await win.webContents.executeJavaScript(`(async () => {
        const until = async (predicate, label) => {
          const end = Date.now() + 5000;
          while (!predicate()) {
            if (Date.now() > end) throw Error('timeout: ' + label);
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        };
        document.querySelector('.nav[data-view="repair"]').click();
        await until(() => document.querySelector('#repairMaintenance [data-gp-action="open-folder"]'), 'first maintenance game');
        const select = document.getElementById('repairGameSelect');
        select.value = 'fixture-two';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => window.__gpMock.calls.some(row => row[0] === 'assess-resolved' && row[1] === 'fixture-two' && row[2] === 'enhancements') &&
          document.querySelector('#repairMaintenance [data-gp-action="open-folder"]'), 'second maintenance game');
        document.querySelector('#repairMaintenance [data-gp-action="open-folder"]').click();
        document.querySelector('#repairMaintenance [data-gp-action="feedback"]').click();
        await until(() => window.__gpMock.calls.some(row => row[0] === 'feedback'), 'maintenance actions');
        const actions = window.__gpMock.calls.filter(row => row[0] === 'open-folder' || row[0] === 'feedback');
        const expected = JSON.stringify([['open-folder', 'fixture-two'], ['feedback', 'fixture-two']]);
        if (JSON.stringify(actions) !== expected) throw Error('maintenance actions escaped the selected game: ' + JSON.stringify(actions));
        return { writes: actions.length, actions };
      })()`);
      console.log(JSON.stringify({ ok: true, scope: 'maintenance-game-switch', sandbox: win.webContents.getLastWebPreferences().sandbox, ...result }, null, 2));
      win.destroy(); app.exit(0); return;
    }
    if (demoMode) {
      await win.webContents.executeJavaScript(`(() => { document.body.dataset.demoMode = 'true'; const banner = document.createElement('div'); banner.className = 'demo-mode-banner'; banner.textContent = '交互演示 · 所有操作仅作用于内存测试数据'; document.body.appendChild(banner); })()`);
      win.on('closed', () => app.quit());
      console.log(JSON.stringify({ ok: true, scope: 'interactive-safe-ui-demo', writes: 0 }));
      return;
    }
    if (process.env.GAME_UI_VIEW === 'addons') {
      const result = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('.nav[data-view="addons"]').click();
        await new Promise(resolve => setTimeout(resolve, 250));
        const panel = document.getElementById('componentLibraryPanel');
        const downloads = document.getElementById('componentUpdateRows');
        if (${JSON.stringify(process.env.GAME_UI_EXPAND_CONTROLS === '1')}) panel?.querySelector('.component-advanced')?.setAttribute('open', '');
        const visibleSelects = [...document.querySelectorAll('#view-addons select')].filter(select => select.getClientRects().length);
        const selectAlignment = visibleSelects.map(select => {
          const style = getComputedStyle(select);
          return { id: select.id || null, height: Math.round(select.getBoundingClientRect().height), display: style.display, alignItems: style.alignItems };
        });
        const assertionCount = 5;
        if (!document.getElementById('view-addons').classList.contains('active')) throw Error('component view is active');
        if (!panel || !downloads || downloads.children.length < 1) throw Error('component repository is rendered');
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth) throw Error('component view has horizontal overflow');
        if (!panel.querySelector('.component-empty')) throw Error('component empty state is visible');
        if (!panel.querySelector('.component-repository:not([open])')) throw Error('download repository is collapsed by default');
        if (CSS.supports('appearance', 'base-select') && selectAlignment.some(item => item.display !== 'flex' || item.alignItems !== 'center')) throw Error('component select content is not vertically centered');
        return { assertionCount, writes: 0, downloadCards: downloads.children.length, horizontalOverflow: 0, selectAlignment };
      })()`);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, sandbox: win.webContents.getLastWebPreferences().sandbox, ...result }, null, 2)); win.destroy(); app.exit(0); return;
    }
    if (process.env.GAME_UI_VIEW && ['games', 'hoyo', 'repair', 'settings'].includes(process.env.GAME_UI_VIEW)) {
      const requestedView = process.env.GAME_UI_VIEW;
      const result = await win.webContents.executeJavaScript(`(async () => {
        const viewName = ${JSON.stringify(process.env.GAME_UI_VIEW)};
        document.querySelector('.nav[data-view="' + viewName + '"]').click();
        await new Promise(resolve => setTimeout(resolve, 350));
        const view = document.getElementById('view-' + viewName);
        if (!view?.classList.contains('active')) throw Error(viewName + ' view is active');
        const activeNavIcon = document.querySelector('.nav.active .nav-icon');
        const regularNavIcon = document.querySelector('.nav:not(.active) .nav-icon');
        const repairActions = document.querySelector('#view-repair .repair-actions');
        const maintenance = document.querySelector('#repairMaintenance');
        const repairGap = repairActions && maintenance?.childElementCount
          ? Math.round(maintenance.getBoundingClientRect().top - repairActions.getBoundingClientRect().bottom)
          : null;
        const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
        const activeMask = activeNavIcon ? getComputedStyle(activeNavIcon).maskImage : null;
        const gameFilter = document.getElementById('gameFilter');
        const expandArrow = document.querySelector('.expand-arrow');
        const expandArrowBefore = expandArrow ? getComputedStyle(expandArrow, '::before') : null;
        const customizableSelect = CSS.supports('appearance', 'base-select');
        const visibleSelects = [...view.querySelectorAll('select')].filter(select => select.getClientRects().length);
        const selectAlignment = visibleSelects.map(select => {
          const style = getComputedStyle(select);
          return { id: select.id || null, height: Math.round(select.getBoundingClientRect().height), display: style.display, alignItems: style.alignItems };
        });
        let motionPreference = null, themePreference = null, settingsRhythm = null, posterGeometry = null;
        if (viewName === 'games') {
          const captureArtwork = ${JSON.stringify(captureArtworkUrl)};
          const firstPoster = view.querySelector('.game-card .poster');
          if (captureArtwork && firstPoster) {
            const image = document.createElement('img');
            image.src = captureArtwork;
            image.alt = '';
            firstPoster.replaceChildren(image);
            try { await image.decode(); } catch {}
          }
          posterGeometry = [...view.querySelectorAll('.game-card .poster')].map(poster => {
            const rect = poster.getBoundingClientRect();
            const image = poster.querySelector('img');
            return {
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              objectFit: image ? getComputedStyle(image).objectFit : null
            };
          });
          if (!posterGeometry.length || posterGeometry.some(item => item.width !== item.height || item.objectFit && item.objectFit !== 'contain')) {
            throw Error('game artwork is not a square contain-fit icon: ' + JSON.stringify(posterGeometry));
          }
        }
        if (viewName === 'settings') {
          const toggle = document.getElementById('animationsToggle');
          const theme = document.getElementById('themeSelect');
          const firstPanel = view.querySelector('.settings-panel');
          const settingRows = [...view.querySelectorAll('.settings-panel .setting-row')];
          const lastFirstPanelRow = firstPanel?.querySelector('.setting-row:last-of-type');
          settingsRhythm = {
            rowMinHeights: settingRows.map(row => getComputedStyle(row).minHeight),
            firstPanelHeight: firstPanel ? Math.round(firstPanel.getBoundingClientRect().height) : null,
            firstPanelTailGap: firstPanel && lastFirstPanelRow
              ? Math.round(firstPanel.getBoundingClientRect().bottom - lastFirstPanelRow.getBoundingClientRect().bottom)
              : null
          };
          if (settingsRhythm.rowMinHeights.some(value => value !== '0px') || settingsRhythm.firstPanelTailGap > 20) throw Error('settings panels retain excessive forced whitespace: ' + JSON.stringify(settingsRhythm));
          const forcedTheme = ${JSON.stringify(process.env.GAME_UI_THEME || '')};
          if (!theme || !['system', 'light', 'dark'].includes(theme.value)) throw Error('theme preference control is unavailable');
          if (forcedTheme) {
            if (theme.value !== forcedTheme || document.documentElement.dataset.theme !== forcedTheme) throw Error('forced theme did not apply before capture');
            themePreference = { forced: forcedTheme, resolved: document.documentElement.dataset.theme };
          } else {
            for (const value of ['dark', 'light', 'system']) {
              theme.value = value;
              theme.dispatchEvent(new Event('change', { bubbles: true }));
              await new Promise(resolve => setTimeout(resolve, 30));
            }
            const themeWrites = window.__gpMock.calls.filter(row => row[0] === 'update-settings' && row[1].theme).map(row => row[1].theme);
            if (theme.value !== 'system' || document.documentElement.dataset.themePreference !== 'system' || themeWrites.join(',') !== 'dark,light,system') throw Error('theme preference was not applied and persisted');
            themePreference = { writes: themeWrites, final: theme.value, resolved: document.documentElement.dataset.theme };
          }
          const initialDuration = parseFloat(getComputedStyle(view).animationDuration);
          if (!toggle?.checked || document.documentElement.dataset.motion !== 'on' || !(initialDuration > .1)) throw Error('animation preference does not default on');
          toggle.click();
          await new Promise(resolve => setTimeout(resolve, 30));
          const disabledDuration = parseFloat(getComputedStyle(view).animationDuration);
          if (toggle.checked || document.documentElement.dataset.motion !== 'off' || disabledDuration > .001) throw Error('animation preference did not disable motion immediately');
          toggle.click();
          await new Promise(resolve => setTimeout(resolve, 30));
          const writes = window.__gpMock.calls.filter(row => row[0] === 'update-settings' && Object.hasOwn(row[1], 'animationsEnabled')).map(row => row[1].animationsEnabled);
          if (!toggle.checked || document.documentElement.dataset.motion !== 'on' || writes.join(',') !== 'false,true') throw Error('animation preference was not restored and persisted');
          motionPreference = { initialDuration, disabledDuration, writes, final: document.documentElement.dataset.motion };
        }
        if (horizontalOverflow) throw Error(viewName + ' view has horizontal overflow');
        if (viewName === 'repair' && repairGap !== null && repairGap < 16) throw Error('repair maintenance spacing regressed');
        if (activeMask && !/-fill\.svg/.test(activeMask)) throw Error(viewName + ' active navigation icon is not the fill variant');
        if (viewName === 'games' && !/caret-down\.svg/.test(expandArrowBefore?.maskImage || '')) throw Error('game expand control is not using CaretDown');
        if (customizableSelect && selectAlignment.some(item => item.display !== 'flex' || item.alignItems !== 'center')) throw Error(viewName + ' select content is not vertically centered');
        return {
          view: viewName,
          writes: 0,
          horizontalOverflow,
          repairGap,
          customizableSelect,
          selectAppearance: gameFilter ? getComputedStyle(gameFilter).appearance : null,
          selectPickerIcon: gameFilter ? getComputedStyle(gameFilter, '::picker-icon').maskImage : null,
          selectAlignment,
          posterGeometry,
          settingsRhythm,
          themePreference,
          motionPreference,
          expandArrowMask: expandArrowBefore?.maskImage || null,
          activeMask,
          regularMask: regularNavIcon ? getComputedStyle(regularNavIcon).maskImage : null
        };
      })()`);
      if (requestedView === 'games' && process.env.GAME_UI_MOTION_TARGET === 'card') {
        result.motionState = await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('#gameList .game-card .game-card-head')?.click();
          await new Promise(resolve => setTimeout(resolve, 70));
          const detail = document.querySelector('#gameList .game-card.expanded .game-detail');
          if (!detail) throw Error('game detail did not open for motion capture');
          const style = getComputedStyle(detail);
          return { animationName: style.animationName, animationDuration: style.animationDuration, opacity: style.opacity,
            arrowExpanded: document.querySelector('#gameList .game-card.expanded .expand-arrow')?.getAttribute('aria-expanded') };
        })()`);
        if (result.motionState.animationName !== 'detail-enter' || result.motionState.animationDuration !== '0.22s' || result.motionState.arrowExpanded !== 'true') throw Error('game detail transition is not active');
      }
      if (requestedView === 'games' && process.env.GAME_UI_MOTION_TARGET === 'modal') {
        result.motionState = await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('#gameList .game-card .game-card-head')?.click();
          await new Promise(resolve => setTimeout(resolve, 70));
          document.querySelector('#gameList .game-card.expanded [data-gp-action="rename-game"]')?.click();
          await new Promise(resolve => setTimeout(resolve, 45));
          const modal = document.getElementById('modal'), card = modal?.querySelector('.modal-card');
          if (!modal || modal.classList.contains('hidden')) throw Error('rename modal did not open for motion capture');
          const modalStyle = getComputedStyle(modal), cardStyle = getComputedStyle(card);
          return { modalDuration: modalStyle.transitionDuration, cardDuration: cardStyle.transitionDuration,
            modalOpacity: modalStyle.opacity, cardTransform: cardStyle.transform };
        })()`);
        if (!result.motionState.modalDuration.includes('0.18s') || !result.motionState.cardDuration.includes('0.18s')) throw Error('modal transition is not active');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (requestedView === 'games' && process.env.GAME_UI_OPEN_PICKER === '1') {
        const point = await win.webContents.executeJavaScript(`(() => { const rect = document.getElementById('gameFilter').getBoundingClientRect(); return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })()`);
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y });
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, sandbox: win.webContents.getLastWebPreferences().sandbox, ...result }, null, 2)); win.destroy(); app.exit(0); return;
    }
    const selectedTab = process.env.GAME_UI_TAB || 'overview';
    if (!['overview', 'nr', 'enhance', 'maintenance'].includes(selectedTab)) throw Error('Unknown screenshot tab');
    const captureArgs = { tab: selectedTab, diagnostics: process.env.GAME_UI_DIAGNOSTICS === '1', dirty: process.env.GAME_UI_DIRTY === '1', readiness: process.env.GAME_UI_READINESS_STATE || 'blocked', hoyoCapture: process.env.GAME_UI_HOYO_CAPTURE === '1' };
    const runner = versionMode ? smokeVersionContract : targetedMode ? hoyoMode ? smokeTargetedHoYo : smokeTargeted : hoyoReadinessMode ? captureHoYoReadiness : readinessMode ? captureReadiness : hoyoMode ? smokeHoYo : captureOnly ? captureBaseline : smoke;
    const result = await win.webContents.executeJavaScript(`(${runner.toString()})(${JSON.stringify(captureArgs)})`);
    if (!captureOnly && process.env.GAME_UI_TAB) {
      const selected = process.env.GAME_UI_TAB; if (!['overview', 'nr', 'enhance', 'maintenance'].includes(selected)) throw Error('Unknown screenshot tab');
      await win.webContents.executeJavaScript(`document.querySelector('.game-card.expanded [data-gp-tab="${selected}"]').click()`);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, sandbox: win.webContents.getLastWebPreferences().sandbox, ...result }, null, 2)); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    try { console.error(await win.webContents.executeJavaScript(`JSON.stringify({ active: document.querySelector('.game-card.expanded')?.dataset.id, text: document.querySelector('.game-card.expanded .game-detail')?.innerText, calls: window.__gpMock?.calls.slice(-12), hoyo: window.__hoyoMock && { flow: window.__hoyoMock.flow, calls: window.__hoyoMock.calls.slice(-12) } })`)); } catch {}
    win.destroy(); app.exit(1);
  }
});
