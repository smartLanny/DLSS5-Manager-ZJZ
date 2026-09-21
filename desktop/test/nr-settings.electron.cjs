'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nr = require('../src/product/nr-config');
const { UNIFORM_SOURCE } = require('../src/product/nr-config-contract');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-nr-electron-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const useUnified5 = process.env.DLSS5_TEST_UNIFIED5 === '1';
const file = path.join(root, 'nr_before_sr.ini'), contract = { version: 'fixture-installed-core', sourceCommit: useUnified5 ? require('../src/product/unified5-core').SOURCE : UNIFORM_SOURCE };
fs.writeFileSync(file, '[NRBeforeSR]\r\nUniformChainVersion=1\r\nIntensity=1.23456789\r\nLocalToneStrength=1.17\r\nLayer2Enabled=1\r\nLayer2Configured=1\r\nLayer2Intensity=0.87654321\r\nLayer3Intensity=1.3456789\r\nLayer4Intensity=0.9876543\r\nLayer5Intensity=1.456789\r\nExperimentalPrivatePreference=keep-exact\r\n');
const game = { id: 'nr-fixture', name: 'NR settings fixture', dir: root, installed: true, supported: true, nativeDlssAvailable: true,
  addonVersion: contract.version, apiOverride: 'auto', chosen: { path: path.join(root, 'Game.exe'), bitness: 64, apiResolution: { api: 'dx12', source: 'fixture' } } };
let writes = 0, lastRequest = null, win;
function assessment() {
  return { schema: 1, gameId: game.id, game, nr: nr.readConfig(file, contract), sections: ['installation'],
    hardware: { family: 'RTX40', series: ['RTX40'] }, defaults: { api: 'auto', version: contract.version, deployment: 'local' },
    api: { effectiveApi: 'dx12', detectedApi: 'dx12', capabilities: ['dx12'], evidence: [], conflicts: [] },
    coreVersions: [{ id: contract.version, label: 'Fixture Core', ready: true }], layout: { mode: 'local', source: 'native' },
    deployment: { mode: 'local', version: contract.version, verified: true }, operation: { pending: false },
    launch: { selected: 'auto', session: null }, enhancements: { requests: {}, applied: {}, pending: [] },
    hotkeys: { nr: { label: 'F6' }, reshade: { key: 36 } }, antiCheat: { detected: false }, failures: [] };
}
ipcMain.handle('nr-fixture', async (event, action, input) => {
  assert.equal(event.sender, win.webContents);
  try {
    if (action === 'assess') return { ok: true, value: assessment() };
    if (action === 'read') return { ok: true, value: nr.readConfig(file, contract) };
    if (action === 'apply') {
      lastRequest = input; await nr.writeConfig(file, input.nr, contract); writes++;
      return { ok: true, value: { applied: true } };
    }
    if (action === 'external') {
      const current = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, nr.updateSection(current, input, contract));
      return { ok: true, value: true };
    }
    throw new Error('Unexpected fixture action');
  } catch (error) { return { ok: false, error: { message: error.message, code: error.code } }; }
});
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `const {ipcRenderer}=require('electron'); window.nrFixture={
  assessGame:()=>ipcRenderer.invoke('nr-fixture','assess'), readNrSettings:()=>ipcRenderer.invoke('nr-fixture','read'),
  requestOperation:(_id,request)=>ipcRenderer.invoke('nr-fixture','apply',request),
  external:patch=>ipcRenderer.invoke('nr-fixture','external',patch)};`);
const renderer = path.resolve(__dirname, '../src/renderer'), asset = name => pathToFileURL(path.join(renderer, name)).href;
const html = path.join(root, 'fixture.html');
fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${asset('style.css')}"><link rel="stylesheet" href="${asset('game-page.css')}"></head><body><main id="fixture" style="max-width:1200px;margin:auto"></main><script src="${asset('../shared/api-resolution.js')}"></script><script src="${asset('launch-settings-ui.js')}"></script><script src="${asset('game-page-ui.js')}"></script></body></html>`);
function interact(useUnified5) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const until = async (predicate, label) => {
    const end = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  const input = key => document.querySelector(`[data-gp-group="nr"][data-gp-field="${key}"]`);
  const change = (key, value) => {
    const element = input(key); check(element && !element.disabled, key + ' is editable');
    if (element.type === 'checkbox') element.checked = Boolean(value); else element.value = String(value);
    element.dispatchEvent(new Event(element.type === 'number' ? 'input' : 'change', { bubbles: true }));
  };
  const click = action => { const button = document.querySelector(`[data-gp-action="${action}"]`); check(button && !button.disabled, action + ' is available'); button.click(); };
  return (async () => {
    const controller = GamePageUi.mount(document.getElementById('fixture'), nrFixture); window.nrController = controller;
    await controller.open('nr-fixture', 'nr');
    check(input('Intensity')?.value === '1.23456789', 'precise saved intensity appears without rounding');
    check(input('Layer2Intensity')?.value === '0.87654321', 'layer 2 keeps its independent value');
    check(input('SkinStructureStrength')?.value === '0.4', 'new default skin strength is .4');
    check(input('UICorrection')?.checked && input('AutoMask')?.checked, 'new model protection defaults are enabled');
    check(document.body.textContent.includes('文件未写入'), 'default values are labelled');
    if (useUnified5) {
      check(input('ColourLabMode').value === '2' && input('ColorStrength').value === '1', 'conservative defaults are visible');
      change('ColourLabMode', 1);
      check(Math.abs(Number(input('ColorStrength').value) - .7) < 1e-6, 'switch recalls the priority bank immediately');
      change('ColorStrength', .85);
      change('ColourLabMode', 2);
      check(input('ColorStrength').value === '1', 'switch back retains conservative bank');
      change('ColourLabMode', 1);
      check(input('ColorStrength').value === '0.85', 'unapplied edits are also independent per policy');
      click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'colour policy saved');
      check(Math.abs(Number(input('ColorStrength').value) - .85) < 1e-6, 'policy and bank round trip through real INI');
    }
    for (const key of ['LightingLock', 'EdgeGuard', 'DetailStability', 'LightBroad', 'LightDark', 'LightReflection', 'LightStructure', 'LightGlow', 'ColorProtection'])
      check(Boolean(input(key)), 'common control ' + key + ' exists');
    change('Layer5Enabled', 1);
    for (let layer = 2; layer <= 5; layer++) check(input('Layer' + layer + 'Enabled').checked, 'enabling layer 5 enables its contiguous predecessors');
    check(input('Layer3Intensity').value === '1.3456789', 'first enable retains a previously saved layer preference');
    change('Layer3Intensity', 1.56789123); change('Layer4Intensity', .7654321);
    click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'first save');
    check(input('Layer3Intensity').value === '1.56789123', 'layer 3 edit read back exactly');
    change('Layer3Enabled', 0); click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'reduced chain save');
    check(!input('Layer4Enabled').checked && !input('Layer5Enabled').checked, 'reducing the chain disables successors');
    change('Layer5Enabled', 1); click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'restored chain save');
    check(input('Layer3Intensity').value === '1.56789123' && input('Layer4Intensity').value === '0.7654321', 'reactivation retains layer preferences');
    click('nr-reset-layer-3'); click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'single layer reset');
    check(input('Layer3Intensity').value === '1.5' && input('Layer4Intensity').value === '0.7654321', 'reset affects only the selected layer');
    change('Intensity', 1.67891234);
    await nrFixture.external({ Intensity: 1.11112222, Layer4Intensity: .55556666 });
    window.dispatchEvent(new Event('focus'));
    await until(() => input('Intensity')?.value === '1.11112222' && !controller.hasDraft(), 'external INI takes precedence over draft');
    check(input('Layer4Intensity').value === '0.55556666', 'external auxiliary preference is displayed');
    check(Boolean(document.querySelector('[data-gp-action="restore-draft-backup"]')), 'displaced draft can be restored');
    click('restore-draft-backup'); check(input('Intensity').value === '1.67891234', 'saved draft is recoverable');
    check(input('Layer4Intensity').value === '0.55556666', 'restoring primary draft retains unrelated external layer value');
    click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'restored draft applied');
    change('Intensity', 1.78912345);
    await nrFixture.external({ Layer4Intensity: .66667777 });
    window.dispatchEvent(new Event('focus'));
    await until(() => input('Layer4Intensity')?.value === '0.66667777', 'unrelated external value refreshed');
    check(controller.getState().draft.nr.Intensity === 1.78912345, 'unrelated draft survives external change');
    click('discard');
    check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'no horizontal layout overflow');
    controller.dispose(); return { assertions: 34, sandbox: true };
  })();
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1300, height: 1000, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(html);
    const result = await win.webContents.executeJavaScript(`(${interact.toString()})(${useUnified5})`);
    const saved = nr.readConfig(file, contract);
    assert.equal(saved.Intensity, 1.67891234); assert.equal(saved.Layer4Intensity, .66667777);
    assert.match(fs.readFileSync(file, 'utf8'), /ExperimentalPrivatePreference=keep-exact\r\n/);
    assert.equal(writes, useUnified5 ? 6 : 5); assert.deepEqual(lastRequest.nr, { Intensity: 1.67891234 });
    console.log(JSON.stringify({ ok: true, scope: 'production NR GamePage interaction with synthetic INI', ...result, writes, actualGameValidation: false }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); win.destroy(); app.exit(1); }
});
