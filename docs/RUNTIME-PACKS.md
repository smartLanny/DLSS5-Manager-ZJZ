# DLSS5 Manager 运行库包

DLSS5 Manager 将神经渲染运行库按显卡族分开管理。RTX20、RTX30、RTX40 共用 RTX40 族运行库包；RTX50 使用单独的 RTX50 包。这里的“共用”表示 Manager 的硬件族选择和包布局，实际游戏是否可用仍取决于游戏 API、Core、驱动和已验证的组件组合。

## 两个运行库包

| 包 | 适用硬件族 | 文件 | 当前固定摘要 |
| --- | --- | --- | --- |
| RTX20–40 | RTX20 / RTX30 / RTX40 | `nvngx_dlssnr.dll` | 165,830,144 bytes；SHA-256 `6eb209e764f39872625debd6abaf45e2bb6322f6f270f781f70c059ae30b3927` |
| RTX50 | RTX50 | `nvngx_dlssnr.dll` | 165,840,496 bytes；SHA-256 `e16bcf15e16e13f527491cdf7845b2fe6521a738d8f7c9c721866a8496e1fc8e` |

两个文件属于大型 NVIDIA runtime，不进入基础源码仓库。已知裸文件按固定摘要识别；新运行包可以携带组件清单，声明 NGX-Feature18 接口、x64 位数、单一显卡族和完整文件摘要，作为未实测候选导入，无需修改 Manager 版本白名单。项目目前没有可直接下载的公开 runtime 两包，release 页面不能代替实际文件。

## 基础包和离线整合包

公开 Manager 便携包包含 Electron UI、Core、DLSS5 Bridge、DLSS5 Feeder、MFG Unlock 1.1.5（默认）与 1.0、0.9（回退）以及开源辅助组件。它不内置上面两个大型 `nvngx_dlssnr.dll`，也不内置 RenoDX NR Add-on；用户通过组件管理分别导入 RTX40 或 RTX50 DLC。

本地 `Full.zip` 不把运行库解包进 Manager，而是并列放入四个仍可独立使用的 ZIP：精简便携包、RenoDX Add-on 包、RTX40 DLC、RTX50 DLC。Windows VC++ 运行库包始终放在 `Full.zip` 外面。RTX40/50 DLC 内部布局仍按硬件族区分：

```text
RTX40/nvngx_dlssnr.dll
RTX50/nvngx_dlssnr.dll
```

Feeder、Vulkan、host 和 Bridge 小组件只有在 staging 清单逐文件提供摘要后才进入包；它们不会带来第三份大型 NR runtime。DX9、Vulkan 和 x86 路线继续使用各自被识别的通用桥/传输组件，不能把 RTX20–40 NR runtime 当成这些路线的实现。

MFG Unlock 1.1.5 是 RTX40 的默认小型补帧 Add-on，固定为 931,328 bytes，SHA-256 为 `0d04d858a62d3d19e7e3d478c0b8c46fe3ac43ec9fd11e4abb15617bd291d71a`；1.0（`f9f10c685e3e89077f751df2394a1629615a56b58d111dff26b39894e772d50e`）和 0.9（`64184bb370f223c3cabb359010a9a64e114cdae6b62d8b014a731a602af0a0da`）仅作为回退。0.7 不再提供。MFG 不替代游戏已有的 Streamline/DLSS-G 运行库。

## 手动导入

在 Manager 的组件库中选择本地文件或目录：

- 单个 `nvngx_dlssnr.dll` 或已知 MFG Add-on 会按固定 SHA-256 和 x64 位数识别。
- ZIP 可以包含 `component-manifest.json`，也可以只包含已知摘要的裸 DLL/Add-on；ZIP 内目录会被展开到隔离库存，不会直接写入游戏目录。
- 目录可以包含 `component-manifest.json`，或包含一个或多个已知摘要文件。目录和 ZIP 不能含链接、路径穿越、重复路径或不受支持的架构。
- 自定义 Bridge、Feeder、host 或 Vulkan 包应随 `component-manifest.json` 声明 `id`、`kind`、版本、接口、架构和每个文件的 bytes/SHA-256。未知裸文件不会被当作可安装组件。

导入后由 Manager 组件库保存摘要和硬件族映射；选择 RTX20–40 或 RTX50 时只激活对应族的 runtime。请保留旧版本缓存和已有收据，以便恢复原安装；新变体应使用新的独立组件 ID，不能让同一个组件 ID 对应两组不同摘要。

## VC++ 运行库修复

如果 Manager、ReShade 或组件加载时出现缺少 MSVC runtime 的系统错误，请使用微软官方 x64 安装程序修复或安装 Visual C++ Redistributable：

[微软官方：最新受支持的 Visual C++ Redistributable](https://learn.microsoft.com/vi-vn/cpp/windows/latest-supported-vc-redist?view=msvc-170)

安装或修复完成后重启 Manager，再重新检查组件。VC++ Redistributable 是系统依赖修复包，不属于 `nvngx_dlssnr.dll`，也不会替换游戏目录内已有的 DLSS/Streamline 文件。

## 来源和更新

- Manager release 页面：[smartLanny/DLSS5-Manager-ZJZ Releases](https://github.com/smartLanny/DLSS5-Manager-ZJZ/releases)
- MFG Unlock 官方 release：[MFGAdaUnlock-RenoDx Releases](https://github.com/mavismmg/MFGAdaUnlock-RenoDx/releases)
- Bridge 官方 release：[NIGos/dlss5-bridge Releases](https://github.com/NIGos/dlss5-bridge/releases)
- Feeder 官方 release：[DLSS5-Feeder Releases](https://github.com/jlrouzies-fr/DLSS5-Feeder/releases)

“检查更新”显示的是官方 release 元数据，不能单独证明新 DLL、Bridge 或 Feeder 已与当前 Core 兼容。导入新文件前应使用官方摘要或项目提供的 component manifest；未完成独立验收的版本会保留为候选状态。
