'use strict';
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { emptyVerification } = require('./runtime-verification');
const { createLegacyEvidenceReader } = require('./legacy-runtime-evidence');
const { createLegacyRuntime } = require('./legacy-runtime');
const { fileDigest, resolveFile, fingerprint } = require('./feeder-runtime');
const { noLinks } = require('./launch-safety');
const { same } = require('./game-processes');
const { classifySeries } = require('./gpu');
const entry = (status, detail, evidence = []) => ({ status, detail, evidence });
const identity = context => fingerprint({ game: context.game, recipe: context.recipe, layout: context.layout });
const REASONS = {
  'hardware-luid-unavailable': '尚未核对当前游戏使用的显卡。',
  'game-process-no-longer-matches': '本次游戏已退出或进程身份改变。',
  'target-loader-or-provider-not-loaded': '等待游戏加载所选 ReShade 和 Feeder。',
  'host-process-or-adapter-mismatch': '宿主进程或显卡与本次游戏不匹配。',
  'host-components-not-loaded': '等待独立宿主加载所选 Core 与 DLSS5 模型。',
  'latest-game-frame-retained': '最新帧保留原图，尚未确认新的 NR 回填。',
  'log-replaced-or-truncated': '运行日志已重建，等待匹配本次宿主的新记录。',
  'log-rewritten': '运行日志身份改变，当前证据不再适用。'
};

function createLegacyRuntimeVerification(options) {
  const runtime = options.runtime || createLegacyRuntime(options), execute = options.execute || promisify(execFile);
  const reader = options.reader || createLegacyEvidenceReader({ validateRecipe: recipe => runtime.validateStored(recipe) });
  const sessions = new Map();
  function components(context) {
    const roots = { game: path.dirname(context.game.exePath), runtime: context.layout.runtimeDir, addon: context.layout.addonDirectory };
    const rows = context.recipe.files.filter(row => row.architecture).map(row => ({ role: row.role, path: resolveFile(roots[row.base], row.target), sha256: row.sha256,
      host: row.target.startsWith('host64/') }));
    if (context.loader && !rows.some(row => same(row.path, context.loader.path))) rows.push({ ...context.loader, role: 'reshade', host: false });
    return rows;
  }
  async function adapters(context) {
    const probe = runtime.adapterProbe();
    if (!path.isAbsolute(probe.file || '') || path.extname(probe.file).toLowerCase() !== '.exe' ||
      JSON.stringify(probe.args) !== '["--list-adapters-json"]') throw Error('显卡枚举工具身份无效。');
    await noLinks(probe.file);
    if (await fileDigest(probe.file) !== probe.sha256) throw Error('显卡枚举工具摘要已改变。');
    const { stdout } = await execute(probe.file, probe.args, { windowsHide: true, cwd: path.dirname(probe.file), timeout: 6000,
      maxBuffer: 64 * 1024, encoding: 'utf8' });
    if (await fileDigest(probe.file) !== probe.sha256) throw Error('显卡枚举期间工具已改变。');
    const result = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim());
    if (result?.schema !== 1 || !Array.isArray(result.adapters) || result.adapters.length > 32) throw Error('显卡枚举结果无效。');
    const list = result.adapters.filter(row => row.vendorId === 0x10de && row.software === false &&
      /^[a-f0-9]{8}:[a-f0-9]{8}$/i.test(row.luid || '') && ['RTX40', 'RTX50'].includes(classifySeries(row.description)) &&
      classifySeries(row.description) === context.recipe.hardwareFamily);
    return [...new Map(list.map(row => [row.luid.toUpperCase(), { luid: row.luid.toUpperCase(), description: row.description }])).values()];
  }
  async function observe(target, expected) {
    const live = await options.processes.observe(target); if (!live) return null;
    const modules = [];
    for (const row of expected) if (live.modules.some(file => same(typeof file === 'string' ? file : file.path, row.path))) {
      await noLinks(row.path); modules.push({ path: row.path, sha256: await fileDigest(row.path) });
    }
    return { pid: live.pid, parentPid: live.parentPid, startedAt: live.startedAt, exePath: live.exe,
      exeSha256: await fileDigest(live.exe), modules };
  }
  async function prepare(id, session) {
    const context = await options.context(id); sessions.delete(id);
    if (!context) return null;
    sessions.set(id, { sessionId: session.sessionId, targetExe: session.targetExe, contextIdentity: identity(context), cursor: null, hostIdentity: null });
    return { applicable: true, runtimeVerified: false };
  }
  async function matched(id, session) {
    const state = sessions.get(id); if (!state || state.sessionId !== session.sessionId || !same(state.targetExe, session.targetExe)) return;
    try {
      const context = await options.context(id); if (!context || identity(context) !== state.contextIdentity) throw Error('输入配套在启动后改变。');
      state.cursor = await reader.prepareLegacyEvidence({ ...context, liveGame: { ...session.process, exePath: session.process.exe } });
    } catch (error) { state.error = error.message; }
  }
  async function assess(id, session) {
    const result = emptyVerification(session?.helper, session), state = sessions.get(id);
    if (!state || !session?.process || session.historical || session.sessionId !== state.sessionId || !same(session.targetExe, state.targetExe)) return result;
    try {
      const context = await options.context(id);
      if (!context || identity(context) !== state.contextIdentity) { result.nr.detail = '输入配套已改变，请重新启动本次验证。'; return result; }
      const expected = components(context), game = await observe(session.process, expected.filter(row => !row.host));
      if (!game) { result.nr.detail = '本次游戏进程已退出或身份无法读取。'; return result; }
      const live = [game], hostSpec = expected.find(row => row.role === 'host'); let host = null;
      if (context.recipe.hostRequired && hostSpec) {
        const found = (await options.processes.find(hostSpec.path)).filter(row => row.parentPid === game.pid && Date.parse(row.startedAt) >= Date.parse(game.startedAt));
        if (found.length > 1) { result.nr.detail = '发现多个匹配宿主，尚不能确认本次回填来源。'; return result; }
        if (found.length === 1) {
          host = await observe(found[0], expected.filter(row => row.host)); if (host) live.push(host);
          const current = host && `${host.pid}:${host.startedAt}`;
          if (current && state.hostIdentity && current !== state.hostIdentity) {
            state.cursor = await reader.prepareLegacyEvidence({ ...context, liveGame: { ...session.process, exePath: session.process.exe } });
            state.hostIdentity = current; result.nr.detail = '已匹配重建的宿主，等待其新的 NR 回填记录。'; return result;
          }
          if (current) state.hostIdentity = current;
        }
      }
      const loaded = (process, rows) => rows.length > 0 && rows.every(row => process?.modules.some(module => same(module.path, row.path) && module.sha256 === row.sha256));
      const loaders = expected.filter(row => !row.host && ['game-loader', 'loader', 'reshade'].includes(row.role));
      const loaderLoaded = loaded(game, loaders);
      if (loaderLoaded) result.reshade = entry('passed', '本次游戏进程已加载所选 ReShade。', loaders);
      const coreRows = expected.filter(row => row.role === 'core'), coreProcess = context.recipe.hostRequired ? host : game;
      if (loaded(coreProcess, coreRows)) result.core = entry('passed', context.recipe.hostRequired ? '本次独立宿主已加载指定 Core。' : '本次游戏已加载指定 Core。', coreRows);
      if (!state.cursor) {
        await matched(id, session);
        result.nr.detail = state.cursor ? '已建立本次运行基线，等待下一批完成帧。' : state.error || '暂时无法建立本次运行基线。'; return result;
      }
      const candidates = await adapters(context);
      if (!candidates.length) { result.nr.detail = '未找到与此 NR 配套匹配的系统显卡身份。'; return result; }
      let evidence;
      for (const adapter of candidates) {
        const current = await reader.assessLegacyEvidence({ cursor: state.cursor, liveProcesses: live, expectedHardwareLuid: adapter.luid });
        evidence = current;
        if (current.processed) { evidence = { ...current, adapter }; break; }
      }
      if (evidence?.processed && loaderLoaded) result.nr = entry('passed', `本次已确认 ${evidence.newFrames} 个 NR 完成帧回填；画面变化仍需对照。`, [evidence]);
      else result.nr = entry('unverified', REASONS[evidence?.reason] || '等待本次同一帧的 NR 完成与游戏回填记录。', evidence ? [evidence] : []);
      return result;
    } catch (error) { result.nr = entry('unverified', '当前运行证据尚不能完整核验。', [{ message: error.message }]); return result; }
  }
  return { prepare, matched, assess };
}
module.exports = { createLegacyRuntimeVerification };
