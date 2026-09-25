'use strict';
// Production renderer -> deferred/operation plan -> AppService/installer/journal.
// The temporary EXE, GPU and payload bytes are inert fixtures and never loaded.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { createExperienceFixture } = require('./helpers/manager-experience-fixture.cjs');
const { createOperationPlans } = require('../src/product/operation-plan');
const { createDeferredOperations } = require('../src/product/deferred-operations');
const { createWorkScheduler } = require('../src/product/work-scheduler');
const { readManifest } = require('../src/product/manifest');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-proxy-conflicts-'));
const output = path.resolve(process.argv[2] || path.join(root, 'evidence')); fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(root, 'electron')); app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tree = dir => Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(row => {
  const file = path.join(dir, row.name); return row.isDirectory() ? Object.entries(tree(file)).map(([name, digest]) => [row.name + '/' + name, digest]) : [[row.name, sha(file)]];
}));
let f, win, id, operations, deferred, plugin, pluginHash, personalIniHash, cancelBaseline, retainedBackup, launchCalls = 0, applyCalls = 0, lastPlan = null;
function addonBytes(name, marker = '') {
  const b = Buffer.alloc(0x800), p = 0x80, o = p + 24, section = o + 0xf0;
  b.write('MZ'); b.writeUInt32LE(p, 0x3c); b.write('PE\0\0', p); b.writeUInt16LE(0x8664, p + 4);
  b.writeUInt16LE(1, p + 6); b.writeUInt16LE(0xf0, p + 20); b.writeUInt16LE(0x20b, o);
  b.writeBigUInt64LE(0x180000000n, o + 24); b.writeUInt32LE(0x200, o + 60);
  b.writeUInt32LE(0x1000, o + 112); b.writeUInt32LE(0x90, o + 116); b.write('.data', section);
  b.writeUInt32LE(0x600, section + 8); b.writeUInt32LE(0x1000, section + 12);
  b.writeUInt32LE(0x600, section + 16); b.writeUInt32LE(0x200, section + 20);
  b.writeUInt32LE(1, 0x214); b.writeUInt32LE(1, 0x218); b.writeUInt32LE(0x1040, 0x21c);
  b.writeUInt32LE(0x1044, 0x220); b.writeUInt32LE(0x1048, 0x224);
  b.writeUInt32LE(0x1100, 0x240); b.writeUInt32LE(0x1050, 0x244); b.write('NAME\0', 0x250);
  b.writeBigUInt64LE(0x180001140n, 0x300); b.write(name + '\0', 0x340); b.write(marker, 0x500);
  return b;
}

async function createFlow() {
  // This fixture owns no SR/FG settings. The inactive coordinator is explicit;
  // all deployment, conflict decisions, backups, restores and file writes use production owners.
  const settings = { assertReady: async () => {}, inspect: async () => ({ applied: {}, requests: {}, pending: [] }), pending: async () => [] };
  const environment = { assertReady: async () => {}, inspect: async () => ({ files: [], remainingFiles: [] }), recoverPending: async () => {} };
  operations = createOperationPlans({ userData: path.join(root, 'fixture', 'user-data'), service: f.service, settings,
    components: { inspect: async () => ({}) }, environment, preparation: { assertReady: async () => {}, inspect: async () => ({ pending: false }) },
    guards: { assertGameClosed: async () => {} }, restoreForUninstall: async () => assert.deepEqual((await settings.inspect()).applied, {}) });
  const scheduler = createWorkScheduler();
  deferred = createDeferredOperations({ userData: path.join(root, 'fixture', 'user-data'), service: f.service, operations,
    run: (key, action) => scheduler.run(key, action), assertClosed: async () => {} });
}
function evidence() {
  const dir = path.dirname(f.exe), manifest = readManifest(f.gameDir);
  const conflict = manifest?.conflicts?.find(row => row.sourceRel === path.relative(f.gameDir, plugin || ''));
  if (conflict) retainedBackup = path.join(f.gameDir, conflict.backupRel);
  const config = path.join(dir, 'nr_before_sr.ini');
  return { defaultEntry: f.service.installationDefaults(id).proxyEntry, route: manifest?.reshadeRoute || null, version: manifest?.payloadVersion || null,
    d3d12: fs.existsSync(path.join(dir, 'd3d12.dll')), dxgi: fs.existsSync(path.join(dir, 'dxgi.dll')),
    iniHash: fs.existsSync(config) ? sha(config) : null, personalIniHash,
    pluginPresent: Boolean(plugin && fs.existsSync(plugin)), pluginHash: plugin && fs.existsSync(plugin) ? sha(plugin) : null,
    originalPluginHash: pluginHash, backupHash: retainedBackup && fs.existsSync(retainedBackup) ? sha(retainedBackup) : null,
    backupPath: retainedBackup || null, treeUnchanged: cancelBaseline ? JSON.stringify(tree(f.gameDir)) === JSON.stringify(cancelBaseline) : null,
    lastPlan, launchCalls, applyCalls };
}
ipcMain.handle('proxy-conflict-production', async (event, method, ...args) => {
  if (event.sender !== win.webContents) throw Error('unexpected sender');
  try {
    let value;
    if (method === 'boot') value = await f.service.boot();
    else if (method === 'listGames' || method === 'refresh') value = await f.service[method]();
    else if (method === 'assessGame') value = await f.assessment.assess(...args);
    else if (method === 'readNrSettings') value = await f.service.readNrSettings(...args);
    else if (method === 'requestOperation') { value = await deferred.submit(...args); lastPlan = value.plan || null; }
    else if (method === 'previewOperation') value = lastPlan = await operations.preview(...args);
    else if (method === 'applyOperation' || method === 'applyOperationElevated') { applyCalls++; value = await deferred.apply(...args); }
    else if (method === 'launch' || method === 'hoyoStart') { launchCalls++; throw Error('Fixture must never launch a game or DLL'); }
    else if (method === 'evidence') value = evidence();
    else if (method === 'personalize') {
      const config = path.join(path.dirname(f.exe), 'nr_before_sr.ini');
      fs.writeFileSync(config, '[NRBeforeSR]\r\nEnabled=1\r\nIntensity=1.23456789\r\nWorkMode=0\r\n; owner precision and comment retained\r\n');
      personalIniHash = sha(config); value = evidence();
    } else if (method === 'add-conflict') {
      plugin = path.join(path.dirname(f.exe), 'neutral-declared.addon64');
      fs.writeFileSync(plugin, addonBytes('RenoDX Generic NR')); pluginHash = sha(plugin); cancelBaseline = tree(f.gameDir); value = evidence();
    } else if (method === 'capture') {
      const file = path.join(output, args[0] + '.png'); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); value = file;
    } else throw Error('unknown fixture call ' + method);
    return { ok: true, value };
  } catch (error) { console.error('fixture IPC', method, error.code, error.message); return { ok: false, error: { code: error.code, message: error.message, details: error.details } }; }
});
app.whenReady().then(async () => {
  try {
    f = await createExperienceFixture(path.join(root, 'fixture'), { executableName: 'HTGame.exe' });
    await f.service.boot(); await f.add(); id = (await f.service.listGames())[0].id;
    await f.service.setGameApiPreference(id, 'dx12'); await f.service.importRuntimeDlc(f.dlc); await createFlow();
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `(${installMock.toString()})({on40:{},hoyoProfiles:[]},${JSON.stringify({ captureOnly: true, paths: { gameDir: f.gameDir, exe: f.exe, ini: path.join(path.dirname(f.exe), 'nr_before_sr.ini') } })});\n` +
      `const {ipcRenderer:r}=require('electron');for(const method of ['boot','listGames','refresh','assessGame','readNrSettings','requestOperation','previewOperation','applyOperation','applyOperationElevated','launch','hoyoStart'])window.manager[method]=(...args)=>r.invoke('proxy-conflict-production',method,...args);window.__production=(method,...args)=>r.invoke('proxy-conflict-production',method,...args);`);
    win = new BrowserWindow({ width: 1120, height: 800, show: false, useContentSize: true,
      webPreferences: { preload, contextIsolation: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.on('preload-error', (_event, _file, error) => console.error(error.stack));
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(id)})`);
    const report = { ok: true, ...result, launchCalls, scope: 'Real Electron renderer, AppService, deferred operations, installer and journal; inert game/Core/GPU and inactive SR/FG coordinator', fixtureRoot: root, actualGameValidation: false };
    fs.writeFileSync(path.join(output, 'manager-proxy-conflicts.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win && !win.isDestroyed()) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); fs.writeFileSync(path.join(output, 'failed.png'), (await win.webContents.capturePage()).toPNG()); win.destroy(); } app.exit(1); }
});
async function exercise(id) {
  const checks = [], check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const until = async (fn, label) => { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw Error('timeout ' + label); await new Promise(resolve => setTimeout(resolve, 20)); } };
  const host = () => document.querySelector(`[data-id="${id}"] .game-detail`), state = () => host().__gpController.getState();
  const call = async (method, ...args) => { const result = await window.__production(method, ...args); check(result.ok, method + ' returned production result'); return result.value; };
  const click = name => { const button = host().querySelector(`[data-gp-action="${name}"]`); check(button && !button.disabled, name + ' reachable'); button.click(); };
  const version = value => {
    const row = [...host().querySelectorAll('[data-gp-field="version"]')].find(node => [...node.options].some(option => option.value === value));
    check(row && !row.disabled, 'Core candidate ' + value + ' reachable'); if (row.closest('details')) row.closest('details').open = true;
    row.value = value; row.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const idle = () => !state().busy && !host().querySelector('.gp-modal');
  await until(() => document.querySelector(`[data-id="${id}"] .open-game-page-btn`), 'library'); document.querySelector(`[data-id="${id}"] .open-game-page-btn`).click();
  await until(() => host()?.__gpController.getState().loaded.includes('installation'), 'initial assessment');
  check(host().querySelector('.gp-proxy-entry')?.textContent.includes('加载入口：D3D12'), 'HTGame first installation visibly defaults to D3D12');
  click('prepare'); await until(() => idle() && state().data.game.installed, 'initial unified Apply');
  let data = await call('evidence'); check(data.d3d12 && !data.dxgi && data.route === 'd3d12', 'production installer wrote only default D3D12 proxy'); check(data.launchCalls === 0, 'initial Apply did not auto-launch');
  await call('personalize'); await host().__gpController.refresh(true);
  version('0.4.2'); click('preview'); await until(() => idle() && state().data.game.addonVersion === '0.4.2', 'Core replacement');
  data = await call('evidence'); check(data.route === 'd3d12' && data.d3d12 && !data.dxgi && data.iniHash === data.personalIniHash, 'Core update preserves exact personal INI bytes and D3D12 entry');
  click('switch-proxy'); check(state().draft.proxyEntry === 'dxgi', 'short switch stages DXGI');
  data = await call('evidence'); check(data.d3d12 && !data.dxgi, 'staging proxy choice writes no files');
  click('preview'); await until(idle, 'explicit DXGI switch'); data = await call('evidence');
  check(data.route === 'dxgi' && data.dxgi && !data.d3d12 && data.iniHash === data.personalIniHash, 'unified Apply switches actual proxy and preserves INI');
  check(data.launchCalls === 0, 'proxy Apply does not auto-launch');
  await call('add-conflict'); version('0.4.7beta'); click('preview');
  await until(() => !state().busy && host().querySelector('.gp-nr-conflicts'), 'production NR conflict confirmation');
  data = await call('evidence');
  check(data.lastPlan.nrConflicts.required && data.lastPlan.nrConflicts.files.some(row => row.classification === 'renodx-generic-nr'), 'backend recognizes declared Generic NR and requires confirmation');
  check(data.treeUnchanged && data.pluginPresent, 'real conflict preview changes no game bytes');
  check(host().querySelector('[data-gp-action="modal-apply"]').textContent === '备份冲突并应用' && [...host().querySelectorAll('.gp-modal details')].every(row => !row.open), 'real conflict uses short folded confirmation');
  await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 120)); await call('capture', 'production-conflict-confirmation');
  click('modal-cancel'); data = await call('evidence'); check(data.treeUnchanged && state().draft.version === '0.4.7beta', 'cancel preserves every game byte and the Core draft');
  click('preview'); await until(() => !state().busy && host().querySelector('.gp-nr-conflicts'), 'new actual conflict preview'); click('modal-apply');
  await until(() => idle() && state().data.game.addonVersion === '0.4.7beta', 'confirmed conflict install');
  data = await call('evidence'); check(!data.pluginPresent && data.backupHash === data.originalPluginHash, 'confirmed installer isolates original addon and verifies backup hash');
  check(data.iniHash === data.personalIniHash && data.route === 'dxgi', 'conflict install retains personal INI and chosen entry');
  version('0.4.2'); click('preview'); await until(() => idle() && state().data.game.addonVersion === '0.4.2', 'Core update after isolation');
  data = await call('evidence'); check(!data.pluginPresent && data.backupHash === data.originalPluginHash, 'later Core update never restores isolated NR conflict');
  host().__gpController.selectTab('maintenance'); await until(() => host().querySelector('[data-gp-action="uninstall-restore"]'), 'uninstall maintenance');
  click('uninstall-restore'); await until(() => !state().busy && host().querySelector('.gp-modal'), 'uninstall restore preview'); click('modal-apply');
  await until(() => idle() && !state().data.game.installed, 'real uninstall restore');
  data = await call('evidence'); check(data.pluginPresent && data.pluginHash === data.originalPluginHash, 'uninstall restore recovers exact original Generic NR hash');
  check(data.backupHash === data.originalPluginHash && data.launchCalls === 0, 'original backup remains and complete flow never launches');
  return { checks, count: checks.length, originalPluginHash: data.originalPluginHash, restoredPluginHash: data.pluginHash, retainedBackupHash: data.backupHash };
}
