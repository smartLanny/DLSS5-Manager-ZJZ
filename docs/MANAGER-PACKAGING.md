# Electron Manager 打包与拆包说明

## 输入清单

`desktop/scripts/stage-manager-distribution.cjs` 接受仓库外 JSON 清单。示例在 [MANAGER-DISTRIBUTION-STAGING.example.json](MANAGER-DISTRIBUTION-STAGING.example.json)，实际清单不要提交到仓库，因为它含本机路径和外部 payload 位置。

清单要提供：

- 活动 Core payload 根目录、`core.version` 新安装默认值和 `core.versions` 同包版本白名单；默认值必须是完整的 `0.4.7beta`，版本名含 D13/D14 时直接拒绝。
- 每个白名单版本会固化为自己经过哈希校验的 Core、`nrchain_nvngx.dll` 和配置。D21 只保留测试身份，不能成为默认项。精确文件尚未准备好的版本不要写进白名单，Manager 会把对应菜单项显示为“组件未准备”，不得用相近版本替代。
- 可选但推荐提供已验收 Core 原始包的 bytes、SHA-256、source commit 和 source-manifest SHA-256。D21 累计常规版只能使用精确 OTA 身份；原始包和清单校验信息不得靠改名推断。
- 授权 runtime 根目录下的 RTX40、RTX50 `nvngx_dlssnr.dll`，各自的 bytes 和 SHA-256。两族各一份，RTX40 作为 RTX20/30/40 的共享安装族。
- 官方 MFG 1.0 Addon（默认），固定为 710144 bytes、`f9f10c685e3e89077f751df2394a1629615a56b58d111dff26b39894e772d50e`；同时保留官方 0.9 回退版（601088 bytes、`64184bb370f223c3cabb359010a9a64e114cdae6b62d8b014a731a602af0a0da`）。0.7 只保留历史恢复识别，不进入安装或回退菜单。
- Bridge 的登记信息来自 staging 清单；没有候选小组件时保留 `reserved`。当前清单提供官方 release 的 `1.4.13-pre8` 候选（固定 tag、commit、bytes 与 SHA-256），因此 stage 的 `resources/bridge-dlc/manifest.json` 记录为 `candidate-staged`，但 `defaultEligible=false`，不会替换现有固定 Bridge，也不会把候选宣称为兼容。独立验收完成后再更新状态和相应 pin；已被取代的 pre7 会被 beta2 清单生成器拒绝。
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

0.5.0-beta.2 的外部 staging 登记三个 `NRExternalProviderV1` 候选：stable AMD OF `0.15.1`（DX12/x64）、legacy host `0.15.1-d16-adapter-r3`（DX9/DX10/DX11/DX12，mixed）和 Vulkan `vulkan-d15-r3`（Vulkan/x64）。旧包中的 preview OF `1.16.0-beta.1` 不进入本次清单。它们保留各自的 `component-manifest.json`、`external-provider-package.json`、许可证、shader/config 和 provenance；Core addon、同源 `nrchain_nvngx.dll`、`nr_before_sr.ini` 与大型 NR runtime 由当前 Core/Runtime 库存注入。provider 自有 `dlss5-feed.cfg` 或 `ReShadePreset.ini` 仍是路线配置，不是 Core 配置。所有版本仍保持候选状态，未因此宣称游戏兼容。

## 两种 flavor

| flavor | 包含 | 不包含 |
| --- | --- | --- |
| `base` | Electron、默认 Core、ReShade、`nrchain_nvngx.dll`、MFG 1.0/0.9、Bridge、Feeder 及清单中 `includeIn` 命中的开源小组件 | 两个大型 `nvngx_dlssnr.dll`、RenoDX NR Add-on、未列入 staging 的组件 |
| `offline` | base 全部内容，加 RTX40 一份和 RTX50 一份 `nvngx_dlssnr.dll`，以及同样命中的小组件 | 其他重复的 Feeder/Vulkan/legacy runtime |

未传 `--work-root` 时，stage 位于 `desktop/.packaging-stage/<flavor>`，交付位于仓库根目录的 `deliveries/`；两处都被 Git 忽略。磁盘空间紧张或不希望占用 C 盘时，应传入专用的非系统盘工作目录，例如 `--work-root D:\DLSS5-Build`。脚本只会清理带自身标记的 stage 和明确的新交付目录，拒绝把无关目录当成构建缓存覆盖。

两种 flavor 都保留系统辅助脚本，以及 `fg-components` 的五个恢复元数据和许可证文件，供旧安装记录识别与恢复使用；该静态清单不会附带旧 FG/UAL 二进制。

## 命令

```powershell
# 共享 CLI/Desktop contract 生成需要仓库根目录的 TypeScript 依赖
npm ci
cd desktop
npm ci
$env:DLSS5_MANAGER_STAGING = 'C:\path\manager-distribution-staging.json'

# 只读核对外部输入，不生成交付物
npm run verify:staging

# RC 基础包（不会绕过缺失的正式发布门禁）
npm run build:base

# 正式公开目录式便携 ZIP；必须通过精确 0.3.3.4 与组件矩阵门禁
npm run build:release -- --work-root D:\DLSS5-Build

# C 盘空间紧张：全部 stage 和交付物放到指定的 D 盘工作目录
node scripts/build-manager.cjs --flavor offline --work-root D:\DLSS5-Build

# RC 目录式便携 ZIP
npm run build:portable

# 本机缺少 NSIS 签名/符号链接条件时，生成可直接解压测试的完整目录 ZIP
node scripts/build-manager.cjs --flavor base --unpacked-zip --work-root D:\DLSS5-Build

# 本地 Full.zip：只嵌套四个独立 ZIP，VC++ 运行库仍在外面
node scripts/build-local-full.cjs --portable D:\Packages\DLSS5-Manager-0.5.x-Portable.zip --renodx D:\Packages\RenoDX-Addon.zip --rtx40 D:\Packages\RTX40-DLC.zip --rtx50 D:\Packages\RTX50-DLC.zip --out D:\Packages\DLSS5-Manager-0.5.x-Full.zip

# 无需 Core/NR 资产的外部组件版，适合验证桌面源码打包
npm run build:external
```

`build-manager.cjs` 会先从仓库根目录生成共享 CLI/Desktop contract，再生成 stage、运行图标生成、核对实际打包资源的分发策略和调用 Electron Builder。独立运行 `desktop` 的 `npm start`、`test:unit`、`test:game-page` 和 `build:external` 也会生成该 contract。它不调用旧的全量 `extraResources` 列表，因此不会把 `resources/feeder-runtime`、`resources/vulkan-runtime`、`resources/legacy-runtime` 中的 runtime 重复复制进包；基础包只复制上述四个 Vulkan ReShade layer 文件。

base/offline 输出目录写入 `build-config.json` 和 `packaging-report.json`；后者记录 flavor、Core 版本、MFG 摘要、最终 artifact 路径，以及本次构建配置的路径与 SHA-256。配置保留实际 stage 的绝对路径，只供本地验包，不提交 Git。`--dry-run` 会生成 stage 并返回规划结果，不删除既有交付目录，也不创建离线 ZIP。

验包时，使用该次构建保存的配置，并保留对应源代码、stage 和 Electron 依赖。配置必须位于待验 `win-unpacked` 目录之外：

```powershell
node scripts/verify-distribution-policy.js --build-config ../deliveries/DLSS5-Manager-0.5.0-beta.2-base/build-config.json
node scripts/verify-manager-release.js --dir ../deliveries/DLSS5-Manager-0.5.0-beta.2-base/win-unpacked --build-config ../deliveries/DLSS5-Manager-0.5.0-beta.2-base/build-config.json --nsis-dir "$env:LOCALAPPDATA/electron-builder/Cache/nsis/nsis-3.0.4.1" --output build/base-verification.json
```

验证器按实际配置检查 stage 和附带文件的摘要；动态构建未提供配置时直接报错，避免把空静态资源列表误判为验包通过。`--nsis-dir` 应指向该次构建所用、含 `elevate.exe` 的可信 NSIS 工具目录；更换 builder 工具版本或缓存位置后相应更新。`build:external` 使用单独的静态资源白名单，输出到 `desktop/dist-external/`，并自动运行 `verify:external`。

RC 清单可暂时只启用已到位的精确来源，但正式发布命令要求 `0.2.0-beta.2`、`0.3.3-dev-r4`（界面显示 0.3.3.4）、`0.4.2`、`0.4.7beta`、`0.5-dline21` 同时存在，且默认仍为 `0.4.7beta`。`0.3.3.4` Core 必须正好是 652288 bytes、SHA-256 `2869d7d6b2d184b4200c3eb7ac671db0299be64e7625c4f816ee26b41890bfb9`；门禁拒绝缺失、改名或替代文件。D21 只作为显式测试项。

MFG provider pin 位于 `desktop/src/product/fg-mfgunlock-providers.json`，资源目录的 `manifest.json` 只负责声明当前 stage 的文件。运行时先用 provider pin 验证资源目录，再按 provider 读取 addon；因此官方 release 增加新 provider 时可以登记新 JSON 记录，不必把每个版本再写进 JS。

当前 MFG 1.0 和 0.9 的裸 Addon 或 component-manifest ZIP 可以进入 component-library 库；`kind=mfg` 库存会由 MFG provider library 注入现有 FG provider selector，并按实际 SHA-256/PE 位数校验部署，pending/migration 恢复保留 provider 身份。未完成独立验收的版本仍保持候选状态。

offline 构建还会在 `deliveries/` 旁生成 `*-nr-runtime-offline.zip`。ZIP 只含 `RTX40/nvngx_dlssnr.dll` 与 `RTX50/nvngx_dlssnr.dll` 两个条目，不附带自定义 manifest；当前组件目录已有这两个摘要，导入器会按已知 catalog 识别 ZIP 内的裸 DLL，并把两个硬件族分别登记。

## 验收边界

构建前检查的是来源身份、文件摘要和包白名单；它不能证明某个游戏、驱动或 GPU 的实际兼容性。Bridge 的 `candidate-staged` 或 `reserved` 状态都不能作为 DX11 兼容结果，MFG 文件检查也不能证明游戏已输出生成帧。要恢复可选路线，必须先有对应的公开资产和独立验收证据，再扩展 staging 白名单。

源快照由 [MANAGER-MIGRATION-SOURCE.json](MANAGER-MIGRATION-SOURCE.json) 固定记录，本次拆包入口和文档变化单独记在 [MANAGER-MIGRATION-INCREMENTAL.md](MANAGER-MIGRATION-INCREMENTAL.md)。
