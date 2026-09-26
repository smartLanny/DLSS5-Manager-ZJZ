# 更换 Core

Core 的身份只登记在 `desktop/src/shared/core-catalog.js` 一处。版本菜单、新安装默认值、OTA 识别、HoYo 可选版本、外部 Provider 路线、人脸配套和发布检查都从这里读取。

## 步骤

1. **登记**：在 `CORES` 末尾加一条，填写 ID、菜单名称、`buildVersion`、源码提交、中英文 Core 的 SHA-256、配套 nrchain、两个 OTA ZIP 的 SHA-256。要设为新安装默认，把 `RECOMMENDED` 改成新 ID。
2. **导入**：用中文 OTA ZIP 生成新的 staging：

   ```powershell
   node desktop/scripts/import-core-ota.cjs --ota <中文 OTA.zip> --staging <当前 staging.json> --output <新的空目录> [--ini <默认 nr_before_sr.ini>]
   ```

   脚本会重新计算 ZIP 和包内每个文件的 SHA-256，和清单或 `SHA256.json` 不一致就停止，不写任何文件。旧版本原样复制，大型 NR 模型（`nvngx_dlssnr.dll`）仍由 `runtime.families` 单独提供。OTA 包不含 INI 时，沿用上一个统一 Core 的默认 INI，或用 `--ini` 指定。
3. **核对**：`DLSS5_TEST_CORE_OTA=<中文 OTA.zip> node --test desktop/test/core-catalog.test.js` 会用实际文件核对清单；没有设置时这项测试会跳过，不能当作已核对。
4. **打包**：用输出目录里的 `staging.json` 运行 `npm --prefix desktop run verify:staging` 和打包命令。发布检查要求默认版本正是清单推荐版，并逐字节核对它的 Core 文件。

## 不会发生的事

- 不会覆盖玩家已有的 `nr_before_sr.ini`；已安装的游戏保留原版本，需要玩家在游戏页选择新版本并确认。
- 管理器只安装中文 Core。英文 OTA 包能识别，但会提示玩家按包内说明手动安装。
- 只有 ID 或名称相同、字节不符的文件，不会被当作登记的 Core。
