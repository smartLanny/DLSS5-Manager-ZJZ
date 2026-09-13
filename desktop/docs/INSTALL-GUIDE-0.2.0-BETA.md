# DLSS 5 AI 超分管理器 · 装机宅版 0.4.5

本安装器基于 `product/xiaofeng-manager-foundation` 分支构建，当前管理器版本为 `0.4.5`。界面设置页与侧栏显示的产品版本与安装包文件名一致，不再使用旧的 `0.2.0-beta.2` 管理器编号。`0.2.0-beta.2` 仍是内置 Addon 兼容槽，不是本次安装器版本。

## 使用方式

1. 双击 `DLSS5-Manager-Setup-0.4.5.exe` 安装，或直接运行 `DLSS5-Manager-0.4.5-portable.exe`。Windows 版本默认请求管理员权限，以便正常写入 Program Files 和游戏目录；启动时请在 UAC 弹窗中选择“是”。
2. 首次打开会自动识别显卡。RTX 20/30/40 共用 RTX40 兼容运行组件，RTX 50 使用 RTX50 运行组件。
3. 点击“添加游戏”选择游戏目录；也可以点击“选择 EXE”直接添加实际运行程序。确认前会显示候选 EXE、相对路径、API、位数和文件大小，并允许手动改名、换图标。
4. 管理器会检查 64 位、图形 API、普通 DLSS 和反作弊风险；如果检测到反作弊，会先显示风险警告，确认后才继续写入。管理器不会修改、删除或绕过反作弊文件。已有原生或模组 DLSS 的 DX11-x64 游戏会自动选择内置 `0.4.5-DX11-兼容增强`；D3D12 仍走原生 SR 或已知硬件深度 RR 路线。
5. 安装完成后可进入“问题修复”检查组件，或从游戏卡片直接启动游戏。
6. 展开游戏卡片后，可在启动前选择 **DLSS SR 模型**。自动推荐：RTX 40/50 → **M**，RTX 20/30 → **K**；**M** 是常规推荐模型，主要对应 DLSS Performance；**L** 是高画质优先、可能低帧数的模型，主要面向 4K Ultra Performance。选择只在下次通过本管理器启动游戏前写入 NVIDIA 每游戏配置，不会在游戏运行中重建 DLSS。RR 研究仍未关闭，本版不自动改写 RR。

游戏很多时，可以在主页顶部输入名称或启动器关键词搜索，也可以用右侧筛选器只看“已安装”“可安装”或“暂不支持”。列表区域支持滚动，底部游戏不会被窗口边界遮住。

### 游戏本体自动识别

自动选择不是按“EXE 必须大于 10 MB”判断。文件大小只展示给用户参考，小型引擎入口也可以是实际游戏本体。管理器综合使用以下信号：`Binaries\\Win64` 等引擎目录、程序名、DirectX/API 证据、DLSS 文件关联，以及 `Launcher`、`CefView`、`QtWebEngine`、报告程序和反作弊服务等辅助程序特征。

对于启动器包裹的游戏，管理器会从所选 EXE 或目录向上回溯到包含普通 DLSS 的真实游戏根目录，并在子目录中继续找候选程序。例如：

- `InfinityNikki Launcher\\InfinityNikki\\X6Game\\Binaries\\Win64`：优先 `X6Game` 下的真实游戏入口；
- `...\\Neverness To Everness\\Client\\WindowsNoEditor\\HT\\Binaries\\Win64\\HTGame.exe`：回溯到 `WindowsNoEditor`，默认选 `HTGame.exe`；
- `...\\Wuthering Waves Game\\Client\\Binaries\\Win64\\Client-Win64-Shipping.exe`：可以在 `Engine\\Plugins\\Runtime\\Nvidia\\DLSS\\Binaries\\ThirdParty\\Win64` 的嵌套布局中找到 DLSS；
- `Hypergryph Launcher\\games\\Arknights Endfield\\Endfield.exe`：即使入口 EXE 很小，只要目录和名称等信号明确，也会优先选中，而不会被 CefView/QtWebEngine 启动组件抢走。

候选列表中的“建议”只是默认选择，用户仍可点选其他已识别的图形程序；保存后会记录这个具体 EXE，后续安装、修复和切换版本都会使用它。

启动器目录会降低启动器本身的优先级。例如选择 `C:\\Program Files\\miHoYo Launcher` 时，会优先排序 `games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe`，再显示 `HYP.exe`、`HYPWorker.exe` 等启动器辅助程序。候选列表按综合优先级排列，`Launcher`、`Helper`、`CefView`、崩溃报告和反作弊服务仍可手动选择，但不会抢默认项。

Steam 游戏的图片会自动按以下顺序处理：本机 Steam `library_600x900` 高清海报、Steam `library_header/header`、Steam `library_hero`，再到 Steam 网络高清海报；只有 Steam 没有可用图片时，才使用 Steam logo 或游戏 EXE 图标。刷新或移除其他游戏时会保留已经加载的图片缓存，并且只更新发生变化的游戏卡片，不再让整页图标重新闪烁。

游戏卡片右侧的“×”是持久化移除：它会记录被移除的游戏目录、启动器和应用标识，重启或重新扫描后也不会自动回来。需要恢复时，在“添加游戏”或“选择 EXE”中重新选择该游戏即可。

## 安装内容

安装器会一起管理 ReShade Add-on 运行环境、NR addon、NR bridge、NR runtime 和 `nr_before_sr.ini`。ReShade Overlay 继续作为游戏内设置界面。

设置页内置四个可切换版本槽（发行包默认使用 0.3.3.5 稳定版；DX11 游戏在未手动指定版本时自动使用前置的兼容测试槽；切换时主要替换 addon，运行库按显卡族固定一份）：

- `0.2.0-beta.2`：从历史 `v0.2.0-beta.2` 源码隔离构建的 legacy addon，作为《NBA 2K27》等反馈中“0.2 可用、0.3 不兼容”的首选兼容性候选；

- `0.4.5-DX11-兼容增强`（内部 ID `0.4.5-ota`，机器版本 `beta0.4.5-dx11-compat`）：直接替换旧 0.4.5 槽。只包含中文核心，并成套校验和安装匹配的核心、`nrchain_nvngx.dll` 与 carrier；已有 INI、ReShade、Runtime 和游戏自带 DLSS 保持不变；
- `0.3.3.5`：默认稳定版槽；本地现有的 0.3.3 legacy addon 与配置，用于日常安装和兼容性基线。当前工作区没有找到身份明确为 `0.3.3.4` 的二进制，因此没有冒充命名。

新版 0.4.5 支持已有原生或模组 DLSS 的 DX11-x64 游戏，同时保留 D3D12 原生 SR 与已知硬件深度 RR 路线。不支持任意无 DLSS 游戏、Feeder、Vulkan、DX9/DX10/OpenGL 或 x86 Legacy。安装前会移出旧核心和旧 carrier，不能叠加混装。

选择版本后，点击游戏卡片的“应用版本”或“一键修复”就会替换对应 addon。替换前会自动产生 `.bak`，并记录版本信息，方便反复切换和卸载恢复。0.4.x 内置槽共用当前显卡族的一套固定 ReShade/Bridge/Runtime，其中包含 `nrchain_nvngx.dll`；导入标准 OTA 时会校验包内同名 chain，包内带 chain 时会和 Addon 一起更新，INI、ReShade、Runtime 和游戏自带 DLSS 保留。DX11 兼容槽会额外管理 native carrier addon，切换回其他版本时自动恢复/移除它。

如果是《NBA 2K27》，建议先在游戏卡片的“Addon 版本”里选择 `0.2.0-beta.2（2K27 兼容候选）`，退出游戏后点击“应用版本”；它是兼容性候选，不代表已经覆盖所有平台、补丁和显卡组合。

DX11 兼容测试槽来自 `beta0.4.2-DX11兼容-exp1-windows-x64.zip`，不是稳定版。如果游戏无法启动、原生 DLSS 异常或日志没有持续提交，请恢复上一个版本并进群联系 `@群RBQ` 提交报告。

更快的 A/B 对比：展开已经安装的游戏卡片，在“Addon 版本”下拉框选择版本，点击旁边的“应用版本”。先完全退出游戏，管理器会自动检查进程、备份当前 addon，再替换所选版本；测试完退出游戏后可直接换另一个版本重复操作。

### 一键安装失败时如何提交反馈

请不要只发送“操作失败”的截图。保持管理器打开，进入左侧“修复”页面，在“安装失败反馈”中选择刚才操作的游戏，点击“保存反馈日志”，把生成的 TXT 文件完整发给维护者。即使游戏还没有安装成功，也可以收集失败信息。

反馈日志包含管理器版本、错误码、最近操作、显卡/组件匹配结果、当前诊断，以及游戏目录旁能找到的 `ReShade.log`、`nr-before-sr.log` 等相关日志。默认会对用户目录进行脱敏，不会自动上传；如果问题明显与权限或安装路径有关，再勾选“包含完整路径”。

### 版本锁定与应用后的诊断

每个已安装游戏会记录自己实际使用的 Addon 版本。游戏卡片的锁定版本优先于设置页的全局默认版本；导入新 OTA 不会自动改写已经锁定的游戏。只有在该游戏卡片里选择新版本并点击“应用版本”，才会写入新的版本记录。

应用完成后管理器只刷新一次游戏库，并丢弃已经过期的异步诊断结果，避免应用时卡顿或右侧仍显示旧版本。如果右侧版本仍提示不一致，先退出游戏，再点击“一键修复”；修复完成后可在“问题修复”页保存完整 TXT 反馈日志。

### 导入标准 OTA / 新 Addon

进入左侧“插件版本”，优先选择标准 OTA `.zip`，也可以直接把它拖进导入区域。管理器会先验证 `ota-manifest.json`、文件大小、SHA-256、API 和 DX11 标记；导入版本只保存到管理器自己的版本库，不会覆盖内置 payload。选择它并点击“应用版本”时，会替换 OTA 内提供的 Addon 和配套 Bridge，并保留游戏目录中的 INI、ReShade、Runtime 和游戏自带 DLSS。单独 `.addon64` 仍可导入，但只替换 Addon，保留当前 Bridge，适合熟悉文件结构的高级用户；导入版本可以在版本页删除，已经写入游戏目录的文件不会因此被删除。

安装程序已注册 `.addon64` 文件关联。安装完成后，在资源管理器中双击 Addon 文件会打开管理器并加入版本库；标准 OTA `.zip` 可以从插件版本页选择或拖入。若需要完整补齐 ReShade、Bridge、Runtime，请对游戏执行对应版本的“修复”，不要只做 OTA 的 Addon 切换。

### 常用设置

管理器界面只保留 Addon 版本、风格和人脸保护。NR 工作分辨率、颜色跟随、AI 强度等细项请在游戏内 ReShade Overlay 中调整；这样不会把不同 Addon 版本的能力差异硬塞进统一界面。恢复默认仍会写回插件的完整默认配置。

关于 NR 分辨率：配置注释中的 `Mode=1` 是 **SR→NR**，即游戏完成 SR 后在输出分辨率上做 NR；`Mode=2` 是 **NR→SR**，即先在游戏的渲染/工作栅格上做 NR，再交给游戏 SR。0.3.x/0.4.x 默认通常是 Mode 2，0.2 legacy 槽默认是 Mode 1。当前 0.4.x 默认 `WorkMode=0`（Reference）且 `CustomWorkScale=1.0`，因此 NR 工作栅格默认匹配游戏当前渲染栅格，不再默认使用 0.75 倍。0.4.x 的 `WorkMode`/`CustomWorkScale` 只属于支持它的 NR→SR 工作栅格路径，不能简单理解成“游戏 DLSS 分辨率开关”；游戏渲染分辨率仍由游戏自己的 DLSS 质量档位决定。切换版本时会随对应配置自动切换这些模式。

## 回滚与安全边界

- 替换已有组件前，会在原文件旁保存 `文件名.bak`；如果已存在同名备份，则使用 `.bak.1` 等名称。
- 同时保留 `_DLSS5_Backup` 内的管理器恢复记录，可从“问题修复”卸载并恢复原文件。
- 未知的 `dxgi.dll`、`d3d12.dll`、其他图形代理和反作弊文件不会被盲目删除或覆盖；检测到反作弊时会先警告，用户确认后才继续安装。
- 安装/修复时会把原版 `renodx-dlss5.addon64`、旧版 `nr-before-sr*.addon64` 以及可识别的 DLSS/NR/NGX 冲突 Addon 移到 `_DLSS5_Backup/conflicts`；普通 RenoDX 色彩/HDR 插件、ReShade 本体和游戏原生 DLSS DLL 会保留。
- 安装、修复、卸载前需要先退出游戏。
- 已安装游戏卡片提供“加载 D3D12 入口”兼容修复：未切换时会提示“部分网游（异环、逆战）不兼容 DXGI，建议加载 D3D12”。它只把管理器自己的 ReShade 入口从 `dxgi.dll` 移到 `d3d12.dll`，遇到已有 `d3d12.dll` 会拒绝覆盖，并留下 `.bak`；可以随时恢复 DXGI。不代表所有网游都兼容，也不会绕过反作弊。

## 当前限制

- 这是 0.4.5 预发布管理器，真实游戏兼容性仍需逐款实机验证。SR 模型写入依赖本机 NVIDIA 驱动；失败时游戏仍会启动，但界面会提示模型未应用。
- 社区反馈中曾见到《绝区零》、原神、Path of Exile 2 等游戏在特定版本/加载链路下尝试 `d3d12.dll` 入口；这不是稳定的官方兼容清单，所以管理器只提供手动、可回滚的修复按钮，不会按游戏名强制替换。
- 本地 payload 已包含 RTX40 兼容组件（覆盖 RTX 20/30/40）和 RTX50 两套版本化组件；公开源码不提交这些二进制文件。
- 安装器不会绕过反作弊，也不会修改、删除反作弊文件或 Steam、Epic 等启动器记录；是否继续由用户确认，实机风险由用户自行承担。

反馈与更新：<https://github.com/smartLanny/dlss5-nr-before-sr-lab/releases>

作者主页：<https://space.bilibili.com/941799>
