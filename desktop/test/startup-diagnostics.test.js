'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createStartupDiagnostics, watchWindow, MAX_LOG } = require('../src/product/startup-diagnostics');

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaofeng-startup-log-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('each startup log is at most 64 KiB and retention keeps the latest four sessions', t => {
  const root = temp(t); let last;
  for (let i = 0; i < 7; i++) {
    last = createStartupDiagnostics({ roots: [root] });
    for (let row = 0; row < 200; row++) last.log('bounded-line', { row, message: 'x'.repeat(2800) });
    const file = path.join(root, `startup-${last.sessionId}.log`); assert.ok(fs.statSync(file).size <= MAX_LOG);
    const stamp = new Date(1000 + i * 2000); fs.utimesSync(file, stamp, stamp);
  }
  const files = fs.readdirSync(root).filter(name => /^startup-.*\.log$/.test(name)); assert.equal(files.length, 4);
  const report = last.report(); assert.ok(Buffer.byteLength(report) <= 128 * 1024); assert.match(report, /精简启动诊断/);
});

test('an unwritable first root falls back and memory reporting survives later append failure', t => {
  const root = temp(t), blocked = path.join(root, 'not-a-directory'); fs.writeFileSync(blocked, 'keep'); const fallback = path.join(root, 'fallback');
  const diagnostics = createStartupDiagnostics({ roots: [path.join(blocked, 'startup'), fallback] });
  assert.equal(diagnostics.directory, fallback); diagnostics.log('fallback-active', { ok: true });
  fs.unlinkSync(path.join(fallback, `startup-${diagnostics.sessionId}.log`)); fs.mkdirSync(path.join(fallback, `startup-${diagnostics.sessionId}.log`));
  diagnostics.log('append-failed', { reason: 'fixture' });
  assert.match(diagnostics.report(), /启动日志目录不可写/); assert.match(diagnostics.report(), /append-failed/);
});

test('startup report redacts case-variant home paths and unrelated absolute game paths', t => {
  const root = temp(t), diagnostics = createStartupDiagnostics({ roots: [root] });
  const home = os.homedir(), caseVariant = home.toUpperCase(), game = 'D:\\Games\\Private Title\\game.exe';
  diagnostics.log('path-error', { home: path.join(caseVariant, 'AppData', 'secret.txt'), game });
  const report = diagnostics.report();
  assert.doesNotMatch(report.toLowerCase(), new RegExp(home.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(report, /Private Title|D:\\Games/i);
});

test('startup logs retain typed process failure fields and redact only strings', t => {
  const root = temp(t), diagnostics = createStartupDiagnostics({ roots: [root] });
  diagnostics.log('render-process-gone', { type: 'Renderer', reason: 'launch-failed', exitCode: 18, sandbox: true,
    message: 'Failed at D:\\Private Games\\game.exe' });
  const rows = fs.readFileSync(path.join(root, `startup-${diagnostics.sessionId}.log`), 'utf8').trim().split('\n').map(JSON.parse);
  const failure = rows.find(row => row.stage === 'render-process-gone');
  assert.equal(failure.type, 'Renderer'); assert.equal(failure.reason, 'launch-failed'); assert.equal(failure.exitCode, 18);
  assert.equal(failure.sandbox, true); assert.doesNotMatch(failure.message, /Private Games|game\.exe/);
});

test('watchWindow distinguishes renderer launch failure from a later crash and clean exit', () => {
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); } isDestroyed() { return false; } show() {} }
  for (const reason of ['launch-failed', 'integrity-failure', 'crashed', 'clean-exit']) {
    const win = new Window(), failures = [], logs = [];
    watchWindow(win, { log: (stage, details) => logs.push({ stage, details }), fail: (...args) => failures.push(args) });
    win.webContents.emit('render-process-gone', {}, { reason, exitCode: 18 });
    assert.deepEqual(logs, [{ stage: 'render-process-gone', details: { type: 'Renderer', reason, exitCode: 18 } }]);
    if (reason === 'clean-exit') { assert.equal(failures.length, 0); continue; }
    assert.equal(failures[0][1].type, 'Renderer'); assert.equal(failures[0][1].reason, reason); assert.equal(failures[0][1].exitCode, 18);
    assert.equal(failures[0][2], reason === 'crashed', 'only ordinary crash retains the software-rendering retry');
    if (reason !== 'crashed') assert.match(failures[0][1].message, /兼容启动\.cmd/);
  }
});

test('handoff readiness is emitted only after the real window, page and renderer all report readiness', () => {
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); } isDestroyed() { return false; } show() {} }
  const win = new Window(); let ready = 0;
  const watch = watchWindow(win, { log() {}, fail() {}, onReady() { ready++; } });
  watch.ready(); assert.equal(ready, 0, 'renderer IPC alone is insufficient');
  win.webContents.emit('did-finish-load'); assert.equal(ready, 0, 'page load without a visible window is insufficient');
  win.emit('ready-to-show'); assert.equal(ready, 1);
  watch.ready(); assert.equal(ready, 1, 'only one terminal readiness callback');
  const failed = new Window(); let failedReady = 0;
  const failedWatch = watchWindow(failed, { log() {}, fail() {}, onReady() { failedReady++; } });
  failed.webContents.emit('preload-error', {}, 'preload.js', new Error('fixture preload failure'));
  failedWatch.ready(); failed.webContents.emit('did-finish-load'); failed.emit('ready-to-show');
  assert.equal(failedReady, 0, 'a failed child cannot become ready from late lifecycle events');
});

test('watchWindow reports preload, renderer, load and readiness timeout failures without changing sandbox flags', async () => {
  class Window extends EventEmitter { constructor() { super(); this.webContents = new EventEmitter(); } isDestroyed() { return false; } show() {} }
  for (const [kind, trigger, title] of [
    ['preload', win => win.webContents.emit('preload-error', {}, 'preload.js', new Error('preload boom')), '界面连接模块加载失败'],
    ['renderer', win => win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 }), '界面进程意外退出'],
    ['load', win => win.webContents.emit('did-fail-load', {}, -2, 'missing', '', true), '界面文件加载失败']
  ]) {
    const win = new Window(), failures = []; watchWindow(win, { log() {}, fail: (...args) => failures.push(args) }, 1000); trigger(win);
    assert.equal(failures[0][0], title, kind);
  }
  const win = new Window(), failures = []; watchWindow(win, { log() {}, fail: (...args) => failures.push(args) }, 5);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(failures[0][0], '界面初始化超时');
});
