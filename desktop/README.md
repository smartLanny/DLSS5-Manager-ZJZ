# DLSS 5 AI 超分管理器 · 装机宅版

这里是 **Manager 0.5.0-beta.1** 的 Electron 桌面源码，与根目录 CLI / 共享安装预检共同维护。当前开发入口见[仓库首页](../README.md)、[UI 指南](../docs/UI-DEVELOPMENT.md)和[打包说明](../docs/MANAGER-PACKAGING.md)。迁入源码中的旧版交接记录不代表当前默认版本或组件策略。

## 启动

在仓库根目录执行：

```powershell
npm ci
npm --prefix desktop ci
npm run start:desktop
```

根目录依赖生成共享 Bridge 合同，desktop 依赖运行 Electron。`src/product/generated/` 不手改。固定上游源码已包含在 `vendor/`，不需要私有仓库或 submodule 下载。

未准备 Core / NVIDIA runtime 时可开发界面、查看组件状态及运行模拟 UI 测试；实际安装和游戏联调需要校验过的组件。

## 桌面功能

- 游戏发现、搜索、卡片、API 识别与手动选择。
- NR 参数、SR/FG 设置的预览、应用、恢复和启动前状态。
- 米哈游绑定、助手流程、共享设置与反馈。
- Core、Bridge、Feeder、MFG、NR runtime、host 的多版本组件库存和导入。
- 本地/外置安装、备份、修复、卸载与中断恢复。
- 本地反馈预览、脱敏打包、启动诊断和运行证据。
- base / offline 拆包与按显卡族划分的 NR 运行库。

当前 Core 由 staging 清单指定，MFG 默认登记 0.9；旧文档中的固定 0.4.7、MFG 0.6.1 等信息保留为历史记录。可选路线仍有各自接口要求和候选状态，代码接通不等于每个游戏或 GPU 已完成验收。

## 检查和打包

在 desktop 目录执行 `npm run verify:vendor`、`npm run test:ui-contract` 和相关界面测试。完整测试为 `npm test`，部分原生/历史用例需要外部夹具，见[测试说明](../docs/LOCAL-BASIC-TESTS.md)。

打包使用外部 staging 清单与 `npm run build:base` / `npm run build:offline`，产物在根目录 ignored `deliveries/`。不要提交本机路径、NVIDIA DLL、Core 成品、游戏文件或签名材料。说明见[运行库包](../docs/RUNTIME-PACKS.md)和[打包文档](../docs/MANAGER-PACKAGING.md)。

源码归属和许可证见 [UPSTREAM.md](UPSTREAM.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)及迁移清单；当前组件选择以组件清单和实际 staging 为准。
