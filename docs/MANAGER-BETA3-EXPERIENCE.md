# Manager 0.5 Beta3 candidate

The implementation starts from Manager `06ad66be98b5b8793da193a4c5d481289fe93258` in an isolated worktree. It does not change stable release branches or install into owner games.

- API preference is bound to the selected executable and stored independently of deployment. The renderer submits a single apply request; component import can resume that request.
- Waiting operations live under `waiting-operations`, independently of write/recovery journals. Each game directory has a write queue. A changed executable, configuration, receipt or layout stops an old waiting request; its draft remains recoverable.
- NR configuration exposes saved text, static effective values, default provenance, errors and the actual Core identity. Writes preserve unrelated keys and encoding, then reread. External edits take priority over drafts.
- Unified3 is fixed to source `7a90660bc468ca86a02abe2e145638b51489d549`. A complete first-install catalog requires its matching INI and seven `nr_face` resources. OTA archives without an INI are update inputs. New installation remains on `0.4.7beta`; old D21 is retained.
- `dlssg-sm86` is separate from MFG Unlock, fixed to upstream 0.3.5 / `9621db573e07ed54f50c15bbb585ed9a7bdfac28`. External staging verifies all four upstream files. No binary is tracked in source.

`desktop/test/manager-experience.electron.cjs` exercises production renderer/service/journals using a synthetic game and inert payloads. `desktop/test/nr-settings.electron.cjs` exercises the actual NR controls with synthetic INI files. These are software interaction checks, not in-game or GPU proof. P95 interaction and cached-page timings are emitted by the experience runner.

Stage the fixed inputs using `desktop/scripts/stage-manager-distribution.cjs`; Beta3 requires `sm86.sourceRoot`, the exact four upstream files, and a complete unified3 Core catalog. Build with the local directory ZIP workflow. Inspect the staged diff and run the repository audit before any later publication. This batch authorizes a local candidate only.

Hardware/game acceptance remains outstanding for RTX20/30 frame generation and unified3 in real games. Unified3 exposes only its verified NGX-D3D12-Feature1 interface; existing Feeder/Vulkan providers retain their independently matched Core contracts.
