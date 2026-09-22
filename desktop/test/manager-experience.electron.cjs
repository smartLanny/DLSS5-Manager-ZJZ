'use strict';
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { createExperienceFixture } = require('./helpers/manager-experience-fixture.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-experience-'));
app.setPath('userData', path.join(root, 'electron')); app.disableHardwareAcceleration();
let win, fixture, cancelImport = true, applications = 0, preferences = 0;
app.whenReady().then(async () => {
 try {
  fixture = await createExperienceFixture(root);
  ipcMain.handle('experience', async (event, name, ...args) => {
   if (event.sender !== win.webContents) throw Error('unexpected sender');
   try {
    let value;
    if (name === 'boot') value = await fixture.service.boot();
    else if (name === 'listGames') value = await fixture.service.listGames();
    else if (name === 'refresh') value = await fixture.service.refresh();
    else if (name === 'pickGame') value = { root: fixture.gameDir, name: '异环反馈 · 混合 API 回归', chosen: fixture.service.gameScan?.('missing') };
    else if (name === 'selection') value = { root: fixture.gameDir, name: '异环反馈 · 混合 API 回归', chosen: { path: fixture.exe, name: 'Game.exe', bitness: 64, apiLabel: 'DX11 / DX12' }, candidates: [{ path: fixture.exe, name: 'Game.exe', bitness: 64, apiLabel: 'DX11 / DX12' }] };
    else if (name === 'confirmGame') { await fixture.add(); value = await fixture.service.listGames(); }
    else if (name === 'assessGame') value = await fixture.assessment.assess(...args);
    else if (name === 'setGameApiPreference') { value = await fixture.service.setGameApiPreference(...args); preferences++; assert.equal(fs.existsSync(path.join(path.dirname(fixture.exe), 'nr-before-sr.zh-CN.addon64')), false); }
    else if (name === 'requestOperation') { applications++; value = await fixture.deferred.submit(...args); }
    else if (name === 'previewOperation') value = await fixture.operations.preview(...args);
    else if (name === 'pickRuntimeDlc') { value = cancelImport ? null : await fixture.service.importRuntimeDlc(fixture.dlc); cancelImport = false; }
    else if (name === 'readPayloadSource') value = fixture.service.payloadState();
    else if (name === 'readNrSettings') value = await fixture.service.readNrSettings(...args);
    else if (name === 'cancelWaitingOperation') value = await fixture.deferred.cancel(...args);
    else if (name === 'running') { fixture.setRunning(args[0]); value = true; }
    else if (name === 'tick') { await fixture.deferred.tick(); value = true; }
    else if (name === 'evidence') value = { applications, preferences, files: fs.readdirSync(path.dirname(fixture.exe)), pending: await fixture.operations.inspect(args[0]), nr: await fixture.service.readNrSettings(args[0]) };
    else throw Error('unknown fixture method ' + name);
    return { ok: true, value };
   } catch (e) { return { ok: false, error: { code: e.code, message: e.message } }; }
  });
  const preload = path.join(root, 'preload.cjs');
  fs.writeFileSync(preload, `(${installMock.toString()})({on40:{},hoyoProfiles:[]},{captureOnly:true,paths:${JSON.stringify({ gameDir: fixture.gameDir, exe: fixture.exe, ini: path.join(path.dirname(fixture.exe), 'nr_before_sr.ini') })}});\n` +
   `const {ipcRenderer:flowIpc}=require('electron');const flowMethods=['boot','listGames','refresh','confirmGame','assessGame','setGameApiPreference','requestOperation','previewOperation','pickRuntimeDlc','readPayloadSource','readNrSettings','cancelWaitingOperation'];for(const name of flowMethods)window.manager[name]=(...args)=>flowIpc.invoke('experience',name,...args);window.manager.pickGame=()=>flowIpc.invoke('experience','selection');window.__flow=(name,...args)=>flowIpc.invoke('experience',name,...args);`);
  win = new BrowserWindow({ width: Number(process.env.GAME_UI_WIDTH) || 1100, height: Number(process.env.GAME_UI_HEIGHT) || 780, show: false, useContentSize: true, webPreferences: { preload, contextIsolation: false, sandbox: true, backgroundThrottling: false, offscreen: true } });
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  if (process.env.GAME_UI_ZOOM) win.webContents.setZoomFactor(Number(process.env.GAME_UI_ZOOM));
  const result = await win.webContents.executeJavaScript(`(${experience.toString()})()`);
  result.displayScaleFactor = screen.getPrimaryDisplay().scaleFactor;
  if (process.env.GAME_UI_THEME === 'light') {
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='light'");
    result.theme = 'light';
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  const output = process.argv[2] && path.resolve(process.argv[2]);
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG()); fs.writeFileSync(output + '.json', JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify({ ok: true, fixture: 'real Electron / production service and journal / synthetic game and payload', ...result }, null, 2));
  win.destroy(); app.exit(0);
 } catch (e) { console.error(e.stack); if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); win.destroy(); } app.exit(1); }
});

async function experience() {
 const until = async (fn, label) => { const end = Date.now() + 15000; while (!fn()) { if (Date.now() > end) throw Error('timeout ' + label); await new Promise(r => setTimeout(r, 15)); } };
 const check = (v, label) => { if (!v) throw Error(label); }, times = { interaction: [], cachedPage: [] };
 const host = () => document.querySelector('.game-card.expanded .game-detail'), state = () => host()?.__gpController.getState();
 const click = name => { const item = host()?.querySelector('[data-gp-action="' + name + '"]'); check(item && !item.disabled, 'unavailable ' + name); item.click(); };
 const set = (group, key, value) => { const item = host().querySelector('[data-gp-group="' + group + '"][data-gp-field="' + key + '"]'); check(item && !item.disabled, 'field ' + key); item.value = value; const at = performance.now(); item.dispatchEvent(new Event(item.type === 'number' || item.type === 'range' ? 'input' : 'change', { bubbles: true })); times.interaction.push(performance.now() - at); };
 await until(() => document.getElementById('addGameBtn') && !document.body.classList.contains('is-busy'), 'startup');
 const add = performance.now(); document.getElementById('addGameBtn').click();
 await until(() => !document.getElementById('gamePickerModal').classList.contains('hidden'), 'game picker');
 document.getElementById('confirmGameBtn').click();
 await until(() => document.querySelector('.open-game-page-btn'), 'added game'); times.addMs = performance.now() - add;
 document.querySelector('.open-game-page-btn').click(); await until(() => state()?.loaded.includes('installation'), 'installation');
 const id = state().id; check(!state().data.game.installed, 'starts uninstalled');
 set('route', 'api', 'dx12'); await until(() => state()?.data.game.apiOverride === 'dx12' && state().data.api.effectiveApi === 'dx12' && state().loaded.includes('installation'), 'metadata save');
 check(!state().data.game.installed, 'API selection must not install');
 click('prepare'); await until(() => !state().busy, 'missing DLC'); check(!state().data.operation.pending, 'missing DLC is not recovery');
 click('import-runtime'); await new Promise(r => setTimeout(r, 80)); check(state().data.game.apiOverride === 'dx12', 'cancel preserves API');
 const start = performance.now(); click('import-runtime'); await until(() => state()?.data.game.installed && !state().busy, 'import resumes Apply'); times.importAndApplyMs = performance.now() - start;
 check(!host().querySelector('.gp-modal'), 'one Apply must not demand another confirmation');
 check(!host().querySelector('[data-gp-action="import-runtime"]'), 'complete installed runtime hides import prompt');
 const imported = await window.__flow('evidence', id); check(imported.ok && imported.value.preferences === 1, 'real preference saved once'); check(!imported.value.pending.pending, 'no transaction left behind');
 set('route', 'version', '0.4.2'); click('preview'); await until(() => !state().busy && state().data.game.addonVersion === '0.4.2', 'replace Core');
 set('route', 'version', '0.4.7beta'); click('preview'); await until(() => !state().busy && state().data.game.addonVersion === '0.4.7beta', 'rollback Core');
 await window.__flow('running', true); host().querySelector('[data-gp-tab="nr"]').click(); set('nr', 'Intensity', '1.3456789'); click('preview'); await until(() => !state().busy && state().data.waiting?.pending, 'queued'); check(!state().data.operation.pending, 'queued is not recovery');
 click('cancel-waiting'); await until(() => !state().busy && !state().data.waiting?.pending, 'cancel wait');
 await window.__flow('running', false);
 for (const next of ['enhance', 'overview', 'nr', 'overview']) { host().querySelector('[data-gp-tab="' + next + '"]').click(); await until(() => state().loaded.includes(({ enhance: 'enhancements', nr: 'installation', overview: 'installation' })[next]), 'load tab'); }
 for (let i = 0; i < 25; i++) { const at = performance.now(); host().querySelector('[data-gp-tab="' + (i % 2 ? 'overview' : 'enhance') + '"]').click(); times.cachedPage.push(performance.now() - at); }
 const p95 = rows => [...rows].sort((a, b) => a - b)[Math.ceil(rows.length * .95) - 1];
 times.interactionP95 = p95(times.interaction); times.cachedPageP95 = p95(times.cachedPage);
 check(times.interactionP95 <= 100 && times.cachedPageP95 <= 500, 'interaction latency gate');
 host().querySelector('[data-gp-tab="overview"]').click(); await document.fonts.ready;
 host().scrollIntoView({ block: 'start' }); await new Promise(r => setTimeout(r, 200));
 check(host().scrollWidth <= host().clientWidth + 2, 'game settings horizontal overflow');
 times.viewport = { width: innerWidth, height: innerHeight, scale: devicePixelRatio };
 return { covered: ['add game', 'mixed API selection', 'missing DLC', 'cancel import', 'import resumes single Apply', 'Core replace', 'Core rollback', 'queue distinct from recovery', 'cancel queue'], timings: times };
}
