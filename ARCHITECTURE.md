# DLSS5 Manager ZJZ 架构边界

本仓库有两个可组合的产品面：根目录的 MIT CLI 壳，以及迁入 `desktop/` 的 Electron Manager。二者都只提交源码、pin、清单和许可证文本；实际运行库由仓库外 staging 清单在本地打包时注入。

## 组件面

| 面 | 所在位置 | 责任 | 发行约束 |
| --- | --- | --- | --- |
| CLI / 配方壳 | `src/` | 发现、配方 dry-run、pin、更新元数据 | 不加载 DLL，不写游戏，不带 payload |
| Electron Manager | `desktop/` | 游戏选择、API/Core 路由、安装/恢复 UI、外部组件来源 | 源码可公开；构建资源必须来自 staging 白名单 |
| Core | 外部活动任务产物 | NR 算法与 Addon | 默认 Core 必须在 staging 清单中明确版本；拒绝 D13/D14 冒充最新 |
| NR runtime | 外部授权目录 | RTX20–40 共享 RTX40 runtime、RTX50 runtime | 基础包不嵌入；offline 包各放一份，禁止 Feeder/Vulkan/legacy 重复携带 |
| MFG | 外部官方 0.9 Addon | RTX40 的 MFG Unlock 入口 | 0.9 固定 bytes/SHA；0.7 仅回滚，由 Manager 清单登记 |
| DX11 Bridge | `bridge-dlc/manifest.json`（stage） | 候选来源和兼容状态登记 | 当前只允许 `reserved`；独立兼容任务验证后才可启用 |
| 可选小组件 | `resources/components/`（stage） | 外部清单提供的 Bridge、Feeder、host、Vulkan 文件 | 必须逐文件 pin；不允许 `nvngx_dlssnr.dll` 混入 |

## 运行时数据流

```text
外部 staging JSON
       │
       ├─ Core bundle v4 + ReShade + nrchain
       ├─ RTX40 / RTX50 nvngx runtime（offline flavor 才复制）
       ├─ MFG 0.9（固定摘要）
       ├─ 外部 staging 小组件（可选，逐文件摘要）
       └─ Bridge reservation（无二进制、无兼容宣称）
       │
       ▼
desktop/.packaging-stage/<flavor>
       │
       ▼
Electron Builder → 仓库外 deliveries/
```

`desktop/scripts/stage-manager-distribution.cjs` 是唯一 payload 组装入口。它逐文件检查普通文件、大小和 SHA-256，拒绝符号链接，拒绝 D13/D14 版本，并且只把 Core 允许的三类小文件、固定 ReShade/chain、授权 runtime、MFG 0.9 放入 stage。`desktop/scripts/build-manager.cjs` 以 stage 生成动态 electron-builder 配置，不继承旧的 Feeder/Vulkan/legacy 全家桶资源列表。

## 基础包和离线包

基础包解决首次启动和 UI 使用所需的小组件，启动后如果本机显卡需要 NR runtime，Manager 会提示选择完整外部组件目录。离线包的差别只有运行库注入：`fixed/RTX40/nvngx_dlssnr.dll` 覆盖 RTX20/30/40，`fixed/RTX50/nvngx_dlssnr.dll` 单独覆盖 RTX50。两者都来自 staging 清单对应的授权目录；不得从旧 D13/D14 包或历史 `dist` 目录推导默认 Core。

Feeder、Vulkan 和 legacy x86/DX9 属于独立路线，当前打包入口不把它们的 runtime 复制进基础包或离线包。缺少这些可选资源时，Manager 应保留可读的未准备状态，不能把文件存在性当成兼容性结论。

## 仓库安全边界

- `docs/MANAGER-MIGRATION-SOURCE.json` 是原始 tracked snapshot，保持不改；迁移后的打包增量另记在 `docs/MANAGER-MIGRATION-INCREMENTAL.md`。
- `scripts/assert-no-payloads.mjs` 扫描源码和工作树中的实际文件，跳过 node_modules、release、deliveries 和合法 ignored stage；Windows 使用 `fileURLToPath` 解析脚本路径。
- 源码、已跟踪资源和文档不得包含 DLL、`.addon64`、`nvngx_*`、私钥或签名材料。stage 是临时构建输入，交付物留在仓库外。
- CLI 的 pin 是版本策略，不是二进制认证；Manager 的 staging SHA-256 是构建前输入检查，也不替代真实游戏/Core 接口验收。

## 未来接口

Bridge 任务可以在不改变 Manager UI 的情况下，把 `bridge.status` 从 `reserved` 更新为经过独立验收的登记项。Runtime、Feeder 和 Vulkan 若要重新进入发行包，必须新增明确的 flavor/白名单和不重复 runtime 的体积审计，不能恢复旧的整包 `extraResources` 列表。
