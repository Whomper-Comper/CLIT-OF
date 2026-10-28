# Local agent handoff

This is a portable workflow for any agent working on the OpenFront Discord bot. The checked-in [AGENTS.md](../AGENTS.md) applies both locally and from GitHub. The OpenFront game and desktop control panel have their own checkouts, instructions and toolchains.

## Open the correct project

Start in the assigned repository and inspect its working tree:

```sh
git status --short --branch
git branch --show-current
```

Preserve existing edits, deletions and untracked work. Read the current repository's agent instructions and manifest before using commands from another project or an older chat. Local folder names and installed versions are not prerequisites encoded in this guide.

For this bot, read the [README](../README.md), [development guide](development.md) and [architecture](architecture.md). Use the [community playbook](community-playbook.md) for feature setup and [operations](operations.md) for hosting and recovery.

## Use the bot's toolchain

The current bot requires Node.js 22.13.0 or newer, TypeScript ESM/NodeNext, and Node's built-in SQLite. Check `package.json` and the lockfile before installing dependencies. Source imports use `.js` extensions; tests import compiled modules from `dist/`.

```sh
node --version
npm --version
npm ci
npm run build
```

Install only when needed. Set isolated test environment values before importing runtime modules: configuration and the database singleton initialize during imports. Keep credentials, identity tokens and runtime databases out of output and commits. Importing `src/index.ts` starts a bot login.

## Find the existing implementation

| Area | Start here |
| --- | --- |
| Commands, private controls and reports | `src/commands/`, `src/reporting.ts`, `src/historyReports.ts` |
| Identity, roles and paced reconciliation | `src/db.ts`, `src/roles.ts`, `src/clanSync.ts`, `src/queues.ts` |
| API validation, caches and statistics | `src/api.ts`, `src/playerStats.ts`, `src/playerAnalytics.ts` |
| Stored history, ratings and collection | `src/historyStore.ts`, `src/historyCollector.ts` |
| Events, availability, milestones, bingo and duels | `src/community/` and their command handlers |
| Lobby discovery, filters and delivery | `src/lobby/`; read [lobby feed operations](operations.md#lobby-feed-operations) before changing the pinned codec |

Use `rg` to find callers, existing behavior and tests before changing a contract. Follow existing validation, access checks, private replies, session bindings and error handling.

## Change and verify

Reproduce bugs with isolated fixtures. Preserve identity scope, deletion cleanup, settings revisions and post-await guards. For optimizations, use the existing batched store APIs and bound payload reads at the query; see [efficient database work](development.md#efficient-database-work). Keep transactions synchronous and preserve retry state, ordering and rollback behavior.

Build before a focused test run so it uses current compiled code. Select suites for the changed behavior; for example:

```sh
npm run build
node --test test/history-improvements.test.mjs test/history-collection.test.mjs
node --test test/event-list.test.mjs test/event-interactions.test.mjs
```

Before handing off a completed code change, run the full suite and inspect the diff:

```sh
npm test
git diff --check
```

The tests use isolated credentials and databases, without logging into Discord or requesting live OpenFront data. Windows backup tests may require the filesystem access described in the [development guide](development.md#verification-workflow); report failures and rerun the unchanged checks with appropriate access rather than weakening backup behavior. Documentation-only changes can check references and factual consistency without claiming a new code test run.

`npm start`, `npm run dev`, command registration, PM2 and deployment commands can affect live services. Run them only as deliberate operational work. A successful local suite does not certify deployment or upstream availability.

## Publish and hand off

Inspect the current diff and stage the intended files explicitly. Include current documentation and shared agent guidance when relevant. Publish portable instructions rather than host-specific paths or stale descriptions of another working tree. Keep unrelated work and private files out of the commit.

When commit/push is authorized, preserve that authorization and use the appropriate existing branch. Do not force-push or reset unrelated changes. Report what changed, the checks actually run, the commit, and whether the push succeeded. Keep local tests, GitHub publication and live deployment distinct.

## If the task belongs to the game or control panel

Open that project's checkout first and read its own agent guidance, README, contribution instructions and `package.json`. Derive installation, test and build commands from that repository; the bot's Node minimum and scripts do not define another project's requirements.

For game work, locate the current UI, server, engine, shared contracts and configuration schemas before editing. Preserve deterministic simulation using the project's seeded randomness and deterministic math; follow its engine-test and localization instructions. Do not infer that the bot repository contains the game's packages, the hosted authentication/statistics API, or the desktop control panel. Existing deletions or missing assets in another checkout require investigation, not restoration merely to make a check pass.
