'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicJson, noLinks, digestFile } = require('./launch-safety');
const { validateOperationRequest: validateRequest } = require('./operation-plan');
const ACTIVE = new Set(['waiting-game', 'ready']);
const STATUSES = new Set([...ACTIVE, 'applying', 'attention', 'recovery-required', 'complete', 'changed', 'cancelled']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function createDeferredOperations({ userData, service, operations, assertClosed, run, beforeApply = async () => {}, emit = () => {} }) {
  const root = path.join(userData, 'waiting-operations');
  let timer = null, polling = false;
  const inFlight = new Set();
  const waitingPlans = new Map();
  const checking = new Set();
  const target = id => {
    const game = path.resolve(service.gameDirectory(id)), exe = path.resolve(service.gameExecutable(id));
    return { game, exe, key: hash(game.toLowerCase()) };
  };
  const fileFor = t => path.join(root, t.key + '.json');
  const seal = row => hash({ gameId: row.gameId, target: row.target, request: row.request, before: row.before, consent: row.consent,
    ...(row.schema === 2 ? { status: row.status, preparation: row.preparation, recovery: row.recovery, draftBackup: row.draftBackup } : {}) });
  async function read(t) {
    const file = fileFor(t); await noLinks(file);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) fail('WAITING_RECORD', '待应用记录无效，未执行。');
      const row = JSON.parse(await fs.readFile(file, 'utf8'));
      if (![1, 2].includes(row.schema) || !STATUSES.has(row.status) || row.seal !== seal(row) || row.target.key !== t.key ||
          row.target.exe.toLowerCase() !== t.exe.toLowerCase()) fail('WAITING_TARGET', '待应用记录对应的程序已改变，未执行。');
      validateRequest(row.request);
      return row;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function snapshot(id, t) {
    const layout = service.getLayout(id);
    const nr = typeof service.readNrSettings === 'function' ? await service.readNrSettings(id).catch(error => {
      if (error.code === 'ERR_NOT_INSTALLED') return null; throw error;
    }) : null;
    const files = [...new Set([layout.activeConfigPath,
      nr?.file || path.join(layout.nrConfigDir || layout.runtimeDir || path.dirname(t.exe), 'nr_before_sr.ini'),
      path.join(path.dirname(t.exe), 'dlssg_sm86.ini'),
      path.join(t.game, '_DLSS5_Backup', 'xiaofeng-manager.json'),
      path.join(t.game, '_DLSS5_Backup', 'xiaofeng-external.json'),
      path.join(t.game, '_DLSS5_Backup', 'xiaofeng-fg-sm86.json'),
      path.join(t.game, '_DLSS5_Backup', 'xiaofeng-launch-settings.json')].filter(Boolean))];
    const identities = [];
    for (const file of files) identities.push({ file, sha256: await digestFile(file) });
    return { exeSha256: await digestFile(t.exe), identities, layout: {
      mode: layout.mode, source: layout.source, generation: layout.generation, version: layout.version,
      runtimeDir: layout.runtimeDir, bindingId: layout.bindingId } };
  }
  async function save(t, row) {
    row.schema = 2;
    row.updatedAt = new Date().toISOString(); row.seal = seal(row);
    await atomicJson(fileFor(t), row); emit({ gameId: row.gameId, status: row.status, message: row.message });
    return row;
  }
  function publicState(row) {
    return row ? { status: row.status, pending: ACTIVE.has(row.status) || row.status === 'applying', message: row.message,
      acceptedAt: row.acceptedAt, request: row.request, draftBackup: row.draftBackup || null,
      recovery: row.recovery || null, requiresReview: ['attention', 'recovery-required', 'changed'].includes(row.status) } : null;
  }
  async function interrupted(t, row) {
    if (!row || !['applying', 'recovery-required'].includes(row.status) || inFlight.has(t.key)) return row;
    row.draftBackup = row.request;
    try {
      const operation = await operations.inspect?.(row.gameId);
      const deployment = operation?.pending ? null : await service.inspectDeployment?.(row.gameId);
      const required = Boolean(operation?.pending || deployment?.pending || deployment?.needsRecovery);
      if (row.status === 'recovery-required' && required) return row;
      row.status = required ? 'recovery-required' : 'attention';
      row.recovery = { required, kind: operation?.pending ? 'operation' : required ? 'deployment' : 'inspect-current-state' };
      row.message = required ? '上次应用被中断，请在高级与维护中恢复未完成操作；原选择已保留，恢复后重新核对。'
        : '上次应用被中断，当前没有未完成事务记录。请重新检查实际配置；原选择已保留，未自动重复应用。';
    } catch (error) {
      row.status = 'attention'; row.recovery = { required: null, kind: 'inspect-current-state', code: error.code || 'WAITING_RECOVERY_INSPECTION' };
      row.message = `上次应用被中断，恢复状态暂时无法确认：${error.message}。原选择已保留，未自动重复应用。`;
    }
    return save(t, row);
  }
  async function inspect(id) {
    const t = target(id), row = await read(t);
    if (!['applying', 'recovery-required'].includes(row?.status) || inFlight.has(t.key)) return publicState(row);
    return run(t.game, async () => publicState(await interrupted(t, await read(t))));
  }
  function attention(plan, request, consent) {
    const choices = (plan.deployment?.addonCompatibility?.decisions || []).some(row =>
      row.moduleMayLoad && !row.mandatory && !['core', 'native-carrier'].includes(row.classification) && row.action === 'isolate' && !request.addonKeep);
    return Boolean(plan.blockers?.length || choices && !plan.nrConflicts?.required || plan.deployment?.requiresAntiCheat && !consent.allowAntiCheat ||
      plan.requiresAdoptionConfirmation && consent.adoptionFingerprint !== plan.adoption?.fingerprint ||
      plan.nrConflicts?.required && consent.nrConflictFingerprint !== nrConflictFingerprint(plan));
  }
  function nrConflictFingerprint(plan) {
    if (!plan.nrConflicts?.required) return null;
    // A queued consent covers the reviewed identities, never just a filename.
    // Operation IDs may change when re-previewed after exit, so bind the actual
    // conflict files and their before/after hashes instead of the transient ID.
    const paths = new Set(plan.nrConflicts.files.map(row => path.resolve(row.path).toLowerCase()));
    const compatibility = plan.deployment?.addonCompatibility;
    return hash({ conflicts: plan.nrConflicts,
      changes: (plan.changes || []).filter(row => row.path && paths.has(path.resolve(row.path).toLowerCase())),
      sourceFingerprint: compatibility?.sourceFingerprint || null, configFingerprint: compatibility?.configFingerprint || null });
  }
  async function execute(id, request, consent) {
    await beforeApply(id);
    const plan = await operations.preview(id, request);
    if (attention(plan, request, consent)) {
      return { needsAttention: true, plan, notice: '请处理本次列出的冲突或确认项。' };
    }
    const result = await operations.apply(plan.planId, { confirm: true, fingerprint: plan.fingerprint,
      allowAntiCheat: consent.allowAntiCheat === true });
    return { ...result, notice: result.notice || '配置已应用。' };
  }
  async function submit(id, input, consent = {}) {
    if (!consent || typeof consent !== 'object' || Array.isArray(consent) || Object.keys(consent).some(k => k !== 'allowAntiCheat') ||
      consent.allowAntiCheat !== undefined && typeof consent.allowAntiCheat !== 'boolean') fail('WAITING_INPUT', '应用选项无效。');
    const request = validateRequest(input), t = target(id);
    return run(t.game, async () => {
      const old = await interrupted(t, await read(t));
      if (old?.status === 'recovery-required') fail('WAITING_RECOVERY_REQUIRED', old.message);
      if (old && ACTIVE.has(old.status)) return { waiting: true, ...publicState(old), notice: '已有待应用操作，可取消后重新选择。' };
      try { await assertClosed(id); }
      catch (e) {
        if (e.code !== 'errGameRunning') throw e;
        if (request.uninstall || request.repair) throw e;
        const before = await snapshot(id, t);
        const preparation = await (operations.prepareForWaiting ? operations.prepareForWaiting(id, request) : operations.preview(id, request));
        if (preparation.requiresAdoptionConfirmation || preparation.nrConflicts?.required) {
          const plan = await operations.preview(id, request, { readOnlyWhileRunning: true });
          plan.waitingConfirmation = true;
          waitingPlans.set(plan.planId, { id, plan, before, expires: Date.now() + 10 * 60000 });
          return { needsAttention: true, plan, notice: '请先核对旧安装及插件隔离；确认后等待游戏退出再应用，完成后不会自动启动。' };
        }
        if (attention(preparation, request, consent)) return { needsAttention: true, plan: preparation, notice: '所需组件或确认项尚未准备完成，未加入等待队列。' };
        const changed = hash(before) !== hash(await snapshot(id, t));
        const row = { schema: 2, gameId: id, target: t, request, consent: { allowAntiCheat: consent.allowAntiCheat === true },
          before, preparation: { verifiedAt: new Date().toISOString(), identity: preparation.fingerprint || preparation.identity || null },
          status: changed ? 'changed' : 'waiting-game', acceptedAt: new Date().toISOString(),
          message: '已保留本次选择，等待游戏退出后重新检查并应用。' };
        if (changed) { row.draftBackup = request; row.message = '检查组件期间游戏配置已变化，已采用外部状态；原选择保留为备份，未加入等待队列。'; }
        await save(t, row);
        return { waiting: !changed, ...publicState(row), notice: row.message };
      }
      return execute(id, request, consent);
    });
  }
  async function assertNoWaiting(id) {
    // Launch callers may already own the directory queue. This read-only gate
    // never enters it recursively or rewrites an interrupted operation.
    const row = await read(target(id));
    if (row && (ACTIVE.has(row.status) || row.status === 'applying'))
      fail('WAITING_OPERATION_PENDING', '当前游戏还有待应用操作，请先取消等待或等应用完成，再单独启动。');
    if (row?.status === 'recovery-required') fail('WAITING_RECOVERY_REQUIRED', '请先恢复未完成的操作，再启动游戏。');
    return publicState(row);
  }
  async function apply(id, planId, consent = {}) {
    const saved = waitingPlans.get(planId);
    if (!saved) return run(target(id).game, async () => {
      const plan = await operations.loadPlan(planId, consent.fingerprint);
      if (plan.gameId !== id) fail('WAITING_TARGET', '该操作预览属于另一个游戏。');
      await beforeApply(id);
      return operations.apply(plan.planId, consent);
    });
    if (saved.id !== id || saved.expires < Date.now() || consent.confirm !== true || consent.fingerprint !== saved.plan.fingerprint)
      fail('WAITING_CONFIRM', '待应用接管确认已过期或身份不符，请重新预览。');
    const t = target(id);
    return run(t.game, async () => {
      const old = await interrupted(t, await read(t));
      if (old && (ACTIVE.has(old.status) || old.status === 'applying' || old.status === 'recovery-required'))
        fail('WAITING_PENDING', '已有待执行或待恢复操作，请先处理后重新确认。');
      const before = await snapshot(id, t);
      if (hash(before) !== hash(saved.before)) fail('WAITING_CHANGED', '游戏或配置已在确认前改变，请重新预览。');
      const fresh = await operations.preview(id, saved.plan.request, { readOnlyWhileRunning: true });
      const confirmed = { allowAntiCheat: consent.allowAntiCheat === true, adoptionFingerprint: saved.plan.adoption?.fingerprint,
        nrConflictFingerprint: nrConflictFingerprint(saved.plan) };
      if (fresh.fingerprint !== saved.plan.fingerprint || attention(fresh, fresh.request, confirmed))
        fail('WAITING_CHANGED', '旧安装、来源或确认项已经改变，请重新预览。');
      let running = false;
      try { await assertClosed(id); } catch (error) { if (error.code !== 'errGameRunning') throw error; running = true; }
      waitingPlans.delete(planId);
      if (!running) { await beforeApply(id); return operations.apply(fresh.planId, { ...consent, fingerprint: fresh.fingerprint }); }
      const row = { schema: 2, gameId: id, target: t, request: fresh.request, consent: confirmed, before,
        preparation: { verifiedAt: new Date().toISOString(), identity: fresh.fingerprint }, status: 'waiting-game',
        acceptedAt: new Date().toISOString(), message: '已确认备份接管，等待游戏退出后重新检查并应用；不会自动启动。' };
      await save(t, row);
      return { waiting: true, ...publicState(row), notice: row.message };
    });
  }
  async function cancel(id) {
    const t = target(id);
    return run(t.game, async () => {
      const row = await read(t);
      if (row && ACTIVE.has(row.status)) { row.status = 'cancelled'; row.message = '已取消待应用操作，游戏文件未改动。'; await save(t, row); }
      return publicState(row);
    });
  }
  async function cancelWithinQueue(id) {
    // The caller already owns this game's write queue. Use its directory, not
    // a readable EXE/valid recovery record, so metadata removal stays reachable.
    const game = path.resolve(service.gameDirectory(id)), key = hash(game.toLowerCase());
    if (inFlight.has(key)) fail('WAITING_OPERATION_ACTIVE', '当前游戏仍在写入，请等待本次操作结束后再移出或恢复。');
    const file = fileFor({ key }); await noLinks(file);
    let archiveFile = null;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) fail('WAITING_RECORD', '待应用记录不是普通文件，未取消。');
      archiveFile = path.join(root, 'cancelled', key + '-' + crypto.randomUUID() + '.json');
      await noLinks(archiveFile); await fs.mkdir(path.dirname(archiveFile), { recursive: true });
      // Preserve even a damaged or interrupted record byte-for-byte; the poller
      // only reads direct children of root, so it can never replay this archive.
      await fs.rename(file, archiveFile);
    } catch (error) { if (error.code !== 'ENOENT') throw error; archiveFile = null; }
    for (const [planId, saved] of waitingPlans) if (saved.id === id) waitingPlans.delete(planId);
    const result = { cancelled: true, archiveFile, gameFilesChanged: false };
    emit({ gameId: id, status: 'cancelled', message: '已取消等待应用，原记录已保留；游戏文件未改动。' });
    return result;
  }
  async function tick() {
    if (polling) return; polling = true;
    let tasks = [];
    try {
      await noLinks(root);
      const names = await fs.readdir(root).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
      tasks = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async name => {
        let seed, checkingKey;
        try {
          const file = path.join(root, name); await noLinks(file);
          if ((await fs.stat(file)).size > 1024 * 1024) return;
          seed = JSON.parse(await fs.readFile(file, 'utf8'));
          if (!ACTIVE.has(seed.status) && seed.status !== 'applying') return;
          const t = target(seed.gameId);
          if (fileFor(t) !== file) return;
          if (checking.has(t.key)) return;
          checking.add(t.key); checkingKey = t.key;
          await run(t.game, async () => {
            let row = await read(t);
            if (row?.status === 'applying') { await interrupted(t, row); return; }
            if (!row || !ACTIVE.has(row.status)) return;
            const current = await snapshot(row.gameId, t);
            if (hash(current) !== hash(row.before)) {
              row.status = 'changed'; row.draftBackup = row.request;
              row.message = '游戏或配置已在外部改变，已采用外部状态；原待应用选择保留为备份，请重新核对。';
              await save(t, row); return;
            }
            try { await assertClosed(row.gameId); }
            catch (e) { if (e.code === 'errGameRunning') return; throw e; }
            // Persist a non-repeating state before any writes. The existing
            // operation journal owns recovery after the first actual write.
            row.status = 'applying'; row.message = '游戏已退出，正在检查并应用。'; inFlight.add(t.key);
            try {
              await save(t, row);
              const result = await execute(row.gameId, row.request, row.consent);
              row.status = result.needsAttention ? 'attention' : 'complete'; row.message = result.notice;
            } catch (e) { row.status = 'attention'; row.message = e.message; row.draftBackup = row.request;
              if (e.details?.recoveryRequired) { row.status = 'recovery-required'; row.recovery = { required: true, kind: 'operation', code: e.code }; } }
            try { await save(t, row); } finally { inFlight.delete(t.key); }
          });
        } catch (e) { emit({ gameId: seed?.gameId, status: 'attention', message: e.message }); }
        finally { if (checkingKey) checking.delete(checkingKey); }
      });
    } finally { polling = false; }
    // A slow owner must not suppress later polls for games that exit or join
    // the queue while it runs. Each game still has one checking/applying task.
    await Promise.allSettled(tasks);
  }
  return { submit, apply, inspect, assertNoWaiting, cancel, cancelWithinQueue, tick,
    start() { if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, 3000); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; } };
}
module.exports = { createDeferredOperations };
