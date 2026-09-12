'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, digestFile } = require('./launch-safety');
const { same } = require('./game-processes');
const fail = (code, message) => { throw Object.assign(new Error(message), { code: 'ASSESSMENT_' + code }); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const RESULTS = ['changed', 'unchanged', 'uncertain'];
function createGameVerificationRecords({ userData, gameExecutable, layout, launchSession, coreIdentity }) {
  if (!path.isAbsolute(userData || '')) fail('IDENTITY', '观察记录需要当前管理器的用户数据目录。');
  async function identity(id) {
    try {
      const exe = gameExecutable(id), current = await layout(id);
      if (!path.isAbsolute(exe || '') || !same(current?.exe, exe)) fail('IDENTITY', '没有可绑定的游戏程序与当前部署。');
      await noLinks(exe); const exeHash = await digestFile(exe);
      if (!HASH.test(exeHash || '')) fail('IDENTITY', '当前游戏程序缺失，不能绑定画面对照记录。');
      const core = await coreIdentity?.(id);
      if (core?.verified !== true || !path.isAbsolute(core.path || '') || !HASH.test(core.sha256 || '') || typeof core.version !== 'string' || !core.version)
        fail('CORE_IDENTITY', '当前 Core 缺少可验证的受管身份，不能绑定画面对照记录。');
      await noLinks(core.path);
      if (await digestFile(core.path) !== core.sha256) fail('CORE_IDENTITY', '当前 Core 缺失或摘要不符，不能绑定画面对照记录。');
      return { exe, exeSha256: exeHash, corePath: core.path, coreSha256: core.sha256, coreVersion: core.version,
        directory: path.join(userData, 'game-verification', crypto.createHash('sha256').update(path.resolve(exe).toLowerCase()).digest('hex')) };
    } catch (error) {
      if (/^ASSESSMENT_(?:IDENTITY|CORE_IDENTITY)$/.test(error.code || '')) throw error;
      fail('CORE_IDENTITY', '当前游戏或 Core 身份暂时无法安全核对，不能绑定画面对照记录。');
    }
  }
  function validSession(session, id, exe) {
    return session && !session.historical && UUID.test(session.sessionId || '') && session.gameId === id && same(session.targetExe, exe) &&
      ['game-matched', 'waiting-enhancement', 'enhancement-failed'].includes(session.status) &&
      Number.isInteger(session.process?.pid) && session.process.pid > 0 && same(session.process.exe, exe) &&
      Number.isFinite(Date.parse(session.requestedAt)) && Number.isFinite(Date.parse(session.process.startedAt)) &&
      Date.parse(session.process.startedAt) >= Date.parse(session.requestedAt) - 1000;
  }
  function sameSession(left, right) {
    return left?.sessionId === right?.sessionId && same(left?.targetExe, right?.targetExe) &&
      left?.process?.pid === right?.process?.pid && left?.process?.startedAt === right?.process?.startedAt;
  }
  async function currentSession(id, exe, expected) {
    const live = await launchSession(id);
    if (!validSession(live, id, exe) || expected !== undefined && (!validSession(expected, id, exe) || !sameSession(live, expected)))
      fail('SESSION', '记录需要绑定当前管理器已匹配的游戏会话。');
    return live;
  }
  async function record(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sessionId', 'sameScene', 'result', 'note', 'evidenceLabel'].includes(key)) ||
      !UUID.test(input.sessionId || '') || input.sameScene !== true || !RESULTS.includes(input.result) || typeof input.note !== 'string' || input.note.length > 2000 ||
      input.evidenceLabel !== undefined && (typeof input.evidenceLabel !== 'string' || input.evidenceLabel.length > 240)) fail('INPUT', '请确认同场景开关对照，并填写观察结果。');
    const current = await identity(id), session = await currentSession(id, current.exe);
    if (session.sessionId !== input.sessionId) fail('SESSION', '观察记录与当前游戏会话不一致。');
    const value = { version: 1, id: crypto.randomUUID(), recordedAt: new Date().toISOString(), gameId: id, exe: current.exe,
      exeSha256: current.exeSha256, corePath: current.corePath, coreSha256: current.coreSha256, coreVersion: current.coreVersion, sessionId: session.sessionId,
      process: { pid: session.process.pid, exe: current.exe, startedAt: session.process.startedAt }, source: 'user-comparison', result: input.result,
      sameScene: true, note: input.note.trim(), evidenceLabel: input.evidenceLabel?.trim() || null, automaticVerification: false };
    const rechecked = await identity(id); await currentSession(id, current.exe, session);
    if (JSON.stringify(rechecked) !== JSON.stringify(current)) fail('CORE_IDENTITY', '观察记录保存前游戏或 Core 身份发生变化。');
    await noLinks(current.directory); await fs.mkdir(current.directory, { recursive: true }); await noLinks(current.directory);
    await fs.writeFile(path.join(current.directory, `${value.id}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    return { recorded: true, record: value, notice: '画面对照已按本次游戏与 Core 身份保存，来源标为用户观察。' };
  }
  async function inspect(id, session) {
    let current, live; try { current = await identity(id); live = await currentSession(id, current.exe, session); }
    catch (error) { if (/^ASSESSMENT_(?:IDENTITY|CORE_IDENTITY|SESSION)$/.test(error.code || '')) return null; throw error; }
    await noLinks(current.directory);
    let files; try { files = await fs.readdir(current.directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const rows = [];
    for (const name of files.filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).slice(-200)) {
      const file = path.join(current.directory, name); await noLinks(file);
      try {
        const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 16384) continue;
        const row = JSON.parse(await fs.readFile(file, 'utf8'));
        if (row.version === 1 && row.id + '.json' === name && row.gameId === id && row.source === 'user-comparison' && row.automaticVerification === false &&
          row.sameScene === true && RESULTS.includes(row.result) && typeof row.note === 'string' && row.note.length <= 2000 &&
          (row.evidenceLabel === null || typeof row.evidenceLabel === 'string' && row.evidenceLabel.length <= 240) &&
          typeof row.recordedAt === 'string' && Number.isFinite(Date.parse(row.recordedAt)) && Date.parse(row.recordedAt) >= Date.parse(live.requestedAt) &&
          row.exeSha256 === current.exeSha256 && row.coreSha256 === current.coreSha256 && row.coreVersion === current.coreVersion && same(row.corePath, current.corePath) &&
          row.sessionId === live.sessionId && same(row.exe, current.exe) && row.process?.pid === live.process.pid &&
          row.process?.startedAt === live.process.startedAt && same(row.process?.exe, current.exe)) rows.push(row);
      } catch {}
    }
    const row = rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    if (!row) return null;
    return { status: row.result === 'changed' ? 'passed' : row.result === 'unchanged' ? 'not-observed' : 'unverified',
      detail: row.result === 'changed' ? '用户报告同场景开关对照有画面变化；此项来源为用户观察。' : row.result === 'unchanged' ? '用户报告本次同场景对照未观察到画面变化。' : '用户尚不能确认本次画面变化。', evidence: [row], source: 'user-comparison', automaticVerification: false };
  }
  return { record, inspect };
}
module.exports = { createGameVerificationRecords };
