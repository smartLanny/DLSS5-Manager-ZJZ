# Managed D3D9On12 entry point

This source-built `d3d9.dll` converts normal `Direct3DCreate9` and
`Direct3DCreate9Ex` calls into the corresponding ReShade 6.8 add-on
`Direct3DCreate9On12` entry point with one zero-initialized `D3D9ON12_ARGS`
whose `Enable9On12` member is `TRUE`. Windows owns device creation and all
COM objects. Existing On12 entry points preserve the caller's override list.

The selected executable loads `d3d9.dll` next to itself. The shim loads only:

| Process | Fixed loader relative to the actual executable | SHA-256 |
| --- | --- | --- |
| x86 | `_DLSS5_Feeder15/ReShade32.dll` | `da430e0a9c6eecefa0d1b27d05e16c426fb5d04e808b194d914eaac4b31bc0f8` |
| x64 | `_DLSS5_Feeder15/ReShade64.dll` | `0cee63f9c9f13f3ac909c5b4903f4dbb4b719a7ab3b4f13b0deaf83c814b94f7` |

The size and SHA-256 are checked before executing the loader. Read handles
remain open to prevent replacing its bytes; after loading, Windows file IDs
confirm the mapped module is the same file. Reparse-point loader paths are
rejected. Initialization is lazy, outside the shim's DLL entry point.
Before loading ReShade, the shim explicitly loads the system D3D9 target so
its On12 hooks can resolve even when creation is the first export called.

`ReShade32/64.dll` uses ReShade's non-proxy configuration rule: a real
`ReShade.ini` must exist beside the executable. The local Feeder service
already uses that path and writes its exact managed `AddonPath`. Merely
placing `ReShade.ini` inside `_DLSS5_Feeder15` is insufficient. The shim does
not alter environment variables, create configuration files, or search for
alternative loaders when verification fails.

The export directory matches Windows D3D9: 23 ordinals (16–38), with 17 named
exports. All 19 ancillary entries use assembly tail calls to the actual
system DLL, preserving their original ABI, including unnamed private
entries. x86 saves general registers, flags and FPU/SSE state while resolving
the target; x64 preserves incoming register and SIMD arguments and supplies
valid stack alignment, shadow space and unwind metadata. Missing system
exports fail fast rather than returning with a guessed calling convention.

Build with `scripts/build-feeder-d3d9on12-shim.ps1` into a fresh directory.
The fixed toolchain is MSVC 14.44 / Windows SDK 10.0.26100.0; the only linked
DLL imports are KERNEL32 and BCrypt. The build emits hashes and export/import
tables. `scripts/test-feeder-d3d9on12-shim.ps1` builds actual x86/x64 SDK-linked
executables and tests missing, misplaced, altered and valid loaders, including
creation before any ancillary export has been invoked. These
tests create enumerators but no graphics device. Device interop, Reset,
ReShade callbacks, host processing and real games require separate evidence.

Primary interface references:

- [Microsoft D3D9 device creation and resource interop specification](https://microsoft.github.io/DirectX-Specs/d3d/TranslationLayerResourceInterop.html)
- [ReShade 6.8 DLL initialization and configuration selection](https://github.com/crosire/reshade/blob/v6.8.0/source/dll_main.cpp)
- [ReShade 6.8 D3D9 entry points](https://github.com/crosire/reshade/blob/v6.8.0/source/d3d9/d3d9.cpp)

This shim contains project source and uses the Windows SDK. ReShade remains
the unmodified official add-on loader from `ReShade_Setup_6.8.0_Addon.exe`.
It does not include dgVoodoo, alter a graphics driver, provide native SR/FG
support, or establish that NR has processed a frame.
