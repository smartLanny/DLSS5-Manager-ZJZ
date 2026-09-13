'use strict';
(function (scope) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const unwrap = response => {
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message || '操作未完成。'), response?.error || {});
    return response.value;
  };
  let current = null;
  function open(options) {
    if (current) return current;
    let game = options.game, busy = false, info = null, plan = null, message = '', error = false;
    let mode = game.installed ? 'repair' : 'clean';
    const selected = new Set(), manager = options.manager || scope.manager;
    const previousFocus = scope.document.activeElement;
    const overlay = scope.document.createElement('div'); overlay.className = 'maintenance-overlay';
    overlay.innerHTML = '<section class="maintenance-card" role="dialog" aria-modal="true" aria-label="维护与恢复" tabindex="-1"></section>';
    scope.document.body.appendChild(overlay);
    const card = overlay.firstElementChild;
    const installed = () => game.installed || game.feeder?.installed || game.vulkan?.installed;
    function close() { if (busy) return; overlay.remove(); current = null; previousFocus?.focus?.({ preventScroll: true }); }
    function render() {
      const disabled = busy ? ' disabled' : '';
      const pending = info?.pending === true;
      const modes = [
        ['repair', '修复当前安装', '补齐并校验本管理器的组件，保留你的参数设置。', !installed()],
        ['restore', '恢复安装前状态', '撤销本管理器的安装；原来就有的 ReShade、其他插件仍会保留。', !installed()],
        ['clean', '尝试恢复干净环境', '先恢复本管理器的安装，再检查外部图形代理和 Add-on，由你确认后备份隔离。', info?.isolated]
      ];
      card.innerHTML = `<div class="maintenance-heading"><div><h3>维护与恢复</h3><p>${esc(game.name)}</p></div><button class="button subtle" type="button" data-maintenance-action="close"${disabled}>关闭</button></div>
        ${message ? `<p class="maintenance-message${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">${esc(message)}</p>` : ''}
        ${plan ? `<div class="maintenance-preview"><h4>确认要隔离的外部组件</h4><p>本管理器配套已恢复到安装前状态，下面的文件尚未移动。关闭此窗口不会重新安装配套。</p>${plan.candidates.length ? `<div class="maintenance-files">${plan.candidates.map(row => `<label class="maintenance-file"><input type="checkbox" data-maintenance-file="${esc(row.name)}"${selected.has(row.name) ? ' checked' : ''}${busy || !row.selectable ? ' disabled' : ''}><span><strong>${esc(row.name)}</strong><small>${esc(row.kind)} · ${Math.ceil(row.bytes / 1024)} KB</small><small>${esc(row.note)}</small></span></label>`).join('')}</div>` : '<p>没有发现可列入清理的同目录图形代理或 Add-on。</p>'}<p class="config-note">${esc(plan.scope)}</p><button class="button primary maintenance-apply" type="button" data-maintenance-action="apply"${busy || !selected.size ? ' disabled' : ''}>${busy ? '正在处理…' : `备份并隔离 ${selected.size} 项`}</button></div>` : `<div class="maintenance-modes">${modes.map(([value, title, detail, unavailable]) => `<label class="maintenance-mode${mode === value ? ' selected' : ''}"><input type="radio" name="maintenance-mode" value="${value}"${mode === value ? ' checked' : ''}${busy || pending || unavailable ? ' disabled' : ''}><span><strong>${title}</strong><small>${detail}</small></span></label>`).join('')}</div>
        ${mode === 'clean' && !pending ? '<p class="config-note">清理分两步：先撤销本管理器，再确认外部文件。文件会移入备份，不会永久删除；不会清理游戏本体、存档或原生 DLSS。</p>' : ''}
        ${!pending ? `<button class="button primary maintenance-start" type="button" data-maintenance-action="start"${busy || !info || (mode !== 'clean' && !installed()) || (mode === 'clean' && info.isolated) ? ' disabled' : ''}>${busy ? '正在处理…' : mode === 'repair' ? '开始修复' : mode === 'restore' ? '恢复安装前状态' : '恢复并检查外部组件'}</button>` : ''}`}
        ${info?.canRestore && !plan ? `<div class="maintenance-undo"><p>${pending ? '上次环境操作未完成，请先恢复。' : `上次隔离了 ${info.files?.length || 0} 项组件，备份仍在。`}</p><button class="button" type="button" data-maintenance-action="undo"${disabled}>${pending ? '恢复未完成环境操作' : '撤销环境清理'}</button>${info.backupDirectory ? `<small class="path-line">备份：${esc(info.backupDirectory)}</small>` : ''}</div>` : ''}
        ${!plan && !installed() && info?.remainingFiles?.length ? `<div class="maintenance-residuals"><h4>当前目录仍有 ${info.remainingFiles.length} 项代理或插件</h4><p>以下文件仍在游戏目录中，不会因为管理器显示未安装就被忽略。选择上方环境清理可检查并备份隔离。</p><ul>${info.remainingFiles.map(row => `<li>${esc(row.name)}${row.legacyNr ? ' · DLSS 5 / NR 历史核心' : ''}</li>`).join('')}</ul></div>` : ''}
        <div class="maintenance-footer"><span>恢复安装前 ≠ 恢复游戏原版</span><button class="button subtle" type="button" data-maintenance-action="feedback"${disabled}>保存反馈</button></div>`;
    }
    async function refreshGame() {
      const updated = await options.onChanged?.(game.id);
      if (updated) game = updated;
      info = unwrap(await manager.inspectEnvironment(game.id));
    }
    async function perform(action) {
      if (busy) return;
      busy = true; error = false; message = ''; render();
      try {
        if (action === 'start' && mode === 'repair') {
          let response = await manager.repair(game.id, { allowAntiCheat: false });
          if (response?.error?.code === 'ERR_ANTI_CHEAT_CONFIRM') {
            if (!scope.confirmAntiCheat || !await scope.confirmAntiCheat(game.id)) throw new Error('已取消修复。');
            response = await manager.repair(game.id, { allowAntiCheat: true });
          }
          unwrap(response); message = '修复操作已完成，实际文件检查结果显示在安装状态中。';
        } else if (action === 'start' && mode === 'restore') {
          const result = unwrap(await manager.uninstall(game.id, false));
          if (result?.removed === false) throw new Error('恢复未完成，请保留记录并保存反馈。');
          message = result.notice || '已恢复安装前状态；原有的其他插件没有被清理。';
        } else if (action === 'start' && mode === 'clean') {
          plan = unwrap(await manager.prepareEnvironmentCleanup(game.id));
          selected.clear(); for (const row of plan.candidates) if (row.selectable && row.selectedByDefault) selected.add(row.name);
          message = plan.restorationNotice || '本管理器的安装已撤销，请确认下面的外部文件。';
        } else if (action === 'apply' && plan) {
          const result = unwrap(await manager.applyEnvironmentCleanup(game.id, plan.planId, [...selected]));
          message = `✓ 已备份隔离 ${result.files.length} 项：${result.files.join('、')}。${result.message}`; plan = null;
        } else if (action === 'undo') {
          const result = unwrap(await manager.restoreEnvironment(game.id));
          message = result.message || '环境恢复操作已完成，请核对文件状态。'; plan = null;
        }
        await refreshGame();
      } catch (cause) {
        message = `${cause.message}${cause.code ? ` [${cause.code}]` : ''}`; error = true;
        // The first cleanup step may have completed before a later check
        // failed. Read the actual state instead of implying it was untouched.
        try { await refreshGame(); } catch {}
        if (action === 'apply') plan = null;
      } finally { busy = false; render(); }
    }
    overlay.onclick = event => {
      const button = event.target.closest('[data-maintenance-action]'); if (!button || button.disabled) return;
      const action = button.dataset.maintenanceAction;
      if (action === 'close') close();
      else if (action === 'feedback') { close(); options.onFeedback?.(game.id); }
      else void perform(action);
    };
    overlay.onchange = event => {
      if (busy) return;
      if (event.target.name === 'maintenance-mode') { mode = event.target.value; message = ''; error = false; render(); }
      else if (event.target.dataset.maintenanceFile) {
        const name = event.target.dataset.maintenanceFile;
        if (event.target.checked) selected.add(name); else selected.delete(name);
        const button = card.querySelector('.maintenance-apply'); button.disabled = !selected.size; button.textContent = `备份并隔离 ${selected.size} 项`;
      }
    };
    overlay.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const elements = [...card.querySelectorAll('button:not([disabled]), input:not([disabled])')];
        if (!elements.length) { event.preventDefault(); return; }
        if (event.shiftKey && scope.document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1).focus(); }
        else if (!event.shiftKey && scope.document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus(); }
      }
    };
    render(); card.focus();
    const ready = (async () => {
      try { info = unwrap(await manager.inspectEnvironment(game.id)); }
      catch (cause) { message = `环境状态读取失败：${cause.message}`; error = true; }
      render();
    })();
    current = { ready, close, element: overlay, get busy() { return busy; } };
    return current;
  }
  scope.gameMaintenanceUi = Object.freeze({ open });
})(window);
