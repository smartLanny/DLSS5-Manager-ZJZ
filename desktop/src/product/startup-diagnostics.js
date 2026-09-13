'use strict';

// Deliberately built-ins only: this runs before any business module is loaded.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const MAX_LOG = 64 * 1024;
const LOG_NAME = /^startup-[a-f0-9-]{36}[.]log$/;
const PROCESS_LAUNCH_GUIDANCE = '请先导出启动诊断；可手动运行独立的“兼容启动.cmd”进行临时排障。默认启动保留沙箱，不会自动切换兼容模式。';

function createStartupDiagnostics(options = {}) {
  const sessionId = crypto.randomUUID();
  const roots = options.roots || [path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'xiaofeng-dlss5-manager', 'startup'),
    path.join(os.tmpdir(), 'xiaofeng-dlss5-manager', 'startup')];
  let directory = null, file = null, written = 0;
  const memory = [];
  const secrets = [os.homedir(), process.env.USERPROFILE, process.env.TEMP, process.env.TMP]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = value => {
    let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
    // Startup errors may quote a game or extracted DLL path. Logs do not need
    // either to distinguish the failing stage, and Windows ignores path case.
    text = text.replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n\t"<>|]*/gi, '<路径>');
    for (const secret of secrets) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'gi'), '<用户目录>');
    }
    return text.slice(0, 3000);
  };
  for (const root of roots) {
    try {
      fs.mkdirSync(root, { recursive: true });
      if (fs.lstatSync(root).isSymbolicLink()) continue;
      const candidate = path.join(root, `startup-${sessionId}.log`);
      fs.writeFileSync(candidate, '', { flag: 'wx' }); directory = root; file = candidate; break;
    } catch {}
  }
  function log(stage, details = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(details).slice(0, 20)) {
      if (typeof value === 'string') safe[key] = redact(value);
      else if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
    }
    const line = `${JSON.stringify({ at: new Date().toISOString(), stage, ...safe })}\n`;
    if (memory.length < 120) memory.push(line);
    if (file && written + Buffer.byteLength(line) <= MAX_LOG) {
      try { fs.appendFileSync(file, line); written += Buffer.byteLength(line); } catch { file = null; }
    }
  }
  log('process-start', { pid: process.pid, platform: process.platform, arch: process.arch,
    node: process.versions.node, electron: process.versions.electron || 'not-electron',
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE), temporaryExtraction: Boolean(process.env.PORTABLE_EXECUTABLE_DIR) });
  if (directory) {
    try {
      const old = fs.readdirSync(directory).filter(name => LOG_NAME.test(name)).map(name => ({ name, stat: fs.lstatSync(path.join(directory, name)) }))
        .filter(row => row.stat.isFile() && !row.stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      for (const row of old.slice(4)) if (row.name !== path.basename(file || '')) fs.unlinkSync(path.join(directory, row.name));
    } catch {}
  }
  function report() {
    const parts = ['DLSS 5 AI 超分管理器 · 精简启动诊断', `生成时间：${new Date().toISOString()}`,
      '仅包含启动阶段和错误摘要；不据此统一归因于 VC++，不包含游戏配置或完整系统日志。'];
    if (directory) {
      try {
        const files = fs.readdirSync(directory).filter(name => LOG_NAME.test(name)).map(name => ({ name, stat: fs.lstatSync(path.join(directory, name)) }))
          .filter(row => row.stat.isFile() && !row.stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(0, 4);
        for (const row of files) {
          const fd = fs.openSync(path.join(directory, row.name), 'r');
          try {
            const buffer = Buffer.alloc(Math.min(row.stat.size, 24 * 1024)), start = Math.max(0, row.stat.size - buffer.length);
            fs.readSync(fd, buffer, 0, buffer.length, start);
            let tail = buffer.toString('utf8');
            if (start) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
            parts.push(`\n${row.name}\n${redactReport(tail)}`);
          }
          finally { fs.closeSync(fd); }
        }
      } catch { parts.push('部分磁盘日志无法读取。'); }
    }
    if (!file) parts.push('启动日志目录不可写，以下为当前进程内存记录。', ...memory);
    return Buffer.from(parts.join('\n'), 'utf8').subarray(0, 120 * 1024).toString('utf8');
  }
  function redactReport(text) { return String(text).split('\n').map(line => redact(line)).join('\n'); }
  function exportTo(destination) { fs.writeFileSync(destination, report(), 'utf8'); return destination; }
  function acknowledge(id) {
    if (!directory || !/^[a-f0-9-]{36}$/.test(id || '')) return;
    try { fs.writeFileSync(path.join(directory, `ack-${id}`), 'focused', { flag: 'wx' }); } catch {}
  }
  async function waitForAcknowledgement(timeout = 2200) {
    if (!directory) return false;
    const ack = path.join(directory, `ack-${sessionId}`), start = Date.now();
    while (Date.now() - start < timeout) {
      if (fs.existsSync(ack)) { try { fs.unlinkSync(ack); } catch {} return true; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  return { sessionId, directory, log, report, exportTo, acknowledge, waitForAcknowledgement };
}

function watchWindow(window, { log, fail, onReady }, timeoutMs = 25000) {
  let visible = false, completed = false, pageLoaded = false, rendererReady = false, readyNotified = false, startupFailed = false;
  const notifyReady = () => {
    if (!startupFailed && !readyNotified && visible && pageLoaded && rendererReady) { readyNotified = true; onReady?.(); }
  };
  const timer = setTimeout(() => {
    if (!completed && visible && pageLoaded) log('renderer-data-still-loading');
    else if (!completed) { startupFailed = true; fail('界面初始化超时', new Error('窗口尚未完成初始化。可以导出启动诊断；不必先删除旧配置。')); }
  }, timeoutMs);
  timer.unref?.();
  const clear = () => { completed = true; clearTimeout(timer); };
  window.once('ready-to-show', () => { if (!window.isDestroyed()) { visible = true; window.show(); log('window-visible'); notifyReady(); } });
  window.webContents.once('did-finish-load', () => { pageLoaded = true; log('page-loaded'); notifyReady(); });
  window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame !== false && code !== -3) { startupFailed = true; clear(); fail('界面文件加载失败', Object.assign(new Error(description), { code })); }
  });
  window.webContents.on('preload-error', (_event, _file, error) => { startupFailed = true; clear(); fail('界面连接模块加载失败', error); });
  window.webContents.on('render-process-gone', (_event, details) => {
    startupFailed = true; clear();
    log('render-process-gone', { type: 'Renderer', reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'clean-exit') return;
    const launchFailure = ['launch-failed', 'integrity-failure'].includes(details.reason);
    const message = `${details.reason}; exitCode=${details.exitCode}${launchFailure ? `。${PROCESS_LAUNCH_GUIDANCE}` : ''}`;
    fail(launchFailure ? '界面子进程无法启动' : '界面进程意外退出',
      Object.assign(new Error(message), { type: 'Renderer', reason: details.reason, exitCode: details.exitCode }), !launchFailure);
  });
  window.on('unresponsive', () => { startupFailed = true; log('window-unresponsive', { visible }); fail('界面暂时无响应', new Error('界面没有响应，请先导出诊断。'), true); });
  window.once('closed', () => { startupFailed = true; clear(); });
  return { ready() { clear(); rendererReady = true; log('renderer-ready'); notifyReady(); }, failed(error) { startupFailed = true; clear(); fail('界面初始化失败', error); } };
}

module.exports = { createStartupDiagnostics, watchWindow, MAX_LOG, PROCESS_LAUNCH_GUIDANCE };
