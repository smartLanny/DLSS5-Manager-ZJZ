'use strict';

// Real Electron/BrowserWindow/preload/renderer; replace only game-facing
// services. This entry is a test artifact and is never included in releases.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { app, BrowserWindow, dialog } = require('electron');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = arg('startup-smoke-root'), mainFile = arg('startup-smoke-main');
if (!root || !mainFile || !path.isAbsolute(root) || !path.isAbsolute(mainFile)) throw new Error('Startup smoke requires explicit isolated paths.');
const appRoot = path.dirname(mainFile), userData = path.join(root, 'user-data');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('crashDumps', path.join(root, 'crash-dumps'));
const reportFile = path.join(root, 'result.json'), stages = [], errors = [];
let finishing = false, completed = false;
const redact = value => String(value || '').replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n\t"<>|]*/gi, '<path>').slice(0, 1600);
function writeResult(value) {
  const temp = `${reportFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, reportFile);
}
async function finish(ok, message) {
  if (completed) return;
  completed = true;
  const window = BrowserWindow.getAllWindows()[0];
  let documentState = null;
  if (ok) {
    try { documentState = await window.webContents.executeJavaScript('(async()=>{const startupContext=await window.manager?.getStartupContext?.();await Promise.resolve();return {title:document.title,readyState:document.readyState,preloadConnected:typeof window.manager?.startupReady==="function",bodyVisible:Boolean(document.body&&document.body.getClientRects().length),startupContext:startupContext?.value,startupPrivilege:document.getElementById("startupPrivilege")?.textContent,startupMode:document.getElementById("startupMode")?.textContent};})()'); }
    catch (error) { ok = false; message = error.message; }
  }
  const preferences = window?.webContents.getLastWebPreferences();
  writeResult({ ok, message: message ? redact(message) : null, mode: app.commandLine.hasSwitch('no-sandbox') ? 'compatibility' : 'normal',
    electron: process.versions.electron, chromium: process.versions.chrome, visible: Boolean(window?.isVisible()),
    configuredSandbox: preferences?.sandbox, contextIsolation: preferences?.contextIsolation, nodeIntegration: preferences?.nodeIntegration,
    document: documentState, stages, errors, businessWrites: 0 });
  app.exit(ok ? 0 : 1);
}
const timeout = setTimeout(() => { void finish(false, 'Real Electron did not complete the three startup stages.'); }, 20000);
timeout.unref();
function stage(name, details = {}) {
  const safe = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]));
  stages.push({ stage: name, ...safe });
  if (name === 'startup-failure' || name === 'child-process-gone' && details.reason !== 'clean-exit') {
    errors.push({ stage: name, type: details.type, reason: details.reason, exitCode: details.exitCode });
    void finish(false, details.message || `${name}: ${details.reason || ''}`);
  }
  const names = new Set(stages.map(row => row.stage));
  if (!finishing && ['window-visible', 'page-loaded', 'renderer-ready'].every(value => names.has(value))) {
    finishing = true;
    setTimeout(() => { void finish(true); }, 400);
  }
}
dialog.showErrorBox = (title, detail) => { errors.push({ title, detail: redact(detail) }); void finish(false, `${title}: ${detail}`); };
dialog.showMessageBox = async options => { errors.push({ title: options.message || options.title }); void finish(false, options.message || options.title); return { response: options.cancelId ?? 1 }; };

const rejectWrite = () => { throw new Error('Startup smoke must not invoke a game or driver operation.'); };
const service = {
  store: { readRecoveryStatus: () => ({ state: 'missing' }) },
  withError: async work => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: { code: 'SMOKE_UNEXPECTED_ACTION', message: error.message } }; } },
  boot: async () => ({ product: { name: 'DLSS 5 AI 超分管理器', edition: '启动验证', author: '装机宅', version: 'startup-smoke' },
    settings: { scanDrives: false }, hardware: { family: 'Unknown', names: [], source: 'fixture' },
    payload: { ready: false, versions: {}, source: { mode: 'bundled', ready: false } }, addons: [], games: [], discoveryWarnings: [] }),
  dispose() {}, gameDirectory: rejectWrite, gameExecutable: rejectWrite, gameScan: rejectWrite, importAddonFile: rejectWrite
};
const replacements = new Map([
  ['src/product/app-service.js', { createAppService: () => service }],
  ['src/product/sr-model-service.js', { createSrModelService: () => ({}) }],
  ['src/product/launch-settings-service.js', { createLaunchSettingsService: () => ({}) }],
  ['src/product/launch-coordinator.js', { createLaunchCoordinator: () => ({ serialize: work => work(), assertMutationReady: rejectWrite }) }],
  ['src/core/install-guards.js', { assertGameClosed: rejectWrite }],
  ['src/product/fg-components.js', { createFgComponents: () => ({}) }],
  ['src/product/game-support.js', { classifyApi: () => 'unknown' }]
].map(([relative, value]) => [path.join(appRoot, relative), value]));
const diagnosticsPath = path.join(appRoot, 'src/product/startup-diagnostics.js');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (replacements.has(resolved)) return replacements.get(resolved);
  if (resolved === diagnosticsPath) {
    const real = originalLoad.apply(this, arguments);
    return { ...real, createStartupDiagnostics() {
      const instance = real.createStartupDiagnostics({ roots: [path.join(root, 'startup')] });
      return { ...instance, log(name, details = {}) { instance.log(name, details); stage(name, details); } };
    } };
  }
  return originalLoad.apply(this, arguments);
};
process.on('uncaughtException', error => { void finish(false, error.message); });
process.on('unhandledRejection', error => { void finish(false, error?.message || error); });
require(mainFile);
