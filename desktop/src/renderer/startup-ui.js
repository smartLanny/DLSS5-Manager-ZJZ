'use strict';

(function (root) {
  function attach(document, manager) {
    const panel = document.getElementById('startupSettings');
    if (!panel) return null;
    const mode = document.getElementById('startupMode');
    const privilege = document.getElementById('startupPrivilege');
    const note = document.getElementById('startupModeNote');
    const message = document.getElementById('startupMessage');
    const refreshButton = document.getElementById('startupRefreshBtn');
    const recoveryButton = document.getElementById('startupOperationRecoveryBtn') || document.getElementById('startupRestartAdminBtn');
    let context = null, busy = false;

    function showMessage(text, error = false) {
      message.textContent = text;
      message.classList.toggle('error', error);
      message.setAttribute('role', error ? 'alert' : 'status');
    }
    function render() {
      const compatible = context?.mode === 'compatibility' || context?.sandbox === false;
      mode.textContent = context ? compatible ? '临时兼容启动' : '正常启动 · 默认沙箱' : '暂未确认';
      privilege.textContent = { standard: '普通权限', administrator: '管理员权限', unknown: '暂未确认' }[context?.privilege] || '暂未确认';
      note.hidden = false;
      note.textContent = (compatible ? '本次通过兼容入口关闭了 Chromium 沙箱，仅用于启动排障。直接打开原 EXE 可恢复正常启动。' : '') +
        '界面正常使用普通权限；只有具体变更预览中的“本次以管理员权限应用”会请求一次提权，不会整体重启界面。';
      if (recoveryButton) {
        recoveryButton.hidden = context?.operation?.canRecover !== true;
        recoveryButton.textContent = busy ? '正在核对工作进程…' : '恢复已结束的一次性操作';
        recoveryButton.disabled = busy || context?.operation?.canRecover !== true;
      }
      refreshButton.disabled = busy;
      panel.setAttribute('aria-busy', String(busy));
    }
    function unwrap(result) {
      if (result?.ok !== true) throw new Error(result?.error?.message || '启动状态暂不可用，请运行独立的“启动诊断.cmd”。');
      return result.value;
    }
    async function refresh({ preserveMessage = false } = {}) {
      try {
        if (typeof manager?.getStartupContext !== 'function') throw new Error('当前版本未提供启动状态接口，请运行独立的“启动诊断.cmd”。');
        context = unwrap(await manager.getStartupContext());
        if (!context || !['standard', 'administrator', 'unknown'].includes(context.privilege)) throw new Error('启动状态返回不完整，请导出启动诊断。');
        if (!preserveMessage) showMessage(context.operation?.active
          ? context.operation.workerRunning ? '一次性工作进程仍在执行，请等待明确结果；当前窗口不会重复写入。' : '一次性操作尚需核对。请先恢复入口，再到游戏维护页恢复未完成操作并重新预览。'
          : context.privilege === 'unknown' ? '暂时无法确认权限，浏览界面不受影响。可导出启动诊断。' : '');
      } catch (error) {
        if (!preserveMessage) showMessage(error.message, true);
      }
      render();
    }
    async function recover() {
      if (busy || !recoveryButton || recoveryButton.disabled) return;
      busy = true; render();
      showMessage('正在核对一次性工作进程是否已经结束。');
      try {
        if (typeof manager?.recoverOperationElevation !== 'function') throw new Error('当前版本未提供一次性操作恢复接口。');
        const value = unwrap(await manager.recoverOperationElevation({ confirm: true }));
        showMessage(value.message || '入口已恢复。请先处理游戏维护页的未完成操作，再重新预览。');
      } catch (error) {
        showMessage(`未释放操作锁，当前窗口保持打开。${error.message}`, true);
      } finally {
        busy = false;
        await refresh({ preserveMessage: true });
      }
    }
    refreshButton.addEventListener('click', () => refresh());
    recoveryButton?.addEventListener('click', recover);
    const ready = refresh();
    return { ready, refresh, recover };
  }

  if (typeof module === 'object' && module.exports) module.exports = { attach };
  if (root?.document) {
    const initialize = () => attach(root.document, root.manager);
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', initialize, { once: true });
    else initialize();
  }
})(typeof window === 'object' ? window : null);
