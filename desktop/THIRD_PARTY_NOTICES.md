# Third-party notices

## DLSS5-Swapper

Parts of the game-library discovery, PE inspection, game scanning, process
guards and file-journal foundation are adapted from DLSS5-Swapper:

- Project: https://github.com/rakanki911/DLSS5-Swapper
- Original author: Rakan Alkhaldi
- License: MIT
- Baseline commit: `ccb67f4bc92cb5da1d25416dd6b338e12fa432c5`

The original copyright and MIT permission notice are retained in `LICENSE`.

The three pure INI helpers in `src/product/launch-ini.js` are adapted from
DLSS5-Swapper commit `027d1becef8d048b757eb76ced639df583374917`; their full MIT
notice is included in `src/product/SWAPPER-INI-LICENSE.txt`.

## Launch configuration controls

The scoped SR/FG configuration compiler and NVIDIA profile adapter were migrated
from this project's frozen public Manager implementation at
`0b386eb2de1cc392cf69a8b6fb809800f9e1cc62`. Public configuration contracts are
documented in the compiler's `SOURCES` object. This code manages existing
OptiScaler/RTX40 control configuration and public NVIDIA profile settings;
The configuration code itself does not implement rendering or frame generation.

## RTX 40 frame-generation compatibility components

The current default is the official MIT-licensed
[MFG Unlock 0.9](https://github.com/mavismmg/MFGAdaUnlock-RenoDx/releases/tag/0.9)
ReShade Add-on, fixed at 601088 bytes and SHA-256
`64184bb370f223c3cabb359010a9a64e114cdae6b62d8b014a731a602af0a0da`.
The pinned 0.7 source-build and official 0.6.1/0.7 providers remain available
for identifying and restoring historical managed installations; they are not
the default build input.

The historical 0.7 source provider uses the MIT-licensed source commit
`ffe6169b5e98ad578fcf2c30614d06a567790fe1`, a separate simplified Chinese overlay
and the documented `flip-metering-serialization-v1` local safety patch. The patch
serializes concurrent pacing discovery and restoration with a nonblocking RAII
gate and uses an atomic retry counter. Hook matching, defaults, registration,
configuration keys and original diagnostic messages are retained. The untouched upstream source and MIT license are in
`native/mfgunlock/upstream`, with locked SDK and Detours dependencies in
`native/mfgunlock/source-lock.json`. The official 0.7 and official 0.6.1
(`a975e84712a6bfc84284f50c9621c349ee806734`) binaries remain selectable alternatives
with their original bytes; they do not include this local safety patch.
Each pinned binary digest, original README and full license is recorded in
`resources/fg-mfgunlock/manifest.json` and shipped alongside its Add-on.
Only one selected version is deployed to the canonical active filename.
It controls existing Streamline FG; the manager does not bundle or replace
DLSS-G or Streamline runtime DLLs for this feature. The older components below
remain available only to identify and restore historical managed installations.

Historical release resources include the original MIT-licensed components from
[RTX40MFG-Unlock v1.2](https://github.com/dashdogy/RTX40MFG-Unlock/releases/tag/v1.2):
RTX40MFGCore.dll, RTX40MFG.asi and RTX40MFG-UI.addon64. The full copyright and
permission notice and MinHook license are retained in `resources/fg-components/LICENSE`
and `resources/fg-components/MINHOOK-LICENSE.txt` and included in packaged resources.

[Ultimate ASI Loader v9.7.4](https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases/tag/v9.7.4)
provides the x64 early-load proxy. Its full MIT license is retained as
`resources/fg-components/UAL-LICENSE`. Fixed source archive URLs and SHA-256 hashes
are recorded in `resources/fg-components/manifest.json`.

These historical components require a game that already provides compatible
Streamline DLSS Frame Generation. Their notices and recovery metadata remain
available, but current base/offline staging does not copy their DLL/ASI artifacts.

## Lucide navigation icons

Four navigation icons and the checkbox check icon are copied without path changes from Lucide `0.468.0`
(`f12b0de177fbc2a6795e99be065887e72b237123`). The full ISC/MIT attribution is
included in `src/renderer/icons/LICENSE`. Source: https://github.com/lucide-icons/lucide.

## ReShade runtime

The current Manager payload uses the authorized official ReShade 6.8.0
add-on-enabled runtime selected for the active Core package and host architecture.
ReShade remains separately licensed by its authors. It is not committed to this
repository and must be prepared from a lawful official source.

ReShade is Copyright 2014 Patrick Mours and distributed under the BSD 3-Clause
License. The full notice is retained in
`resources/legacy-runtime/shared/licenses/ReShade-LICENSE.md` for the 0.15.1
Feeder pool, as well as in the existing Vulkan package described below.
Official source: [crosire/reshade](https://github.com/crosire/reshade).

The base staging keeps the authorized four-file Vulkan ReShade 6.8.0 layer
(`recipe.json`, `ReShade64.json`, `ReShade64.dll` and `LICENSE.md`) for the
Bridge/Vulkan provider to reuse the existing HKCU activation path. Its original
x64 layer manifest and DLL are copied without patching; the BSD 3-Clause notice
is included in `resources/vulkan-reshade/LICENSE.md`. The historical Vulkan
Core/chain/NVIDIA runtime pool is not copied into the lightweight base package.

## Vulkan scene and motion inputs

The optional Vulkan package combines the project's own NR Core with an adapted
[DLSS5-Feeder](https://github.com/jlrouzies-fr/DLSS5-Feeder) at
`26c002d5156d178c2db438327194077c9ad94418`. Feeder's MIT notice is retained as
`licenses/Feeder-MIT.txt` inside the runtime package. Its scene and depth inputs
come from ReShade; its motion estimates use the pinned VORT shader closure at
`b410b9f0c0fbb83c8cb42164aaf1655fab386f4a`. These motion estimates are not native
game motion vectors.

VORT's repository-level MIT notice is retained as `licenses/VORT-root-MIT.txt`.
Individual file notices remain authoritative: the required
`Includes/vort_MotionVectors.fxh` carries CC BY-NC 4.0, and its original header
is preserved. The closure must not be described as entirely MIT-licensed.
The accompanying ReShade.fxh at `6db142b4b1a05c764222e5b0bd9a644b7ccfe1dc`
retains its CC0 notice. The runtime recipe records each shipped file's digest
and provenance separately.

## Feeder 0.15.1 and system D3D9On12

The historical beta.3 legacy-API pool adapts
[DLSS5-Feeder 0.15.1](https://github.com/jlrouzies-fr/DLSS5-Feeder/tree/3f624855276c4bde55145c712782477639b30e85),
commit `3f624855276c4bde55145c712782477639b30e85`, by Jean-Laurent ROUZIES.
Its [MIT license](https://github.com/jlrouzies-fr/DLSS5-Feeder/blob/3f624855276c4bde55145c712782477639b30e85/LICENSE),
including the retained NIGos bridge attribution, is included in
`resources/legacy-runtime/shared/licenses/Feeder-MIT.txt`.
The downstream provider, host transport and completion checks use the project's
sole NR Core through `NRExternalProviderV1`; they do not inject native SR or FG.
The older fixed Feeder and Vulkan packages keep their own identities and notices.

The 0.15.1 pool uses the same pinned VORT closure identified above, with the
original MIT and CC BY-NC 4.0 file notices retained. The noncommercial motion
estimation file credits Jakob Wapenhensch, Pascal Gilcher / Marty McFly and
Vortigern. Additional attribution is retained in
`resources/legacy-runtime/shared/licenses/VORT-license-details.txt`.

The DX9 entry shim and DX9 relay are maintained by this project. They call the
Windows-provided D3D9On12 implementation and load the pinned official ReShade;
they do not bundle Microsoft's system D3D9/D3D12 runtime. The beta.3 pool contains
no dgVoodoo archive or runtime. Its official 2.87.4 download was excluded after
a persistent Defender detection and review of its framework-distribution terms;
the recorded source and scan results remain in
`docs/beta3-dgvoodoo-security-review.md`.

## HoYoShade configuration reference

The per-game HoYo profile follows the published configuration model at
[HoYoShade V3.0.0-Beta.9](https://github.com/DuolaD/HoYoShade/tree/23761f935444a78388c028fbfda921965177c453),
commit `23761f935444a78388c028fbfda921965177c453`.
The upstream code is Copyright (c) 2024 哆啦D夢 / DuolaD under the
[BSD 3-Clause License](https://github.com/DuolaD/HoYoShade/blob/23761f935444a78388c028fbfda921965177c453/LICENSE).
This release uses the manager's own profile and loading-helper implementation
with official ReShade 6.8.0. It does not execute or distribute the upstream
injector or INI-builder programs and does not copy the upstream preset bundle.
The fixed reference identity and policy are recorded in
`resources/hoyoshade/component.json`.

## Native DX11 NR bridge variants

The native DX11 component catalog retains this project's NR-compatible variants
of NIGos Bridge 1.4.12 and 1.4.11. These are adapted companion binaries, not
interchangeable copies of an upstream release with the same version string.
Their source relationships, exact digests and paired Core identity are recorded
in `src/product/component-registry.js` and `payload/nr-before-sr/bundle.json`.
Source: [NR-before-SR project](https://github.com/smartLanny/dlss5-nr-before-sr-lab).
Their payload licensing remains separate from the manager as described below.

## NVIDIA runtime

The historical fixed DX12 Feeder package uses the pinned Feeder/VORT/ReShade
shader sources described above, with a separate DX12 adapter owned by this
project. It processes completed frames with synthetic guidance and is not
native game SR or FG. Its recipe retains per-file provenance and licenses,
including VORT's CC BY-NC 4.0 notice. The package also includes the separately
licensed NR Core and NVIDIA NR runtime supplied by the release maintainer.

`nvngx_dlssnr.dll` is not part of this repository and is not licensed by the
MIT license above. The project does not download, commit or grant rights to any
NVIDIA binary, model or SDK component. A release maintainer must supply runtime
files only where they have a lawful right to do so.

## NR-before-SR runtime

The manager treats the active D15 NR-before-SR add-on, chain and bridge as
externally staged payload files with separate source and licensing. The current
default source package is D15; older D13 and 0.4.7 Corefix8 candidates are not
copied into the new base/offline package. Historical third-party notices remain
in the verified source records and are not relicensed by the Manager.
