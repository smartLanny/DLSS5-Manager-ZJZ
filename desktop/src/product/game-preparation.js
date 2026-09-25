'use strict';

// Durable orchestration over existing, independently reversible transactions.
// Intent is saved before each step so interruption never loses recovery scope.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { noLinks, atomicJson } = require('./launch-safety');
const { inspectNativeEnhancementCapabilities } = require('./game-enhancement-capabilities');
const error = (code, message, details) => Object.assign(new Error(message), { code, details });
const occupied = (snapshot, domain) => Boolean(snapshot.applied?.[domain] || snapshot.requests?.[domain]?.request);
function createGamePreparation({ userData, service, settings, components, fgWorkflow, assertClosed }) {
  const directory = path.join(userData, 'game-preparation');
  function target(id) {
    const exe = service.gameExecutable(id), game = service.gameDirectory(id);
    if (typeof exe !== 'string' || !path.isAbsolute(exe) || typeof game !== 'string' || !path.isAbsolute(game))
      throw error('PREPARATION_TARGET', '请先确认实际游戏 EXE。');
    return { id, exe: path.resolve(exe), game: path.resolve(game), file: path.join(directory, crypto.createHash('sha256').update(path.resolve(exe).toLowerCase()).digest('hex') + '.json') };
  }
  async function read(t) {
    await noLinks(t.file);
    let data; try { data = await fs.readFile(t.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    let value; try { if (data.length > 65536) throw Error(); value = JSON.parse(data); } catch { throw error('PREPARATION_RECORD', '一键准备恢复记录损坏，请保留记录并提交反馈。'); }
    if (value?.version !== 1 || value.exe !== t.exe || value.game !== t.game || !['native', 'feeder'].includes(value.route) ||
        !value.baseline || !value.intent || !Array.isArray(value.stages) ||
        ['nr', 'sr', 'fg', 'fgComponents'].some(key => typeof value.baseline[key] !== 'boolean') ||
        ['nr', 'sr', 'fg'].some(key => typeof value.intent[key] !== 'boolean'))
      throw error('PREPARATION_RECORD', '一键准备恢复记录与游戏不一致，请先处理原记录。');
    return value;
  }
  async function write(t, record) {
    await atomicJson(t.file, record);
  }
  async function remove(t) { await noLinks(t.file); await fs.rm(t.file, { force: true }); }
  async function inspect(id) {
    const value = await read(target(id));
    return { pending: Boolean(value), stages: value?.stages || [], failure: value?.failure || null, runtimeVerified: false };
  }
  async function assertReady(id) {
    if (await read(target(id))) throw error('PREPARATION_PENDING', '上次一键准备尚未完成，请点击“恢复未完成准备”后继续。');
  }
  async function compensate(t, record) {
    const outcomes = [];
    await assertClosed(t.id);
    // Complete the domain journal before requesting a scoped restore. A
    // failed restore stops dependency removal and leaves the ledger intact.
    await settings.assertReady(t.id);
    const pendingFiles = [path.join(t.game, '_DLSS5_Backup', 'pending-switch.json'), path.join(t.game, '_DLSS5_Feeder', 'pending-switch.json')];
    for (const file of pendingFiles) {
      await noLinks(file);
      try { await fs.stat(file); throw error('PREPARATION_INSTALL_PENDING', '安装文件事务仍待恢复，请先在诊断中处理未完成安装。'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    for (const domain of ['fg', 'sr']) if (record.intent[domain] && !record.baseline[domain]) {
      await settings.restore(t.id, domain); outcomes.push({ domain, restored: true });
    }
    if (record.intent.fg && !record.baseline.fgComponents) {
      const current = await components.inspect(t.id);
      if (current.migrationPending) throw error('PREPARATION_FG_PENDING', '补帧迁移仍待恢复，请先在补帧区域处理。');
      await components.restore(t.id);
    }
    if (record.intent.nr && !record.baseline.nr) {
      const rows = await service.listGames(), current = rows.find(row => row.id === t.id);
      if (current?.installed || current?.feeder?.installed || current?.vulkan?.installed) {
        if (record.route === 'feeder') await service.restoreFeeder(t.id);
        else await service.uninstall(t.id, false);
        outcomes.push({ domain: 'nr', restored: true });
      }
    }
    await remove(t);
    return { restored: true, outcomes, runtimeVerified: false };
  }
  async function recover(id) {
    const t = target(id), record = await read(t);
    if (!record) return { restored: false, unchanged: true };
    await assertClosed(id);
    const pending = typeof settings.pending === 'function' ? await settings.pending(id) : [];
    if (pending.length) {
      try { await settings.recover(id); }
      catch (cause) {
        if (cause.code === 'REF_RECOVERY_REQUIRED' && typeof service.recoverReframework === 'function') await service.recoverReframework(id);
        else if (cause.code === 'FEEDER_RECOVERY_REQUIRED' && record.route === 'feeder' && record.intent.nr && !record.baseline.nr) await service.restoreFeeder(id);
        else if (cause.code === 'SETTINGS_FG_FILE_RECOVERY_REQUIRED' && record.intent.fg && typeof components.recoverPending === 'function') await components.recoverPending(id);
        else throw cause;
        await settings.recover(id);
      }
      await service.refresh();
    }
    return service.refreshAfterMutation(await compensate(t, record));
  }
  async function prepare(id, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['api', 'version', 'allowAntiCheat', 'route'].includes(key)) ||
        options.route !== undefined && !['native', 'feeder'].includes(options.route)) throw error('PREPARATION_INPUT', '一键准备请求无效。');
    const t = target(id); await assertReady(id); await settings.assertReady(id); await assertClosed(id);
    const games = await service.listGames(), game = games.find(row => row.id === id);
    if (!game?.chosen) throw error('PREPARATION_TARGET', '请先选择实际游戏 EXE。');
    const capabilities = inspectNativeEnhancementCapabilities(service.gameScan(id));
    const prior = await settings.inspect(id), fgState = await components.inspect(id);
    if (fgState.migrationPending) throw error('PREPARATION_FG_PENDING', '补帧迁移尚未完成，请先恢复。');
    const route = options.route || (game.feeder?.installed ? 'feeder' : 'native');
    if (route === 'feeder' && capabilities.nativeDlssAvailable) throw error('PREPARATION_ROUTE', '已检测到原生 DLSS，请使用原生路线。');
    const record = { version: 1, exe: t.exe, game: t.game, route, startedAt: new Date().toISOString(),
      baseline: { nr: game.installed === true || game.feeder?.installed === true || game.vulkan?.installed === true,
        sr: occupied(prior, 'sr') || prior.legacy?.configured === true || prior.legacy?.baselineCaptured === true || Boolean(prior.legacy?.error),
        fg: occupied(prior, 'fg'), fgComponents: fgState.managed === true || fgState.receipt === true },
      intent: { nr: false, sr: false, fg: false }, stages: [] };
    const row = (domain, status, message) => record.stages.push({ domain, status, message });
    const begin = async domain => { record.intent[domain] = true; await write(t, record); };
    await write(t, record);
    try {
      if (record.baseline.nr) row('nr', 'retained', '保留已安装的画面增强配套。');
      else {
        await begin('nr');
        if (route === 'feeder') await service.installFeeder(id, { ...(options.api ? { api: options.api } : {}), allowAntiCheat: options.allowAntiCheat === true });
        else {
          const installed = await service.applyGameRoute(id, { api: options.api, version: options.version, allowAntiCheat: options.allowAntiCheat === true });
          if (installed?.reframework?.automatic === true && installed.reframework.ready === false)
            throw error('PREPARATION_REFRAMEWORK', installed.reframework.error?.message || 'REFramework 自动准备未完成。');
        }
        row('nr', 'prepared', route === 'feeder' ? '已准备 Feeder 成品帧 NR；需在游戏内核对处理状态。' : '已准备 NR 画面增强配套。');
      }
      await write(t, record);
      const series = [...new Set(prior.hardware?.series || [])];
      if (record.baseline.sr) row('sr', 'retained', '保留已有超分选择。');
      else if (!capabilities.nativeDlssAvailable) row('sr', 'unavailable', '未检测到原生 DLSS 超分，未添加超分设置。');
      else if (series.length !== 1 || !['RTX30', 'RTX40', 'RTX50'].includes(series[0]) || prior.hardware?.family === 'mixed' || prior.hardware?.source === 'unavailable')
        row('sr', 'unavailable', '显卡型号未满足自动选择条件，可在超分区域手动核对。');
      else {
        const request = { backend: 'native', quality: 'quality', preset: 'auto' };
        const plan = await settings.preview(id, 'sr', request);
        await begin('sr'); await settings.apply(plan.id, { confirm: true, automatic: true }); await settings.save(id, 'sr', request);
        row('sr', 'prepared', '已请求质量档超分与推荐模型；请在游戏设置中开启 DLSS。');
      }
      await write(t, record);
      if (record.baseline.fg || fgState.legacyNeedsMigration) row('fg', 'retained', fgState.legacyNeedsMigration ? '保留旧补帧；请在补帧区域显式迁移到 MFG Unlock。' : '保留已有补帧选择。');
      else if (!capabilities.nativeFgAvailable) row('fg', 'unavailable', '未检测到原生 Streamline 补帧；本配套不会为游戏添加原生 FG。');
      else {
        const current = await components.inspect(id);
        if (current.backend === 'dlssg-sm86') {
          row('fg', 'available', 'RTX20/30 多帧生成已随包准备，可在补帧设置中主动启用实验组件。');
        } else if (current.route === 'compatibility' && (current.ready || current.canPrepare)) {
          await begin('fg'); await fgWorkflow.apply(id, { backend: 'mfgunlock', mode: 'follow' }, { allowAntiCheat: options.allowAntiCheat === true });
          row('fg', 'prepared', '已准备 MFG Unlock，默认跟随游戏；按 ReShade 菜单键（新安装默认 Home）→ Add-ons → MFG Unlock 可设置倍率。');
        } else if (current.route === 'native' && current.ready && !current.needsCleanup) {
          const request = { backend: 'nvidia', mode: 'fixed', multiplier: 2 };
          const plan = await settings.preview(id, 'fg', request);
          await begin('fg'); await settings.apply(plan.id, { confirm: true, automatic: true }); await settings.save(id, 'fg', request);
          row('fg', 'prepared', '已请求原生 2 倍补帧；请在游戏设置中开启帧生成。');
        } else row('fg', 'unavailable', (current.blockers || []).join('；') || '当前显卡或补帧配套不满足准备条件。');
      }
      await write(t, record); await remove(t);
      return service.refreshAfterMutation({ prepared: true, stages: record.stages, requiresRestart: true, runtimeVerified: false });
    } catch (cause) {
      record.failure = { code: cause.code || 'PREPARATION_FAILED', message: cause.message };
      try { await write(t, record); await compensate(t, record); }
      catch (recoveryError) { throw error('PREPARATION_RECOVERY_REQUIRED', `一键准备未完成，恢复仍需处理：${recoveryError.message}`, { cause: record.failure, recoveryCode: recoveryError.code, stages: record.stages, gameStarted: false }); }
      throw error(cause.code || 'PREPARATION_FAILED', `一键准备未完成，本次新增内容已撤销：${cause.message}`, { ...cause.details, preparationRolledBack: true, stages: record.stages, gameStarted: false });
    }
  }
  return Object.freeze({ prepare, recover, inspect, assertReady });
}
module.exports = { createGamePreparation };
