'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { installHoYoMock, smokeHoYo } = require('./helpers/hoyo-page-fixture.cjs');
const { installCompatibilityFeedbackMock, smokeCompatibilityNormal, smokeCompatibilityHoyo, smokeCompatibilityHoyoUnready } = require('./helpers/compatibility-feedback-fixture.cjs');

const mode = process.env.GAME_UI_HOYO === '1' ? 'hoyo' : 'normal';
const fixturePaths = {
  gameDir: 'C:\\UI-fixture\\Baldurs Gate 3',
  exe: 'C:\\UI-fixture\\Baldurs Gate 3\\bin\\bg3_dx11.exe',
  ini: 'C:\\UI-fixture\\Baldurs Gate 3\\nr_before_sr.ini'
};
const feature = (domain) => ({
  eligible: true,
  state: 'configurable',
  activation: { state: 'on' },
  availableModes: domain === 'fg' ? ['restore', 'follow', 'off', 'fixed', 'dynamic'] : [],
  availableMultipliers: domain === 'fg' ? [2, 3, 4] : [],
  capabilityOptions: domain === 'fg' ? { multipliers: [2, 3, 4].map(value => ({ value, available: true })) } : {}
});
const features = {
  on40: { sr: feature('sr'), fg: feature('fg') },
  hoyoProfiles: [
    { family: 'starrail', channel: 'cn', exeName: 'StarRail.exe', gameBiz: 'hkrpg_cn', familyLabel: '崩坏：星穹铁道', channelLabel: '国服', releaseCategory: 'public', launcherKinds: ['hoyoplay', 'starward'] },
    { family: 'starrail', channel: 'bilibili', exeName: 'StarRail.exe', gameBiz: 'hkrpg_bilibili', familyLabel: '崩坏：星穹铁道', channelLabel: 'B站渠道服', releaseCategory: 'public', launcherKinds: ['hoyoplay', 'starward'] },
    { family: 'starrail', channel: 'global', exeName: 'StarRail.exe', gameBiz: 'hkrpg_global', familyLabel: '崩坏：星穹铁道', channelLabel: '国际服', releaseCategory: 'public', launcherKinds: ['hoyoplay', 'starward'] }
  ]
};

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'compatibility-full-ui-'));
app.setPath('userData', path.join(temporary, 'profile'));
app.disableHardwareAcceleration();

let win;
let tokenNumber = 0;
const contexts = new Map();
const previews = new Map();
const boundaryCalls = [];
const packageFor = id => id === 'fixture-hoyo' ? 'hoyo-package' : id === 'fixture' ? 'normal-package' : `${id}-package`;
const reply = value => ({ ok: true, value });
const failure = message => ({ ok: false, error: { code: 'FIXTURE_FEEDBACK', message } });

ipcMain.handle('compatibility-feedback-fixture', async (event, action, ...args) => {
  if (event.sender !== win?.webContents) throw Error('unexpected compatibility fixture renderer');
  boundaryCalls.push([action, ...args]);
  if (action === 'open') {
    const [gameId] = args;
    if (!gameId) return failure('missing game id');
    const token = `feedback-${++tokenNumber}`;
    const context = { token, gameId, packageId: packageFor(gameId), closed: false };
    contexts.set(token, context);
    return reply({ token, gameId, packageId: context.packageId });
  }
  if (action === 'close') {
    const [token] = args, context = contexts.get(token);
    if (!context) return reply({ closed: true, missing: true });
    context.closed = true;
    for (const [id, preview] of previews) if (preview.token === token) previews.delete(id);
    return reply({ closed: true, gameId: context.gameId });
  }
  if (action === 'preview') {
    const [token, request] = args, context = contexts.get(token);
    if (!context || context.closed) return failure('反馈上下文已关闭。');
    const previewId = `${context.packageId}-preview-${previews.size + 1}`;
    const preview = { previewId, token, packageId: context.packageId, request, summary: `${context.packageId} · 本次反馈预览`,
      report: { gameId: context.gameId, packageId: context.packageId, ratings: request?.ratings || {}, includeLogs: request?.includeLogs === true },
      files: [{ path: 'compatibility-report.json', bytes: 128, scope: 'current' }], privacyWarning: '预览仅保存在本机；确认后才会写入 ZIP。',
      logPreview: request?.includeLogs === true ? [{ name: 'fixture.log', text: '受控 Electron fixture log' }] : [] };
    previews.set(previewId, preview);
    return reply(preview);
  }
  if (action === 'discard') {
    const [token, previewId] = args, preview = previews.get(previewId);
    if (preview && preview.token === token) previews.delete(previewId);
    return reply({ discarded: true });
  }
  if (action === 'save') {
    const [token, request] = args, context = contexts.get(token), preview = previews.get(request?.previewId);
    if (!context || context.closed) return failure('反馈上下文已关闭。');
    if (!preview || preview.token !== token) return failure('反馈预览已失效。');
    previews.delete(request.previewId);
    return reply({ saved: true, path: `${context.packageId}-${context.gameId}.zip`, packageId: context.packageId });
  }
  return failure('unknown feedback fixture action');
});

app.whenReady().then(async () => {
  const preload = path.join(temporary, 'preload.cjs');
  const install = [
    `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: fixturePaths })});`,
    mode === 'hoyo' ? `(${installHoYoMock.toString()})();` : '',
    `(${installCompatibilityFeedbackMock.toString()})();`
  ].join('');
  fs.writeFileSync(preload, install, 'utf8');
  win = new BrowserWindow({ width: Number(process.env.GAME_UI_WIDTH) || 1100, height: Number(process.env.GAME_UI_HEIGHT) || 780,
    show: false, useContentSize: true, webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const deadlineMs = Math.max(5000, Number(process.env.COMPATIBILITY_UI_DEADLINE_MS) || 45000);
  let deadlineTimer;
  const withDeadline = promise => Promise.race([promise, new Promise((resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error(`Electron UI regression exceeded ${deadlineMs}ms`)), deadlineMs);
  })]);
  try {
    const run = async () => {
      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
      let result;
      if (mode === 'hoyo') {
        const unready = await win.webContents.executeJavaScript(`(${smokeCompatibilityHoyoUnready.toString()})({})`);
        const base = await win.webContents.executeJavaScript(`(${smokeHoYo.toString()})({ hoyoCapture: true })`);
        const feedback = await win.webContents.executeJavaScript(`(${smokeCompatibilityHoyo.toString()})({ leaveSurveyOpen: true })`);
        result = { ...base, ...feedback, baseAssertions: base.assertions, unreadyAssertions: unready.assertions };
      } else {
        result = await win.webContents.executeJavaScript(`(${smokeCompatibilityNormal.toString()})({ leaveSurveyOpen: true })`);
      }
      return result;
    };
    let result = await withDeadline(run()); clearTimeout(deadlineTimer);
    const screenshot = process.argv[2];
    if (screenshot) {
      fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
      fs.writeFileSync(path.resolve(screenshot), (await win.webContents.capturePage()).toPNG());
      result.screenshot = path.resolve(screenshot);
    }
    result = { ok: true, mode, width: win.getContentSize()[0], height: win.getContentSize()[1], ...result,
      boundaryCalls: boundaryCalls.length, activeContexts: [...contexts.values()].filter(row => !row.closed).map(row => row.packageId) };
    console.log(JSON.stringify(result, null, 2));
    win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    try { console.error(await win.webContents.executeJavaScript(`JSON.stringify({ active: document.querySelector('.game-card.expanded')?.dataset.id, dialog: document.querySelector('.cx-dialog')?.open, feedbackCalls: window.__compatMock?.calls, gameCalls: window.__gpMock?.calls.slice(-20), hoyoCalls: window.__hoyoMock?.calls.slice(-20) })`)); } catch {}
    win.destroy(); app.exit(1);
  }
});
