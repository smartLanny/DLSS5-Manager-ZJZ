# Security policy

## Supported branch

Security fixes for the current foundation are developed on
`product/xiaofeng-manager-foundation` until the product is moved to its own
repository.

## Reporting

Do not attach proprietary NVIDIA binaries, game files, raw crash dumps or logs
that contain usernames, installation paths, process addresses or account data.
A useful report should include:

- manager version and commit;
- game name and graphics API;
- the copied, text-only diagnostics from the Repair page;
- minimal reproduction steps;
- sanitized excerpts from `nr-before-sr.log` where relevant.

## Design guarantees

The manager refuses unknown `dxgi.dll` conflicts, anti-cheat targets, unsupported
architectures and payload hash mismatches. Installation operations use a
write-ahead transaction and persistent original-file backups. These checks must
not be weakened merely to increase the number of games shown as supported.
