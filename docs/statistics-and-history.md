# Statistics, match history, Elo, and weekly recaps

This guide explains what the bot's numbers measure, where they come from, and how to interpret incomplete results. For exact slash-command inputs, see the [command reference](commands.md). For enabling features in a server, see [server administration](server-administration.md).

## Contents

- [Choose the right source](#choose-the-right-source)
- [Open and navigate player statistics](#open-and-navigate-player-statistics)
- [Scopes, modes, periods, and maps](#scopes-modes-periods-and-maps)
- [Lifetime statistics and buildings](#lifetime-statistics-and-buildings)
- [Milestone counters and baselines](#milestone-counters-and-baselines)
- [Filtered match statistics](#filtered-match-statistics)
- [Game history browsing](#game-history-browsing)
- [Observed ranked Elo](#observed-ranked-elo)
- [Recent clan analysis](#recent-clan-analysis)
- [Automatic collection](#automatic-collection)
- [Weekly recap setup and calculations](#weekly-recap-setup-and-calculations)
- [Retention, deletion, and stale sessions](#retention-deletion-and-stale-sessions)
- [Common questions](#common-questions)
- [Source references](#source-references)

## Choose the right source

The bot has several data paths. Their counts can legitimately differ.

| View | Data source | Meaning | Main limit |
|---|---|---|---|
| `/whois` | Live public profile plus the applicable stored link | Identity, clans, and profile metadata | Does not establish a complete clan roster |
| `/stats`, all time, no map | Public profile's statistics tree | Lifetime counters for the chosen mode and scope | Fields may be missing or partial |
| `/stats`, a recent period or map | Public player game history for the exact account ID | Results in the fetched, matching sample | Bounded pages/time and upstream history availability |
| `/stats` Buildings | Profile statistics tree | Lifetime building totals for the chosen mode and scope | Period and map do not filter buildings |
| `/stats` Game history | Public player games | Recorded matches, dates, modes, maps, and results | Browse limits or the filtered analytics sample |
| `/stats` Elo | Public ranked leaderboard plus stored observations | Ratings observed by this bot, separately by ladder | No reconstruction before observations began |
| `/clan action:recent` | Public clan sessions | Tagged public Team appearances during the requested window | Bounded requests/time; tags do not prove present membership |
| `/clan action:summary` and scheduled recap | Locally collected clan/player sessions | A previous completed local week's recorded activity | Depends on collection coverage and current eligible links |

Match results, profile counters, and Elo observations are different measurements. For example, an account can have a large lifetime game count while this bot holds only a few recent sessions and one Elo point.

## Open and navigate player statistics

Provide exactly one lookup input:

```text
/stats user:@Alice
/stats openfront_id:PLAYER_ID
```

`PLAYER_ID` is a placeholder for a real OpenFront public ID. You may also use a supported profile URL. A Discord lookup needs a stored link available in the current context; a direct public account lookup does not require you to own that account.

The initial selection is **Graphs**, **Public**, **Free For All**, **All time**, and Elo ladder **1v1**, with no map filter.

The message has four pages:

1. **Statistics**: lifetime profile totals, or results calculated from history when a period/map is selected.
2. **Buildings**: lifetime cities, ports, defense posts, factories, and missile silos.
3. **Game history**: individual recorded games, with Previous/Next controls.
4. **Elo**: dated observations for the selected ranked ladder.

The mode buttons switch between Free For All, Teams, Humans Vs Nations, Ranked, and All modes. **Graphs** and **Numbers** change the existing message and carry across pages. Elo has separate **1v1**, **2v2**, and **Ranked FFA** buttons; mode buttons are disabled on that page.

Scope, period, and map are chosen in the slash command. Rerun `/stats` to change them. Only the person who opened a message can use its controls, and controls expire ten minutes after opening. Restarting the bot also loses these in-memory sessions.

When server player history is disabled, lifetime Statistics and Buildings remain available; Game history and Elo controls are hidden, and commands requesting a period or map are rejected.

## Scopes, modes, periods, and maps

### Scope

| Input | Includes |
|---|---|
| `scope:public` | Public matches; default |
| `scope:private` | Private matches |
| `scope:singleplayer` | Singleplayer matches |
| `scope:all` | All three match types for the selected mode |

An unavailable scope/mode combination is not automatically zero. In particular, ranked profile counters are included only for Public or All scope, rather than being relabelled as private or singleplayer ratings/results.

### Mode

| Input | Meaning |
|---|---|
| `mode:ffa` | Unranked Free For All; default |
| `mode:team` | Exactly unranked Team |
| `mode:hvn` | Unranked Humans Vs Nations |
| `mode:ranked` | Ranked games |
| `mode:all` | All modes; eligible public/all lifetime totals also include ranked |

Teams is not a catch-all for every team-based variant. When comparing another report, check whether that report combines Team, Humans Vs Nations, and ranked games.

### Period

Supported periods are `all`, `24h`, `7d`, `30d`, `90d`, and `365d`. Recent periods are rolling UTC durations ending at the statistics session's captured time. A seven-day player selection means the preceding seven 24-hour periods; it is different from the completed local calendar week used by recaps.

`period:all` without a map uses profile counters. `period:all map:World` still uses recorded history because a map is selected. All time in that history context means all available records reached within the scan budget, not an unlimited lifetime archive.

### Map

Map matching compares complete normalized names. The implementation normalizes Unicode, ignores case, and removes spaces and separators. `World`, `WORLD`, and `world` therefore match the same normalized name. A short fragment is not a substring search.

The map input allows up to 100 characters on one line and must contain a meaningful name after normalization.

```text
/stats user:@Alice mode:team scope:public period:7d view:numbers
/stats openfront_id:PLAYER_ID mode:ffa period:30d map:World
/stats openfront_id:PLAYER_ID mode:all scope:all
```

## Lifetime statistics and buildings

Lifetime summaries aggregate disjoint profile buckets by match type, mode, and difficulty. The bot does not recursively sum every object: recent aggregates can overlap lifetime totals. It uses integer arithmetic for large counters to avoid losing precision above JavaScript's ordinary safe integer range.

The main lifetime win rate is:

```text
wins / profile total games × 100
```

The profile's total counter is used directly. The bot does not force it to equal wins plus losses. A zero denominator displays an em dash.

### Building totals

The dedicated Buildings page shows:

- Cities.
- Ports.
- Defense posts.
- Factories.
- Missile silos.

These are **built totals**, taken from slot zero of the relevant unit counters. They exclude upgrades and captures. They follow the chosen scope/mode, but always remain **lifetime** measurements. Selecting `period:7d map:World` does not turn the Buildings page into buildings built on World this week.

All-time Statistics also retains the building rows. Depending on available profile fields, its additional lifetime detail can include warships built, nukes launched, troops sent, and trade gold earned. MIRV submunitions are not counted as additional nuke launches.

Other OpenFront displays may show a per-game building average. A lifetime total and a per-game average need different units and should not be compared directly.

### Missing and partial values

| Display | Meaning |
|---|---|
| `0` | A known available counter is zero |
| `N/A` / `Unavailable` | The source did not provide a usable counter |
| A total marked `(partial)` or a graph number ending in `+` | The bot can sum available values, but some contributing data is missing or invalid |
| A graph number beginning with `~` | A compact scientific abbreviation; consult the exact numeric totals |
| No recorded statistics | No usable profile bucket was available for the selection |

Bars are scaled relative to the largest displayed value in that chart. Bar length is a visual comparison within the chart; read the numbers for the actual counts. Exact available building totals accompany the dedicated building graph.

## Milestone counters and baselines

Milestone cards use exact public **Team** lifetime games and wins, independently of player match-history collection. They exclude private games, singleplayer, Humans Vs Nations, ranked games, and recent overlapping aggregates. Every selected difficulty bucket must provide nonnegative integer wins, losses, and total, with wins plus losses no greater than total. A reported total may include games without a recorded win or loss; the bot preserves that independent total. Missing, partial, unsafe numeric, or contradictory counters are unavailable and cannot earn milestones; this award rule does not change the existing statistics display.

Thresholds are ascending, unique positive decimal integers, with zero to ten per metric. Either metric or both may have an empty threshold list. Defaults are games at 10, 50, 100, 250, and 500 and wins at 1, 10, 25, 50, and 100. Counters and thresholds remain exact even above the ordinary JavaScript safe integer range.

The first complete observation records already reached thresholds silently. Adding a threshold also creates a quiet baseline for that threshold. Later upward crossings earn each threshold once per server and account; lower or repeated counters never award it again. Several crossings from one check share one durable announcement intent. An award records the observed total and observation time, not an invented historical achievement date.

Same-account verification preserves earned cards. Account replacement, unlink, account deletion, member departure, and server removal clear the corresponding personal milestone records and pending notification payloads. A later link starts with a quiet baseline. Candidate generations and current identity checks reject results captured before cleanup, including results arriving after a member rejoins. Earned records remain until personal cleanup; completed notification diagnostics expire after 30 days.

Eligible background attempts are spaced at least 15 minutes apart. Failed or incomplete checks retain a durable exponential backoff, capped at six hours, while other due members can progress. A successful complete observation resets the interval. Announcement settings and eligibility are checked again around asynchronous profile work by the milestone worker.

`/milestones view` privately shows earned cards and upcoming thresholds for the caller's current effective link. `/milestones configure` privately controls opt-in public cards and delivery recovery with existing configuration access. Cards identify the member, public profile, crossed thresholds, exact observed totals and observation time; observation time is not a claim about when an old achievement happened. Several crossings in one check produce one saved delivery.

Automatic profile polling is spaced globally per public account, including an account linked in several servers and across restarts. Each server retains its own baseline, awards and failure backoff. Same-tick profile evidence may initialize several servers without another profile request. Queued delivery/recovery checks current clan eligibility separately and can make a budgeted fresh profile request before that polling interval ends; it never turns that validation into a new counter observation. Evidence is valid for at most 60 seconds, while fresh Discord membership and current local guards are checked after awaits. Unhealthy deletion-feed synchronization pauses automatic polling and queued sending even when match-history collection is disabled. Private earned cards remain available.

## Filtered match statistics

A recent period or map selects the account's `/games` history and calculates results from records that match the exact public ID, selected scope/mode, time range, and normalized map.

The displayed measurements are:

| Measurement | Calculation |
|---|---|
| Games | All matching fetched records, including incomplete games |
| Wins | Matching records with result `victory` |
| Losses | Matching records with result `defeat` |
| Incomplete | Matching records with no completed result |
| Completed games | Wins + losses |
| Completed win rate | Wins / completed games × 100 |
| Average match duration | Mean duration of completed matching games only |
| Map performance | Matching results grouped by normalized map; up to eight groups displayed |

For example, four wins, two losses, and one incomplete game means seven games and a completed win rate of **66.7%**. The incomplete record does not become a loss or enter the duration average.

The public games endpoint does not provide per-match building totals in the bot's model. Filtered Statistics points to Buildings for lifetime values and does not fabricate period/map building counters.

### Coverage and stopping rules

The default interactive analytics budget is **10 API pages** and **10 seconds checked between page requests**. Each validated page can contain up to 100 games. An individual API request has its own timeout, so the between-page budget is not a hard ten-second wall-clock guarantee.

The bot deduplicates game IDs, rejects future records relative to the captured selection time, preserves opaque cursors, and detects repeated cursors. It relies on the endpoint's newest-first ordering when stopping after crossing a period boundary.

The coverage field reports scanned records/pages and a stop reason:

| Stop reason | Interpretation |
|---|---|
| `exhausted` | The endpoint returned no next cursor |
| `period boundary` | Newest-first pagination reached records older than the selected period |
| `page limit` | More history may remain beyond the page budget |
| `time limit` | Another page was not started because the between-page budget elapsed |
| `cursor loop` | Pagination repeated a cursor and was stopped |
| `api error` | Earlier pages were retained after a later page failed |

The first-page API failure produces an error instead of a result sample. A later failure can leave a labelled partial sample. A complete scan means the available API history for that selection was checked; it does not prove that the API exposes every game the account has ever played.

No matching games in a partial map scan means no matching games were found in the scanned records. It does not prove the player never played that map.

## Game history browsing

The Game history page shows five matches per display page. Each entry includes the recorded result, map, date, duration, mode, match type, ranked type where present, total player count where known, historical username/clan tag, and match ID.

Names and clan tags describe the identity recorded at game time. They can differ from the current profile. Incomplete results remain explicit, and the page's result summary uses completed games for win rate.

There are two browsing paths:

| Selection | How records are loaded | Limit |
|---|---|---|
| All time, no map | Fetches public game-history pages as needed, retaining cursor/filter state | Up to 100 unique recent matches per mode in the session and at most 20 API batches |
| A period or map | Reuses the bounded matching analytics sample | Five-match display pages across that sample; not subject to the separate 100-match browse cap |

The five-game summary is for the current display page. It is not a new lifetime or whole-period aggregate. The statistics session fixes its period/map selection and caches analytics by mode; reopen `/stats` for a new capture time.

Buttons bind to the requester, guild/DM context, and original message. A concurrent click while a page is loading is rejected privately. An expired session asks you to rerun the command. No live-match detection or guessed replay/spectator link is provided.

## Observed ranked Elo

### Current ratings and separate ladders

The bot reads current public leaderboard entries from `/public/leaderboard/ranked?page=N` and matches the exact public ID. It keeps **1v1**, **2v2**, and **Ranked FFA** separate. Clan-war ratings are not player Elo.

The interactive lookup scans at most the two public pages and checks a ten-second budget between pages. A missing result means the lookup has no rating to show for that ladder.

Public leaderboard access can fail, including HTTP 403. In that case the bot explains that it cannot refresh and can still display retained observations. This repository implements the collector and error handling; this guide does not establish that a particular live host can access the endpoint.

### What a chart point means

There is no historical Elo download implemented. The chart contains actual ratings this bot has observed from the public leaderboard. Wins and losses are never used to invent old ratings.

- Opening Elo can record current observations for available ladders.
- With automatic collection and player history enabled, the worker also scans leaderboard pages for linked current human server members.
- Storage keeps the latest observation per server, public ID, ladder, and UTC hour bucket.
- Cached API pages preserve their original fetch timestamp; changing display mode does not invent a new observation time.
- A single point means tracking has started. Two or more observations can show a change.
- Lines connect observations. Values between points are unknown.
- Numbers shows up to the ten latest retained samples in the selected period.
- “Latest observed Elo” is the newest stored observation in that selection, rather than a guarantee of the rating at the current instant.

Elo ignores the ordinary match scope, game mode, and map. The selected period and ranked ladder determine its chart. In particular, `mode:ffa` and Elo ladder `ffa` are different controls: the former selects ordinary FFA match statistics; the latter selects the ranked FFA rating series.

The session attempts a current refresh at most once per 30 seconds when navigating Elo. Switching Graphs/Numbers rereads retained observations and reuses the unchanged PNG. Each ladder has its own graph cache and availability notice.

### Guild and DM storage

Observations are scoped to the current server. DM observations use the internal `dm` scope with the default retention. A server's retained observations are not automatically combined with those from other servers or DMs.

An explicitly looked-up public account can have observations even without a Discord membership association. Member departure and identity cleanup remove the affected associated records; unassociated public-profile observations can expire through retention. Account-deletion purges apply across scopes.

## Recent clan analysis

```text
/clan action:recent clan_tag:MARS days:7 view:both
/clan action:recent clan_tag:MARS days:14 page:2 view:numbers
```

These are action options on the single `/clan` command. Access requires the configured clan/config role. Clan history commands must also be enabled in server history settings.

`days` accepts 1–14, defaulting to 7. The requested end is rounded down to the current minute. Requests walk backward through windows of at most one day, with up to 50 rows per API page. The default maximum is 24 API requests and a 60-second deadline checked before starting another request. The view marks a sample partial when it cannot finish the requested window, or when an API page contains a different clan or a timestamp outside the requested daily window. Those inconsistent rows are excluded; an exact upper-bound timestamp is excluded from that day's half-open window.

The analysis deduplicates match IDs and reports recorded games, wins/losses, win rate, average and peak tagged turnout, and the sum of the API's score. Loss scores can be negative. Graphs show results and turnout bands of 1, 2–3, 4–7, or 8+ tagged players. Five individual matches appear per command page.

This path reads clan history directly; enabling automatic persistent collection is not required for `recent`. It describes **recorded tagged public Team appearances**, not a full authenticated roster, proof of present clan membership, or a live-match feed.

## Automatic collection

Automatic collection is optional and starts disabled. Configure it through **Match history / weekly recap** in `/config`, then **Save**.

The worker starts immediately when the bot is ready and normally ticks every 60 seconds. The server's collection interval governs when a caught-up source is scheduled again; it does not guarantee every player and clan finishes one scan at that exact frequency.

The default request budget is eight collection requests per tick, shared across servers. Membership fetches and recap delivery are separate Discord work. Role cleanup has its own queue and does not wait behind history API requests.

The worker:

1. Applies retention and checks whether the daily deleted-account feed is fresh.
2. Fetches current guild membership and keeps eligible current human links.
3. Creates/resumes collection jobs for configured clans and eligible linked accounts.
4. Optionally spends one request on a shared leaderboard page while reserving capacity for history.
5. Rotates through due jobs using persistent work order and retry timestamps.
6. Attempts eligible recap delivery for up to two servers per tick, rotating their delivery work.

### Backfill and stored records

New history jobs start at UTC midnight seven days before the current date, then move forward in daily windows. Once caught up, they revisit recent dates for delayed results and corrections. Backfill is not the same as downloading the entire retention period. Increasing retention does not reconstruct history from before collection began.

Clan records are keyed by server, clan tag, and game ID. Player records are keyed by server, public ID, and game ID. Repeated pages update existing records instead of increasing counts. Each page's writes are atomic: an invalid/failing row rolls back that page's additions and corrections.

Persistent jobs retain their date window, page/cursor, next attempt, attempts, and identity version. Coverage is marked only when a window finishes. Repeated cursors, impossible windows, unavailable profiles, and stale settings/links do not become successful coverage.

Player recap collection is restricted to public Team sessions whose recorded clan tag matches a configured clan. It does not continuously archive every private/singleplayer/FFA match that a member can inspect interactively in `/stats`.

Leaderboard work shares one page across enabled servers and matches ratings by exact ID. It scans at most two pages before restarting. Progress persists and failures back off.

## Weekly recap setup and calculations

### Settings

| Setting | Default | Allowed values / effect |
|---|---|---|
| Clan history | On | Enables clan history commands/collection sources |
| Player history | On | Enables player history/Elo and eligible player collection |
| Automatic collection | Off | Must be enabled for scheduled recaps |
| Weekly recaps | Off | Requires collection and a destination |
| Recap channel | None | Server text channel accessible to the bot |
| Collection interval | 15 minutes | Integer 5–1440 |
| Retention | 90 days | Integer 14–365 |
| Weekly day | Monday (`1`) | `0` Sunday through `6` Saturday |
| Weekly hour | `12` | Integer 0–23 |
| Time zone | `UTC` | Valid IANA zone, such as `America/Bahia` |

Enabling weekly recaps also enables collection in the GUI. Disabling collection or clearing the destination turns off recaps. Saving validates the relationship again.

The destination requires **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History**. The last permission supports reconciliation when a send may have succeeded before acknowledgement was stored.

### The reporting week

The default scheduled send is Monday at **12:00 UTC**. The report covers the previous complete **Monday 00:00 to Monday 00:00 in the saved time zone**, regardless of the chosen send weekday. Daylight saving offsets are resolved using that zone rather than the host's local clock.

For example, with the default UTC schedule, a Monday noon recap covers the week that ended at midnight that Monday. Changing the send day to Wednesday changes delivery time, not the Monday-to-Monday definition.

The scheduling migration converts the original `09:00 America/Bahia` default to `12:00 UTC` once, preserves other custom schedules, and resets the activation point for affected enabled recaps. This avoids an immediate duplicate from that default migration.

Newly enabling recaps sets an activation timestamp. The worker does not immediately send the latest scheduled period if its scheduled time was before activation; wait for an eligible future scheduled send. Use `/clan action:summary` to preview the previous completed local Monday-to-Monday week's stored report. The preview calculates its boundary using Monday at midnight, independently of the saved delivery weekday/hour. Before a later scheduled send, its preview can therefore refer to a newer week than the latest due scheduled delivery. A preview does not enable collection or send to the recap channel.

### Clan and player calculations

The report uses the same calculations for preview and scheduled delivery; their date windows are selected as described above.

- The headline counts distinct recorded game IDs across configured clans.
- Clan breakdowns count each clan's recorded appearances; the same game can involve more than one configured clan.
- The result-entry graph counts clan result entries, so its sum can exceed the headline's distinct-game count.
- Each clan shows wins, losses, win rate, average/peak turnout, and API score sum.
- Only the first eight clan breakdowns are displayed; totals include all configured clans.

Player rankings use current human Discord members' effective links and exact public IDs. Eligible sessions must be public Team, carry a currently configured clan tag recorded at game time, and have an end timestamp. Duplicate game IDs count once per player. A historical tag does not award an extra tournament qualification or prove current clan membership.

**Most recorded wins** shows up to five players, ordered by wins, then appearances, then stable ID. **Best recorded win fraction** shows up to three players with at least three completed appearances, ordered by win fraction then appearance count. Records without an end timestamp are excluded rather than treated as losses.

Rankings are withheld until the deleted-account check has succeeded within the last day. Clan/player checked-window counts explain whether coverage is complete. Incomplete collection can change rankings; a report is an activity summary from available collected data.

### Delivery reliability

Each server and weekly period has one persistent delivery record with a deterministic nonce. The bot rechecks settings, destination, current identities, and configured tags before sending. Retries inspect up to 100 recent channel messages for the bot's report marker and use Discord nonce enforcement to reduce duplicate sends after interrupted acknowledgements.

This is bounded reconciliation, not a guarantee that a duplicate can never occur. Failed delivery retains an error and retry state. A terminal failed delivery is not retried automatically by that worker; inspect health through `/debug action:status` or `/clan action:doctor` and follow the [operations guide](operations.md).

## Retention, deletion, and stale sessions

Retention limits stored records; selecting `period:365d` cannot recover observations already expired by a 90-day policy. Elo reads enforce the retention cutoff even before the next cleanup tick.

| Event | Effect on collected player/history data |
|---|---|
| Player history disabled and saved | Clears that server's retained player sessions, collection jobs/coverage, and Elo observations; lifetime profile views remain available |
| Automatic collection disabled | Stops background collection for that server; existing data remains subject to retention |
| Clan added or removed | Rebuilds clan-filtered player match records/coverage against the new tag set, preserving unrelated Elo observations |
| Affected identity unlinked/relinked | Purges affected collected identity data; a new link starts eligible collection again |
| Associated member leaves | Removes affected server-associated player history and observations |
| Account appears in deletion feed | Purges its retained player sessions, Elo, and player jobs/coverage across scopes and marks the account deleted |
| No successful deletion checkpoint, or gap beyond seven days | Clears retained player history/Elo before recollection, because the public deletion window cannot establish what was missed |

The deletion feed is checked daily when applicable and fetched fresh. A failure blocks eligible player collection/rankings and scheduled delivery until healthy; clan jobs can still proceed. Deletion markers prevent silently recreating purged player history.

Open statistics sessions check history settings revisions, deletion state, and linked identity before using cached history and again after requests. Changes clear the cached history/analytics/Elo and ask the user to reopen `/stats`. The already-published content of old Discord messages is not retroactively deleted by database cleanup.

Backups can contain older data snapshots. Operators should manage backup access and retention alongside the active database; see [backup and recovery](operations.md#8-database-migration-snapshots-and-recovery).

## Common questions

### Why does another site show a different win rate?

Compare the same account, scope, exact mode, time period, and denominator. Lifetime profile win rate uses the profile total; filtered history uses completed results in the fetched sample. Differences in upstream history coverage and update time also matter.

### Why are building totals unchanged when I select a map?

The Buildings page uses lifetime profile counters. The game-history model has no per-match building counters, so the bot cannot compute that map's buildings from it.

### Why is my Elo blank despite playing ranked?

The selected ladder may have no retained observations, the lookup may not have reached the account, or leaderboard access may have failed. Check the rating coverage notice and other ladders. Blank does not mean zero rating.

### Why is Elo different in two servers?

Each scope can have different observations, retention, collection timing, and settings. DMs also use a separate storage scope.

### Why are weekly rankings missing players?

Check current membership, effective identity links, player-history/collection settings, configured tags recorded in public Team games, completed sessions, deletion-feed health, and coverage. The report cannot rank uncollected or ineligible sessions. It does not use lifetime profile wins as weekly wins.

### Why does a fresh recap show partial coverage?

Backfill and source rotation take time. New jobs begin seven UTC days back; high-volume clans require multiple pages, and an API outage delays successful windows. Preview the report again after collection catches up and inspect doctor/status for persistent errors.

### Does linking create a historical archive immediately?

No. Linking establishes identity. Optional background collection and interactive page requests fetch their own bounded data. Elo trends begin with actual observations and do not acquire past points from linking.

## Source references

- [Statistics command, sessions, page rendering, and limits](../src/commands/stats.ts).
- [Lifetime counters, units, and integer win-rate calculations](../src/playerStats.ts).
- [Period/map selection, normalization, analytics, and coverage](../src/playerAnalytics.ts).
- [Public response models](../src/historyTypes.ts) and [API adapters](../src/api.ts).
- [Clan analysis and weekly report builder](../src/historyReports.ts).
- [Persistent collection, deletion checks, and delivery](../src/historyCollector.ts).
- [History settings, observations, jobs, coverage, and purges](../src/historyStore.ts).
- [Local weekly period and scheduling calculations](../src/historySchedule.ts).

## Shared bingo observations

Shared bingo game progress uses retained player sessions with collection and player history enabled and a healthy deletion feed. A match must start on or after board creation and before its optional closing time, have a valid end, use Public/Team mode, carry a configured clan tag and belong to a currently eligible effective identity/member. Late collection can contribute an eligible match; a match starting before the board never contributes. Repeated polling counts each account/game pair once, and corrected results can reduce wins and completed lines.

`gameEvidenceState(guildId, now)` reports `observed`, `disabled` or `unavailable` with the retention horizon. `observed` describes retained observations, not exhaustive verification: the bingo interface must also surface gaps from the existing player-coverage records and label the history retention limit. Manual challenges remain usable when collection is disabled or unavailable. Expiry, unlink, departure, account deletion, history clear and collection disable remove game contributions; losing then regaining a line does not announce that line twice on the same board. A new board has a new notification namespace.

Availability progress counts distinct current members with nonempty windows and a latest saved timestamp on or after board creation and before closure. It does not require a linked game account. Clearing availability removes its contribution; ordinary account unlink preserves availability. There is no append-only submission log. Manual approval corrections retain an officer audit reason and recompute current progress.

Bingo evidence refresh uses bounded staging: at most 200 canonical source rows are validated per page, then a complete generation is published atomically. During a dirty refresh or inventory change, stored automatic counts may still belong to the prior generation; the bingo interface must finish the fresh replacement or withhold those counts. Partial correction cannot consume automatic completion notification keys. Manual approvals and wholly manual line completion remain usable while automatic evidence is unavailable.

Milestone profile observations and bingo retained-game observations answer different questions. Milestones compare exact public Team lifetime decimal counters, baseline existing/new thresholds silently and persist earned crossings. They do not infer an exact achievement time from late polling. Bingo counts unique retained completed account/game pairs after board creation under the configured clan tags and current human identities; it does not claim exhaustive lifetime coverage or count signup as attendance.

Deletion-feed tombstones suppress recollection and purge an account's stored history, milestone observations/awards/intents and bingo game evidence across guilds. Another account's observations remain intact. Unlink/replacement removes derived account evidence and resets onboarding completion; recurring availability/signups survive. Clearing/disabling player-history evidence removes automatic bingo game contributions while milestones remain separately controlled. Availability evidence needs a current human and a post-board saved nonempty schedule, without requiring an account link. Public messages retain their separate lifetime boundary.
