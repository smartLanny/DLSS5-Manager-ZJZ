'use strict';
// Production GamePage controller in Electron; the IPC boundary is synthetic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-pending-requests-ui-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const features = { on40: { sr: { eligible: true, blockers: [] }, fg: { eligible: false, blockers: [] } }, hoyoProfiles: [] };
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: { gameDir: root, exe: path.join(root, 'Game.exe'), ini: path.join(root, 'nr_before_sr.ini') } })});`);
async function smoke() {
  const mock = window.__gpMock, api = window.manager, checks = [];
  const check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const until = async (fn, label) => { const end = Date.now() + 8000; while (!fn()) { if (Date.now() > end) throw Error('timeout: ' + label); await new Promise(resolve => setTimeout(resolve, 10)); } };
  await until(() => window.GamePageUi && mock, 'production UI');
  const ok = value => ({ ok: true, value: structuredClone(value) }), originalAssess = api.assessGame;
  api.assessGame = async (...args) => { const result = await originalAssess(...args); result.value.waiting = structuredClone(mock.waiting || null); return result; };
  api.readNrSettings = async id => ok(mock.assessments[id].nr);
  api.requestOperation = async (id, request) => {
    mock.requests.push({ id, request: structuredClone(request) });
    if (mock.missingRuntime) return { ok: false, error: { code: 'ERR_PAYLOAD_MISSING', message: '请导入运行库 DLC' } };
    return ok({ applied: true });
  };
  api.pickRuntimeDlc = async () => {
    mock.imports++;
    if (mock.deferImport) await new Promise(resolve => { mock.finishImport = resolve; });
    mock.missingRuntime = false; return ok({ message: '已导入运行库' });
  };
  let controller, host, componentCallbacks = 0;
  const state = () => controller.getState();
  const click = action => { const button = host.querySelector(`[data-gp-action="${action}"]`); if (!button || button.disabled) throw Error(action + ' is unavailable'); button.click(); };
  async function reset() {
    controller?.dispose(); host?.remove(); localStorage.clear();
    mock.assessments.fixture = structuredClone(mock.baseline); mock.assessments.fixture.nr.fingerprint = 'original-config';
    mock.waiting = null; mock.requests = []; mock.imports = 0; mock.missingRuntime = true; mock.deferImport = false; mock.finishImport = null; componentCallbacks = 0;
    mock.delays = {};
    host = document.createElement('div'); document.body.append(host);
    controller = window.GamePageUi.mount(host, api, { runtimeRequired: () => true, onComponentsChanged: async () => { componentCallbacks++; } });
    await controller.open('fixture');
  }
  async function failedRequest() {
    controller.selectTab('nr'); await until(() => host.querySelector('[data-gp-group="nr"][data-gp-field="Intensity"]'), 'NR section');
    const input = host.querySelector('[data-gp-group="nr"][data-gp-field="Intensity"]'); input.value = '1.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
    controller.selectTab('overview');
    const version = host.querySelector('[data-gp-group="route"][data-gp-field="version"]'); version.value = 'fixture-core-alternative'; version.dispatchEvent(new Event('change', { bubbles: true }));
    await controller.runPrimary();
    check(mock.requests.length === 1 && mock.requests[0].request.nr.Intensity === 1.5, 'missing DLC retains the complete requested Core/NR combination');
  }
  await reset(); await failedRequest(); click('import-runtime');
  await until(() => mock.requests.length === 2 && !state().busy, 'normal import continuation');
  check(mock.requests[1].request.nr.Intensity === 1.5 && componentCallbacks === 1, 'unchanged import resumes once after the component callback');

  await reset(); await failedRequest(); click('discard'); click('import-runtime');
  await until(() => componentCallbacks === 1 && !state().busy, 'discarded import');
  check(mock.requests.length === 1 && !controller.hasDraft(), 'import cannot revive an explicitly discarded request');

  await reset(); await failedRequest();
  mock.assessments.fixture.nr = { ...mock.assessments.fixture.nr, Intensity: 0.73, fingerprint: 'external-config' };
  await controller.refresh(true);
  check(!state().draft.nr && state().data.nr.Intensity === 0.73, 'external INI supersedes the NR draft before import');
  click('import-runtime'); await until(() => componentCallbacks === 1 && !state().busy, 'external-config import');
  check(mock.requests.length === 1 && state().data.nr.Intensity === 0.73, 'DLC continuation cannot reintroduce an externally superseded NR value');

  await reset(); await failedRequest(); mock.deferImport = true; click('import-runtime');
  await until(() => mock.finishImport, 'pending picker');
  await controller.open('fixture-two'); await controller.open('fixture');
  mock.finishImport(); await new Promise(resolve => setTimeout(resolve, 80));
  check(mock.requests.length === 1 && componentCallbacks === 0, 'switching away and back invalidates a still-open import request');

  await reset(); await failedRequest(); mock.delays['fixture:installation'] = 80; click('import-runtime');
  await until(() => mock.pending > 0, 'import configuration refresh');
  await controller.open('fixture-two'); await new Promise(resolve => setTimeout(resolve, 100));
  check(mock.requests.length === 1 && componentCallbacks === 0, 'switching games during the post-import refresh cannot continue or call the old game callback');

  await reset(); await failedRequest(); mock.deferImport = true; click('import-runtime');
  await until(() => mock.finishImport, 'pending import with external edit');
  mock.assessments.fixture.nr = { ...mock.assessments.fixture.nr, Intensity: 0.42, fingerprint: 'changed-during-picker' };
  mock.finishImport(); await until(() => componentCallbacks === 1 && !state().busy, 'fresh configuration after import');
  check(mock.requests.length === 1 && state().data.nr.Intensity === 0.42, 'configuration refresh during import prevents stale replay');

  await reset(); mock.missingRuntime = false;
  const backup = { nr: { Intensity: 1.75 }, sr: { backend: 'native', quality: 'custom', renderPercent: 61, preset: 'L' }, fg: { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 } };
  mock.waiting = { status: 'attention', pending: false, requiresReview: true, acceptedAt: 'first', draftBackup: backup, message: 'new conflict' };
  await controller.refresh(true); click('restore-draft-backup'); await controller.runPrimary();
  check(JSON.stringify(mock.requests[0].request) === JSON.stringify(backup), 'restored queue request retains the exact NR/SR/FG choices through re-preview');
  mock.waiting = { ...mock.waiting, acceptedAt: 'second', draftBackup: { nr: { Intensity: 0.88 } } };
  await controller.refresh(true); click('restore-draft-backup');
  check(state().draft.nr.Intensity === 0.88 && !state().draft.sr, 'a new waiting interruption replaces an older recoverable draft');
  click('discard');
  const minimal = { sr: { backend: 'native', quality: 'quality' }, fg: { backend: 'dlssg-sm86', mode: 'follow' } };
  mock.waiting = { ...mock.waiting, acceptedAt: 'third', draftBackup: minimal };
  await controller.refresh(true); click('restore-draft-backup'); await controller.runPrimary();
  check(JSON.stringify(mock.requests.at(-1).request) === JSON.stringify(minimal), 'queue restoration does not add the current recommended model or unrelated FG fields');
  controller.dispose(); host.remove(); return { checks, count: checks.length, scope: 'production renderer with synthetic IPC', actualGameValidation: false };
}
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    console.log(JSON.stringify({ ok: true, ...await win.webContents.executeJavaScript(`(${smoke.toString()})()`) }, null, 2)); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); win.destroy(); } app.exit(1); }
});
