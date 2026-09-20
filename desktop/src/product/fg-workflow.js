'use strict';

// Coordinates settings and component transactions. The component adapter owns
// file provenance; this layer never deletes a filename or guesses a backup.
const policy = require('./launch-settings-policy');
const failure = (code, message, details) => Object.assign(new Error(message), { code, details });
function createFgWorkflow({ settings, components, assertClosed }) {
  const preparing = new Set();
  async function ready(id) { await settings.assertReady(id); await assertClosed(id); }
  async function restoreConfig(id, previous) {
    const now = await settings.inspect(id);
    if (['mfgunlock','dlssg-sm86'].includes(previous.applied?.fg?.backend)) {
      const priorRequest = previous.current?.fg?.valid ? previous.current.fg.request : previous.applied.fg.request;
      const plan = previous.applied.fg.backend === 'mfgunlock' && previous.current?.fg?.valid && typeof settings.previewMfgCompensation === 'function'
        ? await settings.previewMfgCompensation(id, previous.current.fg) : await settings.preview(id, 'fg', priorRequest);
      await settings.apply(plan.id, { confirm: true });
      if (previous.requests?.fg?.request) await settings.save(id, 'fg', previous.requests.fg.request);
      return;
    }
    if (['mfgunlock','dlssg-sm86'].includes(now.applied?.fg?.backend) || ['mfgunlock','dlssg-sm86'].includes(now.requests?.fg?.request?.backend)) await settings.restore(id, 'fg');
    if (['mfgunlock','dlssg-sm86'].includes(previous.requests?.fg?.request?.backend)) await settings.save(id, 'fg', previous.requests.fg.request);
  }
  async function apply(id, input, options = {}) {
    const request = policy.validateRequest('fg', input);
    if (!['mfgunlock','dlssg-sm86'].includes(request.backend) || request.mode === 'restore') throw failure('SETTINGS_FG_WORKFLOW', '此入口仅准备显卡对应的补帧兼容组件。');
    await ready(id);
    if (typeof settings.assessEligibility === 'function') {
      const eligibility = await settings.assessEligibility(id, 'fg', request);
      if (!eligibility.eligible) throw failure('SETTINGS_BLOCKED', eligibility.blockers.map(row => row.message).join('\n'), { eligibility, gameStarted: false });
    }
    const previous = await settings.inspect(id), initial = await components.inspect(id);
    if (initial.route !== 'compatibility' || initial.backend && initial.backend !== request.backend) throw failure('SETTINGS_FG_ROUTE_MISMATCH', '补帧组件与所选显卡后端不一致。');
    if (initial.migrationPending) throw failure('SETTINGS_FG_MIGRATION_PENDING', '上次补帧迁移尚未完成，请先恢复。', { migrationToken: initial.migrationToken });
    const legacySettings = previous.applied?.fg?.backend === 'rtx40' || previous.requests?.fg?.request?.backend === 'rtx40';
    if ((initial.legacyNeedsMigration || legacySettings) && options.migrateLegacy !== true)
      throw failure('SETTINGS_FG_MIGRATION_REQUIRED', '请先点击“迁移并准备 MFG Unlock”；旧动态目标不会自动沿用。');
    let migrationToken = null, prepared = null, configAttempted = false;
    preparing.add(id);
    try {
      if (initial.legacyNeedsMigration || legacySettings) {
        await settings.restore(id, 'fg');
        const restored = await components.inspect(id);
        if (restored.legacyNeedsMigration && restored.migrationReady !== true)
          throw failure('SETTINGS_FG_MIGRATION_BLOCKED', (restored.blockers || []).join('\n') || '恢复设置后，旧组件仍不满足安全迁移条件。');
        const migrated = await components.migrateLegacy(id, { allowAntiCheat: options.allowAntiCheat === true });
        migrationToken = migrated.migrationToken;
      }
      prepared = await components.prepare(id, { allowAntiCheat: options.allowAntiCheat === true, migrationToken, providerId: options.providerId });
      const plan = await settings.preview(id, 'fg', request, { reapplyExternalChanges: options.reapplyExternalChanges === true });
      configAttempted = true;
      const result = await settings.apply(plan.id, { confirm: true, automatic: options.reapplyExternalChanges !== true });
      await settings.save(id, 'fg', request);
      if (migrationToken) await components.commitMigration(id, migrationToken);
      if (prepared.undoToken) await components.commitPrepare(id, prepared.undoToken);
      return { ...result, saved: true, prepared: true, backend: request.backend, requiresRestart: true, runtimeVerified: false,
        componentsChanged: prepared.changed === true, migrated: Boolean(migrationToken), warnings: plan.warnings || [] };
    } catch (cause) {
      const recoveryErrors = [];
      // A migration can persist its token and then throw before returning it.
      // Recover the authoritative record rather than reporting a false undo.
      {
        try {
          const current = await (components.inspectMigration ? components.inspectMigration(id) : components.inspect(id));
          if (!migrationToken && current.migrationPending) migrationToken = current.migrationToken;
          if (current.fileRecoveryPending) recoveryErrors.push({ phase: 'component-files', code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED', message: '补帧组件文件操作尚未完成，请使用专用恢复入口。' });
        }
        catch (error) { recoveryErrors.push({ phase: 'migration-status', code: error.code, message: error.message }); }
      }
      if (configAttempted) {
        try { await restoreConfig(id, previous); }
        catch (error) { recoveryErrors.push({ phase: 'settings', code: error.code, message: error.message }); }
      }
      // Keep components and durable migration evidence in place if settings
      // could not be restored. Do not reintroduce the old hook owner blindly.
      if (!recoveryErrors.length && prepared?.undoToken) {
        try { await components.rollbackPrepare(id, prepared.undoToken); }
        catch (error) { recoveryErrors.push({ phase: 'new-components', code: error.code, message: error.message }); }
      }
      if (!recoveryErrors.length && migrationToken) {
        try { await components.rollbackMigration(id, migrationToken); }
        catch (error) { recoveryErrors.push({ phase: 'legacy-components', code: error.code, message: error.message }); }
      }
      if (recoveryErrors.length) throw failure('SETTINGS_FG_RECOVERY_REQUIRED', '补帧准备未完成，部分恢复尚未确认；已保留组件与备份，请先恢复未完成迁移。',
        { cause: { code: cause.code, message: cause.message }, recoveryErrors, migrationToken, gameStarted: false });
      cause.details = { ...cause.details, preparationRolledBack: true, legacySettingsRestored: legacySettings || initial.legacyNeedsMigration, gameStarted: false };
      throw cause;
    } finally { preparing.delete(id); }
  }
  async function prepare(id, options = {}) {
    const previous = await settings.inspect(id);
    const selected = await components.inspect(id);
    const request = previous.current?.fg?.valid ? previous.current.fg.request : ['mfgunlock','dlssg-sm86'].includes(previous.applied?.fg?.backend) ? previous.applied.fg.request : { backend: selected.backend || 'mfgunlock', mode: 'follow' };
    return apply(id, request, options);
  }
  async function recover(id) {
    await assertClosed(id);
    const files = await components.recoverPending?.(id);
    await settings.assertReady(id);
    const status = await (components.inspectMigration ? components.inspectMigration(id) : components.inspect(id));
    if (!status.migrationPending || !status.migrationToken) return { ...files, restored: files?.recovered === true || files?.restored === true,
      unchanged: files?.recovered !== true && files?.restored !== true };
    const state = await settings.inspect(id);
    if (state.applied?.fg?.backend === 'mfgunlock' || state.requests?.fg?.request?.backend === 'mfgunlock') await settings.restore(id, 'fg');
    return components.rollbackMigration(id, status.migrationToken);
  }
  return Object.freeze({ apply, prepare, recover, isPreparing: id => preparing.has(id) });
}
module.exports = { createFgWorkflow };
