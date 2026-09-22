# 给另一个任务：米哈游 Feeder 配套

状态（2026-09-22）：用户确认没有新的 HoYo Feeder 成品。Beta8 绝区零反馈中的两次 `LEGACY_PACKAGE_UNTRUSTED` 对应缺失的固定旧配套；NR DLC 就绪不能补齐它。Beta9 打包尝试因 `legacyRuntime.root 缺失。` 被拒绝，未交付新 EXE，真实绝区零安装与完整包验收仍未完成。当前管理器修复没有修改或修复 Core / Bridge / Feeder。

1. 以现有累计 0.5 Core / Feeder 为基础，验证 **HoYoShade 加载的 ReShade** 能正确找到 Provider、配置和资源；不要只验证游戏目录里的 dxgi 代理。
2. 返回具有独立 ID / 版本的完整组件包，沿用 `dlss5-component-v1` 和 `dlss5-external-provider-package-v1` 合同，真实声明 `loadingBackend=hoyoshade`、已验证的架构、DX11 / DX12、显卡范围和实际需要的 Core 能力。文件放在绑定客户端的 addon/runtime 目录；ReShade 由 HoYo 配置管理，不能要求覆盖游戏 dxgi.dll。
3. 验证应用、更新保留 INI、API 切换、取消零写入、失败回退、卸载恢复和应用后不自动启动；分别记录受控软件测试与真实游戏测试。管理器现有模拟 IPC / 合成游戏测试不能代替这些实际配套验收。
4. 返回配套目录、源码身份、配置模板、逐文件大小/SHA-256 和许可。管理器任务负责接入与打包，不修改 Core / Bridge / Feeder。

现有 D16-r3 仅声明本地代理路线，不能改个标签就当米哈游配套；Unified5 满足其 Core 能力要求也不会产生未声明的 HoYo 路线。标准 0.4.7beta 的 V1 导出不能冒充新版 Core 的附加能力。保留管理器完整性和路线检查。

也可找回旧池清单 `desktop/resources/legacy-runtime/manifest.json` 中原本固定的四项：`provider-x64`、`provider-x86`、`provider-relay-x64`、`host-x64`。必须逐项符合原摘要；官方未打补丁的同版本包不等同于这些文件。
