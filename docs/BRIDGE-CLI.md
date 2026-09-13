# Explicit bridge context in the real CLI

The existing command now accepts a local, explicit context:

```sh
npm run build
node dist/src/index.js install generic-dlss --bridge-context local-context.json
```

It calls the actual `planInstall(recipe, context)` / `planBridgeDlc` path. A blocked
bridge plan exits nonzero (1); a successful metadata plan remains dry-run and never
authorizes installation. Without this option the existing one-argument behavior is
preserved. Duplicate, unknown or incomplete install options are not silently ignored.

A minimal inactive example (does not require a Feeder/Core package):

```json
{"enabled": false}
```

For an active test, use the `BridgeContext` contract in `src/recipes/bridge.ts`,
with actual known API/architecture, input evidence, Core identity and package
metadata. Do not invent native availability based on DLL presence. Current
`generic-dlss` does not supply an approved synthetic Feeder pin: an absent native
input must keep that route blocked until an approved recipe explicitly defines it.
The context cannot replace recipe pins; do not add an arbitrary pin override to
make a fixture pass. Existing BG3 pin and rollout policy remain unchanged.

The reader allows a nonempty ordinary local UTF-8 JSON object up to 1 MiB. It
rejects directories, link files, UNC/URL inputs, invalid UTF-8/JSON, a changed file,
and oversized data; errors do not echo arbitrary file contents. It returns a
SHA-256 for the input bytes. This is traceability, NOT authentication: neither the
hash nor user-authored JSON proves binary identity, interface readiness or game
compatibility. Public CLI never loads Core/Feeder/NVIDIA DLLs or performs GPU work.

This closes the previous CLI-to-planner wiring gap, but it does not automatically
scan DLL inventories, authenticate DLC manifests, download files, or implement a
transactional installer. Those remain separate work. A future trusted inventory
collector may construct the same context; the game-side provider must still query
and validate its real consumer before using any frame.

Tests include bounded local I/O and six child-process calls to the actual compiled
CLI. No private source, vendor headers/runtime or signing material is involved.
