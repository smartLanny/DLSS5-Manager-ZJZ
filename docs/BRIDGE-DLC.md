# Optional bridge DLC boundary

This public Manager owns recipe selection, pinned DLC metadata and installation
planning. Optical flow, Generic Depth consumption, NR execution and GPU lifetime
belong to the game-side Core/provider, not TypeScript or the updater.

## Roles

- Valid native D3D12 input: keep the native Core route; no Feeder dependency.
- Native cross-API input: select a compatible native mirror DLC. NIGos also has an
  upstream synthetic mode, but our recipe must declare its actual role and variant;
  a renamed upstream DLL is not a proven compatible replacement.
- No usable native input: select the existing synthetic-input provider/transport.
  Reuse its capture/host/depth route, rather than adding a second Feeder implementation.
- Unknown evidence or missing/mismatched package: decline that optional route and
  preserve the installed Core/original picture. File presence alone is not proof of
  usable native guides. Never manufacture a successful compatibility status.

## Implemented API, not a completed installer

`planInstall(recipe, bridgeContext)` now invokes `planBridgeDlc`. The optional
context follows `BridgeContext` in `src/recipes/bridge.ts`: explicit API, process
bitness, native-input evidence, Core build/interfaces and cached package metadata.
Old callers that pass only a recipe keep their original dry-run behavior. The
current CLI does not collect this context automatically; UI/CLI inventory wiring
is a separate task. No new binary downloader, validator or transaction writer is
claimed here.

The result is always `dryRun: true`, `installAuthorized: false`:

| Result | Meaning |
| --- | --- |
| `not-requested` | Optional DLC is off; do not require its files |
| `native` | Explicit native x64 D3D12 capability takes priority |
| `candidate` | Exactly one package matches declared metadata; runtime unverified |
| `blocked` | Report a specific missing/ambiguous/mismatched prerequisite; no writes |

Version, variant, digest, API, bitness, Core build and input-interface must agree.
x86 packages must declare an x64 host. Multiple cached versions are fine, but only
one pinned variant is selected. Duplicate same-version candidates need explicit
variant selection. Existing BG3/Bridge 1.4.11 and no-latest/no-1.4.13-pre policy stays.
A major/minor Core version alone is insufficient to establish ABI compatibility.

Before real installation the caller must authenticate the approved manifest, hash
actual bytes, inspect PE architecture/host identity, recheck license notices,
confirm the game is closed, preserve backups and use transactional rollback.
Before neural execution the provider must Query the actual Core and validate
frame identity, extents, formats and completion. None of these are replaced by a
JSON `sha256`, `x64HostIncluded` or `compatibleCoreBuilds` field.

## Distribution and multiple versions

NIGos Bridge and DLSS5-Feeder themselves use MIT licenses. Their license texts allow
copying, modification and distribution subject to retaining copyright/permission
notices. There is no one-version-only restriction in those texts. That permission
is scoped to their covered code, not every dependency in an assembled ZIP:

- https://github.com/NIGos/dlss5-bridge/blob/main/LICENSE
- https://github.com/jlrouzies-fr/DLSS5-Feeder/blob/main/LICENSE
- https://gpuopen.com/manuals/fidelityfx_sdk/license/
- https://docs.nvidia.com/video-technologies/optical-flow-sdk/license/index.html

Review the exact source revision, build inputs and each redistributed asset.
NVIDIA SDK/runtime and third-party motion shaders retain their own terms. A DLC
label, a separate download or our Manager's MIT license does not waive them.
`licenseNoticeFiles` is a manifest checklist, not a legal or authenticity verdict.
No payload, SDK headers, proprietary code, signing keys or private evidence is
introduced by this change. The existing external-DLC/no-payload policy stays.

Multiple versions should live in the local versioned cache outside ReShade's
active addon search paths. Deploy one explicitly selected bridge/provider per
route, keep rollback versions inactive, and do not silently switch the pin.

## Optical-flow controls

The requested game-side experiment has only AMD/NVIDIA selection and 100%/50%
OF input scale, default AMD/100%, with synthetic input off until requested. Scaling
applies only to the OF image copy, not NR Color, Generic Depth or game rendering
resolution. No guessed INI keys or runtime support are added by Manager.

## Validation of this increment

Scoped TypeScript build with the repository's strict/NodeNext/noUncheckedIndexedAccess
settings and 34 Node tests passed, including the actual `planInstall` caller.
Only changed modules and their unchanged types/error dependencies were compiled
locally; this is not the full repository test suite or the packaged Windows UI.
No downloads, real installation, Core loading, SDK/GPU or game tests were run.
