'use strict';
const ADMINISTRATOR_PROBE = '$id=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=New-Object Security.Principal.WindowsPrincipal($id); $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'ERR_NO_WRITE_ACCESS', 'NVAPI_ACCESS_DENIED', 'NVAPI_INSUFFICIENT_PRIVILEGE']);
const PERMISSION_GUIDANCE = '请先恢复未完成操作，再重新预览；只有具体变更预览中的“本次以管理员权限应用”会请求一次提权，普通界面保持打开。本次不会自动重试。';

function createStartupElevation({ app, runPowerShell, processInfo = process, log = () => {} }) {
  let privilege = 'unknown', inspection = null;
  async function inspectPrivilege() {
    if (processInfo.platform !== 'win32') return 'standard';
    if (!inspection) inspection = (async () => {
      try {
        const value = await runPowerShell(ADMINISTRATOR_PROBE, 3000);
        if (!/^(?:true|false)$/i.test(value)) throw Error('权限检查没有返回明确结果。');
        privilege = /^true$/i.test(value) ? 'administrator' : 'standard';
        log('startup-privilege', { privilege });
      } catch (error) { privilege = 'unknown'; log('administrator-check-failed', { message: error.message }); }
      return privilege;
    })();
    return inspection;
  }
  async function context() {
    const noSandbox = app.commandLine.hasSwitch('no-sandbox');
    return { mode: noSandbox ? 'compatibility' : 'normal', sandbox: !noSandbox, privilege: await inspectPrivilege(),
      canRestartElevated: false, canElevateOperation: processInfo.platform === 'win32', elevationMode: 'one-shot-operation', restarting: false };
  }
  async function relaunchAsAdministrator() {
    throw Object.assign(Error('管理员重启入口已移除。请在具体变更预览中选择本次管理员应用；当前窗口保持普通权限。'), { code: 'STARTUP_WHOLE_APP_ELEVATION_DISABLED' });
  }
  return { context, relaunchAsAdministrator, get restarting() { return false; }, get privilege() { return privilege; } };
}
function permissionFailure(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) return false;
  return PERMISSION_CODES.has(error.code) || permissionFailure(error.cause, depth + 1) || permissionFailure(error.details?.cause, depth + 1);
}
function withPermissionRecovery(result) {
  if (result?.ok !== false || !permissionFailure(result.error)) return result;
  return { ...result, error: { ...result.error, message: `${result.error.message || '权限不足，操作未完成。'} ${PERMISSION_GUIDANCE}`,
    details: { ...result.error.details, recoveryAction: 'recover-repreview-elevated-operation', automaticRetry: false } } };
}
module.exports = { createStartupElevation, withPermissionRecovery, ADMINISTRATOR_PROBE };
