# Manager Beta9: common controls and recoverable operations

Based on the delivered Beta8 commit `48dc3c62217b7862b273bbfdd7375a52c363f1e3` in an isolated worktree. This records Manager source changes and local validation on 2026-09-22. The delivery's external source manifest and validation record bind the final commit to the actual package and startup results. No real game files or Core / Bridge / Feeder source or binaries were changed.

## User-facing changes

- Ordinary and HoYo first installation share the same three settings tabs and one primary action. A successful Apply does not launch a game.
- HoYo artwork uses the existing executable-icon service, with a retry on explicit discovery. Binding and the HoYo launch owner are preserved.
- Staging includes eight exact Core versions: 0.2.0-beta.2, 0.3.7, 0.4.2, 0.4.7beta, 0.5 D13, D21, Unified3 and Unified5. The default remains 0.4.7beta; route compatibility controls which choices can be installed. Historical Manager 0.4.8-beta.3 used Core 0.4.7beta and is not a separate Core version.
- Startup options, component attribution, detailed change lists and extra NR layers open on demand. Unsupported Core parameters are omitted. Selected SR model descriptions reflect the selected model.
- D13 uses NRPasses and its original rational second-pass scale; it never receives Unified5 layer keys. 0.3.7 defaults and ranges use its actual configuration contract.

## Functional fixes

- Cancelled drafts, changes made outside Manager and game switches invalidate a pending DLC continuation. Import cannot replay an obsolete request.
- Native local/external queue preparation checks actual NR conflicts. Conflicts appearing after exit retain the full request for explicit review. Completing a new Apply retires the old review prompt.
- Restoring a pending draft preserves the exact NR, SR and FG fields. Independent SR/FG edits before Core installation do not force a Core install.
- HoYo cached editors refresh when API/binding/installation state changes. A reviewed installation plan can be confirmed even when a version draft exists. Missing-DLC guidance updates immediately and resumes only the same request.
- Isolating an NR DLL preserves unrelated explicitly configured external DLL paths.
- The exact standard Core identity receives its proven V1 export metadata. This does not grant the newer Provider's additional capabilities.
- The explicitly requested API reaches native DLSS probing and its cache key. An unknown API remains unresolved instead of being mistaken for a missing-DLSS Feeder case; the user can select the actual API and retry.
- Native DLSS input takes priority: DX11 uses its matching Bridge, while a Feeder route requires its own input and component checks. Manager does not automatically substitute Core's Present compatibility mode for Feeder.

## HoYo route and optional legacy pool

The reported Beta8 ZZZ `LEGACY_PACKAGE_UNTRUSTED` failures show that preview entered the legacy Feeder path, whose fixed pool was absent. The ordinary NR DLC being ready does not supply that pool. HoYo uses either native input or Feeder input through its existing external profile and helper, according to the actual API, native DLSS evidence and the selected components. Existing installations retain their recorded input route; selecting a Core with Present support does not silently replace Feeder.

The fixed-identity Manager adapter now connects Unified5 to the existing D16-r3 and stable-r3 Feeder packages in HoYo profiles. Original package IDs, manifests, hashes and binary bytes remain unchanged. HoYoShade owns the ReShade loader; Provider/configuration/shader files use the profile's addon/runtime directories instead of installing a local game proxy. D16's missing shader dependencies are supplied from existing components with fixed SHA-256 identities. Core capability checks remain required, and historical receipts retain their original validation and recovery rules.

An initial packaging attempt failed with `legacyRuntime.root 缺失。` (`package-gate.log`). Requiring the legacy pool for every package was too broad and has been corrected: omitting it reports `not-bundled`, `ready: false`; explicitly declaring it still requires the exact complete pinned pool. The builder omits the absent optional resource mapping. Four exact historical Provider/host files remain unavailable; their absence does not block packaging the current supported routes or require waiting for a new Feeder build. This does not make an unavailable historical recipe ready. See [the short handoff](HOYO-FEEDER-HANDOFF-BETA9.md) and [game/input distinctions](HOYO-INPUT-ROUTES.md).

## Validation boundaries

The private local validation directory retains the following evidence. Counts below describe separate runs and are not a combined test total.

| Evidence | Result and scope |
| --- | --- |
| `repo-final.log` | Beta9 build, root CLI/unit suite 78/78, and source payload gate passed; not the full desktop unit suite. |
| `queue-final.log`, `catalog-verification.json` | Focused service/queue tests 60/60; catalog/configuration tests 53/53 and historical payload hash checks. No Core rebuild or game validation. |
| `feeder-backend-unit.log`, `feeder-hoyo-ownership-unit.log` | Initial backend run 70/71; the sole failure lacked an ignored ReShade fixture. That case passed 1/1 with the exact external fixture. This is not a single 71/71 run or acceptance of a complete HoYo package. |
| `hoyo-provider-route-contract-unit.log` | 1/1: a compatible Core does not authorize an undeclared HoYo/helper loading route. |
| `experience.log`, `proxy-conflicts.log` | Real Electron with production service/installer/journal and synthetic game/payload: installation, DLC continuation, Core update/rollback, waiting/cancel; 43 conflict checks, including exact restoration and retained backups. |
| `ordinary-full.log`, `hoyo-shared-ui.log`, `pending-requests-ui.log` | Renderer fixtures: 765 ordinary-game assertions, 91 HoYo assertions and 16 pending-request checks. HoYo IPC is simulated. |
| `usability-normal.log`, `usability-narrow.log` | 23 checks each passed with synthetic IPC; corresponding normal/narrow screenshots and audit JSON remain private. |
| `legacy-optional-gate-unit.log`, `legacy-optional-gate-stage.json` | Post-snapshot correction: 32/32 focused tests; real external base staging inputs passed validation with the optional legacy pool explicitly reported absent. Missing files, forged metadata and same-size modified payloads remain rejected when the pool is declared. |
| `input-route-service-final.log`, `input-route-probe-workflow.log` | 37/37 service routing tests and 39/39 probe/workflow tests. Selected API reaches evidence collection; uncertain evidence remains actionable. |
| `input-route-ui.log`, `input-route-hoyo-ui-regression.log` | Six input-route UI checks and eleven HoYo readiness/history checks passed. |
| `hoyo-provider-pairing.log` | 3/3 production-service tests passed with real staged component bytes and inert games/launchers: DX11 HoYo Feeder install/update/restore, DX12 native input and Feeder fallback, immutable original receipts and fixed shader integrity. DLLs were not executed. |
| `repo-final2.log`, `hoyo-final2.log`, `pending-final2.log`, `experience-final2.log` | Root suite 78/78, HoYo renderer 91 checks, pending-request renderer 16 checks and production-service Electron experience passed after the API/provider corrections. |
| `usability-normal-final.log`, `usability-narrow-final.log` | 23 checks each passed; cached tab transitions including the next paint had a normal-window P95 of 17.4 ms. This is a local synthetic-data measurement, not a large real-library benchmark. |

The final ordinary renderer regression and package startup results are recorded in the delivery validation file to avoid inferring them from source checks. The owner has confirmed the newer Feeder's compatibility; that statement is distinct from Manager fixture results and in-game verification.

Synthetic EXE/Core/GPU/IPC fixtures do not prove actual HoYo installation, helper attachment, in-game behavior or hardware frame generation. Catalog assembly is not complete application packaging. No hosted CI, release, push or merge was performed.

Screenshots and customer feedback remain outside source control. Staging validation is not a delivered executable or complete-package acceptance. No game was run for these final Manager fixes, and actual ZZZ installation and game validation remain incomplete. No successful result is inferred from fixture tests or the owner's Feeder compatibility confirmation.
