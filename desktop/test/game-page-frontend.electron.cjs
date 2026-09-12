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
const preload = path.join(temporary, 'preload.cjs'); fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: captureOnly || hoyoMode || versionMode || readinessMode || hoyoReadinessMode || targetedMode, paths: addonPolicyFixture.paths })});${hoyoMode || hoyoReadinessMode ? `(${installHoYoMock.toString()})();` : ''}`);
let win;
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
  win = new BrowserWindow({ width: Number(process.env.GAME_UI_WIDTH) || 1300, height: Number(process.env.GAME_UI_HEIGHT) || 1000, show: false, useContentSize: true,
    webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    const selectedTab = process.env.GAME_UI_TAB || 'overview';
    if (!['overview', 'enhance', 'maintenance'].includes(selectedTab)) throw Error('Unknown screenshot tab');
    const captureArgs = { tab: selectedTab, diagnostics: process.env.GAME_UI_DIAGNOSTICS === '1', dirty: process.env.GAME_UI_DIRTY === '1', readiness: process.env.GAME_UI_READINESS_STATE || 'blocked', hoyoCapture: process.env.GAME_UI_HOYO_CAPTURE === '1' };
    const runner = versionMode ? smokeVersionContract : targetedMode ? hoyoMode ? smokeTargetedHoYo : smokeTargeted : hoyoReadinessMode ? captureHoYoReadiness : readinessMode ? captureReadiness : hoyoMode ? smokeHoYo : captureOnly ? captureBaseline : smoke;
    const result = await win.webContents.executeJavaScript(`(${runner.toString()})(${JSON.stringify(captureArgs)})`);
    if (!captureOnly && process.env.GAME_UI_TAB) {
      const selected = process.env.GAME_UI_TAB; if (!['overview', 'enhance', 'maintenance'].includes(selected)) throw Error('Unknown screenshot tab');
      await win.webContents.executeJavaScript(`document.querySelector('.game-card.expanded [data-gp-tab="${selected}"]').click()`);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, sandbox: win.webContents.getLastWebPreferences().sandbox, ...result }, null, 2)); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    try { console.error(await win.webContents.executeJavaScript(`JSON.stringify({ active: document.querySelector('.game-card.expanded')?.dataset.id, text: document.querySelector('.game-card.expanded .game-detail')?.innerText, calls: window.__gpMock?.calls.slice(-12) })`)); } catch {}
    win.destroy(); app.exit(1);
  }
});
