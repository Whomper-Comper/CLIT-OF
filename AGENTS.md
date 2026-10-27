# Agent guidance

This repository is the OpenFront Discord bot. The game and desktop control panel are separate projects; do not assume their code or toolchains are available here.

## Start here

- Inspect the current working tree and preserve unrelated changes. Read [README.md](README.md) and [docs/development.md](docs/development.md); consult [docs/architecture.md](docs/architecture.md) before changing persistence, identity, roles, history, or background workers.
- Use the current repository and `package.json` as the authority for scripts and dependencies. The bot uses TypeScript with ESM/NodeNext and requires Node.js 22.13.0 or newer. Source imports use `.js` extensions; tests import compiled modules from `dist/`.
- Keep `.env`, credentials, identity tokens, runtime databases, backups, and other private files out of changes and output. Use an isolated database and test credentials for experiments.

## Implementation boundaries

- Follow existing command registration, access checks, private reply, validation, session-binding, and error-handling patterns. Update user-facing documentation when behavior changes.
- Preserve identity scope, deletion and unlink cleanup, role-write pacing, durable delivery/retry semantics, and bounded background work. Recheck current permissions and durable state after awaited external calls and immediately before side effects.
- Make schema changes through the existing backed-up initialization and migration paths. Cover preservation of existing data, repeatable initialization, and failure behavior when relevant.
- Keep external requests and runtime side effects out of local tests. The lobby codec is pinned to an upstream revision; see [lobby feed operations](docs/operations.md#lobby-feed-operations) before changing it.

## Verification and operations

- Run `npm run build` before targeted `node --test` runs so tests do not use stale `dist/`. Run `npm test` for changes spanning subsystems or before handing off a completed code change. See [docs/development.md](docs/development.md) for targeted suites and Windows sandbox limitations.
- Test observable behavior and relevant failure, permission, and post-await race paths. For performance changes, prefer operation counts or query plans to machine-dependent timing assertions.
- `npm start`, `npm run dev`, command registration, PM2 commands, and `npm run update` can affect live services. Treat them as deliberate operational actions, not local verification. Do not claim local tests prove a live deployment or external API works.
- Report the checks actually run and any failures or limitations. Do not reset unrelated work or force-push.
