'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { noLinks, digestFile, inside } = require('./launch-safety');
const { same } = require('./game-processes');
const { readManifest, assertManifestExecutable } = require('./manifest');
const entry = (status, detail, evidence = []) => ({ status, detail, evidence });
const HASH = /^[a-f0-9]{64}$/;
const validReady = (helper, session) => session && !session.historical && helper?.status === 'ready' && helper.sessionId === session.sessionId &&
  same(helper.targetExe, session.targetExe) && HASH.test(helper.configHash || '') && Number.isInteger(helper.helperPid) && helper.helperPid > 0 &&
  Number.isFinite(Date.parse(helper.readyAt)) && Date.parse(helper.readyAt) >= Date.parse(session.requestedAt);
const empty = (helper, session) => ({ helper: validReady(helper, session) ? entry('passed', '本次助手已报告绑定游戏与配置的就绪事件。', [helper]) :
  helper?.status === 'not-applicable' ? entry('not-applicable', '当前路线无需加载助手。') : entry(helper?.status === 'failed' ? 'failed' : 'unverified', helper?.reason || '尚无本次助手就绪事件。'),
  reshade: entry('unverified', '等待本次游戏进程加载指定 ReShade。'),
  core: entry('unverified', '等待本次进程加载指定身份的 Core。'),
  nr: entry('unverified', '等待本 Core 的 NR 成功与提交持续增长。'),
  visual: entry('unverified', '需同场景开关对照；F8 / ColorDiag 作为独立证据。') });

// Interpret only the project's own counters. RenoDX HDR and other NR owners
// cannot promote this Core's acceptance. A bypass does not imply missing DLLs.
function parseCoreSamples(text) {
  const samples = [], reasons = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/\[stats\] session totals: Feature18-success=(\d+)\s+[^\r\n]*?transfer-submitted=(\d+)/);
    if (match) {
      const success = Number(match[1]), submitted = Number(match[2]);
      if (Number.isSafeInteger(success) && Number.isSafeInteger(submitted)) samples.push({ success, submitted });
    }
    if (/unsupported-(?:input|output)-format|rejected incompatible (?:Color|Output)|R8G8B8A8_TYPELESS.*(?:reject|unsupported)|(?:reject|unsupported).*R8G8B8A8_TYPELESS/i.test(line))
      reasons.push({ code: 'unsupported-format', detail: 'Core 已加载，NR 因格式不支持而旁路。', raw: line.trim().slice(0, 300) });
    else if (/not-attempted/i.test(line)) reasons.push({ code: 'not-attempted', detail: 'NR 尚未尝试；不能据此判断运行库缺失。', raw: line.trim().slice(0, 300) });
    else if (/\bbypass(?:Reason|[-_ ]reason)?[=:]\s*([^;\r\n]+)/i.test(line))
      reasons.push({ code: 'bypass', detail: line.trim().slice(0, 240), raw: line.trim().slice(0, 300) });
  }
  // Require two increasing observations, rather than one historical total.
  const increasing = samples.some((row, index) => index > 0 && row.success > samples[index - 1].success && row.submitted > samples[index - 1].submitted);
  return { samples: samples.slice(-8), increasing, firstReason: reasons[0] || null };
}

function createRuntimeVerification({ layout, processes, modules: expectedModules }) {
  const captures = new Map();
  async function moduleIdentity(id, current) {
    let rows = [];
    try {
      if (typeof expectedModules === 'function') rows = await expectedModules(id, current);
      else if (current.moduleManifest?.length) rows = current.moduleManifest;
      else if (current.gameRoot) {
        await noLinks(path.join(current.gameRoot, '_DLSS5_Backup/xiaofeng-manager.json'));
        const manifest = readManifest(current.gameRoot);
        if (manifest) {
          assertManifestExecutable(current.gameRoot, manifest, current.exe);
          rows = manifest.files.filter(row => ['addon', 'reshade'].includes(row.kind) && typeof row.rel === 'string' && inside(current.gameRoot, path.resolve(current.gameRoot, row.rel)))
            .map(row => ({ role: row.kind === 'addon' ? 'core' : 'reshade', path: path.resolve(current.gameRoot, row.rel), sha256: row.installedSha256 }));
        }
      }
      if (!Array.isArray(rows) || rows.length > 256) return { core: null, loader: null };
      const valid = rows.filter(row => row && path.isAbsolute(row.path || '') && HASH.test(row.sha256 || ''));
      const cores = valid.filter(row => row.role === 'core'), loaders = valid.filter(row => row.role === 'reshade');
      return { core: cores.length === 1 ? cores[0] : null, loader: loaders.length === 1 ? loaders[0] : null };
    } catch { return { core: null, loader: null }; }
  }
  async function prepare(id, session) {
    const current = await layout(id), files = [];
    for (const dir of [...new Set(current.logDirs || [])]) for (const name of ['nr-before-sr.log', 'nr_before_sr.log']) {
      const file = path.join(dir, name); await noLinks(file);
      try { const stat = await fs.stat(file); files.push({ file, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; files.push({ file, size: 0, ino: null, mtimeMs: 0 }); }
    }
    const expected = await moduleIdentity(id, current), coreFile = expected.core?.path || null;
    if (coreFile) await noLinks(coreFile);
    if (expected.loader) await noLinks(expected.loader.path);
    const value = { files, coreFile, coreSha256: expected.core && await digestFile(coreFile) === expected.core.sha256 ? expected.core.sha256 : null,
      loader: expected.loader && await digestFile(expected.loader.path) === expected.loader.sha256 ? expected.loader : null, startedAt: Date.now(),
      sessionId: session?.sessionId || null, targetExe: session?.targetExe || current.exe, generation: current.generation || null };
    captures.set(id, value); return { coreFile, coreSha256: value.coreSha256 };
  }
  async function newText(row, startedAt) {
    let handle;
    try {
      await noLinks(row.file); const stat = await fs.stat(row.file);
      if (!stat.isFile() || stat.mtimeMs < startedAt) return '';
      const replaced = row.ino === null || stat.ino !== row.ino || stat.size < row.size;
      const offset = Math.max(replaced ? 0 : row.size, stat.size - 128 * 1024), length = stat.size - offset;
      if (!length) return '';
      handle = await fs.open(row.file, 'r'); const current = await handle.stat();
      if (current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return '';
      const buffer = Buffer.alloc(length), result = await handle.read(buffer, 0, length, offset);
      const after = await handle.stat();
      if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return '';
      const text = buffer.subarray(0, result.bytesRead).toString('utf8');
      return offset > (replaced ? 0 : row.size) ? text.slice(text.indexOf('\n') + 1) : text;
    } catch { return ''; } finally { await handle?.close(); }
  }
  async function assess(id, session) {
    const result = empty(session?.helper, session), capture = captures.get(id);
    if (!session?.process || session.historical || !capture || !capture.sessionId || capture.sessionId !== session.sessionId ||
        !same(session.targetExe, capture.targetExe) || !same(session.process.exe, capture.targetExe)) return result;
    let current; try { current = await processes.observe(session.process); } catch { return result; }
    if (!current) { result.core.detail = '本次目标进程已退出或身份无法读取；保留验收待确认。'; return result; }
    const modules = Array.isArray(current.modules) ? current.modules : [];
    const coreLoaded = capture.coreSha256 && modules.some(file => same(file, capture.coreFile)) && await digestFile(capture.coreFile) === capture.coreSha256;
    const currentLayout = await layout(id);
    if (!same(currentLayout.exe, capture.targetExe) || (currentLayout.generation || null) !== capture.generation) return result;
    const expected = await moduleIdentity(id, currentLayout);
    const sameLoader = capture.loader && expected.loader && same(expected.loader.path, capture.loader.path) && expected.loader.sha256 === capture.loader.sha256;
    if (sameLoader) await noLinks(capture.loader.path);
    const reshadeLoaded = sameLoader && currentLayout.verified && modules.some(file => same(file, capture.loader.path)) && await digestFile(capture.loader.path) === capture.loader.sha256;
    if (reshadeLoaded) result.reshade = entry('passed', '本次游戏进程已加载当前部署的 ReShade。', [{ pid: current.pid, path: capture.loader.path, sha256: capture.loader.sha256 }]);
    const sameCore = capture.coreFile && capture.coreSha256 && expected.core && same(expected.core.path, capture.coreFile) && expected.core.sha256 === capture.coreSha256;
    if (sameCore) await noLinks(capture.coreFile);
    if (sameCore && coreLoaded) result.core = entry('passed', '本次进程已加载指定摘要的本 Core。', [{ pid: current.pid, startedAt: current.startedAt, path: capture.coreFile, sha256: capture.coreSha256, source: 'process-modules' }]);
    if (!sameCore || !coreLoaded || !reshadeLoaded) return result;
    const text = (await Promise.all(capture.files.map(row => newText(row, capture.startedAt)))).join('\n');
    const parsed = parseCoreSamples(text);
    if (parsed.increasing) result.nr = entry('passed', '本 Core 的 NR 成功与提交计数持续增长；画面变化仍需单独确认。', parsed.samples);
    else if (parsed.firstReason) result.nr = entry('bypassed', parsed.firstReason.detail, [parsed.firstReason]);
    else if (parsed.samples.length) result.nr = entry('unverified', '已收到本次计数，尚未观察到成功与提交持续增长。', parsed.samples);
    result.nr.firstReason = parsed.firstReason;
    return result;
  }
  return { prepare, assess };
}
module.exports = { createRuntimeVerification, parseCoreSamples, emptyVerification: empty };
