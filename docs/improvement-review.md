# Bot improvements and test review

Reviewed locally on 2026-10-17, against the original checkout at `11807a7`.

Bulk history writes now take about 97% less time in the local benchmark. Configuration and statistics messages have clearer grouping while retaining their information. The changes also prevent partial page writes and stale history from being republished after deletion, unlinking, or settings changes.

## Measured performance

| Workload | Previous algorithm, median | Updated algorithm, median | Improvement |
| --- | ---: | ---: | ---: |
| Save 1,000 clan matches | 2,478.82 ms | 64.75 ms | 38.28x throughput; 97.39% less time |
| Save 1,000 player matches | 2,497.55 ms | 68.55 ms | 36.43x throughput; 97.26% less time |
| Standalone commits for 20 pages of 50 matches | 1,000 | 20 | 98% fewer commits |

These timings measure local database writes, not total bot response time. Discord latency, API latency, production load, and disk configuration were not benchmarked. In particular, transactions supplied by a caller and WAL settings can change the benefit substantially.

Reproduce from the repository root:

```text
npm run build
node tools/benchmark-history.mjs
```

The [benchmark](../tools/benchmark-history.mjs) compares the previous row-at-a-time algorithm with the updated page methods using the same current schema and indexes. This isolates batching; it is not a benchmark of two complete bot versions. Each trial uses a fresh disposable database, identical generated records, SQLite DELETE journaling and FULL synchronization. It checks the final row count and removes its temporary files. It never opens the bot's operational database.

Three rounds alternate execution order. Environment: Node v26.4.0, Windows x64. Raw times in milliseconds:

| Workload | Previous trials | Updated trials |
| --- | --- | --- |
| Clan matches | 3218.31, 2107.97, 2478.82 | 79.27, 57.88, 64.75 |
| Player matches | 2497.55, 2117.37, 2660.87 | 68.55, 61.36, 87.37 |

## Other improvements

| Area | Before | After | Evidence or limit |
| --- | --- | --- | --- |
| Repeated Elo graphs | Regenerated the PNG on each graph render | Reuses the image for unchanged samples on the same ladder; changed or removed samples invalidate it | Attachment reuse and invalidation tests; no end-to-end latency percentage claimed |
| Configuration rendering | Loaded home-screen data on other screens | Moves four home-only database accessor calls into the home branch | Code inspection and tests for unnecessary clan/queue reads; access checks still refresh |
| Leaderboard collection | Scanned page ratings for each linked member and checked identities absent from that page | Groups ratings by exact public ID, then checks current identity only for matching players | Collector test verifies one identity read for two linked players when only one is present |
| History cleanup | Some cross-server deletion and latest-work queries lacked suitable indexes | Adds indexes used by those queries | SQLite query-plan checks; no timed deletion multiplier claimed |
| Failed history writes | A failed page could leave earlier rows saved or corrected | A page succeeds together or rolls back, including inside caller transactions | Four clan/player and nested/standalone rollback cases |
| History privacy | Cached results could outlive an unlink, deletion, or settings change | Revalidates before using cached results and after pending requests; rereads stored Elo | Cached, pending, and failed-request tests |
| Clan configuration changes | Adding a clan could purge unrelated Elo history | Rebuilds filtered match history and its coverage, retaining Elo until an actual identity purge | Addition, removal, recollection, and unlink checked together |
| Interaction errors | Component failures could escape the event handler or overwrite useful content | Contains failures and sends a private follow-up for an already acknowledged component | Router tests include failed error delivery |
| Appearance | Long configuration summaries and densely packed result lines | Groups access, replies, activity, collection, and recap settings; highlights enabled toggles; separates summary lines | Information and Discord limits checked; no live Discord usability study |
| Elo explanation | A connecting line could suggest knowledge of unobserved ratings | Explicitly explains observation gaps and single samples | Existing values and observations retained |

## Test decisions

All 18 test files were reviewed. Most tests protect distinct behavior, especially permission changes during requests, identity deletion, incomplete API responses, and recovery after shutdown. Similar-looking tests at separate boundaries were kept where a failure could affect one path without affecting the other.

Four overlapping standalone tests were removed or combined:

| Removed standalone case | Where its useful protection remains |
| --- | --- |
| Transient cleanup member-fetch retry in `bot.test.mjs` | `queue-reliability.test.mjs`: a failed guild backs off without delaying another guild |
| Partial cleanup at shutdown in `bot.test.mjs` | `queue-reliability.test.mjs`: progress persists and actually finishes after restart |
| Clan filter change preserving Elo in `history-improvements.test.mjs` | `history-collection.test.mjs`: add and remove clan tags, verify rebuilt rows/jobs/coverage, preserve Elo, then purge it on unlink |
| Separate old-legend/building/history graph case in `stats-history.test.mjs` | Initial lifetime building bars in `api-reporting.test.mjs`, Buildings graph switching and lazy history result bars in `stats-history.test.mjs`; obsolete legend wording removed |

Four new tests fill useful gaps: three exercise the real leaderboard parser and rating lookup instead of mocking that boundary, and one proves graph pixels reflect the observations and chronological ordering. The test-audit phase therefore remains at 185 tests: four overlapping cases removed, four useful cases added. The original checkout had 143 tests; the complete improvement work adds 42 net tests. Test count is not a coverage percentage or quality score.

| File | Final tests | Review outcome |
| --- | ---: | --- |
| `access-config.test.mjs` | 24 | Keep independent authorization, stale draft, expiry, validation, and layout-limit paths |
| `api-reporting.test.mjs` | 14 | Keep caching and numerical correctness; select the Team control by meaning, retain positive building bars, remove obsolete copy assertions |
| `backups.test.mjs` | 4 | Strengthen retention to require the newest two snapshots, with deterministic timestamps |
| `bot.test.mjs` | 31 | Remove two overlaps; prove failed validation saves nothing and queued tasks preserve rejection/return values |
| `debug.test.mjs` | 10 | Populate unequal server fixtures so incorrect global counts fail; check export allowlists for both link types |
| `dice.test.mjs` | 5 | Preserve random bounds, acknowledgment, animation timing, result, and rate-limit checks; loosen cosmetic text matching and deduplicate the D1 boundary |
| `history-api.test.mjs` | 12 | Add exact-ID and independent-ladder lookup, cached timestamps, bounded/complete/partial searches, malformed responses, HTTP failures, and retry recovery |
| `history-collection.test.mjs` | 13 | Combine clan reset and Elo preservation checks; retain scheduling, restart, identity, and in-flight safety cases |
| `history-improvements.test.mjs` | 7 | Keep atomicity/index/collector tests; add a just-expired observation beside the retained boundary; consolidate the clan-reset overlap |
| `history-reports.test.mjs` | 3 | Verify actual time windows, filtered match IDs, totals, and graph buckets instead of merely the presence of fields |
| `interaction-router.test.mjs` | 5 | Keep separate component/slash acknowledgment and error-delivery paths |
| `player-analytics.test.mjs` | 6 | Keep period, filters, duplicate/cursor, partial failure, and bounded-search cases |
| `player-stats-correctness.test.mjs` | 4 | Keep scope separation, recent-window selection, and exact raw counters |
| `queue-reliability.test.mjs` | 9 | Keep fairness/restart/replacement-job cases; verify obsolete roles are removed before a failing grant |
| `schedule-migration.test.mjs` | 2 | Require a valid newer eligibility timestamp; keep real default-schedule behavior |
| `stats-elo.test.mjs` | 14 | Keep cached/in-flight invalidation and graph reuse; make mocked IDs agree with the real API contract |
| `stats-history.test.mjs` | 16 | Use actual revisioned database settings and action-based control lookup; combine overlapping graph coverage |
| `stats-line-graph.test.mjs` | 6 | Check PNG structure, checksums, visible data, and observation/order changes without tying tests to exact RGB colors; compare buffers without enormous failure diffs |

## Verification and limits

`npm test` builds TypeScript and runs the entire suite: 185 passed, 0 failed, 0 skipped. Backup and migration checks ran outside the filesystem sandbox because it blocks their temporary SQLite backup renames. No live bot was launched.

Six deliberately broken variants of disposable compiled copies were caught by assertions: accepting expired Elo, retaining obsolete coverage after adding a clan, deleting unrelated Elo when removing a clan, hiding a single graph point, ignoring chronological order, and corrupting PNG checksums. This is a targeted spot-check of test effectiveness, not a full mutation score.

PNG checksum verification uses Node's independent built-in CRC implementation, available since [Node 22.2.0](https://nodejs.org/en/blog/release/v22.2.0), within this project's existing Node 22.13.0 minimum.

Changes remain local. No production deployment, live Discord rendering check, or production-wide speed claim is included.
