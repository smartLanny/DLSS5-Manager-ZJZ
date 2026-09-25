# DLC pin table

本表是 Manager 壳的 **权威 pin**。Updater 对照外链源，但 **不**把 latest 写回本表，也 **不**把二进制提交进树。

活数据：[`config/pins.json`](../config/pins.json)（`schemaVersion: 1`）。CLI：`npx dlss5-manager-zjz pins` / `check`。

## Pins

| Component | Slot | Default pin | Rollback | Update source (page) | Metadata URL | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| MFG Unlock (40) | `mfg-dlc` | **0.9** | — | https://github.com/mavismmg/MFGAdaUnlock-RenoDx/releases | https://api.github.com/repos/mavismmg/MFGAdaUnlock-RenoDx/releases?per_page=15 | 新安装只提供 0.9；0.7/0.6.1 仅用于识别并恢复历史收据，不可选择、不进入新包。 |
| Bridge | `bridge` | game-recipe；**BG3 = 1.4.11** | 配方本地 | 本仓 pin：https://github.com/smartLanny/DLSS5-Manager-ZJZ/blob/main/config/pins.json | https://raw.githubusercontent.com/smartLanny/DLSS5-Manager-ZJZ/main/config/pins.json | **可 pin，永不跟 latest**。拒绝 `1.4.13-pre`。概念对齐 lab **#224**。 |
| Feeder | `feeder` | optional | — | 无默认公开根（changelog 门） | — | 主 OTA 可省略；仅配方开门后检查。 |
| nvngx_dlssnr | `nr-runtime` | **310.8.SF-v2** | — | NVIDIA / 日后 RHI 目录（产品页：https://www.nvidia.com/en-us/geforce/technologies/dlss/ ） | 未公开则空 | 无场上证据别乱动。DLL **不**进本仓。 |
| DLSS / SL stack | `sl-stack` | field-current | — | https://github.com/NVIDIA-RTX/Streamline/releases | https://api.github.com/repos/NVIDIA-RTX/Streamline/releases?per_page=15 | **评估** 310.9.1+SL2.14.1，独立 A/B，不绑 lab #190。SDK zip 不进树。 |

## 更新源与检查节奏（类 RHI）

概念上对应既有 mgr 讨论 **#13 / #26 / #6**（检查源、节奏、失败可读）。本壳的具体约定：

| 触发 | 做什么 | 不做什么 |
| --- | --- | --- |
| Manager 启动 | 若 `checkCadence.onLaunch`：对有 `metadataUrl` 的组件 GET 版本列表 | 不下载 zip/DLL/addon；不改 pin |
| 手动 | `dlss5-manager-zjz check`（`--live` 才出网） | 不自动安装 |
| 周期 | 默认 **24 小时**（`periodicHours`） | `autoInstall` 恒为 false |
| 用户确认安装 | 未来：按 **当前 pin** 把外链制品拉到本机缓存并校验哈希 | 永不 `git add` 这些文件；无 pin 不拉 |

实现要点（`src/updater/`）：

1. **pin 优先于源站。** 源站更新只出现在报告里（`keep-pin`）。
2. **Bridge 黑名单。** `latest`、`1.4.13-pre` → `BRIDGE_LATEST_FORBIDDEN` / `blocked-latest`。
3. **元数据默认。** 无 `--live` 时只打印 FetchPlan（URL、GET、不下载二进制）。
4. **Feeder。** `changelog-gate`：无门则 `skip-optional`。
5. **dlssnr。** `rhi-or-nvidia`：没有公开目录条目就保持 310.8.SF-v2。

## 如何“会去拉”

壳在 `pins` / `check` 里对每个组件给出计划，例如：

- MFG：`GET` GitHub Releases JSON → 比较 tag 与 **0.9** → 只报告。
- Bridge：`GET` 本仓 `pins.json` → BG3 继续 **1.4.11**。
- Streamline：`GET` NVIDIA-RTX/Streamline releases → 评估信息，不切换场上 pin。
- 任何 `download` 入口直接 `BINARY_FORBIDDEN`。

## 并行工作（不要写进本 pin）

- 接入点 / Reno 多 hook → lab **#190**（不要把 Core 兼容堆进本仓）。
- 安装器 P0 mgr **#27 / #28**（提权误拦、大 EXE digest）→ lab PR **#251**。本仓 **不**宣称已修，需 Windows 复测后再说。

## 话术

先壳 → 按游戏拉桥 / MFG / Core DLC；禁止再推 800MB+ 全家桶。
