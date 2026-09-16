# 施工简报：DX12 强制启动 × 载体(DXGI→D3D12) × 路线桥接 三合一

> 用途：给对接 Agent 直接照着改。**长版背景见 `LAUNCH-ARGS-AND-API-FORCING-DISCUSSION.md`**，本文只讲「改哪里、怎么改、怎么验」。
> 作者：外部审阅 2026-09-16。状态：提案。

---

## 1. 目标（一句话）

把现在**三个各自独立、互不知情**的动作，合并成**一次原子操作**：

```
目标 API 选定  →  载体(DXGI / D3D12)  →  路线 + 桥接
     ↑_______________ 必须是同一个事务 _______________↑
```

典型触发场景（用户点一次「强制 DX12」）：

- 异环：DE 不需要 argv（UE5 默认 DX12），**但必须同时把载体从 `dxgi.dll` 改成 `d3d12.dll`**（ACE 按注入 dll 文件名拉黑 `dxgi.dll`），并给出 ACE 风险确认。
- 鸣潮：写 `-dx12` argv + 绕过启动器 +（若扫描非 DX12 则）不选 d3d12 载体。
- 燕云：改启动器 `setting.ini`/tag 或 argv，同时决定载体。

---

## 2. 现状：三条轨道已存在，三个断点没接上

| 轨道 | 位置 | 状态 |
| --- | --- | --- |
| ① 启动参数 | `launch-session.js:84` 读 `target.args` | ✅ 字段在，❌ **全仓库无一处填充**（`args: []` 硬编码在 `app-service:2198`、`feeder-service:339`、`legacy-service:772`、`hoyo-launcher:48`） |
| ② 参数→API 识别 | `api-evidence.js:180` `argumentApis()` | ✅ 已能解析 `-dx12/-d3d11/--force-d3d12/-renderer dx11`；❌ 只用于"读"，不用于"写" |
| ③ 载体切换 | `installer.js:885` `toggleD3D12()` | ✅ 有独立事务（sidecar 备份 + journal + sha256 校验）；❌ 与 ① / API 选择完全解耦 |
| ④ 游戏设置同步 | `game-api-settings.js:84` | ❌ **硬编码 `steamAppId !== '1174180' → null`**，只服务 RDR2 |
| ⑤ Steam 启动选项 | `launch-evidence.js:107` | ✅ 只读 `localconfig.vdf` 的 `LaunchOptions` 当证据；❌ 从不写 |

### 三个必须修掉的断点

**断点 A — `toggleD3D12` 要求「扫描判定已是 DX12」**

`installer.js:890`：

```js
if (enabled === true && classifyApi(scan.chosen) !== 'dx12') throw appError('ERR_UNSUPPORTED_API');
```

逻辑上没错，但**在"强制 DX12"的流程里会自锁**：游戏当前跑 DX11 → 不允许切 d3d12 载体 → 但用户正是要把它切成 DX12。必须改成按 **`targetApi`** 判定，而不是按扫描到的 `observedApi`。

**断点 B — 反作弊门形同虚设，且对需要它的游戏完全无效**

`installer.js:900` 的确认门依赖 `guards.antiCheatPresent()`，而它的实现是（`desktop/vendor/DLSS5-Swapper/src/core/install-guards.js:53`）：

```js
if (/easyanticheat|battleye|(?:^|[-_])(?:eac|be)launcher|eaanticheat/i.test(entry.name)) return true;
```

只认 **EAC / BattlEye / EAAC**。本机实测（2026-09-16）需要它的三款一个都不命中：

| 游戏 | 反作弊实体 | 相对游戏根目录的深度 | 现有实现能否命中 |
| --- | --- | --- | --- |
| 异环 | `Client\WindowsNoEditor\HT\Binaries\Win64\AntiCheatExpert\`（`ACE-BASE.sys` / `ACE-Base64.dll` / `ACE-Service64.exe` / `ACE-Tray.exe`）+ 启动器侧 `NTELauncher\driver\PGameProtectDriver_X64.sys` | **6 层** | ❌ 名字不匹配 **且** 超出深度 |
| 鸣潮 | `Wuthering Waves Game\Client\Binaries\Win64\AntiCheatExpert\`（`ACE-CORE.sys` / `ACE-IDS64.dll`） | **4 层** | ❌ 同上 |
| 绝区零 / 原神 | `HoYoKProtect.sys` + `mhypbase.dll`（就在 EXE 同级） | 1 层 | ❌ 名字不匹配 |

而且 `antiCheatPresent()` 的 BFS 是 `depth < 2`、上限 2000 条 —— **即使补上名字也扫不到异环/鸣潮**。

**断点 C — 产品承诺挡住写入**

- `desktop/test/game-api-ui.test.js:66` 断言 UI 必须含「不会替你修改游戏启动参数」
- `desktop/docs/INSTALL-GUIDE-0.2.0-BETA.md:94` 承诺「不修改 Steam、Epic 等启动器记录」

**这两条必须先定调再动代码**，否则会出现"代码违反自己的测试断言"。

---

## 3. 改法

### 3.1 新增统一入口（替换现在的三处分散调用）

```js
// 一次事务做三件事，任一步失败全部回滚
applyApiDeployment(gameId, {
  targetApi: 'dx12',        // 目标（不是观察值）
  // 以下由决策表推导，UI 可覆写但必须解释后果：
  carrier: 'd3d12' | 'dxgi' | 'd3d11' | 'vulkan-layer',
  route: 'native' | 'native-bridge' | 'feeder',
  bridge: '…' | null,
  argv: ['-dx12'],          // 通道 A
  bypassLauncher: true,
  gameSettings: { kind, patch },   // 通道 B（可选）
})
```

### 3.2 决策表（载体/路线/桥接 由 targetApi + 反作弊画像 推导）

| targetApi | 原生 DLSS | 反作弊画像 | carrier | route | 桥接 | argv |
| --- | --- | --- | --- | --- | --- | --- |
| dx12 | 是 | ACE（异环/鸣潮） | **`d3d12.dll`（强制）** | native | 不装 | 按游戏（异环无需） |
| dx12 | 是 | 无 / HoYoKProtect | `dxgi.dll`（或按用户选） | native | 不装 | 按游戏 |
| dx12 | 否 | 任意 | `dxgi.dll` / `d3d12.dll` | feeder | —— | 按游戏 |
| dx11 | 是 | 含 d3d11 黑名单（终末地） | 无可用 | —— | 拒绝并说明 | —— |
| dx11 | 是 | 其他 | `d3d11.dll` / `dxgi.dll` | native-bridge | NIGos DX11 | `-force-d3d11` |
| vulkan | 是 | 任意 | vulkan layer | bridge | Vulkan 桥接 | —— |

**核心改动点**：`external-runtime.js:730` 与 `app-service.js:584` 里 `api !== 'dx12'` 的判定，全部换成 `targetApi !== 'dx12'`。

### 3.3 `apiSettings` 从单游戏泛化为 kind→adapter 查表

现在只有 `kind: 'rdr2-system-xml'` 一种，且 `game-api-settings.js:84` 硬判 appid。改成注册表：

```js
{
  kind: 'rdr2-system-xml' | 'launcher-ini' | 'launcher-tag' | 'steam-launch-options' | 'argv-direct' | 'dual-exe',
  channel: 'A' | 'B' | 'C',
  api, supportedApis,
  canSync: true,        // 现有：能读
  canForce: false,      // 新增：能写
  requiresGameClosed: true,
  bypassLauncher: false,
  riskProfile: { antiCheat: 'ace' | 'hovok' | 'pgameprotect' | null, dllNameBlacklist: ['dxgi.dll'] }
}
```

### 3.4 反作弊识别补全（`install-guards.js:43`）

```js
// 名字：补 ACE / HoYoKProtect / PGameProtect
/easyanticheat|battleye|eaanticheat|anticheatexpert|(?:^|[-_])ace(?:-|$)|hovokprotect|pgameprotect/i
// 深度：depth < 2 → 至少 8（异环实测 6 层）
// 上限：2000 → 8000（仅计数条目，不读文件内容）
```

补完后 `installer.js:900` 的确认门对异环/鸣潮才会真正生效。

---

## 4. 异环专项（必须和载体改名一起做）

| 项 | 值 |
| --- | --- |
| 启动器 | `E:\Neverness To Everness\NTELauncher.exe`（根层壳）→ `NTELauncher\NTELauncher.exe` |
| **真实渲染 exe** | `E:\Neverness To Everness\Client\WindowsNoEditor\HT\Binaries\Win64\HTGame.exe`（254 MB）★ **不是** `NTELauncher\NTEGame.exe`（34.6 MB，那是启动器侧拉起器） |
| 目标 API | UE5 默认 DX12，**不需要 argv** |
| 载体 | **必须 `d3d12.dll`** —— ACE 按注入 dll 文件名检测，`dxgi.dll` 在黑名单内 |
| carrier 判定依据 | `installer.js:890` 的 `classifyApi(scan.chosen) === 'dx12'` 对异环成立（UE5 DX12），所以这条不阻塞；阻塞在"要不要一起改" |
| 风险 | ACE（`ACE-BASE.sys` 内核驱动）+ 完美世界 `PGameProtectDriver_X64.sys` |
| 落点 | `Client\WindowsNoEditor\HT\Binaries\Win64\`（= HTGame.exe 同级，ACE 目录的父目录） |

**要求**：`toggleD3D12` 与 API 选择、路线部署必须进**同一个 `journal.transaction`**，否则会出现"API 已改、载体没换 → ACE 把 dxgi.dll 干掉"或"载体换了、路线还是 Feeder"的中间态。

---

## 5. 施工顺序（建议按 PR 切）

| PR | 内容 | 可独立验收 |
| --- | --- | --- |
| 1 | 反作弊识别补全（§3.4）+ 单测：异环/鸣潮/绝区零目录必须命中，EAC 老样本不回归 | ✅ 纯读，无写操作 |
| 2 | `targetApi` vs `observedApi` 拆分；`external-runtime.js:730` / `app-service.js:584` 改判定源 | ✅ 不改变现有行为 |
| 3 | `apiSettings` 泛化为 kind 查表（RDR2 保持等价行为，先把测试锁住） | ✅ RDR2 回归 |
| 4 | `applyApiDeployment` 统一事务（argv + carrier + route），先只接通道 A | 需鸣潮实机 |
| 5 | 通道 B（启动器 ini/tag）+ 通道 C（Steam LaunchOptions） | 需先定调 §2 断点 C |
| 6 | UI 文案与 `game-api-ui.test.js:66` 断言同步改写 | 需先定调 |

---

## 6. 验收用例

| 游戏 | 期望 | 关键断言 |
| --- | --- | --- |
| **鸣潮** | 直起 `Client-Win64-Shipping.exe -dx12`，载体 `dxgi.dll`，路线 native | 启动后进程路径 = 真实 exe（不是 launcher.exe）；ACE 确认弹窗出现 |
| **异环** | 不传 argv；载体 `d3d12.dll`；路线 native | 部署目录为 `HTGame.exe` 同级；`dxgi.dll` 不存在；ACE 确认弹窗出现 |
| **绝区零** | 走 HoYoPlay 路线（`hoyo-launcher.js:58` 不替换游戏 exe） | 不产生 argv；载体与 hoyoshade helper 一致 |
| **终末地** | **拒绝** d3d12 载体路线（无 DX12） | 报错说明"只有 Vulkan / DX11，需走 Bridge/Feeder" |
| 回归 | RDR2 system.xml 事务行为不变 | 备份/摘要/回滚三项原测试全过 |

---

## 7. 待确认（改之前必须先有结论）

1. **`steam.exe -applaunch <appid> <args>` 是否转发附加参数？** 若能，Steam 侧免写 `localconfig.vdf`，直接绕开 §2 断点 C 的一半承诺。→ **建议第一个做实验**。
2. **§2 断点 C 的承诺怎么翻？** 建议新增"启动参数由管理器接管"的**显式授权模式**（默认关，per-game），只写/只删自己那一项。
3. **`bypassLauncher` 要不要纳入风险提示？** ACE/完美世界驱动的游戏，绕过官方入口直起 exe 可能被判异常。

---

## 附录：本机实测路径（可直接当作能力矩阵初始数据）

| 游戏 | 启动器 | 真实渲染 exe | API 切换 |
| --- | --- | --- | --- |
| 绝区零 | `E:\11.kehuduanyouxi\米哈游\launcher.exe` | `...\米哈游\games\ZenlessZoneZero Game\ZenlessZoneZero.exe` | `-force-d3d12` |
| 鸣潮 | `E:\...\Wuthering Waves\launcher.exe`（真身 `2.6.5.0\launcher_main.exe`） | `...\Wuthering Waves Game\Client\Binaries\Win64\Client-Win64-Shipping.exe` | `-dx12`（⚠ 与 `-dx11` 互斥会 UE Fatal error） |
| 异环 | `E:\Neverness To Everness\NTELauncher.exe` | `...\Client\WindowsNoEditor\HT\Binaries\Win64\HTGame.exe` | UE5 默认 DX12（**只需换载体**） |
| 燕云十六声 | `D:\yysls\Win32\deploy\launcher.exe`（D 盘） | `E:\YY16S\yysls_medium\Engine\Binaries\Win64r\yysls.exe`（E 盘，跨盘） | `--commandline-dx12-control=1`；或 `setting.ini` 的 `DX12=true`；tag：`LocalData\launcher_dx12_control.tag` |
| 终末地 | `C:\Program Files\GRYPHLINK\Launcher.exe` | `Endfield.exe`（823 KB 瘦引导器） | **无 DX12 档**：Vulkan 优先 / DX11 优先 |
| 天涯明月刀 | `QSGameLauncher.exe` | `WuXia_Client_x64.exe` ↔ `XVersion\WuXia_Client_dx12.exe` | **双 exe 切 DX，非参数** |

