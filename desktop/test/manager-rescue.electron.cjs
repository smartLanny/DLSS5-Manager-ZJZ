'use strict';
// Real renderer -> AppService -> external-runtime -> on-disk transaction.
// Game, GPU and Core are inert fixtures. No game, helper or DLL is executed.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { createExperienceFixture } = require('./helpers/manager-experience-fixture.cjs');
const { INSTALLED_NAMES } = require('../src/product/constants');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-rescue-'));
const output = path.resolve(process.argv[2] || path.join(root, 'evidence')); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(root, 'electron')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tree = dir => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(row => {
  const file = path.join(dir, row.name); return row.isDirectory() ? Object.entries(tree(file)).map(([name, value]) => [row.name + '/' + name, value]) : [[row.name, sha(file)]];
}));
let f, win, id, editedHash, originalTree, ini, runtime, launchCalls = 0, lastRescue = null;
ipcMain.handle('rescue-production', async (_event, method, ...args) => {
  try {
    let value;
    if (method === 'assessGame') value = await f.assessment.assess(...args);
    else if (method === 'boot') value = await f.service.boot();
    else if (method === 'listGames' || method === 'refresh') value = await f.service[method]();
    else if (['readNrSettings', 'previewDeploymentRescue'].includes(method)) value = await f.service[method](...args);
    else if (method === 'applyDeploymentRescue') value = lastRescue = await f.service.applyDeploymentRescue(...args);
    else if (method === 'removeGame') value = await f.service.dismissGame(args[0], args[1]);
    else if (method === 'requestOperation') value = await f.deferred.submit(...args);
    else if (method === 'launch' || method === 'hoyoStart') { launchCalls++; throw Error('Game launch forbidden by fixture'); }
    else if (method === 'evidence') {
      const state = await f.service.inspectDeployment(id);
      const wal = lastRescue?.archiveDirectory && fs.existsSync(path.join(lastRescue.archiveDirectory, 'operation.json'))
        ? JSON.parse(fs.readFileSync(path.join(lastRescue.archiveDirectory, 'operation.json'))) : null;
      const row = wal?.files.find(item => item.file === ini);
      value = { state, treeUnchanged: JSON.stringify(tree(f.gameDir)) === JSON.stringify(originalTree), launchCalls,
        editedIniArchived: Boolean(row && row.before === editedHash && sha(path.join(lastRescue.archiveDirectory, row.snapshot)) === editedHash),
        foreignPreserved: fs.readFileSync(path.join(root, 'foreign', 'keep.ini'), 'utf8') === 'private',
        unrelatedPreserved: fs.readFileSync(path.join(runtime, 'unrelated.addon64'), 'utf8') === 'unrelated',
        personalIni: fs.existsSync(path.join(runtime, 'nr_before_sr.ini')) ? fs.readFileSync(path.join(runtime, 'nr_before_sr.ini'), 'utf8') : null };
    } else if (method === 'reinstall') {
      const plan = await f.service.previewDeployment(id, { mode: 'external', api: 'dx12', version: '0.4.7beta' });
      value = await f.service.applyDeployment(plan.planId);
    } else if (method === 'capture') {
      const file = path.join(output, 'rescue-confirmation.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); value = file;
    } else throw Error('Unknown fixture method ' + method);
    return { ok: true, value };
  } catch (error) { console.error('fixture IPC', method, error.code, error.message); return { ok: false, error: { code: error.code, message: error.message, details: error.details } }; }
});
app.whenReady().then(async () => {
  try {
    f = await createExperienceFixture(path.join(root, 'fixture')); await f.service.boot(); await f.add();
    id = (await f.service.listGames())[0].id;
    await f.service.setGameApiPreference(id, 'dx12'); await f.service.importRuntimeDlc(f.dlc);
    const plan = await f.service.previewDeployment(id, { mode: 'external', api: 'dx12', version: '0.4.7beta' });
    await f.service.applyDeployment(plan.planId);
    const layout = f.service.getLayout(id); runtime = layout.runtimeDir; ini = path.join(path.dirname(f.exe), 'ReShade.ini');
    fs.mkdirSync(path.join(root, 'foreign')); fs.writeFileSync(path.join(root, 'foreign', 'keep.ini'), 'private');
    fs.writeFileSync(ini, `[GENERAL]\nBasePath=${path.join(root, 'foreign')}\n[ADDON]\nAddonPath=${path.join(root, 'foreign')}\n`);
    editedHash = sha(ini); fs.unlinkSync(path.join(runtime, INSTALLED_NAMES.addon));
    fs.writeFileSync(path.join(runtime, 'nr_before_sr.ini'), '[NRBeforeSR]\nIntensity=1.23456789\n');
    fs.writeFileSync(path.join(runtime, 'unrelated.addon64'), 'unrelated'); originalTree = tree(f.gameDir);
    const diagnostic = await f.service.diagnose(id);
    if (diagnostic.complete !== false || !diagnostic.deployment.rescue.available) throw Error('Broken binding must retain actionable diagnostics');
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `(${installMock.toString()})({on40:{},hoyoProfiles:[]},${JSON.stringify({ captureOnly: true, paths: { gameDir: f.gameDir, exe: f.exe, ini } })});\n` +
      `const {ipcRenderer:r}=require('electron');for(const m of ['boot','listGames','refresh','assessGame','readNrSettings','previewDeploymentRescue','applyDeploymentRescue','removeGame','requestOperation','launch','hoyoStart'])window.manager[m]=(...a)=>r.invoke('rescue-production',m,...a);window.__realRescue=(m,...a)=>r.invoke('rescue-production',m,...a);`);
    win = new BrowserWindow({ width: 1050, height: 780, show: false, useContentSize: true,
      webPreferences: { preload, contextIsolation: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('preload-error', (_event, _file, error) => console.error(error.stack));
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(id)})`);
    const report = { ok: true, ...result, launchCalls, scope: 'Real Electron renderer and production AppService/external-runtime/WAL; inert synthetic game/Core/GPU, no game launched', fixtureRoot: root };
    fs.writeFileSync(path.join(output, 'manager-rescue.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(0);
  } catch (error) {
    console.error(error.stack); if (win && !win.isDestroyed()) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); fs.writeFileSync(path.join(output, 'failed.png'), (await win.webContents.capturePage()).toPNG()); win.destroy(); } app.exit(1);
  }
});
async function exercise(id) {
  const checks = [], check = (value, name) => { if (!value) throw Error(name); checks.push(name); };
  const until = async (fn, name) => { const end = Date.now() + 25000; while (!fn()) { if (Date.now() > end) throw Error('timeout: ' + name); await new Promise(r => setTimeout(r, 20)); } };
  const host = () => document.querySelector('.game-card.expanded .game-detail');
  const click = name => { const b = host().querySelector(`[data-gp-action="${name}"]`); check(b && !b.disabled, name + ' reachable'); b.click(); };
  const maintenance = () => { const details = host().querySelector('[data-gp-detail="maintenance"]'); check(details, 'maintenance section reachable'); if (!details.open) details.querySelector('summary').click(); };
  const evidence = async () => { const result = await window.__realRescue('evidence'); check(result.ok, 'production evidence readable'); return result.value; };
  await until(() => document.querySelector('.open-game-page-btn'), 'library'); document.querySelector('.open-game-page-btn').click();
  await until(() => host()?.__gpController.getState().loaded.includes('installation'), 'broken installation renders');
  click('maintenance-tab'); await until(() => host().querySelector('[data-gp-action="rescue-repair"]'), 'recovery entry');
  click('rescue-repair'); await until(() => host().querySelector('.gp-modal'), 'actual repair preview');
  check(host().querySelector('.gp-modal').textContent.includes('ReShade.ini'), 'actual loader change shown');
  await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 180));
  await window.__realRescue('capture'); click('modal-cancel'); check((await evidence()).treeUnchanged, 'cancel is byte-for-byte no write');
  click('rescue-repair'); await until(() => host().querySelector('.gp-modal'), 'second actual repair preview'); click('modal-apply');
  await until(() => !host().__gpController.getState().busy && !host().querySelector('.gp-modal'), 'repair completed');
  let result = await evidence(); check(result.state.ready, 'production deployment ready after repair'); check(result.editedIniArchived, 'edited loader byte hash verified in archive');
  check(result.personalIni.includes('Intensity=1.23456789'), 'personal precision retained'); check(result.foreignPreserved, 'foreign path untouched');
  maintenance(); await until(() => host().querySelector('[data-gp-action="rescue-clean"]'), 'clean reachable');
  click('rescue-clean'); await until(() => host().querySelector('.gp-modal'), 'actual clean preview'); click('modal-apply');
  await until(() => !host().__gpController.getState().busy && !host().querySelector('.gp-modal'), 'clean completed');
  result = await evidence(); check(!result.state.installed, 'production state uninstalled'); check(result.unrelatedPreserved && result.foreignPreserved, 'unrelated files retained');
  const reinstall = await window.__realRescue('reinstall'); check(reinstall.ok, 'production install works after clean without manually deleting leftovers');
  await host().__gpController.refresh(true); maintenance(); await until(() => host().querySelector('[data-gp-action="remove-game"]'), 'library exit');
  click('remove-game'); click('modal-cancel'); check(document.querySelector('.open-game-page-btn'), 'cancel retains game');
  click('remove-game'); click('remove-confirm'); await until(() => !document.querySelector(`[data-id="${id}"]`), 'actual metadata removal');
  return { checks, count: checks.length };
}
