'use strict';

// The branded executable always loads its packaged main. Electron's documented
// --inspect-brk switch lets the test install isolation before its first line.
// https://www.electronjs.org/docs/latest/tutorial/debugging-main-process
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { verifyExecutable } = require('./verify-execution-level');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function inspectorConnection(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs; let target;
  while (!target && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) });
      const rows = await response.json(); target = rows.find(row => row.type === 'node' && row.webSocketDebuggerUrl);
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Packaged EXE did not expose its paused local inspector.');
  const url = new URL(target.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) throw new Error('Unexpected inspector endpoint.');
  const socket = new WebSocket(url), pending = new Map(); let nextId = 0, paused;
  const pausedWaiters = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result); }
    } else if (message.method === 'Debugger.paused') {
      paused = message.params; for (const resolve of pausedWaiters.splice(0)) resolve(paused);
    }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  return { request, close: () => socket.close(), async paused() {
    if (paused) return paused;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Packaged main did not pause before execution.')), 10000);
      pausedWaiters.push(value => { clearTimeout(timeout); resolve(value); });
    });
  } };
}

async function startPackagedWithIsolation({ executable, mainFile, entry, directory, compatibility, broker }) {
  if (!verifyExecutable(executable, 'asInvoker').ok) throw new Error('Packaged startup requires an asInvoker EXE.');
  const port = await unusedLoopbackPort();
  const isolatedUserData = path.join(directory, 'user-data'); fs.mkdirSync(isolatedUserData, { recursive: true });
  const args = [`--inspect-brk=127.0.0.1:${port}`, `--user-data-dir=${isolatedUserData}`, `--startup-smoke-root=${directory}`, `--startup-smoke-main=${mainFile}`];
  if (compatibility) args.push('--no-sandbox', '--sandbox-retry-once');
  const started = await broker.launch({ exe: executable, args, cwd: path.dirname(executable) });
  let inspector;
  try {
    inspector = await inspectorConnection(port);
    await inspector.request('Runtime.enable'); await inspector.request('Debugger.enable');
    await inspector.request('Runtime.runIfWaitingForDebugger');
    const stopped = await inspector.paused(), frame = stopped.callFrames?.[0]?.callFrameId;
    if (!frame) throw new Error('Packaged main pause has no JavaScript frame.');
    const before = await inspector.request('Debugger.evaluateOnCallFrame', { callFrameId: frame,
      expression: '({filename:typeof __filename==="string"?__filename:null,canRequire:typeof require==="function",pid:process.pid,userData:require("electron").app.getPath("userData")})', returnByValue: true });
    const identity = before.result?.value;
    if (before.exceptionDetails || identity?.pid !== started.pid || !identity.canRequire || path.resolve(identity.filename || '').toLowerCase() !== path.resolve(mainFile).toLowerCase())
      throw new Error('Inspector did not stop in this packaged EXE main; isolation was not applied.');
    if (identity.userData !== isolatedUserData) throw new Error('The official user-data-dir flag did not isolate app.getPath(userData) before instrumentation.');
    const injected = await inspector.request('Debugger.evaluateOnCallFrame', { callFrameId: frame,
      expression: `require(${JSON.stringify(entry)});({userData:require('electron').app.getPath('userData'),isolated:true})`, returnByValue: true });
    if (injected.exceptionDetails || injected.result?.value?.userData !== path.join(directory, 'user-data'))
      throw new Error(`Packaged startup isolation failed: ${injected.exceptionDetails?.text || 'unexpected userData'}`);
    await inspector.request('Debugger.resume');
    return { ...started, packagedExecutable: true, userDataFlagHonoredBeforeInstrumentation: true,
      instrumentation: 'Local inspector paused packaged main before first line; isolated userData and inert game services installed.' };
  } catch (error) {
    try { process.kill(started.pid); } catch {}
    throw error;
  } finally { inspector?.close(); }
}
module.exports = { startPackagedWithIsolation, unusedLoopbackPort, inspectorConnection };
