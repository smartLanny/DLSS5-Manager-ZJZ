'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReframeworkCompatibility, REFRAMEWORK_ADAPTERS, OFFICIAL_REFRAMEWORK_01417: OFFICIAL } = require('./reframework-compatibility');
const { readManifest, manifestPath, assertManifestExecutable, validateEntry } = require('./manifest');
const { noLinks, atomicJson } = require('./launch-safety');

const RECEIPT = '_DLSS5_Backup/reframework-preparation.json';
const PRODUCT = 'xiaofeng-reframework-preparation';
const HASH = /^[a-f0-9]{64}$/i, UUID = /^[a-f0-9-]{36}$/i;
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (code, message, details) => { throw Object.assign(new Error(message), { code, details }); };
function localAbsolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') && (process.platform !== 'win32' || /^[a-z]:[\\/][^:]*$/i.test(value)); }
function rel(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || path.isAbsolute(value) || /[\0<>:"|?*]/.test(value)) return null;
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) return null;
  return parts.join('/');
}
function validConfig(bytes) {
  let text;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    if (bytes.length % 2) return false;
    const little = Buffer.from(bytes.subarray(2)); little.swap16(); text = little.toString('utf16le');
  } else text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  return /^\s*\[NRBeforeSR\]\s*(?:[;#].*)?$/mi.test(text);
}

function createReframeworkPreparation(options = {}) {
  const overrides = options.overrides || {};
  const journal = overrides.journal || require('../core/file-journal');
  const guards = overrides.guards || require('../core/install-guards');
  const pe = overrides.pe || require('../core/pe');
  const fileDigest = overrides.fileDigest || digest;
  const copyFile = overrides.copyFile || fsp.copyFile;
  const writeReceipt = overrides.writeReceipt || atomicJson;
  const writeRecoveryMarker = overrides.writeRecoveryMarker || atomicJson;
  const recoveryCopyFile = overrides.recoveryCopyFile || fsp.copyFile;
  const compatibility = createReframeworkCompatibility({ pe, fileDigest });

  async function safe(gameDir, relative) {
    if (!rel(relative)) fail('REF_UNSAFE_PATH', 'REFramework 文件路径无效。');
    const file = journal.safePath(gameDir, relative); await noLinks(file); return file;
  }
  async function stateOf(file, maxBytes = 64 * 1024 * 1024) {
    await noLinks(file);
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > maxBytes) fail('REF_FILE_INVALID', 'REFramework 目标不是安全的普通文件。', { file: path.basename(file) });
      return { exists: true, sha256: fileDigest(file), size: stat.size };
    } catch (error) { if (error.code === 'ENOENT') return { exists: false, sha256: null }; throw error; }
  }
  async function targetOf(input) {
    if (!localAbsolute(input?.gameDir) || !localAbsolute(input?.exe)) fail('REF_BAD_TARGET', '需要本地绝对游戏目录与 EXE。');
    const gameDir = path.resolve(input.gameDir), exe = path.resolve(input.exe);
    const engine = String(input.engine || '').trim().toLowerCase().replace(/[ _-]+/g, '-');
    const adapter = REFRAMEWORK_ADAPTERS.find(row => row.executable.toLowerCase() === path.basename(exe).toLowerCase() && row.engine === engine);
    await noLinks(gameDir); await noLinks(exe);
    let exeStat; try { exeStat = await fsp.lstat(exe); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!same(path.dirname(exe), gameDir) || !adapter || !exeStat?.isFile() || exeStat.nlink > 1 || pe.getBitness(exe) !== 64)
      fail('REF_UNSUPPORTED_TARGET', '只支持已匹配卡普空 RE 引擎配套的根目录 x64 游戏程序。');
    return { gameDir, exe, engine, adapter };
  }
  async function closed(target) {
    await noLinks(target.gameDir); await noLinks(target.exe);
    await guards.assertGameClosed(target.gameDir, target.exe);
  }
  async function journalPaths(target) {
    // The shared journal also captures its legacy manifest automatically.
    for (const file of [RECEIPT, '_DLSS5_Backup/manifest.json', '_DLSS5_Backup/pending-switch.json', '_DLSS5_Backup/pending-switch.json.tmp', '_DLSS5_Backup/.transactions'])
      await safe(target.gameDir, file);
  }
  async function rootOwnership(target) {
    const file = await safe(target.gameDir, path.relative(target.gameDir, manifestPath(target.gameDir)));
    const state = await stateOf(file, 2 * 1024 * 1024);
    if (!state.exists) return null;
    const manifest = readManifest(target.gameDir);
    assertManifestExecutable(target.gameDir, manifest, target.exe);
    if (!localAbsolute(manifest.game.dir) || !same(manifest.game.dir, target.gameDir) || manifest.files.length > 256)
      fail('REF_ROOT_RECEIPT_INVALID', '主安装收据没有绑定当前游戏目录。');
    const rows = new Map();
    for (const row of manifest.files) {
      const relative = rel(row?.rel);
      if (!relative || rows.has(relative.toLowerCase()) || !HASH.test(row.installedSha256 || '')) fail('REF_ROOT_RECEIPT_INVALID', '主安装归属路径或摘要无效。');
      validateEntry(target.gameDir, manifest, row, journal.safePath); await safe(target.gameDir, relative);
      if (row.original.existed) {
        if (!HASH.test(row.original.sha256 || '')) fail('REF_ROOT_RECEIPT_INVALID', '主安装原始备份摘要无效。');
        const backup = await safe(target.gameDir, row.original.backupRel);
        if (row.kind === 'config' || row.kind === 'addon') {
          const actual = await stateOf(backup);
          if (!actual.exists || actual.sha256 !== row.original.sha256.toLowerCase()) fail('REF_ROOT_RECEIPT_INVALID', '参与归属确认的主安装原始备份漂移。');
        }
      }
      rows.set(relative.toLowerCase(), row);
    }
    return { manifest, rows, sha256: state.sha256 };
  }
  async function receiptOf(target) {
    const file = await safe(target.gameDir, RECEIPT), state = await stateOf(file, 128 * 1024);
    if (!state.exists) return null;
    let record; try { record = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { fail('REF_RECEIPT_INVALID', 'REFramework 归属收据无法读取，未清空记录。'); }
    if (record?.version !== 1 || record.product !== PRODUCT || !UUID.test(record.id || '') || record.adapter !== target.adapter.id ||
        !localAbsolute(record.game?.dir) || !same(record.game.dir, target.gameDir) || record.game.exe?.toLowerCase() !== target.adapter.executable.toLowerCase() ||
        record.game.engine !== target.engine || record.game.architecture !== 64 || !Array.isArray(record.mirrors) || record.mirrors.length > 32)
      fail('REF_RECEIPT_INVALID', 'REFramework 归属收据的游戏或组件身份无效。');
    if (record.loader && (record.loader.rel !== OFFICIAL.install_leaf || record.loader.sha256 !== OFFICIAL.dll_sha256 ||
        !['owned', 'external', 'released'].includes(record.loader.ownership) || record.loader.originalExisted !== (record.loader.ownership === 'external')))
      fail('REF_RECEIPT_INVALID', 'REFramework loader 归属记录无效。');
    if (!target.adapter.storage && (record.configSeed != null || record.mirrors.length || record.retiredMirrors?.length))
      fail('REF_RECEIPT_INVALID', '此游戏只使用根目录配置，收据不能声明缓存配置或 Core 镜像。');
    if (record.configSeed && (record.configSeed.rel !== '_storage_/nr_before_sr.ini' || record.configSeed.sourceRel !== 'nr_before_sr.ini' ||
        !HASH.test(record.configSeed.sha256 || '') || !UUID.test(record.configSeed.rootInstallId || '') || record.configSeed.policy !== 'preserve-current'))
      fail('REF_RECEIPT_INVALID', 'REFramework 配置预置归属记录无效。');
    const seen = new Set();
    for (const row of record.mirrors) {
      if (!rel(row?.rootRel) || path.posix.dirname(rel(row.rootRel)) !== '.' || !/\.addon64$/i.test(row.rootRel) ||
          rel(row.mirrorRel)?.toLowerCase() !== `_storage_/${row.rootRel.toLowerCase()}` || !HASH.test(row.sha256 || '') ||
          !HASH.test(row.baselineSha256 || '') || !UUID.test(row.rootInstallId || '') || seen.has(row.mirrorRel.toLowerCase()) ||
          row.confirmed !== true || row.baselineRel !== `_DLSS5_Backup/reframework-mirrors/${record.id}/${row.rootRel.toLowerCase()}.bin`)
        fail('REF_RECEIPT_INVALID', 'Core 镜像没有独立有效的确认收据。');
      seen.add(row.mirrorRel.toLowerCase()); await safe(target.gameDir, row.mirrorRel); await safe(target.gameDir, row.baselineRel);
    }
    return { record, sha256: state.sha256 };
  }
  function fresh(target) { return { version: 1, product: PRODUCT, id: crypto.randomUUID(), adapter: target.adapter.id,
    game: { dir: target.gameDir, exe: target.adapter.executable, engine: target.engine, architecture: 64 }, loader: null, configSeed: null, mirrors: [] }; }
  async function persist(target, record) {
    const file = await safe(target.gameDir, RECEIPT); await journal.capture(target.gameDir, file); await writeReceipt(file, record);
  }
  async function copyCaptured(target, source, dest) {
    await journal.capture(target.gameDir, dest);
    const pendingFile = journal.pendingPath(target.gameDir);
    await noLinks(pendingFile); const token = await fsp.readFile(pendingFile);
    let captured; try { captured = JSON.parse(token.toString('utf8')); } catch { fail('REF_RECOVERY_INVALID', '共享事务记录无法读取。'); }
    const relative = rel(path.relative(target.gameDir, dest));
    const index = captured.files?.findIndex(row => rel(row.rel)?.toLowerCase() === relative.toLowerCase());
    if (captured.version !== 1 || !/^_DLSS5_Backup\/\.transactions\/[a-f0-9-]{36}$/i.test(captured.folder || '') ||
        !Number.isInteger(index) || index < 0 || captured.files[index].snapshot !== `${captured.folder}/${index}.bin` ||
        !captured.files.some(row => rel(row.rel)?.toLowerCase() === RECEIPT.toLowerCase()))
      fail('REF_RECOVERY_INVALID', '复制目标没有属于同一 REFramework 事务的快照记录。');
    try { await copyFile(source, dest, fs.constants.COPYFILE_EXCL); }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      try {
        await noLinks(pendingFile);
        if (!(await fsp.readFile(pendingFile)).equals(token)) fail('REF_RECOVERY_CHANGED', '出现目标冲突时共享事务身份已改变。');
        const row = captured.files[index];
        if (!row.existed) {
          await stateOf(dest); const currentHash = digest(dest);
          const snapshot = await safe(target.gameDir, row.snapshot);
          if (fs.existsSync(snapshot)) fail('REF_RECOVERY_CHANGED', '未创建目标的快照编号已被占用。');
          // Rebase only this conclusively external EEXIST target inside the SAME
          // WAL. Mark existed first: a failed snapshot must make recover's
          // preflight fail, instead of deleting an unowned newly created file.
          row.existed = true; row.reframeworkPreservedSha256 = currentHash;
          await writeRecoveryMarker(pendingFile, captured);
          await noLinks(pendingFile);
          if (JSON.stringify(JSON.parse(await fsp.readFile(pendingFile, 'utf8'))) !== JSON.stringify(captured))
            fail('REF_RECOVERY_CHANGED', '外部目标保护标记没有正确读回。');
          await fsp.mkdir(path.dirname(snapshot), { recursive: true }); await noLinks(dest); await noLinks(snapshot);
          await recoveryCopyFile(dest, snapshot, fs.constants.COPYFILE_EXCL);
          if (digest(snapshot) !== currentHash || digest(dest) !== currentHash)
            fail('REF_RECOVERY_CHANGED', '外部目标在保护快照期间改变。');
        }
      } catch (recoveryError) {
        throw Object.assign(new Error('无法安全保护新出现的外部文件；文件和共享恢复日志已保留，请提交反馈。'), {
          code: 'REF_RECOVERY_PROTECTION_FAILED', preservePending: true, cause: recoveryError, details: { file: relative, needsRecovery: true }
        });
      }
      fail('REF_TARGET_APPEARED', '目标文件在复制前由外部创建，已保留并回滚本次其他写入。', { file: relative });
    }
  }
  async function inspect(input) {
    const target = await targetOf(input), hasStorage = Boolean(target.adapter.storage);
    const ownership = hasStorage ? await rootOwnership(target) : null, prior = await receiptOf(target);
    const rootConfig = await safe(target.gameDir, 'nr_before_sr.ini');
    const storageConfig = hasStorage ? await safe(target.gameDir, '_storage_/nr_before_sr.ini') : null;
    const root = hasStorage ? await stateOf(rootConfig, 64 * 1024) : { exists: false };
    const stored = hasStorage ? await stateOf(storageConfig, 64 * 1024) : { exists: false };
    const configOwner = ownership?.rows.get('nr_before_sr.ini');
    const ownsRoot = configOwner?.kind === 'config';
    // The immutable ownership proof comes from the main receipt. A mutable INI
    // is intentionally checked against its CURRENT bytes, not installedSha256.
    const managedFiles = ownsRoot && root.exists ? [{ rel: 'nr_before_sr.ini', sha256: root.sha256, role: 'nr-config' }] : [];
    const view = compatibility.inspect({ ...input, gameDir: target.gameDir, exe: target.exe,
      componentRoot: input.componentRoot || options.componentRoot, managedFiles });
    if (!view.matched) fail('REF_UNSUPPORTED_TARGET', view.reason);
    const ignored = new Set(['REF_EXISTING_FRAMEWORK', 'REF_STORAGE_REVIEW_REQUIRED', 'REF_STORAGE_OWNED_DRIFT', 'REF_MANAGED_FILE_CHANGED',
      'REF_ROOT_CONFIG_INVALID', 'REF_STORAGE_CONFIG_INVALID', 'REF_CONFIG_OWNERSHIP_REQUIRED']);
    const blockers = view.blockers.filter(row => !ignored.has(row.code));
    let seed = null;
    if (stored.exists) {
      if (!validConfig(await fsp.readFile(storageConfig))) blockers.push({ code: 'REF_STORAGE_CONFIG_INVALID', message: '现有 _storage_ 配置无效，已保留原件，不会覆盖。' });
    } else if (root.exists) {
      if (!ownsRoot) blockers.push({ code: 'REF_CONFIG_OWNERSHIP_REQUIRED', message: '缺少有效主收据确认 root INI 归属，未预置配置。' });
      else if (!validConfig(await fsp.readFile(rootConfig))) blockers.push({ code: 'REF_ROOT_CONFIG_INVALID', message: 'root INI 缺少有效 NRBeforeSR 配置段，未预置。' });
      else seed = { source: rootConfig, target: storageConfig, sha256: root.sha256, rootInstallId: ownership.manifest.installId };
    }
    const loader = await stateOf(await safe(target.gameDir, OFFICIAL.install_leaf));
    if (prior?.record.loader?.ownership === 'owned' && loader.exists && loader.sha256 !== OFFICIAL.dll_sha256)
      blockers.push({ code: 'REF_LOADER_CHANGED', message: '本工具拥有的 loader 已变化，未覆盖或删除。' });
    const loaderOwnership = loader.exists ? prior?.record.loader?.ownership === 'owned' ? 'owned' : 'external' : 'absent';
    return { matched: true, canPrepare: blockers.length === 0, ready: blockers.length === 0 && loader.exists,
      target, source: view.component.file, component: view.component, loader: { ...loader, ownership: loaderOwnership },
      config: { effective: !hasStorage ? rootConfig : stored.exists ? storageConfig : seed ? storageConfig : null, seed, existingStoragePreferred: stored.exists },
      rootReceiptSha256: ownership?.sha256 || null, receiptSha256: prior?.sha256 || null, record: prior?.record || null,
      warnings: view.blockers.filter(row => ignored.has(row.code) && !/CONFIG/.test(row.code)), blockers,
      mirrors: prior?.record.mirrors || [], gameRuntimeVerified: false };
  }
  function assertReady(view) { if (view.blockers.length) fail(view.blockers[0].code, view.blockers[0].message, { blockers: view.blockers }); }
  async function prepare(input) {
    const initial = await inspect(input); assertReady(initial); await closed(initial.target); await journalPaths(initial.target);
    return journal.transaction(initial.target.gameDir, async () => {
      await journal.capture(initial.target.gameDir, await safe(initial.target.gameDir, RECEIPT));
      const current = await inspect(input); assertReady(current);
      if (current.receiptSha256 !== initial.receiptSha256 || current.rootReceiptSha256 !== initial.rootReceiptSha256)
        fail('REF_STATE_CHANGED', '游戏或 REFramework 归属记录已改变，请重新检查。');
      const record = current.record || fresh(current.target);
      if (!current.loader.exists) {
        await closed(current.target);
        const checked = await inspect(input); assertReady(checked);
        if (checked.loader.exists || checked.source !== current.source) fail('REF_STATE_CHANGED', '复制前 loader 状态已改变。');
        const dest = await safe(current.target.gameDir, OFFICIAL.install_leaf); await noLinks(current.source);
        if (fileDigest(current.source) !== OFFICIAL.dll_sha256) fail('REF_COMPONENT_HASH', '复制前官方 loader 来源摘要已改变。');
        await copyCaptured(current.target, current.source, dest);
        const written = await stateOf(dest);
        if (written.sha256 !== OFFICIAL.dll_sha256 || written.size !== OFFICIAL.dll_bytes) fail('REF_COPY_VERIFY', 'loader 写入后读回不一致。');
        record.loader = { rel: OFFICIAL.install_leaf, sha256: OFFICIAL.dll_sha256, ownership: 'owned', originalExisted: false };
      } else record.loader = { rel: OFFICIAL.install_leaf, sha256: OFFICIAL.dll_sha256,
        ownership: current.loader.ownership, originalExisted: current.loader.ownership === 'external' };
      if (current.config.seed) {
        const seed = current.config.seed; await closed(current.target);
        const ownership = await rootOwnership(current.target);
        if (ownership?.sha256 !== current.rootReceiptSha256 || !(ownership?.rows.get('nr_before_sr.ini')?.kind === 'config'))
          fail('REF_STATE_CHANGED', '预置前 root 配置归属已改变。');
        const source = await safe(current.target.gameDir, 'nr_before_sr.ini'), dest = await safe(current.target.gameDir, '_storage_/nr_before_sr.ini');
        if ((await stateOf(dest, 64 * 1024)).exists || fileDigest(source) !== seed.sha256) fail('REF_STATE_CHANGED', '预置前配置字节或有效目录已改变。');
        await journal.capture(current.target.gameDir, dest); await fsp.mkdir(path.dirname(dest), { recursive: true }); await noLinks(dest);
        await copyCaptured(current.target, source, dest);
        if (fileDigest(dest) !== seed.sha256) fail('REF_COPY_VERIFY', '配置预置后读回不一致。');
        record.configSeed = { rel: '_storage_/nr_before_sr.ini', sourceRel: 'nr_before_sr.ini', sha256: seed.sha256,
          rootInstallId: seed.rootInstallId, policy: 'preserve-current' };
      }
      record.preparedAt = new Date().toISOString(); await persist(current.target, record);
      return { prepared: true, loaderOwnership: record.loader.ownership, loaderReadbackVerified: true,
        seededConfig: Boolean(current.config.seed), effectiveConfig: current.config.effective,
        warnings: current.warnings, gameRuntimeVerified: false };
    });
  }
  async function restore(input) {
    const target = await targetOf(input), prior = await receiptOf(target); await closed(target); await journalPaths(target);
    if (!prior) return { restored: false, unchanged: true, configurationPreserved: true };
    return journal.transaction(target.gameDir, async () => {
      await journal.capture(target.gameDir, await safe(target.gameDir, RECEIPT));
      const current = await receiptOf(target);
      if (!current || current.sha256 !== prior.sha256) fail('REF_STATE_CHANGED', '恢复前归属记录已改变。');
      const record = current.record, loader = record.loader;
      let removedLoader = false;
      if (loader?.ownership === 'owned') {
        await closed(target); const file = await safe(target.gameDir, loader.rel), actual = await stateOf(file);
        if (actual.exists && actual.sha256 !== loader.sha256) fail('REF_LOADER_CHANGED', 'loader 已被外部修改；收据、当前文件与配置均保留。');
        if (actual.exists) { await journal.capture(target.gameDir, file); await noLinks(file);
          if (fileDigest(file) !== loader.sha256) fail('REF_LOADER_CHANGED', '删除前 loader 摘要发生变化。');
          await fsp.unlink(file); removedLoader = true; }
        record.loader = { ...loader, ownership: 'released' };
      }
      // No config or mirror is a loader-uninstall target. Keep its independent
      // receipt so the original installer can later restore Core in one journal.
      record.restoredAt = new Date().toISOString(); await persist(target, record);
      return { restored: true, removedLoader, externalLoaderPreserved: loader?.ownership === 'external',
        configurationPreserved: true, mirrorsPreserved: record.mirrors.length, gameRuntimeVerified: false };
    });
  }
  async function recover(input) {
    const target = await targetOf(input); await closed(target); await journalPaths(target);
    const file = journal.pendingPath(target.gameDir), exists = await stateOf(file, 2 * 1024 * 1024);
    if (!exists.exists) return { recovered: false };
    let pending; try { pending = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { fail('REF_RECOVERY_INVALID', '共享恢复日志损坏，已保留。'); }
    const allowed = new Set([RECEIPT.toLowerCase(), '_dlss5_backup/manifest.json', 'dinput8.dll']);
    if (target.adapter.storage) allowed.add('_storage_/nr_before_sr.ini');
    if (!Array.isArray(pending.files) || !pending.files.some(row => rel(row.rel)?.toLowerCase() === RECEIPT.toLowerCase()) ||
        pending.files.some(row => !allowed.has(rel(row.rel)?.toLowerCase())))
      fail('REF_RECOVERY_OTHER_TRANSACTION', '未完成日志不属于本 REFramework 操作，请由原安装器恢复。');
    for (const row of pending.files) {
      const actual = await safe(target.gameDir, row.rel), snapshot = await safe(target.gameDir, row.snapshot);
      // A failed protection marker may leave existed=false. Current presence
      // does not prove we created it, even if a loader happens to have our hash.
      if (row.existed === false && fs.existsSync(actual))
        fail('REF_RECOVERY_TARGET_UNCONFIRMED', '未能确认新目标归属，恢复不会删除它；请保留日志并提交反馈。', { file: row.rel });
      if (row.reframeworkPreservedSha256 !== undefined && (!HASH.test(row.reframeworkPreservedSha256) || !fs.existsSync(actual) ||
          !fs.existsSync(snapshot) || digest(actual) !== row.reframeworkPreservedSha256 || digest(snapshot) !== row.reframeworkPreservedSha256))
        fail('REF_RECOVERY_PROTECTION_FAILED', '外部文件保护快照不完整或已改变，恢复已停止。', { file: row.rel });
    }
    return { recovered: await journal.recover(target.gameDir), gameRuntimeVerified: false };
  }
  async function confirmMirrors(input, request = {}) {
    if (request.confirm !== true || !Array.isArray(request.mirrors) || request.mirrors.length < 1 || request.mirrors.length > 32)
      fail('REF_MIRROR_CONFIRM_REQUIRED', 'Core 镜像必须逐项明确确认归属及当前摘要。');
    const target = await targetOf(input);
    if (!target.adapter.storage) fail('REF_MIRROR_UNSUPPORTED', '此游戏使用根目录配置，不确认或操作缓存 Core 镜像。');
    await closed(target); await journalPaths(target);
    return journal.transaction(target.gameDir, async () => {
      await journal.capture(target.gameDir, await safe(target.gameDir, RECEIPT));
      const ownership = await rootOwnership(target), prior = await receiptOf(target), record = prior?.record || fresh(target);
      if (!ownership) fail('REF_ROOT_RECEIPT_REQUIRED', '确认 Core 镜像需要有效主安装收据。');
      const loader = await stateOf(await safe(target.gameDir, OFFICIAL.install_leaf));
      if (loader.sha256 !== OFFICIAL.dll_sha256) fail('REF_COMPONENT_HASH', '确认镜像前必须有固定官方 REFramework loader。');
      const requested = new Set();
      for (const row of request.mirrors) {
        const rootRel = rel(row?.rootRel), mirrorRel = rel(row?.mirrorRel), root = ownership.rows.get(rootRel?.toLowerCase());
        if (!rootRel || path.posix.dirname(rootRel) !== '.' || !/\.addon64$/i.test(rootRel) || root?.kind !== 'addon' ||
            mirrorRel?.toLowerCase() !== `_storage_/${rootRel.toLowerCase()}` || !HASH.test(row.sha256 || '') || requested.has(mirrorRel.toLowerCase()))
          fail('REF_MIRROR_CONFIRM_REQUIRED', '镜像必须绑定主收据里的根目录 Core addon64。');
        requested.add(mirrorRel.toLowerCase()); await closed(target);
        const rootState = await stateOf(await safe(target.gameDir, rootRel)), mirror = await stateOf(await safe(target.gameDir, mirrorRel));
        const hash = row.sha256.toLowerCase();
        if (rootState.sha256 !== root.installedSha256.toLowerCase() || mirror.sha256 !== hash || hash !== rootState.sha256)
          fail('REF_MIRROR_CHANGED', '确认的 root/mirror 必须分别读回且匹配同一已拥有 Core。');
        const existing = record.mirrors.find(item => item.mirrorRel.toLowerCase() === mirrorRel.toLowerCase());
        if (existing && (existing.sha256 !== hash || existing.rootInstallId !== ownership.manifest.installId)) fail('REF_MIRROR_CHANGED', '已有镜像收据不能通过再次确认重置基线。');
        if (!existing) record.mirrors.push({ rootRel, mirrorRel, sha256: hash, baselineSha256: hash,
          baselineRel: `_DLSS5_Backup/reframework-mirrors/${record.id}/${rootRel.toLowerCase()}.bin`,
          rootInstallId: ownership.manifest.installId, confirmed: true, confirmedAt: new Date().toISOString() });
      }
      if ((await rootOwnership(target)).sha256 !== ownership.sha256) fail('REF_STATE_CHANGED', '确认期间主安装收据已改变。');
      await persist(target, record); return { confirmed: true, mirrors: record.mirrors, coreFilesWritten: false };
    });
  }
  async function planMirrors(input, request = {}) {
    const target = await targetOf(input);
    if (!target.adapter.storage) fail('REF_MIRROR_UNSUPPORTED', '此游戏使用根目录配置，不确认或操作缓存 Core 镜像。');
    const ownership = await rootOwnership(target), prior = await receiptOf(target);
    if (!ownership || !prior || !Array.isArray(request.files) || request.files.length < 1 || request.files.length > 32 || !['replace', 'restore'].includes(request.operation))
      fail('REF_MIRROR_PLAN_REQUIRED', '镜像计划需要有效 root/独立 mirror 收据和明确的逐文件操作。');
    const next = structuredClone(prior.record), operations = [], seen = new Set();
    for (const desired of request.files) {
      const rootRel = rel(desired?.rootRel), root = ownership.rows.get(rootRel?.toLowerCase());
      const mirror = next.mirrors.find(row => row.rootRel.toLowerCase() === rootRel?.toLowerCase());
      if (!rootRel || !HASH.test(desired.sha256 || '') || !mirror || root?.kind !== 'addon' || mirror.rootInstallId !== ownership.manifest.installId || seen.has(rootRel.toLowerCase()))
        fail('REF_MIRROR_UNOWNED', '未知镜像或新主收据不能仅凭同名/root 最新摘要被接管。');
      seen.add(rootRel.toLowerCase());
      const rootState = await stateOf(await safe(target.gameDir, rootRel)), mirrorState = await stateOf(await safe(target.gameDir, mirror.mirrorRel));
      if (rootState.sha256 !== root.installedSha256.toLowerCase() || mirrorState.sha256 !== mirror.sha256)
        fail('REF_MIRROR_CHANGED', 'root 或已确认 mirror 漂移，不会提出替换/恢复。');
      const backup = await stateOf(await safe(target.gameDir, mirror.baselineRel));
      if (backup.exists && backup.sha256 !== mirror.baselineSha256) fail('REF_MIRROR_BACKUP_CHANGED', '镜像原始归档漂移，不能用于恢复。');
      const sha256 = desired.sha256.toLowerCase();
      if (request.operation === 'restore' && (!backup.exists || sha256 !== mirror.baselineSha256))
        fail('REF_MIRROR_RESTORE_UNAVAILABLE', '只有原安装事务已保存且读回正确的镜像基线可用于恢复。');
      const archive = !backup.exists ? { sourceRel: mirror.mirrorRel, targetRel: mirror.baselineRel, sha256: mirror.baselineSha256 } : null;
      if (archive && mirror.sha256 !== mirror.baselineSha256) fail('REF_MIRROR_RESTORE_UNAVAILABLE', '镜像已经升级但原始基线缺失。');
      operations.push({ kind: request.operation === 'restore' ? 'restore-core-mirror' : 'replace-core-mirror', rootRel,
        mirrorRel: mirror.mirrorRel, expectedRootSha256: rootState.sha256, expectedMirrorSha256: mirror.sha256, sha256,
        sourceRel: request.operation === 'restore' ? mirror.baselineRel : rootRel, archive });
      mirror.sha256 = sha256;
    }
    return { readonly: true, requiresGameClosed: true, requiresSameTransactionAsRoot: true, writesRegistry: false,
      rootReceiptSha256: ownership.sha256, receiptRel: RECEIPT, receiptBeforeSha256: prior.sha256, receiptNext: next, operations,
      configurationPolicy: 'preserve both root and storage bytes', coreFilesWritten: false };
  }
  return Object.freeze({ inspect, prepare, restore, recover, confirmMirrors, planMirrors, receiptRel: RECEIPT });
}

module.exports = { createReframeworkPreparation, RECEIPT };
