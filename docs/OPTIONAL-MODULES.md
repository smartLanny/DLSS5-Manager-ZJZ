# 可选模块（挂钩，不覆盖旧构建）

本页只描述根目录 **CLI 的 optional 命令**。完整 Electron Manager 已迁入 `desktop/`，其中的米哈游管理、反馈打包和组件库已有实现；不能用下表的 CLI 占位状态推断桌面功能缺失。桌面开发与分工见 [UI-DEVELOPMENT.md](UI-DEVELOPMENT.md)。

CLI 的这些模块仍只保留 **模块 id + 默认关闭 + 可读拒绝**，不从命令行调用桌面的游戏安装、GPU 或反馈保存流程。

| id | 意图 | 默认 | 拒绝码 |
| --- | --- | --- | --- |
| `mihoyo-hooks` | 米哈游启动器路径、反作弊提示、专属反馈分流 | 关 | `LAB_CORE_OUT_OF_SCOPE` |
| `feedback-packaging` | 只读脱敏报告；不自动开 Issue；私有附件单独确认 | 关 | `OPTIONAL_MODULE_DISABLED` |
| `mfg-dlc-slot` | MFG DLC 槽，默认制品 **0.9** | 关（pin 仍生效） | `OPTIONAL_MODULE_DISABLED` |
| `d14-core` | 选择 lab 发的 D14 Core，不在此做兼容矩阵 | 关 | `LAB_CORE_OUT_OF_SCOPE` |

CLI：`dlss5-manager-zjz optional` 列出；带模块 id 会按上表抛错。

## 概念对齐（不复制 ARR 源码）

公开 ARR 仓 `smartLanny/dlss5-manager` 文档里有组件清单 v2、`.dlss5pkg` 契约、反馈契约。本壳：

- **可以** 用自己的 TypeScript 类型描述“将来如何接”
- **不可以** 拷贝该仓 Electron/CJS 实现或把 `trusted-keys` / 签名脸搬过来
- **不可以** 把私有 lab 的 NR 成品或防再分发逻辑搬过来

CLI 反馈方向（独立重述）：本机预览 → 用户确认 → 公开文本脱敏；原始路径/截图不进公开报告。CLI optional 槽不执行打包；桌面反馈实现在 `desktop/src/compatibility/` 和对应 renderer / IPC 中。

D14 / 多 hook 继续在 lab **#190**。本仓配方把 `d14-core` 标成 optionalSlots，安装 dry-run 默认跳过。
