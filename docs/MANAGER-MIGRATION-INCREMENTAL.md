# Manager migration incremental record

`docs/MANAGER-MIGRATION-SOURCE.json` remains the immutable source snapshot. It records the tracked Electron import from `ab2a5785` and is intentionally not rewritten by packaging work.

This increment migrates the desktop Manager and adds component management and packaging:

- The shared API resolver supplies the desktop game page, preflight and installation. A detected API is used directly; unknown and conflicting evidence still permits a manual override. New installations use the selected source's default Core rather than forcing the historical 0.4.7 version.
- The component library imports manifests, recognized files and upstream archives into an immutable shared cache. Core and runtime selections retain older versions; Bridge and MFG changes use existing per-game transactions and recovery records.
- The desktop uses the public CLI bridge preflight implementation, generated during build. Compatible interfaces admit new Core identities without changing an exact-version whitelist; metadata matching remains distinct from runtime validation.
- External Provider recipes bind their transport to the selected Core, its matching chain companion and one hardware-family runtime. Existing game receipts preserve their own provider selection.
- Payload verification reads only the selected deployment inventory, streams file hashes and caches display-only missing-runtime states. Commit-time source, executable, backup and recovery checks remain active. Installation timing is recorded for the owner to measure; no deployment speedup percentage is claimed.

- `desktop/package.json` moves the Electron release identity to `0.5.0-beta.2` and exposes `stage`, `build:base`, `build:offline` and portable variants. The build entry also supports a dedicated non-system-drive work root and a complete unpacked test ZIP.
- `desktop/scripts/stage-manager-distribution.cjs` consumes an external staging JSON, validates the active Core plus MFG 1.0/0.9, copies only a small allow-list, and rejects D13/D14 defaults.
- The same stage entry now accepts an explicit `components` allow-list for small Bridge, Feeder, host, and Vulkan files. It writes a digest catalog under `resources/components/`; `nvngx_dlssnr.dll` remains forbidden there and stays in the RTX-family runtime split.
- The stage manifest also has a narrow `resources` allow-list for the existing HoYoShade profile, loading helper, REFramework entry files and the four-file Vulkan ReShade layer (`LICENSE.md`, `recipe.json`, `ReShade64.dll`, `ReShade64.json`). It does not restore the historical Feeder/legacy resource pools or the old Vulkan Core/NR runtime pool.
- `desktop/scripts/build-manager.cjs` supplies dynamic Electron Builder resources and writes artifacts outside the repository.
- `docs/RUNTIME-PACKS.md` documents the RTX20–40/RTX50 split, manual file/directory/ZIP import and the Microsoft VC++ x64 repair link.
- `desktop/src/product/deployment-timing.js` and the native installer record identity/preflight, backup/write, commit and total elapsed milliseconds in the install manifest and returned operation result; timing data contains no paths.
- `desktop/scripts/build-vulkan-present.ps1` now requires caller-supplied headers, DXC and MSVC paths; no workstation-private path remains in that entry point.
- `desktop/src/product/fg-mfgunlock-providers.json` holds the MFG provider pins; `fg-mfgunlock-resources.js` exposes only official 0.9 for new installs. The 0.7/0.6.1 digests are recovery-only identities for historical receipts and are neither selectable nor packaged.
- `scripts/assert-no-payloads.mjs` uses Windows-safe URL conversion and skips only generated stage/release trees while continuing to reject source payloads and private keys.

Without a staged Bridge package the local bridge entry remains a reservation. The current generic staging entry copies the separately pinned Bridge package with its importer manifest and records `candidate-staged` plus its addon digest; that does not turn the candidate into a compatibility result. Runtime files are sourced through the authorized external manifest; the repository does not gain a new NVIDIA DLL.

The repository changes prepare a candidate and its verification workflow; they do not themselves claim stable game/GPU compatibility. Public release publication, signed installer production and main-branch merge remain separate repository operations with their own credentials and gates.
