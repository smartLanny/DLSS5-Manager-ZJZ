'use strict';

(function (scope) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const unwrap = value => { if (value?.ok !== true) throw Object.assign(new Error(value?.error?.message || '本次操作未完成。'), value?.error); return value.value; };
  const errorText = value => `${value?.code ? `[${value.code}] ` : ''}${value?.message || value || '本次操作未完成。'}`;
  const waiting = phase => ['waiting-helper', 'waiting-launcher', 'waiting-game', 'running'].includes(phase);
  const PHASES = {
    binding: ['绑定启动器', '选择这个客户端对应的官方启动器。'], api: ['确认游戏 API', '按游戏实际使用的图形 API 选择一次。'],
    install: ['准备独立画面增强', '先预览 ReShade、Core 和 NR 配套，再应用安装。'], ready: ['已准备，可以启动', '助手就绪后会打开已绑定的官方启动器。'],
    'waiting-helper': ['正在准备加载助手', '请稍候，助手就绪后继续。'], 'waiting-launcher': ['在官方启动器中启动游戏', '已绑定当前客户端，正在等待它产生游戏进程。'],
    'waiting-game': ['等待游戏启动', '请在已打开的官方启动器中点击启动游戏。'], running: ['游戏已启动', '加载与 NR 状态分别核对；请在游戏中查看实际画面。'],
    failed: ['本次操作未完成', '查看当前原因后重新检查。'], recovery: ['先恢复未完成操作', '恢复记录已保留，完成恢复后再继续。']
  };
  const verificationLabel = row => row?.state === 'passed' ? '已确认' : ['failed', 'blocked'].includes(row?.state) ? '未通过' : '待确认';
  const channelValue = row => typeof row === 'string' ? row : row.channel;
  const channelLabel = row => typeof row === 'string' ? row : row.channelLabel || row.label || row.channel;

  function mount(host, api, options = {}) {
    let games = [], launchers = [], warnings = [], selectedId = null, flow = null, form = {}, busy = false, error = '', plan = null,
      discovering = false, disposed = false, generation = 0, timer = null, active = false, expanded = true, editingApi = false, currentWork = '', previewAction = 'install', editorReadiness = null;
    const editors = new Map(), recoveryEditors = new Map();
    const editor = () => editors.get(flow?.gameId);
    const editorBusy = () => editor()?.controller.getState().busy === true || recoveryEditors.get(flow?.gameId)?.controller.getState().busy === true;
    const hasDraft = () => editor()?.controller.hasDraft() === true;
    const pendingAction = () => editor()?.controller.getState().action || null;
    const waitingForExit = () => pendingAction()?.waiting === true || flow?.waiting?.pending === true;
    const feedback = scope.CompatibilityGamePage?.mountFeedback?.(host, api, () => ({
      id: flow?.gameId || null, gameName: flow?.name,
      visible: active && expanded && !disposed,
      mountTarget: host.querySelector('.hoyo-current') || host,
      busy: Boolean(busy || flow?.busy || editorBusy() || plan || editingApi),
      contextKey: JSON.stringify([flow?.id, flow?.exePath, flow?.gameVersion, flow?.channel,
        flow?.binding?.launcher?.id, flow?.session?.sessionId]),
      status: error || flow?.error || flow?.installation?.error || flow?.phase === 'failed'
        ? '遇到问题也能反馈，不必先完成安装或进入游戏。'
        : flow?.phase === 'recovery' ? '可以先反馈问题，不会改动游戏或恢复记录。'
        : '自动带入当前已知信息；准备就绪不等于已经在游戏里生效。'
    }));
    const button = (action, label, primary = false, disabled = false) => `<button type="button" class="button ${primary ? 'primary' : 'subtle'}" data-hoyo-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
    const select = (field, label, rows, selected, placeholder) => `<label class="gp-field"><span>${label}</span><select data-hoyo-field="${field}"${busy ? ' disabled' : ''}>${placeholder ? `<option value="">${placeholder}</option>` : ''}${rows.map(row => `<option value="${esc(row.value)}"${String(selected ?? '') === String(row.value) ? ' selected' : ''}>${esc(row.label)}</option>`).join('')}</select></label>`;
    function stopPoll() { if (timer) clearTimeout(timer); timer = null; }
    function schedule() {
      stopPoll();
      if (active && !disposed && !busy && !editorBusy() && !hasDraft() && !editingApi && flow && waiting(flow.phase) && !error)
        timer = setTimeout(() => { void inspect(true); }, 2000);
    }
    function accept(value) {
      if (!value || !value.id || selectedId && value.id !== selectedId) throw new Error('返回的客户端与当前选择不一致。');
      flow = value; selectedId = value.id; resetEditorReadiness(); const at = games.findIndex(row => row.id === value.id);
      if (at < 0) games.push(value); else games[at] = value;
      form = {}; options.onChanged?.(value); schedule();
    }
    function resetEditorReadiness() {
      editorReadiness = null;
      const entry = editor();
      // The new flow supersedes every assessment already started by its
      // retained editor, including responses still in flight and cached renders.
      if (entry) {
        entry.readinessCutoff = entry.controller.getState().assessmentOrder ?? -1;
        entry.controller.updateLaunchReadiness?.(flow.gameId, flow?.launch?.readiness || flow?.launchReadiness || flow?.installation?.launchReadiness);
      }
    }
    function launchReadiness() {
      const value = editorReadiness?.state ? editorReadiness : flow?.launch?.readiness || flow?.launchReadiness || flow?.installation?.launchReadiness;
      return value?.state ? value : null;
    }
    function readinessBlocked() { const info = launchReadiness(); return info?.state === 'blocked' || info?.state === 'unknown' && Array.isArray(info.blockers) && info.blockers.length > 0; }
    function readinessNeedsNotice() { const info = launchReadiness(); return readinessBlocked() || info?.state === 'unknown'; }
    function readinessBlocker() {
      const info = launchReadiness();
      return Array.isArray(info?.blockers) ? info.blockers.find(row => row && row.message) || info.blockers[0] || null : null;
    }
    function readinessActionKind() {
      const action = readinessBlocker()?.action;
      return typeof action === 'string' ? action : action?.kind || null;
    }
    function readinessMessage() {
      const info = launchReadiness(), blocker = readinessBlocker();
      if (!info || !readinessNeedsNotice()) return '';
      if (info.state === 'unknown' && !blocker && info.source === 'metadata') return '已保存设置；启动时会检查当前状态。';
      return (blocker?.message ? errorText(blocker) : '') || (info.state === 'unknown' ? '启动前状态暂时无法确认，请重新检查设置。' : '启动前还有需要处理的设置。');
    }
    function readinessActionLabel() {
      const kind = readinessActionKind();
      if (kind === 'recover') return '恢复未完成操作';
      if (kind === 'migrate') return '前往补帧设置';
      if (kind === 'reapply') return '重新预览设置';
      if (kind === 'open-settings') return '前往超分补帧设置';
      return launchReadiness()?.state === 'unknown' ? '重新检查启动条件' : '处理启动前设置';
    }
    function currentAction() {
      if (busy) return button('working', currentWork, true, true);
      if (!flow) return '';
      if (waitingForExit()) return button('waiting-exit', '等待游戏退出', true, true);
      if (hasDraft()) return button('apply-editor', '应用', true, busy || flow.busy || editorBusy());
      const disabled = busy || flow.busy || editorBusy() || hasDraft();
      if (editingApi) return button('confirm-api', '确认图形 API', true, disabled || !['dx11', 'dx12'].includes(form.api) || form.api === flow.api?.api) + button('cancel-api', '取消修改', false, disabled);
      if (flow.nextAction === 'recover' || flow.phase === 'recovery') return button('recover', '恢复未完成操作', true, disabled);
      if (error || flow.error || flow.installation?.error || flow.phase === 'failed') return button('inspect', '重新检查', true, disabled);
      if (flow.nextAction === 'bind') return button('bind', '确认绑定', true, disabled || !((form.launcherId || flow.binding?.launcher?.id) && (!(flow.binding?.channels?.length > 1) || form.channel || flow.channel)));
      if (flow.nextAction === 'select-api') return button('bind', '确认图形 API', true, disabled || !['dx11', 'dx12'].includes(form.api));
      if (flow.nextAction === 'preview-install') return button('preview-install', '应用', true, disabled);
      if (flow.nextAction === 'start') { const blocked = readinessBlocked(); return button(blocked ? 'resolve-readiness' : 'start', blocked ? readinessActionLabel() : '启动', true, disabled || !flow.installation?.ready); }
      if (flow.nextAction === 'recover') return button('recover', '恢复未完成操作', true, disabled);
      if (flow.nextAction === 'wait' || waiting(flow.phase)) return button('cancel', '取消等待', false, disabled);
      return button('inspect', '重新检查', true, disabled);
    }
    function bindingFields() {
      if (!flow || !editingApi && !['binding', 'api'].includes(flow.phase)) return '';
      const bindingMode = !editingApi && flow.phase === 'binding';
      const binding = flow.binding || {}, channels = binding.channels || [], available = binding.launchers?.length ? binding.launchers : launchers;
      const rows = available.map(row => ({ value: row.id, label: `${row.kind === 'starward' ? 'Starward' : 'HoYoPlay'} · ${row.path}` }));
      return `<div class="hoyo-binding gp-controls">${bindingMode ? select('launcherId', '对应启动器', rows, form.launcherId || binding.launcher?.id, '选择启动器') +
        (channels.length > 1 ? select('channel', '游戏客户端', channels.map(row => ({ value: channelValue(row), label: channelLabel(row) })), form.channel || flow.channel, '选择客户端') : '') :
        select('api', '游戏图形 API', [{ value: 'dx11', label: 'DirectX 11' }, { value: 'dx12', label: 'DirectX 12' }], form.api, '按游戏实际设置选择')}
        ${bindingMode ? button('pick-launcher', '选择启动器文件', false, busy) : ''}</div>`;
    }
    function evidence() {
      if (!flow || !flow.installation?.installed && !flow.session) return '';
      return `<details class="gp-section gp-diagnostics-details hoyo-evidence" data-hoyo-detail="evidence"><summary>${flow.session && !flow.session.historical ? '本次运行核验' : '最近运行记录'}</summary><div class="gp-verification">${[['reshade', 'ReShade'], ['core', 'Core'], ['nr', 'NR 处理']].map(([key, label]) => {
        const row = flow.verification?.[key], text = verificationLabel(row);
        return `<article><h4>${label}</h4><span class="badge ${row?.state === 'passed' ? 'good confirmed' : ['failed', 'blocked'].includes(row?.state) ? 'bad' : ''}">${text}</span>${row?.detail ? `<p>${esc(row.detail)}</p>` : ''}</article>`;
      }).join('')}</div><p class="gp-caption">ReShade、Core 与 NR 分别核验；画面效果请在游戏内对照。</p></details>`;
    }
    const ready = () => !busy && !flow?.busy && !error && !flow?.error && !flow?.installation?.error && !editingApi && flow?.phase === 'ready' && flow?.nextAction === 'start' && flow?.installation?.ready;
    function phaseLabel(row) {
      const readiness = row.id === selectedId ? launchReadiness() : row.launchReadiness;
      if (row.phase === 'ready' && !(row.id === selectedId && (busy || editingApi || error))) {
        if (readiness?.state === 'blocked' || readiness?.state === 'unknown' && readiness.blockers?.length) return '启动前需要处理';
        if (readiness?.state === 'unknown') return '启动时检查设置';
      }
      return row.id === selectedId && busy ? currentWork : PHASES[row.id === selectedId && editingApi ? 'api' : row.error || row.installation?.error || row.id === selectedId && error ? 'failed' : row.phase]?.[0] || '待检查';
    }
    function maintenance() {
      const disabled = busy || editorBusy() || hasDraft() || editingApi || waiting(flow.phase);
      return `<details class="gp-section gp-maintenance-details hoyo-details" data-hoyo-detail="maintenance"${!ready() && (flow.phase === 'recovery' || flow.error?.code === 'DEPLOYMENT_FILE_CHANGED' || flow.installation?.error?.code === 'DEPLOYMENT_FILE_CHANGED') ? ' open' : ''}><summary>启动器、API 与维护</summary><div class="gp-facts">${[['启动器', flow.binding?.launcher?.path || '尚未绑定'], ['图形 API', { dx11: 'DirectX 11', dx12: 'DirectX 12' }[flow.api?.api] || '待确认']].map(([label, value]) => `<div class="gp-fact"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('')}</div>
        <div class="gp-actions">${button('inspect', '重新检查', false, disabled)}${button('edit-api', '修改图形 API', false, disabled || !['install', 'ready'].includes(flow.phase))}${button('pick-launcher', '重新选择启动器', false, disabled)}${flow.installation?.installed ? button('preview-repair', '预览修复', false, disabled) + button('preview-restore', '预览卸载与恢复', false, disabled) : ''}</div>${!ready() && flow.gameId ? '<div class="hoyo-recovery-slot"></div>' : ''}</details>`;
    }
    function detail() {
      const phase = editingApi ? 'api' : flow.phase === 'recovery' ? 'recovery' : error || flow.error || flow.installation?.error ? 'failed' : flow.phase;
      const text = PHASES[phase] || ['检查客户端', '重新检查后继续。'];
      const description = busy ? '本次操作正在执行，完成后会显示结果。' : error || (flow.error ? errorText(flow.error) : '') || (flow.installation?.error ? errorText(flow.installation.error) : '') || (editingApi ? '按游戏实际设置选择配套路线。确认后先预览应用，再启动。' : text[1]);
      return `<div class="game-detail gp-inline hoyo-current" aria-label="当前客户端操作">${ready() ? '' : `<div class="gp-apply-bar hoyo-next-step"><div role="status"><strong>${esc(busy ? currentWork : text[0])}</strong><small>${esc(description)}</small></div><div class="hoyo-primary-actions">${currentAction()}</div></div>`}
        ${bindingFields() ? `<section class="gp-section"><h3>${editingApi || flow.phase === 'api' ? '图形 API' : '启动器绑定'}</h3>${bindingFields()}</section>` : ''}
        ${ready() ? '<div class="hoyo-settings-slot"></div>' : !busy && !['binding', 'api'].includes(phase) ? `<p class="gp-caption">${phase === 'install' ? '此客户端使用独立的 ReShade、Core 和 NR 配套。预览后再确认安装。' : ''}</p>` : ''}
        ${ready() ? '' : `<div class="hoyo-maintenance-slot">${maintenance()}${evidence()}</div>`}</div>`;
    }
    function syncEditorActions(actionState = null) {
      if (actionState && Object.hasOwn(actionState, 'readiness') && actionState.readinessOrder > (editor()?.readinessCutoff ?? -1))
        editorReadiness = actionState.readiness?.state ? actionState.readiness : null;
      const locked = editorBusy() || hasDraft();
      host.querySelector('.game-card.expanded')?.classList.toggle('has-pending-draft', hasDraft());
      const status = host.querySelector(`[data-hoyo-card="${selectedId}"] [data-hoyo-status]`);
      if (status && flow) { status.textContent = editorBusy() ? '正在处理设置…' : hasDraft() ? '有修改待应用' : readinessBlocked() ? '启动前需要处理' : readinessNeedsNotice() ? '启动时检查设置' : phaseLabel(flow); status.classList.toggle('good', !locked && ready() && !readinessNeedsNotice()); }
      host.setAttribute('aria-busy', String(busy || editorBusy()));
      const start = host.querySelector('[data-hoyo-action="start"]');
      if (start) { start.disabled = locked || !ready() || readinessBlocked() || waitingForExit(); start.classList.toggle('primary', !locked && !readinessBlocked()); }
      const header = host.querySelector('.hoyo-header-action'); if (header && flow && ready()) { header.innerHTML = currentAction(); const headerStart = header.querySelector('[data-hoyo-action="start"]'); if (headerStart) { headerStart.disabled = locked || !ready() || readinessBlocked(); headerStart.classList.toggle('primary', !locked && !readinessBlocked()); } }
      const primary = host.querySelector('.hoyo-primary-actions'); if (primary && flow && !ready()) primary.innerHTML = currentAction();
      if (header) header.hidden = expanded && ready();
      for (const node of host.querySelectorAll('.hoyo-details [data-hoyo-action],.library-actions [data-hoyo-action]')) node.disabled = locked || busy || editingApi || node.closest('.hoyo-details') && waiting(flow?.phase) || node.dataset.hoyoAction === 'edit-api' && !['install', 'ready'].includes(flow?.phase);
      feedback?.update();
    }
    function render() {
      if (disposed) return;
      const view = host.closest('.view'), top = view?.scrollTop;
      const openDetails = [...host.querySelectorAll('[data-hoyo-detail][open]')].map(row => row.dataset.hoyoDetail);
      for (const entry of [...editors.values(), ...recoveryEditors.values()]) entry.element.remove();
      host.innerHTML = `<div class="library-header"><p class="summary">${discovering ? '正在发现本机客户端…' : `共 ${games.length} 个客户端 · 自动匹配已安装的启动器`}</p><div class="library-actions">${button('pick-game', '选择游戏程序', !games.length, busy || editorBusy() || hasDraft())}${button('discover', '重新扫描', false, busy || editorBusy() || hasDraft())}</div></div>
        ${warnings.length ? `<details class="gp-section hoyo-discovery-notes"><summary>发现提示 ${warnings.length}</summary>${warnings.map(row => `<p class="gp-caption">${esc(errorText(row))}</p>`).join('')}</details>` : ''}
        <div class="game-list" aria-label="米哈游客户端">${games.map(row => {
          const current = row.id === selectedId, opened = current && expanded, failed = row.error || row.installation?.error || current && error;
          return `<article class="game-card hoyo-game-card${opened ? ' expanded' : ''}" data-hoyo-card="${esc(row.id)}"><div class="game-card-head" data-hoyo-client="${esc(row.id)}"><div class="poster hoyo-poster" aria-hidden="true"><span class="nav-icon nav-icon-hoyo"></span></div><div class="game-meta"><div class="game-title"><h3>${esc(row.name)}</h3><span class="badge ${failed ? 'bad' : row.installation?.ready && !(current && busy) ? 'good' : ''}" data-hoyo-status>${esc(phaseLabel(row))}</span></div><p>${esc(row.channelLabel || '客户端待确认')} · ${esc({ dx11: 'DirectX 11', dx12: 'DirectX 12' }[row.api?.api] || 'API 待确认')}${row.gameVersion ? ` · ${esc(row.gameVersion)}` : ''}</p><p class="game-exe-path" title="${esc(row.exePath)}">${esc(row.exePath)}</p></div><div class="card-action">${current && ready() ? `<div class="hoyo-header-action">${currentAction()}</div>` : ''}<button type="button" class="button subtle" data-hoyo-toggle="${esc(row.id)}"${busy || editorBusy() ? ' disabled' : ''}>${row.installation?.installed ? '设置' : '安装与设置'}</button><button class="expand-arrow" type="button" data-hoyo-toggle="${esc(row.id)}" aria-label="展开或收起游戏详情" aria-expanded="${opened}"${busy || editorBusy() ? ' disabled' : ''}></button></div></div>${opened ? detail() : ''}</article>`;
        }).join('') || `<div class="empty"><h3>${busy ? '正在发现本机客户端' : error ? '本次发现未完成' : '还没有找到米哈游游戏'}</h3><p>${esc(error || '可选择原神、崩坏：星穹铁道或绝区零的游戏程序。')}</p></div>`}</div>`;
      host.setAttribute('aria-busy', String(busy));
      if (expanded && ready()) openSettings();
      for (const key of openDetails) { const node = host.querySelector(`[data-hoyo-detail="${key}"]`); if (node) node.open = true; }
      openRecoveryTools();
      syncEditorActions();
      if (top !== undefined) view.scrollTop = top;
      if (plan) renderPlan();
    }
    function closeSettings() {
      if (editorBusy()) return;
      expanded = false; render(); schedule();
      host.querySelector(`[data-hoyo-toggle="${selectedId}"]`)?.focus();
    }
    function removedGame(gameId) {
      for (const cache of [editors, recoveryEditors]) { cache.get(gameId)?.controller.dispose(); cache.delete(gameId); }
      games = games.filter(row => row.gameId !== gameId);
      if (flow?.gameId === gameId) { flow = null; selectedId = null; expanded = false; plan = null; error = ''; }
      render();
    }
    function openRecoveryTools() {
      const slot = host.querySelector('.hoyo-recovery-slot');
      if (!slot || !flow?.gameId || !slot.closest('details')?.open) return;
      let entry = recoveryEditors.get(flow.gameId);
      if (!entry) {
        const element = document.createElement('div'), clientId = flow.id, gameId = flow.gameId;
        element.className = 'hoyo-recovery-host'; slot.append(element);
        const controller = scope.GamePageUi.mount(element, api, { maintenanceOnly: true, hoyoSettingsOnly: true, compatibilityFeedbackOwned: true,
          onActionState: () => syncEditorActions(), onRemoved: removedGame,
          onChanged: async () => { const value = unwrap(await api.hoyoInspect(clientId)); if (flow?.gameId === gameId) { accept(value); await editors.get(gameId)?.controller.refresh(true); render(); } } });
        entry = { element, controller }; recoveryEditors.set(gameId, entry);
        void controller.open(gameId);
      } else slot.append(entry.element);
    }
    host.addEventListener('toggle', event => { if (event.target.matches?.('[data-hoyo-detail="maintenance"]') && event.target.open) openRecoveryTools(); }, true);
    function openSettings() {
      const slot = host.querySelector('.hoyo-settings-slot'); if (!slot || !flow?.gameId) return;
      let entry = editor();
      if (!entry) {
        const element = document.createElement('div'); element.className = 'hoyo-settings-host'; slot.append(element);
        const id = flow.id, gameId = flow.gameId, controller = scope.GamePageUi.mount(element, api, { hoyoSettingsOnly: true, compatibilityFeedbackOwned: Boolean(feedback), onBack: closeSettings, onRemoved: removedGame,
          onLaunch: async () => { if (!ready() || waitingForExit() || hasDraft()) return; return run(() => api.hoyoStart(selectedId), true, '正在准备启动…'); },
          onActionState: state => { if (!disposed && selectedId === id && flow?.gameId === gameId && editors.get(gameId)?.element === element) syncEditorActions(state); }, maintenanceContent: () => maintenance() + evidence(),
          onChanged: async () => { try { const value = unwrap(await api.hoyoInspect(id)); if (selectedId === id) { accept(value); render(); } } catch (failure) { error = errorText(failure); render(); } } });
        entry = { element, controller }; editors.set(flow.gameId, entry);
        void controller.open(flow.gameId, 'overview', { game: { id: flow.gameId, name: flow.name, installed: true, chosen: { path: flow.exePath, apiResolution: { api: flow.api?.api } } } });
      } else slot.append(entry.element);
    }
    function renderPlan() {
      host.querySelector('.gp-modal')?.remove();
      const consent = plan.requiresAntiCheat === true || plan.deployment?.requiresAntiCheat === true;
      host.insertAdjacentHTML('beforeend', `<div class="gp-modal" role="dialog" aria-modal="true" aria-label="米哈游操作预览"><div class="gp-modal-card"><h3>确认本次变更</h3>${scope.GamePageUi.adoptionMarkup?.(plan, 'hoyo') || ''}${scope.GamePageUi.nrConflictMarkup?.(plan) || ''}<p>${esc(flow?.name)} · 核对后一次应用。</p>${plan.nrConflicts?.required ? '<details><summary>完整变更清单</summary>' : ''}<div class="gp-change-list">${(plan.changes || []).map(row => `<div><strong>${esc(row.name || row.key || row.role || row.action)}</strong><span>${esc(({ create: '新增', replace: '替换', remove: '移除', keep: '保留' })[row.action] || row.description || row.action)}</span>${row.path ? `<small>${esc(row.path)}</small>` : ''}</div>`).join('')}</div>${plan.nrConflicts?.required ? '</details>' : ''}${(plan.blockers || []).map(row => `<p class="gp-message error">${esc(errorText(row))}</p>`).join('')}${plan.requiresElevation ? '<p>应用时会显示 Windows 权限确认，完成后管理器继续以普通权限运行。</p>' : ''}${consent ? '<label class="check-line gp-check"><input type="checkbox" data-hoyo-consent>我已了解反作弊可能阻止加载及账号风险，并决定应用。</label>' : ''}<p class="hoyo-plan-message gp-message" role="status" hidden></p><div class="gp-modal-actions">${button('close-plan', '取消', false, busy)}${button('apply', plan.nrConflicts?.required ? '备份冲突并应用' : '应用本次变更', true, busy || Boolean(plan.blockers?.length))}</div></div></div>`);
      host.querySelector('[data-hoyo-action="close-plan"]')?.focus();
    }
    async function run(work, applyValue = true, label = '正在检查…') {
      if (busy || disposed) return; busy = true; expanded = true; currentWork = label; error = ''; stopPoll(); render(); const token = ++generation;
      try { const result = unwrap(await work()); if (disposed || generation !== token) return; if (applyValue) accept(result); return result; }
      catch (failure) { if (!disposed && generation === token) error = errorText(failure); }
      finally { if (!disposed && generation === token) { busy = false; currentWork = ''; render(); schedule(); } }
    }
    async function discover() {
      discovering = true;
      await run(async () => { const result = await api.hoyoDiscover(); if (result?.ok === true) {
        const value = result.value; games = value.games || []; launchers = value.launchers || []; warnings = value.warnings || [];
        selectedId = games.some(row => row.id === selectedId) ? selectedId : games[0]?.id || null; flow = games.find(row => row.id === selectedId) || null; resetEditorReadiness(); form = {};
        for (const game of games) options.onChanged?.(game);
      } return result; }, false, '正在发现本机客户端…'); discovering = false; render(); schedule();
    }
    async function inspect(passive = false) {
      if (!flow || busy) return;
      if (!passive) return run(() => api.hoyoInspect(selectedId, { retry: true }));
      const token = generation, requestedId = selectedId;
      try { const value = unwrap(await api.hoyoInspect(requestedId)); if (!disposed && active && generation === token && selectedId === requestedId) { accept(value); render(); } }
      catch (failure) { if (!disposed && generation === token && selectedId === requestedId) { error = errorText(failure); render(); } }
      finally { schedule(); }
    }
    host.addEventListener('change', event => { const field = event.target.dataset.hoyoField; if (!field || busy) return; form[field] = event.target.value; const region = host.querySelector('.hoyo-primary-actions'); if (region) region.innerHTML = currentAction(); });
    host.addEventListener('click', async event => {
      const client = event.target.closest('[data-hoyo-client]');
      if (client && !event.target.closest('[data-hoyo-action]') && !busy && !editorBusy()) {
        if (selectedId === client.dataset.hoyoClient) { expanded = !expanded; render(); schedule(); return; }
        generation++; stopPoll(); selectedId = client.dataset.hoyoClient; flow = games.find(row => row.id === selectedId); resetEditorReadiness(); expanded = true; form = {}; editingApi = false; error = ''; plan = null; render(); await inspect(); return;
      }
      const item = event.target.closest('[data-hoyo-action]'); if (!item || item.disabled || busy || editorBusy()) return;
      const action = item.dataset.hoyoAction;
      if (hasDraft() && !['close-plan', 'apply-editor'].includes(action)) return;
      if (action === 'apply-editor') { expanded = true; render(); return editor()?.controller.runPrimary(); }
      if (action === 'edit-api') { editingApi = true; form = { api: flow.api?.api || '' }; error = ''; stopPoll(); render(); host.querySelector('[data-hoyo-field="api"]')?.focus(); return; }
      if (action === 'cancel-api') { editingApi = false; form = {}; error = ''; render(); schedule(); return; }
      if (action === 'confirm-api') {
        const selected = form.api; if (!editingApi || !['dx11', 'dx12'].includes(selected)) return;
        const result = await run(() => api.hoyoBind(selectedId, { api: selected }), true, '正在保存图形 API…');
        if (result) { editingApi = false; form = {}; render(); schedule(); } return;
      }
      if (editingApi && ['start', 'bind', 'preview-install', 'preview-repair', 'preview-restore'].includes(action)) return;
      if (action === 'discover') return discover();
      if (action === 'inspect') return inspect();
      if (action === 'pick-game') { const result = await run(() => api.hoyoPickGame(), false, '正在选择游戏程序…'); if (result && !result.cancelled) { if (result.discovery?.id) { selectedId = result.discovery.id; accept(result.discovery); } await discover(); } return; }
      if (action === 'pick-launcher') return run(() => api.hoyoPickLauncher(selectedId), true, '正在选择启动器…');
      if (action === 'bind') return run(() => api.hoyoBind(selectedId, { ...form }), true, '正在保存客户端绑定…');
      if (action.startsWith('preview-')) { const requested = action.slice(8), result = await run(() => api.hoyoPreview(selectedId, requested), false, '正在准备操作预览…'); if (result) { plan = result; previewAction = requested; renderPlan(); } return; }
      if (action === 'close-plan') { plan = null; host.querySelector('.gp-modal')?.remove(); return; }
      if (action === 'resolve-readiness') {
        const kind = readinessActionKind();
        // The outer HoYo card can be collapsed while its lightweight flow
        // still exposes a launch blocker. Open the card first, create the
        // shared editor, then let that editor wait for installation readiness
        // and route to the owning tab.
        if (!expanded) { expanded = true; render(); }
        if (!editor()?.controller) openSettings();
        const controller = editor()?.controller;
        if (controller?.resolveReadiness) await controller.resolveReadiness();
        else if (controller) controller.selectTab(kind === 'recover' ? 'maintenance' : 'enhance');
        else await inspect();
        return;
      }
      if (action === 'repreview-proxy') {
        const choice = host.querySelector('[data-hoyo-adoption-proxy]')?.value;
        const selected = choice === '' || choice === undefined ? null : plan?.adoption?.hosts?.filter(row => row.kind === 'unknown-proxy')[Number(choice)];
        if (!selected) { const notice = host.querySelector('.hoyo-plan-message'); notice.textContent = '请先选择允许备份替换的具体入口。'; notice.hidden = false; return; }
        const adoption = { replaceProxy: { path: selected.path, sha256: selected.sha256, configFingerprint: plan.adoption.configFingerprint } };
        const result = await run(() => api.hoyoPreview(selectedId, previewAction, { ...(plan.request?.version ? { version: plan.request.version } : {}), adoption }), false, '正在重新核对所选入口…');
        if (result) { plan = result; renderPlan(); } return;
      }
      if (action === 'apply') {
        const saved = plan; if (!saved) return; const allowAntiCheat = host.querySelector('[data-hoyo-consent]')?.checked === true;
        if ((saved.requiresAntiCheat === true || saved.deployment?.requiresAntiCheat === true) && !allowAntiCheat) {
          const message = host.querySelector('.hoyo-plan-message'); message.textContent = '请先确认已了解本次游戏的反作弊提示。'; message.hidden = false; return;
        }
        const label = previewAction === 'restore' ? '正在卸载并恢复…' : previewAction === 'repair' ? '正在修复配套…' : '正在应用安装…';
        editor()?.controller.dispose(); editors.delete(flow.gameId);
        plan = null; return run(() => api.hoyoApply(selectedId, saved.planId, { confirm: true, fingerprint: saved.fingerprint, allowAntiCheat }), true, label);
      }
      if (action === 'start') { if (!ready() || waitingForExit()) return; return run(() => api.hoyoStart(selectedId), true, '正在准备启动…'); }
      if (action === 'cancel') return run(() => api.hoyoCancel(selectedId), true, '正在取消等待…');
      if (action === 'recover') return run(() => api.hoyoRecover(selectedId), true, '正在恢复未完成操作…');
    });
    host.addEventListener('keydown', event => {
      if (editingApi && event.key === 'Escape' && !busy) { editingApi = false; form = {}; error = ''; render(); schedule(); return; }
      if (!plan) return;
      if (event.key === 'Escape' && !busy) { plan = null; host.querySelector('.gp-modal')?.remove(); }
      if (event.key === 'Tab') {
        const buttons = [...host.querySelectorAll('.gp-modal button:not([disabled]),.gp-modal input:not([disabled])')], first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus(); }
      }
    });
    render();
    return { activate() { active = true; if (!games.length) return discover(); render(); schedule(); }, deactivate() { active = false; stopPoll(); feedback?.update(); },
      refresh: discover, getState: () => ({ selectedId, flow, games, busy, error, plan, editingApi, currentWork, expanded }), dispose() { disposed = true; generation++; stopPoll(); feedback?.dispose(); for (const entry of [...editors.values(), ...recoveryEditors.values()]) entry.controller.dispose(); } };
  }
  const api = { mount, verificationLabel };
  if (typeof module === 'object' && module.exports) module.exports = api; else scope.HoYoPageUi = api;
})(typeof window === 'object' ? window : globalThis);
