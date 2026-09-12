# DLSS5-Manager-ZJZ

装机宅 DLSS5 **开源安装器 / 管理器壳**（MIT）。

## 边界
- **本仓（MIT）**：游戏发现、配方安装/卸载、DLC pin 清单、可检查/下载更新（类 RHI）、失败可读。
- **Core**：`dlss5-nr-before-sr-lab` 发版（MIT 源码；**不**塞 NVIDIA DLL）。
- **专有面**：签名发行、防再分发、部分 UI/米哈游专属能力可仍在私有 Manager 发行线（见既有 `dlss5-manager` ARR）。
- **DLC（外链）**：Bridge / Feeder / MFG / nvngx·SL 等二进制 — 只维护 manifest + pin + 更新源，**不**进本仓源码树。

## 当前 pin（摘要）
- **MFG Unlock：优先/默认 0.9**（`mavismmg/MFGAdaUnlock-RenoDx`）；0.7 仅回滚。
- **Bridge**：可读 pin（BG3 → 1.4.11；勿无脑 1.4.13-pre）。见 lab #224。
- **dlssnr**：场上 310.8.SF-v2，无公开更新则别乱动。

## 并行
- 接入点兼容（Reno 多 hook）→ lab **#190**（勿把仓乱堆进 #190）。
- 安装器 P0：mgr **#27/#28**（提权误拦 / 大 EXE digest）→ lab PR **#251**。

## 话术
先壳 → 按游戏拉桥/MFG/Core DLC；禁止再推 800MB+ 全家桶。

## 本仓骨架

Node 22 + TypeScript CLI。不嵌入 DLC 二进制。公开 ARR `dlss5-manager` 只作概念对齐，不拷源码。

```sh
npm install
npm run check
node dist/src/index.js pins
node dist/src/index.js check
node dist/src/index.js discover
node dist/src/index.js install bg3
```

`check --live` 才会访问更新源的 Releases JSON；默认只说明将如何 GET。架构与边界见 [ARCHITECTURE.md](ARCHITECTURE.md)，pin / 节奏见 [docs/DLC-PIN.md](docs/DLC-PIN.md)，可选模块见 [docs/OPTIONAL-MODULES.md](docs/OPTIONAL-MODULES.md)。

**本仓不宣称 mgr #27 / #28 已修**（仍在 lab PR #251，待 Windows 复测）。
