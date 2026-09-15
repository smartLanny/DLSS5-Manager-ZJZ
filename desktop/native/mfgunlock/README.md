# MFG Unlock 0.9 中文面板构建

`mfgunlock-0.9-zh-CN` 基于 mavismmg 的 MIT 项目
[MFGAdaUnlock-RenoDx 0.9](https://github.com/mavismmg/MFGAdaUnlock-RenoDx/releases/tag/0.9)，
固定提交 `4a7b7bcd5f4e951c0cae9ffa7db7e5bdf5f8d40b`。原始版权、许可、README
和全部运行时代码保留在 `upstream`。

本地构建只调整相对 include 路径，并将上游 `OnRegisterOverlay` 隔离为
`panel_zh.inl` 进行中文本地化；没有携带 0.7 的运行时补丁，也没有更改补丁匹配、
帧节奏、Dynamic MFG、HDR 或细小物体算法。`verify-fg-mfgunlock-source.js` 会逐文件
核对上游摘要，重建预期源文件，并拒绝本地化面板以外的运行时代码差异。

中文面板保留 0.9 的全部配置项和诊断路径，重点解释：固定值是可以提高或降低的
绝对倍率；Dynamic MFG 只适用于 D3D12、595.41+ 驱动、DLSS-G 310.9.1 和
Streamline 2.14.1 的精确组合；`ForceFlipMeteringOff` 是 3×/4× 卡死时才使用的
兼容救援。字体仍由 ReShade 宿主管理，本插件不会修改或重建字体图集。

从 `desktop` 目录构建：

```powershell
node scripts/verify-fg-mfgunlock-source.js
./scripts/build-fg-mfgunlock.ps1 -OutputDirectory ./build/mfg-0.9-zh-new
```

构建需要 `source-lock.json` 中固定摘要的 ReShade、Streamline、DLSS 头文件，
Microsoft Detours 源码，以及 Visual Studio 2022 14.44 / Windows SDK 10.0.26100.0。
脚本使用 `/Brepro`，将二进制摘要和输入身份写入 `build-mfgunlock.json`。编译成功
不等于 GPU 实机验收通过；发布记录必须把中文/ABI/INI 检查与实际游戏生成帧验证分开。
本构建不分发 NVIDIA DLSS-G 或 Streamline 运行库。
