'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const realDiagnostics = require('../src/product/startup-diagnostics');
const realLaunchPolicy = require('../src/product/launch-settings-policy');

const mainFile = path.resolve(__dirname, '../main.js');
const source = fs.readFileSync(mainFile, 'utf8');
const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(options = {}) {
  const logs = [], dialogs = [], errors = [], handles = new Map(), execCalls = []; let latestWindow = null;
  const startup = { sessionId: '11111111-1111-1111-1111-111111111111', directory: null,
    log(stage, details = {}) { logs.push({ stage, details }); }, report: () => 'report', exportTo: file => file,
    acknowledge: id => logs.push({ stage: 'ack', details: { id } }), waitForAcknowledgement: async () => options.acknowledged === true };
  class App extends EventEmitter {
    constructor() {
      super(); this.isPackaged = options.packaged !== false; this.quitCalls = 0; this.ready = false;
      this.commandLine = { hasSwitch: name => options.effectiveSwitches
        ? options.effectiveSwitches.includes(name)
        : (options.argv || []).some(arg => arg === `--${name}` || arg.startsWith(`--${name}=`)) };
    }
    disableHardwareAcceleration() { logs.push({ stage: 'disabled-hardware' }); }
    isReady() { return this.ready; }
    whenReady() { if (options.deferReady) return new Promise(() => {}); this.ready = true; return Promise.resolve(); }
    getVersion() { return 'test-version'; }
    getPath(name) { return path.join(__dirname, `.startup-${name}`); }
    requestSingleInstanceLock() { logs.push({ stage: 'instance-lock-requested' }); return options.singleInstance !== false; }
    releaseSingleInstanceLock() { logs.push({ stage: 'instance-lock-released' }); }
    setAppUserModelId() {}
    quit() { this.quitCalls++; }
    exit(code) { this.exitCode = code; }
    relaunch(details = {}) { logs.push({ stage: 'relaunch', details }); }
    async getFileIcon() { return { isEmpty: () => true }; }
  }
  const app = new App();
  class BrowserWindow extends EventEmitter {
    constructor(config) { super(); this.config = config; this.webContents = new EventEmitter(); this.webContents.send = () => {}; latestWindow = this; }
    isDestroyed() { return false; } isMinimized() { return false; } show() { this.shown = true; } focus() {} restore() {} minimize() {} close() { this.emit('closed'); }
    loadFile() { return options.loadFileError ? Promise.reject(new Error('fixture loadFile failure')) : Promise.resolve(); }
  }
  const ipcMain = new EventEmitter(); ipcMain.handle = (name, fn) => handles.set(name, (event, ...args) => fn(event && Object.hasOwn(event, 'sender') ? event : { ...event, sender: latestWindow?.webContents }, ...args));
  const dialog = { async showMessageBox(arg) { dialogs.push(arg); if (options.dialogFailure) throw new Error('dialog unavailable'); return { response: options.dialogResponse ?? 1 }; },
    async showSaveDialog() { return { canceled: true }; }, showErrorBox(title, detail) { errors.push({ title, detail }); }, async showOpenDialog() { return { canceled: true, filePaths: [] }; } };
  const screen = { getPrimaryDisplay: () => ({ workAreaSize: options.workAreaSize || { width: 1920, height: 1080 } }) };
  const electron = { app, BrowserWindow, ipcMain, dialog, screen, shell: { showItemInFolder() {}, async openExternal(url) { options.externalUrls?.push(url); }, async openPath() { return ''; } }, clipboard: { writeText() {} } };
  const service = { store: { readRecoveryStatus: () => ({ state: 'ok' }), read: () => ({ gameOverrides: {} }) }, withError: options.withError || (fn => fn()), install: options.install || (async () => ({})),
    boot: async () => ({}), refresh: async () => ({}), listGames: async () => [{ id: 'game', name: 'Fixture Game' }], product: {},
    getLayout: () => ({ mode: 'local', loadingMode: 'proxy', runtimeDir: 'C:\\game', activeConfigPath: 'C:\\game\\ReShade.ini' }),
    inspectDeployment: async () => ({ installed: false, needsRecovery: false }),
    gameDirectory: () => 'C:\\game', gameExecutable: () => 'C:\\game\\game.exe',
    gameScan: () => ({ primaryDlss: options.noNativeDlss ? null : { name: 'nvngx_dlss.dll' },
      streamlineFiles: options.noNativeFg ? [] : [{ name: 'sl.interposer.dll' }, { name: 'sl.dlss_g.dll' }], chosen: {}, reshade: {} }),
    reShadeSource: () => null, refreshAfterMutation: async value => value, importAddonFile: async () => {}, dispose() {}, ...options.appService };
  const launchSettings = { assertReady: async () => {}, pending: async () => [], restore: async () => {}, hasOwnedState: async () => false, inspect: async () => ({ requests: {}, applied: {} }),
    assessEligibility: async (_id, domain) => { const missing = domain === 'sr' ? options.noNativeDlss : options.noNativeFg; return { eligible: !missing, blockers: missing ? [{ code: domain === 'sr' ? 'ERR_NO_DLSS' : 'SETTINGS_NO_NATIVE_FG', message: 'fixture native integration missing' }] : [] }; }, ...options.launchService };
  const fgComponents = options.fgComponents || { inspect: async () => ({ route: 'native', ready: true }) };
  const feedbackCalls = options.compatibilityFeedbackCalls || [], defaultFeedback = {
    open: async id => { feedbackCalls.push({ name: 'open', args: [id] }); return { token: 'fixture-feedback-token', contextKey: id }; },
    preview: async (token, request) => { feedbackCalls.push({ name: 'preview', args: [token, request] }); return { previewId: 'fixture-feedback-preview', summary: 'fixture feedback preview' }; },
    save: async (token, request) => { feedbackCalls.push({ name: 'save', args: [token, request] }); return { saved: true }; },
    discard: async (token, previewId) => { feedbackCalls.push({ name: 'discard', args: [token, previewId] }); return true; },
    close: async token => { feedbackCalls.push({ name: 'close', args: [token] }); return true; },
    dispose: () => { feedbackCalls.push({ name: 'dispose', args: [] }); }
  };
  const compatibilityFeedback = { ...defaultFeedback,
    ...(typeof options.compatibilityFeedback === 'function' ? options.compatibilityFeedback() : options.compatibilityFeedback || {}) };
  const business = {
    './src/product/app-service': { createAppService: () => service }, './src/product/sr-model-service': { createSrModelService: input => { options.srFactory?.(input); return { read() {}, migrationInfo: async () => ({ baselineCaptured: false }), ...options.srService }; } },
    './src/product/launch-settings-service': { createLaunchSettingsService: input => { options.launchFactory?.(input); return launchSettings; } },
    './src/product/nvapi-drs': { createNvapiDrs: () => options.legacyDriver || {} },
    './src/product/nvapi-profile': { createNvapiProfileAdapter: () => options.profileDriver || {} },
    './src/product/work-scheduler': { createWorkScheduler: () => {
      const scheduler = require('../src/product/work-scheduler').createWorkScheduler();
      return { run: (key, work) => scheduler.run(key, () => options.serialize ? options.serialize(work) : work()) };
    } },
    './src/product/deferred-operations': { createDeferredOperations: input => {
      options.deferredFactory?.(input); return { start() {}, dispose() {}, assertNoWaiting: async () => {}, ...options.deferredService };
    } },
    './src/product/launch-coordinator': { createLaunchCoordinator: () => ({ serialize: options.serialize || (fn => fn()),
      assertMutationReady: options.assertMutationReady || (async () => {}), restoreForUninstall: options.restoreForUninstall || (async () => {}),
      inspect: options.coordinatorInspect || (async () => ({})), removeLibraryEntry: options.removeLibraryEntry || (async () => ({})), launch: options.launch || (async () => ({ launchSettings: [] })) }) },
    './src/core/install-guards': { assertGameClosed: options.assertGameClosed || (async () => {}) }, './src/product/fg-components': { createFgComponents: () => fgComponents },
    './src/product/game-preparation': { createGamePreparation: () => ({ assertReady: async () => {}, inspect: async () => ({ pending: false }), ...options.preparationService }) },
    './src/product/game-environment': { createGameEnvironment: () => ({ assertReady: async () => {}, inspect: async () => ({ pending: false }), ...options.environmentService }) },
    './src/product/game-support': { classifyApi: () => 'dx12' },
    './src/product/operation-api': require('../src/product/operation-api'),
    './src/product/operation-plan': { createOperationPlans: input => { options.operationFactory?.(input); return { assertReady: async () => {}, ...options.operationService }; } },
    './src/product/operation-elevation': { createOperationElevation: () => ({ assertAvailable: async () => {}, inspect: async () => ({ active: false, canRecover: false }), recover: async () => ({}), ...options.elevationService }) },
    './src/product/operation-worker': { workerArguments: require('../src/product/operation-worker').workerArguments,
      runOperationWorker: async opts => { logs.push({ stage: 'worker-entry', details: opts.args }); if (options.initializeWorker) await opts.initialize(); return options.workerResult || { ok: true }; } },
    './src/product/game-processes': { createGameProcesses: () => ({}) },
    './src/product/native-enhancement-probe': { createNativeEnhancementProbe: () => ({ inspect: async (_id, domain) => ({
      support: { status: (domain === 'sr' ? options.noNativeDlss : options.noNativeFg) ? 'unknown' : 'supported' } }) }) },
    './src/product/hoyo-launcher': { createHoYoLauncher: () => ({}) },
    './src/product/hoyo-workflow': { createHoYoWorkflow: input => { options.hoyoFactory?.(input); return { ...options.hoyoWorkflow }; } },
    './src/product/hoyo-launch-elevation': { createHoYoLaunchPlans: () => ({}),
      createHoYoElevatedSessions: ({ normal }) => ({ ...normal, assess: async () => null }) },
    './src/product/runtime-verification': { createRuntimeVerification: () => ({}), emptyVerification: require('../src/product/runtime-verification').emptyVerification },
    './src/product/legacy-runtime-verification': { createLegacyRuntimeVerification: () => ({}) },
    './src/product/game-launch-broker': { createGameLaunchBroker: () => ({}) },
    './src/product/launch-session': { createLaunchSessions: () => ({ dispose: async () => {} }) },
    './src/product/loading-helper': { createLoadingHelper: () => ({}) },
    './src/product/game-verification-records': { createGameVerificationRecords: () => ({
      inspect: async () => null,
      record: async () => { throw new Error('Unexpected visual observation write in startup fixture.'); },
      ...options.verificationRecords
    }) },
    './src/product/component-assessment': require('../src/product/component-assessment'),
    './src/product/game-assessment': { createGameAssessment: () => ({ assess: async () => options.assessment || {} }) },
    './src/product/feedback': require('../src/product/feedback'),
    './src/product/compatibility-feedback': { createCompatibilityFeedback: () => compatibilityFeedback }
  };
  const fakeProcess = new EventEmitter(); Object.assign(fakeProcess, { argv: options.argv || ['electron', mainFile], env: { SystemRoot: 'C:\\Windows', ...(options.env || {}) }, platform: 'win32',
    execPath: 'C:\\Program Files\\Manager\\manager.exe', resourcesPath: 'C:\\resources', pid: 1234,
    versions: { node: process.versions.node, electron: '33.0.0', chrome: '130.0.6723.191' } });
  let execCount = 0;
  const customRequire = request => {
    if (request === 'electron') return electron;
    if (request === './src/product/startup-diagnostics') return { ...realDiagnostics, createStartupDiagnostics: () => startup };
    if (request === './src/product/portable-data') return { configurePortableData: () => null };
    if (request === './src/product/startup-prerequisite') return { createStartupPrerequisite: () => ({
      ensureReady: async () => ({ proceed:true, prompted:false, result:{ status:'available' } }) }) };
    if (request === './src/product/manager-update') return { createManagerUpdate: () => ({ check:async()=>({available:false}),
      prepare:async()=>({}),cancel:()=>false,launchApply:async()=>({launched:true}) }) };
    if (request === './src/product/launcher-compatibility') return require('../src/product/launcher-compatibility');
    if (request === './src/product/startup-elevation') return require('../src/product/startup-elevation');
    if (request === './src/product/startup-handoff') return { createStartupHandoff: () => ({
      begin: () => ({ nonce: '22222222-2222-2222-2222-222222222222' }),
      wait: options.handoffWait || (async () => { logs.push({ stage: 'elevation-child-ready' }); }),
      cancel: () => logs.push({ stage: 'handoff-cancelled' }), finish: () => logs.push({ stage: 'handoff-finished' }),
      listen() {}, readyChild: () => true, failChild() {}
    }) };
    if (request === './src/product/launch-settings-policy') return realLaunchPolicy;
    if (request === './src/product/fg-workflow') return require('../src/product/fg-workflow');
    if (request === './src/product/game-enhancement-capabilities') return { inspectNativeEnhancementCapabilities: scan => ({
      nativeDlssAvailable: Boolean(scan.primaryDlss), nativeFgAvailable: scan.streamlineFiles.some(row => row.name === 'sl.dlss_g.dll') &&
        scan.streamlineFiles.some(row => row.name === 'sl.interposer.dll')
    }) };
    if (request === 'child_process') return { execFile(file, args, childOptions, callback) {
      execCalls.push({ file, args, options: childOptions }); execCount++; const row = options.execResults?.[execCount - 1] || { error: null, stdout: 'True' }; setImmediate(() => callback(row.error, row.stdout || '')); return { unref() {} };
    } };
    if (options.requireFailure === request) throw Object.assign(new Error('injected business module require failure'), { code: 'MODULE_NOT_FOUND' });
    if (business[request]) return business[request];
    return require(request);
  };
  const context = vm.createContext({ require: customRequire, module: { exports: {} }, exports: {}, __filename: mainFile, __dirname: path.dirname(mainFile), process: fakeProcess,
    console, Buffer, URL, setTimeout, clearTimeout, setImmediate });
  new vm.Script(source, { filename: mainFile }).runInContext(context);
  return { app, logs, dialogs, errors, handles, execCalls, process: fakeProcess, launchSettings, fgComponents, feedbackCalls, compatibilityFeedback,
    get window() { return latestWindow; } };
}

function saw(h, stage) { return h.logs.some(row => row.stage === stage); }
function dialogTitle(h, text) { return h.dialogs.some(row => String(row.message || row.title).includes(text)); }

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('ordinary and HoYo launch endpoints refuse pending applications before launching', async () => {
  let launches = 0, starts = 0;
  const h = harness({ deferredService: { assertNoWaiting: async () => { throw Object.assign(new Error('waiting'), { code: 'WAITING_OPERATION_PENDING' }); } },
    launch: async () => { launches++; }, hoyoWorkflow: { inspect: async () => ({ gameId: 'game' }), start: async () => { starts++; } } });
  await settle();
  try {
    await assert.rejects(h.handles.get('game-launch')({}, 'game'), { code: 'WAITING_OPERATION_PENDING' });
    await assert.rejects(h.handles.get('hoyo-start')({}, 'client'), { code: 'WAITING_OPERATION_PENDING' });
    assert.equal(launches, 0); assert.equal(starts, 0);
  } finally { h.window?.emit('closed'); }
});

test('operation confirmation delegates to the deferred owner without nesting its game lock', async () => {
  let input, applications = 0;
  const h = harness({ deferredFactory: value => { input = value; }, deferredService: { apply: async (id, planId, consent) =>
    input.run('C:\\game', async () => { applications++; return { id, planId, confirm: consent.confirm }; }) } });
  await settle();
  try {
    assert.deepEqual(await h.handles.get('game-operation-apply')({}, 'game', 'plan', { confirm: true }), { id: 'game', planId: 'plan', confirm: true });
    assert.equal(applications, 1);
  } finally { h.window?.emit('closed'); }
});

test('launch mode saves merge current game fields and preserve another simultaneous game save', async t => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'launch-mode-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = require('../src/product/state-store').createStore(path.join(root, 'settings.json'));
  const dir = id => path.join(root, id), exe = id => path.join(dir(id), 'Game.exe'); let operations;
  const h = harness({ operationFactory: input => { operations = input; }, appService: { store,
    gameDirectory: dir, gameExecutable: exe,
    assessmentSeed: id => ({ id, dir: dir(id), scan: { chosen: { path: exe(id), api: 'dx12', dx12: true, bitness: 64 } } }) } });
  await settle();
  try {
    await Promise.all([operations.setLaunchMode('first', 'exe'), operations.setLaunchMode('second', 'exe'),
      store.update(state => ({ gameOverrides: { ...state.gameOverrides, [dir('first').toLowerCase()]: {
        ...state.gameOverrides[dir('first').toLowerCase()], name: 'Kept name', api: 'dx12', apiExecutable: exe('first') } } }))]);
    const saved = store.read().gameOverrides;
    assert.equal(saved[dir('first').toLowerCase()].launchMode, 'exe');
    assert.equal(saved[dir('first').toLowerCase()].name, 'Kept name');
    assert.equal(saved[dir('first').toLowerCase()].api, 'dx12');
    assert.equal(saved[dir('second').toLowerCase()].launchMode, 'exe');
  } finally { h.window.emit('closed'); }
});

test('a launch blocks mutations for the same directory while another game remains usable', async () => {
  const entered = deferred(), release = deferred(), calls = [];
  const h = harness({ appService: { gameDirectory: id => id === 'other' ? 'C:\\other' : 'C:\\game',
    renameGame: async id => { calls.push(id); } }, launch: async () => {
    entered.resolve(); await release.promise; return { launchSettings: [] };
  } });
  await settle();
  const launching = h.handles.get('game-launch')({}, 'game'); await entered.promise;
  const same = h.handles.get('game-rename')({}, 'alias', 'Alias'), other = h.handles.get('game-rename')({}, 'other', 'Other');
  try { await other; assert.deepEqual(calls, ['other']); }
  finally { release.resolve(); await Promise.all([launching, same]); h.window.emit('closed'); }
  assert.deepEqual(calls, ['other', 'alias']);
});

test('HoYo launch joins the game directory queue while cancel remains immediate', async () => {
  const entered = deferred(), release = deferred(); let workflow, launches = 0, cancelled = 0;
  const h = harness({ hoyoFactory: input => { workflow = input; }, hoyoWorkflow: { cancel: async () => { cancelled++; } },
    launch: async () => { if (++launches === 1) { entered.resolve(); await release.promise; } return { launchSettings: [] }; } });
  await settle();
  const direct = h.handles.get('game-launch')({}, 'game'); await entered.promise;
  const queued = workflow.launch('game', { cancelled: () => false });
  try { await h.handles.get('hoyo-cancel')({}, 'client'); await settle(); assert.equal(launches, 1); assert.equal(cancelled, 1); }
  finally { release.resolve(); await Promise.all([direct, queued]); h.window.emit('closed'); }
  assert.equal(launches, 2);
});

test('legacy and current NVIDIA helpers share a short lock without blocking game metadata', async () => {
  const entered = deferred(), release = deferred(), calls = []; let legacy, current;
  const h = harness({ srFactory: input => { legacy = input.nvapi; }, launchFactory: input => { current = input.driver; },
    legacyDriver: { applySrPreset: async () => { calls.push('legacy'); entered.resolve(); await release.promise; } },
    profileDriver: { write: async () => { calls.push('current'); } },
    appService: { renameGame: async () => { calls.push('rename'); } } });
  await settle();
  const old = legacy.applySrPreset(); await entered.promise; const modern = current.write();
  try { await h.handles.get('game-rename')({}, 'game', 'Name'); assert.deepEqual(calls, ['legacy', 'rename']); }
  finally { release.resolve(); await Promise.all([old, modern]); h.window.emit('closed'); }
  assert.deepEqual(calls, ['legacy', 'rename', 'current']);
});

test('settings plans apply in their owning game queue and reject unregistered plans', async () => {
  const entered = deferred(), release = deferred(); let applied = false;
  const h = harness({ launchService: { preview: async () => ({ id: 'settings-plan' }), apply: async () => { applied = true; } },
    launch: async () => { entered.resolve(); await release.promise; return { launchSettings: [] }; } });
  await settle();
  await h.handles.get('launch-settings-preview')({}, 'game', 'sr', {});
  const launch = h.handles.get('game-launch')({}, 'game'); await entered.promise;
  const apply = h.handles.get('launch-settings-apply')({}, 'settings-plan', { confirm: true });
  try { await settle(); assert.equal(applied, false);
    await assert.rejects(h.handles.get('launch-settings-apply')({}, 'unknown', { confirm: true }), { code: 'PLAN_EXPIRED' });
  } finally { release.resolve(); await Promise.all([launch, apply]); h.window.emit('closed'); }
  assert.equal(applied, true);
});

test('high-DPI compact work areas keep the first window fully on screen and resizable', async () => {
  const h = harness({ workAreaSize: { width: 960, height: 520 } });
  await settle();
  const config = h.window.config;
  assert.ok(config.width <= 960 && config.height <= 520);
  assert.ok(config.minWidth <= config.width && config.minHeight <= config.height);
  assert.ok(config.width >= 600 && config.height >= 420);
  assert.equal(config.center, true);
  h.window.emit('closed');
});

test('cleanup IPC serializes managed restoration before read-only external preview', async () => {
  const order = [];
  const h = harness({ serialize: async work => { order.push('lock'); const result = await work(); order.push('unlock'); return result; },
    restoreForUninstall: async () => order.push('settings'),
    appService: { restoreManagedForCleanup: async () => { order.push('managed'); return { notice: 'original proxy retained' }; } },
    environmentService: { preview: async () => { order.push('preview'); return { planId: 'p', candidates: [] }; } } });
  await settle(); const result = await h.handles.get('game-environment-prepare-clean')({}, 'g');
  assert.deepEqual(order, ['lock', 'settings', 'managed', 'preview', 'unlock']);
  assert.equal(result.managedInstallationRestored, true); assert.equal(result.restorationNotice, 'original proxy retained');
  h.window.emit('closed');
});

test('failed managed restoration never proceeds to external cleanup preview', async () => {
  let previews = 0;
  const h = harness({ appService: { restoreManagedForCleanup: async () => { throw new Error('restore failed'); } },
    environmentService: { preview: async () => previews++ } });
  await settle(); await assert.rejects(h.handles.get('game-environment-prepare-clean')({}, 'g'), /restore failed/);
  assert.equal(previews, 0); h.window.emit('closed');
});

test('pending environment recovery blocks writes but its owner recovery remains reachable first', async () => {
  const order = []; const h = harness({
    environmentService: { assertReady: async () => { throw new Error('environment pending'); },
      recoverPending: async () => { order.push('recovery'); return { recovered: true }; }, restore: async () => { order.push('undo'); return { restored: true }; } },
    preparationService: { assertReady: async () => order.push('preparation') },
    restoreForUninstall: async () => order.push('settings'),
    appService: { restoreManagedForCleanup: async () => order.push('managed') } });
  await settle(); await assert.rejects(h.handles.get('game-install')({}, 'g'), /environment pending/);
  const result = await h.handles.get('game-environment-restore')({}, 'g');
  assert.deepEqual(order, ['recovery', 'preparation', 'settings', 'managed', 'undo']); assert.equal(result.interruptedFilesRecovered, true);
  h.window.emit('closed');
});

test('business-module require failure produces an early log and visible native dialog', async () => {
  const h = harness({ requireFailure: './src/product/app-service' }); await settle();
  assert.equal(saw(h, 'electron-entry'), true); assert.equal(saw(h, 'startup-failure'), true); assert.equal(dialogTitle(h, '管理器初始化失败'), true);
});

test('loadFile rejection is visible and does not add a no-sandbox retry', async () => {
  const h = harness({ loadFileError: true }); await settle(); assert.equal(saw(h, 'window-created'), true); assert.equal(dialogTitle(h, '界面文件加载失败'), true);
  assert.equal(h.process.argv.includes('--no-sandbox'), false); assert.equal(h.logs.some(row => JSON.stringify(row).includes('--no-sandbox')), false);
});

test('GPU launch failure, preload failure and renderer crash each reach the native error path', async () => {
  const gpu = harness(); await settle(); gpu.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 7 }); await settle();
  assert.equal(saw(gpu, 'child-process-gone'), true); assert.equal(dialogTitle(gpu, '图形子进程无法启动'), true);
  const preload = harness(); await settle(); preload.window.webContents.emit('preload-error', {}, 'preload.js', new Error('preload fixture')); await settle();
  assert.equal(dialogTitle(preload, '界面连接模块加载失败'), true);
  const renderer = harness(); await settle(); renderer.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 }); await settle();
  assert.equal(dialogTitle(renderer, '界面进程意外退出'), true);
  assert.equal(renderer.dialogs.at(-1).buttons.includes('使用软件渲染重启'), true);
});

test('startup options report effective switches and runtime versions without recording argv', async () => {
  const h = harness({ argv: ['electron', mainFile, '--no-sandbox', 'D:\\Private Games\\game.exe'],
    effectiveSwitches: ['disable-gpu', 'disable-gpu-sandbox', 'software-rendering'] });
  await settle();
  const options = h.logs.find(row => row.stage === 'startup-options').details;
  assert.equal(options.noSandbox, false, 'effective Chromium switches take precedence over raw argv');
  assert.equal(options.disableGpu, true); assert.equal(options.disableGpuSandbox, true); assert.equal(options.softwareRendering, true);
  assert.equal(options.chromium, '130.0.6723.191'); assert.equal(options.osRelease, require('node:os').release());
  assert.equal(saw(h, 'disabled-hardware'), true);
  assert.doesNotMatch(JSON.stringify(options), /Private Games|game\.exe|argv/);
  h.window.emit('closed');
});

test('default startup retains sandbox protections and does not request a compatibility relaunch', async () => {
  const h = harness(); await settle();
  const preferences = h.window.config.webPreferences;
  assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
  const options = h.logs.find(row => row.stage === 'startup-options').details;
  for (const name of ['noSandbox', 'disableGpu', 'disableGpuSandbox', 'softwareRendering']) assert.equal(options[name], false, name);
  assert.equal(saw(h, 'relaunch'), false); assert.equal(saw(h, 'disabled-hardware'), false);
  assert.equal(h.execCalls.length, 0, 'opening the normal window neither probes PowerShell nor elevates');
  h.window.emit('closed');
});

test('GPU and renderer launch failures preserve their cause and offer one detected, non-persistent compatibility retry', async () => {
  for (const type of ['GPU', 'Renderer']) {
    for (const reason of ['launch-failed', 'integrity-failure']) {
      const h = harness({dialogResponse:2}); await settle();
      if (type === 'GPU') h.app.emit('child-process-gone', {}, { type, reason, exitCode: 18 });
      else h.window.webContents.emit('render-process-gone', {}, { reason, exitCode: 18 });
      await settle();
      const failure = h.logs.find(row => row.stage === 'startup-failure').details;
      assert.equal(failure.type, type); assert.equal(failure.reason, reason); assert.equal(failure.exitCode, 18);
      const event = h.logs.find(row => row.stage === (type === 'GPU' ? 'child-process-gone' : 'render-process-gone')).details;
      assert.equal(event.type, type); assert.equal(event.reason, reason); assert.equal(event.exitCode, 18);
      assert.match(h.dialogs.at(-1).detail, /临时关闭沙箱/); assert.match(h.dialogs.at(-1).detail, /不会保存/);
      assert.equal(h.dialogs.at(-1).buttons.includes('临时兼容重试'), true);
      assert.equal(h.dialogs.at(-1).buttons.includes('使用软件渲染重启'), false);
      assert.equal(saw(h, 'relaunch'), false); assert.equal(h.process.argv.includes('--no-sandbox'), false);
      h.window.emit('closed');
    }
  }
});

test('confirmed child-process failure can relaunch exactly once with transient sandbox switches', async () => {
  const h = harness({dialogResponse:1}); await settle();
  h.app.emit('child-process-gone', {}, { type:'GPU', reason:'launch-failed', exitCode:18 }); await settle();
  const relaunch = h.logs.find(row => row.stage === 'relaunch');
  assert.ok(relaunch);assert.ok(relaunch.details.args.includes('--no-sandbox'));assert.ok(relaunch.details.args.includes('--sandbox-retry-once'));
  assert.equal(saw(h,'sandbox-retry-once-requested'),true);
});

test('manual no-sandbox startup is rejected unless it is the one-time detected retry', async () => {
  const h = harness({argv:['electron',mainFile,'--no-sandbox']}); await settle();
  assert.equal(h.window,null);assert.equal(h.errors.length,1);assert.match(h.errors[0].detail,/不能直接以无沙箱模式启动/);
  assert.equal(saw(h,'relaunch'),false);
});

test('single-instance without acknowledgement explains the hidden-window condition without killing anything', async () => {
  const h = harness({ singleInstance: false, acknowledged: false }); await settle();
  assert.equal(saw(h, 'existing-instance-detected'), true); assert.equal(h.errors.length, 1);
  assert.match(h.errors[0].detail, /已有管理器进程，但没有确认窗口已显示/); assert.match(h.errors[0].detail, /不会自动结束进程或删除单实例文件/);
});

test('legacy administrator startup flag never launches UAC or replaces the ordinary window',async()=>{
  const h=harness({argv:['electron',mainFile,'--as-admin']}); await settle();
  assert.equal(h.execCalls.length,0);assert.equal(saw(h,'legacy-whole-app-elevation-ignored'),true);assert.ok(h.window);assert.equal(h.app.quitCalls,0);h.window.emit('closed');
});
test('native dialog failure falls back to showErrorBox instead of a silent rejection', async () => {
  const h = harness({ requireFailure: './src/product/app-service', dialogFailure: true }); await settle();
  assert.equal(saw(h, 'error-dialog-failed'), true); assert.equal(h.errors.length, 1); assert.match(h.errors[0].detail, /启动诊断\.cmd/);
});

test('failure before app readiness synchronously shows an error box and exits', async () => {
  const h = harness({ deferReady: true }); h.app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 5 }); await settle();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].detail, /图形子进程无法启动/); assert.equal(h.app.exitCode, 1);
  assert.equal(saw(h, 'startup-failure'), true);
});

test('old elevation retry flags cannot trigger a new administrator process',async()=>{
  const h=harness({argv:['electron',mainFile,'--as-admin','--elevation-attempted']}); await settle();
  assert.equal(h.execCalls.length,0);assert.equal(saw(h,'instance-lock-released'),false);assert.ok(h.window);h.window.emit('closed');
});
test('a portable launcher environment does not cause a whole-application elevated restart',async()=>{
  const h=harness({argv:['manager.exe','--as-admin'],env:{PORTABLE_EXECUTABLE_FILE:'C:\portable.exe'}});await settle();
  assert.equal(h.execCalls.length,0);assert.equal(h.app.quitCalls,0);assert.ok(h.window);h.window.emit('closed');
});
test('startup context is read-only, identifies the authorized one-time compatibility retry and does not trust a packaged admin manifest', async () => {
  const h = harness({ argv: ['manager.exe', '--no-sandbox', '--sandbox-retry-once'], execResults: [{ error: null, stdout: 'False' }] }); await settle();
  const context = h.handles.get('startup-context');
  const foreign = await context({ sender: {} }); assert.equal(foreign.ok, false); assert.equal(h.execCalls.length, 0);
  const result = await context({ sender: h.window.webContents });
  assert.equal(result.ok, true); assert.equal(result.value.privilege, 'standard'); assert.equal(result.value.mode, 'compatibility');
  assert.equal(result.value.sandbox, false); assert.equal(result.value.canRestartElevated, false);
  assert.equal(h.execCalls.length, 1); assert.doesNotMatch(h.execCalls[0].args.at(-1), /Start-Process|RunAs/);
  assert.equal(saw(h, 'elevation-requested'), false); h.window.emit('closed');
});

test('retired administrator-restart IPC cannot request UAC or release the normal single-instance lock',async()=>{
  const h=harness();await settle();
  const result=await h.handles.get('startup-restart-elevated')({sender:h.window.webContents},{confirm:true});
  assert.equal(result.ok,false);assert.equal(result.error.code,'STARTUP_WHOLE_APP_ELEVATION_DISABLED');
  assert.equal(h.execCalls.length,0);assert.equal(h.app.quitCalls,0);assert.equal(saw(h,'instance-lock-released'),false);h.window.emit('closed');
});
test('explicit one-shot application delegates the bound preview and keeps the ordinary window alive',async()=>{
  const calls=[];const h=harness({elevationService:{apply:async(...args)=>{calls.push(args);return {applied:true,elevated:true};}}});await settle();
  const consent={confirm:true,fingerprint:'a'.repeat(64)};
  const result=await h.handles.get('game-operation-apply-elevated')({},'game','11111111-1111-4111-8111-111111111111',consent);
  assert.equal(result.applied,true);assert.equal(calls.length,1);assert.equal(calls[0][0],'game');assert.equal(calls[0][2],consent);
  assert.equal(h.app.quitCalls,0);assert.equal(saw(h,'instance-lock-released'),false);h.window.emit('closed');
});
test('permission recovery retains the game guard, original error and transaction state without an automatic retry', async () => {
  const { normalizeError } = require('../src/product/errors'); let guarded = 0, writes = 0;
  const h = harness({ withError: async work => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: normalizeError(error) }; } },
    assertMutationReady: async () => { guarded++; }, install: async () => { writes++; throw Object.assign(new Error('fixture denied'),
      { code: 'EACCES', details: { pending: true, phase: 'rollback', recoveryStateKnown: false } }); } });
  await settle();
  const result = await h.handles.get('game-install')({ sender: h.window.webContents }, 'game');
  assert.equal(guarded, 1); assert.equal(writes, 1); assert.equal(result.ok, false); assert.equal(result.error.code, 'EACCES');
  assert.equal(result.error.details.pending, true); assert.equal(result.error.details.recoveryStateKnown, false);
  assert.equal(result.error.details.recoveryAction, 'recover-repreview-elevated-operation'); assert.match(result.error.message, /重新预览/);
  assert.equal(h.execCalls.length, 0); assert.equal(h.app.quitCalls, 0);
  h.window.emit('closed');
});

test('game-closed rejection still prevents a write under ordinary startup', async () => {
  let writes = 0;
  const h = harness({ assertMutationReady: async () => { throw Object.assign(new Error('game is running'), { code: 'ERR_GAME_RUNNING' }); },
    install: async () => { writes++; } }); await settle();
  await assert.rejects(h.handles.get('game-install')({}, 'game'), { code: 'ERR_GAME_RUNNING' });
  assert.equal(writes, 0); assert.equal(h.execCalls.length, 0); h.window.emit('closed');
});

test('launch settings update validates with the real policy before inspecting or preparing FG components', async () => {
  const componentCalls = [], settingCalls = [];
  const h = harness({
    fgComponents: {
      inspect: async () => { componentCalls.push('inspect'); return { route: 'compatibility', ready: false }; },
      prepare: async () => { componentCalls.push('prepare'); return { prepared: true }; }
    },
    launchService: {
      assertReady: async () => settingCalls.push('ready'), preview: async () => settingCalls.push('preview'),
      apply: async () => settingCalls.push('apply'), save: async () => settingCalls.push('save'), restore: async () => {}
    }
  });
  await settle();
  const update = h.handles.get('launch-settings-update');
  assert.equal(typeof update, 'function');
  await assert.rejects(update({}, 'game', 'fg', { backend: 'mfgunlock', mode: 'bogus' }), error => error.code === 'SETTINGS_INPUT');
  assert.deepEqual(componentCalls, []);
  assert.deepEqual(settingCalls, []);
});

test('MFG Unlock update uses the real workflow to prepare missing components before preview, apply and save', async () => {
  const order = [];
  const request = { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 };
  const h = harness({
    fgComponents: {
      inspect: async () => { order.push('inspect'); return { route: 'compatibility', ready: false }; },
      prepare: async (id, options) => { order.push('prepare'); assert.equal(id, 'game'); assert.equal(options.allowAntiCheat, true); return { prepared: true }; }
    },
    launchService: {
      assertReady: async id => { assert.equal(id, 'game'); order.push('ready'); },
      preview: async (id, domain, actual) => { order.push('preview'); assert.deepEqual([id, domain, actual], ['game', 'fg', request]); return { id: 'plan-1' }; },
      apply: async (id, consent) => { order.push('apply'); assert.equal(id, 'plan-1'); assert.equal(consent.confirm, true); assert.equal(consent.automatic, true); return { applied: true, readbackVerified: true }; },
      save: async (id, domain, actual) => { order.push('save'); assert.deepEqual([id, domain, actual], ['game', 'fg', request]); return { saved: true }; },
      restore: async () => {}
    }
  });
  await settle();
  const result = await h.handles.get('launch-settings-update')({}, 'game', 'fg', request, { allowAntiCheat: true });
  assert.ok(order.indexOf('ready') < order.indexOf('prepare'));
  assert.deepEqual(order.filter(value => value !== 'ready'), ['inspect', 'prepare', 'preview', 'apply', 'save']);
  assert.equal(result.applied, true); assert.equal(result.saved, true); assert.equal(result.backend, 'mfgunlock');
});

test('MFG Unlock update rejects a route mismatch without preparing or writing settings', async () => {
  const calls = [];
  const h = harness({
    fgComponents: {
      inspect: async () => { calls.push('inspect'); return { route: 'native', ready: false }; },
      prepare: async () => calls.push('prepare')
    },
    launchService: {
      assertReady: async () => calls.push('ready'), preview: async () => calls.push('preview'),
      apply: async () => calls.push('apply'), save: async () => calls.push('save'), restore: async () => {}
    }
  });
  await settle();
  await assert.rejects(h.handles.get('launch-settings-update')({}, 'game', 'fg', { backend: 'mfgunlock', mode: 'fixed', multiplier: 3 }),
    error => error.code === 'SETTINGS_FG_ROUTE_MISMATCH');
  assert.ok(calls.includes('ready')); assert.deepEqual(calls.filter(value => value !== 'ready'), ['inspect']);
});

test('global launch settings reset attempts both domains and rejects partial restoration', async () => {
  const restored = [];
  const h = harness({ launchService: {
    assertReady: async () => {},
    restore: async (_id, domain) => {
      restored.push(domain);
      if (domain === 'sr') throw Object.assign(new Error('fixture SR restore failure'), { code: 'SR_RESTORE_FAILED' });
      return { restored: true };
    }
  } });
  await settle();
  await assert.rejects(h.handles.get('launch-settings-reset-all')({}, 'game'), error => {
    assert.equal(error.code, 'SETTINGS_RESTORE_INCOMPLETE');
    assert.equal(JSON.stringify(error.details.outcomes.map(row => [row.domain, row.ok])), JSON.stringify([['fg', true], ['sr', false]]));
    return true;
  });
  assert.deepEqual(restored, ['fg', 'sr']);
});

test('missing SR and FG providers reject overrides while restore uses the owner path', async () => {
  const calls=[];
  const h=harness({noNativeDlss:true,noNativeFg:true,fgComponents:{inspect:async()=>calls.push('components')},launchService:{
    assertReady:async()=>{},preview:async()=>{calls.push('preview');return{id:'restore'};},apply:async()=>{calls.push('apply');return{restored:true};},save:async()=>calls.push('save'), restore:async (_id,domain)=>{calls.push('restore-'+domain);return{restored:true};}
  }});
  await settle();
  await assert.rejects(h.handles.get('launch-settings-update')({},'game','sr',{backend:'native',quality:'balanced',preset:'auto'}),error=>error.code==='ERR_NO_DLSS');
  await assert.rejects(h.handles.get('launch-settings-update')({},'game','fg',{backend:'mfgunlock',mode:'fixed',multiplier:3}),error=>error.code==='SETTINGS_NO_NATIVE_FG');
  assert.deepEqual(calls,[]);
  const result=await h.handles.get('launch-settings-update')({},'game','fg',{backend:'nvidia',mode:'restore'});
  assert.equal(result.restored,true); assert.equal(result.saved,true); assert.deepEqual(calls,['restore-fg']);
});

test('native FG remains independent from a missing SR provider', async () => {
  const calls = [];
  const h = harness({ noNativeDlss: true, fgComponents: { inspect: async () => { calls.push('fg-inspect'); return { route: 'native', ready: true }; } },
    launchService: { preview: async (_id, domain) => { calls.push(`preview-${domain}`); return { id: 'fg-plan' }; },
      apply: async () => { calls.push('apply'); return { applied: true }; }, save: async () => calls.push('save') } }); await settle();
  await assert.rejects(h.handles.get('launch-settings-update')({}, 'game', 'sr', { backend: 'native', quality: 'quality', preset: 'auto' }), { code: 'ERR_NO_DLSS' });
  const result = await h.handles.get('launch-settings-update')({}, 'game', 'fg', { backend: 'nvidia', mode: 'fixed', multiplier: 2 });
  assert.equal(result.applied, true); assert.deepEqual(calls, ['fg-inspect', 'preview-fg', 'apply', 'save']); h.window.emit('closed');
});

test('specialized recovery remains reachable while a one-click preparation ledger is pending', async () => {
  const calls = [];
  const h = harness({ preparationService: { assertReady: async () => {throw Object.assign(new Error('pending preparation'),{code:'PREPARATION_PENDING'});} },
    assertMutationReady: async () => {throw Object.assign(new Error('pending files'),{code:'SETTINGS_RECOVERY_FIRST'});},
    serialize: async work => {calls.push('serialized'); return work();},
    launchService: {pending: async () => [{kind:'file-journal'}]},
    appService: {restoreFeeder: async () => {calls.push('feeder-owner'); return {restored:true};}, recoverReframework: async () => {calls.push('ref-owner');return {recovered:true};}} });
  await settle();
  assert.equal((await h.handles.get('game-feeder-restore')({},'g')).restored,true);
  assert.equal((await h.handles.get('game-reframework-recover')({},'g')).recovered,true);
  assert.deepEqual(calls,['serialized','feeder-owner','serialized','ref-owner']);
  await assert.rejects(h.handles.get('game-install')({},'g'),{code:'PREPARATION_PENDING'});
});

test('Feeder recovery preserves the driver-pending guard and propagates owner failures', async () => {
  let calls=0;
  const h=harness({launchService:{pending:async()=>[{kind:'driver-receipt'}]},appService:{restoreFeeder:async()=>{calls++;}}});
  await settle(); await assert.rejects(h.handles.get('game-feeder-restore')({},'g'),{code:'SETTINGS_RECOVERY_FIRST'}); assert.equal(calls,0);
  const conflict=harness({launchService:{pending:async()=>[{kind:'file-journal'}]},appService:{restoreFeeder:async()=>{throw Object.assign(new Error('external file changed'),{code:'FEEDER_FILE_CHANGED'});}}});
  await settle();await assert.rejects(conflict.handles.get('game-feeder-restore')({},'g'),{code:'FEEDER_FILE_CHANGED'});
});

test('FG file recovery remains serialized and reachable through pending preparation and file guards', async () => {
  const calls = []; let filesPending = true;
  const h = harness({
    preparationService: { assertReady: async () => { throw Object.assign(new Error('pending preparation'), { code: 'PREPARATION_PENDING' }); } },
    assertMutationReady: async () => { throw new Error('generic write guard must not run'); },
    serialize: async work => { calls.push('serialized'); return work(); },
    assertGameClosed: async () => { calls.push('closed'); },
    launchService: { assertReady: async () => { calls.push('settings-ready'); if (filesPending) throw new Error('pending files'); } },
    fgComponents: {
      recoverPending: async () => { calls.push('fg-owner'); filesPending = false; return { recovered: true }; },
      inspectMigration: async () => ({ migrationPending: false, fileRecoveryPending: false })
    }
  });
  await settle();
  assert.equal((await h.handles.get('fg-components-recover')({}, 'g')).restored, true);
  assert.deepEqual(calls, ['serialized', 'closed', 'fg-owner', 'settings-ready']);
  await assert.rejects(h.handles.get('game-install')({}, 'g'), { code: 'PREPARATION_PENDING' });
});


test('one-shot worker initializes trusted services without a BrowserWindow, renderer IPC or GUI instance lock',async()=>{
  const h=harness({initializeWorker:true,argv:['manager.exe','--operation-worker=22222222-2222-4222-8222-222222222222','--operation-request-hash='+ 'a'.repeat(64)]});await settle();
  assert.equal(saw(h,'worker-entry'),true);assert.equal(saw(h,'business-modules-loaded'),true);assert.equal(saw(h,'instance-lock-requested'),false);
  assert.equal(h.window,null);assert.equal(h.handles.size,0);assert.equal(h.app.exitCode,0);
});
test('invalid worker arguments exit with visible parent-reportable failure rather than opening an admin GUI',async()=>{
  const h=harness({argv:['manager.exe','--operation-worker=../../other']});await settle();
  assert.equal(h.window,null);assert.equal(h.app.exitCode,1);assert.equal(h.dialogs.length,0);assert.equal(saw(h,'operation-worker-startup-failed'),true);
});
test('ordinary mutations are rejected before entering the queue while a one-shot worker is active',async()=>{
  let writes=0,queued=0;const h=harness({elevationService:{busy:true},serialize:async fn=>{queued++;return fn();},install:async()=>writes++});await settle();
  await assert.rejects(h.handles.get('game-install')({},'game'),{code:'ERR_JOB_BUSY'});
  assert.equal(writes,0);assert.equal(queued,0);h.window.emit('closed');
});

test('feedback build preserves original text and appends the current four evidence levels with path preferences',async()=>{
  const assessment={schema:1,gameId:'game',assessedAt:'fixture-time',layout:{exe:'C:/Users/Alice/Games/Game.exe'},
    api:{observedApi:'dx12',evidence:['C:/Users/Alice/Games/native.log']},launch:{session:{nonce:'fresh-session',historical:false}},
    verification:{helper:{status:'passed',detail:'this helper session'},core:{status:'passed',detail:'specific Core'},nr:{status:'bypassed',detail:'unsupported format'},visual:{status:'unverified',detail:'comparison needed'}}};
  const h=harness({assessment,appService:{collectFeedback:async()=>({text:'ORIGINAL REPORT\n',suggestedName:'report.txt'})}});await settle();
  const report=await h.handles.get('feedback-build')({},'game',{includePaths:false});
  assert.ok(report.text.startsWith('ORIGINAL REPORT\n'));assert.match(report.text,/\[本次会话验收\]/);assert.match(report.text,/NR 处理：bypassed/);
  assert.equal(report.verification.visual.status,'unverified');assert.equal(report.launchSession.nonce,'fresh-session');assert.equal(report.report.assessmentIdentity.gameId,'game');
  assert.doesNotMatch(report.text,/Alice/);assert.match(report.text,/%USERNAME%/);
  const full=await h.handles.get('feedback-build')({},'game',{includePaths:true});assert.match(full.text,/Alice/);h.window.emit('closed');
});

test('external help routes accept fixed keys and verified game names rather than arbitrary URLs',async()=>{
  const urls=[],h=harness({externalUrls:urls});await settle();
  assert.equal(await h.handles.get('open-external')({},'https://untrusted.example'),false);
  assert.equal(await h.handles.get('open-external')({},'gameCompatibility:missing'),false);
  await h.handles.get('open-external')({},'antiCheatPolicy');await h.handles.get('open-external')({},'gameCompatibility:game');
  assert.deepEqual(urls,['https://help.steampowered.com/zh-cn/faqs/view/571A-97DA-70E9-FF74','https://www.google.com/search?q='+encodeURIComponent('Fixture Game ReShade 反作弊 兼容性')]);
  h.window.emit('closed');
});

test('visual observation IPC keeps the trusted sender gate and forwards the bound input and owner failures', async () => {
  const calls = [], input = { sessionId: 'current-fixture-session', sameScene: true, result: 'changed', note: 'same scene', evidenceLabel: 'F8 comparison' };
  const value = { recorded: true, record: { source: 'user-comparison', automaticVerification: false } };
  const h = harness({ verificationRecords: { record: async (id, request) => {
    calls.push({ id, request });
    if (request.sessionId !== input.sessionId) throw Object.assign(new Error('fixture session mismatch'), { code: 'ASSESSMENT_SESSION' });
    return value;
  } } });
  await settle();
  try {
    const record = h.handles.get('game-visual-record'); assert.equal(typeof record, 'function');
    await assert.rejects(record({ sender: new EventEmitter() }, 'game', input), { code: 'IPC_SENDER' }); assert.equal(calls.length, 0);
    assert.equal(await record({}, 'game', input), value); assert.equal(calls[0].id, 'game'); assert.equal(calls[0].request, input);
    assert.equal(value.record.automaticVerification, false);
    await assert.rejects(record({}, 'game', { ...input, sessionId: 'stale-fixture-session' }), { code: 'ASSESSMENT_SESSION' });
    assert.equal(calls.length, 2);
  } finally { h.window.emit('closed'); }
});

test('remaining-file cleanup preview only reads ownership and never invokes restoration', async () => {
  const calls = [], preview = { planId: 'read-only-preview', candidates: [] }, forbidden = async () => { calls.push('restore'); throw new Error('Preview must not restore.'); };
  let serialized = false;
  const h = harness({ serialize: async work => { assert.equal(serialized, false); serialized = true; try { return await work(); } finally { serialized = false; } },
    restoreForUninstall: forbidden,
    appService: { inspectDeployment: async id => { assert.equal(serialized, true); assert.equal(id, 'game'); calls.push('deployment'); return { installed: false }; }, restoreManagedForCleanup: forbidden },
    coordinatorInspect: async () => { calls.push('components'); return { fgComponents: { managed: false, receipt: false } }; },
    srService: { migrationInfo: async () => { calls.push('legacy'); return { baselineCaptured: false }; }, prepareMigration: forbidden },
    launchService: { hasOwnedState: async () => { calls.push('settings'); return false; }, restore: forbidden },
    environmentService: { restore: forbidden, preview: async id => { assert.equal(serialized, true); assert.equal(id, 'game'); calls.push('preview'); return preview; } } });
  await settle();
  try {
    assert.equal(await h.handles.get('game-environment-preview-clean')({}, 'game'), preview);
    assert.deepEqual(calls, ['deployment', 'components', 'legacy', 'settings', 'preview']);
  } finally { h.window.emit('closed'); }
});

test('cleanup preview blocks every managed owner and pending FG record without restoring or previewing files', async () => {
  const cases = [
    { deployment: { installed: true } }, { deployment: { needsRecovery: true } }, { ownedSettings: true }, { legacy: { baselineCaptured: true } },
    ...['installed', 'needsRecovery', 'needsCleanup', 'managed', 'receipt', 'fileRecoveryPending', 'fileOperationActive', 'migrationPending'].map(flag => ({ fgComponents: { [flag]: true } }))
  ];
  for (const state of cases) {
    let previews = 0, restores = 0;
    const forbidden = async () => { restores++; throw new Error('Pure preview cannot restore an owner.'); };
    const h = harness({ restoreForUninstall: forbidden,
      appService: { inspectDeployment: async () => state.deployment || {}, restoreManagedForCleanup: forbidden },
      coordinatorInspect: async () => ({ fgComponents: state.fgComponents || {} }),
      srService: { migrationInfo: async () => state.legacy || {}, prepareMigration: forbidden },
      launchService: { hasOwnedState: async () => state.ownedSettings === true, restore: forbidden },
      environmentService: { restore: forbidden, preview: async () => { previews++; return {}; } } });
    await settle();
    try {
      await assert.rejects(h.handles.get('game-environment-preview-clean')({}, 'game'), { code: 'ENVIRONMENT_RESTORE_FIRST' }, JSON.stringify(state));
      assert.equal(previews, 0); assert.equal(restores, 0);
    } finally { h.window.emit('closed'); }
  }
});

test('library removal serializes metadata work after all recovery guards without invoking restore', async () => {
  const checks = [], result = { dismissed: true, libraryOnly: true }; let serialized = false, restores = 0, removes = 0;
  const guard = name => async id => { assert.equal(serialized, true); assert.equal(id, 'game'); checks.push(name); };
  const h = harness({ serialize: async work => { serialized = true; try { return await work(); } finally { serialized = false; } },
    operationService: { assertReady: guard('operation') }, preparationService: { assertReady: guard('preparation') }, environmentService: { assertReady: guard('environment') },
    restoreForUninstall: async () => restores++, appService: { restoreManagedForCleanup: async () => restores++ },
    removeLibraryEntry: async id => { assert.equal(serialized, true); assert.equal(id, 'game');
      assert.ok(['operation', 'preparation', 'environment'].every(name => checks.includes(name))); removes++; return result; } });
  await settle();
  try { assert.equal(await h.handles.get('game-library-remove')({}, 'game'), result); assert.equal(removes, 1); assert.equal(restores, 0); }
  finally { h.window.emit('closed'); }
});

test('library removal cannot bypass any recovery guard, active worker, or the current-window sender', async () => {
  for (const name of ['operation', 'preparation', 'environment', 'worker', 'sender']) {
    let removes = 0;
    const blocker = async () => { throw Object.assign(new Error(name + ' pending'), { code: 'FIXTURE_RECOVERY_PENDING' }); };
    const h = harness({ removeLibraryEntry: async () => removes++, ...(name === 'operation' ? { operationService: { assertReady: blocker } } : {}),
      ...(name === 'preparation' ? { preparationService: { assertReady: blocker } } : {}), ...(name === 'environment' ? { environmentService: { assertReady: blocker } } : {}),
      ...(name === 'worker' ? { elevationService: { busy: true } } : {}) });
    await settle();
    try {
      await assert.rejects(h.handles.get('game-library-remove')(name === 'sender' ? { sender: new EventEmitter() } : {}, 'game'),
        { code: name === 'worker' ? 'ERR_JOB_BUSY' : name === 'sender' ? 'IPC_SENDER' : 'FIXTURE_RECOVERY_PENDING' });
      assert.equal(removes, 0);
    } finally { h.window.emit('closed'); }
  }
});

test('component assessment construction does not eagerly read a game or module owner', async () => {
  const reads = [], read = name => () => { reads.push(name); throw new Error('Eager component read: ' + name); };
  const h = harness({ appService: { getLayout: read('layout'), gameModuleManifest: read('modules') }, fgComponents: { ownedModuleManifest: read('fg-modules') } });
  await settle();
  try { assert.ok(h.window); assert.equal(saw(h, 'startup-failure'), false); assert.deepEqual(reads, []); }
  finally { h.window?.emit('closed'); }
});

test('HoYo IPC serializes workflow actions, rejects foreign senders and forwards only an explicit inspect retry', async () => {
  const calls = [], results = new Map(), failure = Object.assign(new Error('fixture HoYo preview failure'), { code: 'HOYO_FIXTURE' });
  let serialized = false;
  const methods = ['discover', 'bind', 'preview', 'apply', 'recover'];
  const workflow = Object.fromEntries(methods.map(name => {
    const result = { method: name }; results.set(name, result);
    return [name, async (...args) => {
      assert.equal(serialized, true, name + ' must run inside the coordinator queue');
      calls.push({ name, args });
      if (name === 'preview' && args[1] === 'fail') throw failure;
      return result;
    }];
  }));
  workflow.inspect = async (id, options) => {
    if (!options) return { gameId: id };
    assert.equal(serialized, false); assert.equal(Object.keys(options).join(','), 'retry');
    calls.push({ name: 'inspect', args: [id, options.retry] }); return options.retry;
  };
  const h = harness({ hoyoWorkflow: workflow, serialize: async work => {
    const previous = serialized; serialized = true;
    try { return await work(); } finally { serialized = previous; }
  } });
  await settle();
  try {
    assert.equal(saw(h, 'startup-failure'), false);
    const binding = { channel: 'official', launcher: 'fixture-launcher' }, consent = { fingerprint: 'bound-plan' };
    const args = { discover: [], bind: ['game', binding], preview: ['game', 'install', { version: '0.4.7beta' }], apply: ['game', 'plan', consent], recover: ['game'] };
    for (const name of methods) {
      const invoke = h.handles.get('hoyo-' + name); assert.equal(typeof invoke, 'function');
      const before = calls.length;
      await assert.rejects(invoke({ sender: new EventEmitter() }, ...args[name]), { code: 'IPC_SENDER' });
      assert.equal(calls.length, before, 'foreign sender must never reach ' + name);
      assert.equal(await invoke({}, ...args[name]), results.get(name));
      assert.deepEqual(calls.at(-1), { name, args: args[name] }); assert.equal(serialized, false);
    }
    await assert.rejects(h.handles.get('hoyo-preview')({}, 'game', 'fail'), error => error === failure);
    assert.equal(serialized, false, 'an owner failure must release the coordinator queue');
    const inspect = h.handles.get('hoyo-inspect'), before = calls.length;
    await assert.rejects(inspect({ sender: new EventEmitter() }, 'game', { retry: true }), { code: 'IPC_SENDER' });
    assert.equal(calls.length, before);
    for (const options of [undefined, { retry: true, ignored: 'value' }, { retry: false }, { retry: 'true' }]) {
      const expected = options?.retry === true;
      assert.equal(await inspect({}, 'game', options), expected);
      assert.deepEqual(calls.at(-1), { name: 'inspect', args: ['game', expected] });
    }
  } finally { h.window?.emit('closed'); }
});

test('compatibility feedback IPC registers the current-window gate and forwards context parameters', async () => {
  const calls = [], opened = { token: 'fixture-token', contextKey: 'fixture-context' }, previewed = { previewId: 'fixture-preview', summary: 'fixture preview' }, saved = { saved: true };
  const feedback = {
    open: async id => { calls.push({ name: 'open', args: [id] }); return opened; },
    preview: async (token, request) => { calls.push({ name: 'preview', args: [token, request] }); return previewed; },
    save: async (token, request) => { calls.push({ name: 'save', args: [token, request] }); return saved; },
    discard: async (token, previewId) => { calls.push({ name: 'discard', args: [token, previewId] }); return true; },
    close: async token => { calls.push({ name: 'close', args: [token] }); return true; },
    dispose() {}
  };
  const h = harness({ compatibilityFeedback: feedback }); await settle();
  const args = { open: ['game'], preview: ['fixture-token', { ratings: { playability: 'normal' }, includeLogs: false }],
    save: ['fixture-token', { previewId: 'fixture-preview', confirmed: true }], discard: ['fixture-token', 'fixture-preview'], close: ['fixture-token'] };
  try {
    for (const name of Object.keys(args)) {
      const invoke = h.handles.get('compatibility-' + name); assert.equal(typeof invoke, 'function');
      await assert.rejects(invoke({ sender: new EventEmitter() }, ...args[name]), { code: 'IPC_SENDER' });
    }
    assert.deepEqual(calls, [], 'foreign renderer never reaches the compatibility feedback owner');
    const context = await h.handles.get('compatibility-open')({}, 'game'); assert.equal(context, opened);
    const request = { ratings: { playability: 'normal', image: 'improved', fluidity: 'smooth' }, includeLogs: false };
    assert.equal(await h.handles.get('compatibility-preview')({}, context.token, request), previewed);
    const saveRequest = { previewId: previewed.previewId, confirmed: true };
    assert.equal(await h.handles.get('compatibility-save')({}, context.token, saveRequest), saved);
    await h.handles.get('compatibility-discard')({}, context.token, previewed.previewId);
    await h.handles.get('compatibility-close')({}, context.token);
    assert.deepEqual(calls, [
      { name: 'open', args: ['game'] }, { name: 'preview', args: [context.token, request] },
      { name: 'save', args: [context.token, saveRequest] }, { name: 'discard', args: [context.token, previewed.previewId] },
      { name: 'close', args: [context.token] }
    ]);
  } finally { h.window?.emit('closed'); }
});

test('preload separates library-only removal and pure cleanup preview from restoration IPC', async () => {
  const calls = []; let api;
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'manager'); api = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return args[0]; }, send() {}, on() {}, removeListener() {} }, webUtils: { getPathForFile() {} } };
  const file = path.resolve(__dirname, '../preload.js');
  new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }).runInNewContext({ require: name => { assert.equal(name, 'electron'); return electron; }, Object });
  assert.equal(await api.removeGame('game'), 'game-library-remove'); assert.equal(await api.previewEnvironmentCleanup('game'), 'game-environment-preview-clean');
  assert.deepEqual(calls, [['game-library-remove', 'game'], ['game-environment-preview-clean', 'game']]);
});
