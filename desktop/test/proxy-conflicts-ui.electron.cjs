'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installMock } = require('./helpers/game-page-beta3-fixture.cjs');
const { installHoYoMock } = require('./helpers/hoyo-page-fixture.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-conflicts-ui-'));
app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
const features = { on40: { sr: { eligible: false, blockers: [] }, fg: { eligible: false, blockers: [{ message: '此游戏没有原生补帧' }] } }, hoyoProfiles: [] };
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `(${installMock.toString()})(${JSON.stringify(features)},${JSON.stringify({ captureOnly: true, paths: { gameDir: root, exe: path.join(root, 'Game.exe'), ini: path.join(root, 'nr_before_sr.ini') } })});(${installHoYoMock.toString()})();(${installScenario.toString()})();`);
function installScenario() {
  const mock = window.__gpMock, api = window.manager, ok = value => ({ ok: true, value: structuredClone(value) });
  mock.conflictApplies = []; mock.starts = 0;
  const current = mock.assessments.fixture; current.game.chosen.apiResolution.api = current.api.effectiveApi = 'dx12';
  current.defaults.proxyEntry = 'd3d12'; current.layout.loadingBackend = 'local'; current.layout.loadingMode = 'proxy';
  current.layout.proxyPaths = ['C:\\Fixture\\dxgi.dll'];
  const conflict = { required: true, backupDirectories: ['C:\\Fixture\\_DLSS5_Backup', 'D:\\Manager\\runtime-backups'],
    files: [{ name: 'legacy-nr.addon64', path: 'C:\\Fixture\\legacy-nr.addon64', action: 'backup-isolate', classification: 'generic-nr' }] };
  mock.conflict = conflict;
  const preview = api.previewOperation, apply = api.applyOperation;
  api.requestOperation = async (id, request) => {
    mock.calls.push(['request', structuredClone(request), id]);
    const result = await preview(id, request); result.value.nrConflicts = structuredClone(mock.conflict);
    mock.plans.set(result.value.planId, structuredClone(result.value));
    return ok({ confirmationRequired: true, plan: result.value });
  };
  api.applyOperation = async (id, planId, consent) => {
    mock.conflictApplies.push({ id, planId, consent });
    const result = await apply(id, planId, consent), request = mock.plans.get(planId).request;
    if (result.ok && request.proxyEntry) mock.assessments[id].defaults.proxyEntry = request.proxyEntry;
    return result;
  };
  api.launch = async () => { mock.starts++; return ok({ status: 'waiting-game' }); };
  const hoyo = window.__hoyoMock, hoyoPreview = api.hoyoPreview;
  hoyo.flow.phase = 'install'; hoyo.flow.nextAction = 'preview-install'; hoyo.flow.api = { api: 'dx12' }; hoyo.requiresAntiCheat = false;
  api.hoyoPreview = async (...args) => { const result = await hoyoPreview(...args); result.value.nrConflicts = structuredClone(conflict); return result; };
}
async function smoke() {
  const mock = window.__gpMock, checks = [];
  const check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  const until = async (fn, label) => { const end = Date.now() + 8000; while (!fn()) { if (Date.now() > end) throw Error('timeout ' + label); await new Promise(r => setTimeout(r, 15)); } };
  const host = () => document.querySelector('[data-id="fixture"] .game-detail');
  const ctrl = () => host().__gpController, state = () => ctrl().getState();
  const button = (root, action) => root.querySelector(`[data-gp-action="${action}"]`);
  const click = (root, action) => { const node = button(root, action); check(node && !node.disabled, action + ' available'); node.click(); };
  const set = (group, key, value) => { const node = host().querySelector(`[data-gp-group="${group}"][data-gp-field="${key}"]`); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
  await until(() => document.querySelector('[data-id="fixture"] .open-game-page-btn'), 'library'); document.querySelector('[data-id="fixture"] .open-game-page-btn').click();
  await until(() => state()?.loaded.includes('installation'), 'installation page');
  check(button(host(), 'switch-proxy')?.textContent === '改用 DXGI' && host().querySelector('.gp-proxy-entry').textContent.includes('加载入口：D3D12'), 'homepage honors actual/default D3D12 entry');
  check(button(host(), 'switch-proxy').title.includes('DXGI 冲突') && button(host(), 'switch-proxy').getClientRects().length > 0, 'short entry and tooltip are visible on installation page');
  check(!host().querySelector('[data-gp-field="proxyEntry"]'), 'advanced duplicate proxy selector removed');
  const callsBefore = mock.calls.length; click(host(), 'switch-proxy');
  check(JSON.stringify(state().draft) === JSON.stringify({ proxyEntry: 'dxgi' }) && mock.calls.length === callsBefore, 'switch only stages proxyEntry without IPC or writes');
  check(host().querySelector('.gp-apply-bar .primary').textContent === '应用修改' && mock.starts === 0, 'staged switch waits for unified Apply');
  click(host(), 'preview'); await until(() => host().querySelector('.gp-modal') && !state().busy, 'conflict short confirmation');
  const dialog = () => host().querySelector('.gp-modal');
  check(dialog().textContent.includes('C:\\Fixture\\_DLSS5_Backup') && dialog().textContent.includes('D:\\Manager\\runtime-backups'), 'confirmation shows both fixed owner backup directories');
  check(dialog().querySelector('.gp-nr-conflicts') && [...dialog().querySelectorAll('details')].every(row => !row.open), 'NR conflict details and complete file list start folded');
  check(button(host(), 'modal-apply').textContent === '备份冲突并应用' && mock.conflictApplies.length === 0, 'confirmationRequired response cannot apply silently');
  click(host(), 'modal-cancel'); check(state().draft.proxyEntry === 'dxgi' && mock.conflictApplies.length === 0, 'cancel conflict preserves switch draft and performs no Apply');
  click(host(), 'preview'); await until(() => dialog() && !state().busy, 'second conflict preview'); click(host(), 'modal-apply');
  await until(() => !state().busy && !dialog() && !ctrl().hasDraft(), 'explicit Apply');
  check(mock.conflictApplies.length === 1 && mock.conflictApplies[0].consent.confirm === true && mock.conflictApplies[0].consent.fingerprint, 'confirmed conflict keeps original plan fingerprint authorization');
  check(button(host(), 'switch-proxy').textContent === '改用 D3D12' && mock.starts === 0, 'readback updates actual entry without launching');
  const originalConflict = mock.conflict, appliesBeforeTransfer = mock.conflictApplies.length;
  const restorePath = 'C:\\Fixture\\Binaries\\Win64\\legacy-nr.addon64';
  mock.conflict = { required: true, backupDirectories: ['C:\\Fixture\\_DLSS5_Backup\\conflicts'],
    files: [{ name: 'legacy-nr.addon64', path: 'D:\\Manager\\runtime-backups\\legacy-nr.addon64', action: 'transfer-backup', classification: 'generic-nr', restorePath }] };
  click(host(), 'switch-proxy'); click(host(), 'preview');
  await until(() => dialog() && !state().busy, 'isolated backup migration confirmation');
  const migration = dialog().querySelector('.gp-nr-conflicts');
  check(migration.querySelector('h4').textContent === '隔离备份随安装迁移', 'backup-only migration is distinguished from a newly found conflict');
  const destination = [...migration.querySelectorAll('li')].find(node => node.textContent === restorePath);
  check(destination && destination.getClientRects().length > 0 && !destination.closest('details') && migration.textContent.includes('隔离文件继续停用；卸载后恢复到：'), 'migration visibly names the new uninstall restore location and keeps the plugin disabled');
  click(host(), 'modal-cancel');
  check(!dialog() && mock.conflictApplies.length === appliesBeforeTransfer && state().draft.proxyEntry === 'd3d12' && mock.starts === 0, 'cancel migration performs zero Apply and preserves the draft without starting');
  click(host(), 'discard'); mock.conflict = originalConflict;
  const model = mock.assessments.fixture;
  model.maintenance.canRestore = true; ctrl().selectTab('maintenance');
  await until(() => button(host(), 'restore-environment'), 'maintenance archive restore');
  check(button(host(), 'restore-environment').disabled && button(host(), 'restore-environment').title === '卸载当前配套后可恢复', 'installed components cannot implicitly uninstall through archive restore');
  ctrl().selectTab('overview');
  for (const api of ['dx11', 'dx10', 'dx9', 'vulkan']) {
    model.game.chosen.apiResolution.api = model.api.effectiveApi = api; await ctrl().refresh(true);
    check(!button(host(), 'switch-proxy'), api + ' cannot show DX12 proxy switch');
  }
  model.game.chosen.apiResolution.api = model.api.effectiveApi = 'dx12'; model.layout.loadingMode = 'helper'; await ctrl().refresh(true);
  check(!button(host(), 'switch-proxy'), 'helper loading cannot show a proxy switch');
  model.layout.loadingMode = 'proxy'; model.layout.loadingBackend = 'hoyoshade'; await ctrl().refresh(true);
  check(!button(host(), 'switch-proxy'), 'HoYoShade backend cannot show a proxy switch');
  model.layout.loadingBackend = 'local'; model.defaults.proxyEntry = 'auto'; model.layout.proxyPaths = ['C:\\Fixture\\d3d12.dll']; await ctrl().refresh(true);
  check(button(host(), 'switch-proxy').textContent === '改用 DXGI', 'installed proxy path is the fallback when defaults are unresolved');
  click(host(), 'switch-proxy'); set('route', 'api', 'dx11');
  await until(() => state().draft.api === 'dx11', 'API draft');
  check(!Object.hasOwn(state().draft, 'proxyEntry') && !button(host(), 'switch-proxy'), 'leaving DX12 clears only an inapplicable proxy draft');
  click(host(), 'discard');
  document.querySelector('[data-view="hoyo"]').click(); const hoyo = () => document.querySelector('#hoyoWorkspace');
  await until(() => hoyo().querySelector('[data-hoyo-action="preview-install"]'), 'HoYo install');
  hoyo().querySelector('[data-hoyo-action="preview-install"]').click(); await until(() => hoyo().querySelector('.gp-nr-conflicts'), 'HoYo same confirmation');
  check(hoyo().querySelector('[data-hoyo-action="apply"]').textContent === '备份冲突并应用' && [...hoyo().querySelectorAll('.gp-modal details')].every(row => !row.open), 'HoYo uses the same short folded conflict confirmation');
  hoyo().querySelector('[data-hoyo-action="close-plan"]').click(); check(!window.__hoyoMock.calls.some(row => row[0] === 'apply'), 'HoYo conflict cancel performs no apply');
  hoyo().querySelector('[data-hoyo-action="preview-install"]').click(); await until(() => hoyo().querySelector('.gp-nr-conflicts'), 'HoYo confirmation again');
  await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 120));
  return { checks, assertions: checks.length, actualGameValidation: false };
}
let win;
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1180, height: 860, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${smoke.toString()})()`);
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, scope: 'production renderer / synthetic proxy and NR-conflict IPC fixtures', ...result }, null, 2));
    win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); if (win) { console.error(await win.webContents.executeJavaScript('document.body.innerText')); win.destroy(); } app.exit(1); }
});
