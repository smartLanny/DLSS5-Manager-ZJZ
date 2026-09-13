'use strict';
// Real DOM interaction with fake IPC; never opens or mutates a game.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-ui-'));
app.setPath('userData', path.join(temporary, 'profile')); app.disableHardwareAcceleration();
const source = fs.readFileSync(path.join(__dirname, 'launch-settings-frontend.electron.cjs'), 'utf8');
const prelude = source.slice(source.indexOf('function installMock()'), source.indexOf('async function smoke()'));
const preload = path.join(temporary, 'preload.cjs'); fs.writeFileSync(preload, `${prelude}\ninstallMock();`);
async function smoke() {
  const checks = [], calls = [];
  const assert = (condition, description) => { if (!condition) throw new Error(description); checks.push(description); };
  const wait = async predicate => { const end = Date.now() + 5000; while (!predicate()) { if (Date.now() > end) throw new Error('UI timeout'); await new Promise(r => setTimeout(r, 10)); } };
  const ok = value => ({ ok: true, value: structuredClone(value) });
  let game = { id: 'fixture', name: '环境维护验证', installed: true }, state = { pending: false, isolated: false, files: [], canRestore: false }, finishRepair;
  const manager = {
    inspectEnvironment: async () => ok(state),
    repair: () => { calls.push('repair'); return new Promise(resolve => { finishRepair = () => resolve(ok({ repaired: true })); }); },
    uninstall: async () => { calls.push('restore'); game.installed = false; return ok({ removed: true, notice: '原有 dxgi.dll 已保留。' }); },
    prepareEnvironmentCleanup: async () => { calls.push('preview'); game.installed = false; return ok({ planId: 'plan', scope: '只检查所选 EXE 同目录', candidates: [
      { name: 'dxgi.dll', kind: 'ReShade', bytes: 1024, selectable: true, selectedByDefault: true },
      { name: 'version.dll', kind: '来源未确认', bytes: 100, selectable: true, selectedByDefault: false },
      { name: 'd3d12.dll', kind: 'Microsoft', bytes: 100, selectable: false, selectedByDefault: false }
    ] }); },
    applyEnvironmentCleanup: async (id, plan, names) => { calls.push(['apply', id, plan, names]); state = { pending: false, isolated: true, canRestore: true, files: names, backupDirectory: 'C:\\fixture\\backup' }; return ok({ files: names, message: '文件已保留备份。' }); },
    restoreEnvironment: async () => { calls.push('undo'); state = { pending: false, isolated: false, canRestore: false, files: [] }; return ok({ restored: true }); }
  };
  const open = async () => { const modal = window.gameMaintenanceUi.open({ game: structuredClone(game), manager, onChanged: async () => structuredClone(game) }); await modal.ready; return modal; };
  const mode = (modal, value) => { const input = modal.element.querySelector(`input[value="${value}"]`); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); };
  const click = (modal, action) => modal.element.querySelector(`[data-maintenance-action="${action}"]`).click();
  let modal = await open();
  assert(modal.element.querySelectorAll('input[type="radio"]').length === 3, 'One maintenance entry contains three distinct operations');
  click(modal, 'start'); await wait(() => finishRepair);
  assert(modal.busy && modal.element.querySelector('[data-maintenance-action="close"]').disabled, 'Active work disables close and further submissions');
  click(modal, 'start'); assert(calls.filter(x => x === 'repair').length === 1, 'Double click submits one repair');
  finishRepair(); await wait(() => !modal.busy);
  assert(modal.element.textContent.includes('修复操作已完成'), 'Repair completion remains visible');
  mode(modal, 'restore'); click(modal, 'start'); await wait(() => !modal.busy);
  assert(calls.includes('restore') && modal.element.textContent.includes('原有 dxgi.dll 已保留'), 'Restore reports retained original files');
  mode(modal, 'clean'); click(modal, 'start'); await wait(() => !modal.busy);
  assert(calls.includes('preview') && !calls.some(x => Array.isArray(x)), 'First cleanup step shows a preview without isolating files');
  assert(modal.element.querySelector('[data-maintenance-file="dxgi.dll"]').checked && !modal.element.querySelector('[data-maintenance-file="version.dll"]').checked,
    'Known external plugin is preselected and unknown DLL is opt-in');
  assert(modal.element.querySelector('[data-maintenance-file="d3d12.dll"]').disabled, 'System runtime cannot be selected');
  click(modal, 'apply'); await wait(() => !modal.busy);
  assert(JSON.stringify(calls.find(x => Array.isArray(x))) === JSON.stringify(['apply', 'fixture', 'plan', ['dxgi.dll']]), 'Confirmed isolation sends exactly the selected filename and preview identity');
  assert(modal.element.querySelector('[data-maintenance-action="undo"]') && modal.element.textContent.includes('C:\\fixture\\backup'), 'Successful isolation exposes its backup and undo action');
  click(modal, 'undo'); await wait(() => !modal.busy); assert(!modal.element.querySelector('[data-maintenance-action="undo"]'), 'Successful undo clears only the active isolation state');
  modal.close(); state = { pending: true, isolated: false, canRestore: true };
  manager.restoreEnvironment = async () => ({ ok: false, error: { code: 'ENVIRONMENT_FILE_CHANGED', message: '外部文件已改变，备份仍保留' } });
  modal = await open(); assert(!modal.element.querySelector('[data-maintenance-action="start"]') && modal.element.querySelector('[data-maintenance-action="undo"]'), 'Interrupted cleanup exposes owner recovery while ordinary writes are blocked');
  click(modal, 'undo'); await wait(() => !modal.busy);
  assert(modal.element.querySelector('[role="alert"]').textContent.includes('ENVIRONMENT_FILE_CHANGED') && modal.element.querySelector('[data-maintenance-action="undo"]'), 'Recovery failure preserves the visible cause and retry action');
  modal.close(); state = { pending: false, isolated: false, canRestore: false, remainingFiles: [{ name: 'DLSS5-AI渲染超分版-beta0.4.6-hotfix.1-@野生的装机宅-Bilibili.addon64', legacyNr: true }] };
  modal = await open();
  assert(modal.element.querySelector('.maintenance-residuals')?.textContent.includes('hotfix.1'), 'An uninstalled game still exposes its historical Add-on residual');
  click(modal, 'start'); await wait(() => !modal.busy);
  return { checks };
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 960, height: 900, show: false, webPreferences: { preload, sandbox: true, contextIsolation: false, nodeIntegration: false, offscreen: true } });
  try {
    await win.loadFile(path.join(process.env.MANAGER_UI_ROOT || path.resolve(__dirname, '..'), 'src/renderer/index.html'));
    const result = await win.webContents.executeJavaScript(`(${smoke.toString()})()`);
    win.webContents.invalidate(); await new Promise(resolve => setTimeout(resolve, 180));
    if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, ...result }, null, 2)); win.destroy(); app.exit(0);
  } catch (error) { console.error(error.stack); win.destroy(); app.exit(1); }
});
