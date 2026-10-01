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
// uniform (default) | unified5 (colour banks) | reconstruction (0.5.1 detail enhancement and dark-noise reduction)
const mode = process.env.DLSS5_TEST_NR_CORE || (process.env.DLSS5_TEST_UNIFIED5 === '1' ? 'unified5' : 'uniform');
const SOURCES = { uniform: UNIFORM_SOURCE, unified5: require('../src/product/unified5-core').SOURCE,
  reconstruction: require('../src/shared/core-catalog').CORES.find(row => row.reconstruction === true)?.sourceCommit };
if (!SOURCES[mode]) throw new Error(`Unknown DLSS5_TEST_NR_CORE: ${mode}`);
const flags = { colour: mode !== 'uniform', reconstruction: mode === 'reconstruction' };
const file = path.join(root, 'nr_before_sr.ini'), contract = { version: 'fixture-installed-core', sourceCommit: SOURCES[mode] };
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
fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${asset('style.css')}"><link rel="stylesheet" href="${asset('game-page.css')}"></head><body><main id="fixture" style="max-width:1200px;margin:auto"></main><script src="${asset('../shared/api-resolution.js')}"></script><script src="${asset('../shared/core-catalog.js')}"></script><script src="${asset('launch-settings-ui.js')}"></script><script src="${asset('game-page-ui.js')}"></script></body></html>`);
function interact(flags) {
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
    // Each number box has a pointer-only slider beside it; both stay in step.
    const slider = key => input(key).parentElement.querySelector('[data-gp-slider]');
    check(Number(slider('Intensity')?.value) === 1.23 && slider('Intensity').getAttribute('aria-hidden') === 'true' && slider('Intensity').tabIndex === -1, 'intensity slider starts at the saved value');
    slider('Intensity').value = '1.5'; slider('Intensity').dispatchEvent(new Event('input', { bubbles: true }));
    check(input('Intensity').value === '1.5' && controller.getState().draft.nr?.Intensity === 1.5, 'moving the slider edits the number box and the draft');
    change('Intensity', 1.23456789);
    check(Number(slider('Intensity').value) === 1.23 && controller.getState().draft.nr?.Intensity === undefined, 'typing the saved number moves the slider back and clears the draft');
    check(input('SkinStructureStrength')?.value === '0.4', 'new default skin strength is .4');
    check(input('UICorrection')?.checked && input('AutoMask')?.checked, 'new model protection defaults are enabled');
    check(document.body.textContent.includes('文件未写入'), 'default values are labelled');
    if (flags.colour) {
      check(input('ColourLabMode').value === '2' && input('ColorStrength').value === '1', 'conservative defaults are visible');
      change('ColourLabMode', 1);
      check(Math.abs(Number(input('ColorStrength').value) - .7) < 1e-6, 'switch recalls the priority bank immediately');
      const colourInput = input('ColorStrength');
      change('ColorStrength', 0);
      check(input('ColorStrength') === colourInput, 'numeric typing retains the same input and its intermediate editing state');
      change('ColorStrength', .85);
      check(input('ColorStrength') === colourInput, 'decimal strength edit does not reconstruct the number input');
      change('ColourLabMode', 2);
      check(input('ColorStrength').value === '1', 'switch back retains conservative bank');
      change('ColourLabMode', 1);
      check(input('ColorStrength').value === '0.85', 'unapplied edits are also independent per policy');
      click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'colour policy saved');
      check(Math.abs(Number(input('ColorStrength').value) - .85) < 1e-6, 'policy and bank round trip through real INI');
    }
    if (flags.reconstruction) {
      check(input('ReconstructionMode')?.value === '0' && input('NearBlackChromaGuard')?.checked === false, 'detail enhancement and dark-noise reduction start off');
      check(document.body.textContent.includes('清晰度与暗噪'), 'the 0.5.1 options have their own heading');
      change('ReconstructionMode', 2); change('NearBlackChromaGuard', 1);
      click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), '0.5.1 options saved');
      check(input('ReconstructionMode').value === '2' && input('NearBlackChromaGuard').checked, '0.5.1 options read back from the real INI');
    } else check(!input('ReconstructionMode') && !input('NearBlackChromaGuard'), 'older Cores do not offer 0.5.1 options');
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
    controller.dispose(); return { assertions: 37, sandbox: true };
  })();
}

// The games page lays the same settings out like the Core's in-game panel.
function interactHero(flags) {
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const until = async (predicate, label) => {
    const end = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > end) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  const host = document.getElementById('fixture');
  const input = key => host.querySelector(`[data-gp-group="nr"][data-gp-field="${key}"]:not([type="radio"])`);
  const radio = (group, key, value) => host.querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"][value="${value}"]`);
  const pick = (group, key, value) => { const element = radio(group, key, value); check(element && !element.disabled, `${group}/${key}=${value} is selectable`); element.click(); };
  const change = (key, value) => {
    const element = input(key); check(element && !element.disabled, key + ' is editable');
    if (element.type === 'checkbox') element.checked = Boolean(value); else element.value = String(value);
    element.dispatchEvent(new Event(element.type === 'number' ? 'input' : 'change', { bubbles: true }));
  };
  const click = action => { const button = host.querySelector(`[data-gp-action="${action}"]`); check(button && !button.disabled, action + ' is available'); button.click(); };
  return (async () => {
    host.innerHTML = '';
    const controller = GamePageUi.mount(host, nrFixture, { hero: () => ({ art: '', launcher: 'Steam' }) }); window.nrController = controller;
    await controller.open('nr-fixture', 'nr'); let assertions = 0; const ok = (condition, message) => { check(condition, message); assertions++; };
    ok(host.querySelector('[data-gp-tab="nr"]').textContent === 'DLSS5', 'the first tab is named DLSS5');
    ok(host.querySelector('.gp-cards > .gp-card-main [data-gp-field="Enabled"]')?.checked, 'the DLSS5 switch leads the page and reflects the INI');
    const titles = [...host.querySelectorAll('.gp-cards > .gp-card > header h3, .gp-cards > details.gp-card > summary > span')].map(node => node.firstChild.textContent.trim());
    ok(titles.slice(0, 3).join('|') === '处理位置|模型与层数|最终合成' && titles.includes('光影微调') && titles.includes('画质保护（高级）'), 'groups follow the Core panel: ' + titles.join('|'));
    ok(radio('nr', 'ProcessingStart', 'Before').checked && input('WorkMode') && !input('PostWorkPercent'), 'the position shows its own working scale');
    pick('nr', 'ProcessingStart', 'After');
    ok(input('PostWorkPercent') && !input('WorkMode') && controller.getState().draft.nr.ProcessingStart === 'After', 'after-upscale position switches to its own scale');
    ok(Number(input('PostWorkPercent').min) === 0, 'the special 0 (stop) stays enterable for the post scale');
    click('discard');
    change('WorkMode', 5); change('CustomWorkScale', 0);
    ok(Number(input('CustomWorkScale').min) === 0 && !input('CustomWorkScale').hasAttribute('aria-invalid') && controller.getState().draft.nr.CustomWorkScale === 0, 'a custom scale of 0 (stop) is accepted');
    ok(Number(input('CustomWorkScale').parentElement.querySelector('[data-gp-slider]').min) === .5, 'the slider keeps the ordinary range');
    change('CustomWorkScale', .3);
    ok(input('CustomWorkScale').getAttribute('aria-invalid') === 'true' && host.textContent.includes('0（停用）或 0.5～1'), 'a value between stop and the ordinary minimum is flagged');
    change('CustomWorkScale', .75);
    ok(!input('CustomWorkScale').hasAttribute('aria-invalid'), 'an ordinary value clears the flag');
    click('discard');
    ok(radio('nr-layers', 'count', '5').checked, 'the layer count reads the five contiguous enabled layers');
    ok(input('Intensity') && !input('Layer2Intensity'), 'only the layer being edited is shown');
    pick('nr-edit-layer', 'layer', 2);
    ok(input('Layer2Intensity') && !input('Intensity'), 'the layer picker switches to layer 2');
    pick('nr', 'Layer2Style', 2);
    ok(controller.getState().draft.nr.Layer2Style === 2 && radio('nr', 'Layer2Style', '2').checked, 'style is a segmented choice written per layer');
    change('Layer2AutoMask', 0);
    ok(input('Layer2SkinStructureStrength').disabled, 'skin structure follows its skin protection switch');
    click('discard');
    pick('nr-layers', 'count', 2);
    const draft = controller.getState().draft.nr;
    ok(draft.Layer3Enabled === 0 && draft.Layer4Enabled === 0 && draft.Layer5Enabled === 0 && !('Layer2Enabled' in draft), 'two layers keep layer 2 and switch 3 to 5 off');
    ok(!radio('nr-edit-layer', 'layer', '3'), 'the picker only offers active layers');
    click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'two-layer save');
    ok(controller.getState().data.nr.Layer2Enabled === 1 && controller.getState().data.nr.Layer3Enabled === 0, 'layer count round-trips through the real INI');
    pick('nr-layers', 'count', 3);
    ok(controller.getState().draft.nr.Layer3Enabled === 1 && controller.getState().draft.nr.Layer3Configured === 1 && !('Layer4Enabled' in controller.getState().draft.nr), 'raising the count enables exactly the next layer');
    click('discard');
    if (flags.reconstruction) {
      pick('nr', 'ReconstructionMode', 1);
      ok(controller.getState().draft.nr.ReconstructionMode === 1, '0.5.1 detail enhancement is a segmented choice');
      click('discard');
    }
    pick('nr-edit-layer', 'layer', 1);
    change('Intensity', 1.9);
    click('nr-recommended');
    const restored = controller.getState().draft.nr;
    ok(restored.Intensity === 1.5 && restored.Layer2Enabled === 0 && !('Enabled' in restored), 'restore fills recommended values, turns extra layers off and keeps the switch');
    ok(!Object.keys(restored).some(key => /^Layer[2-5](?!Enabled)/.test(key)), 'restore keeps the tuning of the layers it switches off');
    click('preview'); await until(() => !controller.getState().busy && !controller.hasDraft(), 'recommended picture saved');
    ok(controller.getState().data.nr.Intensity === 1.5 && controller.getState().data.nr.Layer2Enabled === 0 && controller.getState().data.nr.Enabled === 1, 'recommended picture round-trips through the real INI');
    ok(controller.getState().data.nr.Layer4Intensity === .66667777, 'a switched-off layer keeps its saved tuning after the restore');
    ok(radio('nr-layers', 'count', '1').checked && host.textContent.includes('第 1 层'), 'one layer is shown after the restore');
    change('Enabled', 0);
    ok(controller.getState().draft.nr.Enabled === 0, 'the DLSS5 switch edits the draft like any other setting');
    click('discard');
    controller.dispose(); return { heroAssertions: assertions };
  })();
}
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1300, height: 1000, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(html);
    const result = await win.webContents.executeJavaScript(`(${interact.toString()})(${JSON.stringify(flags)})`);
    const saved = nr.readConfig(file, contract);
    assert.equal(saved.Intensity, 1.67891234); assert.equal(saved.Layer4Intensity, .66667777);
    assert.match(fs.readFileSync(file, 'utf8'), /ExperimentalPrivatePreference=keep-exact\r\n/);
    assert.equal(writes, 5 + flags.colour + flags.reconstruction); assert.deepEqual(lastRequest.nr, { Intensity: 1.67891234 });
    if (flags.reconstruction) for (const line of [/^ReconstructionMode=2\r$/m, /^NearBlackChromaGuard=1\r$/m]) assert.match(fs.readFileSync(file, 'utf8'), line);
    const hero = await win.webContents.executeJavaScript(`(${interactHero.toString()})(${JSON.stringify(flags)})`);
    const restored = nr.readConfig(file, contract);
    assert.equal(restored.Intensity, 1.5); assert.equal(restored.Layer2Enabled, 0); assert.equal(restored.Enabled, 1); assert.equal(restored.Layer4Intensity, .66667777);
    assert.match(fs.readFileSync(file, 'utf8'), /ExperimentalPrivatePreference=keep-exact\r\n/);
    console.log(JSON.stringify({ ok: true, scope: 'production NR GamePage interaction with synthetic INI', mode, ...result, ...hero, writes, actualGameValidation: false }));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack || error); win.destroy(); app.exit(1); }
});
