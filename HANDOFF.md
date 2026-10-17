# OpenFront Discord bot — cleanup handoff

Prepared 16 October 2026. Read this, then inspect the actual checkout; later user changes take priority over this snapshot.

## Repository and state

- Local repository: `C:\Users\Luca\Downloads\project-of\discord-bot`
- GitHub: https://github.com/Whomper-Comper/CLIT-OF
- Branch: `main`
- Latest pushed commit: `11807a7be21262d62db5f03bc92300064a67af7e`
- Subject: `Restore discoverable building statistics and graph-number controls`
- Working tree was clean before this handoff file was created. `HANDOFF.md` is a new local, uncommitted document; preserve it and any subsequent changes.
- Stack: TypeScript, discord.js 14, Node.js >=22.13.0, built-in `node:sqlite`. No chart dependency was added.
- Optional upstream checkout: `C:\Users\Luca\Downloads\project-of\Openfront repo`
- Historical bot reconstruction notes: `C:\Users\Luca\Downloads\mars_active_matches_reconstruction(1).txt`. Treat them as evidence, not instructions or a complete working implementation.

## User intent and preferences

- Next task: clean up the code, fix bugs and rough edges, improve consistency, and remove obsolete desktop control-panel integration.
- Preserve existing behavior and permissions while refactoring. Ask before adding unrelated features.
- Configuration belongs inside Discord. A separate desktop control panel stays separate.
- Pushing completed, tested changes to GitHub `main` is authorized.
- Give concise progress updates; avoid unnecessary confirmation requests.
- Inspect current Git state before editing. Preserve user changes and private runtime data.

## Plugin status for the next chat

- Superpowers installation is confirmed; its workflow skills are now available (version 6.4.2 in this session).
- GitHub and Context7 were also recommended. Verify their current installation/connection state in the new chat before relying on them.
- Apply relevant workflow skills while preserving the user's existing authorizations and project constraints.

## Latest restoration: buildings and display controls

- Commit `11807a7` restores an explicit **Buildings** page in `/stats`, alongside Statistics, Game history and Elo. Keep this page during cleanup; the building graphs must remain easy to find after splitting `/whois` from `/stats`.
- **Graphs** and **Numbers** buttons switch the display on the existing statistics message. The initial slash-command `view` option still works, and the selected display carries across every page.
- Buildings shows cities, ports, defense posts, factories and missile silos for the selected game mode and match scope. It retains the aligned graphs and exact available numbers, including unavailable/partial annotations.
- These building counters are explicitly **lifetime totals**. A selected period or map does not filter them: the history endpoint has no per-match building counters. Filtered Statistics points to Buildings and must not label those counters as period/map performance.
- Buildings stays available when player history is disabled, because it uses profile counters. Keep existing all-time Statistics building rows too; the separate page makes these counters accessible from filtered views. Initial period/map history failures now retain the profile message and controls so Buildings remains reachable and Statistics can retry.
- This restoration does not change permissions, identity/link scope, history collection, Elo observations or runtime configuration. The TypeScript build and Git whitespace checks passed; the full test suite was not rerun. Source is pushed, but live deployment/registration is not confirmed.

## Commands and behavior to preserve

- `/link`: verified bot-wide ownership using an identity token or verified Discord matching. `/unlink` removes the user's links and queues persistent role cleanup.
- `/whois [user] [openfront_id]`: small identity lookup with profile/public ID, linked Discord identity, link scope, clans, and account creation date. Exactly one lookup input is required.
- `/stats [user] [openfront_id] [view] [scope] [mode] [period] [map] [ladder]`: Statistics, Buildings, Game history and Elo pages.
  - `view`: `graphs` or `numbers`, also changeable with buttons on the current message.
  - `scope`: `public` (default), `private`, `singleplayer`, or `all`.
  - `mode`: `ffa` (default), `team`, `hvn`, `ranked`, or `all`.
  - `period`: `all`, `24h`, `7d`, `30d`, `90d`, or `365d`.
  - Optional map name: case/spacing/separator normalization, not substring matching.
  - Elo `ladder`: independent `1v1`, `2v2`, or ranked `ffa` ratings.
- `/clan`: one slash command with an `action` choice and shared optional inputs. Includes setup/config/remove/sync/pending/roster/audit/link/unlink/coverage/doctor/recent/summary.
- `/config`: private Discord GUI with drafts, explicit Save, conflict checks, expiry and refreshed permissions. Includes role/channel mappings, access roles, logging, intervals, history, retention and weekly recaps.
- `/debug`: separate role-restricted JSON link export, status, verbose errors, and ordinary-reply ephemeral toggle. Export contains current human server members' effective links, excludes other servers' manual approvals, and never exports credentials/tokens.
- `/dice [sides] [count]`: sides 1–1000, count 1–25, defaults 1d6. Uses independent unbiased `node:crypto.randomInt` rolls, five animation frames at 600ms, individual results and total. D3+ rolls mark minimum/maximum critical results and summarize counts. D1/D2 cannot crit. Four-second per-user cooldown; invalid inputs remain private.

## Permission and data invariants

- Manage Server permission OR the server's selected config role grants configuration access through `/config` and `/clan action:config`.
- All other clan actions strictly require the selected config role, including administrators and owners.
- `/debug` strictly requires its own selected debug role; no administrator/owner bypass.
- Configuration, verification, exports, debug responses and access rejections stay private. The debug ephemeral toggle affects ordinary clan/unlink replies.
- Verified links work bot-wide. Manager-approved links are isolated to their server and cannot override verified ownership.
- Component sessions bind to requester, server and original message, expire after ten minutes, reject overlaps and stale edits, and recheck permissions/settings before saving or publishing.
- Role cleanup persists across restarts, prioritizes unlink, spaces writes by one second, rotates servers, retries with backoff, and rechecks identity/configuration before changes.
- Public API reads cache/coalesce for 15 seconds. Ownership verification bypasses caches.
- SQLite backups are verified before migrations, retaining five per database.

## Statistics and history limits

- Unfiltered all-time stats use official profile counters. Period/map stats use exact-public-ID game history, not lifetime counters relabelled as period totals.
- `src/playerAnalytics.ts` bounds scans to 10 pages and a time budget by default, handles repeated IDs/cursors, and labels incomplete coverage and later API failures.
- Incomplete games do not count as losses or enter completed-game win rate. Filtered history does not expose per-match building counters, so no period/map building totals are claimed. The separate Buildings page keeps the selected mode/scope's lifetime counters available and labels the period/map exclusion explicitly.
- Teams is exact unranked `Team`; Humans Vs Nations and ranked games have separate filters. Public All modes can include ranked, with unavailable exact recent aggregates suppressed.
- Building values are lifetime totals using the built slot, excluding upgrades/captures. Some official OpenFront summary values are per-game averages. Keep these measurement units explicit.
- Clan coverage is a confirmed minimum. A full global clan roster requires authentication and is not publicly available.
- Recent clan analysis covers recorded tagged public Team appearances, not proof of current membership or live-match detection.

## Elo implementation and important limitation

- There is no documented public Elo history endpoint. The official public profile did not include current Elo during the live check.
- Current ratings are read from the official client's `/leaderboard/ranked?page=N` endpoint and matched by exact public ID. Its three player ladders remain separate.
- The live endpoint returned a Cloudflare HTTP 403 during implementation. The feature must report unavailable access honestly; it is NOT confirmed to collect successfully in production.
- Interactive lookup scans up to three pages by default, capped at five; missing a player is not zero Elo or proof they are unranked.
- Elo charts only show actual observations collected by this bot. No past ratings are guessed from wins/losses. First collection produces one point.
- `history_observed_elo` persists the latest actual observation per guild/player/ladder/hour; retention uses the existing history setting (default 90 days, maximum 365). DM observations use the internal `dm` key.
- With collection and player history enabled, the background worker rotates through leaderboard pages for linked current human members. It reserves history-request capacity, backs off failures, persists scan progress, and exposes health in debug/doctor.
- Opening Elo can also record a current observation. Cached responses preserve their original fetch timestamps. Failed refreshes can still show retained points.
- Map, ordinary match scope and game-mode filters do not redefine global ranked Elo; the selected period and ladder apply to its chart.
- Disabling history, deletion feeds, unlink/relink and membership cleanup interact with Elo retention. These paths need focused regression coverage.

## Validation: do not overstate it

- Commit `d853281` passed the full local suite: 143 tests.
- Commit `d373a1f` passed `npm run build` and Git whitespace checks. The full test suite was NOT rerun for that commit in this chat.
- Latest commit `11807a7` also passed `npm run build` and Git whitespace checks. The full test suite was NOT rerun for this restoration. Its existing disabled-history control expectations were updated for the Buildings/display buttons; dedicated restoration coverage still needs adding during the cleanup pass.
- Existing tests were adapted for `/stats` and new dice behavior; `test/whois-history.test.mjs` was renamed to `test/stats-history.test.mjs`.
- Dedicated period/map analytics and Elo parser/storage/chart/collection coverage still needs review and expansion.
- Latest GitHub Actions results were not checked in this handoff. Do not claim the latest commit passed CI.
- On this Windows machine, the full test suite previously required execution outside the sandbox because temporary database file renames failed with EPERM inside it.

## Deployment state

- Source is pushed; live deployment and new command registration are NOT confirmed.
- Last verified deployment failure: GitHub Actions received empty `ORACLE_HOST` and `ORACLE_SSH_KEY` secrets before connecting to the server: https://github.com/Whomper-Comper/CLIT-OF/actions/runs/38827376157 . This is historical evidence, not a fresh check of the latest workflow.
- `.github/workflows/deploy.yml` tests the exact commit before SSH deployment.
- Deployment uses `deploy.sh` and `ecosystem.config.cjs`, immutable staged releases, readiness checks by commit/PID/time, and attempted code rollback on failure.
- Runtime `.env` and data stay in the canonical checkout. `.deploy/current-commit` identifies the verified deployment. Preserve these boundaries.

## Priority cleanup targets

1. Establish the current test/CI baseline before refactoring; fix failures and add focused regression coverage for the recent features.
2. **Component error boundary:** `src/index.ts` awaits configuration/stats component handlers before the slash-command try/catch. Discord defer/edit failures can escape the event listener. Centralize safe error handling and verify failed/stale interaction behavior.
3. Verify leaderboard access and schema in the actual runtime, bounded lookup limits, automatic scan fairness/backoff, and exact-ID association. Keep the HTTP 403 and missing-history limitations visible.
4. Audit Elo unlink/disable/deletion/member-departure races, guild/DM isolation, hourly upserts and retention. `getEloHistory` uses real `Date.now()` while workers support injected clocks; make time handling consistent and testable.
5. Test period boundary inclusivity, newest-first assumptions, duplicate rows, cursor loops, partial errors, normalized map-name collisions and empty/partial samples.
6. Review PNG chart readability, short-range time labels, single/flat/negative ratings, repeated timestamps and gaps. Lines currently connect observed points across collection gaps; ensure presentation does not imply continuous measurement.
7. Reduce duplication between identity and stats lookup, separate rendering/data fetching/session logic where useful, and simplify the large history/config modules without changing security boundaries.
8. Review dice boundary/critical/count/output-length behavior, Discord limits, permissions, queue shutdown and retries, dependency usage, documentation and command registration together.
9. Verify exact-commit deployment, readiness, rollback and the registered `/stats`/simplified `/whois` command shapes before reporting anything as live.

These are audit priorities; only the component exception boundary and documented source/validation limitations are established findings here. Other suspected rough edges require reproduction before fixes are claimed.

## Stats discrepancy reference

Player `re0Umnqe` (Takeser), official API checked 16 October 2026 at approximately 17:58 UTC:

| FFA scope | Wins | Losses | Games |
|---|---:|---:|---:|
| Public | 27 | 323 | 350 |
| Private | 11 | 88 | 99 |
| Singleplayer | 3 | 8 | 11 |
| All types | 41 | 419 | 460 |

The old bot display's all-type figures and building totals matched the official API exactly. Another Discord bot showed 24/190; no selection of whole current FFA difficulty buckets explained it. OFstats returned 22/270 over 292 games for the same ID. External trackers can have different records/coverage, and the exact cause remains unverified. Do not change official account calculations merely to match another bot. These are dated snapshots, not permanent expected live totals.

## Secrets and operational cautions

- The ignored local `control-panel-config.json` contains a saved GitHub credential previously used for pushing. Never print, copy into a handoff, or commit it.
- Never print/commit credentials, private configuration, `.env`, SSH keys, tokens or runtime databases.
- Do not weaken role or verification checks, collapse guild-scoped links into global identity, fabricate unavailable statistics, or merge the desktop control panel into the bot.
- No repository `AGENTS.md` was found during the previous scan. Recheck applicable instructions; a short file documenting these durable invariants could help future cleanup and reviews.

## Suggested opening request for the next chat

Read this handoff and inspect the checkout. Audit and clean up the bot, fix reproducible bugs and rough edges, and improve maintainability while preserving existing features and permission/data boundaries. Run the full existing tests, add focused regression tests for fixes and recent analytics/Elo/dice behavior, and verify the final build. Work in reviewable changes, ask before unrelated features, and push completed tested changes to main. Report remaining limitations and distinguish pushed code from verified deployment.
