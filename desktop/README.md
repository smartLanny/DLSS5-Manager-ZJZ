# DLSS 5 AI 超分管理器 · 装机宅版

面向普通玩家的 NR、超分与补帧安装管理器。本分支为 **Manager 0.4.7-beta.1 测试候选**，以 dev.13 为基础，加入按需管理员权限、完整解压版交付、独立 DX12 Feeder 和 RTX40 MFG Unlock 0.6.1。版本尚未合入 main 或公开发布。

**管理器与核心版本分别记录**：当前默认核心为 **beta0.4.7**，保留 **0.3.3.4 稳定兼容版**等历史选择。Vulkan 与 Feeder 使用各自固定配套，不允许任意交换核心。

它不是新的游戏内 HUD，也不尝试重造 ReShade。桌面端只负责把现有
NR-before-SR 插件变得更容易安装和调节：打开软件即可看到游戏，卡片内
直接一键安装、修改常用参数、检查组件、修复或卸载。

## 当前范围

- Windows 10 / 11，默认普通权限和 Chromium 沙箱；
- 已有 DLSS 的 x64 DX12、配套 DX11 路线，以及固定 Vulkan 试验配套；
- 无原生 DLSS 的 RTX50 / x64 DX12 Feeder 试验路线，仅明确 sRGB 的 RGBA8 成品帧 NR，不提供原生 SR/FG；
- RTX40 的 MFG Unlock 需要原生 Streamline FG、310+ DLSS-G 和完整 ReShade Add-on 支持，默认跟随游戏；
- 检测到反作弊组件时保留现有明确确认流程，不修改或绕过反作弊；
- Feeder 的 x86、DX9/10/11、OpenGL、HDR、模拟器路线尚未接入。

安装完成、配置读回和真实游戏运行分别记录。使用与恢复方法见 [候选版说明](docs/manager-0.4.7-beta.1-use.txt)，启动方式见 [启动与恢复](docs/STARTUP-RECOVERY.md)。

## 使用源码

```powershell
git submodule update --init --recursive
npm install
npm start
```

通过 GitHub 的“Download ZIP”获取源码时，压缩包没有 submodule 元数据，请改用：

```powershell
./scripts/bootstrap-vendor.ps1
npm install
npm start
```

管理器可以在没有完整组件时启动、扫描游戏和查看兼容性；安装操作会提示先准备组件。在“插件版本 → 安装组件来源”选择含 `bundle.json` 的完整目录，校验成功后保存路径，重启后继续使用。也可选择其 `payload` 上级目录。

切换来源不会立即改写游戏。目录断开、清单变更、文件损坏会明确阻止安装或修复，不静默改用别的目录；更新清单后需点“重新检查”。若新来源不含已安装游戏的版本，需明确选择目标版本，修复不会擅自升级。游戏目录、实际 EXE 和手动 API 选择均继续保留。

普通构建包含已准备的完整配套；外部组件版不含原生、Vulkan 或 Feeder NR payload。两种构建的 GUI 均为 `asInvoker`，portable 为 `user`；权限不足时由用户在设置中明确重启为管理员，游戏使用独立的普通权限启动助手。准备本地原生组件示例：

```powershell
./scripts/prepare-payload.ps1 `
  -NrBuildDir D:\nr-build `
  -NeuralRuntime D:\runtime\nvngx_dlssnr.dll `
  -ReShadeAddonRuntime D:\reshade\ReShade64.dll
```

脚本生成 SHA-256 清单。版本化目录的生成工具见 `scripts/prepare-versioned-payload.ps1`；公开源码不提交专有 NVIDIA runtime。仅有 OTA / addon 更新文件不足以首次安装完整运行环境。

DXGI / 混合证据不会直接当作 DX11。用户可按实际 EXE 保存图形 API；指定 DX12 保留所选核心和共用 `nrchain_nvngx.dll`，不部署 DX11 carrier；指定 DX11 才要求配套 carrier。安装、修复、版本切换和 OTA 共用这套路线规则，旧受管文件按恢复记录处理，未知文件或外部改动不会被强制覆盖。

构建外部组件版：`npm run build:external`；输出至 `dist-external`，文件名带 `external`，以免混淆完整组件包。验证：`npm run verify:external`。完整包仍使用 `npm run build`。本候选构建验证不等于已发布或具体游戏兼容性验收。

## 用户路径

1. 自动扫描或“添加游戏”；
2. 在主页搜索框/筛选器中定位游戏；
3. 在“插件版本”确认完整组件，在“设置”选择新安装默认核心；已安装游戏在各自卡片选择并应用版本；
4. 原地展开卡片调整风格、人脸保护、模型强度和额外强度；NR 工作分辨率仍在游戏内 ReShade Overlay 调整。SR 与 FG 更改后自动应用并保存，请先退出游戏；界面区分配置已应用与游戏实际未验证。一键准备保留已有选择，中断后可恢复本轮新增内容；
5. “插件版本”页优先支持选择/拖入标准 OTA `.zip`，也支持 `.addon64`；双击关联文件也会自动导入。导入 OTA 后，已经锁定旧版本的游戏不会被全局选择覆盖，只有在该游戏卡片点击“应用版本”才会替换；
6. 游戏内仍使用原来的 ReShade 设置页；
7. 切换版本后点“应用版本”，按 API 部署所需组件，保留原始备份和管理器恢复记录；需要恢复时按游戏、按设置域处理。

RTX50 使用原生帧生成；RTX40 新准备只使用 MFG Unlock 0.6.1 单 Add-on，旧 MFG/UAL 仅保留识别、恢复与显式迁移能力。游戏内进入 ReShade → Add-ons → MFG Unlock 设置倍率。组件与配置验证不代表游戏已输出生成帧。

新版 MFG 不沿用旧套装的 VC++ 准备门槛，也不将管理器打不开统一归因于 VC++。临时兼容入口需明确确认后才使用 `--no-sandbox`；它不改变默认启动，不代表目标电脑的 NSIS Setup 问题已经修复。

### 版本锁定、OTA 应用与诊断

游戏卡片记录自己的 `payloadVersion`。因此，某个游戏已经锁定 `0.3.3.5` 时，即使插件版本页又导入了新的 OTA，诊断和“修复”仍会以该游戏锁定版本为准；在卡片中明确点击“应用版本”后，才会切换到新版本。应用过程中只执行一次游戏库刷新，并且旧的异步诊断结果不会覆盖新结果，避免出现卡顿、安装已经完成但右侧仍显示旧版本的问题。

标准 OTA 里的 `nr-before-sr.zh-CN.addon64` 与 `nrchain_nvngx.dll` 会作为一个配套更新保存。应用时两者都会先备份为 `.bak` 或进入管理器备份目录后再替换；INI、ReShade、AI Runtime 和游戏自带的 `nvngx_dlss.dll`、`nvngx_dlssg.dll` 不会被 OTA 覆盖。仅导入单独 `.addon64` 时，则只替换 Addon 并保留当前 Bridge。

### 一键安装失败怎么反馈

不要只截“操作失败”的提示。保留管理器打开，进入左侧“修复”页面，在“安装失败反馈”里选择对应游戏，点击“保存反馈日志”，把生成的 TXT 发给维护者。管理器会记录错误码、最近一次操作、组件匹配结果，以及游戏目录旁的 `ReShade.log`、`nr-before-sr.log` 等相关日志；默认会脱敏用户目录，不会自动上传。只有在排查权限或路径问题时，才需要勾选“包含完整路径”。

0.4.x 中 Mode 是旧版内部处理链路，不等于游戏 DLSS 画质档位；当前默认 `WorkMode=0`（Reference）并将 `CustomWorkScale=1.0`，让 NR 工作栅格与游戏当前渲染栅格匹配。`WorkMode` 仍由插件配置兼容保留，但管理器不再把它暴露成独立选项，避免和游戏内渲染分辨率混淆。

## 安全模型

- 所有安装组件必须匹配 `bundle.json`；
- 写入前确认游戏已关闭；
- 检测到反作弊时先警告，用户确认后才继续写入；
- 不覆盖未知 `dxgi.dll`；
- 每次操作使用写前日志，失败自动回滚；
- 首次被替换的文件单独备份，卸载时恢复；
- 默认保留用户的 `nr_before_sr.ini` 参数；
- 安装/修复会把 `renodx-dlss5.addon64`、旧 `nr-before-sr*.addon64` 和可识别的
  DLSS/NR/NGX 冲突 Addon 移到 `_DLSS5_Backup/conflicts`，不删除；
- 不移动 ReShade 本体 `dxgi.dll`、游戏自带 `nvngx_dlss.dll` / `nvngx_dlssg.dll`，
  也不移动普通 RenoDX 色彩/HDR 插件；
- 不在仓库提交 NVIDIA runtime 或其他未审查二进制。

## 上游与署名

桌面基础通过固定版本 Git submodule 复用了 MIT 许可的
[DLSS5-Swapper](https://github.com/rakanki911/DLSS5-Swapper) 部分本地扫描与
文件安全实现。原作者和许可证见 `UPSTREAM.md`、`LICENSE` 与
`THIRD_PARTY_NOTICES.md`。

产品维护：**野生的装机宅**。品牌名、Bilibili 主页、群号和更新地址统一在根目录 `product.json` 配置，空群号不会显示入口。
