'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { createStartupDiagnostics, watchWindow, PROCESS_LAUNCH_GUIDANCE } = require('./src/product/startup-diagnostics');
const { createStartupElevation, withPermissionRecovery } = require('./src/product/startup-elevation');
const { createOperationElevation } = require('./src/product/operation-elevation');
const { workerArguments, runOperationWorker } = require('./src/product/operation-worker');
const { app, BrowserWindow, ipcMain, dialog, screen, shell, clipboard } = require('electron');
let portableData = null, portableDataError = null;
try { portableData = require('./src/product/portable-data').configurePortableData(app); }
catch (error) { portableDataError = error; }
const startup = createStartupDiagnostics(portableData ? { roots:[path.join(portableData.logs, 'startup')] } : {});
const operationWorkerRequested = process.argv.some(value => typeof value === 'string' && (value.startsWith('--operation-worker=') || value.startsWith('--hoyo-launch-worker=')));
let createAppService, createSrModelService, createLaunchSettingsService, createLaunchCoordinator, installGuards, createFgComponents, classifyApi;

let win = null;
let service = null;
let srModel = null;
let launchSettings = null;
let launchCoordinator = null;
let fgComponents = null;
let fgWorkflow = null;
let preparation = null;
let environment = null;
let operationPlans = null;
let operationElevation = null;
let hoyoLaunchPlans = null;
let hoyoWorkflow = null;
let launchSessions = null;
let runtimeVerification = null;
let gameAssessment = null;
let verificationRecords = null;
let currentHardware = null;
let compatibilityFeedback = null;
let launcherCompatibility = null;
let managerUpdate = null;
let windowWatch = null;
let failureVisible = false;
let quitting = false;
let singleInstanceOwned = false;
app.on('before-quit', () => { quitting = true; });
const softwareRendering = app.commandLine.hasSwitch('software-rendering');
const noSandbox = app.commandLine.hasSwitch('no-sandbox');
const sandboxRetryOnce = app.commandLine.hasSwitch('sandbox-retry-once');
if (softwareRendering) { app.disableHardwareAcceleration(); startup.log('software-rendering-requested'); }
startup.log('startup-options', { noSandbox, sandboxRetryOnce, disableGpu: app.commandLine.hasSwitch('disable-gpu'),
  disableGpuSandbox: app.commandLine.hasSwitch('disable-gpu-sandbox'), softwareRendering,
  chromium: process.versions.chrome || '', osRelease: os.release(),
  nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS), electronRunAsNodePresent: Boolean(process.env.ELECTRON_RUN_AS_NODE),
  compatibilityLayerPresent: Boolean(process.env.__COMPAT_LAYER) });
startup.log('elevation-policy', { mode: 'on-demand', requested: app.commandLine.hasSwitch('as-admin') });

async function exportStartupReport() {
  const selected = await dialog.showSaveDialog({ title: '保存精简启动诊断', defaultPath: 'DLSS5-启动诊断.txt', filters: [{ name: '文本诊断', extensions: ['txt'] }] });
  if (!selected.canceled && selected.filePath) { startup.exportTo(selected.filePath); shell.showItemInFolder(selected.filePath); }
}

async function startupFailure(title, error, softwareRetry = false) {
  if (operationWorkerRequested) { startup.log('operation-worker-startup-failed', { title, code: error?.code, message: error?.message }); app.exit(1); return; }
  const sandboxRetry = error?.sandboxFailure === true && !noSandbox && !sandboxRetryOnce;
  startup.log('startup-failure', { title, code: error?.code || '', type: error?.type, reason: error?.reason, exitCode: error?.exitCode,
    sandboxFailure: error?.sandboxFailure === true,
    message: error?.message || String(error), stack: error?.stack || '' });
  if (failureVisible) return;
  failureVisible = true;
  try {
    if (!app.isReady()) {
      let saved = '';
      try { if (startup.directory) saved = startup.exportTo(path.join(startup.directory, '启动失败诊断.txt')); } catch {}
      dialog.showErrorBox('管理器启动失败', `${title}\n${error?.message || ''}\n${saved ? `诊断已保存：${saved}` : '请运行独立的“启动诊断.cmd”导出诊断。'}`);
      app.exit(1);
      return;
    }
    await app.whenReady();
    const result = await dialog.showMessageBox({ type: 'error', title: '管理器未能正常启动', message: title,
      detail: `${error?.message || '启动过程未完成。'}\n可以直接导出精简诊断。不会自动删除旧配置，也不能仅凭此判断缺少 VC++。${sandboxRetry ? '\n已确认 Electron 子进程启动失败，可只在下一次启动临时关闭沙箱排障；该选择不会保存。' : ''}`,
      buttons: sandboxRetry ? ['导出诊断', '临时兼容重试', '关闭'] : softwareRetry ? ['导出诊断', '使用软件渲染重启', '关闭'] : ['导出诊断', '关闭'], cancelId: sandboxRetry || softwareRetry ? 2 : 1 });
    if (result.response === 0) { await exportStartupReport(); app.quit(); }
    else if (sandboxRetry && result.response === 1) {
      const args = process.argv.slice(1).filter(arg => arg !== '--no-sandbox' && arg !== '--sandbox-retry-once' && !arg.startsWith('--sandbox-retry-once='));
      startup.log('sandbox-retry-once-requested');
      app.relaunch({ args:[...args,'--no-sandbox','--sandbox-retry-once'] }); app.quit();
    }
    else if (softwareRetry && result.response === 1) { app.relaunch({ args: [...process.argv.slice(1).filter(arg => arg !== '--software-rendering'), '--software-rendering'] }); app.quit(); }
    else app.quit();
  } catch (failure) {
    startup.log('error-dialog-failed', { message: failure.message });
    try { dialog.showErrorBox('管理器启动失败', `${title}\n${error?.message || ''}\n请运行随包的“启动诊断.cmd”导出诊断。`); } catch {}
    app.quit();
  } finally { failureVisible = false; }
}
process.on('uncaughtException', error => { void startupFailure('启动过程发生异常', error); });
process.on('unhandledRejection', error => { void startupFailure('启动过程未完成', error); });
process.on('exit', code => startup.log('process-exit', { code }));
app.on('child-process-gone', (_event, details) => {
  startup.log('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName, name: details.name });
  if (!quitting && details.type === 'GPU' && ['launch-failed', 'integrity-failure'].includes(details.reason)) {
    void startupFailure('图形子进程无法启动', Object.assign(new Error(`GPU process: ${details.reason} (${details.exitCode})。${PROCESS_LAUNCH_GUIDANCE}`),
      { type: details.type, reason: details.reason, exitCode: details.exitCode, sandboxFailure:true }));
  }
});

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function runPowerShell(command, timeout = 15000) {
  return new Promise((resolve, reject) => execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16384 }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
}

const elevation = createStartupElevation({ app, runPowerShell, processInfo: process, log: startup.log });

async function inspectLaunchMode(id) {
  const seed = typeof service.assessmentSeed === 'function' ? await service.assessmentSeed(id) : null;
  const game = seed || (await service.listGames()).find(row => row.id === id), exe = service.gameExecutable(id);
  if (!game) throw Object.assign(new Error('游戏已不在当前库中。'), { code: 'LAUNCH_TARGET' });
  const layout = service.getLayout(id);
  if (layout.loadingBackend === 'hoyoshade') return { selected: layout.launcher?.kind || 'hoyoplay',
    effective: layout.launcher?.kind || 'hoyoplay', exe, loadingBackend: 'hoyoshade', steamAvailable: false,
    launcher: layout.launcher, bindingId: layout.bindingId,
    instruction: layout.launcher?.kind === 'starward' ? '通过已绑定的 Starward 启动。' : '助手就绪后，在 HoYoPlay 中点击启动。' };
  const chosen = seed?.scan?.chosen || service.gameScan(id).chosen || game.chosen || {};
  const verified = game.verifiedSteamAppId || chosen.verifiedSteamAppId;
  const steamRoot = game.steamRoot || chosen.steamRoot;
  const steamAvailable = /^\d{1,10}$/.test(String(verified || '')) && typeof steamRoot === 'string' && path.isAbsolute(steamRoot);
  const state = service.store.read(), entry = state.gameOverrides[path.resolve(service.gameDirectory(id)).toLowerCase()];
  const override = entry?.launchExecutable && path.resolve(entry.launchExecutable).toLowerCase() === path.resolve(exe).toLowerCase() ? entry.launchMode : 'auto';
  const selected = ['steam', 'exe'].includes(override) ? override : 'auto';
  const profileGame = { ...game, scan:{ ...(seed?.scan || service.gameScan(id)), chosen },
    ...(steamAvailable ? { verifiedSteamAppId:String(verified), steamRoot } : {}) };
  const selection = require('./src/product/operation-api').resolveOperationApi(profileGame);
  const profile = launcherCompatibility?.resolveLaunchProfile(profileGame, selection.effectiveApi, { preference:selected });
  const effective = profile?.launchMode || (selected === 'auto' ? steamAvailable ? 'steam' : 'exe' : selected);
  return { selected, effective, steamAvailable,
    steamAppId: steamAvailable ? String(verified) : null, steamRoot: steamAvailable ? steamRoot : null, exe,
    launchProfile:profile || null, instruction:profile?.reason || null, warning:profile?.warning || null };
}
async function setLaunchMode(id, mode) {
  if (!['auto', 'steam', 'exe'].includes(mode)) throw Object.assign(new Error('启动方式无效。'), { code: 'LAUNCH_MODE' });
  const current = await inspectLaunchMode(id);
  if (current.loadingBackend === 'hoyoshade') throw Object.assign(new Error('米哈游模式的启动方式由客户端绑定决定，请在兼容设置中修改。'), { code: 'LAUNCH_HOYO_BOUND' });
  if (mode === 'steam' && !current.steamAvailable) throw Object.assign(new Error('当前游戏没有可验证的 Steam 安装身份。'), { code: 'LAUNCH_STEAM_UNVERIFIED' });
  const state = service.store.read(), key = path.resolve(service.gameDirectory(id)).toLowerCase();
  await service.store.write({ gameOverrides: { ...state.gameOverrides, [key]: { ...state.gameOverrides[key], launchMode: mode, launchExecutable: current.exe } } });
  await service.refresh(); return inspectLaunchMode(id);
}
async function applyEnhancement(id, domain, input, options = {}) {
  const policy = require('./src/product/launch-settings-policy');
  const request = policy.validateRequest(domain, input);
  await launchSettings.assertReady(id);
  if (!policy.isRestore(domain, request)) {
    const eligibility = await launchSettings.assessEligibility(id, domain, request);
    if (!eligibility.eligible) throw Object.assign(new Error(eligibility.blockers.map(row => row.message).join('；')), { code: eligibility.blockers[0]?.code || 'SETTINGS_UNAVAILABLE' });
  }
  if (domain === 'fg' && request.backend === 'mfgunlock' && request.mode !== 'restore') return fgWorkflow.apply(id, request, options);
  if (policy.isRestore(domain, request)) {
    const result = await launchSettings.restore(id, domain);
    return { ...result, saved: true };
  }
  if (domain === 'fg' && request.mode !== 'restore') {
    if (request.backend === 'rtx40') throw Object.assign(new Error('旧补帧后端仅保留恢复能力，请先迁移到 MFG Unlock。'), { code: 'SETTINGS_FG_MIGRATION_REQUIRED' });
    const components = await fgComponents.inspect(id);
    if (components.route !== 'native') throw Object.assign(new Error('所选补帧路线与当前显卡不一致。'), { code: 'SETTINGS_FG_ROUTE_MISMATCH' });
    if (components.needsCleanup) { await launchSettings.restore(id, 'fg'); await fgComponents.restore(id); }
    else if (!components.ready) await fgComponents.prepare(id, { allowAntiCheat: options.allowAntiCheat === true });
  }
  const plan = await launchSettings.preview(id, domain, request, { reapplyExternalChanges: options.reapplyExternalChanges === true });
  const result = await launchSettings.apply(plan.id, { confirm: true });
  try { await launchSettings.save(id, domain, request); }
  catch (error) { throw Object.assign(new Error(`设置已应用，但未能记住选择：${error.message}`), { code: error.code || 'SETTINGS_SAVE_FAILED', details: { applied: true } }); }
  return { ...result, saved: true };
}

async function collectSessionFeedback(id, options = {}) {
  const report = await service.collectFeedback(id, options);
  const { safeJson } = require('./src/product/feedback');
  let assessment;
  try { assessment = await gameAssessment.assess(id); }
  catch (error) { assessment = { gameId: id, failures: [{ code: error.code || 'ASSESSMENT_UNAVAILABLE', message: error.message }],
    verification: require('./src/product/runtime-verification').emptyVerification() }; }
  const evidence = safeJson({ verification: assessment.verification, api: assessment.api || null,
    assessmentIdentity: { schema: assessment.schema || 1, gameId: assessment.gameId, assessedAt: assessment.assessedAt || null,
      exe: assessment.game?.executable || assessment.layout?.exe || null, failures: assessment.failures || [] },
    launchSession: assessment.launch?.session || null }, options.includePaths === true);
  const rows = [['helper', '加载助手'], ['core', '本 Core 加载'], ['nr', 'NR 处理'], ['visual', '视觉对照']].map(([key, label]) => {
    const value = evidence.verification?.[key];
    return `${label}：${value?.status || 'unverified'} · ${value?.detail || '本次尚无可核对证据。'}`;
  });
  return { ...report, ...evidence, report: { ...(report.report && typeof report.report === 'object' ? report.report : {}), ...evidence },
    text: `${report.text || ''}\n[本次会话验收]\n${rows.join('\n')}\n[会话验收数据]\n${JSON.stringify(evidence, null, 2)}\n` };
}

function addonArgs(argv) {
  return (argv || []).filter(file => typeof file === 'string' && /(?:\.addon64|\.zip)$/i.test(file));
}

let executableIconCache = null;
async function iconDataFor(file, currentIcon = null) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  const current = typeof currentIcon === 'string' && currentIcon.length <= 1024 * 1024 ? currentIcon : null;
  let fallback = null, recognizedShellIcon = !current;
  for (const size of ['large', 'normal', 'small']) {
    try {
      const icon = await app.getFileIcon(file, { size });
      if (icon && !icon.isEmpty()) {
        const data = icon.toDataURL();
        fallback ||= data;
        if (current === data) recognizedShellIcon = true;
      }
    } catch {}
  }
  // Upgrade old automatically extracted shell icons only when their exact
  // bytes match. A user-selected icon is never replaced on a guess.
  if (!recognizedShellIcon) return current;
  try {
    executableIconCache ||= require('./src/product/executable-icon').createExecutableIconCache();
    const resource = executableIconCache.get(file);
    if (resource) return resource;
  } catch {}
  return fallback || current;
}

function createWindow() {
  let workArea = null;
  try { workArea = screen?.getPrimaryDisplay()?.workAreaSize || null; } catch {}
  const validArea = workArea && Number.isFinite(workArea.width) && Number.isFinite(workArea.height) && workArea.width > 0 && workArea.height > 0;
  const fit = (desired, floor, available) => validArea ? Math.min(desired, Math.max(Math.min(floor, available), available - 32)) : desired;
  const width = fit(1400, 480, workArea?.width);
  const height = fit(860, 360, workArea?.height);
  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(900, width),
    minHeight: Math.min(620, height),
    center: true,
    backgroundColor: '#fbfbfa',
    // Windows uses the exact same multi-size ICO for the window and the
    // packaged executable, so Explorer and the taskbar cannot diverge.
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  startup.log('window-created');
  windowWatch = watchWindow(win, { log: startup.log, fail: (...args) => { if (!quitting) void startupFailure(...args); },
    onReady() {
      startup.log('normal-window-ready');
    } });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html')).catch(error => { void startupFailure('界面文件加载失败', error); });
  win.on('closed', () => { win = null; });
}

function registerIpc() {
  ipcMain.on('startup-renderer-ready', event => { if (event.sender === win?.webContents) windowWatch?.ready(); });
  ipcMain.on('startup-renderer-failed', (event, message) => {
    if (event.sender === win?.webContents) windowWatch?.failed(new Error(String(message || '界面初始化失败').slice(0, 500)));
  });
  ipcMain.handle('startup-export', () => exportStartupReport());
  const fromMainWindow = event => win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.handle('startup-context', async event => fromMainWindow(event)
    ? { ok: true, value: { ...await elevation.context(), operation: await operationElevation.inspect() } }
    : { ok: false, error: { code: 'ERR_BAD_REQUEST', message: '启动状态请求来源无效。' } });
  ipcMain.handle('startup-restart-elevated', async (event, request) => {
    return { ok: false, error: { code: 'STARTUP_WHOLE_APP_ELEVATION_DISABLED', message: '整体管理员重启已移除，请从具体变更预览选择本次管理员应用。' } };
  });
  ipcMain.handle('operation-elevation-inspect', async event => fromMainWindow(event)
    ? service.withError(() => operationElevation.inspect()) : { ok: false, error: { code: 'IPC_SENDER', message: '请求来源无效。' } });
  ipcMain.handle('operation-elevation-recover', async (event, request) => {
    if (!fromMainWindow(event) || request?.confirm !== true) return { ok: false, error: { code: 'CONFIRM_REQUIRED', message: '请明确恢复已结束的一次性操作。' } };
    return service.withError(() => launchCoordinator.serialize(() => operationElevation.recover()));
  });
  const loggedGameActions = new Set([
    'game-install', 'game-repair', 'game-upgrade-addon', 'game-uninstall', 'game-api-set', 'game-route-apply', 'game-user-addon-set',
    'game-toggle-d3d12', 'game-launch', 'game-diagnose', 'game-rename', 'game-hotkeys-read',
    'game-hotkey-write', 'nr-read', 'nr-write', 'nr-default', 'nr-recommended',
    'sr-model-read', 'sr-model-write', 'feedback-export', 'launch-settings-inspect',
    'launch-settings-save', 'launch-settings-preview', 'launch-settings-restore', 'launch-settings-recover',
    'fg-components-prepare', 'fg-components-restore', 'launch-settings-update', 'launch-settings-reset-all',
    'game-reframework-inspect', 'game-reframework-prepare', 'game-reframework-restore', 'game-reframework-recover',
    'game-feeder-inspect', 'game-feeder-install', 'game-feeder-restore', 'game-prepare-all', 'game-preparation-recover', 'fg-components-recover',
    'game-environment-inspect', 'game-environment-prepare-clean', 'game-environment-preview-clean', 'game-environment-apply', 'game-environment-restore', 'game-library-remove',
    'game-operation-preview', 'game-operation-apply', 'game-operation-apply-elevated', 'game-operation-recover', 'game-feature-confirm'
  ]);
  const guardedActions = new Set(['game-install', 'game-repair', 'game-upgrade-addon', 'game-toggle-d3d12',
    'game-api-set', 'game-route-apply', 'nr-write', 'nr-default', 'nr-recommended', 'game-hotkey-write', 'game-reframework-prepare', 'game-reframework-restore',
    'game-feeder-install', 'game-prepare-all', 'game-user-addon-set']);
  const serializedActions = new Set([...guardedActions, 'game-launch', 'game-uninstall', 'game-dismiss', 'game-library-remove',
    'game-confirm', 'game-rename', 'settings-update', 'sr-model-write', 'launch-settings-save', 'launch-settings-preview',
    'launch-settings-apply', 'launch-settings-restore', 'launch-settings-recover', 'fg-components-prepare', 'fg-components-restore',
    'payload-source-pick', 'payload-source-reset', 'payload-source-recheck', 'launch-settings-update', 'launch-settings-reset-all',
    'game-reframework-recover', 'game-feeder-restore', 'game-preparation-recover', 'fg-components-recover',
    'game-environment-prepare-clean', 'game-environment-preview-clean', 'game-environment-apply', 'game-environment-restore',
    'game-operation-preview', 'game-operation-apply', 'game-operation-apply-elevated', 'game-operation-recover', 'game-feature-confirm', 'game-user-addon-set']);
  for (const name of ['addon-import', 'addon-remove', 'pick-addon', 'pick-scan-folder', 'components-pick', 'components-runtime-pick', 'components-runtime-activate', 'game-component-apply']) serializedActions.add(name);
  guardedActions.add('game-component-apply');
  serializedActions.add('components-download');
  serializedActions.add('components-core-activate');
  serializedActions.add('components-provider-select');
  serializedActions.add('manager-update-prepare');
  serializedActions.add('manager-update-apply');
  loggedGameActions.add('game-component-apply');
  for (const name of ['hoyo-discover', 'hoyo-pick-game', 'hoyo-pick-launcher', 'hoyo-bind', 'hoyo-preview', 'hoyo-apply', 'hoyo-recover']) serializedActions.add(name);
  const call = (name, fn) => ipcMain.handle(name, async (_event, ...args) => withPermissionRecovery(await service.withError(
    () => {
      const work = async () => {
        if (_event.sender !== win?.webContents) throw Object.assign(new Error('请求不是来自当前管理器窗口。'), { code: 'IPC_SENDER' });
        if (serializedActions.has(name)) await operationElevation?.assertAvailable();
        if (serializedActions.has(name) && loggedGameActions.has(name) && !['game-operation-recover', 'game-preparation-recover', 'launch-settings-recover', 'fg-components-recover', 'game-reframework-recover', 'game-feeder-restore', 'game-environment-restore'].includes(name)) await operationPlans?.assertReady(args[0]);
        if (serializedActions.has(name) && loggedGameActions.has(name) && name !== 'game-environment-restore') await environment?.assertReady(args[0]);
        if (serializedActions.has(name) && loggedGameActions.has(name) && !['game-operation-recover', 'game-preparation-recover', 'launch-settings-recover', 'fg-components-recover', 'game-reframework-recover', 'game-feeder-restore', 'game-environment-restore'].includes(name)) await preparation?.assertReady(args[0]);
        if (guardedActions.has(name)) await launchCoordinator.assertMutationReady(args[0]);
        return fn(...args);
      };
      if (serializedActions.has(name) && operationElevation?.busy) throw Object.assign(new Error('一次性管理员操作正在执行，请等待明确结果。'), { code: 'ERR_JOB_BUSY' });
      return serializedActions.has(name) ? launchCoordinator.serialize(work) : work();
    },
    { action: name, gameId: loggedGameActions.has(name) && typeof args[0] === 'string' ? args[0] : null }
  )));
  call('boot', async () => {
    const data = await service.boot();
    currentHardware = data.hardware;
    for (const warning of data.discoveryWarnings || []) startup.log('launcher-discovery-warning', { code: warning.code, message: warning.message });
    return data;
  });
  call('games-refresh', () => service.refresh());
  call('games-list', () => service.listGames());
  call('game-assessment', (id, options) => gameAssessment.assess(id, options));
  call('hoyo-discover', () => hoyoWorkflow.discover());
  call('hoyo-inspect', (id, options) => hoyoWorkflow.inspect(id, { retry: options?.retry === true }));
  call('hoyo-pick-game', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '选择正式米哈游游戏程序', filters: [{ name: '游戏程序', extensions: ['exe'] }] });
    return hoyoWorkflow.pickGame(result.canceled ? null : result.filePaths[0]);
  });
  call('hoyo-pick-launcher', async id => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '选择这个客户端的 HoYoPlay 或 Starward 启动器', filters: [{ name: '启动器', extensions: ['exe'] }] });
    return hoyoWorkflow.pickLauncher(id, result.canceled ? null : result.filePaths[0]);
  });
  call('hoyo-bind', (id, input) => hoyoWorkflow.bind(id, input));
  call('hoyo-preview', (id, action) => hoyoWorkflow.preview(id, action));
  call('hoyo-apply', (id, planId, consent) => hoyoWorkflow.apply(id, planId, consent));
  call('hoyo-recover', id => hoyoWorkflow.recover(id));
  call('hoyo-start', async id => { await operationElevation.assertAvailable(); return hoyoWorkflow.start(id); });
  call('hoyo-cancel', id => hoyoWorkflow.cancel(id));
  call('game-visual-record', (id, input) => verificationRecords.record(id, input));
  call('game-operation-preview', (id, request) => operationPlans.preview(id, request));
  call('game-operation-apply', async (id, planId, consent) => {
    const plan = await operationPlans.loadPlan(planId, consent?.fingerprint);
    if (plan.gameId !== id) throw Object.assign(new Error('应用预览属于另一游戏。'), { code: 'OPERATION_TARGET' });
    return operationPlans.apply(planId, consent);
  });
  call('game-operation-apply-elevated', async (id, planId, consent) => {
    const result = await operationElevation.apply(id, planId, consent);
    await service.refresh(); return result;
  });
  call('game-operation-recover', id => operationPlans.recover(id));
  call('game-feature-confirm', (id, domain, value) => launchSettings.confirmGameFeature(id, domain, value));
  call('game-launch-session', id => launchSessions.inspect(id));
  call('game-launch-cancel', id => launchSessions.cancel(id));
  call('game-install', (id, options) => service.install(id, options));
  call('game-repair', (id, options) => service.repair(id, options));
  call('game-upgrade-addon', (id, version, options) => service.upgradeAddon(id, version, options));
  call('game-dismiss', id => launchCoordinator.dismiss(id));
  call('game-library-remove', async id => {
    await operationPlans.assertReady(id); await preparation.assertReady(id); await environment.assertReady(id);
    return launchCoordinator.removeLibraryEntry(id);
  });
  call('game-rename', (id, name) => service.renameGame(id, name));
  call('game-api-set', (id, api, options) => service.setGameApi(id, api, options));
  call('game-route-apply', (id, options) => service.applyGameRoute(id, options));
  call('game-prepare-all', (id, options) => preparation.prepare(id, options));
  call('game-preparation-inspect', id => preparation.inspect(id));
  call('game-preparation-recover', id => preparation.recover(id));
  call('game-environment-inspect', id => environment.inspect(id));
  call('game-environment-preview-clean', async id => {
    const deployment = await service.inspectDeployment(id);
    const settings = await launchCoordinator.inspect(id);
    const legacy = await srModel.migrationInfo(id);
    if (deployment.installed || deployment.needsRecovery || await launchSettings.hasOwnedState(id) || legacy?.baselineCaptured ||
        settings.fgComponents?.installed || settings.fgComponents?.managed || settings.fgComponents?.receipt || settings.fgComponents?.needsRecovery || settings.fgComponents?.needsCleanup ||
        settings.fgComponents?.fileRecoveryPending || settings.fgComponents?.fileOperationActive || settings.fgComponents?.migrationPending)
      throw Object.assign(new Error('请先选择卸载方式并恢复超分补帧设置，再预览剩余文件清理。'), { code: 'ENVIRONMENT_RESTORE_FIRST' });
    return environment.preview(id);
  });
  call('game-environment-prepare-clean', async id => {
    await launchCoordinator.restoreForUninstall(id);
    const restoration = await service.restoreManagedForCleanup(id);
    const preview = await environment.preview(id);
    return { ...preview, managedInstallationRestored: true, restorationNotice: restoration.notice || '本管理器的配套已恢复到安装前状态。' };
  });
  call('game-environment-apply', async (id, planId, names) => service.refreshAfterMutation(await environment.apply(id, planId, names)));
  call('game-environment-restore', async id => {
    const recovered = await environment.recoverPending(id);
    await preparation.assertReady(id);
    await launchCoordinator.restoreForUninstall(id);
    await service.restoreManagedForCleanup(id);
    return service.refreshAfterMutation({ ...await environment.restore(id), interruptedFilesRecovered: recovered.recovered });
  });
  call('game-feeder-inspect', id => service.inspectFeeder(id));
  call('game-feeder-install', (id, options) => service.installFeeder(id, options));
  call('game-feeder-restore', async id => {
    const pending = await launchSettings.pending(id);
    if (pending.some(row => row.kind !== 'file-journal')) throw Object.assign(new Error('驱动设置有未完成操作，请先恢复超分补帧设置。'), { code: 'SETTINGS_RECOVERY_FIRST' });
    // The Feeder owner validates its WAL, current files and game process. A
    // generic pending-file guard would make this recovery impossible to reach.
    return service.restoreFeeder(id);
  });
  call('game-toggle-d3d12', (id, enabled, options) => service.toggleD3D12(id, enabled === true, options));
  call('game-uninstall', async (id, removeSettings) => {
    await launchCoordinator.restoreForUninstall(id);
    const result = await service.uninstall(id, removeSettings === true);
    try {
      const remainingFiles = await environment.remaining(id);
      return { ...result, remainingFiles, notice: remainingFiles.length
        ? `已恢复安装前状态；目录中仍有 ${remainingFiles.map(row => row.name).join('、')}。可继续选择“尝试恢复干净环境”备份隔离。`
        : result.notice || '已恢复安装前状态；所选 EXE 同目录未发现图形代理和 Add-on。' };
    } catch (error) { return { ...result, remainingCheckFailed: true, notice: `安装已恢复，但残留检查未完成：${error.message}。请在维护入口重新检查。` }; }
  });
  call('game-launch', async id => {
    let result;
    try { result = await launchCoordinator.launch(id); }
    catch (error) {
      const outcomes = error?.details?.launchSettings;
      if (Array.isArray(outcomes) && win && !win.isDestroyed()) {
        win.webContents.send('launch-settings-applied', {
          id,
          outcomes: outcomes.filter(row => row?.applied === true || row?.skipped === true),
          launchFailed: true
        });
      }
      throw error;
    }
    if (win && !win.isDestroyed()) {
      if (result.srModel) win.webContents.send('sr-model-applied', { id, ...result.srModel });
      win.webContents.send('launch-settings-applied', { id, outcomes: result.launchSettings });
    }
    return result;
  });
  call('game-diagnose', id => service.diagnose(id));
  call('nr-read', id => service.readNrSettings(id));
  call('nr-write', (id, patch) => service.writeNrSettings(id, patch));
  call('sr-model-read', id => srModel.read(id));
  call('sr-model-write', (id, selection) => launchCoordinator.writeLegacySr(id, selection));
  call('launch-settings-inspect', id => launchCoordinator.inspect(id));
  call('launch-settings-save', (id, domain, request) => launchSettings.save(id, domain, request));
  call('launch-settings-preview', (id, domain, request) => launchSettings.preview(id, domain, request));
  call('launch-settings-apply', (planId, consent) => launchSettings.apply(planId, { confirm: consent?.confirm === true }));
  call('launch-settings-restore', (id, domain) => launchSettings.restore(id, domain));
  call('launch-settings-recover', id => launchSettings.recover(id));
  call('launch-settings-update', (id, domain, input, options = {}) => applyEnhancement(id, domain, input, options));
  call('launch-settings-reset-all', async id => {
    const outcomes = [];
    for (const domain of ['fg', 'sr']) {
      try { const result = await launchSettings.restore(id, domain); outcomes.push({ domain, ok: true, result }); }
      catch (error) { outcomes.push({ domain, ok: false, code: error.code, message: error.message }); }
    }
    if (outcomes.some(row => !row.ok)) throw Object.assign(new Error(outcomes.filter(row => !row.ok).map(row => `${row.domain.toUpperCase()}：${row.message}`).join('；')),
      { code: 'SETTINGS_RESTORE_INCOMPLETE', details: { outcomes } });
    return { restored: true, outcomes };
  });
  call('fg-components-prepare', async (id, options) => {
    const result = await fgWorkflow.prepare(id, options);
    return service.refreshAfterMutation(result);
  });
  call('fg-components-recover', async id => service.refreshAfterMutation(await fgWorkflow.recover(id)));
  call('fg-components-restore', async id => {
    await launchSettings.assertReady(id);
    await launchSettings.restore(id, 'fg');
    const result = await fgComponents.restore(id);
    return service.refreshAfterMutation(result);
  });
  call('game-hotkeys-read', id => service.readGameHotkeys(id));
  call('game-reframework-inspect', id => service.readReframework(id));
  call('game-reframework-prepare', (id, options) => service.prepareReframework(id, options));
  call('game-reframework-restore', id => service.restoreReframework(id));
  call('game-reframework-recover', id => service.recoverReframework(id));
  call('game-hotkey-write', (id, target, binding) => service.writeGameHotkey(id, target, binding));
  call('nr-default', id => service.applyDefault(id));
  call('nr-recommended', id => service.applyDefault(id));
  call('settings-update', patch => service.updateSettings(patch));
  call('addon-list', () => service.listAddonVersions());
  call('payload-source-read', () => service.payloadState());
  call('components-list', () => service.listComponents());
  call('components-providers', () => service.inspectComponentProviders());
  call('components-provider-select', id => service.selectComponentProvider(id));
  call('manager-update-check', () => managerUpdate ? managerUpdate.check() : Promise.reject(Object.assign(new Error('当前版本未配置自动更新清单。'), { code:'UPDATE_CONFIGURATION' })));
  call('manager-update-prepare', manifest => managerUpdate ? managerUpdate.prepare(manifest) : Promise.reject(Object.assign(new Error('当前版本不能自动准备更新。'), { code:'UPDATE_CONFIGURATION' })));
  call('manager-update-cancel', () => managerUpdate?.cancel() === true);
  call('manager-update-apply', async () => {
    if (!managerUpdate) throw Object.assign(new Error('当前版本不能自动应用更新。'), { code:'UPDATE_CONFIGURATION' });
    const result = await managerUpdate.launchApply(); setImmediate(() => app.quit()); return result;
  });
  call('components-updates', () => service.checkComponentUpdates());
  call('components-download', id => service.downloadComponent(id));
  call('game-components', id => service.componentChoices(id));
  call('game-component-apply', (id, bridge) => service.applyBridgeComponent(id, bridge));
  call('game-user-addon-set', (id, componentId, enabled) => service.setUserAddon(id, componentId, enabled === true));
  call('components-runtime-activate', id => service.activateComponentRuntime(id));
  call('components-core-activate', id => service.activateComponentCore(id));
  call('components-storage-pick', async () => {
    const current=await service.listComponents();
    const result=await dialog.showOpenDialog(win,{properties:['openDirectory'],title:'选择组件仓库所在磁盘或目录',
      defaultPath:path.dirname(current.storage.root)});
    if (result.canceled || !result.filePaths[0]) return null;
    return service.moveComponentLibrary(result.filePaths[0]);
  });
  call('components-pick', async directory => {
    const result = await dialog.showOpenDialog(win, { properties: [directory ? 'openDirectory' : 'openFile'],
      title: '导入运行库或外部组件', ...(directory ? {} : { filters: [{ name: '组件包与模块', extensions: ['zip','json','dll','addon64','addon32'] }] }) });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.importComponent(result.filePaths[0]);
  });
  call('components-runtime-pick', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '选择 NR 运行库 DLC（RTX40 / RTX50）',
      filters: [{ name: 'NR 运行库 DLC', extensions: ['zip'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.importRuntimeDlc(result.filePaths[0]);
  });
  call('payload-source-pick', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择完整组件目录',
      defaultPath: service.store.read().payloadSourcePath || service.payloadDir });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.selectPayloadSource(result.filePaths[0]);
  });
  call('payload-source-reset', () => service.selectPayloadSource(null));
  call('payload-source-recheck', () => service.recheckPayloadSource());
  call('addon-import', file => service.importAddonFile(file));
  call('addon-remove', id => service.removeAddonVersion(id));
  call('game-art', id => service.fetchGameArt(id));
  call('game-icon', async (id, currentIcon) => {
    const file = service.gameExecutable(id);
    return iconDataFor(file, currentIcon);
  });
  call('game-selection-icon', file => iconDataFor(file));

  call('pick-game', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择游戏安装目录' });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.prepareGameSelection(result.filePaths[0]);
  });
  call('pick-executable', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '选择游戏运行程序', filters: [{ name: 'Windows 游戏程序', extensions: ['exe'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.prepareGameSelection(result.filePaths[0], result.filePaths[0]);
  });
  call('pick-hoyo-launcher', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], title: '选择 HoYoPlay 或 Starward 启动器', filters: [{ name: 'Windows 启动器', extensions: ['exe'] }] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  call('game-confirm', selection => launchCoordinator.confirmSelection(selection));
  call('pick-game-icon', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择游戏图标',
      filters: [{ name: '图标或程序', extensions: ['ico', 'exe', 'dll'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return { file: result.filePaths[0], icon: await iconDataFor(result.filePaths[0]) };
  });
  call('pick-addon', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择 DLSS 5 Addon 或标准 OTA 包',
      filters: [{ name: 'DLSS 5 Addon / 标准 OTA', extensions: ['addon64', 'zip'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.importAddonFile(result.filePaths[0]);
  });
  call('pick-scan-folder', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择游戏库目录' });
    if (result.canceled || !result.filePaths[0]) return null;
    return service.addScanFolder(result.filePaths[0]);
  });
  call('open-external', async key => {
    if (typeof key !== 'string') return false;
    let url = service.product[key];
    if (key === 'antiCheatPolicy') url = 'https://help.steampowered.com/zh-cn/faqs/view/571A-97DA-70E9-FF74';
    else if (key.startsWith('gameCompatibility:')) {
      const id = key.slice('gameCompatibility:'.length), game = (await service.listGames()).find(row => row.id === id);
      if (!game || typeof game.name !== 'string' || !game.name.trim()) return false;
      url = `https://www.google.com/search?q=${encodeURIComponent(`${game.name} ReShade 反作弊 兼容性`)}`;
    }
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });
  call('open-folder', async id => {
    const dir = service.gameDirectory(id);
    return (await shell.openPath(dir)) === '';
  });
  call('copy-text', text => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) return false;
    clipboard.writeText(text);
    return true;
  });
  call('feedback-export', async (id, options = {}) => {
    const report = await collectSessionFeedback(id, options);
    const result = await dialog.showSaveDialog(win, {
      title: '保存问题反馈日志',
      defaultPath: path.join(app.getPath('downloads'), report.suggestedName),
      filters: [{ name: '反馈日志（TXT）', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, report.text, 'utf8');
    return result.filePath;
  });
  call('feedback-build', (id, options = {}) => collectSessionFeedback(id, options));
  call('compatibility-open', id => compatibilityFeedback.open(id));
  call('compatibility-preview', (token, request) => compatibilityFeedback.preview(token, request));
  call('compatibility-save', (token, request) => compatibilityFeedback.save(token, request));
  call('compatibility-discard', (token, previewId) => compatibilityFeedback.discard(token, previewId));
  call('compatibility-close', token => compatibilityFeedback.close(token));

  ipcMain.on('window-minimize', () => win && win.minimize());
  ipcMain.on('window-maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window-close', () => win && win.close());
}

async function initializeServices({ worker = false, hoyoWorker = false, workerControls = null } = {}) {
    ({ createAppService } = require('./src/product/app-service'));
    ({ createSrModelService } = require('./src/product/sr-model-service'));
    ({ createLaunchSettingsService } = require('./src/product/launch-settings-service'));
    ({ createLaunchCoordinator } = require('./src/product/launch-coordinator'));
    installGuards = require('./src/core/install-guards');
    ({ createFgComponents } = require('./src/product/fg-components'));
    ({ classifyApi } = require('./src/product/game-support'));
    startup.log('business-modules-loaded');
    const userData = app.getPath('userData');
    service = createAppService({
      userData,
      documentsDir: app.getPath('documents'),
      resourcesPath: process.resourcesPath,
      appDir: __dirname,
      version: app.getVersion(),
      overrides: { applicationDir:app.isPackaged ? path.dirname(process.execPath) : null,
        portableExecutable:process.env.PORTABLE_EXECUTABLE_FILE || null,
        getFeatureEvidence: (id, domain) => featureProbe.inspect(id, domain), getKnownComponents: async id => fgComponents ? [
        ...await fgComponents.ownedModuleManifest(id).then(rows => rows.map(row => ({ ...row, owned: true, compatibility: 'compatible' }))),
        ...(typeof fgComponents.catalog === 'function' ? fgComponents.catalog() : []).map(row => ({ sha256: row.sha256, role: 'mfgunlock', compatibility: 'compatible' }))
      ] : [] }
    });
    if (!worker && typeof service.product?.updateManifestUrl === 'string') {
      managerUpdate = require('./src/product/manager-update').createManagerUpdate({ currentVersion:app.getVersion(),
        manifestUrl:service.product.updateManifestUrl, root:portableData?.updates || path.join(userData,'updates'),
        applicationDirectory:app.isPackaged ? path.dirname(process.execPath) : null,
        executable:app.isPackaged ? process.execPath : null, portable:Boolean(portableData),
        progress:value => { if (win && !win.isDestroyed()) win.webContents.send('manager-update-progress',value); } });
    }
    startup.log('state-store-opened');
    const configRecovery = service.store.readRecoveryStatus?.();
    if (!worker && configRecovery && !['ok', 'missing', 'unread'].includes(configRecovery.state)) {
      startup.log('settings-recovery', { state: configRecovery.state, reason: configRecovery.reason, message: configRecovery.message });
      void dialog.showMessageBox({ type: 'warning', title: '已保留旧配置', message: configRecovery.message,
        detail: '原配置和游戏备份没有被删除。需要协助时，可通过启动诊断导出当前状态。', buttons: ['知道了'] });
    }
    srModel = createSrModelService({
      userData,
      resourcesPath: process.resourcesPath,
      appDir: __dirname,
      gameDirectory: id => service.gameDirectory(id),
      gameExecutable: id => service.gameExecutable(id)
    });
    const featureProbe = require('./src/product/native-enhancement-probe').createNativeEnhancementProbe({
      gameDirectory: id => service.gameDirectory(id), gameExecutable: id => service.gameExecutable(id),
      gameMetadata: id => service.assessmentSeed(id), scan: id => service.gameScan(id),
      resourcesPath: process.resourcesPath, appDir: __dirname
    });
    launchSettings = createLaunchSettingsService({
      userData, resourcesPath: process.resourcesPath, appDir: __dirname,
      gameDirectory: id => service.gameDirectory(id),
      getLayout: id => service.getLayout(id), scan: id => service.gameScan(id),
      gameExecutable: id => service.gameExecutable(id), legacySrModel: srModel,
      getFeatureEvidence: (id, domain) => featureProbe.inspect(id, domain),
      assertComponents: async (id, backend) => {
        const state = await fgComponents.inspect(id);
        if (backend === 'rtx40') throw Object.assign(new Error('旧补帧后端仅允许恢复。'), { code: 'SETTINGS_FG_MIGRATION_REQUIRED' });
        if (state.migrationPending && !fgWorkflow?.isPreparing(id)) throw Object.assign(new Error('补帧迁移尚未完成，请先恢复。'), { code: 'SETTINGS_FG_MIGRATION_PENDING' });
        if ((backend === 'mfgunlock' && state.route !== 'compatibility') || (backend === 'nvidia' && state.route !== 'native'))
          throw Object.assign(new Error('补帧设置与当前显卡路线不一致。'), { code: 'SETTINGS_FG_ROUTE_MISMATCH' });
        if (!state.ready) throw Object.assign(new Error(state.needsCleanup
          ? '请先切换为原生帧生成路线，处理旧兼容组件。'
          : '请先准备完整的帧生成兼容组件，再应用设置。'), { code: 'SETTINGS_COMPONENTS_NOT_READY' });
      }
    });
    fgComponents = createFgComponents({
      resourcesPath: process.resourcesPath, appDir: __dirname, userData,
      gameDirectory: id => service.gameDirectory(id), gameExecutable: id => service.gameExecutable(id),
      getLayout: id => service.getLayout(id),
      getFeatureEvidence: (id, domain) => featureProbe.inspect(id, domain),
      scan: id => {
        const scan = service.gameScan(id);
        const capability = require('./src/product/game-enhancement-capabilities').inspectNativeEnhancementCapabilities(scan);
        return { api: classifyApi(scan.chosen),
          streamlineFg: capability.nativeFgAvailable,
          dlssgFiles: (scan.dlssFiles || []).filter(row => /^nvngx_dlssg\.dll$/i.test(row.name || '')),
          reshadeAddon: Boolean(scan.reshade?.installed && scan.reshade?.addonSupport)
        };
      },
      getReShadeSource: () => {
        try { return service.reShadeSource(); } catch { return null; }
      }
    });
    fgWorkflow = require('./src/product/fg-workflow').createFgWorkflow({ settings: launchSettings, components: fgComponents,
      assertClosed: id => installGuards.assertGameClosed(service.gameDirectory(id), service.gameExecutable(id)) });
    preparation = require('./src/product/game-preparation').createGamePreparation({ userData, service, settings: launchSettings, components: fgComponents, fgWorkflow,
      assertClosed: id => installGuards.assertGameClosed(service.gameDirectory(id), service.gameExecutable(id)) });
    launchCoordinator = createLaunchCoordinator({ service, settings: launchSettings, legacySrModel: srModel, guards: installGuards,
      components: fgComponents, explicitApply: true, launchGame: (id, controls) => launchSessions.start(id, controls) });
    environment = require('./src/product/game-environment').createGameEnvironment({ gameDirectory: id => service.gameDirectory(id),
      gameExecutable: id => service.gameExecutable(id), guards: installGuards });
    const processes = require('./src/product/game-processes').createGameProcesses();
    const nativeRuntimeVerification = require('./src/product/runtime-verification').createRuntimeVerification({ layout: id => service.getLayout(id), processes, modules: id => service.gameModuleManifest(id) });
    const legacyRuntimeVerification = require('./src/product/legacy-runtime-verification').createLegacyRuntimeVerification({ appDir: __dirname, resourcesPath: process.resourcesPath,
      processes, context: id => service.legacyRuntimeContext(id) });
    runtimeVerification = {
      prepare: (id, session) => service.legacyRuntimeContext(id) ? legacyRuntimeVerification.prepare(id, session) : nativeRuntimeVerification.prepare(id, session),
      assess: (id, session) => service.legacyRuntimeContext(id) ? legacyRuntimeVerification.assess(id, session) : nativeRuntimeVerification.assess(id, session),
      matched: (id, session) => service.legacyRuntimeContext(id) ? legacyRuntimeVerification.matched(id, session) : null
    };
    const broker = require('./src/product/game-launch-broker').createGameLaunchBroker({ resourcesPath: process.resourcesPath });
    launcherCompatibility = require('./src/product/launcher-compatibility').createLauncherCompatibility({ userData, broker,
      assertGameClosed: (gameDir, exe) => installGuards.assertGameClosed(gameDir, exe) });
    const isAdministrator = async () => (await elevation.context()).privilege === 'administrator';
    const hoyoLauncher = require('./src/product/hoyo-launcher').createHoYoLauncher({ broker, isAdministrator });
    const loadingHelper = require('./src/product/loading-helper').createLoadingHelper({ appDir: __dirname, resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      isAdministrator,
      getLayout: id => service.getLayout(id), inspectDeployment: id => service.inspectDeployment(id), additionalModules: async id => [
        ...await fgComponents.ownedModuleManifest(id), ...await service.feederModuleManifest(id)] });
    launchSessions = require('./src/product/launch-session').createLaunchSessions({ userData, processes, broker, helper: loadingHelper, hoyoTimeoutMs: 300000,
      game: async id => { const mode = await inspectLaunchMode(id), layout = service.getLayout(id);
        if (layout.loadingBackend === 'hoyoshade') return hoyoLauncher.resolve(layout);
        return { exe: mode.launchProfile?.realExecutable || mode.exe, launchMode: mode.effective, steamAppId: mode.steamAppId, steamRoot: mode.steamRoot,
        ...(mode.launchProfile ? { launchRequest:mode.launchProfile.launchRequest, launchProfile:mode.launchProfile } : {}),
        ...(layout.loadingMode === 'helper' ? { helper: { gameId: id } } : {}) }; },
      launchDirect: id => service.launch(id), launchHoYo: (id, _target, controls) => hoyoLauncher.launch(service.getLayout(id), controls),
      beforeLaunch: async (id, session) => {
        await service.prepareRuntimeLaunch(id, session);
        const result = await runtimeVerification.prepare(id, session);
        await require('./src/product/compatibility-launch').captureCompatibilitySnapshot(
          compatibilityFeedback, id, session, { log: startup.log });
        return result;
      },
      onGameMatched: async (id, session) => { await service.recordRuntimeLaunch(id, session); return runtimeVerification.matched(id, session); },
      emit: async session => {
        if (hoyoWorker && workerControls) await workerControls.publish({ session: { ...session, elevated: true }, checkedAt: new Date().toISOString() });
        if (win && !win.isDestroyed()) win.webContents.send('launch-session-updated', session);
      } });
    const hoyoElevation = require('./src/product/hoyo-launch-elevation');
    const ordinarySessions = launchSessions, localVerification = runtimeVerification;
    hoyoLaunchPlans = hoyoElevation.createHoYoLaunchPlans({ userData, service, helper: loadingHelper, launcher: hoyoLauncher, guards: installGuards,
      execute: hoyoWorker ? plan => hoyoElevation.runHoYoRuntime({ plan, sessions: ordinarySessions, verification: localVerification, processes, controls: workerControls }) : null });
    if (!worker) {
      launchSessions = hoyoElevation.createHoYoElevatedSessions({ userData, plans: hoyoLaunchPlans, normal: ordinarySessions,
        getLayout: id => service.getLayout(id), processInfo: process, appPath: __dirname, packaged: app.isPackaged, runPowerShell,
        log: startup.log, emit: session => { if (win && !win.isDestroyed()) win.webContents.send('launch-session-updated', session); } });
      runtimeVerification = { ...localVerification, assess: async (id, session) => await launchSessions.assess(id, session) || localVerification.assess(id, session) };
    }
    operationPlans = require('./src/product/operation-plan').createOperationPlans({ userData, service, settings: launchSettings,
      components: fgComponents, fgWorkflow, environment, preparation, guards: installGuards, applyEnhancement,
      restoreForUninstall: id => launchCoordinator.restoreForUninstall(id), setLaunchMode, inspectLaunchMode });
    verificationRecords = require('./src/product/game-verification-records').createGameVerificationRecords({ userData,
      gameExecutable: id => service.gameExecutable(id), layout: id => service.getLayout(id), coreIdentity: id => service.gameCoreIdentity(id), launchSession: id => launchSessions.inspect(id) });
    const componentAssessment = require('./src/product/component-assessment').createComponentAssessment({ layout: id => service.getLayout(id), allowExplicitExpectedPaths: true,
      knownPayloads: () => service.knownComponentCatalog(),
      getExpectedModules: async id => [...await service.gameModuleManifest(id), ...await fgComponents.ownedModuleManifest(id)] });
    gameAssessment = require('./src/product/game-assessment').createGameAssessment({ service, settings: launchSettings, coordinator: launchCoordinator,
      environment, operations: operationPlans, launches: launchSessions, verification: runtimeVerification, launchMode: inspectLaunchMode,
      hardware: () => currentHardware, helper: loadingHelper, records: verificationRecords, components: componentAssessment });
    if (!worker) compatibilityFeedback = require('./src/product/compatibility-feedback').createCompatibilityFeedback({
      assessment: gameAssessment, sessions: launchSessions,
      modules: async id => [...await service.gameModuleManifest(id), ...await fgComponents.ownedModuleManifest(id)],
      collectReport: collectSessionFeedback, managerVersion: app.getVersion(),
      writePackage: async ({ filename, bytes, validateBeforeWrite }) => {
        const selected = await dialog.showSaveDialog(win, { title: '保存兼容反馈包',
          defaultPath: path.join(app.getPath('downloads'), filename), filters: [{ name: '兼容反馈包', extensions: ['zip'] }] });
        if (selected.canceled || !selected.filePath) return { cancelled: true };
        await validateBeforeWrite();
        await require('./src/product/launch-safety').noLinks(selected.filePath);
        const handle = await fs.promises.open(selected.filePath, 'wx').catch(error => {
          if (error.code === 'EEXIST') throw Object.assign(new Error('保存位置已有同名文件，请选择新的文件名。'), { code: 'COMPATIBILITY_FILE_EXISTS' });
          throw error;
        });
        let created, writeError;
        try { created = await handle.stat(); await handle.writeFile(bytes); await handle.sync(); }
        catch (error) { writeError = error; }
        try { await handle.close(); } catch (error) { writeError ||= error; }
        if (writeError) {
          // Only remove the file created by this attempt. A replaced path is
          // external, even when the failed write used the same selected name.
          try {
            const current = await fs.promises.lstat(selected.filePath);
            if (created?.ino > 0 && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino)
              await fs.promises.unlink(selected.filePath);
          } catch {}
          throw writeError;
        }
        try { shell.showItemInFolder(selected.filePath); } catch {}
        return { saved: true };
      }
    });
    if (!worker) operationElevation = createOperationElevation({ userData, plans: operationPlans, processInfo: process, appPath: __dirname,
      packaged: app.isPackaged, runPowerShell, log: startup.log });
    if (!worker) hoyoWorkflow = require('./src/product/hoyo-workflow').createHoYoWorkflow({ userData, service,
      operations: operationPlans, launches: launchSessions, verification: runtimeVerification,
      launch: (id, controls) => launchCoordinator.serialize(() => launchCoordinator.launch(id, controls)),
      inspectLaunchReadiness: id => launchCoordinator.inspectLaunchReadiness(id),
      elevatedApply: (id, planId, consent) => operationElevation.apply(id, planId, consent),
      beforeMutation: id => installGuards.assertGameClosed(service.gameDirectory(id), service.gameExecutable(id)),
      requiresElevation: async plan => {
        if (await isAdministrator()) return false;
        const protectedRoots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.SystemRoot].filter(Boolean)
          .map(root => path.resolve(root).toLowerCase());
        for (const row of plan.changes || []) {
          const file = row.path || row.file;
          if (!path.isAbsolute(file || '')) continue;
          const key = path.resolve(file).toLowerCase();
          if (protectedRoots.some(root => key === root || key.startsWith(root + path.sep))) return true;
          let parent = path.dirname(file);
          while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
          try { await fs.promises.access(parent, fs.constants.W_OK); } catch { return true; }
        }
        return false;
      } });
}

async function startApplication() {
  startup.log('electron-entry', { version: app.getVersion(), packaged: app.isPackaged });
  const worker = workerArguments(process.argv);
  if (worker) {
    await app.whenReady();
    const result = await runOperationWorker({ userData: app.getPath('userData'), args: worker, processInfo: process, appPath: __dirname,
      runPowerShell, elevation, log: startup.log, initialize: async controls => {
        await initializeServices({ worker: true, hoyoWorker: worker.hoyoRuntime === true, workerControls: controls }); await service.boot();
        return { plans: worker.hoyoRuntime ? hoyoLaunchPlans : operationPlans };
      } });
    await launchSessions?.dispose(); service?.dispose?.(); app.exit(result.ok ? 0 : 1); return;
  }
  const reportIndex = process.argv.indexOf('--diagnostics-output');
  if (reportIndex >= 0) {
    const target = process.argv[reportIndex + 1];
    if (!target || !path.isAbsolute(target)) throw new Error('诊断输出需要指定完整文件路径。');
    await app.whenReady(); startup.exportTo(target); app.quit(); return;
  }
  if (process.argv.includes('--diagnostics')) { await app.whenReady(); await exportStartupReport(); app.quit(); return; }
  if (noSandbox && !sandboxRetryOnce) throw Object.assign(new Error('不能直接以无沙箱模式启动。请先普通双击；仅在程序确认 Electron 子进程启动失败后，错误框会提供一次临时兼容重试。'), { code:'UNAUTHORIZED_NO_SANDBOX' });
  if (app.commandLine.hasSwitch('as-admin')) startup.log('legacy-whole-app-elevation-ignored');
  singleInstanceOwned = app.requestSingleInstanceLock({ startupNonce: startup.sessionId });
  if (!singleInstanceOwned) {
    startup.log('existing-instance-detected');
    if (await startup.waitForAcknowledgement()) { startup.log('existing-instance-focused'); app.quit(); }
    else await startupFailure('已有管理器进程，但没有确认窗口已显示', new Error('已有进程可能尚未完成启动或没有响应。请先导出诊断，再从任务管理器核对；不会自动结束进程或删除单实例文件。'));
    return;
  }
  startup.log('single-instance-acquired');
  app.on('second-instance', async (_event, argv, _cwd, additional) => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    startup.acknowledge(additional?.startupNonce);
    startup.log('second-instance-focus', { windowAvailable: Boolean(win) });
    if (!service) return;
    for (const file of addonArgs(argv)) {
      try { await operationElevation?.assertAvailable(); await launchCoordinator.serialize(() => service.importAddonFile(file)); }
      catch (error) { startup.log('addon-import-deferred', { code: error.code, message: error.message });
        await dialog.showMessageBox({ type: 'warning', title: '组件尚未导入', message: '当前操作尚未结束，请等待结果或恢复后，再导入这个组件。', buttons: ['知道了'] }); }
    }
    if (win && !win.isDestroyed()) win.webContents.send('addon-imported');
  });

  app.setAppUserModelId('com.xiaofeng.dlss5.manager');
  await app.whenReady();
  startup.log('electron-ready');
  if (portableDataError) throw portableDataError;
  const prerequisite = require('./src/product/startup-prerequisite').createStartupPrerequisite({ dialog, shell,
    platform:process.platform, executable:process.execPath });
  const prerequisiteResult = await prerequisite.ensureReady();
  startup.log('startup-prerequisite', { status:prerequisiteResult.result?.status || 'unknown',
    repair:prerequisiteResult.result?.repair || '', action:prerequisiteResult.action || 'none' });
  if (!prerequisiteResult.proceed) { app.quit(); return; }
  await initializeServices();
    for (const file of addonArgs(process.argv)) {
      try { await operationElevation.assertAvailable(); await service.importAddonFile(file); }
      catch (error) { startup.log('startup-addon-import-deferred', { code: error.code, message: error.message }); }
    }
    registerIpc();
    createWindow();
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { startup.log('app-quitting'); void launchSessions?.dispose(); compatibilityFeedback?.dispose(); service?.dispose?.(); });
}
void startApplication().catch(error => startupFailure('管理器初始化失败', error));
