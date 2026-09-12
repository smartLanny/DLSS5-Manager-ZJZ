'use strict';
const path = require('path');
const fs = require('fs');
const { assertLaunchNotCancelled } = require('./launch-safety');

function createLaunchCoordinator({ service, settings, legacySrModel, guards, components, launchGame, explicitApply = false }) {
  let queue = Promise.resolve();
  function serialize(work) {
    const current = queue.then(work, work);
    queue = current.catch(() => {});
    return current;
  }
  const closed = id => guards.assertGameClosed(service.gameDirectory(id), service.gameExecutable(id));
  const hasComponentReceipt = id => fs.existsSync(path.join(service.gameDirectory(id), '_DLSS5_Backup', 'xiaofeng-fg-components.json'));
  async function launchFailure(id, error, phase, launchSettings) {
    const outcomes = Array.isArray(launchSettings) ? launchSettings : [];
    let ownedDomains = null;
    try {
      const applied = (await settings.inspect(id))?.applied;
      if (applied && typeof applied === 'object' && !Array.isArray(applied)) ownedDomains = Object.keys(applied);
    } catch {}
    // A successful restore is also reported as applied, but it has removed the
    // receipt. Prefer the authoritative ownership snapshot to old outcome rows.
    const recoverableDomains = [...new Set((ownedDomains ?? outcomes.filter(row => row?.applied === true).map(row => row.domain))
      .filter(domain => domain === 'sr' || domain === 'fg'))];
    const original = error && typeof error === 'object' ? error : new Error(String(error));
    const suffix = recoverableDomains.length
      ? ownedDomains !== null
        ? `；${recoverableDomains.map(value => value.toUpperCase()).join(' / ')} 设置保留恢复记录，请在对应区域核对并撤销。`
        : '；启动设置可能已有变更，但恢复状态暂无法读取。请核对设置记录并提交 BUG 反馈，不要反复写入。'
      : '';
    const wrapped = new Error(`${original.message || '游戏启动失败。'}${suffix}`);
    wrapped.code = typeof original.code === 'string' && /^(SETTINGS_|NVAPI_|FG_)/.test(original.code)
      ? original.code : 'SETTINGS_LAUNCH_FAILED';
    wrapped.cause = original;
    wrapped.details = {
      ...(original.details && typeof original.details === 'object' ? original.details : {}),
      phase,
      gameStarted: false,
      launchSettings: outcomes,
      recoveryStateKnown: ownedDomains !== null,
      recoverableDomains
    };
    return wrapped;
  }
  async function launch(id, controls) {
    assertLaunchNotCancelled(controls);
    await settings.assertReady(id);
    await service.validateLaunch(id);
    await closed(id);
    assertLaunchNotCancelled(controls);
    if (components) {
      const migration = await components.inspectMigration?.(id);
      if (migration?.fileRecoveryPending) throw Object.assign(new Error('补帧组件文件操作尚未完成，请先恢复再启动游戏。'), { code: 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' });
      if (migration?.migrationPending) throw Object.assign(new Error('补帧迁移尚未完成，请先恢复或完成迁移再启动游戏。'), { code: 'SETTINGS_FG_MIGRATION_PENDING' });
      const requests = typeof settings.savedRequests === 'function' ? await settings.savedRequests(id) : (await settings.inspect(id)).requests;
      const fg = requests?.fg?.request;
      if (fg && fg.mode !== 'restore') {
        const readiness = await components.inspect(id);
        if (readiness.migrationPending) throw Object.assign(new Error('补帧迁移尚未完成，请先恢复。'), { code: 'SETTINGS_FG_MIGRATION_PENDING' });
        if (fg.backend === 'rtx40') throw Object.assign(new Error('旧补帧设置需要先迁移或撤销；不会在启动时重新安装旧组件。'), { code: 'SETTINGS_FG_MIGRATION_REQUIRED' });
        if (!readiness.ready) throw Object.assign(new Error(readiness.needsCleanup
          ? '请先在 FG 区域切换为原生路线，移除旧兼容组件。'
          : '帧生成组件尚未就绪，请先在 FG 区域准备兼容组件或处理提示。'), { code: 'SETTINGS_COMPONENTS_NOT_READY' });
      }
    }
    assertLaunchNotCancelled(controls);
    const launchSettings = await settings.beforeLaunch(id);
    const failure = launchSettings.find(row => row.applied !== true && row.skipped !== true);
    if (failure) throw await launchFailure(id, Object.assign(new Error(failure.reason || '启动设置应用失败，未启动游戏。'),
      { code: failure.code || 'SETTINGS_APPLY_FAILED' }), 'launch-settings', launchSettings);
    let srModel = null;
    try {
      assertLaunchNotCancelled(controls);
      if (!await settings.hasSrRequest(id)) {
        assertLaunchNotCancelled(controls);
        if (explicitApply) {
          const legacy = await legacySrModel.migrationInfo(id);
          if (legacy.configured || legacy.baselineCaptured) throw Object.assign(new Error('此游戏仍有旧版 SR 选择，请先在增强设置中预览并应用或恢复；启动不会自动写入旧设置。'), { code: 'SETTINGS_LEGACY_APPLY_REQUIRED' });
          srModel = { ...legacy, apply: { ok: true, skipped: true } };
        } else srModel = await legacySrModel.applyBeforeLaunch(id);
        if (srModel?.apply?.ok !== true) throw Object.assign(new Error(srModel?.apply?.error || 'SR 模型应用失败，未启动游戏。'),
          { code: 'SETTINGS_APPLY_FAILED' });
      }
    } catch (error) {
      // Dependency failures may throw rather than return { apply: { ok: false } }.
      // Keep already completed FG/SR outcomes visible in both cases.
      throw await launchFailure(id, error, 'legacy-sr', launchSettings);
    }
    assertLaunchNotCancelled(controls);
    try { return { launched: await (launchGame || service.launch)(id, controls), srModel, launchSettings }; }
    catch (error) { throw await launchFailure(id, error, 'process-spawn', launchSettings); }
  }
  async function restoreForUninstall(id) {
    await settings.assertReady(id);
    await closed(id);
    for (const domain of ['fg', 'sr']) await settings.restore(id, domain);
    await legacySrModel.prepareMigration(id);
    if (components) await components.restore(id);
  }
  async function inspectLaunchReadiness(id, observed = null) {
    const base = typeof settings.inspectLaunchReadiness === 'function'
      ? await settings.inspectLaunchReadiness(id, observed)
      : { state: 'unknown', known: false, blockers: [], source: 'unavailable', pending: [] };
    const blockers = [...(base.blockers || [])], requests = base.requests || observed?.requests || {};
    const add = (domain, code, message, details = {}) => {
      const { action, ...rest } = details;
      blockers.push({ domain, code, message, ...rest, action: typeof action === 'string' ? { kind: action } : action || null });
    };
    const fgRequest = requests.fg?.request;
    let migration = null;
    if (components?.inspectMigration) {
      try { migration = await components.inspectMigration(id); }
      catch (error) { add('fg', error.code || 'SETTINGS_FG_MIGRATION_UNKNOWN', error.message || '补帧迁移状态无法确认。', { known: false, recovery: true, action: 'recover' }); }
      if (migration?.fileRecoveryPending) add('fg', 'SETTINGS_FG_FILE_RECOVERY_REQUIRED', '补帧组件文件操作尚未完成，请先恢复。', { recovery: true, action: 'recover' });
      else if (migration?.migrationPending) add('fg', 'SETTINGS_FG_MIGRATION_PENDING', '补帧迁移尚未完成，请先恢复或完成迁移。', { recovery: true, action: 'migrate' });
    }
    const observedFg = observed?.fgComponents;
    if (fgRequest && fgRequest.mode !== 'restore' && observedFg) {
      if (observedFg.fileRecoveryPending) add('fg', 'SETTINGS_FG_FILE_RECOVERY_REQUIRED', '补帧组件文件操作尚未完成，请先恢复。', { recovery: true, action: 'recover' });
      else if (observedFg.migrationPending) add('fg', 'SETTINGS_FG_MIGRATION_PENDING', '补帧迁移尚未完成，请先恢复。', { recovery: true, action: 'migrate' });
      else if (observedFg.ready === false) add('fg', 'SETTINGS_COMPONENTS_NOT_READY', observedFg.needsCleanup
        ? '请先在 FG 区域切换为原生路线，移除旧兼容组件。' : '帧生成组件尚未就绪，请先准备兼容组件或处理提示。', { action: 'open-settings' });
    }
    const state = blockers.length ? 'blocked' : base.state === 'unknown' ? 'unknown' : 'ready';
    return { ...base, state, known: state !== 'unknown' && base.known !== false && !blockers.some(row => row.known === false), blockers,
      source: observed ? 'settings-inspection' : 'metadata', migration };
  }
  return { serialize, launch, restoreForUninstall, inspectLaunchReadiness,
    async inspect(id) {
      if (!components) return settings.inspect(id);
      const [snapshot, fgComponents] = await Promise.all([settings.inspect(id), components.inspect(id).catch(async error => {
        // A partially restored receipt must not hide its independent WAL
        // recovery entry behind the failed component eligibility inspection.
        let recovery = {};
        try { recovery = await components.inspectPending?.(id) || {}; } catch {}
        return { route: 'unknown', ready: false, canPrepare: false, missing: [], blockers: [error.message || '无法确认 FG 组件状态。'],
          errorCode: error.code || 'SETTINGS_COMPONENTS_UNKNOWN', ...recovery };
      })]);
      return { ...snapshot, fgComponents };
    },
    assertMutationReady: id => settings.assertReady(id),
    async removeLibraryEntry(id) {
      await settings.assertReady(id);
      if (await settings.hasOwnedState(id) || hasComponentReceipt(id) || (await legacySrModel.migrationInfo(id))?.baselineCaptured)
        throw Object.assign(new Error('请先恢复超分补帧设置与组件，再移出游戏库。'), { code: 'LIBRARY_RESTORE_FIRST' });
      return service.dismissGame(id, { libraryOnly: true });
    },
    async dismiss(id) {
      if (!service.gameExecutable(id)) {
        if (hasComponentReceipt(id) || await settings.hasOwnedState(id) || (await legacySrModel.migrationInfo(id))?.baselineCaptured) {
          throw Object.assign(new Error('原 EXE 缺失且仍有待还原的设置，请恢复原程序路径后处理。'), { code: 'SETTINGS_EXE_CHANGED' });
        }
        return service.dismissGame(id);
      }
      await restoreForUninstall(id);
      return service.dismissGame(id);
    },
    async confirmSelection(selection) {
      if (!selection || typeof selection.root !== 'string' || typeof selection.executable !== 'string') {
        return service.addManualSelection(selection);
      }
      for (const name of ['xiaofeng-launch-settings.json', 'xiaofeng-fg-components.json']) {
        const file = path.join(selection.root, '_DLSS5_Backup', name);
        if (!fs.existsSync(file)) continue;
        let record; try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
          throw Object.assign(new Error('已有设置恢复记录损坏，不能改绑游戏程序。'), { code: 'SETTINGS_RECEIPT_INVALID' });
        }
        const owned = name === 'xiaofeng-launch-settings.json' ? Object.keys(record.applied || {}).length : (record.files || []).length;
        if (owned && typeof record.exe === 'string' && path.resolve(record.exe).toLowerCase() !== path.resolve(selection.executable).toLowerCase()) {
          throw Object.assign(new Error('此目录仍有属于原 EXE 的设置或兼容组件，请先还原再改绑。'), { code: 'SETTINGS_EXE_CHANGED' });
        }
      }
      for (const game of service.gamesInDirectory(selection.root)) {
        if (game.executable && path.resolve(game.executable).toLowerCase() === path.resolve(selection.executable).toLowerCase()) continue;
        if (!game.executable) {
          if (await settings.hasOwnedState(game.id) || (await legacySrModel.migrationInfo(game.id))?.baselineCaptured) {
            throw Object.assign(new Error('原 EXE 仍有设置记录，不能改绑到其他程序。'), { code: 'SETTINGS_EXE_CHANGED' });
          }
          continue;
        }
        await settings.assertReady(game.id);
        const current = await settings.inspect(game.id);
        if (Object.keys(current.applied || {}).length || current.legacy?.baselineCaptured || current.legacy?.error) {
          throw Object.assign(new Error('此目录的原 EXE 仍有 SR / FG 设置，请先还原原游戏设置，再选择其他程序。'), { code: 'SETTINGS_EXE_CHANGED' });
        }
      }
      return service.addManualSelection(selection);
    },
    async writeLegacySr(id, selection) {
      if (await settings.hasSrRequest(id)) throw Object.assign(new Error('此游戏已使用新的 SR 设置，请在 SR 超分区域修改。'), { code: 'SETTINGS_OWNERSHIP' });
      return legacySrModel.write(id, selection);
    }
  };
}

module.exports = { createLaunchCoordinator };
