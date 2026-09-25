'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, atomicJson, assertLaunchNotCancelled } = require('./launch-safety');
const { same } = require('./game-processes');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function createLaunchSessions({ userData, game, broker, processes, helper = null, launchDirect = null, launchHoYo = null,
  beforeLaunch = async () => {}, onGameMatched = async () => {}, emit = () => {}, timeoutMs = 60000, hoyoTimeoutMs = timeoutMs, pollMs = 1000, now = Date.now, delay = sleep }) {
  const sessions = new Map(), active = new Map();
  const directory = path.join(userData, 'launch-sessions');
  const publicSession = row => structuredClone(Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('_'))));
  const recordFile = id => path.join(directory, crypto.createHash('sha256').update(String(id)).digest('hex') + '.json');
  async function save(row, status, extra = {}) {
    Object.assign(row, extra, { status, updatedAt: new Date(now()).toISOString() });
    const snapshot = publicSession(row);
    row._saving = (row._saving || Promise.resolve()).catch(() => {}).then(async () => { await atomicJson(recordFile(row.gameId), snapshot); await emit(snapshot); });
    await row._saving;
  }
  async function inspect(id) {
    if (sessions.has(id)) return publicSession(sessions.get(id));
    const file = recordFile(id); await noLinks(file);
    let row; try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 128 * 1024) throw Error(); row = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; return { status: 'record-unavailable', gameId: id }; }
    const target = await game(id);
    if (row?.version !== 1 || row.gameId !== id || !same(row.targetExe, target.exe)) return { status: 'stale', gameId: id };
    // A saved Ready never belongs to a new manager session. Keep its history
    // visible, and require live process identity for new runtime observations.
    return { ...row, historical: true };
  }
  async function start(id, controls) {
    assertLaunchNotCancelled(controls);
    if (active.has(id)) fail('LAUNCH_BUSY', '该游戏正在启动，请等待或取消本次等待。');
    const target = await game(id);
    assertLaunchNotCancelled(controls);
    if (!target || !path.isAbsolute(target.exe || '') || !['steam', 'exe', 'official', 'hoyoplay', 'starward'].includes(target.launchMode)) fail('LAUNCH_TARGET', '没有可验证的启动入口。');
    const hoyo = ['hoyoplay', 'starward'].includes(target.launchMode);
    if (hoyo && (!target.helper || !launchHoYo)) fail('LAUNCH_HELPER_UNAVAILABLE', '米哈游路线需要已绑定的启动器和加载助手。');
    const row = { version: 1, sessionId: crypto.randomUUID(), gameId: id, targetExe: target.exe, mode: target.launchMode,
      requestedAt: new Date(now()).toISOString(), status: 'preflight', helper: { status: target.helper ? 'starting' : 'not-applicable' },
      process: null, cleanup: { status: 'not-needed' }, runtimeVerified: false };
    sessions.set(id, row); active.set(id, row); row._cancelled = false;
    const cancellation = { cancelled: () => row._cancelled || controls?.cancelled?.() };
    let helperSession;
    try {
      await beforeLaunch(id, { sessionId: row.sessionId, targetExe: row.targetExe, requestedAt: row.requestedAt }); await noLinks(target.exe);
      if ((await processes.find(target.exe)).length) fail('LAUNCH_GAME_RUNNING', '游戏已在运行，请先退出再启动。');
      assertLaunchNotCancelled(cancellation);
      await save(row, 'preflight');
      if (target.helper) {
        if (!helper) fail('LAUNCH_HELPER_UNAVAILABLE', '此路线需要兼容加载助手，当前没有已核验的适配器。');
        await save(row, 'waiting-helper');
        assertLaunchNotCancelled(cancellation);
        helperSession = await helper.prepare({ ...target.helper, gameId: id, sessionId: row.sessionId, targetExe: row.targetExe });
        row._helperSession = helperSession;
        assertLaunchNotCancelled(cancellation);
        const ready = await helper.start(helperSession, cancellation);
        if (!ready || ready.sessionId !== row.sessionId || !same(ready.targetExe, row.targetExe) || ready.configHash !== helperSession.configHash)
          fail('LAUNCH_HELPER_IDENTITY', '助手就绪事件与本次游戏或配置不一致，已停止启动。');
        row.helper = { status: 'ready', sessionId: ready.sessionId, targetExe: row.targetExe, configHash: ready.configHash, helperPid: ready.helperPid,
          readyAt: new Date(now()).toISOString() };
      }
      assertLaunchNotCancelled(cancellation);
      await save(row, 'request-sending');
      if (helperSession && helper.alive && !await helper.alive(helperSession)) fail('LAUNCH_HELPER_EXITED', '助手已在发送启动请求前退出，已停止本次启动。');
      assertLaunchNotCancelled(cancellation);
      if (hoyo) {
        row._launchRequested = true;
        // The adapter revalidates the bound EXE, launcher and protocol after
        // helper Ready, immediately before issuing the launch request.
        const launched = await launchHoYo(id, target, cancellation);
        row.launchInstruction = launched.launchInstruction;
      } else if (row.mode === 'steam') {
        if (!/^\d{1,10}$/.test(String(target.steamAppId || '')) || !path.isAbsolute(target.steamRoot || '')) fail('LAUNCH_STEAM_UNVERIFIED', '没有与游戏安装记录匹配的 Steam AppID。');
        const steamExe = path.join(target.steamRoot, 'steam.exe');
        row._launchRequested = true;
        await broker.launch({ exe: steamExe, args: ['-applaunch', String(target.steamAppId)], cwd: target.steamRoot }, cancellation);
      } else if (row.mode === 'official') {
        if (!target.launchRequest || !path.isAbsolute(target.launchRequest.exe || '')) fail('LAUNCH_OFFICIAL_UNVERIFIED', '没有可验证的官方启动器入口。');
        row._launchRequested = true;
        await broker.launch(target.launchRequest, cancellation);
      } else {
        row._launchRequested = true;
        if (launchDirect) await launchDirect(id);
        else await broker.launch({ exe: target.exe, args: target.args || [], cwd: path.dirname(target.exe) }, cancellation);
      }
      await save(row, row.mode === 'steam' || row.mode === 'official' || hoyo ? 'waiting-launcher' : 'waiting-game');
      const deadline = now() + (hoyo ? hoyoTimeoutMs : timeoutMs), requested = Date.parse(row.requestedAt);
      while (now() <= deadline) {
        if (cancellation.cancelled()) fail('LAUNCH_CANCELLED', '已取消等待；已发送的启动请求不会撤回，也不会结束游戏。');
        const found = (await processes.find(target.exe)).filter(item => Date.parse(item.startedAt) >= requested - 1000);
        if (found.length > 1) fail('LAUNCH_AMBIGUOUS_PROCESS', '出现多个匹配的游戏进程，无法确认本次目标。');
        if (found.length === 1) {
          row.process = found[0];
          await save(row, 'game-matched');
          await onGameMatched(id, publicSession(row));
          await save(row, 'waiting-enhancement');
          await helper?.watch?.(helperSession, { onFailure: async error => {
            row.helper = { ...row.helper, status: 'failed', reason: error.message };
            await save(row, 'enhancement-failed', { gamePreserved: true });
          }, process: row.process });
          return publicSession(row);
        }
        if (helperSession && helper.alive && !await helper.alive(helperSession)) fail('LAUNCH_HELPER_EXITED', '等待游戏时助手提前退出，加载准备失败。');
        await delay(pollMs);
      }
      fail('LAUNCH_TARGET_TIMEOUT', '已发送启动请求，但未匹配到所选游戏 EXE。请核对启动器和 API 入口；不会自动改用直接启动。');
    } catch (error) {
      let preserved = Boolean(row.process);
      if (row._launchRequested && !row.process) {
        try {
          const found = (await processes.find(target.exe)).filter(item => Date.parse(item.startedAt) >= Date.parse(row.requestedAt) - 1000);
          if (found.length === 1) row.process = found[0];
          preserved = found.length > 0;
        } catch { row.processObservation = 'unavailable'; }
      }
      if (/^(?:HELPER_|LAUNCH_HELPER_)/.test(error.code || '')) row.helper = { ...row.helper, status: 'failed', reason: error.message };
      if (helperSession && !row.process) {
        try { row.cleanup = await helper.stop(helperSession, error.code || 'launch-failed'); }
        catch (cleanup) { row.cleanup = { status: 'failed', reason: cleanup.message }; }
      }
      await save(row, error.code === 'LAUNCH_CANCELLED' ? 'cancelled' : preserved && row.helper.status === 'failed' ? 'enhancement-failed' : 'failed',
        { error: { code: error.code || 'LAUNCH_FAILED', message: error.message }, gamePreserved: preserved || row._launchRequested && row.processObservation === 'unavailable' ? true : false });
      throw Object.assign(error, { details: { ...error.details, launchSession: publicSession(row) } });
    } finally { active.delete(id); }
  }
  function cancel(id) { const row = active.get(id); if (row) row._cancelled = true; return { cancelled: Boolean(row) }; }
  // Closing this UI never kills games. Only waiting, owned helpers are cancelled.
  async function dispose() { for (const row of active.values()) row._cancelled = true; await helper?.detach?.(); }
  return { start, inspect, cancel, dispose, live: id => sessions.get(id) ? publicSession(sessions.get(id)) : null };
}
module.exports = { createLaunchSessions };
