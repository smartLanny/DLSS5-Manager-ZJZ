'use strict';
// Real renderer -> production service/plan/deferred/installer/WAL. All game,
// host and Core bytes are inert fixtures; PE identity and GPU evidence are synthetic.
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { createExperienceFixture } = require('./helpers/manager-experience-fixture.cjs');
const { readManifest } = require('../src/product/manifest');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-adoption-ui-'));
const output = path.resolve(process.argv[2] || path.join(root, 'evidence'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(root, 'electron')); app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const progress = message => fs.appendFileSync(path.join(output, 'manager-adoption-progress.log'), new Date().toISOString() + ' ' + message + '\n');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function tree(directory, base = directory) {
  return Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap(row => {
    const file = path.join(directory, row.name);
    return row.isDirectory() ? Object.entries(tree(file, base)) : [[path.relative(base, file), digest(file)]];
  }).sort(([a], [b]) => a.localeCompare(b)));
}
let active, win;
ipcMain.handle('adoption-experience', async (event, name, ...args) => {
  if (event.sender !== win?.webContents) throw Error('unexpected renderer');
  const { fixture: f, stats } = active;
  progress(active.kind + ': ' + name);
  try {
    let value;
    if (name === 'boot') value = await f.service.boot();
    else if (name === 'listGames') value = await f.service.listGames();
    else if (name === 'refresh') value = await f.service.refresh();
    else if (name === 'selection') value = { root: f.gameDir, name: '旧安装接管 · 合成验收',
      chosen: { path: f.exe, name: 'Game.exe', bitness: 64, apiLabel: 'DX11 / DX12' },
      candidates: [{ path: f.exe, name: 'Game.exe', bitness: 64, apiLabel: 'DX11 / DX12' }] };
    else if (name === 'confirmGame') { await f.add(); value = await f.service.listGames(); }
    else if (name === 'assessGame') value = await f.assessment.assess(...args);
    else if (name === 'setGameApiPreference') { stats.apiSaves++; value = await f.service.setGameApiPreference(...args); }
    else if (name === 'requestOperation') { stats.requests++; value = await f.deferred.submit(...args); }
    else if (name === 'previewOperation') value = await f.operations.preview(...args);
    else if (name === 'applyOperation') { stats.confirmations++; value = await f.deferred.apply(...args); }
    else if (name === 'pickRuntimeDlc') {
      if (!stats.importAttempts++) { stats.cancelledImports++; value = null; }
      else { value = await f.service.importRuntimeDlc(f.dlc); stats.imports++; }
    }
    else if (name === 'readPayloadSource') value = f.service.payloadState();
    else if (name === 'readNrSettings') value = await f.service.readNrSettings(...args);
    else if (name === 'cancelWaitingOperation') value = await f.deferred.cancel(...args);
    else if (name === 'launch' || name === 'hoyoStart') { stats.launchCalls++; throw Error('This fixture must never launch a game'); }
    else if (name === 'evidence') {
      const current = tree(f.gameDir), manifest = readManifest(f.gameDir);
      const backedUp = (manifest?.files || []).filter(row => row.original.existed).map(row => ({
        name: path.basename(row.rel), originalSha256: row.original.sha256,
        backupSha256: digest(path.join(f.gameDir, row.original.backupRel)),
        originalMatchesFixture: active.original[path.normalize(row.rel)] === row.original.sha256
      }));
      value = { stats: { ...stats }, gameUnchanged: JSON.stringify(current) === JSON.stringify(active.original),
        manifestVersion: manifest?.payloadVersion || null, backedUp,
        iniPreserved: digest(path.join(path.dirname(f.exe), 'nr_before_sr.ini')) === active.originalIni,
        installedHostIsAddon: fs.readFileSync(path.join(path.dirname(f.exe), 'dxgi.dll')).includes('Searching for add-ons'),
        pending: await f.operations.inspect(args[0]), noAutoLaunch: stats.launchCalls === 0 };
      active.latestEvidence = value;
    }
    else if (name === 'capture') {
      if (!/^[a-z0-9-]+$/.test(args[0])) throw Error('invalid screenshot name');
      const file = path.join(output, active.kind + '-' + args[0] + '.png');
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); active.screenshots.push(file); value = file;
    } else throw Error('unknown adoption fixture method: ' + name);
    return { ok: true, value };
  } catch (error) { return { ok: false, error: { code: error.code, message: error.message, details: error.details } }; }
});

app.whenReady().then(async () => {
  const results = [];
  try {
    for (const kind of ['reshade-standard', 'unknown-proxy']) {
      progress(kind + ': create fixture');
      const caseRoot = path.join(root, kind), fixture = await createExperienceFixture(caseRoot, { existingInstallation: kind });
      active = { kind, fixture, original: tree(fixture.gameDir), originalIni: digest(path.join(path.dirname(fixture.exe), 'nr_before_sr.ini')),
        screenshots: [], stats: { requests: 0, confirmations: 0, apiSaves: 0, importAttempts: 0, cancelledImports: 0, imports: 0, launchCalls: 0 } };
      const preload = path.join(caseRoot, 'preload.cjs');
      fs.writeFileSync(preload, `(${installMock.toString()})({on40:{},hoyoProfiles:[]},{captureOnly:true,paths:${JSON.stringify({ gameDir: fixture.gameDir, exe: fixture.exe, ini: path.join(path.dirname(fixture.exe), 'nr_before_sr.ini') })}});\n` +
        `const {ipcRenderer:adoptIpc}=require('electron');for(const method of ['boot','listGames','refresh','confirmGame','assessGame','setGameApiPreference','requestOperation','previewOperation','applyOperation','pickRuntimeDlc','readPayloadSource','readNrSettings','cancelWaitingOperation','launch','hoyoStart'])window.manager[method]=(...args)=>adoptIpc.invoke('adoption-experience',method,...args);window.manager.pickGame=()=>adoptIpc.invoke('adoption-experience','selection');window.__adoption=(...args)=>adoptIpc.invoke('adoption-experience',...args);`);
      win = new BrowserWindow({ width: 1180, height: 850, show: false, useContentSize: true,
        webPreferences: { preload, contextIsolation: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
      await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
      progress(kind + ': renderer loaded');
      const result = await win.webContents.executeJavaScript(`(${exercise.toString()})(${JSON.stringify(kind)})`);
      assert.equal(active.stats.launchCalls, 0); assert.equal(active.latestEvidence.iniPreserved, true);
      results.push({ kind, ...result, evidence: active.latestEvidence, screenshots: active.screenshots });
      progress(kind + ': passed');
      win.destroy(); win = null;
    }
    const report = { ok: true, scope: 'Real Electron renderer and production service/plan/deferred/installer/WAL; synthetic game, payload, PE identity and hardware; no DLL/game/driver execution',
      displayScaleFactor: screen.getPrimaryDisplay().scaleFactor, fixtureRoot: root, results };
    fs.writeFileSync(path.join(output, 'manager-adoption.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); app.exit(0);
  } catch (error) {
    console.error(error.stack);
    if (win && !win.isDestroyed()) {
      console.error(await win.webContents.executeJavaScript('document.body.innerText'));
      fs.writeFileSync(path.join(output, 'manager-adoption-failed.png'), (await win.webContents.capturePage()).toPNG()); win.destroy();
    }
    fs.writeFileSync(path.join(output, 'manager-adoption-failed.json'), JSON.stringify({ error: error.stack, completed: results, kind: active?.kind, stats: active?.stats }, null, 2)); app.exit(1);
  }
});

async function exercise(kind) {
  const assertions = [], timings = {}, start = performance.now();
  const check = (value, label) => { if (!value) throw Error(label); assertions.push(label); };
  const until = async (fn, label) => { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw Error('timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const host = () => document.querySelector('.game-card.expanded .game-detail');
  const state = () => host()?.__gpController.getState();
  const click = action => { const button = host()?.querySelector(`[data-gp-action="${action}"]`); check(button && !button.disabled, action + ' is available'); button.click(); };
  const set = (group, key, value) => { const input = host().querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"]`); check(input && !input.disabled, key + ' is editable'); input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
  const inspect = async id => { const response = await window.__adoption('evidence', id); check(response.ok, 'real service evidence readable'); return response.value; };
  const capture = async label => { await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 100)); const r = await window.__adoption('capture', label); check(r.ok, 'captured ' + label); };
  const applyIntent = () => { const button = host().querySelector('.gp-apply-bar .primary'); check(button && !button.disabled && ['prepare', 'preview'].includes(button.dataset.gpAction), 'apply intent does not combine launch'); button.click(); };
  await until(() => document.getElementById('addGameBtn') && !document.body.classList.contains('is-busy'), 'startup');
  document.getElementById('addGameBtn').click(); await until(() => !document.getElementById('gamePickerModal').classList.contains('hidden'), 'picker');
  document.getElementById('confirmGameBtn').click(); await until(() => document.querySelector('.open-game-page-btn'), 'added');
  document.querySelector('.open-game-page-btn').click(); await until(() => state()?.loaded.includes('installation'), 'installation page');
  const id = state().id;
  check(!state().data.game.installed && state().data.game.existingInstallation?.detected, 'real scan exposes unmanaged installation');
  set('route', 'api', 'dx12'); await until(() => state().data.game.apiOverride === 'dx12' && state().loaded.includes('installation'), 'API metadata');
  set('route', 'version', '0.4.7beta'); applyIntent(); await until(() => !state().busy, 'DLC required');
  // Unknown proxies are deliberately reviewed before reading deployment sources.
  if (kind === 'unknown-proxy' && host().querySelector('.gp-modal')) {
    check(host().querySelector('[data-gp-action="modal-apply"]').disabled, 'unknown proxy initially blocks apply');
    const picker = host().querySelector('[data-gp-adoption-proxy]'); check(picker, 'specific proxy selector exists');
    picker.value = '0'; await capture('specific-proxy-choice'); click('repreview-proxy'); await until(() => !state().busy, 'explicit proxy selected');
    // The failed DLC preview retains its old proposal. Close that proposal so
    // the next wait observes the import continuation, never this stale modal.
    if (host().querySelector('.gp-modal')) click('modal-cancel');
  }
  check((await inspect(id)).gameUnchanged, 'API and blocked preparation leave every original game file untouched');
  click('import-runtime'); await until(() => !state().busy, 'cancel DLC import');
  check((await inspect(id)).stats.cancelledImports === 1, 'cancel DLC selection recorded');
  check((await inspect(id)).gameUnchanged, 'cancel DLC selection writes no game files');
  const importedAt = performance.now(); click('import-runtime');
  await until(() => !state().busy && host().querySelector('.gp-modal .gp-adoption'), 'DLC resumes into adoption confirmation');
  timings.importToConfirmationMs = performance.now() - importedAt;
  check(!state().data.game.installed, 'runtime import did not install or bypass adoption confirmation');
  check(host().querySelector('.gp-adoption').textContent.includes('dxgi.dll'), 'confirmation names the actual proxy file');
  const before = await inspect(id); check(before.gameUnchanged && before.stats.confirmations === 0, 'proposal has not called installer apply');
  await capture('confirmation-before-write'); click('modal-cancel');
  check(state().draft.version === '0.4.7beta', 'cancel keeps the chosen Core draft');
  const cancelled = await inspect(id); check(cancelled.gameUnchanged && cancelled.stats.confirmations === 0, 'cancel adoption preserves original bytes and creates no receipt');
  applyIntent(); await until(() => !state().busy && host().querySelector('.gp-modal .gp-adoption'), 'reopened adoption');
  // The unknown proxy choice is a draft-bound explicit authorization, never inferred.
  if (host().querySelector('[data-gp-action="modal-apply"]').disabled) {
    const picker = host().querySelector('[data-gp-adoption-proxy]'); check(picker, 'unknown target still needs an explicit choice');
    picker.value = '0'; click('repreview-proxy'); await until(() => !state().busy && !host().querySelector('[data-gp-action="modal-apply"]')?.disabled, 'reviewed unknown proxy replacement');
  }
  const applyAt = performance.now(); click('modal-apply');
  await until(() => !state().busy && state().data.game.installed && !host().querySelector('.gp-modal'), 'confirmed installation');
  timings.confirmedInstallMs = performance.now() - applyAt;
  const installed = await inspect(id);
  check(installed.manifestVersion === '0.4.7beta' && !installed.pending.pending, 'production receipt commits the reviewed Core without a pending transaction');
  check(installed.installedHostIsAddon && installed.iniPreserved, 'real installer replaces the host and preserves personal NR INI');
  check(['dxgi.dll', 'nrchain_nvngx.dll'].every(name => installed.backedUp.some(row => row.name === name && row.originalMatchesFixture && row.originalSha256 === row.backupSha256)), 'persistent backups contain the exact prior host and chain bytes');
  check(installed.noAutoLaunch, 'confirmation never auto-launches');
  await capture('installed-with-backups');
  const historicalPanel = host().querySelector('[data-gp-detail="rollback"]'); check(historicalPanel, 'historical Core control exists'); historicalPanel.open = true;
  const historical = historicalPanel.querySelector('select'); historical.value = '0.4.2'; historical.dispatchEvent(new Event('change', { bubbles: true })); applyIntent();
  await until(() => !state().busy && state().data.game.addonVersion === '0.4.2', 'switch Core');
  check((await inspect(id)).manifestVersion === '0.4.2', 'Core switch updates the real receipt');
  set('route', 'version', '0.4.7beta'); applyIntent(); await until(() => !state().busy && state().data.game.addonVersion === '0.4.7beta', 'Core rollback');
  const final = await inspect(id);
  check(final.iniPreserved && final.noAutoLaunch && final.stats.confirmations === 1, 'Core switch and rollback preserve INI without relaunch or redundant adoption');
  check(final.backedUp.every(row => row.originalSha256 === row.backupSha256), 'Core changes retain the first-install restoration baseline');
  await capture('core-rolled-back'); timings.totalMs = performance.now() - start;
  return { assertions, assertionCount: assertions.length, timings };
}
