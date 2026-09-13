# 协作开发

Manager 在本仓维护；Core 算法及 Bridge/Feeder/Vulkan 原生后端由对应组件任务维护。先阅读 [UI 指南](docs/UI-DEVELOPMENT.md)和[架构](ARCHITECTURE.md)。

## 分支和职责

从最新 `main` 创建个人工作分支，按页面或模块分工，通过 PR 合入。修改共享页面、IPC 或安装流程前与相关开发者协调；保留别人的未提交修改，不强推覆盖共享分支。

- `desktop/src/renderer/` 负责展示、草稿与预览，不直接写游戏或驱动。
- `desktop/preload.js` / `desktop/main.js` 是 IPC 边界；新增调用同时维护两侧和测试。
- `desktop/src/product/` 负责真实状态、组件身份、事务、恢复和启动守卫。
- 根目录 `src/recipes/bridge.ts` 是共享合同源，生成文件不手改。
- `desktop/vendor/` 保持固定上游来源，保留许可证；业务修改优先放在 Manager 层。

分别记录文件已安装、配置已保存、组件已加载和真实运行证据。保留草稿、原始备份、按游戏隔离的选择及恢复入口，不给本地功能增加账号要求。

## 提交前

```powershell
npm run check
npm --prefix desktop run verify:vendor
npm --prefix desktop run test:ui-contract
```

UI PR 提供受影响页面的截图或受控测试结果，检查 1100×780 和 900×620。按改动运行针对性测试：布局/文案不必重跑全部原生用例；保存、导入、安装、启动与恢复须验证实际调用、原文件保留、预览后变化拒绝和失败恢复。

GitHub 当前 `check` 工作流验证 CLI / 共享合同和源码无载荷，不替代 Windows 桌面、GPU 或游戏验收。

DLL、Addon、游戏文件、私钥、签名材料、个人 staging 清单和真实反馈包不进入源码提交。ignored 构建产物也不要强制加入 Git；分享真实诊断前先脱敏。测试和打包入口见 [UI 指南](docs/UI-DEVELOPMENT.md)与[本地测试](docs/LOCAL-BASIC-TESTS.md)。
