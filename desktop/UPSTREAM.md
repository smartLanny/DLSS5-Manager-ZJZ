# Upstream relationship

This project is a focused downstream edition of
[`rakanki911/DLSS5-Swapper`](https://github.com/rakanki911/DLSS5-Swapper),
which is maintained by Rakan Alkhaldi and released under the MIT License.

Baseline used for this foundation:

- upstream repository: `rakanki911/DLSS5-Swapper`
- upstream commit: `ccb67f4bc92cb5da1d25416dd6b338e12fa432c5`
- baseline date: 2026-09-05

The downstream intentionally keeps only the reusable local-library discovery,
PE inspection, game scanning, process guard and file-journal foundations. Its
product UI, payload contract, NR settings layer, install/repair workflow and
Chinese beginner-facing copy are maintained separately.

See `docs/UPSTREAM_SYNC.md` before importing a later upstream revision.

`src/core/file-journal.js` is a downstream copy of the pinned MIT journal, with
one product recovery extension: `preservePending` keeps an interrupted journal
when automatically rolling back could erase a newly appeared external file.
REFramework recovery validates that ownership before using the shared journal.
The upstream submodule remains at the original revision and is not patched.

## Manager 0.4.8-beta.3 component boundaries

Manager `0.4.8-beta.3` / Windows build `0.4.8.3` keeps the existing foundation
above and independently pins the following runtime components. A manager version
does not change the Core, bridge, provider or GPU-specific runtime identity.

| Component | Pinned source/version | Downstream boundary |
| --- | --- | --- |
| NR Core | `0.4.7beta`; ExternalProvider source revision `4ecc6d02ca6058cb1ebb0faae5aa49b34b0614ad` | Native and `NRExternalProviderV1` variants have different fixed hashes and cannot be interchanged. |
| Feeder | [0.15.1 / `3f624855`](https://github.com/jlrouzies-fr/DLSS5-Feeder/tree/3f624855276c4bde55145c712782477639b30e85), MIT | Provider/host adapters use the project's sole NR Core, full-size same-frame transport and a project completion extension to IPC v9. |
| ReShade | [6.8.0 full Add-on runtime](https://reshade.me/), BSD 3-Clause | Official x86/x64 bytes are pinned independently; the manager chooses the actual loader architecture. |
| VORT | [`b410b9f0`](https://github.com/vortigern11/vort_Shaders/tree/b410b9f0c0fbb83c8cb42164aaf1655fab386f4a), MIT plus per-file CC BY-NC 4.0 | The required pixel-pass closure and original notices are retained; estimates remain Synthetic rather than native game motion vectors. |
| HoYoShade | [V3.0.0-Beta.9 / `23761f93`](https://github.com/DuolaD/HoYoShade/tree/23761f935444a78388c028fbfda921965177c453), BSD 3-Clause | Configuration reference only; manager-owned profile/helper, verified launcher binding and official ReShade. Upstream injector/INI builder are not run or redistributed. |
| MFG Unlock | [0.7 / `ffe6169b`](https://github.com/mavismmg/MFGAdaUnlock-RenoDx/releases/tag/0.7), MIT; [0.6.1](https://github.com/mavismmg/MFGAdaUnlock-RenoDx/releases/tag/0.6.1) fallback | Source-built simplified Chinese 0.7 is the default; official 0.7 and 0.6.1 remain independently pinned alternatives. Only one provider is active. |
| NIGos DX11 companion | NR-adapted 1.4.12 default / 1.4.11 fallback | Project-specific hashes and Core pairing in `src/product/component-registry.js`; a same-number upstream DLL is not a drop-in replacement. |

The DX9 shim and relay are project-owned source. They use the Windows system
D3D9On12 implementation and an x64 NR host for either game architecture. The
release excludes dgVoodoo 2.87.4 after the recorded Defender result and review of
its distribution terms. No private copy of Microsoft's system runtime is bundled.

The DX9 relay retains bounded current-frame depth candidates observed during
actual draw calls, so a game may unbind its scene depth before Present. Candidate
references are released at Present and swapchain destruction/Reset. The provider
owns a separate `dlss5-feed.cfg` `enabled` switch with a Chinese ReShade panel;
disabled frames skip host submission and output copies, and re-enabling starts a
new resource/history generation. It is independent of ReShade's global effects
switch. R3 also binds reuse to the complete depth descriptor and ready copy
pipeline, rebuilding after format changes and bypassing unsupported multisample
depth. Both architectures have exact-binary 600-frame unbound-depth, D24S8/D16
format-switch, MSAA-bypass, switch and Reset evidence in
`resources/legacy-runtime/acceptance/dx9-r3-build.json`; the
five unchanged non-DX9 routes keep their existing controlled evidence.

The local Feeder matrix is DX9/DX10/DX11 x86 and x64, plus DX12 x64, each with
separate RTX40 and RTX50 model runtimes. The published HoYo workflow is x64
DX11/DX12 and starts directly with an external helper profile. DX9+HoYo is not
an admitted combination. Ordinary games default to game-directory deployment;
existing installations retain their current deployment.

`resources/legacy-runtime/manifest.json` locks assets and route acceptance;
`src/product/legacy-runtime-lock.js` also retains historical receipt identities.
Repairs preserve the installed combination. A Feeder 0.13.1 to 0.15.1 transition
is an explicit complete-package operation, not a provider-only replacement.
The previous fixed Feeder and Vulkan resources remain available within their
existing ownership and recovery boundaries.

`npm run verify:legacy-runtime` checks each unique asset once, its PE architecture,
every admitted recipe and the final binary identities in controlled acceptance.
Both full and portable builds run this check. The 7 RTX50 controlled routes have
NR completion, resize/reset and OS exit evidence; RTX40 files are verified but
hardware execution and real-game results remain separately recorded in
[`docs/beta3-acceptance.md`](docs/beta3-acceptance.md).

The separate game-plugin manual update archive contains 26 route directories
and two shared GPU-family NR runtimes. It is not a manager OTA-import format.
Manager-owned installations continue through preview/apply/recovery so their
files, backups and receipts stay consistent. Full copyright and license notices
are described in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
