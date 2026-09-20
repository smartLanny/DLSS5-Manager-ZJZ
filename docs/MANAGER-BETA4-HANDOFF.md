# Manager 0.5 Beta4 本地候选

从冻结的 Beta3 `6cb8c7a5b49374b3e903eff9a19991ea3b4c5974` 独立继续。只修改管理器及其测试、打包和说明；保留既有工作树，不发布、合并或替换真实游戏文件。

游戏页统一为“安装与启动 / NR 画面增强 / DLSS 超分与补帧”。普通游戏与米哈游共用设置和“应用 / 启动”状态；应用、导入续接、排队完成均不自动启动。Core 常用列表保留标准版与当前完整 0.5 候选，历史版本进入回退；Feeder 专用路线继续按实际接口拒绝不兼容 Core。

未受管旧安装保留目标 Core，点击应用先显示接管清单。未知代理先选定具体文件，再重新预览和确认；授权绑定文件、配置指纹，写入前重新核对。普通 ReShade 替换、重命名已知 Core、缺件与配置残留使用现有备份事务；取消不写游戏，失败可恢复。等待队列与恢复记录分开，实际启动边界也检查待办。

组件页按内容身份汇总 Bridge、Feeder、MFG Unlock 和 dlssg-sm86，核对实际内置文件。每类最多展示一份兼容更新，不把未知上游版本宣称为兼容。组件读取按需进行，校验异步且缓存；下载和导入只禁用各自操作。NR 显卡运行库继续使用独立 DLC。

## 验证

- 仓库 `npm run check`、UI 合同、固定 vendor、公源审计。
- 桌面整套回归及因新接管/按钮合同更新的旧用例复跑，最终统计和跳过原因见交付目录验证记录；不把跳过当作通过。
- 真实 Electron：普通游戏、HoYoShade 委派、真实 INI、多层、旧安装接管、DLC 取消/续接、Core 来回切换、等待取消、零自动启动。
- 接管专用跨层 runner：真实 service/operation/deferred/installer/WAL，普通 ReShade 与未知代理共 85 项。游戏及 PE/GPU 身份为合成夹具，未执行游戏或 DLL。
- 新构建便携包逐文件与可信源码/固定 Electron 44.3.0 核对；ZIP 对照；普通及兼容启动；全新便携目录无替换服务的实际 EXE 启动。

入口：`desktop/test/manager-adoption.electron.cjs`、`manager-experience.electron.cjs`、`game-usability.electron.cjs`、`components-page.electron.cjs`、`nr-settings.electron.cjs`。详细日志和截图保留在仓库外，不提交私有证据。

## 保留边界

- 新装默认 `0.4.7beta`，当前完整候选 `0.5-dline21-unified3 / 7a90660b`；没有纳入未交付的新 Core/Bridge/Feeder 适配。
- d3d11.dll 旧主机、多个主代理等仍会明确要求先整理入口。自动接管替换限当前支持的 DXGI/D3D12 入口，不静默改名或创建第二份主机。
- RTX20/30 实际补帧、unified3 及新版适配的游戏验证待对应硬件/其他任务完成；软件验证不能代替这些证据。
- 回退前取消等待，游戏用 Beta4 的历史 Core/恢复入口处理，再退出并运行保留的旧管理器。保留游戏备份与便携 data。

给其他任务的短说明见 [Core 适配交接](CORE-ADAPTATION-HANDOFF.md)。配套必须携带完整首装目录、INI 合同、源版本及文件哈希，不能用 OTA 代替完整包。
