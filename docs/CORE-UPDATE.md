# 更换 Core

Core 的身份只登记在 `desktop/src/shared/core-catalog.js` 一处。版本菜单、新安装默认值、OTA 识别、HoYo 可选版本、外部 Provider 路线、人脸配套和发布检查都从这里读取。

## 步骤

1. **登记**：在 `CORES` 末尾加一条，填写 ID、菜单名称、`buildVersion`、源码提交、中英文 Core 的 SHA-256、配套 nrchain，以及交付文件的 SHA-256：Core-only OTA 填 `ota`；按显卡分包的交付包（`install/` 结构，例如 0.5.2 Beta 13）填 `packages`，每个包写明包的哈希和大小、包里 DLSS5 模型的哈希、适用的显卡系列。要设为新安装默认，把 `RECOMMENDED` 改成新 ID。
2. **导入**：用中文 OTA ZIP 或 40/50 系交付包生成新的 staging：

   ```powershell
   node desktop/scripts/import-core-ota.cjs --ota <中文 OTA.zip> --staging <当前 staging.json> --output <新的空目录> [--ini <默认 nr_before_sr.ini>]
   node desktop/scripts/import-core-ota.cjs --package <DLSS5-<版本>-RTX40-50.zip> --staging <当前 staging.json> --output <新的空目录>
   ```

   交付包里的 NVIDIA DLSS5 模型不会进入 staging：确认再分发许可之前，公开发布只放 Core、nrchain、人脸资源和许可说明，模型由玩家自己导入。

   脚本会重新计算 ZIP 和包内每个文件的 SHA-256，和清单或 `SHA256.json` 不一致就停止，不写任何文件。旧版本原样复制，大型 NR 模型（`nvngx_dlssnr.dll`）仍由 `runtime.families` 单独提供。OTA 包不含 INI 时，沿用上一个统一 Core 的默认 INI，或用 `--ini` 指定。
3. **核对**：`DLSS5_TEST_CORE_OTA=<中文 OTA.zip> node --test desktop/test/core-catalog.test.js` 或 `DLSS5_TEST_CORE_PACKAGE_DIR=<两个交付包所在目录> node --test desktop/test/core-package.test.js` 会用实际文件核对清单；没有设置时这些测试会跳过，不能当作已核对。
4. **新增的 INI 选项**（Core 新增了玩家可调的设置时才需要）：在 `desktop/src/product/nr-config-contract.js` 登记键名、缺省值和范围，并让它只对带相应标记的 Core 开放。例如 0.5.1 的 `ReconstructionMode`（0 关闭、1 均衡、2 精细）和 `NearBlackChromaGuard`（去除暗噪），只在清单里标了 `reconstruction: true` 的 Core 上显示；判断依据是实际 Core 文件的哈希，不是版本名称。
5. **打包**：用输出目录里的 `staging.json` 运行 `npm --prefix desktop run verify:staging` 和打包命令。发布检查要求默认版本正是清单推荐版，并逐字节核对它的 Core 文件。

## 配套 DLSS5 模型

登记了 `packages` 的 Core（0.5.2 Beta 13）兼容之前所有的 DLSS5 模型，配套模型是可选升级，按显卡系列（不是 RTX40/RTX50 大类）挑选唯一一份：

- 玩家导入交付包或其中的 `nvngx_dlssnr.dll` 后，模型只放进这个 Core 的版本目录，之后安装这个 Core 时优先使用；旧 Core 共用的模型不变。
- 没导入配套模型、认不出显卡系列，或显卡系列不在包的适用范围内时，照常使用共用模型安装，界面只提示可以导入哪个包。
- 版本目录里的配套模型摘要和登记不符时报告文件被修改，不会部署它，也不会按文件名或“最新”猜测。

## 不会发生的事

- 不会覆盖玩家已有的 `nr_before_sr.ini`；已安装的游戏保留原版本，需要玩家在游戏页选择新版本并确认。
- 管理器只安装中文 Core。英文 OTA 包能识别，但会提示玩家按包内说明手动安装。
- 只有 ID 或名称相同、字节不符的文件，不会被当作登记的 Core。
