# 讨论简报：启动参数层 + API 强制层（对接 manager-0.5.0-beta.2）

> 状态：**提案 / 待讨论**，不是已批准的施工单。作者：外部代码审阅（2026-09-16）。
> 目的：把「DX12 强制启动」和「更多游戏客户端启动逻辑」拆成可判定的技术问题，供本仓库对接 Agent 决定方案。

---

## 0. 一句话结论

管理器已经具备三块地基，但**没有把它们串成一条链路**：

| 已有 | 位置 | 现状 |
| --- | --- | --- |
| 会**读**启动器的启动参数 | `launch-evidence.js:68-114` | 从 `localconfig.vdf` 读 `launchoptions`，作为 **API 证据**返回 `launchArguments` / `launchArgumentsApplied` |
| 会**改**游戏自己的图形设置 | `game-api-settings.js` + `rdr2-api-settings.js` | 单写者事务（备份 + SHA-256 + 回滚），**但只服务 RDR2 一款** |
| 能**直起**游戏 exe | `launch-session.js:84` | `broker.launch({ exe, args: target.args \|\| [] })` —— **`args` 字段存在，但全仓库没有任何地方填充它** |

缺的是：**per-game 启动档案（launcher / realExe / argv）+ 通用 API 控制适配器 + 与路线/桥接的联动决策**。

---

## 1. 现状盘点（带文件位置，便于核对）

### 1.1 启动链路

| 能力 | 位置 | 关键事实 |
| --- | --- | --- |
| 启动会话编排 | `launch-session.js` | `launchMode ∈ {steam, exe, hoyoplay, starward}`（第 39 行）；`exe` 分支读 `target.args`（第 84 行） |
| Steam 拉起 | `launch-session.js:80` | `steam.exe -applaunch <appid>`，**没有附加参数通道** |
| Steam 启动选项 | `launch-evidence.js:107-113` | 三态来源：`steam-active-account` / `steam-unbound-profiles`；`launchArgumentsApplied` 需 active 账户 + 单 profile + 语法合法 |
| 启动参数 → API 识别 | `api-evidence.js:180-193` | 正则 `^--?(?:force-)?((?:d3d\|dx)1[12]\|vulkan\|opengl\|glcore)$` —— **已经认识 `-dx12/-d3d11/--force-d3d12` 这一族写法** |
| 启动模式持久化 | `state-store.js:69-74` | 只存 `{launchMode, launchExecutable}`；`operation-plan.js:47` 白名单 `auto/steam/exe` |
| 米哈游路线 | `hoyo-launcher.js` | 只启动**启动器**（第 58 行），注释明写"never substitutes the game EXE"；HoYoPlay 需用户**手动点启动**（第 42 行 `launchInstruction`） |
| 启动器位置发现 | `launcher-locations.js` | 只有 Steam root / GOG / Epic manifest；**没有国产启动器**（米哈游 / 库洛 / 完美 / 网易 / WeGame / GRYPHLINE） |

### 1.2 API 与路线

| 能力 | 位置 | 关键事实 |
| --- | --- | --- |
| API 解析 | `shared/api-resolution.js` | 返回 `{api(偏好), effectiveApi, detectedApi, supported, requiresManualSelection}` |
| 每游戏静态表 | `api-evidence.js:21-30` | `STEAM_ENTRY_APIS` 只有 **2 个 appid**（BG3 1086940、RE9 3764200）；`STEAM_STATIC_EXCEPTIONS` 1 个；`STEAM_CONFIG_ENTRIES` 1 个 |
| 图形设置同步 | `game-api-settings.js:79-93` | `identity()` 第 84 行 **硬判 `steamAppId !== '1174180' → null`**，其余游戏一律 no-op |
| 代理入口 dxgi ↔ d3d12 | `installer.js:895-930`、`external-runtime.js:730`、`app-service.js:584` | 只切换 **ReShade 载体文件名**；约束 `entry === 'd3d12' && api !== 'dx12' → PROXY_ENTRY 拒绝` |
| RDR2 双 API 支持 | `rdr2-api-settings.js:110` | `supportedApis: ['dx12','vulkan']`、`canSync`、`sha256` |

### 1.3 现有产品承诺（**这是必须先解决的前提**）

- `desktop/test/game-api-ui.test.js:66` → 断言 UI 含「**不会替你修改游戏启动参数**」
- `desktop/docs/INSTALL-GUIDE-0.2.0-BETA.md:94` → 「不会修改、删除……**Steam、Epic 等启动器记录**」
- `desktop/docs/INSTALL-GUIDE-0.2.0-BETA.md:87` → 「加载 D3D12 入口」只移动**管理器自己的** ReShade 入口

**DX12 强制启动必然触碰其中一条**（Steam 走 LaunchOptions；直起 exe 走 argv）。方案定不下来之前不要动代码。

---

## 2. 必须先定调的三个问题

### Q1 「不改启动参数」这条承诺怎么翻？

建议：新增**显式授权的「启动参数由管理器接管」模式**（默认关闭，per-game 绑定）。同时做三件事，缺一不可：

1. 文案改写 + `game-api-ui.test.js:66` 断言同步更新（不要留旧文案骗人）
2. 只写/只删**自己写入的那一项**，不整段覆盖启动器记录
3. 走与 `game-api-settings` 同一个事务（备份 + 摘要 + 回滚），卸载时一并撤回

### Q2 「游戏能跑哪些 API」和「我要用哪个 API」必须拆开

现在一个 `api` 值同时承担三种语义（检测 / 覆盖 / 部署）。加强制后至少要四态：

```
observedApi    运行期证据（swapchain / Player.log）—— 游戏现在真的在跑什么
configuredApi  游戏自己保存的设置（RDR2 system.xml、启动器 setting.ini）—— 不启动也能读
preferredApi   用户选择（现有 apiOverride）
effectiveApi   写入并下次启动后生效的目标 —— 桥接/路线应该按这个来选
```

`api-resolution.js` 已有 `effectiveApi`/`detectedApi`，缺 `configuredApi` 和 **「本游戏能否被强制、用哪种通道」的能力字段**。

### Q3 「强制能力」≠「强制成功」

实测（本机，2026-09-16）：**国产启动器普遍吞掉命令行参数**——米哈游 HYP、鸣潮 `launcher_main.exe`、异环 `NTELauncher.exe`、网易 `yysls` 启动器全部如此。所以"强制 DX12"必须按通道区分可信度，见 §3。

---

## 3. 建议机制：三种 DX 切换通道 + 统一契约

### 3.1 通道（按可信度降序）

| 通道 | 做法 | 可信度 | 代价 |
| --- | --- | --- | --- |
| **A. argv 直起** | 绕过启动器，直起真实渲染 exe + 参数 | 最高（参数必定送达） | 需要 launcher → realExe 映射；会跳过启动器的完整性/更新检查 |
| **B. 配置/状态文件** | 改游戏自己存的设置（RDR2 `system.xml` 已有先例）或启动器配置文件 / tag 文件 | 中（需先关游戏 + 可能被启动器覆盖） | 需要逐游戏适配器 |
| **C. 启动器记录** | Steam `localconfig.vdf` 的 `LaunchOptions` | 低（账户/profile 多份、会被 Steam 覆盖） | 触碰 §1.3 的承诺 |

**建议优先验证通道 A 的一个变体**：`steam.exe -applaunch <appid> <附加参数>` 是否真的把参数转发给游戏。若可行，Steam 侧就**不必写 `localconfig.vdf`**，直接绕开 §1.3 的第二条承诺，成本最低。（待实测确认，不要先写代码。）

### 3.2 契约草案：把 `apiSettings` 泛化成适配器族

现在 `chosen.apiSettings.kind` 只有一个值 `'rdr2-system-xml'`。建议扩成 kind → adapter 查表，并补上"写"的能力：

```js
{
  kind: 'rdr2-system-xml' | 'launcher-ini' | 'launcher-tag' | 'steam-launch-options' | 'argv-direct' | 'dual-exe',
  channel: 'A' | 'B' | 'C',
  api: 'dx12',                     // 当前值（读）
  supportedApis: ['dx12', 'vulkan'],
  canSync: true,                   // 现有：能否读
  canForce: true,                  // 新增：能否写
  requiresGameClosed: true,
  bypassLauncher: true,            // 写入后必须绕过启动器才生效
  reversible: true,
  evidence: [ /* 复用现有 signals 结构 */ ]
}
```

配套一份**能力矩阵**（等价于外部 DLSS5 安装器的 `$KnownGameTable`），每游戏一行：

```
{ exe, launcher, realExe, api, dxSwitch, channel, route, bypassLauncher, note }
```

### 3.3 launcher-shell 反推真实 exe

`INSTALL-GUIDE-0.2.0-BETA.md:16-27` 已经把这套启发式写清楚了（回溯 `WindowsNoEditor/HT/Binaries/Win64`、排除 `CefView`/`QtWebEngine`/`Launcher`、小 exe 也可能是本体）。建议把它从"扫描选候选"**提升为一条独立可复用的解析**，并加一条硬规则：

> **同名命中才自动切换注入目标；不同名只提示待确认。**

理由：外部同名工具（`dlss5-installer.ps1`）在这里踩过坑——拖启动器时它建议的"真游戏"是 `D:\Delta Force\...\DeltaForceClient-Win64-Shipping.exe`（**别的游戏**），而询问默认值是 y，用户回车就装错目录。

---

## 4. 与路线 / 桥接的联动（最需要先讲清的一条）

**桥接选择应该由「强制后的目标 API」决定，而不是由「扫描到的当前 API」决定。**

否则会出现：用户选 DX12 → 管理器按 `observedApi === 'dx11'` 装 NIGos DX11 桥接 → 但强制生效后游戏跑 DX12 → 桥接装错。

建议矩阵：

| 目标 API | 原生 DLSS | 路线 | 载体 | 桥接器 |
| --- | --- | --- | --- | --- |
| dx12 | 是 | Native 直钩 | `dxgi.dll` / `d3d12.dll` | 不装 |
| dx11 | 是 | Native（Bridge 镜像） | `d3d11.dll` / `dxgi.dll` | NIGos DX11 |
| vulkan | 是 | Vulkan 试验 | Vulkan layer | Vulkan 桥接 |
| 任意 | 否 | Feeder | `dxgi.dll` / `d3d12.dll` | —— |
| 无 DX12 可选 | 是 | 只能 Bridge / Feeder | —— | —— |

`operation-plan.js` 的请求对象建议把 `api` 拆成 `targetApi` + `observedApi`；UI 上直接说清：

> 「这条路线要求游戏运行时是 DX12；当前观察到的渲染 API 是 DX11 → 需要先强制切换到 DX12（点击后写入，请先关游戏）」

### 用词纠正（现在文档里两处混用）

- 「**加载入口**」= ReShade 载体是 `dxgi.dll` 还是 `d3d12.dll`（`INSTALL-GUIDE:87` 的用法）
- 「**游戏渲染 API**」= 游戏实际跑 DX11/DX12/Vulkan（`external-runtime.js:730` 的用法）

这两个概念在 UI 上必须用不同措辞，否则用户会把"换个 dll 名"当成"把游戏切成 DX12"。

---

## 5. 建议补的模块

| # | 模块 | 做什么 |
| --- | --- | --- |
| 1 | `game-launch-profile.js`（新） | per-game 启动档案 `{launcher, realExe, argv, cwd, env, bypassLauncher}`，接进 `launch-session.js:84` 替换裸 `target.args` |
| 2 | `launcher-registry.js`（扩 `launcher-locations.js`） | 国产启动器识别：米哈游 / 库洛 / 完美 NTELauncher / 网易 yysls / WeGame / GRYPHLINE；每个给「进程名 + 配置文件 + InstallPath 键 + 是否吞参数」 |
| 3 | `game-launch-shell.js`（新） | 启动器壳 → 真实渲染 exe 反推（§3.3） |
| 4 | `game-api-adapter/*`（新，替 `rdr2-api-settings.js` 单例） | 把 `game-api-settings.js:84` 的硬编码 `1174180` 换成 kind 查表；先落两个：`rdr2-system-xml`（已有）、`steam-launch-options`（新） |
| 5 | `api-capability-matrix.json`（新） | 每游戏 `{exe, launcher, realExe, api, dxSwitch, channel, route, note}` |
| 6 | 测试 | `game-api-ui.test.js:66` 断言改写；补 argv 注入的 launch-session 单测；补"绕过启动器"路径 |

---

## 6. 建议的第一个端到端切片（MVP）

**选《鸣潮》**，理由：

- UE4 + 原生 DLSS，DX12 是正路（`-dx12` 语义无歧义）
- 启动器与本体分离，路径已实测：启动器 `Wuthering Waves\launcher.exe`（真身 `2.6.5.0\launcher_main.exe`），真游戏 `Wuthering Waves Game\Client\Binaries\Win64\Client-Win64-Shipping.exe`
- 无 ACE 级别的注入封锁，比异环好验证
- 启动器吞参数已确认 → 正好验证通道 A

之后按难度递进：**异环**（ACE 反作弊 + Streamline 深链）→ **燕云十六声**（启动器与本体跨盘，DX 开关在启动器 `setting.ini` / `LocalData\*.tag`）→ **终末地**（**没有 DX12 档**，只有 Vulkan 优先 / DX11 优先，永远只能走 Bridge / Feeder）。

---

## 7. 待对接 Agent 明确的开放问题

1. **Steam `-applaunch` 能否附带参数？** 若能，Steam 侧就免写 `localconfig.vdf`，绕开现有承诺。→ 建议优先实验验证，成本最低的突破口。
2. **卸载/取消安装时，自己写进去的 `-dx12` 要不要撤回？** 建议：是，且必须与 `game-api-settings` 共用同一个 journal 事务。
3. **米哈游路线怎么强制 DX12？** HoYoPlay 必须用户手动点启动，没有 argv 通道（`hoyo-launcher.js:42`），只能找 HoYoPlay 自身的 per-game 图形 API 设置。是否愿意为此增加一个"启动器设置同步"适配器？
4. **反作弊场景下"绕过启动器直起 exe"要不要单独风险提示？** ACE（异环、三角洲、终末地）对绕过官方入口较敏感。
5. **`apiSettings.canSync === false` 时的语义要不要统一？** 现在 RDR2 走 no-op 并保留手动偏好（`game-api-settings.js:189`），若推广到多适配器，需要明确"部分可读 / 部分可写"的中间态。

---

## 附录 A：本机实测的游戏启动档案（可直接作为能力矩阵的初始数据）

采集环境：Windows 11（DESKTOP-42LPKH6），2026-09-16。完整版见同批次产出的 `game-launcher-registry.json`。

| 游戏 | 启动器 | 真实渲染 exe | DX 切换 | 通道 |
| --- | --- | --- | --- | --- |
| 绝区零 | `E:\11.kehuduanyouxi\米哈游\launcher.exe`（HYP 1.18.0.380） | `...\米哈游\games\ZenlessZoneZero Game\ZenlessZoneZero.exe` | `-force-d3d12`（备选 `-use-d3d12`） | A |
| 鸣潮 | `E:\...\Wuthering Waves\launcher.exe`（真身 `2.6.5.0\launcher_main.exe`） | `...\Wuthering Waves Game\Client\Binaries\Win64\Client-Win64-Shipping.exe`（930.9 MB） | `-dx12` / `-d3d12`；⚠ 与 `-dx11` 互斥会 UE Fatal error | A |
| 异环 | `E:\Neverness To Everness\NTELauncher.exe` | `...\Client\WindowsNoEditor\HT\Binaries\Win64\HTGame.exe`（254 MB）★ 不是 `NTELauncher\NTEGame.exe` | UE5 默认 DX12 | —— |
| 燕云十六声 | `D:\yysls\Win32\deploy\launcher.exe`（**D 盘**） | `E:\YY16S\yysls_medium\Engine\Binaries\Win64r\yysls.exe`（**E 盘**，跨盘） | `--commandline-dx12-control=1`；或 `setting.ini` 的 `DX12=true`；状态 tag `LocalData\launcher_dx12_control.tag`=1 / `last_graphics_api.tag`=dx12 | A 或 B |
| 终末地 | `C:\Program Files\GRYPHLINK\Launcher.exe`（本机未安装） | `Endfield.exe`（823 KB 瘦引导器） | **无 DX12 档**：Vulkan 优先 / DX11 优先；兜底 `-force-d3d11` | B（启动器设置） |

补充同类样本（供启发式回归）：天涯明月刀 `WuXia_Client_x64.exe` ↔ `XVersion\WuXia_Client_dx12.exe`（**双 exe 切 DX，非参数**）；巫师3 `bin\x64_dx12\witcher3.exe` ↔ `bin\x64\witcher3.exe`；三角洲同一游戏有两个 Shipping exe（主模式 / BlackHawkDown）；刺客信条启动器在游戏目录**之外**（Ubisoft Connect）。

## 附录 B：外部参考

同机的第三方工具 `D:\DLSS5参考\dlss5自动化安装包v2.4.1 bugfix\dlss5-installer.ps1` 有一份等价的 `$KnownGameTable`（字段 `Exe / ApiKey / Route / Note`，含绝区零 `NotSupported`、终末地 `ModeSwitch`），以及 `Get-LauncherShellCheck`（启动器壳识别）。**可交叉核对，但不要直接复制其结论**——它是 PowerShell 单文件工具，判定阈值（如 exe > 50 MB、Depth 6）是为它自己的场景调的。

