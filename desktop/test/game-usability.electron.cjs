'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { installHoYoMock } = require('./helpers/hoyo-page-fixture.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-beta4-ui-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const features = { on40: { sr: { eligible: false, blockers: [] }, fg: { eligible: false, blockers: [{ message: '此游戏没有原生补帧' }] } }, hoyoProfiles: [] };
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: { gameDir: root, exe: path.join(root, 'Game.exe'), ini: path.join(root, 'nr_before_sr.ini') } })});(${installHoYoMock.toString()})();(${installScenario.toString()})();`);
function installScenario() {
  const api = window.manager, mock = window.__gpMock, ok = value => ({ ok: true, value: structuredClone(value) });
  mock.launchCount = 0; mock.adoption = true; mock.proxyUnknown = false; mock.hostKind = 'reshade-standard';
  for (const value of Object.values(mock.assessments)) {
    value.coreVersions = [{ id: '0.4.7beta', label: '0.4.7beta', ready: true }, { id: '0.5-dline21-unified5', label: '0.5 unified5', ready: true }, { id: '0.4.2', label: '0.4.2', ready: true }];
    value.waiting = { pending: false };
  }
  const assess = api.assessGame, apply = api.applyOperation, preview = api.previewOperation;
  api.assessGame = async (...args) => { const result = await assess(...args); if (result.ok) result.value.waiting = structuredClone(mock.assessments[args[0]].waiting); return result; };
  api.launch = async () => { mock.launchCount++; return ok({ status: 'waiting-game' }); };
  api.cancelWaitingOperation = async id => { mock.assessments[id].waiting = { pending: false }; return ok({ cancelled: true }); };
  api.previewOperation = async (id, request) => {
    const result = await preview(id, request);
    if (mock.adoption && !mock.assessments[id].game.installed) {
      const host = { path: 'C:\\Synthetic\\dxgi.dll', sha256: 'e'.repeat(64), kind: mock.proxyUnknown ? 'unknown-proxy' : mock.hostKind };
      result.value.requiresAdoptionConfirmation = true;
      result.value.adoption = { required: true, configFingerprint: 'f'.repeat(64), hostState: host.kind, hosts: host.kind === 'missing' ? [] : [host], replaceProxy: request.adoption?.replaceProxy || null };
      if (mock.proxyUnknown && !request.adoption?.replaceProxy) result.value.blockers = [{ message: '请选择允许替换的入口' }];
      mock.plans.set(result.value.planId, structuredClone(result.value));
    }
    return result;
  };
  api.requestOperation = async (id, request) => {
    mock.calls.push(['request', structuredClone(request), id]);
    const plan = await api.previewOperation(id, request);
    if (plan.value.requiresAdoptionConfirmation) return ok({ needsAttention: true, plan: plan.value });
    return api.applyOperation(id, plan.value.planId, { confirm: true, fingerprint: plan.value.fingerprint });
  };
  api.applyOperation = async (id, planId, consent) => {
    const result = await apply(id, planId, consent);
    if (result.ok) { mock.assessments[id].game.installed = true; mock.assessments[id].deployment.verified = true; }
    return result;
  };
  const hoyo = window.__hoyoMock;
  const hoyoPreview = api.hoyoPreview;
  api.hoyoPreview = async (...args) => { const result = await hoyoPreview(...args); result.value.requiresAdoptionConfirmation = true; result.value.adoption = { required: true, hostState: 'missing', hosts: [], configFingerprint: 'f'.repeat(64) }; return result; };
  hoyo.flow.phase = 'install'; hoyo.flow.nextAction = 'preview-install'; hoyo.flow.api = { api: 'dx11' }; hoyo.requiresAntiCheat = false;
}
async function smoke() {
  const mock = window.__gpMock, hoyo = window.__hoyoMock, checks = [];
  const check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const until = async (predicate, label) => { const limit = Date.now() + 7000; while (!predicate()) { if (Date.now() > limit) throw Error('timeout: ' + label); await new Promise(r => setTimeout(r, 12)); } };
  const card = id => document.querySelector(`[data-id="${id}"]`);
  const host = id => card(id)?.querySelector('.game-detail');
  const ctrl = id => host(id)?.__gpController;
  const visible = node => node && node.getClientRects().length > 0;
  const click = (root, action) => { const button = root.querySelector(`[data-gp-action="${action}"]`); check(button && !button.disabled, action + ' available'); button.click(); };
  const change = (root, group, key, value) => { const input = root.querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"]`); check(input && !input.disabled, key + ' editable'); input.value = value; input.dispatchEvent(new Event(input.type === 'range' || input.type === 'number' ? 'input' : 'change', { bubbles: true })); };
  await until(() => card('fixture'), 'library'); card('fixture').querySelector('.open-game-page-btn').click();
  await until(() => ctrl('fixture')?.getState().loaded.includes('installation'), 'installed page');
  check([...host('fixture').querySelectorAll('[data-gp-tab]')].map(n => n.textContent).join('|') === '安装与启动|NR 画面增强|DLSS 超分与补帧', 'exactly three task pages');
  check(!host('fixture').querySelector('[data-gp-field="Intensity"]'), 'installation page does not mix NR controls');
  check([...host('fixture').querySelector('.gp-install-section [data-gp-field="version"]').options].map(n => n.value).join('|') === '0.4.7beta|0.5-dline21-unified5', 'main Core selector has the two supported choices');
  check(Boolean(host('fixture').querySelector('[data-gp-detail="rollback"] option[value="0.4.2"]')), 'historical Core stays in rollback controls');
  check(!visible(card('fixture').querySelector('.unified-launch-btn')), 'expanded ordinary card hides duplicate header action');
  check(host('fixture').querySelectorAll('.gp-apply-bar .primary').length === 1, 'ordinary page has one primary action');
  host('fixture').querySelector('[data-gp-tab="nr"]').click();
  mock.assessments.fixture.launch.readiness = { state: 'blocked', blockers: [{ domain: 'fg', message: '不支持原生补帧', action: { kind: 'open-settings' } }] };
  await ctrl('fixture').refresh(); change(host('fixture'), 'nr', 'Intensity', '1.65'); click(host('fixture'), 'preview');
  await until(() => !ctrl('fixture').getState().busy && !ctrl('fixture').hasDraft(), 'NR-only apply');
  check(mock.assessments.fixture.nr.Intensity === 1.65, 'unavailable FG does not block an NR-only request');
  check(mock.launchCount === 0, 'successful apply never launches automatically');
  mock.assessments.fixture.waiting = { pending: true, message: '等待游戏退出' }; await ctrl('fixture').refresh();
  check(host('fixture').querySelector('.gp-apply-bar .primary').dataset.gpAction === 'cancel-waiting', 'waiting offers cancellation instead of launch');
  await ctrl('fixture').launchGame(); check(mock.launchCount === 0, 'direct page launch is blocked while waiting');
  click(host('fixture'), 'back'); check(card('fixture').querySelector('.unified-launch-btn').disabled, 'collapsed card also blocks launch while waiting');
  card('fixture-unmanaged').querySelector('.open-game-page-btn').click(); await until(() => ctrl('fixture-unmanaged')?.getState().loaded.includes('installation'), 'unmanaged page');
  change(host('fixture-unmanaged'), 'route', 'version', '0.4.7beta'); click(host('fixture-unmanaged'), 'prepare');
  await until(() => host('fixture-unmanaged').querySelector('.gp-adoption'), 'adoption confirmation');
  const applied = mock.calls.filter(row => row[0] === 'apply').length;
  click(host('fixture-unmanaged'), 'modal-cancel'); check(ctrl('fixture-unmanaged').hasDraft(), 'cancel adoption preserves draft');
  check(mock.calls.filter(row => row[0] === 'apply').length === applied && !mock.assessments['fixture-unmanaged'].game.installed, 'cancel adoption does not install');
  for (const kind of ['addon-compatible', 'missing']) {
    mock.hostKind = kind;
    if (kind === 'missing') mock.assessments['fixture-unmanaged'].game.existingInstallation.files = [{ name: 'nr_before_sr.ini', kind: 'config' }, { name: 'feedback.txt', kind: 'feedback' }];
    click(host('fixture-unmanaged'), 'prepare'); await until(() => host('fixture-unmanaged').querySelector('.gp-adoption'), kind + ' preview');
    check(kind !== 'missing' || host('fixture-unmanaged').querySelector('.gp-adoption').textContent.includes('配置或插件残留'), 'residual config is explained as needing a loading entry');
    click(host('fixture-unmanaged'), 'modal-cancel');
    check(!mock.assessments['fixture-unmanaged'].game.installed && mock.calls.filter(row => row[0] === 'apply').length === applied, kind + ' also requires confirmation');
  }
  mock.proxyUnknown = true; click(host('fixture-unmanaged'), 'prepare'); await until(() => host('fixture-unmanaged').querySelector('[data-gp-adoption-proxy]'), 'unknown proxy choice');
  check(host('fixture-unmanaged').querySelector('[data-gp-action="modal-apply"]').disabled, 'unknown proxy cannot be silently replaced');
  host('fixture-unmanaged').querySelector('[data-gp-adoption-proxy]').value = '0'; click(host('fixture-unmanaged'), 'repreview-proxy');
  await until(() => !ctrl('fixture-unmanaged').getState().busy && !host('fixture-unmanaged').querySelector('[data-gp-action="modal-apply"]').disabled, 'explicit proxy preview');
  check(mock.calls.filter(row => row[0] === 'apply').length === applied, 'choosing proxy still does not apply');
  click(host('fixture-unmanaged'), 'modal-apply'); await until(() => !ctrl('fixture-unmanaged').getState().busy && mock.assessments['fixture-unmanaged'].game.installed, 'confirmed adoption');
  check(host('fixture-unmanaged').querySelector('.gp-apply-bar .primary').textContent === '启动' && mock.launchCount === 0, 'confirmed adoption changes Apply to Launch without launching');
  document.querySelector('[data-view="hoyo"]').click();
  const hoyoHost = () => document.querySelector('#hoyoWorkspace');
  await until(() => hoyoHost().querySelector('[data-hoyo-action="preview-install"]'), 'HoYo install');
  check(document.querySelector('[data-view="hoyo"]').textContent === '米哈游', 'HoYo navigation uses the requested name');
  hoyoHost().querySelector('[data-hoyo-action="preview-install"]').click(); await until(() => hoyoHost().querySelector('[data-hoyo-action="apply"]'), 'HoYo plan');
  check(hoyoHost().querySelector('.gp-adoption')?.textContent.includes('确认接管'), 'HoYo uses the shared adoption confirmation');
  hoyoHost().querySelector('[data-hoyo-action="close-plan"]').click(); check(!hoyo.calls.some(row => row[0] === 'apply'), 'HoYo install cancellation does not apply');
  hoyoHost().querySelector('[data-hoyo-action="preview-install"]').click(); await until(() => hoyoHost().querySelector('[data-hoyo-action="apply"]'), 'HoYo second plan');
  hoyoHost().querySelector('[data-hoyo-action="apply"]').click(); await until(() => hoyoHost().querySelector('[data-gp-tab="nr"]'), 'HoYo shared settings');
  await until(() => hoyoHost().querySelector('.hoyo-settings-host')?.__gpController.getState().loaded.includes('installation'), 'HoYo settings loaded');
  check([...hoyoHost().querySelectorAll('.button.primary')].filter(visible).length === 1, 'installed HoYo uses one shared primary action');
  check(!hoyo.calls.some(row => row[0] === 'start'), 'HoYo install never starts automatically');
  const corePicker = () => hoyoHost().querySelector('[data-gp-group="route"][data-gp-field="version"]');
  check(Boolean(corePicker()) && [...corePicker().options].some(row => row.value === '0.5-dline21-unified5' && !row.disabled), 'latest Core is selectable for explicit compatibility preview');
  check([...corePicker().options].some(row => row.value === '0.4.7beta' && row.disabled), 'Feature1-only historical Core remains unavailable for external Provider pairing');
  const hoAssessment = mock.assessments['fixture-hoyo'];
  hoAssessment.layout.inputRoute = 'native'; hoAssessment.game.nativeDlssAvailable = true; hoAssessment.game.feeder = null;
  await hoyoHost().querySelector('.hoyo-settings-host').__gpController.refresh();
  check([...corePicker().options].some(row => row.value === '0.5-dline21-unified5' && !row.disabled), 'HoYo native input exposes the standard 0.5 switch in the shared page');
  change(hoyoHost(), 'route', 'version', '0.5-dline21-unified5'); click(hoyoHost(), 'preview');
  await until(() => !hoyoHost().querySelector('.hoyo-settings-host').__gpController.getState().busy, 'HoYo Core apply');
  check(mock.calls.some(row => row[0] === 'request' && row[1].version === '0.5-dline21-unified5' && row[2] === 'fixture-hoyo'), 'HoYo Core selection follows the same operation contract');
  check(!hoyo.calls.some(row => row[0] === 'start'), 'HoYo Core apply never launches');
  hoyoHost().querySelector('[data-gp-tab="nr"]').click(); change(hoyoHost(), 'nr', 'Intensity', '1.35');
  check([...hoyoHost().querySelectorAll('.button.primary')].filter(visible).length === 1 && hoyoHost().querySelector('.gp-apply-bar .primary').textContent === '应用', 'HoYo draft uses the shared Apply action');
  click(hoyoHost(), 'preview'); await until(() => !hoyoHost().querySelector('.hoyo-settings-host').__gpController.getState().busy, 'HoYo settings apply');
  check(!hoyo.calls.some(row => row[0] === 'start'), 'HoYo settings apply does not start');
  await until(() => visible(hoyoHost().querySelector('[data-gp-action="launch"]')), 'HoYo launch after apply');
  mock.assessments['fixture-hoyo'].waiting = { pending: true, message: '等待游戏退出' };
  await hoyoHost().querySelector('.hoyo-settings-host').__gpController.refresh();
  check(hoyoHost().querySelector('.gp-apply-bar .primary').dataset.gpAction === 'cancel-waiting', 'HoYo shared state blocks launch while queued');
  click(hoyoHost(), 'back'); check(hoyoHost().querySelector('[data-hoyo-action="waiting-exit"]').disabled, 'collapsed HoYo card also blocks queued launch');
  hoyoHost().querySelector('[data-hoyo-toggle]').click(); click(hoyoHost(), 'cancel-waiting');
  await until(() => visible(hoyoHost().querySelector('[data-gp-action="launch"]')), 'HoYo cancellation restores launch');
  click(hoyoHost(), 'launch'); await until(() => hoyo.calls.some(row => row[0] === 'start'), 'explicit HoYo start');
  check(mock.launchCount === 0 && hoyo.calls.filter(row => row[0] === 'start').length === 1, 'shared Launch delegates once to the HoYoShade backend');
  hoyoHost().querySelector('[data-hoyo-action="cancel"]').click();
  await until(() => visible(hoyoHost().querySelector('[data-gp-tab="overview"]')), 'HoYo return from launch wait');
  hoyoHost().querySelector('[data-gp-tab="overview"]').click(); await new Promise(r => setTimeout(r, 200));
  check(visible(hoyoHost().querySelector('.gp-apply-bar .primary')), 'final HoYo primary remains visible after parent refresh');
  return { checks, assertions: checks.length, actualGameValidation: false };
}
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${smoke.toString()})()`);
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, scope: 'production renderer / synthetic operation and HoYo fixtures', ...result }, null, 2));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); win.destroy(); } app.exit(1); }
});
