# Development and verification

Read the [architecture](architecture.md) before changing persistence, identity, roles or history. User-facing contracts are documented in [commands](commands.md), [server administration](server-administration.md) and [statistics and history](statistics-and-history.md). Runtime setup, deployment, backups and incident response are in [operations](operations.md). The [README](../README.md) is the entry point.

## Contents

- [Toolchain and local setup](#toolchain-and-local-setup)
- [Every package script](#every-package-script)
- [Verification workflow](#verification-workflow)
- [Test inventory](#test-inventory)
- [Adding or changing a command](#adding-or-changing-a-command)
- [Adding settings or a migration](#adding-settings-or-a-migration)
- [Adding an API field, statistics mode or report](#adding-an-api-field-statistics-mode-or-report)
- [Working with asynchronous state safely](#working-with-asynchronous-state-safely)

## Toolchain and local setup

The package requires Node.js **22.13.0 or newer**. It uses Node's built-in `node:sqlite` `DatabaseSync`; installing a separate SQLite npm driver is unnecessary. `package.json` declares ESM (`"type": "module"`). TypeScript targets ES2022, uses strict checking and `NodeNext` module/module resolution, and emits from `src/` to `dist/`. Source imports use `.js` extensions so compiled imports resolve correctly. Tests are JavaScript ESM `.mjs` files that import the compiled `dist/` modules.

Install locked dependencies from the repository root:

```sh
npm ci
npm run build
```

These commands install dependencies and compile; they do not start the bot. Local interactive use requires a private environment configured as described in [operations](operations.md). Use a separate development Discord application/server and database when deliberately testing live behavior. Keep tokens and identity-token input out of logs, fixtures, screenshots and committed files.

Configuration and the singleton database are initialized during module imports. Set test environment values before importing modules that depend on `config.ts`/`db.ts`; changing `process.env` afterward does not rebuild the exported configuration. Importing `src/index.ts` starts login. Importing command definitions can instantiate the database, including in the command registration tool. Use a dedicated database path for experiments rather than assuming a definition import is side-effect-free.

## Every package script

| Command | Implementation and effect |
| --- | --- |
| `npm run build` | `tsc`; strict compilation into `dist/`; no live Discord/API request |
| `npm start` | `node --no-warnings dist/index.js`; runs the existing compiled bot; does not build first |
| `npm run dev` | `tsx src/index.ts`; starts the source bot; despite the name, it is not configured as a file watcher |
| `npm run register-commands` | `tsx src/deploy-commands.ts`; replaces the application's registered command set from shared definitions |
| `npm run pm2:start` | Starts `ecosystem.config.cjs` through PM2 |
| `npm run pm2:stop` | Stops the PM2 application defined in that file |
| `npm run pm2:restart` | Restarts the PM2 application defined in that file |
| `npm run update` | `bash deploy.sh`; invokes the deployment/update workflow; requires its deployment environment |
| `npm test` | Runs `npm run build` then `node --test test/*.test.mjs` |

Command registration is a live Discord mutation, not a local validation step. To scope a deliberate registration to a development guild, set `GUILD_ID` or pass its ID after `--`:

```sh
npm run register-commands -- YOUR_DEVELOPMENT_GUILD_ID
```

The environment `GUILD_ID` takes precedence over the positional argument; when neither is supplied, registration is global. Registration replaces the selected scope's command list rather than adding one command. Role/member intents and permissions still need to be configured for the running bot. PM2 and Bash availability are deployment prerequisites, not provided by TypeScript compilation. There is no declared lint, formatter, standalone typecheck, test-watch or database-migration package script; `build` is the compiler check and schema initialization is application startup code.

## Verification workflow

The local automated suite builds and runs without logging into Discord or requesting real OpenFront data. Test files set isolated environment values, commonly use in-memory SQLite, stub dotenv loading where needed, and replace API/Discord boundaries with fixtures. Backup/migration tests use temporary on-disk databases where disk behavior matters. These tests check contracts and race conditions; they do not prove a deployed token, intent, channel permission or external endpoint is working.

Use the full suite for changes spanning multiple subsystems:

```sh
npm test
```

For a targeted iteration, build once before invoking the relevant files. Running tests directly against stale `dist/` can produce a misleading result.

```sh
npm run build
node --test test/queue-reliability.test.mjs test/bot.test.mjs
node --test test/history-api.test.mjs test/history-collection.test.mjs test/history-improvements.test.mjs
node --test test/stats-history.test.mjs test/stats-elo.test.mjs test/stats-line-graph.test.mjs
node --test test/access-config.test.mjs test/debug.test.mjs test/interaction-router.test.mjs
node --test test/backups.test.mjs test/schedule-migration.test.mjs
```

Each line is an independently selectable group, not a requirement to repeatedly run all overlapping groups. To narrow further, place the test-runner option before the filename:

```sh
node --test --test-name-pattern="unlink" test/bot.test.mjs
```

After verification, inspect the actual changed files and report which commands ran and their outcome. Documentation-only work can verify paths, links and factual correspondence without claiming a fresh full-suite run. Do not copy historical test totals as proof of present results; parameterized registrations expand at runtime. A successful build is not evidence of a successful bot login or deployment.

## Test inventory

There are **18 test files** under `test/` in the documented source tree. This is a file inventory, not a claimed execution/pass count. Several files generate cases in loops, so the current test runner summary is the authority for executed case counts.

| File | Behaviors protected |
| --- | --- |
| `test/access-config.test.mjs` | Explicit manager/debug roles; owner/admin boundaries; configuration/history menus; pagination and component limits; revisions, permission revocation after awaits, expired/busy sessions and conflicting edits |
| `test/api-reporting.test.mjs` | Coalesced/cloned/expired/fresh caches and generation ordering; response validation; exact profile/building arithmetic; graph alignment; coverage and fresh doctor diagnostics; statistics modes |
| `test/backups.test.mjs` | Consistent WAL-inclusive snapshots; pre-migration contents; per-database rotation; invalid/new/in-memory database handling; process-owned deployment readiness |
| `test/bot.test.mjs` | Command definitions and config validation; clan authorization/setup/removal/pagination; identity ownership and audit scoping; legacy migrations; role union/removal/stale-write checks; pacing, API failures and reply behavior |
| `test/debug.test.mjs` | Explicit debug-role access; scoped exports; no credential leakage; revoked access and unavailable membership; oversized/empty exports; private diagnostic status/toggles and controlled error wording |
| `test/dice.test.mjs` | Dice definition bounds/defaults; inclusive random boundaries; public animation/final result; invalid inputs and animation throttling |
| `test/history-api.test.mjs` | Exact-ID ladder lookup and bounded absence; malformed/forbidden responses; cursor/filter cache isolation; known empty versus missing history; sessions/time bounds/clan schema; deletion feed and UTC normalization |
| `test/history-collection.test.mjs` | Opt-in settings validation; deduplication and coverage; restart checkpoints and failure isolation; bounded rotation; unlink/settings/shutdown races; recorded tags and boundaries; deletion gaps; weekly DST and interrupted-delivery reconciliation |
| `test/history-improvements.test.mjs` | Atomic page rollback both inside/outside caller transactions; indexed cross-guild player deletion queries; captured-clock Elo retention; leaderboard matching avoids unnecessary identity checks |
| `test/history-reports.test.mjs` | Bounded one-day recent-clan scans, deduplication and partial labels; numeric/graph agreement; current-link/historical-tag weekly rankings and incomplete coverage |
| `test/interaction-router.test.mjs` | Interaction event contains expired reply/follow-up failures; acknowledged components preserve their original message; unknown slash commands and deferred errors receive controlled responses |
| `test/player-analytics.test.mjs` | Inclusive period boundaries, future/incomplete games, map normalization and scope separation; duplicate/cursor loops; later API failure, bounded scans and early period-boundary exit |
| `test/player-stats-correctness.test.mjs` | Disjoint profile type/mode buckets; exact recent-window selection; missing bucket/partial totals; building, launch and trade wire slots |
| `test/queue-reliability.test.mjs` | Persisted unlink priority; replacement-job version protection; paced priority preemption; guild fairness; one write per cleanup turn; failure isolation; revocation before grants; restartable progress |
| `test/schedule-migration.test.mjs` | One-time legacy weekly default migration, custom schedule preservation and Monday-noon UTC default boundaries |
| `test/stats-elo.test.mjs` | Cached/in-flight invalidation after deletion/unlink/settings changes; ladder-specific completeness warnings; graph attachment reuse and replacement; removed observations cannot reappear |
| `test/stats-history.test.mjs` | Buildings independence/lifetime labels/exact counters; lazy bounded history pages and filters; session ownership/message binding/busy/expiry; settings races; retry paths, DMs, missing/deleted players and Discord output limits |
| `test/stats-line-graph.test.mjs` | No fabricated chart for no valid points; complete decodable PNGs for parameterized samples; trace changes with observation order |

## Adding or changing a command

1. Put the handler and `SlashCommandBuilder` definition in `src/commands/`, following the shared command shape. Add it to `commands` in `src/commands/index.ts`; runtime routing and registration both consume this list. Avoid a second independently maintained registration definition.
2. Decide whether the action needs a guild, cached guild membership, manager role, explicit debug role or identity ownership. Apply the existing access helper that matches the action. Manage Server is a recovery/bootstrap right for configuration, not a blanket replacement for the clan or debug role.
3. Validate simple input and apply appropriate throttling before expensive work. Defer before slow membership/API work. Use `privateReply` for identity verification, configuration and debug; only use the configurable ordinary reply helper where exposing that command's result is intended. Disable mention parsing on output.
4. Use `CommandError` for expected actionable failures and the centralized error formatter. Keep raw API/database errors and credentials out of replies. Let the outer interaction boundary contain unexpected failures, including failures of the error reply itself.
5. For components, return `false` for unrelated custom IDs so later handlers can receive them. Bind sessions to their owner/context, enforce expiry and busy state, and acknowledge the interaction appropriately. An old menu/button is not proof that its user still has access.
6. If the command mutates links or mappings, use existing transactional database methods and reconciliation queue semantics. Do not write Discord roles directly around the shared pacer, or treat a queued update as already completed.
7. Test the command definition, authorization rejection before side effects, successful visible behavior and any important post-await race. Update [commands](commands.md) and other affected user documentation. Register deliberately in a development guild only when local review is complete.

## Adding settings or a migration

Trace a setting through schema/defaults, interfaces, validation, persistence, revision handling, interactive draft/rendering and consumers. History settings have synthetic defaults until first save; debug and manager roles have independent revision domains. Clan configuration uses a content snapshot rather than a dedicated revision number. Preserve the distinction between editing a mapping and advancing its background sync timestamp.

An additive migration belongs in the backed-up initialization transaction (`db.ts`, or `HistoryStore.initialize` for history). Inspect schema columns before adding fields so opening an existing database is repeatable. Specify insert/copy columns explicitly; older physical column order can differ from a new database. A one-time data transformation needs a durable metadata marker and fixture coverage for both legacy/default and custom values. Never rewrite user customization on every startup.

Add defaults consistently to both the SQL schema and application fallback settings. Define cleanup when disabling or removing a setting, and invalidate in-flight work/sessions when its revision changes. Test stale writes, migration idempotence and preexisting data preservation using temporary databases. Test backup failure behavior when modifying initialization. A backup file's existence is not sufficient proof that it contains committed WAL data or passes integrity checking.

## Adding an API field, statistics mode or report

Update `historyTypes.ts` and runtime validators in `api.ts` together. Keep known absence, empty results, malformed data, HTTP failures and timeouts distinct. Validate bounds and filters before network work; encode IDs and preserve opaque cursors. Include every relevant filter in the cache key, retain cloned results, and preserve freshness generation checks. Use local fixtures for newly observed response shapes; these documents make no assertion that an external API was checked live.

Choose the correct source: lifetime counters, on-demand game history, stored public Team sessions and leaderboard observations answer different questions. Do not add profile recent-window counters together as if they were independent lifetime buckets. Keep large exact values in `bigint`, preserve unavailable versus zero, and count completed results separately from incomplete games. Period/map analytics must retain bounded scan budgets and explain partial samples. Elo observations must remain separate by ladder and must not imply an invented historical curve before the first observation.

For a new history consumer, preserve half-open local storage windows, deduplication keys, source coverage and identity/configuration rechecks after awaits. A successful page write does not establish complete coverage until its window finishes. A deleted player must remain blocked by tombstones; changing tags must invalidate player coverage based on the previous tag set. Refresh/invalidate session graph buffers when the underlying observations change.

Keep Discord limits in mind: long names need escaping/truncation, large lists need pagination, private data must stay within its authorized scope, and graph attachments must be removed when invalidated. Follow existing text bars for exact numeric comparisons and the local PNG renderer for Elo. Test the report's displayed denominator/completeness and attachment contents, not merely helper calls that mirror implementation.

## Working with asynchronous state safely

The bot is single-process, but concurrent promises still create races. Use `MemberLocks` for the appropriate identity/guild/member scope, and check current durable state after slow work and before side effects. `role_jobs.version`, `linked_at`, settings revisions, clan snapshots and deletion tombstones each protect a different state transition; dropping one because another exists weakens the boundary.

Keep persisted jobs restartable and retries bounded in delay/work. Preserve priority when coalescing cleanup, obsolete role IDs when replacing configurations, and progress when processing one role at a time. Route actual role writes through the same lane. The collector has its own request budget so background history does not hold up role cleanup. Inject clocks/API boundaries in focused tests rather than waiting real minutes or using live network calls.

For changes that claim to fix a race, build a fixture that pauses the external request, mutates the identity/settings/access state, resumes it and asserts that no stale storage, role write or publication happens. Also test that unrelated valid work still progresses; rejecting everything is not a correct reconciliation strategy.
