'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const UUID = /^[a-f0-9-]{36}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function failure(code, message) { return Object.assign(new Error(message), { code }); }

// A request belongs to one original process and one fresh nonce. A ready reply
// must come from a different Electron session and contain every readiness stage.
function createStartupHandoff({ directory, sessionId, pid = process.pid, log = () => {}, timeoutMs = 30000, pollMs = 100 }) {
  let stopListening = null;
  function files(nonce) {
    if (!directory || !path.isAbsolute(directory) || !UUID.test(nonce || '')) throw failure('STARTUP_HANDOFF_UNAVAILABLE', '启动握手目录不可用，未关闭当前窗口。请导出启动诊断。');
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw failure('STARTUP_HANDOFF_UNAVAILABLE', '启动握手目录无效，未关闭当前窗口。');
    const base = path.join(directory, `elevation-${nonce}`);
    return { request: `${base}.request.json`, response: `${base}.response.json`, cancel: `${base}.cancel` };
  }
  function read(file) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { return null; }
  }
  function requestFor(nonce) {
    const names = files(nonce), request = read(names.request);
    if (!request || request.version !== 1 || request.nonce !== nonce || !UUID.test(request.parentSession || '') ||
      !Number.isInteger(request.parentPid) || request.parentPid <= 0 || !Number.isFinite(request.createdAt) || !Number.isFinite(request.deadlineAt)) return null;
    return { names, request };
  }
  function begin() {
    const nonce = crypto.randomUUID(), names = files(nonce), createdAt = Date.now();
    const request = { version: 1, nonce, parentSession: sessionId, parentPid: pid, createdAt, deadlineAt: createdAt + 60000 + timeoutMs };
    fs.writeFileSync(names.request, JSON.stringify(request), { flag: 'wx' });
    return { ...request, names };
  }
  function validReply(ticket, reply) {
    return reply?.version === 1 && reply.nonce === ticket.nonce && reply.parentSession === ticket.parentSession &&
      reply.requestCreatedAt === ticket.createdAt && UUID.test(reply.childSession || '') && reply.childSession !== ticket.parentSession &&
      Number.isInteger(reply.childPid) && reply.childPid > 0 && reply.childPid !== ticket.parentPid;
  }
  async function wait(ticket) {
    const deadlineAt = Date.now() + timeoutMs;
    do {
      const reply = read(ticket.names.response);
      if (validReply(ticket, reply)) {
        if (reply.status === 'failed') throw failure('STARTUP_CHILD_FAILED', `管理员新会话未完成启动：${String(reply.title || '请查看启动诊断').slice(0, 120)}`);
        if (reply.status === 'ready' && reply.administrator === true && reply.instanceLockOwned === true &&
          reply.windowVisible === true && reply.pageLoaded === true && reply.rendererReady === true) {
          log('elevation-child-ready', { childSession: reply.childSession, pid: reply.childPid });
          return reply;
        }
      }
      if (Date.now() >= deadlineAt) break;
      await sleep(pollMs);
    } while (true);
    throw failure('STARTUP_CHILD_NOT_READY', '管理员进程未在限定时间内完成窗口、页面和界面初始化，当前窗口将保留。');
  }
  function cancel(ticket) {
    try { fs.writeFileSync(ticket.names.cancel, 'cancel', { flag: 'wx' }); } catch {}
  }
  function finish(ticket) {
    for (const file of Object.values(ticket.names)) { try { fs.unlinkSync(file); } catch {} }
  }
  function childReply(nonce, details) {
    const pending = requestFor(nonce);
    if (!pending || pending.request.parentSession === sessionId || pending.request.parentPid === pid) return false;
    const { names, request } = pending;
    if (fs.existsSync(names.cancel) || Date.now() > request.deadlineAt) return false;
    const reply = { version: 1, nonce, parentSession: request.parentSession, requestCreatedAt: request.createdAt,
      childSession: sessionId, childPid: pid, ...details };
    // One terminal answer per fresh session; incomplete/stale replies never
    // become a successful handoff. The parent reads bounded JSON only.
    try { fs.writeFileSync(names.response, JSON.stringify(reply), { flag: 'wx' }); return true; }
    catch (error) { log('elevation-reply-not-written', { code: error.code || 'write-failed' }); return false; }
  }
  function readyChild(nonce, { administrator, instanceLockOwned }) {
    if (administrator !== true || instanceLockOwned !== true) { failChild(nonce, '管理员权限或实例锁尚未确认'); return false; }
    const sent = childReply(nonce, { status: 'ready', administrator: administrator === true, instanceLockOwned: instanceLockOwned === true,
      windowVisible: true, pageLoaded: true, rendererReady: true });
    if (sent) stopListening?.();
    return sent;
  }
  function failChild(nonce, title) {
    try { return childReply(nonce, { status: 'failed', title: String(title || '启动失败').slice(0, 120) }); } catch { return false; }
  }
  function listen(nonce, onCancel) {
    const pending = requestFor(nonce);
    if (!pending || pending.request.parentSession === sessionId || pending.request.parentPid === pid) throw failure('STARTUP_HANDOFF_INVALID', '管理员启动请求无效或已过期。');
    let active = true;
    const timer = setInterval(() => {
      if (!active) return;
      if (fs.existsSync(pending.names.cancel) || Date.now() > pending.request.deadlineAt) {
        stopListening(); log('elevation-child-cancelled'); onCancel();
      }
    }, pollMs);
    timer.unref?.();
    stopListening = () => { active = false; clearInterval(timer); };
    return stopListening;
  }
  return { begin, wait, cancel, finish, listen, readyChild, failChild };
}

module.exports = { createStartupHandoff };
