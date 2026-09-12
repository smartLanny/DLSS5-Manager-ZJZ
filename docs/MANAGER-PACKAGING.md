# Electron Manager 打包与拆包说明

## 输入清单

`desktop/scripts/stage-manager-distribution.cjs` 接受仓库外 JSON 清单。示例在 [MANAGER-DISTRIBUTION-STAGING.example.json](MANAGER-DISTRIBUTION-STAGING.example.json)，实际清单不要提交到仓库，因为它含本机路径和外部 payload 位置。

清单要提供：

- 活动 Core payload 根目录和明确的 Core 版本；版本名含 D13/D14 时直接拒绝。
- 可选但推荐提供已验收 Core 原始包的 bytes、SHA-256、source commit 和 source-manifest SHA-256；当前 canonical 输入是 D16 `7b056439a981b1392d66d40a746a9fbd2299ca94`，ZH 包为 1613306 bytes，SHA-256 为 `54b7928201f8e9a97d7779373a786650014f8006567da64d1ef931a5829f9b3b`。
- 授权 runtime 根目录下的 RTX40、RTX50 `nvngx_dlssnr.dll`，各自的 bytes 和 SHA-256。两族各一份，RTX40 作为 RTX20/30/40 的共享安装族。
- 官方 MFG 0.9 Addon，固定为 601088 bytes、`64184bb370f223c3cabb359010a9a64e114cdae6b62d8b014a731a602af0a0da`。
- Bridge 的登记信息来自 staging 清单；没有候选小组件时保留 `reserved`。当前清单提供带 importer manifest 的 `1.4.13-pre7` 候选，因此 stage 的 `resources/bridge-dlc/manifest.json` 记录为 `candidate-staged`，带候选 addon SHA 和文件摘要，但不会把候选宣称为兼容。独立验收完成后再更新状态和相应 pin。
- 可选的 `components` 数组。它是小组件的唯一外部注入入口，允许 `bridge`、`feeder`、`host`、`vulkan` 四类；每个文件都要声明来源、stage 相对路径、bytes 和 SHA-256。
- 可选的 `resources` 数组。它只允许当前 Manager 仍需的 HoYoShade、loading-helper、REFramework 入口和 Vulkan ReShade layer 文件，目标路径固定在原来的 `resources/` 子目录；每个文件同样要声明 bytes 和 SHA-256。

路径可以是绝对路径，也可以相对于清单文件。清单之外的文件不会进入 stage。

小组件清单可以为一组文件共用 `sourceRoot`，也可以逐项给出相对于 staging JSON 的 `source`：

```json
{
  "components": [
    {
      "id": "bridge-release-candidate",
      "kind": "bridge",
      "version": "1.4.x",
      "variant": "official",
      "architecture": "x64",
      "interface": "NGX-D3D12-Feature1",
      "gameApis": ["dx11", "vulkan"],
      "includeIn": ["base", "offline"],
      "sourceRoot": "external/bridge-package",
      "files": [
        { "source": "component-manifest.json", "path": "component-manifest.json", "bytes": 0, "sha256": "<64-hex>" },
        { "source": "external-provider-package.json", "path": "external-provider-package.json", "bytes": 0, "sha256": "<64-hex>" },
        { "source": "dlss5-bridge.addon64", "path": "dlss5-bridge.addon64", "bytes": 0, "sha256": "<64-hex>" }
      ]
    }
  ]
}
```

`includeIn` 缺省时同时进入 base 和 offline。stage 会把这些文件原样写到 `resources/components/<id>/`，保留输入中的 `component-manifest.json` 和 `external-provider-package.json`，并另生成 Manager 的 `resources/components/catalog.json`；Bridge/Feeder 若缺少根目录 `component-manifest.json` 会直接拒绝。当前包只登记为外部候选，不改变业务接线或兼容结论。单个小组件文件上限 128 MiB、总量上限 512 MiB，文件名为 `nvngx_dlssnr.dll` 的大型 NR runtime 会被拒绝，必须继续走 RTX40/RTX50 runtime 配置。

`resources` 入口不会恢复 `feeder-runtime`、`legacy-runtime` 或旧 FG/Vulkan runtime DLL；它只补齐现有业务代码实际读取的 profile/helper/REFramework 小资源，以及 Bridge/Vulkan 动态 provider 复用的 ReShade layer。当前 Vulkan ReShade allow-list 是 `LICENSE.md`、`recipe.json`、`ReShade64.dll`、`ReShade64.json` 四个文件。

当前外部 staging 还登记了四个 `NRExternalProviderV1` 候选：stable AMD OF `0.15.1`（DX12/x64，默认候选）、preview OF `1.16.0-beta.1`（DX12/x64，可选）、D16 legacy host `0.15.1-d16-adapter-r3`（DX9/DX10/DX11/DX12，mixed，默认候选）和 Vulkan `vulkan-d15-r3`（Vulkan/x64，默认候选）。它们保留各自的 `component-manifest.json`、`external-provider-package.json`、许可证、shader/config 和 provenance；Core addon、同源 `nrchain_nvngx.dll`、`nr_before_sr.ini` 与大型 NR runtime 由当前 Core/Runtime 库存注入。provider 自有 `dlss5-feed.cfg` 或 `ReShadePreset.ini` 仍是路线配置，不是 Core 配置。所有版本仍保持候选状态，未因此宣称游戏兼容。

## 两种 flavor

| flavor | 包含 | 不包含 |
| --- | --- | --- |
| `base` | Electron、默认 Core、ReShade、`nrchain_nvngx.dll`、MFG 0.9、Bridge candidate-staged/候选包，以及清单中 `includeIn` 命中的小组件 | 两个大型 `nvngx_dlssnr.dll`、未列入 staging 的 Feeder/Vulkan/legacy runtime |
| `offline` | base 全部内容，加 RTX40 一份和 RTX50 一份 `nvngx_dlssnr.dll`，以及同样命中的小组件 | 其他重复的 Feeder/Vulkan/legacy runtime |

stage 位于 `desktop/.packaging-stage/<flavor>`，被 Git 忽略，只用于当前构建。交付位于仓库外的 `../deliveries/`。构建清理的路径被限制在这两个目录，避免把用户的源目录当作输出。

## 命令

```powershell
# 共享 CLI/Desktop contract 生成需要仓库根目录的 TypeScript 依赖
npm ci
cd desktop
npm install
$env:DLSS5_MANAGER_STAGING = 'C:\path\manager-distribution-staging.json'

# 只读核对外部输入，不生成交付物
npm run verify:staging

# 基础包：NSIS + portable
npm run build:base

# 本地离线整合包：NSIS + portable，额外注入两个 runtime
npm run build:offline

# 只需要 portable 时
npm run build:portable
npm run build:offline:portable
```

`build-manager.cjs` 会先从仓库根目录生成共享 CLI/Desktop contract，再生成 stage、运行图标生成和 Electron Builder。独立运行 `desktop` 的 `npm start` 也会先生成该 contract。它不调用旧的全量 `extraResources` 列表，因此不会把 `resources/feeder-runtime`、`resources/vulkan-runtime`、`resources/legacy-runtime` 中的 runtime 重复复制进包；基础包只复制上述四个 Vulkan ReShade layer 文件。输出目录写入 `packaging-report.json`，其中包含 flavor、Core 版本、MFG 摘要和最终 artifact 路径。

当前实际构建的 base 与 offline 报告都记录同一个 D16 source package：`1613306` bytes、上述 SHA-256；这能追溯到 D16 canonical 包，不会把旧 D13/D14/D15 目录误当作默认 Core。

MFG provider pin 位于 `desktop/src/product/fg-mfgunlock-providers.json`，资源目录的 `manifest.json` 只负责声明当前 stage 的文件。运行时先用 provider pin 验证资源目录，再按 provider 读取 addon；因此官方 release 增加新 provider 时可以登记新 JSON 记录，不必把每个版本再写进 JS。

当前已知 MFG 0.9 的裸 Addon 或 component-manifest ZIP 可以进入 component-library 库；`kind=mfg` 库存会由 MFG provider library 注入现有 FG provider selector，并按实际 SHA-256/PE 位数校验部署，pending/migration 恢复保留 provider 身份。未完成独立验收的版本仍保持候选状态。

offline 构建还会在 `deliveries/` 旁生成 `*-nr-runtime-offline.zip`。ZIP 只含 `RTX40/nvngx_dlssnr.dll` 与 `RTX50/nvngx_dlssnr.dll` 两个条目，不附带自定义 manifest；当前组件目录已有这两个摘要，导入器会按已知 catalog 识别 ZIP 内的裸 DLL，并把两个硬件族分别登记。

## 验收边界

构建前检查的是来源身份、文件摘要和包白名单；它不能证明某个游戏、驱动或 GPU 的实际兼容性。Bridge 的 `candidate-staged` 或 `reserved` 状态都不能作为 DX11 兼容结果，MFG 文件检查也不能证明游戏已输出生成帧。要恢复可选路线，必须先有对应的公开资产和独立验收证据，再扩展 staging 白名单。

源快照由 [MANAGER-MIGRATION-SOURCE.json](MANAGER-MIGRATION-SOURCE.json) 固定记录，本次拆包入口和文档变化单独记在 [MANAGER-MIGRATION-INCREMENTAL.md](MANAGER-MIGRATION-INCREMENTAL.md)。
