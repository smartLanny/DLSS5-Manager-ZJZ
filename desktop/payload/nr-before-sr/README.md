# 装机宅版 Release payload

发行包使用紧凑结构：每个显卡族只保留一套固定运行组件，每个可切换版本只保留 addon 和配置。

目录结构如下；0.4.6 发行包默认选择 `versions/0.4.6`，其他版本用于用户手动切换测试：

- `fixed/RTX40`、`fixed/RTX50` — 对应显卡族的 `ReShade64.dll`、`nrchain_nvngx.dll`、`nvngx_dlssnr.dll`
- `versions/0.2.0-beta.2`、`versions/0.3.3.5` — 历史版本的 addon 和 `nr_before_sr.ini`
- `versions/0.4.5-ota` — 公共名称固定为 `0.4.5-DX11-兼容增强`，必须同时包含中文核心、`nrchain_nvngx.dll`、`dlss5-native-carrier-045-dx11-compat.addon64` 和默认 INI

历史版本继续使用 `fixed/RTX40` 或 `fixed/RTX50` 中的共用 `nrchain_nvngx.dll`。`0.4.5-ota` 使用自己版本目录内的匹配 chain；安装或修复时会和核心、carrier 成套校验和替换，但已有 `nr_before_sr.ini` 不覆盖。

这些文件必须是**合法取得且相互匹配的 x64 文件**。如果重新准备 payload：

- 固定运行文件放入对应的 `fixed/<family>` 目录；
- 历史版本 addon 和配置放入对应的 `versions/<version>` 目录；`0.4.5-ota` 还必须放入匹配的 chain 和上述精确 carrier 文件名。只使用已验证的 `beta0.4.5-dx11-compat` / PE 0.4.5.104 中文构建，不可用旧二进制改名代替。

兼容范围：已有原生或模组 DLSS 的 DX11-x64 游戏，以及原有 D3D12 SR 与已知硬件深度 RR 路线。不包含无 DLSS/Feeder、Vulkan、DX9/DX10/OpenGL 或 x86 Legacy。

0.4.6 在已验证的 hotfix.3 载荷上追加，旧槽位保留用于回退：

```powershell
node scripts/prepare-release-046.js <已核验的0.4.6中文OTA解包目录> <已核验的默认INI>
```

脚本固定源码 `9087a9efbc7bb53a3c79e7766a174534f49c412c` 及中文核心、nrchain、carrier、INI 哈希；
Manager 产品版本 0.4.6 / Windows 文件版本 0.4.6.0，内置核心 PE 0.4.6.0。
版本目录只含中文核心、默认 INI、nrchain、配套 DX11 carrier。DX12 仅部署核心与 nrchain；
carrier 只在确认 DX11 且兼容桥接勾选时部署，不支持 Vulkan。旧 0.4.5 槽保持原字节。

Then run:

```powershell
node scripts/verify-payload.js --write
```

脚本会写入带 SHA-256 校验值的 `bundle.json`。缺失或校验不匹配时，应用会拒绝安装。
除非单独确认了再分发权利，否则不要把这些二进制提交到公开仓库。


0.4.6-hotfix.1 候选追加方式：

```powershell
node scripts/prepare-release-046-hotfix1.js <已核验的hotfix.1中文OTA解包目录> <已核验的hotfix.1默认INI>
```

源码固定 `35ef9a826642e0eabcecd46d012167dd52b98105`，中文核心 PE 0.4.6.1，
默认 INI 两条最终倍率都为 1.00。已安装游戏的明确 INI 在升级/OTA 时保留；
只有用户主动“恢复默认”时才同时写回 TransferStrength 和 PostTransferStrength=1。
旧 0.4.6 和 0.4.5 槽保持原字节，新候选使用独立槽位，不改旧公开附件。

## 0.5 D13 与 Corefix8 测试槽

经来源、ZIP、Core、chain 和配置 blob 校验后，才可以把两套中文 Core 作为独立的内置更新候选写入：

- `versions/0.5-dline13`：0.5 D13 中文 Core、该包自己的 `nrchain_nvngx.dll` 和 7abd235 源码提交中的 `config/nr_before_sr.ini`；
- `versions/0.4.7beta-corefix.8`：0.4.7 Corefix8 中文 Core、该包自己的 `nrchain_nvngx.dll` 和 6949051 源码提交中的 `config/nr_before_sr.ini`。

两个槽位都只面向已经安装的 D3D12 游戏更新，保留游戏已有 INI；没有 DX11 carrier，不改变 `defaultVersion`，也不能用于首次安装。两个槽位均会保留在普通 Core 版本列表中，名称带“测试”，并标记为 core-update-only。两个槽位的 chain 即使当前 SHA-256 相同，也必须和各自 Core 成套维护，不能把 0.5 与 0.4.7 的 Addon、配置或其它配套交叉复制。

准备命令接受两个已核验的原始 ZIP 和一个包含对应源码提交的本地 Git 工作树：

```powershell
node scripts/prepare-beta7-core-catalog.js <0.5-D13-OTA.zip> <corefix8-zh-CN.zip> <git-repository>
```

脚本先验证固定 ZIP/Core/chain 哈希、ZIP 文件集合和两个源码提交的原始配置 blob，再检查目标槽位和 `bundle.json`；任一输入、配置或已有字节冲突都会在写盘前失败。成功后每个槽位包含 Core、chain、对应配置和 `core-import-receipt.json`，重复执行保持幂等。`bundle.json` 的两个 entry 使用 `compatibility: null`、`comparisonOnly: false`、`coreUpdateOnly: true`、`ota: true`，并记录来源提交、ZIP 哈希、Core/chain 哈希、配置 blob 路径和哈希。
