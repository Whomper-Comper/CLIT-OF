# Agent guidance

This repository is the OpenFront Discord bot. The game and desktop control panel are separate projects; do not assume their code or toolchains are available here.

This checked-in guidance applies to any AI agent working locally or from GitHub. The [local agent handoff](docs/local-agent-guide.md) provides a portable workflow; use the current checkout as the authority.

## Start here

- Inspect the current working tree and preserve unrelated changes. Read [README.md](README.md) and [docs/development.md](docs/development.md); consult [docs/architecture.md](docs/architecture.md) before changing persistence, identity, roles, history, or background workers.
- Use the current repository and `package.json` as the authority for scripts and dependencies. The bot uses TypeScript with ESM/NodeNext and requires Node.js 22.13.0 or newer. Source imports use `.js` extensions; tests import compiled modules from `dist/`.
- Hosting target: Oracle Linux 9 ARM64 with 6 GB RAM by default. ANT is a candidate subject to `ant tools/check-runtime.mjs`; ANT 16.5 failed `node:sqlite` resolution in the verified Windows probe. The user authorized the existing Node fallback when required APIs are unavailable. See [Oracle ARM hosting](docs/oracle-arm.md); do not silently replace the SQLite API or assume startup benchmarks prove bot throughput.
- Keep `.env`, credentials, identity tokens, runtime databases, backups, and other private files out of changes and output. Use an isolated database and test credentials for experiments.

## Implementation boundaries

- Follow existing command registration, access checks, private reply, validation, session-binding, and error-handling patterns. Update user-facing documentation when behavior changes.
- Multi-action command families use a required `action` choice, with legacy subcommand parsing for registration transition. Keep per-action required/irrelevant input checks null-safe (`0` and `false` can be valid). Global and guild registrations are separate live actions.
- Preserve identity scope, deletion and unlink cleanup, role-write pacing, durable delivery/retry semantics, and bounded background work. Recheck current permissions and durable state after awaited external calls and immediately before side effects.
- Discord's single-role writes return updated member clones; do not assume the input role cache changed. Multi-clan and targeted sync sequences force-refresh just that member after a real write before the next clan, retaining live binding/config guards. A failed refresh must remain an error for later clans rather than advancing their successful-sync timestamps.
- Keep transactions and composable savepoints synchronous; never hold one across an awaited external request. Batch work through existing store APIs while preserving identity/tombstone/revision checks, checkpoints, retry state, duplicate-input ordering, and rollback behavior.
- Bound list payload reads and decoding in the database query, preserving ordering, caps, draft filtering, and guild scope. Intersect effective-link inventories with fresh server membership; bot-wide links can belong to people outside the current server. See [efficient database work](docs/development.md#efficient-database-work).
- Make schema changes through the existing backed-up initialization and migration paths. Cover preservation of existing data, repeatable initialization, and failure behavior when relevant.
- Keep clan configuration snapshots in explicit field order: legacy migrations append columns, so database row property order can differ from a new draft. A successful persistent Save must retain its new snapshot/revision even if Discord redraw fails; unsaved changes publish only after a successful redraw.
- Keep external requests and runtime side effects out of local tests. The lobby codec is pinned to an upstream revision; see [lobby feed operations](docs/operations.md#lobby-feed-operations) before changing it.

## Verification and operations

- Run `npm run build` before targeted `node --test` runs so tests do not use stale `dist/`. Run `npm test` for changes spanning subsystems or before handing off a completed code change. See [docs/development.md](docs/development.md) for targeted suites and Windows sandbox limitations.
- Test observable behavior and relevant failure, permission, and post-await race paths. Pair operation counts or query plans with those behavioral checks for performance changes; avoid machine-dependent timing assertions.
- `npm start`, `npm run dev`, command registration, PM2 commands, and `npm run update` can affect live services. Treat them as deliberate operational actions, not local verification. Do not claim local tests prove a live deployment or external API works.
- Report the checks actually run and any failures or limitations. Do not reset unrelated work or force-push.
- `node tools/check-runtime.mjs` is a credential-free local capability probe, including the SQLite iterator required by history readers; `node --expose-gc tools/benchmark-bot.mjs` measures an offline in-memory weekly workload after build. Linux x64/ARM64 verification on main/feature pushes is separate from deployment. Report runtime/architecture with measurements; do not equate Windows results with Oracle ARM performance.
- Before publishing, review the exact staged diff and include updated shared guidance and documentation. Keep published handoffs portable; exclude machine-specific paths, credentials, runtime data, and unrelated local work. Report the committed revision and whether its push succeeded.
