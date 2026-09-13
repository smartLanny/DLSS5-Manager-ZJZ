'use strict';
const { ensureDefaultReShadeHotkey } = require('../src/product/hotkeys');

const slash = value => value.replaceAll('\\', '/');
function overview(plan) {
  return `游戏插件手动更新包：Core ${plan.coreVersion} / Feeder ${plan.feederVersion}

这是游戏插件的更新材料，不是管理器安装包，也不是管理器“导入 OTA”功能支持的格式。
先选加载方式，再选原生或 Feeder 路线、游戏实际 API、游戏 EXE 位数和 RTX 40 / 50。只使用一套“分路线更新材料”。
Core 版本是 ${plan.coreVersion}，Feeder 版本是 ${plan.feederVersion}；管理器版本不代表插件版本。

更新前
1. 完全退出游戏及对应宿主。备份当前活动 Addon、桥接器、nrchain、NR 运行库及个人配置到加载目录以外。
2. 如果当前由管理器接管，使用管理器的完整预览和应用，让文件、备份与收据一起更新。不要用此包手动覆盖后修改收据摘要。
3. 如果旧安装由其他工具接管，先使用原工具还原，再安装完整新配套。Feeder 0.13.1 → 0.15.1 必须先还原旧接管者；不能只换 provider、宿主或 Core 中的一个。
4. 手动维护的安装按对应“目标路径清单.json”逐项处理。先移出旧 Core／旧桥接器（包括改过名字的副本），再放入本套组件；同一活动目录只保留一套。

配置与共享文件
所有 INI、CFG 和预设都在“配置参考（勿覆盖）”目录，并带 .example 后缀。不要直接覆盖个人 ReShade.ini、nr_before_sr.ini、dlss5-feed.cfg 或预设；仅按路径清单核对并合并必要项目。
新安装默认按 = 打开 ReShade 面板，对应 [INPUT] 的 KeyOverlay=187,0,0,0；已有明确自定义键保持原样。“恢复默认 =”会明确改回此键，完全重启游戏后生效。
两个体积较大的 nvngx_dlssnr.dll 仅在“共享NR运行库”各保存一次。按当前显卡族及路线清单复制到明确标出的目标目录，不能漏复制或混用 RTX 40 / 50。
“原生” Core 与 Feeder 的 ExternalProvider Core 是不同二进制，不能互换。Feeder 0.15.1 使用固定 IPC v9 配套；x86 游戏的宿主、Core 与 NR 运行库仍为 x64。

加载方式
本地原生：在当前真正生效的 Addon 目录更新组件，保留已选的 ReShade 加载入口。此包不替游戏选择新的代理 DLL。
本地 Feeder：路径基准是实际游戏 EXE 所在目录；runtime 为 EXE/_DLSS5_Feeder15，addon 为 runtime/addons。DX9 的 d3d9.dll 使用 Windows 系统 D3D9On12；包内没有 dgVoodoo 或私有系统运行库。
HoYo：只以管理器当前游戏页面显示并核验的活动运行目录为准；不猜测用户目录，不向游戏根目录放代理 DLL。原生和 Feeder 使用各自的材料，不能混装。管理器接管的目录仍须通过管理器应用。

桥接器与补帧
原生 DX11 默认是 NIGos Bridge 1.4.12 的本项目 NR 适配版。1.4.11 回退材料放在“独立组件/桥接器回退”，仅供明确需要回退时替换同名桥接器；不要将回退目录整体复制到 Addon 加载路径。原生 DX12 不安装 DX11 桥接器。
“独立组件/RTX40-MFGUnlock-0.7-zh-CN.zip”是独立补帧解锁组件，按其中说明单独操作。原生 DLSS FG 必须已可用；安装此组件不会让不支持 FG 的游戏自动获得 FG。40 系列真实游戏倍帧及其与 NR 联用仍待用户实测。

回退
退出游戏后，移出本次新增组件，恢复更新前完整组件组与个人配置。若由管理器接管，使用管理器还原，保留备份和收据；不要在其下方手动替换文件。

校验与来源
“文件校验.json”记录包内文件 SHA-256（不包含自身；外部 build-report.json 同时校验它与 ZIP）。各路线清单另有组件版本、架构、来源及目标位置。
文件校验、编译和受控样例通过不代表每款游戏或 RTX 40 已验证实际 NR／多倍补帧。路线验收状态保存在配套清单中，未验证项保持未验证。
许可证和第三方说明见“许可证与来源”。请保留原文件中的署名与许可条款。
`;
}

function routeReadme(route) {
  const lines = [route.label, '', `Core：${route.coreVersion}${route.route === 'feeder' ? `；Feeder：${route.feederVersion}` : ''}`,
    `游戏 API：${route.api.toUpperCase()}；游戏位数：${route.architecture}；显卡族：${route.hardwareFamily}`,
    `Core 接口：${route.coreInterface}。${route.route === 'feeder' ? '必须保留本套 provider、宿主（如有）、Core、nrchain 和对应运行库的完整组合。' : '使用原生 Core；不能替换成 Feeder 的 ExternalProvider Core。'}`, '', '目标位置：'];
  for (const [base, description] of Object.entries(route.bases)) lines.push(`- ${base}：${description}`);
  lines.push('', '按“目标路径清单.json”读取 packagePath（本 ZIP 根目录中的位置）和 target（实际目标）。只复制本套清单中的文件。',
    '配置参考行 referenceOnly=true，文件扩展名为 .example。不要覆盖现有个人配置。共享 NR 运行库也必须按清单另行复制。',
    '更新前退出游戏并备份原文件到加载路径以外；移出旧 Core／桥接器的全部副本，避免改名后重复加载。');
  if (route.loadingBackend === 'hoyoshade') lines.push('HoYo 的 active 目标只使用管理器当前显示的已核验活动目录，绝不放到游戏根目录；管理器接管的安装应通过管理器完整预览／应用以同步收据。');
  else if (route.route === 'feeder') lines.push('game 是实际游戏 EXE 所在目录（不是启动器目录）。合并 game/ReShade.ini 的 ADDON/AddonPath，并保持清单中的 shader／preset 相对目录。');
  if (route.route === 'feeder' && route.hostRequired) lines.push('Core、nrchain、NR 运行库位于 addon/host64/addons；宿主与其 dxgi.dll 位于 addon/host64。不要把 Core 或 NR 运行库放在 host64 根目录。');
  if (route.api === 'dx9') lines.push('DX9：game/d3d9.dll → runtime/ReShade32.dll 或 ReShade64.dll；Windows 须提供 Direct3DCreate9On12。NRGuides.ini 的路径按 host64 位置保留。');
  if (route.route === 'native' && route.api === 'dx11') lines.push('默认 NIGos Bridge 1.4.12 NR 适配版；独立的 1.4.11 回退材料只在明确回退时替换同名文件，不可同时保留。');
  lines.push('Feeder 0.13.1 跨代更新或更换原接管者时，先用原接管者还原，再安装完整 0.15.1。回退时恢复完整备份组，不混用不同版本。', '',
    '组件来源：', ...route.files.filter(file => !file.referenceOnly).map(file => `- ${slash(file.target.path)}  SHA-256 ${file.sha256}`), '');
  return lines.join('\n');
}

function localFeederConfig(defaults) {
  return ensureDefaultReShadeHotkey(`[ADDON]\nAddonPath=.\\_DLSS5_Feeder15\\addons\n[GENERAL]\nEffectSearchPaths=.\\_DLSS5_Feeder15\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\_DLSS5_Feeder15\\reshade-shaders\\Textures\\**\nPresetPath=.\\_DLSS5_Feeder15\\ReShadePreset.ini\nPreprocessorDefinitions=${defaults.definitions}\n`);
}
function hoyoFeederConfig(defaults) {
  return ensureDefaultReShadeHotkey(`[ADDON]\nAddonPath=.\\\n[GENERAL]\nEffectSearchPaths=.\\reshade-shaders\\Shaders\\**\nTextureSearchPaths=.\\reshade-shaders\\Textures\\**\nPresetPath=.\\ReShadePreset.ini\nPreprocessorDefinitions=${defaults.definitions}\n`);
}

module.exports = { overview, routeReadme, localFeederConfig, hoyoFeederConfig };
