# Manager UI 开发指南

桌面版本由 `desktop/package.json` 管理；Core 版本单独记录。改 UI 不需要同步修改 Core 版本。

## 首次启动

Windows 10/11、Node.js 22 或更新版本。克隆本公开仓库后，在根目录执行：

```powershell
npm ci
npm --prefix desktop ci
npm run start:desktop
```

两个 lockfile 均已提交，两个目录的依赖都要安装。启动命令会先生成共享预检模块。UI 开发无需先获取私有 Core 仓库、NVIDIA SDK 或签名证书；未准备渲染组件时界面会显示相应状态。

## 文件地图

| 目标 | 位置 |
| --- | --- |
| 主页面和导航 | `desktop/src/renderer/index.html`、`renderer.js` |
| 公共样式和布局 | `desktop/src/renderer/style.css`、`workspace-layout.css` |
| 游戏详情、NR/SR/FG | `desktop/src/renderer/game-page-ui.js`、`game-page.css`、`launch-settings-ui.js` |
| 米哈游 | `desktop/src/renderer/hoyo-page-ui.js`，复用共享游戏编辑器 |
| 组件库 | `desktop/src/renderer/component-library-ui.js` |
| 反馈 | `desktop/src/renderer/compatibility-panel.js`、`compatibility-panel.css`、`compatibility-integration.js` |
| IPC | `desktop/preload.js`、`desktop/main.js` |
| 状态、安装与恢复 | `desktop/src/product/` |

`desktop/src/product/generated/` 由根目录生成，不手改。测试中的旧版本名称是模拟样本，不能据此修改发行 pin。

## 模拟数据测试与截图

下面的 Electron 测试使用真实 renderer 和受控 IPC，不启动真实游戏、不写 NVIDIA 驱动；完成后会退出。日常交互使用 `start:desktop`。

在 desktop 目录执行：

```powershell
npm run test:ui-contract
npm run test:game-page

$env:GAME_UI_HOYO = '1'
npm run test:game-page
Remove-Item Env:GAME_UI_HOYO

New-Item -ItemType Directory -Path build -Force | Out-Null
$env:GAME_UI_WIDTH = '900'
$env:GAME_UI_HEIGHT = '620'
npx --no-install electron test/compatibility-full-ui.electron.cjs build/feedback-900x620.png
Remove-Item Env:GAME_UI_WIDTH, Env:GAME_UI_HEIGHT
```

普通样本在 `test/helpers/game-page-beta3-fixture.cjs`，米哈游样本在 `test/helpers/hoyo-page-fixture.cjs`，反馈样本在 `test/helpers/compatibility-feedback-fixture.cjs`。修改 IPC 数据时同步维护夹具，不为通过测试而删除草稿、旧状态或失败恢复断言。

布局检查受影响页面和 1100×780、900×620 两种尺寸；交互检查焦点、未应用草稿、关闭预览、快速切换游戏和异步旧结果。安装/恢复改动增加相应产品服务测试，外部资源说明见 [LOCAL-BASIC-TESTS.md](LOCAL-BASIC-TESTS.md)。

## Core 侧需要做什么

**只改 UI：不需要 Core 侧改代码。** Manager 业务源码和模拟界面夹具均在本仓。

真实组件联调或打包时，由组件维护者提供：

1. 冻结版本的 Core Addon、同源 `nrchain_nvngx.dll`、对应配置和来源记录，不混用其他版本的 chain。
2. 组件 ID、版本、架构、接口/能力及逐文件 bytes/SHA-256。可识别的 Core Acceptance 格式和 Provider 合同见 [COMPONENT-PACKS.md](COMPONENT-PACKS.md)。
3. 按显卡族区分的授权 NR runtime，以及目标路线需要的 Bridge/Feeder/MFG/host/Vulkan 组件。按[示例](MANAGER-DISTRIBUTION-STAGING.example.json)准备个人 staging 清单，不提交个人绝对路径。

Core 的 ABI、配置键或能力声明变化时，先同步接口、默认值和兼容范围，再更新 Manager 适配与测试。新 GPU 后端所需 SDK、真实 NR/光流与游戏画面验收继续由组件任务负责，不是开始 UI 协作的前置条件。

合入 `main` 建立协作基线，不自动发布安装包，也不把候选组件标成已完成游戏兼容验收。
