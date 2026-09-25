# 米哈游输入路线说明

资料核对日期：2026-09-22。下表来自官方公告和项目仓库，不是本管理器的安装、硬件或游戏验收。实际路线仍取决于当前客户端、API、设置及配套身份，不能仅按游戏名决定。

| 游戏 | 已核实的官方信息 | 路线含义 |
| --- | --- | --- |
| 原神 | [2025-08-06 官方配置公告](https://www.hoyolab.com/article/40408846)列 DirectX 11；本次未查到官方原生 DLSS 支持公告。 | 保留匹配的 Feeder 路线，不把它显示为原生 DLSS 超分。 |
| 崩坏：星穹铁道 | [NVIDIA 2025-01-14 公告](https://www.nvidia.cn/geforce/news/dlss-assetto-corsa-evo-honkai-star-rail-smite-2/)确认 3.0 于 2025-01-15 加入 DLSS 超分；[4.0 官方公告](https://www.hoyolab.com/article/43725556)列 DX11 配置要求。 | 先检查原生 DLSS 输入；实际为 DX11 时配匹配的 Bridge，不能默认归入无 DLSS 的 Feeder 路线。配置要求不等于本次运行 API 证据。 |
| 绝区零 | [官方 FAQ，2026-06-17](https://www.hoyolab.com/article/45490247)说明启动器可选择 DX12、取消后回到 DX11；支持 DLSS 超分和符合硬件条件的帧生成。 | 读取实际 API 和原生 DLSS 条件；不能因曾经使用过 Feeder 就推断所有新安装也需要 Feeder。既有收据仍保留其路线。 |

## 原神第三方超分桥接

[Genshin FSR Bridge](https://github.com/AizawaHikaru233/genshin_fsr_brigde)确有将原神 FSR2 输入转接、再通过 OptiScaler 使用 DLSS 超分的方案。当前 README 声明支持原神 7.0，也明确标注非 HoYoverse 官方项目，以及 NVIDIA 上 OptiScaler 与 ReShade 同时启用可能不稳定。

这是新增第三方加载与超分替换链，需要独立处理加载顺序、更新和恢复。本批不集成它，继续使用已有匹配配套。它与 [Feeder](https://github.com/jlrouzies-fr/DLSS5-Feeder)从 ReShade 画面、深度及估算运动信息构造 NR 输入不同；后者不能冒充游戏原生 DLSS SR 或原生 FG。

## Core 自动兼容与 Feeder

当前内置 Unified5（源码 `38f5fff6fb6b20ce5fb09b0cca5020fcc4d9171d`）的 Present 兼容路径要求实际 D3D12 呈现及可信的当前画面来源。能取得原生导引时使用它们；获准的纯颜色路径使用占位深度和运动信息并每帧重置。它不是 DX11 的通用替代输入，也不等于通过 Feeder 取得深度及估算运动信息。

对应源码依据：`nr_compat_present_events.inl` 的 D3D12/来源准入、`nr_source_frame_runtime.inl::AcquireApplicationPresentColor`、`nr_compat_present_models.inl::LayerGuides`。FG 拥有最终呈现时仍有独立边界限制。这里没有同场景证据证明 Core 兼容模式或 Feeder 普遍更稳定；Manager 不自动用 Present 替换 Feeder。
