# Local basic regression

`npm run check` builds the shared CLI/Desktop contract, runs the portable CLI tests,
and checks that the public source tree contains no payloads.

Desktop tests using real pinned MFG or historical Bridge files require optional
assets outside this lightweight checkout. Set these paths in the test process:

- `DLSS5_TEST_RESOURCE_ROOT`: a resources directory containing `fg-mfgunlock/`
  with the current manifest and the pinned versions required by the selected tests.
- `DLSS5_TEST_LEGACY_PAYLOAD_ROOT`: the historical NR payload directory containing
  `bundle.json`, `fixed/`, and `versions/`, for historical Bridge recovery tests.

For example, after setting those variables, run from the repository root:

```powershell
node --test --test-concurrency=1 desktop/test/game-api-ui.test.js desktop/test/operation-application-identity.test.js desktop/test/operation-plan-integration.test.js
```

The external paths change only test fixture discovery. The production manifest,
PE, file identity and SHA-256 checks remain active. Missing assets do not authorize
substitute files, and these tests do not execute the supplied DLLs. Installation,
driver and registry fixtures operate on temporary files and mocked owners.

The BG3 integration case checks that Bridge 1.4.12 is rejected, explicit 1.4.11
stays pinned across Core selection, and rejection/restoration preserve the game.
It does not establish game or GPU compatibility. Packaged startup checks and
Core CPU policy checks are separate from NR/optical-flow GPU and game acceptance.
