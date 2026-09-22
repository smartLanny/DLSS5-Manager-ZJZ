'use strict';
// Actual renderer and native Electron layout; IPC uses isolated, inert fixtures.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { installHoYoMock } = require('./helpers/hoyo-page-fixture.cjs');
const { resolveContract } = require('../src/product/nr-config-contract');
const { readConfig } = require('../src/product/nr-config');
const output = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'manager-usability-audit'));
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-usability-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const features = { on40: { sr: { eligible: true, state: 'configurable', blockers: [] }, fg: { eligible: false, blockers: [{ message: '游戏未提供原生补帧' }] } }, hoyoProfiles: [], uniform: resolveContract('0.5-dline21-unified3'), dual: resolveContract('0.5-dline13'), icon: 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/app-icon.png')).toString('base64') };
for (const name of ['uniform', 'dual']) {
  const contract = features[name];
  const config = path.join(root, name + '.ini');
  fs.writeFileSync(config, '[NRBeforeSR]\n' + Object.entries(contract.defaults).map(([key, value]) => key + '=' + value).join('\n'));
  features[name + 'Config'] = readConfig(config, contract.version);
}
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: { gameDir: root, exe: path.join(root, 'Game.exe') } })});(${installHoYoMock.toString()})();(${scenario.toString()})();`);
function scenario() {
  const mock = window.__gpMock, h = window.__hoyoMock;
  window.auditCapture = name => require('electron').ipcRenderer.invoke('usability-capture', name);
  window.manager.getGameIcon = async id => { mock.calls.push(['get-game-icon', id]); return { ok: true, value: mock.features.icon }; };
  h.flow.phase = 'install'; h.flow.nextAction = 'preview-install'; h.flow.api = { api: 'dx11' }; h.flow.channel = 'cn';
  h.flow.binding.status = 'confirmed'; h.flow.binding.launcher = h.flow.binding.launchers[0];
  const g = mock.assessments['fixture-hoyo']; g.api.effectiveApi = g.api.detectedApi = g.game.chosen.apiResolution.api = 'dx11';
}
let win;
ipcMain.handle('usability-capture', async (event, name) => {
  if (event.sender !== win?.webContents || !/^[a-z0-9-]+$/.test(name)) throw Error('Invalid capture');
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
});
async function audit() {
  const mock = window.__gpMock, results = [], timings = [], checks = [];
  const assert = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, label) => { const end = Date.now() + 8000; while (!fn()) { if (Date.now() > end) throw Error('Timeout: ' + label); await delay(15); } };
  const visible = node => Boolean(node?.getClientRects().length) && !node.closest('details:not([open])') && !node.closest('[hidden]');
  const capture = async (name, host) => {
    await delay(100);
    assert(document.documentElement.scrollWidth <= innerWidth, name + ': no horizontal overflow');
    const controls = [...host.querySelectorAll('button,select,input')].filter(visible);
    const rect = host.getBoundingClientRect();
    results.push({ step: results.length + 1, name, visibleControls: controls.length, text: host.innerText, viewport: [innerWidth, innerHeight], host: { top: rect.top, bottom: rect.bottom } });
    await window.auditCapture(name);
  };
  const host = () => document.querySelector('[data-id="fixture"] .game-detail');
  const state = () => host().__gpController.getState();
  const click = action => { const node = host().querySelector(`[data-gp-action="${action}"]`); assert(node && !node.disabled, action + ' enabled'); node.click(); };
  const tab = async key => { const start = performance.now(); host().querySelector(`[data-gp-tab="${key}"]`).click(); await until(() => state().tab === key && (key !== 'enhance' || state().loaded.includes('enhancements')), key); await new Promise(requestAnimationFrame); timings.push(performance.now() - start); };
  await until(() => document.querySelector('[data-id="fixture"] .open-game-page-btn'), 'library');
  await capture('01-library', document.getElementById('view-games'));
  document.querySelector('[data-id="fixture"] .open-game-page-btn').click(); await until(() => state()?.loaded.includes('installation'), 'editor');
  await capture('02-installation', host());
  assert(host().querySelector('[data-gp-detail="startup"]:not([open])'), 'startup details collapsed');
  assert([...host().querySelectorAll('.primary')].filter(visible).length === 1, 'one main action');
  await tab('nr'); await capture('03-nr-standard', host());
  const nr = mock.assessment.nr, contract = mock.features.uniform;
  mock.assessment.nr = { ...contract.defaults, ...mock.features.uniformConfig, contract, readable: true, defaults: contract.defaults };
  await host().__gpController.refresh(true); await capture('04-nr-multilayer', host());
  assert(host().querySelector('[data-gp-detail="layers"]:not([open])'), 'additional layers collapsed');
  const input = host().querySelector('[data-gp-field="Intensity"]'); input.value = '1.234567'; input.dispatchEvent(new Event('input', { bubbles: true }));
  assert(state().draft.nr.Intensity === 1.234567, 'numeric precision retained');
  assert(host().querySelector('[data-gp-detail="draft-summary"]:not([open])'), 'change details do not displace the main action');
  await capture('05-draft', host()); click('discard');
  const dual = mock.features.dual;
  mock.assessment.nr = { ...dual.defaults, ...mock.features.dualConfig, contract: dual, readable: true, defaults: dual.defaults };
  await host().__gpController.refresh(true); await capture('06-nr-dual', host());
  assert(host().querySelector('[data-gp-field="NRPasses"]') && !host().querySelector('[data-gp-field="Layer2Enabled"]'), 'D13 uses its actual two-pass contract');
  mock.assessment.nr = nr; await host().__gpController.refresh(true);
  await tab('enhance'); await capture('07-dlss', host());
  assert(host().innerText.includes('应用后使用 M 模型'), 'SR model hint matches selected model');
  await tab('nr'); input.value = '1.25';
  const current = host().querySelector('[data-gp-field="Intensity"]'); current.value = '1.25'; current.dispatchEvent(new Event('input', { bubbles: true }));
  assert(!host().querySelector('.gp-apply-bar .primary').disabled, 'unavailable FG does not block NR draft'); click('discard');
  for (let i = 0; i < 20; i++) await tab(i % 2 ? 'nr' : 'overview');
  document.querySelector('[data-view="hoyo"]').click();
  const hh = () => document.querySelector('.hoyo-settings-host'), h = window.__hoyoMock;
  await until(() => hh()?.__gpController.getState().loaded.includes('installation'), 'HoYo shared first installation');
  await until(() => document.querySelector('[data-hoyo-card] .poster img')?.complete, 'HoYo icon');
  assert(hh().querySelectorAll('[data-gp-tab]').length === 3, 'HoYo first installation uses the same three tabs');
  assert(mock.calls.some(row => row[0] === 'get-game-icon' && row[1] === h.flow.gameId), 'HoYo requests actual game icon service');
  await capture('08-hoyo-installation', document.getElementById('view-hoyo'));
  const firstApply = hh().querySelector('[data-gp-action="prepare"]'); assert(firstApply && !firstApply.disabled, 'HoYo first apply available'); firstApply.click();
  await until(() => document.querySelector('[data-hoyo-action="apply"]'), 'HoYo confirmation');
  await capture('09-hoyo-confirmation', document.getElementById('view-hoyo'));
  document.querySelector('[data-hoyo-action="close-plan"]').click();
  assert(!h.calls.some(row => row[0] === 'apply'), 'cancel confirmation does not apply');
  const samples = timings.slice(-20).sort((a,b) => a-b);
  return { ok: true, scope: 'production Electron renderer; inert synthetic IPC; icon fixture uses bundled app artwork', checks, steps: results, cachedTabs: { samples: samples.length, p95Ms: samples[Math.ceil(samples.length * .95) - 1] }, noRealGameFiles: true };
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: Number(process.env.GAME_UI_WIDTH) || 1300, height: Number(process.env.GAME_UI_HEIGHT) || 1000, useContentSize: true, show: false,
    webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    if (process.env.GAME_UI_ZOOM) win.webContents.setZoomFactor(Number(process.env.GAME_UI_ZOOM));
    const result = await win.webContents.executeJavaScript(`(${audit.toString()})()`);
    fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2)); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    win.destroy(); app.exit(1);
  }
});
