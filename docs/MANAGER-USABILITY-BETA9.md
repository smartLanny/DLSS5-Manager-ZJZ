# Manager Beta9: common controls and recoverable operations

Based on the delivered Beta8 commit `48dc3c62217b7862b273bbfdd7375a52c363f1e3` in an isolated worktree. This records Manager source changes and local validation on 2026-09-22, not a delivered Beta9 executable. No real game files or Core / Bridge / Feeder source or binaries were changed.

## User-facing changes

- Ordinary and HoYo first installation share the same three settings tabs and one primary action. A successful Apply does not launch a game.
- HoYo artwork uses the existing executable-icon service, with a retry on explicit discovery. Binding and the HoYo launch owner are preserved.
- Core choices include 0.3.7, 0.4.2, 0.4.7beta, D13 dual-pass and Unified5; the default remains 0.4.7beta. Route compatibility still controls which choices can be installed.
- Startup options, component attribution, detailed change lists and extra NR layers open on demand. Unsupported Core parameters are omitted. Selected SR model descriptions reflect the selected model.
- D13 uses NRPasses and its original rational second-pass scale; it never receives Unified5 layer keys. 0.3.7 defaults and ranges use its actual configuration contract.

## Functional fixes

- Cancelled drafts, changes made outside Manager and game switches invalidate a pending DLC continuation. Import cannot replay an obsolete request.
- Native local/external queue preparation checks actual NR conflicts. Conflicts appearing after exit retain the full request for explicit review. Completing a new Apply retires the old review prompt.
- Restoring a pending draft preserves the exact NR, SR and FG fields. Independent SR/FG edits before Core installation do not force a Core install.
- HoYo cached editors refresh when API/binding/installation state changes. A reviewed installation plan can be confirmed even when a version draft exists. Missing-DLC guidance updates immediately and resumes only the same request.
- Isolating an NR DLL preserves unrelated explicitly configured external DLL paths.
- The exact standard Core identity receives its proven V1 export metadata. This does not grant the newer Provider's additional capabilities.

## Unresolved delivery dependency

The reported Beta8 ZZZ failure is reproducible: HoYo preview falls back to the pinned legacy Feeder pool, which was absent from the delivered application. The ordinary NR DLC being ready does not supply this pool.

Four exact legacy Provider/host binaries are unavailable in inspected local sources, archives and historical installers. The currently bundled D16-r3 package declares local proxy routes; it does not declare HoYoShade. Neither its route identity nor the Core capability requirements may be bypassed.

The attempted packaging gate returned `ok: false` with `legacyRuntime.root 缺失。` (`package-gate.log`). This confirms rejection of incomplete input; it is not a successful package build. The owner confirms that no new HoYo Feeder artifact is available. No repaired HoYo package or new Beta9 EXE has been delivered, and actual ZZZ installation and complete-package acceptance remain incomplete. Supply either the complete original pinned pool or a separately identified, verified HoYo-compatible Provider package before rerunning production service/Electron and final packaged installation checks. See [the short handoff](HOYO-FEEDER-HANDOFF-BETA9.md).

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

Synthetic EXE/Core/GPU/IPC fixtures do not prove actual HoYo installation, helper attachment, in-game behavior or hardware frame generation. Catalog assembly is not complete application packaging. No hosted CI, release, push or merge was performed.

Screenshots and customer feedback remain outside source control. Packaging and real HoYo installation acceptance remain incomplete until the missing compatible input is supplied.
