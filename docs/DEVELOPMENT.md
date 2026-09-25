# Manager 开发与构建指南

普通用户入口是[项目首页](../README.md)和[使用指南](USER-GUIDE.md)。本文承接原 README 中的技术说明。

## 仓库与职责

根目录是 Node.js 22 + TypeScript CLI / 配方与共享预检，`desktop/` 是 Electron Manager。桌面开发版本由 `desktop/package.json` 管理，Core 构建版本单独记录，UI 更新不改变 Core 的 ABI 或算法。

Manager 在本仓独立构建和协作。NR 算法及 Bridge / Feeder / Vulkan 原生后端由对应组件仓库维护；仅通过版本、API、能力、文件清单、SHA-256 和恢复契约协作。不得把私有 Core 源码、NVIDIA runtime、游戏文件、成品 Addon、签名材料和个人 staging 路径提交进源码。

## 从源码启动

Windows 10/11、Node.js 22 或更新版本。在根目录执行：

```powershell
npm ci
npm --prefix desktop ci
npm run start:desktop
```

两个目录的 lockfile 都要使用。启动和桌面测试入口会生成共享预检模块；`desktop/src/product/generated/` 不手改。固定上游源码已包含在 `desktop/vendor/`，开发 UI 无需获取私有 lab 或初始化 submodule。

没有真实 Core / runtime 时可以运行界面和受控测试，不能据此验收安装和游戏渲染。文件地图、游戏页 / HoYo / 反馈夹具和截图命令见 [UI-DEVELOPMENT.md](UI-DEVELOPMENT.md)。

## 检查

```powershell
npm run check
npm --prefix desktop run verify:vendor
npm --prefix desktop run test:ui-contract
npm --prefix desktop run test:game-page
```

`npm run check` 检查共享合同、CLI 和源码无载荷，不代替 Windows 桌面、GPU 或游戏验收。桌面完整测试为 `npm --prefix desktop test`；原生和历史用例所需外部夹具见 [LOCAL-BASIC-TESTS.md](LOCAL-BASIC-TESTS.md)。

安装 / 保存 / 启动 / 恢复变动须验证原文件保留、预览后变化拒绝、失败恢复和实际调用方。UI 检查至少覆盖 1100×780、900×620，以及 200% 缩放下约 960×520 的紧凑工作区；同时覆盖浅深主题、动画开关、长列表和焦点。不得通过删除失败断言宣称通过。

## CLI

```powershell
npm ci
npm run build
node dist/src/index.js pins
node dist/src/index.js check
```

默认只生成 FetchPlan；显式 `check --live` 才检查发行元数据。CLI 不加载 Core / Feeder / NVIDIA DLL，也不执行 GPU 或游戏安装。接口见 [BRIDGE-CLI.md](BRIDGE-CLI.md)。

## 两类构建

**外部组件验证版**不包含专有 Core 和 NR runtime，适合 UI / 状态迁移验证和已有组件的维护者：

```powershell
npm --prefix desktop run build:external
npm --prefix desktop run verify:external
```

输出为 `desktop/dist-external/`。缺少加载助手、桥接器等实际资源时，相应功能仍会拒绝启用；不能把外部版打包成功等同于完整发行配套就绪。

**基础 / 离线整合包**需要仓库外的已批准 staging 清单。格式见 [示例](MANAGER-DISTRIBUTION-STAGING.example.json)：

```powershell
$env:DLSS5_MANAGER_STAGING = 'C:\path\manager-distribution-staging.json'
npm --prefix desktop run verify:staging
npm --prefix desktop run build:base
npm --prefix desktop run build:offline

# 空间紧张时，把 stage 和交付物放到非系统盘；在 desktop 目录执行：
node scripts/build-manager.cjs --flavor offline --unpacked-zip --work-root D:\DLSS5-Build
```

构建仅复制白名单和逐文件 bytes / SHA-256 对应的输入。base 包携带小组件，offline 才加入按显卡族区分的大型 NR runtime。Bridge / Feeder / host / Vulkan 等可选配套单独提供；不能从历史目录顺手复制未审查二进制，也不能混用不同 Core 的 chain。

交付目录 `deliveries/` 和构建输出由 Git 忽略，不进入源码提交。现有 D13 / D14 发布阻止规则和其他入口检查保持有效；具体发布清单仍由 [MANAGER-PACKAGING.md](MANAGER-PACKAGING.md) 规定。

## 组件兼容性与回退

权威 pin 在 [config/pins.json](../config/pins.json) 和 [DLC-PIN.md](DLC-PIN.md)。当前新安装默认提供 MFG 1.0，0.9 是显式回退；0.7/0.6.1 仅用于历史收据恢复，不能作为回退选择。BG3 Bridge 保留 1.4.11，不因上游出现 latest / 预发布就自动替换。

展示名和菜单项不是成品身份，也不构成兼容性证据。D21 的默认策略需要实际完整包；D12 不得重新标为 D21。已有游戏选择优先于新的全局默认。缺可选桥接配套时只阻止对应操作，保留原游戏与 Core。

## 更多文档

[架构](../ARCHITECTURE.md) · [协作](../CONTRIBUTING.md) · [组件包](COMPONENT-PACKS.md) · [运行库](RUNTIME-PACKS.md) · [迁移记录](MANAGER-MIGRATION-INCREMENTAL.md) · [PR5 技术验收](PR5-INTEGRATION-VALIDATION.md)
