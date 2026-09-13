# Contributing

Keep the foundation narrow and auditable.

- Product policy belongs in `src/product/`, not the pinned upstream submodule.
- Do not add an independent game overlay unless it removes a real dependency or
  solves a measured problem that the ReShade overlay cannot solve.
- Do not add an account requirement to local install/settings workflows.
- New install routes must be separate adapters with their own compatibility,
  rollback and tests.
- Never commit NVIDIA runtimes, model payloads, game files or unreviewed native
  binaries.
- User-facing status must distinguish file integrity from verified runtime
  execution.

Before submitting a change:

```powershell
npm run verify:vendor
npm test
```

Changes to installer behavior need tests for install, repair, uninstall,
pre-existing file restoration and failure rollback.
