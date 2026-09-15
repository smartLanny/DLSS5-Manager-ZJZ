'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../src/renderer/launch-settings-ui');
const policy = require('../src/product/launch-settings-policy');

test('renderer requests compile with the real policy and omit dormant fields', () => {
  for (const backend of ['native', 'optiscaler']) {
    for (const quality of ['game', 'dlaa', 'quality', 'balanced', 'performance', 'ultraPerformance', 'custom']) {
      const request = ui.createRequest('sr', { backend, quality, renderPercent: '75', preset: 'M' });
      assert.deepEqual(policy.validateRequest('sr', request), request);
      if (quality !== 'custom') assert.equal(request.renderPercent, undefined);
      if (backend === 'optiscaler' || quality === 'game') assert.equal(request.preset, undefined);
    }
  }
  assert.throws(() => ui.createRequest('sr', { backend: 'native', quality: 'custom', renderPercent: '75.5' }), /整数/);
  assert.throws(() => ui.createRequest('sr', { backend: 'optiscaler', quality: 'custom', renderPercent: '33.33' }), /33.334/);
  assert.deepEqual(ui.createRequest('sr', { backend: 'native', quality: 'preserve', preset: 'K' }), { backend: 'native', quality: 'preserve', preset: 'K' });
  assert.deepEqual(ui.createRequest('sr', { backend: 'native', quality: 'preserve', preset: 'auto' }), { backend: 'native', quality: 'preserve', preset: 'auto' });
  for (const backend of ['nvidia', 'rtx40']) {
    for (const mode of ['restore', 'fixed', 'dynamic', backend === 'nvidia' ? 'off' : 'follow']) {
      const request = ui.createRequest('fg', { backend, mode, multiplier: '6', targetFps: '0', experimental56: true });
      assert.deepEqual(policy.validateRequest('fg', request), request);
      if (mode !== 'fixed') assert.equal(request.multiplier, undefined);
      if (mode !== 'dynamic') assert.equal(request.targetFps, undefined);
      if (backend === 'nvidia' || mode !== 'dynamic') assert.equal(request.experimental56, undefined);
    }
  }
  const mfgDynamic = ui.createRequest('fg', { backend: 'mfgunlock', mode: 'dynamic', targetFps: '120', multiplier: '6',
    runtimeMode: 'ota', hdrMode: 'automatic', depthEdgeGuard: '2', freezeFallback: 'on', reflexSourceCap: 'on',
    temporalFix: '', blackwellFrameworkKernels: '' });
  assert.deepEqual(mfgDynamic, { backend: 'mfgunlock', mode: 'dynamic', targetFps: 120, runtimeMode: 'ota', hdrMode: 'automatic',
    depthEdgeGuard: 2, freezeFallback: true, reflexSourceCap: true });
  assert.deepEqual(policy.validateRequest('fg', mfgDynamic), mfgDynamic);
  assert.equal(mfgDynamic.multiplier, undefined);
  assert.deepEqual(ui.createRequest('fg', { backend: 'mfgunlock', mode: 'fixed', multiplier: '2' }),
    { backend: 'mfgunlock', mode: 'fixed', multiplier: 2 }, 'MFG 0.9 fixed values are absolute requests');
  assert.throws(() => ui.createRequest('fg', { backend: 'rtx40', mode: 'off' }), /有效/);
  assert.throws(() => ui.createRequest('fg', { backend: 'nvidia', mode: 'fixed', multiplier: '7' }), /2–6/);
  assert.throws(() => ui.createRequest('fg', { backend: 'nvidia', mode: 'dynamic', targetFps: '' }), /整数/);
});

test('an installation family alone never grants FG capability', () => {
  assert.equal(ui.hardwareFacts({ family: 'RTX40' }).fgBackend, null);
  assert.equal(ui.hardwareFacts({ family: 'RTX40', series: ['RTX30'] }).fgBackend, null);
  assert.equal(ui.hardwareFacts({ family: 'RTX40', names: ['NVIDIA GeForce RTX 3080'] }).fgBackend, null);
  assert.equal(ui.hardwareFacts({ family: 'RTX40', series: ['RTX40'], names: ['RTX 3090'] }).fgBackend, null);
  assert.equal(ui.hardwareFacts({ family: 'mixed', series: ['RTX40', 'RTX50'] }).fgBackend, null);
  assert.equal(ui.hardwareFacts({ series: ['RTX40'], source: 'unavailable' }).fgBackend, null);
  assert.equal(ui.hardwareFacts({ family: 'RTX40', series: ['RTX40'], names: ['NVIDIA GeForce RTX 4090'] }).fgBackend, 'mfgunlock');
  assert.equal(ui.hardwareFacts({ family: 'RTX50', series: ['RTX50'] }).fgBackend, 'nvidia');
  assert.equal(ui.recommendedPreset({ family: 'RTX40', series: ['RTX20'] }), 'K');
  assert.equal(ui.recommendedPreset({ family: 'RTX30', series: ['RTX30'] }), 'K');
  assert.equal(ui.recommendedPreset({ family: 'RTX40', series: ['RTX40'] }), 'M');
  assert.equal(ui.recommendedPreset({ family: 'RTX50', series: ['RTX50'] }), 'M');
  assert.equal(ui.recommendedPreset({ family: 'mixed', series: ['RTX30', 'RTX40'] }), null);
  assert.equal(ui.recommendedPreset({ family: 'RTX40' }), null);
});

test('the independent SR editor proposes explicit per-GPU models without adding an automatic policy', () => {
  for (const [series, expected] of [['RTX20', 'K'], ['RTX30', 'K'], ['RTX40', 'M'], ['RTX50', 'M']]) {
    const hardware = { family: series === 'RTX50' ? 'RTX50' : 'RTX40', series: [series] };
    const settings = { hardware, requests: {}, applied: {} }, before = structuredClone(settings);
    const fields = ui.initialSrFields(settings);
    assert.deepEqual(fields, { backend: 'native', quality: 'preserve', preset: expected, renderPercent: 67 });
    const request = ui.createRequest('sr', fields);
    assert.deepEqual(request, { backend: 'native', quality: 'preserve', preset: expected });
    assert.deepEqual(policy.validateRequest('sr', request), request, 'existing managers can read the unchanged request format');
    assert.equal(policy.nativeSr(request, hardware).operations.length, 2);
    assert.deepEqual(settings, before, 'recommendation does not mutate persisted settings');
  }
  for (const hardware of [{}, { family: 'RTX40' }, { source: 'unavailable', series: ['RTX40'] },
    { family: 'mixed', series: ['RTX30', 'RTX50'] }, { series: ['RTX40'], names: ['NVIDIA GeForce RTX 3090'] }]) {
    const fields = ui.initialSrFields({}, hardware);
    assert.equal(fields.quality, 'game'); assert.equal(fields.preset, '');
    assert.deepEqual(ui.createRequest('sr', fields), { backend: 'native', quality: 'game' });
  }
  assert.throws(() => ui.createRequest('sr', { backend: 'native', quality: 'preserve', preset: 'gpu-auto' }), /模型/);
});

test('independent SR initialization preserves saved requests, applied requests and omitted presets', () => {
  const hardware = { series: ['RTX40'] }, legacy = { configured: true, selection: 'm', managed: false };
  const saved = { backend: 'native', quality: 'performance', preset: 'auto' };
  const settings = { requests: { sr: { request: saved } }, applied: { sr: { request: { backend: 'native', quality: 'quality', preset: 'L' } } }, legacy };
  let fields = ui.initialSrFields(settings, hardware);
  assert.equal(fields.preset, 'auto'); assert.equal(fields.renderPercent, 50);
  assert.deepEqual(ui.createRequest('sr', fields), saved);
  assert.equal(policy.nativeSr(ui.createRequest('sr', fields), hardware).operations.find(row => row.id === policy.IDS.sr[3]).value, 13);
  fields.quality = 'quality';
  assert.equal(policy.nativeSr(ui.createRequest('sr', fields), hardware).operations.find(row => row.id === policy.IDS.sr[3]).value, 11, 'saved auto retains the NVIDIA quality-based policy');
  delete settings.requests.sr;
  assert.deepEqual(ui.createRequest('sr', ui.initialSrFields(settings, hardware)), settings.applied.sr.request);
  for (const request of [{ backend: 'native', quality: 'custom', renderPercent: 73 }, { backend: 'native', quality: 'game' },
    { backend: 'optiscaler', quality: 'quality' }]) {
    settings.applied.sr.request = request;
    const fields = ui.initialSrFields(settings, hardware);
    assert.equal(fields.preset, ''); assert.deepEqual(ui.createRequest('sr', fields), request);
  }
});

test('independent SR initialization only adopts explicitly configured and unowned legacy selections', () => {
  const hardware = { family: 'RTX50', series: ['RTX50'] };
  const legacy = { configured: true, managed: false, selection: 'l', effective: 'm' };
  assert.equal(ui.initialSrFields({ legacy }, hardware).preset, 'L', 'the saved selection wins over a derived effective suggestion');
  legacy.selection = 'auto';
  assert.equal(ui.initialSrFields({ legacy }, hardware).preset, 'M');
  assert.equal(ui.initialSrFields({ legacy }, { family: 'RTX40', series: ['RTX20'] }).preset, 'K');
  assert.equal(ui.initialSrFields({ legacy }, {}).quality, 'game');
  legacy.selection = 'default';
  assert.deepEqual(ui.createRequest('sr', ui.initialSrFields({ legacy }, hardware)), { backend: 'native', quality: 'game' });
  legacy.selection = 'k'; legacy.configured = false;
  assert.equal(ui.initialSrFields({ legacy }, hardware).preset, 'M');
  legacy.configured = true; legacy.managed = true;
  assert.equal(ui.initialSrFields({ legacy }, hardware).preset, 'M');
  legacy.managed = false; legacy.error = { message: 'unreadable' };
  assert.notEqual(ui.initialSrFields({ legacy }, hardware).preset, 'K', 'unreadable legacy data is not a confirmed saved selection');
});

test('SR model labels describe the requested choice without claiming universal L quality superiority', () => {
  assert.deepEqual(ui.SR_MODEL_LABELS, { K: 'K · 老版兼容', M: 'M · 平衡选择', L: 'L · 4K 优化' });
  assert.equal(ui.SR_MODEL_DESCRIPTIONS.L, '主要优化 4K 超级性能档位。');
  assert.doesNotMatch(Object.values(ui.SR_MODEL_LABELS).join(''), /最好|最高/);
});

test('settings apply through one update operation; errors stay dirty and global reset clears both domains', async () => {
  const calls = [];
  const data = { hardware: { series: ['RTX40'] }, requests: {}, applied: {}, pending: [] };
  const host = { isConnected: true, innerHTML: '', querySelector: () => null };
  let failUpdate = false;
  const manager = {
    inspectLaunchSettings: async () => ({ ok: true, value: structuredClone(data) }),
    updateLaunchSettings: async (id, domain, request, options) => {
      calls.push(['update', id, domain, request, options]);
      if (failUpdate) return { ok: false, error: { code: 'SETTINGS_DISK', message: '写入失败' } };
      data.requests[domain] = { exe: 'C:\\Games\\A.exe', request };
      data.applied[domain] = { request, readbackVerified: true };
      return { ok: true, value: { applied: true } };
    },
    resetAllLaunchSettings: async id => {
      calls.push(['reset-all', id]);
      data.requests = {}; data.applied = {};
      return { ok: true, value: { restored: true } };
    }
  };
  const controller = ui.mount(host, 'game-1', { manager });
  await controller.ready;
  assert.deepEqual(calls, [], 'initial inspection never writes settings');
  Object.assign(controller.getState().drafts.sr, { quality: 'custom', renderPercent: 75, preset: 'M' });
  controller.getState().dirty.sr = true;
  await controller.perform('auto', 'sr');
  assert.deepEqual(calls[0], ['update', 'game-1', 'sr', { backend: 'native', quality: 'custom', renderPercent: 75, preset: 'M' }, { allowAntiCheat: false }]);
  assert.match(host.innerHTML, /设置已应用/);
  assert.doesNotMatch(host.innerHTML, /预览|确认应用/);
  failUpdate = true;
  controller.getState().drafts.sr.renderPercent = 76;
  controller.getState().dirty.sr = true;
  await controller.perform('auto', 'sr');
  assert.match(host.innerHTML, /写入失败 \[SETTINGS_DISK\]/);
  assert.equal(controller.getState().dirty.sr, true);
  failUpdate = false;
  await controller.perform('auto', 'sr');
  assert.equal(controller.getState().dirty.sr, false);
  await controller.perform('restore-all');
  assert.equal(data.requests.sr, undefined);
  assert.equal(controller.getState().drafts.sr.quality, 'quality');
  assert.deepEqual(calls.filter(row => row[0] === 'reset-all'), [['reset-all', 'game-1']]);
  assert.match(host.innerHTML, /恢复原有设置/);
});

test('readback state and component messages are escaped', () => {
  const applied = { sr: { request: { backend: 'native', quality: 'quality' }, runtimeVerified: true } };
  assert.doesNotMatch(ui.statusMarkup('sr', { applied }, false), /配置已校验/);
  applied.sr.readbackVerified = true;
  const status = ui.statusMarkup('sr', { applied }, false);
  assert.match(status, /配置已校验/);
  const components = ui.fgComponentMarkup({ hardware: { series: ['RTX40'] }, fgComponents: { route: 'compatibility', ready: false, canPrepare: false, missing: ['<img src=x onerror=1>'], blockers: ['<script>bad()</script>'] } }, false);
  assert.match(components, /&lt;img/);
  assert.match(components, /&lt;script&gt;bad/);
});

test('legacy SR choices stay visible until this editor takes ownership', () => {
  const data = { requests: {}, applied: {}, legacy: { selection: 'auto', effective: 'm', managed: false, baselineCaptured: true } };
  assert.equal(ui.initialFields('sr', data).quality, 'quality');
  data.hardware = { family: 'RTX40', series: ['RTX40'] };
  assert.equal(ui.initialFields('sr', data).preset, 'auto');
  const status = ui.statusMarkup('sr', data, false);
  assert.match(status, /沿用原模型设置：自动 → 模型 M/);
  assert.doesNotMatch(status, /未设启动覆盖|配置已校验/);
  data.legacy.managed = true;
  assert.equal(ui.initialFields('sr', data).quality, 'quality');
  assert.doesNotMatch(ui.statusMarkup('sr', data, false), /沿用原模型设置/);
  data.legacy.managed = false;
  data.requests.sr = { request: { backend: 'native', quality: 'custom', renderPercent: 75, preset: 'K' } };
  assert.equal(ui.initialFields('sr', data).preset, 'K');
  assert.doesNotMatch(ui.statusMarkup('sr', data, false), /沿用原模型设置/);
  delete data.requests.sr;
  data.legacy.effective = 'default';
  assert.equal(ui.initialFields('sr', data).quality, 'quality');
  data.legacy.error = { message: '读取失败' };
  assert.match(ui.statusMarkup('sr', data, false), /状态未确认/);
});

test('the new module replaces the legacy writable SR widget and preserves core controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  assert.match(html, /src="launch-settings-ui.js"/);
  assert.doesNotMatch(html, /src="sr-model-ui.js"/);
  assert.match(renderer, /launchSettingsUi.mount/);
  assert.doesNotMatch(renderer, /carrier-component-check/);
  assert.match(renderer, /核心版本/);
  assert.match(html, /<div class="community-note"[^>]*><span>用爱发电<\/span><span>不要付费<\/span><\/div>/);
});

test('shared NVIDIA profile scope is visible without nagging a single executable', () => {
  assert.equal(ui.driverScopeMarkup({ name: 'Game profile', applications: ['Game.exe'], shared: false }), '');
  const shared = ui.driverScopeMarkup({ name: '<Shared>', applications: ['Game.exe', '<Launcher.exe>'], shared: true });
  assert.match(shared, /NVIDIA 游戏配置：&lt;Shared&gt; · 关联 2 个启动入口；超分补帧设置会同步用于这些入口/);
  assert.match(shared, /<li>Game\.exe<\/li><li>&lt;Launcher\.exe&gt;<\/li>/);
  assert.match(ui.driverScopeMarkup({ status: 'unknown', message: 'driver unavailable' }), /设置范围暂时无法读取/);
  assert.match(ui.driverScopeMarkup({ error: { message: 'private backend detail' } }), /data-ls-action="reload"/);
  assert.doesNotMatch(ui.driverScopeMarkup({ error: { message: '<secret>' } }), /secret/);
});

test('missing game capability hides irrelevant editors and retains restoration when a previous request exists', async () => {
  const data = { hardware: { family: 'RTX40', series: ['RTX40'] }, requests: { sr: { request: { backend: 'native', quality: 'quality' } } }, applied: {}, pending: [],
    fgComponents: { route: 'compatibility', ready: false, canPrepare: true, missing: ['compatibility files'], blockers: [] } };
  const host = { isConnected: true, innerHTML: '', querySelector: () => null };
  let writes = 0;
  const controller = ui.mount(host, 'no-dlss', { nativeDlssAvailable: false, nativeFgAvailable: false, manager: {
    inspectLaunchSettings: async () => ({ ok: true, value: data }),
    updateLaunchSettings: async () => { writes++; return { ok: true, value: { applied: true } }; },
    prepareFgComponents: async () => { writes++; return { ok: true, value: { prepared: true } }; }
  } });
  await controller.ready;
  assert.match(host.innerHTML, /未检测到原生 DLSS 超分/);
  assert.match(host.innerHTML, /没有可准备的补帧功能/);
  assert.match(host.innerHTML, /data-ls-action="restore-all"(?![^>]* disabled)/);
  assert.doesNotMatch(host.innerHTML, /<fieldset|data-ls-field=/);
  assert.doesNotMatch(host.innerHTML, /data-ls-action="prepare"/);
  await controller.perform('auto', 'sr');
  await controller.perform('prepare', 'fg');
  assert.equal(writes, 0);
});

test('FG owner recovery remains available with component WAL or migration, LS pending and missing native FG', async () => {
  for (const pending of [{ fileRecoveryPending: true }, { migrationPending: true }, { migrationPending: { token: 'migration-fixture' } }]) {
    const data = { hardware: { family: 'RTX40', series: ['RTX40'] }, requests: {}, applied: {}, pending: [{ kind: 'file-journal' }],
      fgComponents: { backend: 'mfgunlock', route: 'compatibility', ready: false, canPrepare: true, managed: true, missing: [], blockers: [], ...pending } };
    const host = { isConnected: true, innerHTML: '', querySelector: () => null }, calls = [];
    let complete;
    const controller = ui.mount(host, 'recovery-game', { nativeDlssAvailable: false, nativeFgAvailable: false, manager: {
      inspectLaunchSettings: async () => ({ ok: true, value: structuredClone(data) }),
      recoverFgComponents: id => { calls.push(['owner', id]); return new Promise(resolve => { complete = () => {
        data.pending = []; data.fgComponents.fileRecoveryPending = false; data.fgComponents.migrationPending = false;
        resolve({ ok: true, value: { restored: true } });
      }; }); },
      recoverLaunchSettings: async () => { calls.push(['generic']); throw new Error('Wrong recovery owner'); }
    } });
    await controller.ready;
    assert.match(host.innerHTML, /data-ls-action="recover-components"(?![^>]* disabled)/);
    assert.match(host.innerHTML, pending.fileRecoveryPending ? /恢复未完成组件操作/ : /恢复未完成迁移/);
    assert.match(host.innerHTML, /data-ls-action="restore-all"[^>]* disabled/);
    assert.match(host.innerHTML, /data-ls-action="remove-components"[^>]* disabled/);
    assert.doesNotMatch(host.innerHTML, /<fieldset|data-ls-field=/);
    const recovering = controller.perform('recover-components', 'fg');
    assert.equal(controller.getState().busy, true);
    assert.match(host.innerHTML, /data-ls-action="recover-components"[^>]* disabled/);
    await controller.perform('recover-components', 'fg');
    assert.deepEqual(calls, [['owner', 'recovery-game']]);
    complete(); await recovering;
    assert.equal(controller.getState().busy, false);
    assert.doesNotMatch(host.innerHTML, /data-ls-action="recover-components"/);
    assert.doesNotMatch(host.innerHTML, /data-ls-action="prepare"/);
    assert.doesNotMatch(host.innerHTML, /<fieldset|data-ls-field=/, 'recovery cannot create native capability');
  }
});

test('a rejected FG owner recovery preserves its enabled recovery entry and the pending receipt', async () => {
  const data = { hardware: { family: 'RTX40', series: ['RTX40'] }, requests: {}, applied: {}, pending: [{ kind: 'file-journal' }],
    fgComponents: { backend: 'mfgunlock', route: 'compatibility', ready: false, fileRecoveryPending: true, missing: [], blockers: [] } };
  const host = { isConnected: true, innerHTML: '', querySelector: () => null };
  let ownerCalls = 0;
  const controller = ui.mount(host, 'blocked-owner', { nativeFgAvailable: false, manager: {
    inspectLaunchSettings: async () => ({ ok: true, value: structuredClone(data) }),
    recoverFgComponents: async () => { ownerCalls++; return { ok: false, error: { code: 'FG_FILE_CHANGED', message: '外部文件已改变，记录仍保留。' } }; }
  } });
  await controller.ready; await controller.perform('recover-components', 'fg');
  assert.equal(ownerCalls, 1); assert.equal(controller.getState().busy, false);
  assert.match(host.innerHTML, /外部文件已改变/);
  assert.match(host.innerHTML, /data-ls-action="recover-components"(?![^>]* disabled)/);
  assert.equal(data.fgComponents.fileRecoveryPending, true); assert.equal(data.pending.length, 1);
});

test('SR model recommendation is hardware-bound and does not write during initialization', async () => {
  for (const [series, expected] of [['RTX30', 'K'], ['RTX40', 'M'], ['RTX50', 'M']]) {
    const data = { hardware: { family: series, series: [series] }, requests: {}, applied: {}, pending: [] };
    const host = { isConnected: true, innerHTML: '', querySelector: () => null };
    let writes = 0;
    const controller = ui.mount(host, series, { manager: {
      inspectLaunchSettings: async () => ({ ok: true, value: data }),
      updateLaunchSettings: async () => { writes++; return { ok: true, value: { applied: true } }; }
    } });
    await controller.ready;
    assert.equal(controller.getState().drafts.sr.preset, 'auto');
    assert.match(host.innerHTML, new RegExp(`value="auto" selected>\u81ea\u52a8\u63a8\u8350 · ${expected}（\u63a8\u8350）`));
    assert.match(host.innerHTML, /模型 L · 高画质低性能/);
    assert.match(host.innerHTML, /模型 M · 推荐（适用 RTX40 \/ RTX50）/);
    assert.equal(writes, 0);
  }
  for (const hardware of [{ source: 'unavailable', series: ['RTX40'] }, { family: 'mixed', series: ['RTX30', 'RTX50'] }, {}]) {
    const data = { hardware, requests: {}, applied: {}, pending: [] };
    assert.equal(ui.initialFields('sr', data).preset, '');
    data.requests.sr = { request: { backend: 'native', quality: 'quality', preset: 'auto' } };
    assert.equal(ui.initialFields('sr', data).preset, '', 'a stale automatic request is not silently recommended when hardware is no longer unique');
  }
});

test('an unconfigured legacy default does not masquerade as an existing model policy', async () => {
  const data = { hardware: { family: 'RTX40', series: ['RTX40'] }, requests: {}, applied: {}, pending: [],
    legacy: { configured: false, selection: 'auto', effective: 'm', managed: false } };
  const host = { isConnected: true, innerHTML: '', querySelector: () => null };
  let writes = 0;
  const controller = ui.mount(host, 'fresh-game', { manager: {
    inspectLaunchSettings: async () => ({ ok: true, value: data }),
    updateLaunchSettings: async () => { writes++; return { ok: true, value: { applied: true } }; }
  } });
  await controller.ready;
  assert.equal(controller.getState().drafts.sr.preset, 'auto');
  assert.match(host.innerHTML, /value="auto" selected>自动推荐 · M（推荐）/);
  assert.doesNotMatch(host.innerHTML, /沿用原模型设置/);
  assert.equal(writes, 0);
});

test('failed game launch refreshes any settings that were already applied and enables feedback context', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  assert.match(main, /error\?\.details\?\.launchSettings/);
  assert.match(main, /outcomes\.filter\(row => row\?\.applied === true \|\| row\?\.skipped === true\)/);
  assert.match(main, /launchFailed: true/);
  assert.match(renderer, /window\.manager\.launch\(id\), '已发起游戏启动，请核对游戏窗口', false, id/);
});

test('new SR controls expose presets and ratios without offering a legacy OptiScaler backend', async () => {
  for (const [quality, percent] of Object.entries({ dlaa: 100, quality: 67, balanced: 59, performance: 50, ultraPerformance: 33 })) {
    const fields = ui.initialFields('sr', { requests: { sr: { request: { backend: 'native', quality } } } });
    assert.equal(fields.renderPercent, percent);
    assert.equal(ui.createRequest('sr', fields).renderPercent, undefined, 'named presets must retain their driver mode rather than override a rounded ratio');
  }
  const data = { requests: { sr: { request: { backend: 'optiscaler', quality: 'custom', renderPercent: 75 } } }, applied: {}, hardware: {}, pending: [] };
  const host = { isConnected: true, innerHTML: '', querySelector: () => null };
  const controller = ui.mount(host, 'legacy', { manager: {
    inspectLaunchSettings: async () => ({ ok: true, value: data }),
    updateLaunchSettings: async () => { throw new Error('must not write a legacy OptiScaler request'); }
  } });
  await controller.ready;
  assert.doesNotMatch(host.innerHTML, /data-ls-field="backend"/);
  assert.match(host.innerHTML, /旧 OptiScaler 设置/);
  assert.match(host.innerHTML, /data-ls-action="restore-all"[^>]*>恢复默认/);
  assert.doesNotMatch(host.innerHTML, /data-ls-action="(?:save|preview|confirm|restore)"/);
  assert.equal(data.requests.sr.request.backend, 'optiscaler', 'legacy receipt is not discarded by rendering or rejected save');
});

test('RTX40 fields remain selectable while components await automatic preparation and RTX50 selects native', async () => {
  const data = { hardware: { family: 'RTX40', series: ['RTX40'] }, requests: {}, applied: {}, pending: [],
    fgComponents: { route: 'compatibility', ready: false, canPrepare: true, missing: ['兼容插件', '加载器'], blockers: [] } };
  const host = { innerHTML: '', isConnected: true, querySelector: () => null };
  const calls = [];
  const manager = { inspectLaunchSettings: async () => ({ ok: true, value: structuredClone(data) }),
    prepareFgComponents: async (id, options) => { calls.push([id, options]); data.fgComponents.ready = true; return { ok: true, value: { prepared: true } }; } };
  const controller = ui.mount(host, 'game', { manager }); await controller.ready;
  assert.match(host.innerHTML, /更改补帧选项时会自动准备配套组件/);
  assert.match(host.innerHTML, /data-ls-field="mode"/);
  await controller.perform('prepare', 'fg');
  assert.deepEqual(calls, [['game', { allowAntiCheat: false, migrateLegacy: false }]]);
  assert.match(host.innerHTML, /data-ls-field="mode"/);
  const native = ui.fgComponentMarkup({ hardware: { family: 'RTX50', series: ['RTX50'] }, fgComponents: { route: 'native', ready: true } }, false);
  assert.match(native, /RTX 50 · 原生帧生成/);
  assert.doesNotMatch(native, /准备兼容组件/);
});
