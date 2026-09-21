'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { buildOverview } = require('../src/product/component-overview');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-components-ui-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
function inventory() {
  const packages = ['bridge', 'feeder', 'mfg', 'dlssg-sm86'].map((kind, i) => ({ kind, id: kind + '-bundled', source: 'bundled', validation: 'candidate',
    version: kind === 'bridge' ? '1.4.13-pre8' : kind === 'mfg' ? '1.0' : '0.3.5', interface: kind === 'feeder' ? 'ExternalProviderV1' : 'NGX-D3D12-Feature1',
    requiredCoreCapabilities: kind === 'feeder' ? ['fence'] : [], filesReady: true, files: [{ name: 'module.addon64', sha256: String(i).repeat(64) }] }));
  const catalog = { checkedAt: new Date().toISOString(), packages: [{ id: 'mfg-new', kind: 'mfg', version: '1.1', sha256: 'a'.repeat(64), downloadUrl: 'https://github.com/fixture', compatibilityVerified: true },
    { id: 'bridge-alias', kind: 'bridge', version: '1.4.13-pre8', sha256: '0'.repeat(64), downloadUrl: 'https://github.com/fixture' }] };
  return { packages, catalog, storage: { root: 'D:\\Manager\\data\\components' }, warnings: [], runtimeSetup: { runtimeDlcRequired: true, hardwareFamily: 'RTX40', ready: true },
    componentOverview: buildOverview({ packages, catalog, currentCore: { inputInterfaces: ['NGX-D3D12-Feature1'] } }) };
}
app.whenReady().then(async () => {
  let win;
  try {
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `(${installMock.toString()})({on40:{},hoyoProfiles:[]},{captureOnly:true,paths:{gameDir:'C:\\\\UI-fixture',exe:'C:\\\\UI-fixture\\\\Game.exe',ini:'C:\\\\UI-fixture\\\\nr_before_sr.ini'}});\n` +
      `const fixtureData=${JSON.stringify(inventory())};window.__componentCalls={list:0,updates:0,imports:0,downloads:0,updateError:false,downloadError:false};
      window.manager.listComponents=async()=>{window.__componentCalls.list++;await new Promise(r=>setTimeout(r,80));return {ok:true,value:fixtureData};};
      window.manager.checkComponentUpdates=async()=>{window.__componentCalls.updates++;await new Promise(r=>setTimeout(r,200));return {ok:true,value:window.__componentCalls.updateError?[{kind:'bridge',error:{code:'HTTP_503',message:'下载源暂时不可用'}}]:[]};};
      window.manager.pickComponent=async()=>{window.__componentCalls.imports++;await new Promise(r=>setTimeout(r,350));return {ok:true,value:null};};
      window.manager.downloadComponent=async()=>{window.__componentCalls.downloads++;await new Promise(r=>setTimeout(r,300));if(window.__componentCalls.downloadError)return {ok:false,error:{code:'COMPONENT_HASH_MISMATCH',message:'下载文件摘要不符'}};fixtureData.componentOverview.updates=[];return {ok:true,value:{changedGames:false}};};`);
    win = new BrowserWindow({ width: Number(process.env.GAME_UI_WIDTH) || 1100, height: Number(process.env.GAME_UI_HEIGHT) || 820,
      show: false, useContentSize: true, webPreferences: { preload, contextIsolation: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    const errors = []; win.webContents.on('console-message', (_event, ...args) => { const entry = args[0]; if (entry?.level === 'error') errors.push(entry.message); });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    win.webContents.setZoomFactor(Number(process.env.GAME_UI_ZOOM) || 1);
    const result = await win.webContents.executeJavaScript(`(${exercise.toString()})()`);
    result.consoleErrors = errors;
    const output = process.argv[2] && path.resolve(process.argv[2]);
    if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG()); fs.writeFileSync(output + '.json', JSON.stringify(result, null, 2)); }
    console.log(JSON.stringify({ ok: true, fixture: 'Real Electron / production component UI / synthetic inventory', ...result }, null, 2)); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); win.destroy(); } app.exit(1); }
});
async function exercise() {
  const check = (condition, label) => { if (!condition) throw Error(label); };
  const until = async (fn, label) => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw Error('timeout ' + label); await new Promise(r => setTimeout(r, 10)); } };
  await until(() => document.querySelector('[data-view="addons"]') && !document.body.classList.contains('is-busy'), 'boot');
  check(window.__componentCalls.list === 0 && window.__componentCalls.updates === 0, 'hidden component page must not verify inventory or fetch releases');
  document.querySelector('[data-view="addons"]').click();
  await until(() => document.querySelectorAll('.component-package-summary').length === 4, 'bundled summaries');
  check(document.querySelectorAll('#componentUpdateRows button').length === 1, 'only compatible update, no alias downloads');
  check(document.querySelector('#componentUpdateRows button').getClientRects().length > 0, 'update is visibly reachable');
  check(document.getElementById('componentRuntimeGuide').classList.contains('hidden'), 'ready DLC must not show missing-runtime guide');
  check(document.getElementById('componentLibraryRows').textContent.includes('待适配'), 'Feeder missing Core contract visible');
  check(!document.getElementById('componentProviderSelect') && !document.getElementById('applyBridgeComponentBtn'), 'no duplicated game mutation controls');
  document.querySelector('.component-advanced').open = true;
  document.getElementById('importComponentBtn').click();
  check(!document.getElementById('checkComponentUpdatesBtn').disabled && !document.getElementById('importRuntimeDlcBtn').disabled, 'file picker must not globally disable controls');
  document.querySelector('[data-view="settings"]').click();
  check(document.getElementById('view-settings').classList.contains('active'), 'navigation remains usable during import');
  await until(() => document.getElementById('componentLibraryMessage').textContent.includes('已取消'), 'cancel import');
  document.querySelector('[data-view="addons"]').click();
  document.getElementById('checkComponentUpdatesBtn').click();
  await until(() => !document.getElementById('checkComponentUpdatesBtn').disabled, 'check updates');
  check(window.__componentCalls.updates === 1, 'update check explicit only');
  window.__componentCalls.updateError = true; document.getElementById('checkComponentUpdatesBtn').click();
  await until(() => !document.getElementById('checkComponentUpdatesBtn').disabled, 'failed update check');
  check(document.getElementById('componentLibraryMessage').textContent.includes('Bridge：[HTTP_503]'), 'update error names its component and error code');
  window.__componentCalls.downloadError = true; document.querySelector('#componentUpdateRows button').click();
  await until(() => document.getElementById('componentLibraryMessage').textContent.includes('COMPONENT_HASH_MISMATCH'), 'failed download');
  check(document.getElementById('componentLibraryMessage').textContent.includes('RTX 40 多帧生成') && !document.querySelector('#componentUpdateRows button').disabled, 'download failure keeps component identity and retry entry');
  window.__componentCalls.downloadError = false;
  document.querySelector('#componentUpdateRows button').click();
  check(!document.getElementById('importComponentBtn').disabled, 'downloading does not block imports');
  await until(() => !document.querySelector('#componentUpdateRows button'), 'downloaded update disappears');
  await until(() => document.getElementById('componentLibraryMessage').textContent.includes('更新已准备'), 'download completion');
  check(window.__componentCalls.downloads === 2, 'single requested download');
  document.querySelector('.component-advanced').open = false;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  check(document.documentElement.scrollWidth <= innerWidth + 1, 'no horizontal overflow');
  return { groups: 4, aliasDownloadSuppressed: true, feederPendingAdaptation: true, lazyInventory: true, explicitUpdate: true,
    independentOperations: true, cancelledImportRecovered: true, noOverflow: true, calls: window.__componentCalls, viewport: { width: innerWidth, height: innerHeight } };
}
