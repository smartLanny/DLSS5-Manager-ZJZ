'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { installHoYoMock } = require('./helpers/hoyo-page-fixture.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-recovery-ui-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const features = { on40: { sr: { eligible: false, blockers: [] }, fg: { eligible: false, blockers: [{ message: '此游戏没有原生补帧' }] } }, hoyoProfiles: [] };
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: { gameDir: root, exe: path.join(root, 'Game.exe'), ini: path.join(root, 'nr_before_sr.ini') } })});(${installHoYoMock.toString()})();(${installScenario.toString()})();`);
function installScenario() {
  const api = window.manager, mock = window.__gpMock, hoyo = window.__hoyoMock;
  const ok = value => ({ ok: true, value: structuredClone(value) });
  const failure = (code, message) => ({ ok: false, error: { code, message } });
  const rescue = window.__rescue = { previews: [], applies: [], removed: [], launches: 0, previewFail: false, applyFail: false, plans: {} };
  for (const id of ['fixture', 'fixture-hoyo']) {
    const value = mock.assessments[id]; value.game.installed = true; value.nr = structuredClone(mock.baseline.nr);
    value.deployment.mode = 'external'; value.deployment.rescue = { available: true, pending: id === 'fixture-hoyo' };
  }
  api.requestOperation = async () => failure('DEPLOYMENT_FILE_CHANGED', 'ReShade.ini 已在管理器外修改。');
  api.previewDeploymentRescue = async (id, mode) => {
    rescue.previews.push({ id, mode }); await new Promise(resolve => setTimeout(resolve, 40));
    if (rescue.previewFail) { rescue.previewFail = false; return failure('DEPLOYMENT_RESCUE_READ_FAILED', '无法读取当前运行目录，请重试。'); }
    const planId = 'rescue-' + rescue.previews.length;
    const plan = { planId, mode, changes: [{ path: 'D:\\Fixture\\managed\\ReShade.ini', name: 'ReShade.ini', action: 'replace', beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64) }],
      warnings: [{ code: 'UNKNOWN_PATH_PRESERVED', message: '未知路径保持原样。' }], scope: '仅处理原受管运行目录。', archiveDirectory: 'D:\\Fixture\\archive', requiresAntiCheat: mode === 'clean', requiresConfirmation: true };
    rescue.plans[planId] = plan; return ok(plan);
  };
  api.applyDeploymentRescue = async (id, planId, options) => {
    rescue.applies.push({ id, planId, options });
    if (rescue.applyFail) { rescue.applyFail = false; return failure('DEPLOYMENT_RESCUE_STALE', '预览后文件再次改变，请重新预览。'); }
    const value = mock.assessments[id]; value.deployment.rescue.pending = false; value.deployment.needsRecovery = false; value.operation.pending = false;
    if (id === 'fixture-hoyo') { hoyo.flow.phase = 'ready'; hoyo.flow.nextAction = 'start'; hoyo.flow.error = null; hoyo.flow.installation.error = null; hoyo.flow.installation.needsRecovery = false; hoyo.flow.installation.ready = true; }
    return ok({ notice: '恢复已完成。' });
  };
  api.removeGame = async (id, options) => { rescue.removed.push({ id, options }); mock.removed.add(id); return ok({ removed: true }); };
  api.launch = async () => { rescue.launches++; return ok({ status: 'waiting-game' }); };
  hoyo.flow.phase = 'recovery'; hoyo.flow.nextAction = 'recover'; hoyo.flow.error = { code: 'DEPLOYMENT_FILE_CHANGED', message: '运行目录已在外部修改。' };
  hoyo.flow.installation = { installed: true, ready: false, needsRecovery: true }; hoyo.flow.api = { api: 'dx11' };
}
async function smoke() {
  const checkNames = [], mock = window.__gpMock, fixture = window.__rescue;
  const check = (value, label) => { if (!value) throw Error(label); checkNames.push(label); };
  const until = async (fn, label) => { const end = Date.now() + 8000; while (!fn()) { if (Date.now() > end) throw Error('timeout ' + label); await new Promise(r => setTimeout(r, 15)); } };
  const ordinary = () => document.querySelector('[data-id="fixture"] .game-detail');
  const click = (root, action) => { const button = root.querySelector(`[data-gp-action="${action}"]`); check(button && !button.disabled, action + ' is reachable'); button.click(); };
  const idle = root => !root.__gpController.getState().busy;
  await until(() => document.querySelector('[data-id="fixture"] .open-game-page-btn'), 'library');
  document.querySelector('[data-id="fixture"] .open-game-page-btn').click();
  await until(() => ordinary()?.__gpController.getState().loaded.includes('installation'), 'assessment');
  ordinary().querySelector('[data-gp-tab="nr"]').click();
  const intensity = ordinary().querySelector('[data-gp-field="Intensity"]'); intensity.value = '.7654321'; intensity.dispatchEvent(new Event('input', { bubbles: true }));
  click(ordinary(), 'preview'); await until(() => idle(ordinary()), 'external error');
  check(ordinary().textContent.includes('[DEPLOYMENT_FILE_CHANGED]'), 'game error keeps its code');
  click(ordinary(), 'maintenance-tab'); await until(() => ordinary().querySelector('[data-gp-action="rescue-repair"]'), 'rescue entry');
  check(ordinary().querySelector('[data-gp-detail="maintenance"]').open, 'error opens the maintenance fold');
  click(ordinary(), 'rescue-repair'); await until(() => ordinary().querySelector('.gp-modal'), 'repair preview');
  check(ordinary().querySelector('.gp-modal').textContent.includes('D:\\Fixture\\archive') && ordinary().querySelector('.gp-modal').textContent.includes('UNKNOWN_PATH_PRESERVED'), 'preview shows backup scope and concrete warning');
  click(ordinary(), 'modal-cancel'); check(fixture.applies.length === 0 && ordinary().__gpController.hasDraft(), 'cancel preview performs no write and retains draft');
  fixture.previewFail = true; click(ordinary(), 'rescue-repair'); await until(() => idle(ordinary()), 'preview read failure');
  check(ordinary().textContent.includes('[DEPLOYMENT_RESCUE_READ_FAILED]') && !ordinary().querySelector('[data-gp-action="rescue-repair"]').disabled, 'failed preview shows code and permits retry');
  click(ordinary(), 'rescue-repair'); await until(() => ordinary().querySelector('.gp-modal'), 'retry preview'); fixture.applyFail = true;
  click(ordinary(), 'modal-apply'); await until(() => idle(ordinary()) && !ordinary().querySelector('.gp-modal'), 'stale apply');
  check(ordinary().textContent.includes('[DEPLOYMENT_RESCUE_STALE]') && ordinary().querySelector('[data-gp-action="rescue-repair"]'), 'stale apply returns to a fresh preview entry');
  click(ordinary(), 'rescue-clean'); await until(() => ordinary().querySelector('.gp-modal'), 'clean preview');
  const attempts = fixture.applies.length; click(ordinary(), 'modal-apply'); check(fixture.applies.length === attempts, 'requested consent gates destructive rescue');
  ordinary().querySelector('[data-gp-consent]').checked = true; click(ordinary(), 'modal-apply'); await until(() => idle(ordinary()) && !ordinary().querySelector('.gp-modal'), 'clean confirmed');
  check(fixture.applies.at(-1).options.confirm === true && fixture.applies.at(-1).options.allowAntiCheat === true, 'rescue apply sends explicit confirmation and consent');
  check(fixture.launches === 0, 'rescue never launches game');
  mock.assessments.fixture.operation.pending = true; mock.assessments.fixture.deployment.needsRecovery = true; mock.assessments.fixture.deployment.rescue.pending = true;
  await ordinary().__gpController.refresh(true);
  check(ordinary().querySelector('[data-gp-action="rescue-recover"]') && !ordinary().querySelector('[data-gp-action="rescue-clean"]'), 'pending deployment exposes recovery before clean or repair');
  click(ordinary(), 'remove-game');
  check(ordinary().querySelector('.gp-modal').textContent.includes('放弃未应用草稿') && ordinary().querySelector('.gp-modal').textContent.includes('全部备份保留'), 'remove confirmation explains drafts and file preservation');
  click(ordinary(), 'modal-cancel'); check(fixture.removed.length === 0 && ordinary().__gpController.hasDraft(), 'cancel library removal retains draft');
  click(ordinary(), 'remove-game'); click(ordinary(), 'remove-confirm'); await until(() => !document.querySelector('[data-id="fixture"]'), 'library removal');
  check(JSON.stringify(fixture.removed[0]) === JSON.stringify({ id: 'fixture', options: { keepFiles: true, confirm: true } }), 'installed pending dirty game can leave library with exact keep-files contract');
  document.querySelector('[data-view="hoyo"]').click();
  const hoyo = () => document.querySelector('#hoyoWorkspace');
  await until(() => hoyo().querySelector('.hoyo-recovery-host [data-gp-action="rescue-recover"]'), 'HoYo recovery fallback');
  check(hoyo().textContent.includes('[DEPLOYMENT_FILE_CHANGED]'), 'HoYo preserves actionable error code');
  const recoveryHost = hoyo().querySelector('.hoyo-recovery-host'); click(recoveryHost, 'rescue-recover'); await until(() => recoveryHost.querySelector('.gp-modal'), 'HoYo recovery preview');
  click(recoveryHost, 'modal-cancel'); check(!fixture.applies.some(row => row.id === 'fixture-hoyo'), 'HoYo rescue cancel never applies');
  click(recoveryHost, 'rescue-recover'); await until(() => recoveryHost.querySelector('.gp-modal'), 'HoYo new preview'); click(recoveryHost, 'modal-apply');
  await until(() => hoyo().querySelector('.hoyo-settings-host [data-gp-tab="overview"]'), 'HoYo restored shared page');
  check(!window.__hoyoMock.calls.some(row => row[0] === 'start'), 'HoYo recovery never auto-starts');
  const shared = hoyo().querySelector('.hoyo-settings-host'); shared.querySelector('[data-gp-detail="maintenance"]').open = true;
  await until(() => shared.querySelector('[data-gp-action="rescue-repair"]'), 'HoYo normal maintenance rescue');
  check(Boolean(shared.querySelector('[data-gp-action="rescue-clean"]')), 'ready HoYo keeps the same repair and clean entries');
  click(shared, 'rescue-clean'); await until(() => shared.querySelector('.gp-modal'), 'final recovery confirmation');
  await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 100));
  return { checks: checkNames, assertions: checkNames.length, previewCount: fixture.previews.length, applyAttempts: fixture.applies.length, actualGameValidation: false };
}
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${smoke.toString()})()`);
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, scope: 'production renderer / synthetic rescue API with real ordinary and HoYo rendering', ...result }, null, 2));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); win.destroy(); } app.exit(1); }
});
