# Development and verification

Read the [architecture](architecture.md) before changing persistence, identity, roles or history. User-facing contracts are documented in [commands](commands.md), [server administration](server-administration.md) and [statistics and history](statistics-and-history.md). Runtime setup, deployment, backups and incident response are in [operations](operations.md). The [README](../README.md) is the entry point.

## Contents

- [Toolchain and local setup](#toolchain-and-local-setup)
- [Every package script](#every-package-script)
- [Verification workflow](#verification-workflow)
- [Test inventory](#test-inventory)
- [Adding or changing a command](#adding-or-changing-a-command)
- [Adding settings or a migration](#adding-settings-or-a-migration)
- [Efficient database work](#efficient-database-work)
- [Adding an API field, statistics mode or report](#adding-an-api-field-statistics-mode-or-report)
- [Working with asynchronous state safely](#working-with-asynchronous-state-safely)

## Toolchain and local setup

The [Oracle ARM runbook](oracle-arm.md) explains the ANT compatibility gate, existing Node fallback and offline CPU/RSS workload. `node tools/check-runtime.mjs` makes no external requests and imports no bot configuration. `.github/workflows/verify.yml` runs isolated Node verification on Linux x64 and ARM64 without deployment credentials for pull requests, manual dispatch and pushes to main or feature branches.

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
node --test test/role-enqueue-batch.test.mjs test/history-maintenance-indexes.test.mjs
node --test test/api-admission.test.mjs test/session-expiry.test.mjs test/session-handlers.test.mjs
node --test test/history-api.test.mjs test/history-collection.test.mjs test/history-improvements.test.mjs
node --test test/stats-history.test.mjs test/stats-elo.test.mjs test/stats-line-graph.test.mjs
node --test test/stats-line-graph-efficiency.test.mjs test/lobby-query-index.test.mjs test/lobby-feed-counts.test.mjs
node --test test/access-config.test.mjs test/debug.test.mjs test/interaction-router.test.mjs
node --test test/backups.test.mjs test/schedule-migration.test.mjs
```

Each line is an independently selectable group, not a requirement to repeatedly run all overlapping groups. To narrow further, place the test-runner option before the filename:

```sh
node --test --test-name-pattern="unlink" test/bot.test.mjs
```

After verification, inspect the actual changed files and report which commands ran and their outcome. Documentation-only work can verify paths, links and factual correspondence without claiming a fresh full-suite run. Do not copy historical test totals as proof of present results; parameterized registrations expand at runtime. A successful build is not evidence of a successful bot login or deployment.

## Test inventory

The suites below cover foundation, community and lobby behavior. Cross-cutting command, runtime and clan-batch checks are included alongside them. This is a file inventory, not a claimed execution/pass count. Several files generate cases in loops, so the current test runner summary is the authority for executed case counts.

| File | Behaviors protected |
| --- | --- |
| `test/runtime-compatibility.test.mjs` | Isolated runtime preflight without bot configuration, disk database paths, credentials or external services; real CLI rejects a SQLite implementation missing ordered statement iteration |
| `test/command-actions.test.mjs` | Seven flat action-choice schemas, required/irrelevant action inputs, zero/false values, permissions and legacy registered-subcommand compatibility |
| `test/clan-sync-batch.test.mjs` | Shared initial rosters, profile cache/expiry, overlapping clan locks, per-clan timestamps/final membership checks, clone-returning role writes and real targeted command page/tag scopes with authoritative refresh/failure behavior |
| `test/access-config.test.mjs` | Explicit manager/debug roles; owner/admin boundaries; configuration/history menus; pagination and component limits; revisions, permission revocation after awaits, expired/busy sessions, conflicting edits, final report guards and batched affected-member selection for Save/removal |
| `test/api-reporting.test.mjs` | Coalesced/cloned/expired/fresh caches and generation ordering; response validation; exact profile/building arithmetic; graph alignment; coverage and fresh doctor diagnostics; statistics modes |
| `test/api-admission.test.mjs` | Eight-active/64-waiting burst bounds; FIFO/exact queue deadlines; body/error cancellation and release; token-audience grouping; fresh generation cleanup; per-caller mutation isolation and maximum deletion-feed clone count |
| `test/session-expiry.test.mjs`, `test/session-handlers.test.mjs` | Idle release without interaction; ten-minute boundaries, caps, clock jumps, timer cancellation/unref; real statistics/configuration/community handlers, retained heavy analytics and post-await revocation |
| `test/backups.test.mjs` | Consistent WAL-inclusive snapshots; pre-migration contents; per-database rotation; invalid/new/in-memory database handling; process-owned deployment readiness |
| `test/bot.test.mjs` | Command definitions and config validation; pure role-helper imports; clan authorization/setup/removal/pagination and batched affected-member selection; identity ownership and audit scoping; legacy migrations; role union/removal/stale-write checks; pacing, API failures and reply behavior |
| `test/clan-sync-cross-config.test.mjs` | Cross-clan configuration changes and same-account re-verification invalidate stale role updates |
| `test/clan-sync-log-race.test.mjs` | Role-change logs do not publish stale destinations or identities after a write |
| `test/clan-sync-mismatch-race.test.mjs` | Pending-invite summaries recheck identities, membership and approval roles before publication |
| `test/clan-sync-schedule-race.test.mjs` | An empty sync cannot mark an edited clan mapping as already synchronized |
| `test/clan-report-race.test.mjs` | Pending/roster/coverage/doctor authorization and mapping races; protected approval versus surplus rank warnings; final coverage membership, identity changes, newly linked members, refresh failures and rendering/authorization handoffs |
| `test/debug.test.mjs` | Explicit debug-role access; scoped exports; no credential leakage; revoked access and unavailable membership; oversized/empty exports; private diagnostic status/toggles and controlled error wording |
| `test/dice.test.mjs` | Dice definition bounds/defaults; inclusive random boundaries; public animation/final result; invalid inputs and animation throttling |
| `test/history-api.test.mjs` | Exact-ID ladder lookup and bounded absence; malformed/forbidden responses; cursor/filter cache isolation; known empty versus missing history; sessions/time bounds/clan schema; deletion feed and UTC normalization |
| `test/history-collection.test.mjs` | Opt-in settings; deduplication/coverage; batched job inventory counts/plans, preserved checkpoints/backoff, replacement/deletion/scope/rollback; bounded rotation; unlink/settings/shutdown races; deletion gaps; weekly DST and delivery reconciliation |
| `test/history-improvements.test.mjs` | Atomic page and rating batches; indexed account/identity cleanup; repeatable index migration; streamed batched coverage; captured-clock Elo retention, latest-hour association rules and tombstones; leaderboard identity filtering and batch counts; one-query settings listing |
| `test/history-maintenance-indexes.test.mjs` | Covering retained-member inventories, selective coverage/due ranges, identical pruning/retention/fairness results, repeatable initialization, preservation and migration rollback |
| `test/history-reports.test.mjs` | Bounded one-day recent-clan scans, deduplication and partial labels; numeric/graph agreement; current-link/historical-tag weekly rankings and incomplete coverage; batched recap coverage and reuse of clan payloads |
| `test/identity-lookup-race.test.mjs` | Whois and statistics reject changed identity bindings after profile/analytics requests and during later controls, while standalone public-ID lookups remain available |
| `test/interaction-router.test.mjs` | Interaction event contains expired reply/follow-up failures; acknowledged components preserve their original message; unknown slash commands and deferred errors receive controlled responses |
| `test/player-analytics.test.mjs` | Inclusive period boundaries, future/incomplete games, map normalization and scope separation; duplicate/cursor loops; later API failure, bounded scans and early period-boundary exit |
| `test/player-stats-correctness.test.mjs` | Disjoint profile type/mode buckets; exact recent-window selection; missing bucket/partial totals; building, launch and trade wire slots |
| `test/queue-reliability.test.mjs` | Persisted unlink priority; replacement-job version protection; paced priority preemption; guild fairness; one write per cleanup turn; failure isolation; revocation before grants; restartable progress |
| `test/role-enqueue-batch.test.mjs` | Constant mapping/preparation work on large config rosters; obsolete-role retention, per-member/guild isolation, duplicate order, priority/created-at/version behavior, retries, empty rosters and atomic failure rollback |
| `test/schedule-migration.test.mjs` | One-time legacy weekly default migration, custom schedule preservation and Monday-noon UTC default boundaries |
| `test/stats-elo.test.mjs` | Cached/in-flight invalidation after deletion/unlink/settings changes; ladder-specific completeness warnings; graph attachment reuse and replacement; removed observations cannot reappear |
| `test/stats-history.test.mjs` | Buildings independence/lifetime labels/exact counters; lazy bounded history pages and filters; session ownership/message binding/busy/expiry; settings races; retry paths, DMs, missing/deleted players and Discord output limits |
| `test/stats-line-graph.test.mjs` | No fabricated chart for no valid points; complete decodable PNGs for parameterized samples; trace changes with observation order |
| `test/stats-line-graph-efficiency.test.mjs` | Decoded-pixel equivalence to the prior renderer, spikes/duplicates/rounding boundaries and reduced dense-chart raster writes with unchanged observations |
| `test/lobby-query-index.test.mjs` | Bounded ordered due-candidate selection under large mixed backlogs; four recovery statuses, exact cutoff/ties, legacy index upgrade, repeat initialization, custom-index preservation and rollback |
| `test/lobby-feed-counts.test.mjs` | Owned count-state/index reuse; defensive old/new snapshots and point copies; partial/zero/duplicate/unknown counts, source/replacement/freshness/invalidation, and post-await capacity/rule rechecks |

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

## Efficient database work

Reuse the store APIs that batch a shared scope: `HistoryStore.ensureJobs` preserves unchanged job checkpoints and retry state, `recordEloBatch` shares one observation timestamp per guild, and `getCoverageBySubject` streams coverage for a requested inventory. Job pruning remains separate from ensuring supplied bindings. Keep identity replacement, deleted-account suppression, duplicate-input order and partial-failure rollback intact when changing these paths. Savepoints compose with caller-owned transactions and must finish before an awaited external call.

An effective-link inventory includes bot-wide verified users as well as eligible server-only links. Intersect it with freshly fetched human membership for human reports, or the appropriate current roster for reconciliation. Do not assume every returned identity belongs to the current server or reuse an eligibility snapshot across an await without checking the original binding and current state again.

For lists, select bounded payload rows in SQLite and decode only the displayed page. Count or project scalar fields separately when needed, keeping the same ordering, cap, guild scope and draft filtering. Preserve request/send limits and durable fairness when reducing repeated work in a background task. Pure helpers such as `roles.ts` should use type-only imports for database contracts rather than importing the runtime singleton.

Prove a performance change with real operation counts or query plans alongside observable results, boundaries and failure/race coverage. The [architecture evidence](architecture.md#local-performance-evidence) records the existing fixtures and their limits; a smaller query count alone does not prove correct identity scope or bounded payload processing. Update the test inventory when adding or removing a suite, and use the current runner output for pass counts.

## Adding an API field, statistics mode or report

Update `historyTypes.ts` and runtime validators in `api.ts` together. Keep known absence, empty results, malformed data, HTTP failures and timeouts distinct. Validate bounds and filters before network work; encode IDs and preserve opaque cursors. Include every relevant filter in the cache key, retain cloned results, and preserve freshness generation checks. Use local fixtures for newly observed response shapes; these documents make no assertion that an external API was checked live.

Choose the correct source: lifetime counters, on-demand game history, stored public Team sessions and leaderboard observations answer different questions. Do not add profile recent-window counters together as if they were independent lifetime buckets. Keep large exact values in `bigint`, preserve unavailable versus zero, and count completed results separately from incomplete games. Period/map analytics must retain bounded scan budgets and explain partial samples. Elo observations must remain separate by ladder and must not imply an invented historical curve before the first observation.

For a new history consumer, preserve half-open local storage windows, deduplication keys, source coverage and identity/configuration rechecks after awaits. A successful page write does not establish complete coverage until its window finishes. A deleted player must remain blocked by tombstones; changing tags must invalidate player coverage based on the previous tag set. Refresh/invalidate session graph buffers when the underlying observations change.

Keep Discord limits in mind: long names need escaping/truncation, large lists need pagination, private data must stay within its authorized scope, and graph attachments must be removed when invalidated. Follow existing text bars for exact numeric comparisons and the local PNG renderer for Elo. Test the report's displayed denominator/completeness and attachment contents, not merely helper calls that mirror implementation.

## Working with asynchronous state safely

The bot is single-process, but concurrent promises still create races. Use `MemberLocks` for the appropriate identity/guild/member scope, and check current durable state after slow work and before side effects. `role_jobs.version`, `linked_at`, settings revisions, clan snapshots and deletion tombstones each protect a different state transition; dropping one because another exists weakens the boundary.

Keep persisted jobs restartable and retries bounded in delay/work. Preserve priority when coalescing cleanup, obsolete role IDs when replacing configurations, and progress when processing one role at a time. Route actual role writes through the same lane. The collector has its own request budget so background history does not hold up role cleanup. Inject clocks/API boundaries in focused tests rather than waiting real minutes or using live network calls.

For changes that claim to fix a race, build a fixture that pauses the external request, mutates the identity/settings/access state, resumes it and asserts that no stale storage, role write or publication happens. Also test that unrelated valid work still progresses; rejecting everything is not a correct reconciliation strategy.

## Community regression inventory and performance evidence

Build before focused runs. The final integration group is:

```sh
npm run build
node --test test/interaction-router.test.mjs test/bot.test.mjs test/community-integration.test.mjs
```

Choose affected feature suites while iterating; run `npm test` once when ready for the final full check. On restricted Windows executors, SQLite migration backup renames can fail with EPERM. Run the unchanged full suite with authorized filesystem access; do not skip backup tests, weaken snapshots or change production paths to hide the restriction. Expected injected worker/role warnings are captured and asserted, and the timezone measurement is asserted without printing benchmark JSON. Unexpected diagnostics remain visible.

| File | Behaviors protected |
| --- | --- |
| `test/community-core.test.mjs` | Shared schema/savepoints, settings revisions, leases/retries, sessions, identity and cleanup callbacks, retention |
| `test/community-access.test.mjs` | Fresh mapped officer/config authorization and saved interaction binding |
| `test/community-delivery.test.mjs` | Eight requests/four sends, fairness, non-overlap/stop-drain, markers/nonces, ambiguous send recovery, final-delivery hook, lease/target/stop guards and serialized text budgets |
| `test/community-import.test.mjs` | Domain imports avoid runtime singleton/schema side effects |
| `test/community-time.test.mjs` | Gaps/folds/overnight/half-hour DST, full-duration overlap, distinct attendees, per-zone reuse under cache churn |
| `test/availability.test.mjs` | Private recurring schedules, revisions/clear, fourteen-window pagination, public count-only suggestions and bounded evidence |
| `test/events.test.mjs` | Atomic last-seat/squad/reserve behavior, revisions, membership promotion and indexed participant-page query plans |
| `test/event-interactions.test.mjs` | Private drafts/moves, canonical public controls, ownership/permission races, serialization and opt-in choices |
| `test/event-list.test.mjs` | Ten-row published event pages, private replies, deterministic ordering, draft/guild isolation, 100-event cap, partial/empty/invalid pages and bounded payload reads/decoding |
| `test/event-delivery.test.mjs` | Durable publication/reminders, current opted-in membership, missed deadlines, cancellation/recovery and bounded cleanup |
| `test/onboarding.test.mjs` | Approved-to-join versus actual membership, unknown evidence, signup versus attendance, async identity/role/enrollment checks and bounded ten-person queue |
| `test/wheel.test.mjs` | Complete valid packages, supported catalog, random bounds, private explicit save/removal, copied event settings and safe output |
| `test/milestones.test.mjs` | Exact huge counters, thresholds/baselines/crossings, partial data, revisions, cleanup and deduplicated awards; unchanged inventory query counts, identity generations, preserved backoff, duplicate ordering and rollback |
| `test/milestone-interactions.test.mjs` | Private view/settings/thresholds/destination and deliberate retry, stale identity/access/session checks and exact-value output limits |
| `test/milestone-delivery.test.mjs` | Globally paced/fair profiles, shared raw proof and budgets, deletion gate, disable/stop/reconciliation, one-query settings list |
| `test/bingo.test.mjs` | Frozen objectives, free center/lines, unique evidence, current progress/correction, notification namespace and atomic generation creation |
| `test/bingo-evidence.test.mjs` | Retained canonical post-board games/availability, cleanup/privacy, indexed pages, bounded dirty refresh/staging/finalization, maintained aggregates and zero game reads while disabled/unavailable with full recovery scans |
| `test/bingo-interactions.test.mjs` | Private draft/reset/claims/review, revisions/permissions, pending state, public serialization and recovery controls |
| `test/bingo-worker.test.mjs` | Actual staged worker, fresh inventory masking/mixed-line deferral, membership outages, shared recovery budgets and stopped continuation disposal |
| `test/duels.test.mjs` | Consent/state/cooldowns/slots, cryptographic draw ownership, saved ties/results, expiry, restart, cleanup and indexed bounded retention |
| `test/duel-interactions.test.mjs` | Canonical consent/bindings, activation cadence/deadlines, enabling failures, shared final hook, expiry/departure lease/timeout marker recovery and no fresh closed publication |
| `test/community-integration.test.mjs` | Actual runtime signup/checklist/availability evidence, deletion across guilds/account isolation, milestone disable, maximum cards/lists and indexed mixed-history diagnostics with real private pagination |
| `test/final-review-regressions.test.mjs` | Event final-roster permission/session guards, availability draft validation, event list cap, cooldown expiry-scan counts/exact boundaries/clock changes/atomic capacity, milestone cooldown and in-flight sharing |

`test/bot.test.mjs` also asserts exactly 16 unique commands, the unchanged `sides`/`count` dice interface and all seven community Guild contexts. `test/interaction-router.test.mjs` exercises the actual central dispatcher and InteractionCreate listener across every community public/private prefix, malformed/forged bindings, valid bingo/milestones/duel controls and legacy fallthrough. Its real Discord interaction objects also exercise config channel select/change/clear/Save and injected acknowledgement/redraw failures. `access-config` verifies staged redraw failures, committed-write recovery and repeated saves with legacy column ordering. The fixture substitutes only Discord/API boundaries; state transitions and query plans use real SQLite.

Retain count/plan evidence for optimizations rather than adding wall-clock thresholds. Committed [architecture measurements](architecture.md#local-performance-evidence) preserve earlier local observations: availability Intl calls 93,810 → 46,905 for 129 zones/258 members (1.2649s → 0.5511s representative); event participant rows 10,001 → 20 + two aggregate rows; 1,000 settings queries 1,001 → 1 (12-iteration median 8.9947ms → 1.7075ms, p95 30.0878ms → 2.4469ms). The final diagnostics fixture seeds 12,000 mixed rows, returns 11 instead of 10,000 guild rows, and proves indexed order without a temporary sort. Later-page OFFSET cost is proportional to preceding matching diagnostics.

Bingo's measured production source pages are 200/200/51/1 for 451 games plus availability, with one game parse each and zero history payload reads/game parses/evidence-row loads during finalization. Keep this distinct from the synchronous compatibility replacement's proportional canonical reads and the older clean-refresh-only zero-read test. Cleanup/dirty refresh are bounded at 200. One-off timing scripts and scratch handoffs remain local; assertions protect correctness and operation bounds without claiming a machine-independent duration.

## Lobby alert verification

The lobby suites add behavioral coverage for source fixtures/full/count frames, filter combinations, reconnection, durable rules/deduplication, exact 180-second boundaries, DM success, blocked-DM fallback/guidance, fresh channel visibility, ambiguous/interrupted sends, retry of unsent candidates, lookup races, stop/drain and private command/button bindings. Matching, candidate rotation, joined validation, guarded send activation and bounded notification decoding tests constrain database operations; retention tests check indexed and fair bounded cleanup. The actual central router suite exercises continuation from a DM. Build before focused tests:

```sh
npm run build
node --test test/lobby-*.test.mjs test/interaction-router.test.mjs
```

`tools/vendor-lobby-codec.mjs` regenerates the checked-in standalone codec from a pinned upstream revision and encodes synthetic fixture messages with that same generated codec. The fixture tests check decoding those saved messages, but do not independently verify compatibility with an upstream encoder or live feed. Regeneration is a deliberate maintenance operation requiring network access; ordinary builds/tests work offline and need no neighboring game checkout. Verify build compatibility before changing the supported SHA. The registry now has 16 unique commands.
