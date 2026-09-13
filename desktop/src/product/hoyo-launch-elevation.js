'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, digestFile, atomicJson, assertLaunchNotCancelled } = require('./launch-safety');
const { createOperationElevation, locations, hash } = require('./operation-elevation');
const { executionLevel } = require('./game-launch-broker');
const { validHoYoProfile } = require('./hoyoshade-profiles');
const { emptyVerification } = require('./runtime-verification');
const { same } = require('./game-processes');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code, message) => { throw Object.assign(Error(message), { code: 'HOYO_ELEVATION_' + code }); };
const namespace = userData => path.join(userData, 'hoyo-runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function needsHoYoElevation(layout) {
  return layout?.loadingBackend === 'hoyoshade' && validHoYoProfile(layout.hoyoProfile, layout.exe) &&
    ['requireAdministrator', 'highestAvailable'].includes(executionLevel(layout.exe));
}

// This is a launch-only request owner. It cannot execute a deployment plan or
// arbitrary shell arguments, and the UAC worker recompiles its complete binding.
function createHoYoLaunchPlans({ userData, service, helper, launcher, execute, guards, now = Date.now }) {
  const directory = path.join(namespace(userData), 'launch-plans');
  async function snapshot(id) {
    const layout = service.getLayout(id);
    if (!needsHoYoElevation(layout) || layout.verified !== true || layout.needsRecovery) fail('ROUTE', '此请求只用于已绑定、要求管理员权限的米哈游客户端。');
    await guards.assertGameClosed(service.gameDirectory(id), layout.exe);
    const deployment = await service.inspectDeployment(id), allowed = await helper.inspect(id), target = await launcher.resolve(layout);
    if (deployment.ready !== true || !allowed.ready) fail('NOT_READY', '米哈游配套或插件允许清单尚未通过检查，请先应用或修复。');
    const modules = [];
    for (const row of allowed.modules) {
      await noLinks(row.path);
      const sha256 = await digestFile(row.path);
      if (!HASH.test(sha256 || '') || sha256 !== row.expectedSha256) fail('MODULE', '米哈游组件在启动预览时改变。');
      modules.push({ path: row.path, sha256, role: row.role });
    }
    return { exe: layout.exe, exeSha256: await digestFile(layout.exe), bindingId: layout.bindingId,
      launcher: target.launcher, configPath: layout.activeConfigPath, configHash: allowed.configHash,
      runtimeDir: layout.runtimeDir, generation: layout.generation, modules };
  }
  async function preview(id) {
    const binding = await snapshot(id), plan = { version: 1, kind: 'hoyoshade-elevated-launch', planId: crypto.randomUUID(),
      gameId: id, exe: binding.exe, before: { exeSha256: binding.exeSha256 }, binding, blockers: [], createdAt: now(), expiresAt: now() + 120000 };
    plan.fingerprint = hash({ kind: plan.kind, gameId: id, binding, createdAt: plan.createdAt, expiresAt: plan.expiresAt });
    await atomicJson(path.join(directory, plan.planId + '.json'), plan); return plan;
  }
  async function loadPlan(planId, fingerprint) {
    if (!UUID.test(planId || '') || !HASH.test(fingerprint || '')) fail('REQUEST', '米哈游启动请求身份无效。');
    const file = path.join(directory, planId + '.json'); await noLinks(file);
    const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 256 * 1024 || stat.nlink !== 1) fail('REQUEST', '启动请求不是有效的有界普通文件。');
    const plan = JSON.parse(await fs.readFile(file, 'utf8'));
    if (plan.version !== 1 || plan.kind !== 'hoyoshade-elevated-launch' || plan.planId !== planId ||
        !Number.isFinite(plan.createdAt) || !Number.isFinite(plan.expiresAt) || plan.createdAt > now() + 5000 || plan.expiresAt <= now() ||
        plan.expiresAt <= plan.createdAt || plan.expiresAt - plan.createdAt > 120000 ||
        plan.fingerprint !== fingerprint || hash({ kind: plan.kind, gameId: plan.gameId, binding: plan.binding, createdAt: plan.createdAt, expiresAt: plan.expiresAt }) !== fingerprint) fail('CHANGED', '启动请求已过期或改变。');
    const current = await snapshot(plan.gameId);
    if (hash({ kind: plan.kind, gameId: plan.gameId, binding: current, createdAt: plan.createdAt, expiresAt: plan.expiresAt }) !== fingerprint || !same(plan.exe, current.exe) || plan.before.exeSha256 !== current.exeSha256)
      fail('CHANGED', '启动器、游戏或配套在预览后改变，请重新启动。');
    return plan;
  }
  async function apply(planId, consent) {
    if (!execute || consent?.confirm !== true) fail('WORKER_REQUIRED', '米哈游管理员加载只能由本次已核验的后台工作进程执行。');
    const plan = await loadPlan(planId, consent.fingerprint);
    return execute(plan);
  }
  return { preview, loadPlan, apply };
}

async function runHoYoRuntime({ plan, sessions, verification, processes, controls, now = Date.now, delay = sleep }) {
  let cancelling = false, closed = false, timerBusy = false;
  const timer = setInterval(async () => {
    if (timerBusy || closed) return; timerBusy = true;
    try {
      if (await controls.cancelled() || !await controls.parentAlive()) { cancelling = true; sessions.cancel(plan.gameId); }
    } catch { cancelling = true; sessions.cancel(plan.gameId); }
    finally { timerBusy = false; }
  }, 1000);
  try {
    if (await controls.cancelled() || !await controls.parentAlive()) {
      cancelling = true;
      return { applied: true, gamePreserved: true, monitoringEnded: true, cancelled: true, runtimeVerified: false };
    }
    let session = await sessions.start(plan.gameId, { cancelled: () => cancelling });
    const deadline = now() + 12 * 60 * 60000;
    while (!cancelling && now() < deadline) {
      session = await sessions.inspect(plan.gameId);
      if (!session?.process) break;
      const live = await processes.find(session.targetExe);
      if (!live.some(row => row.pid === session.process.pid && row.startedAt === session.process.startedAt)) {
        await controls.publish({ session: { ...session, status: 'game-exited', elevated: true }, verification: emptyVerification(null, session), checkedAt: new Date(now()).toISOString() });
        break;
      }
      const result = await verification.assess(plan.gameId, session);
      if (cancelling || await controls.cancelled() || !await controls.parentAlive()) { cancelling = true; break; }
      await controls.publish({ session: { ...session, elevated: true }, verification: result, checkedAt: new Date(now()).toISOString() });
      await delay(2500);
    }
    return { applied: true, gamePreserved: true, monitoringEnded: true, cancelled: cancelling, runtimeVerified: false };
  } finally { closed = true; clearInterval(timer); await sessions.dispose(); }
}

function createHoYoElevatedSessions({ userData, plans, normal, getLayout, processInfo, appPath, packaged, runPowerShell, emit = () => {},
  now = Date.now, elevationFactory = createOperationElevation, ...rest }) {
  const active = new Map(), records = new Map();
  function notify(state, progress) {
    const row = progress?.session;
    if (!row || row.gameId !== state.gameId || !UUID.test(row.sessionId || '') || !same(row.targetExe, state.exe)) fail('PROGRESS', '管理员助手的运行记录与所选游戏不一致。');
    if (row.historical || state.session && row.sessionId !== state.session.sessionId || state.session?.process &&
        (row.process?.pid !== state.session.process.pid || row.process?.startedAt !== state.session.process.startedAt)) fail('PROGRESS', '管理员观测不能替换已经绑定的游戏会话。');
    const checkedAt = Date.parse(progress.checkedAt || '');
    if (!Number.isFinite(checkedAt) || checkedAt > now() + 5000 || checkedAt < (state.updatedAt || 0) - 5000) fail('PROGRESS', '管理员观测时间无效或倒退。');
    state.session = { ...row, elevated: true }; state.verification = now() - checkedAt <= 15000 ? progress.verification || null : null; state.updatedAt = checkedAt;
    records.set(state.gameId, state); emit(state.session);
    if (!state.started && ['waiting-launcher', 'waiting-game', 'game-matched', 'waiting-enhancement'].includes(row.status)) {
      state.started = true; state.resolve(structuredClone(state.session));
    }
  }
  async function start(id, controls) {
    assertLaunchNotCancelled(controls);
    if (!needsHoYoElevation(getLayout(id))) return normal.start(id, controls);
    if (active.has(id)) {
      const running = active.get(id);
      if (running.session) return structuredClone(running.session);
      fail('BUSY', '此游戏的专用加载助手仍在启动，请完成 Windows 权限确认。');
    }
    const state = { gameId: id, exe: getLayout(id).exe, started: false, updatedAt: 0, session: null, done: false };
    active.set(id, state);
    let plan;
    try {
      plan = await plans.preview(id);
      if (state.cancelRequested) fail('CANCELLED', '已取消本次管理员加载。');
      assertLaunchNotCancelled(controls);
    } catch (error) { if (active.get(id) === state) active.delete(id); throw error; }
    state.exe = plan.exe;
    const promise = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    const elevated = elevationFactory({ ...rest, userData: namespace(userData), plans, processInfo, appPath, packaged, runPowerShell,
      workerFlag: '--hoyo-launch-worker', timeoutMs: 12 * 60 * 60000 + 120000, pollMs: 1000,
      cancelled: () => state.cancelRequested || controls?.cancelled?.(),
      onReserved: async info => { state.dispatch = info; if (state.cancelRequested || controls?.cancelled?.()) await cancel(id); },
      onDispatched: async info => { state.dispatch = info; if (state.cancelRequested) await cancel(id); }, onProgress: progress => notify(state, progress) });
    state.finished = Promise.resolve().then(async () => {
      const previous = await elevated.inspect();
      if (previous.active && previous.canRecover) await elevated.recover();
      else if (previous.active) fail('BUSY', '原米哈游加载工作进程尚未结束，请稍后再试。');
      if (state.cancelRequested) fail('CANCELLED', '已取消本次管理员加载。');
      assertLaunchNotCancelled(controls);
      return elevated.apply(id, plan.planId, { confirm: true, fingerprint: plan.fingerprint });
    }).then(result => {
      if (!state.started) state.reject(Object.assign(Error('专用助手结束前未确认游戏启动。'), { code: 'HOYO_ELEVATION_NOT_STARTED' }));
      state.done = true; state.verification = null;
      if (state.session) { state.session = { ...state.session, status: result.cancelled ? 'cancelled' : 'game-exited', gamePreserved: true }; emit(state.session); }
      return result;
    }).catch(error => {
      if (!state.started) state.reject(error);
      if (state.session) { state.session = { ...state.session, status: 'enhancement-failed', gamePreserved: true,
        error: { code: error.code, message: error.message } }; emit(state.session); }
    }).finally(() => { state.done = true; state.verification = null; active.delete(id); });
    return promise;
  }
  async function inspect(id) { return records.get(id)?.session ? structuredClone(records.get(id).session) : normal.inspect(id); }
  async function cancel(id) {
    const state = active.get(id); if (!state) return normal.cancel(id);
    state.cancelRequested = true;
    if (state.dispatch) {
      const { nonce, requestHash } = state.dispatch;
      await atomicJson(locations(namespace(userData), nonce).cancel, { version: 1, nonce, requestHash, cancel: true });
    }
    return { cancelled: true, gamePreserved: true };
  }
  async function assess(id, session) {
    const state = records.get(id), result = emptyVerification(session?.helper, session);
    if (!state || !session?.elevated) return null;
    if (state.done || now() - state.updatedAt > 15000 || state.session?.sessionId !== session.sessionId || session.gameId !== id || !same(session.targetExe, state.exe) ||
        state.session?.process && (session.process?.pid !== state.session.process.pid || session.process?.startedAt !== state.session.process.startedAt) || !needsHoYoElevation(getLayout(id))) {
      result.nr.detail = '管理员运行观测已结束或过期；不沿用旧的 NR 完成状态。'; return result;
    }
    return state.verification ? structuredClone(state.verification) : result;
  }
  async function dispose() { await Promise.allSettled([...active.keys()].map(cancel)); await normal.dispose(); }
  return { start, inspect, cancel, dispose, assess, live: id => records.get(id)?.session || normal.live(id) };
}
module.exports = { createHoYoLaunchPlans, createHoYoElevatedSessions, runHoYoRuntime, needsHoYoElevation, namespace };
