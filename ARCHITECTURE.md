# Architecture — DLSS5-Manager-ZJZ

本仓是 **MIT 安装器 / 管理器壳**。它负责发现游戏、按配方安装/卸载、维护 DLC pin、用类 RHI 方式检查（并在用户确认后下载）更新，以及把失败写成可读错误。它不是 Core，也不是签名发行面。

## 三面边界

| 面 | 仓库 | 许可 | 本壳做什么 |
| --- | --- | --- | --- |
| **Manager 壳** | `smartLanny/DLSS5-Manager-ZJZ`（本仓） | MIT | 发现、配方、pin、更新检查、可读失败 |
| **Core** | `smartLanny/dlss5-nr-before-sr-lab` | 源码侧 MIT；**不**塞 NVIDIA DLL | 发版 Core。Reno 多 hook / 接入点兼容 = lab **#190**，勿倒进本仓 |
| **专有 / 签名面** | 私有 lab 发行线 + 公开 ARR `smartLanny/dlss5-manager` | ARR / UNLICENSED | 签名、防再分发、部分 UI / 米哈游专属能力。逻辑与密钥不进本树 |

产品 Manager 的现行实现目前仍在私有 lab 分支（如 `codex/manager-049-beta1-20260912`）与 fix PR **#251**（`codex/manager-049-mgr27-28-20260912`）。本仓从零搭壳 + pin/updater，**不**把 ARR 源码或私有秘密拷过来。公开 `dlss5-manager` 的文档契约（组件清单、本地包、反馈）只作概念对齐。

## 本树允许 / 禁止

**允许**

- TypeScript/Node 壳、CLI、pin JSON、配方 dry-run
- 更新源 URL、检查节奏、元数据 GET 计划
- 可选模块的挂钩点与文档（米哈游钩子、反馈打包、MFG 槽、D14 Core 选择）
- 可读错误码（见 `src/failures.ts`）

**禁止**

- NVIDIA DLL、`nvngx_*`、专有 NR kernel、`.addon64`、`.dlss5pkg` 成品
- 防再分发 / Authenticode / Ed25519 私钥或“签名脸”
- 把 lab #190 Core 兼容工作堆进此仓
- 宣称 **mgr #27 / #28** 已在本仓修复（提权误拦 / 大 EXE digest 仍在 lab PR **#251**，待 Windows 复测）

## 运行时数据流（目标）

```
发现游戏 → 解析配方 + pin → 类 RHI 元数据检查
        → 用户确认 → 外链 DLC 进本机缓存（哈希）
        → 事务安装 / 卸载 → 失败可读 + 回滚入口
```

当前骨架：发现只报扫描根；安装/卸载只输出 dry-run；`check` 默认打印如何拉取，`--live` 才打 Releases JSON。没有任何命令会把二进制写进仓库。

## 更新器（类 RHI）

- **权威**是 `config/pins.json`，不是源站 latest。
- 启动 / 手动 / 每 24h：只检查元数据。
- **从不自动安装**。
- Bridge：游戏可 pin；BG3 → **1.4.11**；拒绝 `latest` 与 `1.4.13-pre`（概念对齐 lab **#224**）。
- MFG Unlock：默认 **0.9**；**0.7** 只出现在回滚列。
- `nvngx_dlssnr`：场上 **310.8.SF-v2**，无证据不 bump。
- DLSS/SL 评估走独立 A/B，不绑 #190。

节奏与 URL 见 [docs/DLC-PIN.md](docs/DLC-PIN.md)。

## 与旧发行线的关系

米哈游钩子、反馈打包、MFG DLC 槽、D14 Core 选择是 **可选模块**，默认关闭，见 [docs/OPTIONAL-MODULES.md](docs/OPTIONAL-MODULES.md)。它们存在是为了以后接，而不是用旧构建覆盖本壳。
