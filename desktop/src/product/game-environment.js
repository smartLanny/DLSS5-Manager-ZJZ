'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const execute = promisify(require('node:child_process').execFile);
const { noLinks, inside, atomicJson } = require('./launch-safety');
const { inspectComponentClues } = require('./component-assessment');
const { snapshotAddonLoadingLayout, assertAddonSnapshot } = require('./addon-loading-layout');
const { planAddonCompatibility } = require('./addon-compatibility');
const PRODUCT = 'xiaofeng-environment-cleanup';
const RECEIPT = '_DLSS5_Backup/xiaofeng-environment.json';
const DIRECTORY = '_DLSS5_Backup/environment-cleanup';
const PROXIES = new Set(['dxgi.dll', 'd3d12.dll', 'd3d11.dll', 'd3d9.dll', 'opengl32.dll', 'dinput8.dll', 'version.dll', 'winmm.dll', 'dsound.dll']);
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = new Set();
const fail = (code, message) => { throw Object.assign(new Error(message), { code: `ENVIRONMENT_${code}` }); };
const key = file => path.resolve(file).toLowerCase();
const jsonHash = value => crypto.createHash('sha256').update(JSON.stringify(value, null, 2) + '\n').digest('hex');
async function digest(file, maxBytes = 64 * 1024 * 1024) {
  await noLinks(file);
  let before; try { before = await fsp.stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!before.isFile() || before.size > maxBytes) fail('FILE_INVALID', '清理目标不是可检查的普通文件。');
  const hash = crypto.createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  await noLinks(file); const after = await fsp.stat(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('FILE_CHANGED', '文件在检查期间改变，请重新检查。');
  return hash.digest('hex');
}
async function readJson(file, maxBytes = 128 * 1024) {
  await noLinks(file);
  try {
    const stat = await fsp.stat(file); if (!stat.isFile() || stat.size > maxBytes) fail('RECORD_INVALID', '环境恢复记录大小无效。');
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function createGameEnvironment(options) {
  const journal = options.journal || require('../core/file-journal');
  const guards = options.guards || require('../core/install-guards');
  const pe = options.pe || require('../core/pe');
  const copy = options.copyFile || fsp.copyFile, plans = new Map();
  async function publish(temp, targetFile, replace) {
    if (process.platform !== 'win32') fail('PLATFORM_UNSUPPORTED', '此环境清理功能需要 Windows。');
    // File.Move refuses an existing destination. Unlike copyFile, it never
    // exposes incomplete bytes at the live path. File.Replace is used only
    // for an already validated manager JSON receipt during rollback.
    const literal = file => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(file).toString('base64')}'))`;
    const script = `$ErrorActionPreference='Stop'; [IO.File]::${replace ? 'Replace' : 'Move'}(${literal(temp)},${literal(targetFile)}${replace ? ',[NullString]::Value' : ''});`;
    try {
      await execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000, maxBuffer: 8192 });
    } catch (cause) { throw Object.assign(new Error('文件提交未完成，原文件和恢复记录已保留；请检查目录权限或重试恢复。'), { code: 'ENVIRONMENT_COMMIT_FAILED', cause }); }
  }
  async function atomicCopy(t, source, destination, expected, replace = false) {
    const staging = journal.safePath(t.game, `_DLSS5_Backup/environment-staging/${crypto.randomUUID()}.part`);
    await noLinks(staging); await fsp.mkdir(path.dirname(staging), { recursive: true });
    try {
      await copy(source, staging, fs.constants.COPYFILE_EXCL);
      if (await digest(staging) !== expected || await digest(source) !== expected) fail('FILE_CHANGED', '暂存文件验证失败，未提交到游戏目录。');
      const handle = await fsp.open(staging, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await noLinks(destination); await closed(t);
      if (!replace && await digest(destination) !== null) fail('FILE_CHANGED', '提交前目标已出现，未覆盖。');
      await publish(staging, destination, replace);
    } finally {
      // A process exit may leave a .part inside this dedicated staging folder.
      // It is never a live DLL or an accepted backup and cannot block recovery.
      await fsp.unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  function target(id) {
    const gameInput = options.gameDirectory(id), exeInput = options.gameExecutable(id);
    if (typeof gameInput !== 'string' || !path.isAbsolute(gameInput) || typeof exeInput !== 'string' || !path.isAbsolute(exeInput)) fail('TARGET_INVALID', '请先确认实际游戏 EXE。');
    const game = path.resolve(gameInput), exe = path.resolve(exeInput);
    if (!inside(game, exe) || !/\.exe$/i.test(exe)) fail('TARGET_INVALID', '请先确认实际游戏 EXE。');
    return { id, game, exe, dir: path.dirname(exe), record: journal.safePath(game, RECEIPT) };
  }
  function graphicsFile(t, rel) {
    const file = journal.safePath(t.game, rel), name = path.basename(file).toLowerCase();
    return key(path.dirname(file)) === key(t.dir) && (PROXIES.has(name) || /\.addon(?:32|64)?$/i.test(name));
  }
  async function closed(t) { await noLinks(t.exe); await guards.assertGameClosed(t.game, t.exe); }
  async function record(t) {
    const value = await readJson(t.record); if (!value) return null;
    if (value.version !== 1 || value.product !== PRODUCT || !UUID.test(value.id || '') || key(value.game || '.') !== key(t.game) || key(value.exe || '.') !== key(t.exe) || !['isolated', 'restored'].includes(value.state) || !Array.isArray(value.files) || !value.files.length || value.files.length > 64)
      fail('RECORD_INVALID', '环境恢复记录与当前游戏不一致，已保留备份。');
    const seen = new Set();
    value.files.forEach((row, index) => {
      if (!graphicsFile(t, row.rel) || seen.has(row.rel.toLowerCase()) || !HASH.test(row.sha256 || '') || row.backup !== `${DIRECTORY}/${value.id}/${index}.bin`)
        fail('RECORD_INVALID', '环境恢复记录含未知目标，未修改文件。');
      seen.add(row.rel.toLowerCase());
    });
    return value;
  }
  async function pending(t) {
    const state = await readJson(journal.pendingPath(t.game), 2 * 1024 * 1024);
    return state?.owner?.product === PRODUCT ? state : null;
  }
  async function remaining(id) {
    const t = target(id); await noLinks(t.dir);
    const entries = await fsp.readdir(t.dir, { withFileTypes: true }), files = [];
    for (const entry of entries) {
      const rel = path.relative(t.game, path.join(t.dir, entry.name)).replaceAll('\\', '/');
      if (!graphicsFile(t, rel)) continue;
      await noLinks(path.join(t.dir, entry.name));
      files.push({ name: entry.name, rel, addon: /\.addon(?:32|64)?$/i.test(entry.name),
        legacyNr: /(?:dlss5|nr[-_ ]?before[-_ ]?sr)/i.test(entry.name) && /\.addon(?:32|64)?$/i.test(entry.name) });
    }
    return files;
  }
  async function inspect(id) {
    const t = target(id), interrupted = await pending(t), saved = interrupted ? null : await record(t);
    return { pending: Boolean(interrupted), isolated: saved?.state === 'isolated', canRestore: Boolean(interrupted || saved?.state === 'isolated'),
      files: saved?.files.map(row => ({ name: path.basename(row.rel), sha256: row.sha256 })) || [], backupDirectory: saved ? path.join(t.game, DIRECTORY, saved.id) : null,
      remainingFiles: await remaining(id),
      scope: '仅检查所选 EXE 同目录的图形代理与 Add-on；不检查或修改游戏本体、存档、原生 DLSS 和着色器目录。' };
  }
  async function assertReady(id) {
    // Renaming a library entry remains possible when its EXE is missing.
    // A pending cleanup is bound to the game root and must still block writes.
    const root = options.gameDirectory(id);
    if (typeof root !== 'string' || !path.isAbsolute(root)) fail('TARGET_INVALID', '无法确认游戏安装目录。');
    const state = await readJson(journal.pendingPath(root), 2 * 1024 * 1024);
    if (state?.owner?.product === PRODUCT) fail('RECOVERY_REQUIRED', '上次环境清理未完成，请在“维护与恢复”中撤销清理。');
  }
  async function preview(id) {
    const t = target(id); await closed(t); await assertReady(id);
    if ((await record(t))?.state === 'isolated') fail('BACKUP_EXISTS', '上次环境清理仍保持隔离，可先撤销清理；现有备份不会被覆盖。');
    if (fs.existsSync(journal.pendingPath(t.game))) fail('OTHER_RECOVERY', '游戏仍有其他未完成操作，请先恢复。');
    const snapshot = await snapshotAddonLoadingLayout({ exeDir: t.dir, gameId: id, architecture: 64, environment: options.environment || process.env });
    const knownComponents = typeof options.knownComponents === 'function' ? await options.knownComponents(id) : options.knownComponents || [];
    const compatibility = planAddonCompatibility(snapshot, { knownComponents });
    if (compatibility.blockers.length) fail('LOAD_LAYOUT', '无法完整核对插件实际加载范围，请先恢复或修正配置。');
    const entries = await fsp.readdir(t.dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      const rel = path.relative(t.game, path.join(t.dir, entry.name)).replaceAll('\\', '/');
      if (!graphicsFile(t, rel)) continue;
      const file = journal.safePath(t.game, rel), sha256 = await digest(file), bytes = (await fsp.stat(file)).size;
      const addon = /\.addon(?:32|64)?$/i.test(entry.name);
      const decision = addon ? compatibility.decisions.find(row => key(row.path) === key(file)) : null;
      const clues = addon ? await inspectComponentClues(file) : null;
      const recognized = addon ? clues.classification === 'unknown' ? 'ReShade Add-on（来源未确认）' : clues.label : ['ReShade', 'OptiScaler', 'Ultimate ASI Loader', 'REFramework'].find(label => pe.versionMentions(file, label)) || null;
      const systemRuntime = !recognized && pe.versionMentions(file, 'Microsoft');
      const preserveAddon = addon && (!['core', 'native-carrier'].includes(clues.classification) || clues.evidence.some(row =>
        ['renodx-hdr', 'renodx-other', 'renodx-generic-nr', 'renodx-dlss5', 'mfgunlock', 'other-mod'].includes(row.classification)));
      candidates.push({ name: entry.name, rel, sha256, bytes, kind: recognized || (systemRuntime ? '游戏或系统运行组件' : '来源未确认的代理 DLL'),
        selectable: !systemRuntime && (!addon || decision?.moduleMayLoad === true),
        selectedByDefault: addon ? decision?.action === 'isolate' : Boolean(recognized),
        mandatory: addon && decision?.mandatory === true && decision.action === 'isolate',
        ...(decision ? { compatibility: decision, loadState: decision.loadState } : {}),
        ...(clues ? { classification: clues.classification, source: clues.source, confidence: clues.confidence, evidence: clues.evidence } : {}),
        note: addon ? decision?.reason || '文件不在当前插件加载范围，保持原位。' : recognized ?
          addon && clues.confidence === 'hint' ? '仅名称提示可能属于旧核心；请核对后选择，清理时按原摘要备份。' : '可备份隔离，撤销清理时按原摘要恢复。' :
          systemRuntime ? '可能属于游戏本体，不列入清理。' : '可能是其他模组，也可能是游戏所需文件；不会自动选中。' });
    }
    if (candidates.length > 64) fail('TOO_MANY_FILES', '同目录插件过多，未自动扩大清理范围。');
    const planId = crypto.randomUUID(), plan = { id, planId, exe: t.exe, exeHash: await digest(t.exe, 8 * 1024 * 1024 * 1024), candidates, snapshot, expires: Date.now() + 5 * 60 * 1000 };
    plans.set(planId, plan);
    return { planId, candidates, compatibility, scope: (await inspect(id)).scope, requiresConfirmation: true,
      externalPlugins: compatibility.decisions.filter(row => key(path.dirname(row.path)) !== key(t.dir)).map(row => ({ ...row,
        handledBy: 'deployment', note: '实际插件位于独立运行目录，请通过部署预览执行隔离与恢复。' })) };
  }
  async function validateWal(t, state) {
    const owner = state?.owner;
    if (!owner || owner.product !== PRODUCT || owner.version !== 1 || key(owner.exe || '.') !== key(t.exe) || !UUID.test(owner.cleanupId || '') || !['isolate', 'restore'].includes(owner.operation) || !Array.isArray(owner.checks) || owner.checks.length > 132)
      fail('RECOVERY_INVALID', '环境清理事务归属无效，已保留记录。');
    if (!Array.isArray(state.files) || !Array.isArray(state.dirs) || state.files.length > 132 || !/^_DLSS5_Backup\/\.transactions\/[a-f0-9-]+$/.test(state.folder || '')) fail('RECOVERY_INVALID', '环境清理事务范围无效。');
    if (owner.pid !== process.pid && Number.isInteger(owner.pid)) {
      try { process.kill(owner.pid, 0); fail('BUSY', '另一管理器仍持有本次环境操作，请先结束该操作。'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const allowed = rel => rel === RECEIPT || rel === '_DLSS5_Backup/manifest.json' || graphicsFile(t, rel) || new RegExp(`^${DIRECTORY}/${owner.cleanupId}/[0-9]+\\.bin$`).test(rel);
    const checks = new Map();
    for (const row of owner.checks) {
      if (!allowed(row.rel) || checks.has(row.rel.toLowerCase()) || !(row.before === null || HASH.test(row.before || '')) || !Array.isArray(row.after) || row.after.some(value => value !== null && !HASH.test(value || '')))
        fail('RECOVERY_INVALID', '环境清理摘要记录无效。');
      checks.set(row.rel.toLowerCase(), row);
    }
    const dirs = new Set(), seen = new Set();
    for (let index = 0; index < state.files.length; index++) {
      const row = state.files[index], check = checks.get(String(row.rel).replaceAll('\\', '/').toLowerCase());
      if (!check || seen.has(row.rel.toLowerCase()) || row.snapshot !== `${state.folder}/${index}.bin` || row.existed !== (check.before !== null)) fail('RECOVERY_INVALID', '环境清理含未授权或重复的恢复目标。');
      seen.add(row.rel.toLowerCase());
      const before = row.existed ? await digest(journal.safePath(t.game, row.snapshot)) : null;
      if (before !== check.before) fail('RECOVERY_INVALID', '环境恢复快照摘要不一致。');
      const now = await digest(journal.safePath(t.game, row.rel));
      if (![check.before, ...check.after].includes(now)) fail('FILE_CHANGED', `${path.basename(row.rel)} 已被外部改变，文件和恢复记录均已保留。`);
      let parent = path.posix.dirname(row.rel.replaceAll('\\', '/')); while (parent !== '.') { dirs.add(parent.toLowerCase()); parent = path.posix.dirname(parent); }
    }
    if (state.dirs.some(dir => !dirs.has(dir.replaceAll('\\', '/').toLowerCase()))) fail('RECOVERY_INVALID', '环境恢复包含其他目录。');
  }
  async function rollback(t, state) {
    await validateWal(t, state);
    const checks = new Map(state.owner.checks.map(row => [row.rel.toLowerCase(), row]));
    for (const row of [...state.files].reverse()) {
      await closed(t);
      const rel = row.rel.replaceAll('\\', '/'), check = checks.get(rel.toLowerCase()), destination = journal.safePath(t.game, rel);
      const current = await digest(destination);
      if (current === check.before) continue;
      if (![check.before, ...check.after].includes(current)) fail('FILE_CHANGED', '恢复前文件被外部改变，未覆盖。');
      if (check.before === null) await fsp.unlink(destination);
      else {
        // An existing unequal target can only be the owned JSON record. Live
        // DLL restoration always commits into an absent destination.
        if (current !== null && rel !== RECEIPT) fail('FILE_CHANGED', '恢复目标已有新的内容，未覆盖。');
        await atomicCopy(t, journal.safePath(t.game, row.snapshot), destination, check.before, current !== null);
      }
    }
    // All live files are restored before discarding the WAL. Incomplete
    // snapshot/staging cleanup can leave harmless archives, never a false state.
    await fsp.unlink(journal.pendingPath(t.game));
    for (const row of state.files) await fsp.unlink(journal.safePath(t.game, row.snapshot)).catch(() => {});
    await fsp.rmdir(journal.safePath(t.game, state.folder)).catch(() => {});
    return true;
  }
  async function transaction(t, id, operation, checks, work) {
    return journal.transaction(t.game, async () => {
      const manifestRel = '_DLSS5_Backup/manifest.json';
      const original = await digest(journal.safePath(t.game, manifestRel));
      await journal.setOwner(t.game, { version: 1, product: PRODUCT, cleanupId: id, exe: t.exe, operation, pid: process.pid,
        checks: [{ rel: manifestRel, before: original, after: [original] }, ...checks] });
      return work();
    }, { recoverOnError: async () => {
      const state = await pending(t);
      // Before setOwner succeeds, only the journal's initial manifest capture
      // can exist; no environment target has been touched yet.
      return state ? rollback(t, state) : journal.recover(t.game);
    } });
  }
  async function serial(t, work) {
    const lock = key(t.game); if (active.has(lock)) fail('BUSY', '该游戏正在进行环境操作。');
    active.add(lock); try { return await work(); } finally { active.delete(lock); }
  }
  async function apply(id, planId, names) {
    const t = target(id), plan = plans.get(planId); plans.delete(planId);
    return serial(t, async () => {
      await closed(t); await assertReady(id);
      if (!plan || plan.id !== id || plan.exe !== t.exe || plan.expires < Date.now() || !Array.isArray(names) || new Set(names).size !== names.length || !names.length) fail('PLAN_EXPIRED', '清理预览已失效，请重新检查文件。');
      if (await digest(t.exe, 8 * 1024 * 1024 * 1024) !== plan.exeHash) fail('FILE_CHANGED', '游戏 EXE 在预览后改变，请重新检查。');
      const selected = names.map(name => plan.candidates.find(row => row.name === name && row.selectable));
      if (selected.some(row => !row) || selected.reduce((sum, row) => sum + row.bytes, 0) > 256 * 1024 * 1024) fail('SELECTION_INVALID', '所选清理范围无效或过大。');
      if (plan.candidates.some(row => row.mandatory && !names.includes(row.name))) fail('CONFLICT_REQUIRED', '已确认冲突的插件必须一并备份隔离。');
      await assertAddonSnapshot(plan.snapshot, { environment: options.environment || process.env });
      if ((await record(t))?.state === 'isolated') fail('BACKUP_EXISTS', '已有环境隔离备份，未覆盖。');
      const cleanupId = crypto.randomUUID(), next = { version: 1, product: PRODUCT, id: cleanupId, game: t.game, exe: t.exe, state: 'isolated', createdAt: new Date().toISOString(),
        files: selected.map((row, index) => ({ rel: row.rel, sha256: row.sha256, bytes: row.bytes, backup: `${DIRECTORY}/${cleanupId}/${index}.bin` })) };
      for (const row of next.files) if (await digest(journal.safePath(t.game, row.rel)) !== row.sha256) fail('FILE_CHANGED', '预览后文件已改变，请重新检查。');
      const checks = [{ rel: RECEIPT, before: await digest(t.record), after: [jsonHash(next)] }, ...next.files.flatMap(row => [{ rel: row.rel, before: row.sha256, after: [null] }, { rel: row.backup, before: null, after: [row.sha256] }])];
      await transaction(t, cleanupId, 'isolate', checks, async () => {
        await journal.capture(t.game, t.record);
        for (const row of next.files) {
          await closed(t);
          const original = journal.safePath(t.game, row.rel), backup = journal.safePath(t.game, row.backup);
          if (await digest(original) !== row.sha256 || await digest(backup) !== null) fail('FILE_CHANGED', '文件或备份在清理前改变。');
          await journal.capture(t.game, backup); await fsp.mkdir(path.dirname(backup), { recursive: true }); await atomicCopy(t, original, backup, row.sha256);
          if (await digest(backup) !== row.sha256 || await digest(original) !== row.sha256) fail('FILE_CHANGED', '备份验证失败，未隔离原文件。');
          await journal.capture(t.game, original); await fsp.unlink(original);
        }
        await atomicJson(t.record, next);
      });
      return { cleaned: true, files: selected.map(row => row.name), backupDirectory: path.join(t.game, DIRECTORY, cleanupId), cleanGameVerified: false,
        message: '所选组件已备份隔离；未检查游戏本体完整性，不能保证已清除全部模组。' };
    });
  }
  async function restore(id) {
    const t = target(id);
    return serial(t, async () => {
      await closed(t);
      const interrupted = await pending(t);
      if (interrupted) await rollback(t, interrupted);
      const saved = await record(t);
      if (!saved || saved.state !== 'isolated') return { restored: Boolean(interrupted), unchanged: !interrupted };
      const next = { ...saved, state: 'restored', restoredAt: new Date().toISOString() }, checks = [{ rel: RECEIPT, before: await digest(t.record), after: [jsonHash(next)] }];
      for (const row of saved.files) {
        if (await digest(journal.safePath(t.game, row.backup)) !== row.sha256) fail('BACKUP_CHANGED', '环境隔离备份缺失或被修改，未恢复。');
        const current = await digest(journal.safePath(t.game, row.rel));
        if (current !== null && current !== row.sha256) fail('FILE_CHANGED', `${path.basename(row.rel)} 已有新的内容，未覆盖；请先恢复当前安装。`);
        checks.push({ rel: row.rel, before: current, after: [row.sha256] });
      }
      await transaction(t, saved.id, 'restore', checks, async () => {
        await journal.capture(t.game, t.record);
        for (const row of saved.files) {
          await closed(t); const original = journal.safePath(t.game, row.rel), current = await digest(original);
          if (current === row.sha256) continue;
          if (current !== null || await digest(journal.safePath(t.game, row.backup)) !== row.sha256) fail('FILE_CHANGED', '恢复前文件发生变化，未覆盖。');
          await journal.capture(t.game, original); await atomicCopy(t, journal.safePath(t.game, row.backup), original, row.sha256);
          if (await digest(original) !== row.sha256) fail('FILE_CHANGED', '恢复文件校验失败，记录已保留。');
        }
        await atomicJson(t.record, next);
      });
      return { restored: true, files: saved.files.map(row => path.basename(row.rel)), message: '清理前的组件已按原摘要恢复；隔离备份仍保留。' };
    });
  }
  async function recoverPending(id) {
    const t = target(id);
    return serial(t, async () => {
      await closed(t); const state = await pending(t); if (!state) return { recovered: false };
      return { recovered: await rollback(t, state) };
    });
  }
  return Object.freeze({ inspect, remaining, preview, apply, restore, recoverPending, assertReady });
}
module.exports = { createGameEnvironment, PRODUCT, RECEIPT, PROXIES };
