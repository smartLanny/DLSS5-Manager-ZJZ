# 公开仓库与发布审计

本仓库只公开源代码、文本清单、许可证和可复现的摘要信息。原始反馈、日志、抓取、转储、本机路径、测试存档、私有 DLL、密钥和签名材料不得进入公开提交或 Release。

## 提交前

在 `desktop` 目录运行：

```powershell
npm run audit:public
```

该检查覆盖相对 `origin/main` 新增或修改的文件以及未跟踪文件，拒绝常见私有证据目录、新增二进制/归档/密钥、具体本机路径、私钥文本和常见访问令牌。它同时运行 `git diff --check`。历史上已经跟踪但本次未修改的文件不在“新增文件类别”审计范围内。

还要人工检查：

```powershell
git status --short
git diff --stat origin/main
git diff --name-status origin/main
git diff origin/main -- . ":(exclude)package-lock.json"
```

重点确认：

- 没有 `bug-inbox`、反馈 ZIP、游戏日志、截图、转储或本机测试存档。
- 没有 `payload`、`resources` 下新加入的 DLL、EXE、Addon 或私钥；发布二进制只能由外部固定摘要清单在隔离 stage 中注入。
- 文档和测试没有真实用户名、下载目录、仓库外工作目录或账号数据。
- `update-manifest.json` 只含公开 Release 地址、大小和 SHA-256，不含构建机路径。
- `packaging-report.json`、`build-config.json`、stage、deliveries 和本地 `Full.zip` 不提交 Git。

## 构建与发布前

正式公开包只使用：

```powershell
npm run build:release -- --work-root D:\DLSS5-Build
```

该命令仅生成目录式 `Portable.zip`，并额外验证：

- 新装默认是 `0.4.7beta`，D21 不是稳定默认。
- 精确 `0.3.3.4` Core 大小为 652288 bytes，SHA-256 为 `2869d7d6b2d184b4200c3eb7ac671db0299be64e7625c4f816ee26b41890bfb9`。
- Bridge 与 Feeder 已进入公开组件目录。
- MFG 1.0 是默认、0.9 是回退，0.7 不进入安装矩阵。
- 基础便携包不含 RTX40/50 `nvngx_dlssnr.dll`。

发布前人工打开最终 ZIP，确认根目录存在便携标记、主程序、说明和组件清单；确认不存在反馈文件、本机路径和运行库 DLC。记录最终 ZIP、`update-manifest.json`、来源提交、stage 报告和 SHA-256。源码提交、本地门禁、GitHub CI、维护者实机与游戏内结果必须分别记录，不能互相替代。

## 本地 Full.zip

`Full.zip` 不是公开基础包。它只能嵌套以下四个独立 ZIP：便携管理器、RenoDX Add-on、RTX40 DLC、RTX50 DLC。微软 VC++ 运行库仍单独提供官方页面或独立包，不放进 `Full.zip`。

打包命令和四个输入文件摘要会写到 `Full.zip.json` 旁路报告；报告不含原始本机路径，也不提交公开仓库。
