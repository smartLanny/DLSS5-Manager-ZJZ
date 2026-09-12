# Manager 组件包约定

Manager 的组件库按文件 SHA-256 保存多版本候选。导入成功只表示文件和清单一致；候选不会因此变成已完成游戏兼容验收的版本。组件库当前接受 `core`、`bridge`、`feeder`、`mfg`、`nr-runtime`、`host` 六类，组件 ID、版本、架构、接口和每个文件的 bytes/SHA-256 都必须明确。stage 还允许暂存 `vulkan` 小组件，但当前组件库没有独立 `vulkan` kind；这类目录会先作为 staging 候选，不能被文档当作已经接入的 Vulkan 安装路线。

## 通用组件清单

标准清单文件名为 `component-manifest.json`，顶层使用 `schema: "dlss5-component-v1"`，至少包含：

```json
{
  "schema": "dlss5-component-v1",
  "id": "example-component",
  "kind": "bridge",
  "version": "1.0.0",
  "variant": "official",
  "architecture": "x64",
  "interface": "NGX-D3D12-Feature1",
  "gameApis": ["dx11"],
  "hardwareFamilies": ["RTX40"],
  "inputInterfaces": ["NGX-D3D12-Feature1"],
  "supportsPresent": false,
  "files": [
    { "path": "example.addon64", "bytes": 0, "sha256": "<64-hex>" }
  ]
}
```

`files` 是数组，每项都需要相对路径、bytes 和 SHA-256；目录或 ZIP 里的实际文件必须逐项匹配。`validation`、`blockers` 和 `capabilities` 等字段可以随清单声明，但导入结果最高仍是 `candidate`，不会凭清单自称已验收。ZIP 和目录不能含链接、路径穿越、重复路径或位数不符的 PE 文件。

## Core 上游 Acceptance 包适配

没有 `component-manifest.json` 时，组件库可以识别特定的 Core Acceptance 目录：目录同时包含 `build-info.json` 和 `SHA256.json`，其中 `build-info.json.schema` 必须是 `nr050-core-only-acceptance-v1`，`version` 必须是合法版本 ID，`binaries` 必须明确且只包含一个 `.addon64` 和 `nrchain_nvngx.dll`。`SHA256.json` 中每个文件的摘要、实际文件摘要、bytes 和 `build-info.json.binaries` 必须相互一致。

适配器据此生成 Core 组件记录：`kind=core`、`architecture=x64`、接口为 `NGX-D3D12-Feature1`，组件 ID 由版本和 Addon 摘要前缀组成；只有 `processing_starts` 包含 `Present` 时才声明 `supportsPresent:true`。这条适配只识别上述固定 Acceptance schema，不代表任意 Core ZIP 都可导入；当前默认 D15 Core 仍要经过 staging 的版本和来源校验。

## 外部 Provider 包

需要完整路线描述的 Feeder/外部 Provider 包必须在组件库中包含唯一的 `external-provider-package.json`。库存行必须是 `kind=feeder`、架构 `x86`/`x64`/`mixed`、接口 `NRExternalProviderV1`、来源为 `catalog` 或 `user-imported`，状态为 `candidate` 或 `blocked`；文件索引保存于 `objects/<sha256>/<basename>`，清单本身也必须经过同样的摘要保护。

Provider 清单使用精确 schema `dlss5-external-provider-package-v1`，顶层只允许 `schema`、`interface`、`contract`、`defaults`、`routes`：

- `interface` 需要 `name: "NRExternalProviderV1"`、`version: 1` 和字符串形式的 `requiredCoreCapabilities`。
- `contract` 需要 `provenance`（`Native` 或 `Synthetic`）、`scope`、`colorContract`、`srInjected`、`fgInjected`。
- `defaults` 只含 `definitions`、`hostGuides`、`feeder` 三段字符串配置。
- 每条 `routes` 需要 `id`、API（`dx9`/`dx10`/`dx11`/`dx12`/`vulkan`）、架构、显卡族、加载后端、proxy entries、`hostRequired`、`transport`、`relay`、`wrapper`、`coreDirectory`、`runtimeDirectory` 和 `files`。
- `wrapper`（如有）必须声明 id、version、`outputApi:"dx12"`、entry、`systemRuntime`、`privateRuntimeBundled`、`minimumWindows`；路线文件不能占用 `core`、`core-chain`、`core-config` 或 `nr-runtime` 角色，每条路线必须有且只有一个 `provider` 文件。

导入后 Provider 仍是候选。选择路线时，Manager 会要求当前 x64 Core 声明 `NRExternalProviderV1` 和清单要求的 capabilities，同时要求唯一同源 `nrchain_nvngx.dll`、当前 Core 的 `nr_before_sr.ini`、匹配显卡族的当前 NR runtime，以及库存中对应 SHA-256 文件。配置部署后允许按原事务修改；不匹配时可选路线保持不可用，不回退到旧 Core。

当前 staging 的 Provider 候选包括 DX12 stable OF `0.15.1`、DX12 preview OF `1.16.0-beta.1`、已修正为 r2 的 DX9/DX10/DX11/DX12 legacy host，以及 Vulkan `vulkan-d15-r3`。preview 保留为可选候选；这些包仍是候选状态，不能当作最终游戏兼容结论。Provider 包保留内部清单、许可证、shader/config 和 provenance，Core/chain/NR runtime 由当前库存按 `currentCore`/`currentRuntime` 注入。

## MFG 与恢复

MFG Unlock 的游戏设置选择器按 provider ID 切换已登记版本。当前内置 provider 以官方 0.9 为默认，0.7/0.6.1 作为固定回退；选择会经过预览、精确文件摘要校验和单游戏事务，再写入 ReShade 配置及 MFG 收据。收据保存 provider ID、安装后摘要和原组件快照，恢复时仍按这些摘要核对。

组件库会按摘要缓存多个版本。请保留旧版本库存和对应收据；新版本使用独立 ID，不能覆盖已有 ID 的不同文件集合。外部 MFG 文件进入 `kind=mfg` 库存后，会由 MFG provider library 按库存范围注入现有游戏设置 provider 选择器，并按实际 SHA-256、PE 位数和 provider 范围校验部署；pending/migration 恢复会保留 provider 身份，未知或被阻止的版本仍不能直接安装。

当前已知 RTX runtime 支持固定摘要的裸文件导入；新版运行包支持带 NGX-Feature18 接口、x64 位数、单一显卡族和完整摘要的组件清单导入，仍作为未实测候选。当前没有项目公开下载资产。Bridge、Feeder 和其他外部包同样需要实际文件、组件清单和独立验收状态，不能只凭 release 标签或任意版本号启用。
