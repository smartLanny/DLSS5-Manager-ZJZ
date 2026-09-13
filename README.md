# DLSS5 Manager ZJZ

这是装机宅 DLSS5 Manager 的公开集成仓库：根目录保留 MIT CLI / 配方壳，`desktop/` 承载迁入的 Electron Manager 源码。两者共用 pin、组件边界和拆包策略，源码树不提交 NVIDIA runtime、Addon 成品或签名材料。

当前桌面开发版本为 **0.5.0-beta.1**。本仓作为 Manager 的协作开发入口，包含桌面界面、主进程、安装与恢复、组件库、米哈游流程、反馈及测试；Core 算法和 GPU 后端继续在各自的组件仓库维护。

## 从源码开始改 UI

Windows 10/11、Node.js 22 或更新版本。在仓库根目录执行：

```powershell
npm ci
npm --prefix desktop ci
npm run start:desktop
```

UI 源码位于 `desktop/src/renderer/`。启动桌面界面不需要先编译 Core 或准备 NVIDIA DLL；安装和实际游戏联调才需要经校验的外部组件。仓库已包含固定版本的上游源码，无需访问私有 lab 或另行初始化 submodule。

修改后运行 `npm run check` 和 `npm --prefix desktop run test:ui-contract`。游戏卡片、米哈游和反馈有使用模拟数据的 Electron 测试与截图入口，详见 [UI 开发指南](docs/UI-DEVELOPMENT.md)。多人协作流程和分层约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发行边界

- **基础 Manager 包**：Electron UI、默认 Core、ReShade、`nrchain_nvngx.dll` 等小型配套、MFG Unlock 0.9 登记与安装资源。
- **RTX20–40 / RTX50 运行库包**：只在本地离线整合包中分别放一份 `nvngx_dlssnr.dll`；基础包不嵌入大型 NVIDIA DLL，用户也可以从完整外部组件目录导入。
- **小组件 staging**：Bridge、Feeder、host、Vulkan 只有在外部 staging 清单逐文件提供 bytes/SHA-256 后才会进入 `resources/components/`；大 NR runtime 永远沿用独立运行库包。
- **Vulkan layer**：基础包保留原 `resources/vulkan-reshade/` 的四文件 ReShade layer，供动态 Vulkan provider 和 Bridge 复用 HKCU 激活；旧 Vulkan Core/chain/NR 运行池不随包恢复。
- **DX11 Bridge**：当前 staging 已携带 `1.4.13-pre7` 的 manager-core-compat 候选包及 importer manifest；包内记录为 `candidate-staged`，独立游戏兼容验证完成前不会把它宣称为已兼容。
- **旧 Manager 源码**：迁移快照已冻结；这不冻结仍在活跃 Core 任务中的组件产物。原始迁移清单保持不变，增量记录见 [docs/MANAGER-MIGRATION-INCREMENTAL.md](docs/MANAGER-MIGRATION-INCREMENTAL.md)。

二进制输入通过外部 staging 清单提供，构建只复制清单白名单。交付目录位于本仓根目录的 `deliveries/`，由 Git 忽略；构建不会把交付物加入源码提交。

## CLI 壳

根目录是 Node 22 + TypeScript CLI，负责游戏发现、配方 dry-run、DLC pin 和更新元数据检查：

```sh
npm install
npm run check
node dist/src/index.js pins
node dist/src/index.js check
```

默认 `check` 只输出 FetchPlan；只有显式 `--live` 才访问 Releases 元数据。CLI 不加载 Core/Feeder/NVIDIA DLL，也不执行 GPU 或游戏安装。

## Electron Manager 打包

先准备仓库外 staging 清单，格式见 [docs/MANAGER-DISTRIBUTION-STAGING.example.json](docs/MANAGER-DISTRIBUTION-STAGING.example.json)。清单必须指定活动 Core 版本、授权的 RTX40/RTX50 runtime 文件和已批准的 MFG 0.9 SHA-256；D13/D14 Core 会被入口拒绝。

```powershell
# 先在仓库根目录准备共享 CLI/Desktop contract 生成所需依赖
npm ci
cd desktop
npm install
$env:DLSS5_MANAGER_STAGING = 'C:\path\manager-distribution-staging.json'
npm run verify:staging
npm run build:base
npm run build:offline
```

`build:base` 的 stage 只含小组件，`build:offline` 才复制 RTX40 与 RTX50 两个大型 runtime。两种构建都不复制 Feeder/Vulkan/legacy 中的重复 runtime；可选路线缺少资源时由 Manager 显示未准备状态。实际构建使用动态 Electron Builder 配置，避免把历史 `extraResources` 全量列表重新带入包。

根目录检查：

```powershell
npm run check
node scripts/assert-no-payloads.mjs
```

检查会正确处理 Windows 路径，跳过 `node_modules`、release、deliveries 和合法的 ignored stage；源码和已跟踪文件仍禁止 DLL、Addon、NVIDIA runtime 与私钥材料。

运行库包、手动导入和 VC++ 修复说明见 [docs/RUNTIME-PACKS.md](docs/RUNTIME-PACKS.md)。

## 组件 pin

权威 pin 见 [config/pins.json](config/pins.json) 和 [docs/DLC-PIN.md](docs/DLC-PIN.md)。MFG 默认 0.9、0.7 仅回滚；BG3 Bridge 继续固定 1.4.11，禁止把 latest 或 1.4.13-pre 当作兼容结论。Bridge/Feeder/Core 的真实接口与游戏验收仍由相应组件任务负责。

架构和仓库边界见 [ARCHITECTURE.md](ARCHITECTURE.md)，打包拆分与验收细节见 [docs/MANAGER-PACKAGING.md](docs/MANAGER-PACKAGING.md)。
