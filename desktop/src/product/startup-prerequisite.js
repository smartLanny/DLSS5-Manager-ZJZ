'use strict';

const path = require('node:path');
const { inspectVcRuntime } = require('./windows-runtime');

const VC_REDIST_HELP = 'https://learn.microsoft.com/vi-vn/cpp/windows/latest-supported-vc-redist?view=msvc-170';

function createStartupPrerequisite(options = {}) {
  const inspect = options.inspect || inspectVcRuntime;
  const dialog = options.dialog;
  const shell = options.shell;
  const platform = options.platform || process.platform;
  const executable = options.executable || process.execPath;

  async function ensureReady() {
    const applicationDirectory = typeof executable === 'string' && path.isAbsolute(executable)
      ? path.dirname(executable) : undefined;
    const result = inspect({ platform, applicationDirectory });
    if (result.status !== 'missing') return { proceed:true, prompted:false, result };

    const localInvalid = result.repair === 'game-files';
    const detail = localInvalid
      ? `程序目录中的 ${result.missing.join('、')} 无效或不是 x64 版本。请重新解压完整管理器；安装系统运行库不会替换这些文件。`
      : `缺少 ${result.missing.join('、')}。这些文件用于加载 Core、Bridge、Feeder 等原生组件；管理器便携包本身不捆绑 Windows 运行库。`;
    const buttons = localInvalid
      ? ['知道了并关闭', '仍然启动']
      : ['打开微软官方下载页', '仍然启动', '关闭'];
    const selected = await dialog.showMessageBox({
      type:'warning', title:'需要 Windows 运行库',
      message:localInvalid ? '管理器目录中的运行库文件无效' : '缺少 Microsoft Visual C++ x64 运行库',
      detail, buttons, defaultId:0, cancelId:localInvalid ? 0 : 2, noLink:true
    });
    if (!localInvalid && selected.response === 0) {
      await shell.openExternal(VC_REDIST_HELP);
      return { proceed:false, prompted:true, action:'official-download', result };
    }
    if (selected.response === 1) return { proceed:true, prompted:true, action:'continue', result };
    return { proceed:false, prompted:true, action:'close', result };
  }

  return { ensureReady };
}

module.exports = { VC_REDIST_HELP, createStartupPrerequisite };
