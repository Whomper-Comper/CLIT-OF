# Command reference

This reference describes the commands registered by `src/commands/index.ts` and their current handlers. Start with the [README](../README.md); see [server administration](server-administration.md), [statistics and history](statistics-and-history.md), [operations](operations.md), and [architecture](architecture.md) for the corresponding workflows.

## Contents

- [Entering commands](#entering-commands)
- [Visibility and permissions](#visibility-and-permissions)
- [/link](#link)
- [/unlink](#unlink)
- [/whois](#whois)
- [/stats](#stats)
- [/dice](#dice)
- [/availability](#availability)
- [/config](#config)
- [/clan](#clan)
- [/debug](#debug)
- [Statistic milestones](#statistic-milestones)
- [Shared server bingo](#shared-server-bingo)
- [Common command problems](#common-command-problems)

## Entering commands

Type `/` in Discord, choose the bot's command, then fill in Discord's named input fields. Examples below use `option:value` to describe those fields. Select users, roles and channels through Discord's picker; example names such as `@Alice`, `@ClanManager`, and `#clan-log` are illustrative.

`/clan` has one required **action option**, not slash subcommands: use `/clan action:sync`, not `/clan sync`. Likewise use `/debug action:status`. Discord can show a friendly label for a choice while its underlying value is the value documented here.

There are fourteen registered commands: `/link`, `/unlink`, `/whois`, `/stats`, `/clan`, `/config`, `/debug`, `/dice`, `/availability`, `/event`, `/onboarding`, `/wheel`, `/milestones`, and `/bingo`. `/config`, `/clan`, `/debug`, `/availability`, `/event`, `/onboarding`, `/wheel`, `/milestones`, and `/bingo` are explicitly server-only. The other builders do not declare a server-only context; availability outside servers also depends on the application's installation and Discord command contexts. In a DM, identity lookups use verified bot-wide links, not server approvals.

### Accepted identity inputs

OpenFront public IDs are case-sensitive tokens of 1–22 letters, digits, underscores or hyphens. Inputs recognized as Discord snowflakes (17–20 digits) are rejected when an OpenFront account is required. A profile URL is also accepted, for example `https://openfront.io/player/HabCsQYR`. The resolver also understands `/player/ID` paths with prefixes, supported `publicID`/`publicId`/`player`/`id` query parameters and profile hash links. Paste a public profile link rather than an account name.

For `/whois` and `/stats`, `openfront_id` additionally accepts a Discord user ID or mention. That path looks up a saved identity; it does not interpret the number as an OpenFront account. Supply exactly one identity option; leaving both empty does **not** default to yourself.

## Visibility and permissions

| Command or action | Access | Normal visibility |
| --- | --- | --- |
| `/link` | Account owner verifies ownership | Always private |
| `/unlink` | Your own links | Private by default; server setting can make public |
| `/whois`, `/stats`, valid `/dice` | No selected management role required | Public |
| `/config`, `/clan action:config` | Manage Server permission **or** configured config role | Always private |
| All other `/clan` actions | Must hold configured config role | Private by default, except roster and whole-clan sync are public |
| `/debug` | Must hold configured debug role | Always private |

Manage Server allows recovery and configuration, but does not bypass the selected role for other clan actions. Owners and administrators also need the selected clan/debug role for those respective commands. No debug role means `/debug` is disabled.

`/debug action:ephemeral enabled:false` changes ordinary clan and unlink responses in that server. It does not change already-created messages or the always-private tools. Access checks that reject a command before it is acknowledged reply privately. A later error can replace an already-public command response and retain its visibility. Invalid dice settings reply privately. Public identity/statistics responses may display saved identity information and live account statistics; a private configuration menu does not make those lookup commands private.

## `/link`

```text
/link openfront_id:HabCsQYR
/link openfront_id:https://openfront.io/player/HabCsQYR
/link token:<your newly generated Identity Token>
```

| Option | Requirement | Meaning |
| --- | --- | --- |
| `openfront_id` | Exactly one of this or `token` | OpenFront public ID/profile link; the live profile's Discord connection must match the person running the command |
| `token` | Exactly one of this or `openfront_id`; maximum 4096 characters | Identity Token generated in OpenFront account settings |

The command fetches a fresh profile. Token verification must return a valid account ID; an invalid/expired token is rejected. Without a token, a mismatched or absent Discord connection produces guidance to use an Identity Token or ask a manager for a server-only approval. A profile existing is not enough to prove ownership.

Success saves an `identity_token` or `profile_discord` verification, replaces your previous verified identity, invalidates conflicting server-only claims, and queues role reconciliation across configured servers. An account already verified to another Discord user cannot be claimed until that owner unlinks it. Identity changes also invalidate associated retained identity history. Verification is private. The per-user cooldown is 10 seconds.

## `/unlink`

```text
/unlink
```

No options. Removes **your verified bot-wide identity and all your server-only approvals across servers**, including when called outside a server. It purges associated identity history and queues clan-role cleanup. If there are no links, it reports that. Cleanup is paced and may finish after the command responds. Staff-owned approval roles are not automatically removed. The per-user cooldown is 10 seconds.

To remove only a particular server approval as staff, use `/clan action:unlink user:@Alice` instead.

## `/whois`

```text
/whois user:@Alice
/whois openfront_id:HabCsQYR
/whois openfront_id:https://openfront.io/player/HabCsQYR
```

| Option | Requirement | Meaning |
| --- | --- | --- |
| `user` | Exactly one of this or `openfront_id` | Discord user whose effective link is available here |
| `openfront_id` | Exactly one of this or `user` | Public ID/profile link, or Discord ID/mention |

The public identity card includes the OpenFront profile, public ID, linked Discord user when known, saved link scope, live clans, and account creation date when available. In a server, an effective link is a verified bot-wide identity or an eligible approval in that server. A direct public-ID lookup can work without a saved link and may show the Discord connection from the profile itself.

If a saved link exists but OpenFront fails, the card can show the saved identity and clearly mark unavailable live membership. A missing profile does not silently erase a saved link. If neither a link nor a profile is available, the command fails. Use `/stats` for results and charts. Per-user cooldown: 3 seconds.

## `/stats`

```text
/stats user:@Alice
/stats openfront_id:HabCsQYR scope:all mode:all view:numbers
/stats openfront_id:HabCsQYR mode:ffa period:30d map:World
/stats user:@Alice ladder:2v2
```

| Option | Requirement/default | Choices or constraint |
| --- | --- | --- |
| `user` | Exactly one of `user`/`openfront_id` | Discord user with an effective saved link |
| `openfront_id` | Exactly one of `user`/`openfront_id` | Public ID, profile URL, Discord ID or mention |
| `view` | `graphs` | `graphs`, `numbers` |
| `scope` | `public` | `public`, `private`, `singleplayer`, `all` |
| `mode` | `ffa` | `ffa`, `team`, `hvn`, `ranked`, `all` |
| `period` | `all` | `all`, `24h`, `7d`, `30d`, `90d`, `365d` |
| `map` | None | Exact normalized map name, at most 100 characters, one line, no control characters |
| `ladder` | `1v1` | `1v1`, `2v2`, `ffa` |

The initial page is **Statistics**, even when a ladder is supplied; choose **Elo** to open its rating page. The response is public. Only the invoker can change its controls. Sessions last 10 minutes and belong to their original message and server/DM context. Reopen `/stats` after expiry or changes to identity/history settings. Per-user cooldown: 3 seconds.

### Navigating statistics

1. Choose **Free For All**, **Teams**, **Humans Vs Nations**, **Ranked**, or **All modes**. The original scope, period and map remain selected. Teams is the unranked Team category; ranked play has its own mode.
2. Choose **Statistics**, **Buildings**, **Game history**, or **Elo**. If the server disables player history, Game history/Elo controls are hidden, and period/map selections are rejected. All-time Statistics and Buildings remain available.
3. Choose **Graphs** or **Numbers** to update the existing message. Statistics/building graphs are aligned text charts; Elo can attach a PNG line chart.
4. On Game history, use **Previous**/**Next**. Pages show up to five matches, including result, map, date, duration, mode/type, player count, recorded name/tag and match ID. Ordinary all-time history is bounded to 100 recent matches per mode and 20 fetched API batches. Period/map history uses its bounded matching selection.
5. On Elo, choose **1v1**, **2v2**, or **Ranked FFA**. Game-mode buttons are disabled there. The original period applies; map, scope and ordinary mode do not redefine ranked rating.

Unfiltered all-time Statistics uses lifetime account counters. A period or map uses bounded exact-account game history, labels partial coverage, excludes incomplete games from completed-game win rate, and can show map results and average duration. Map normalization ignores case, whitespace, hyphens and underscores. Buildings always shows **lifetime** counters for the selected scope/mode; period/map filters do not apply to those counters.

Elo stores actual observed public ratings, not estimates from wins/losses. One sample is a point, and missing history cannot be reconstructed. A blocked leaderboard (including HTTP 403), incomplete lookup, absent ladder entry, or expired retention can explain missing data. Opening/refreshing Elo attempts a current lookup no more often than every 30 seconds within that session; switching Graphs/Numbers does not initiate that lookup. See [statistics and history](statistics-and-history.md) for data definitions and collection limits.

## `/availability`

```text
/availability set day:Friday start:23:00 end:01:00 timezone:America/Bahia
/availability view
/availability view user:@Alice page:2
/availability clear window:ID_FROM_VIEW
/availability clear
/availability suggest duration:120
```

Save up to 14 weekly windows of 30 minutes to 12 hours, including overnight windows. Times use local `HH:mm` and weekdays; a timezone is required on the first save and reused afterward. Changing timezone changes how all your local windows project. A matching weekday/start/end replaces the same window; supply its `window` ID to replace it with different times. Zero-length windows are invalid. `/availability clear` without a window removes all your recurring availability.

Set, view, clear, and editing controls are private. View pages show seven windows, with owner-bound edit/delete controls that expire after ten minutes. Editing opens local day/time/timezone fields; the modal labels Monday as 0 through Sunday as 6. Reopen view after a change from another session. Only configured community managers, mapped clan officers, and mapped clan leaders can view another member's raw schedule. This access does not alter existing clan/config/debug permissions.

Suggestions are public counts and Discord timestamps, never member IDs or raw schedules. They refresh server membership once, exclude departed members and bots, and evaluate the next 14 days at 30-minute starts. The default duration is 120 minutes; choose 30–240. A member must cover the full session; overlapping or adjacent windows count only once. Results rank by member count, then start time, and suppress overlapping sessions with the same attendees. If everyone cannot attend, the result explains the best partial overlap. Weekly local rules follow timezone changes; skipped and repeated clock hours are projected as real availability. Suggestions do not publish events or sign anyone up. Per-member suggestion cooldown: ten seconds.

## `/dice`

```text
/dice
/dice sides:20 count:2
```

| Option | Default | Bounds |
| --- | --- | --- |
| `sides` | 6 | Integer 1–1000 |
| `count` | 1 | Integer 1–25 |

Rolls use Node's cryptographic random integer generator. Five rolling frames run at 600 ms each, then the public result lists each die and a total for multiple dice. With at least three sides, 1 is a critical minimum and the highest face is a critical maximum. D1 and D2 do not show critical labels. Per-user cooldown: 4 seconds.

## `/config`

```text
/config
```

No options. Opens a private, invoker-only server menu for 10 minutes. Manage Server permission or the configured config role is required. The menu shows access roles, debug/private-reply settings, configured clan count and pending/retrying role jobs.

| Home control | Behavior |
| --- | --- |
| Set config role | Select one normal server role; saves immediately |
| Set debug role | Select one normal role; saves immediately; clearing disables `/debug` |
| Clan selector | Opens a saved clan draft; up to 25 clans per menu page |
| New clan | Opens a new unsaved draft |
| Previous / Next | Navigates the home clan selector |
| Diagnostics | Private doctor report, first report page |
| Link coverage | Private coverage report, first report page |
| Match history / weekly recap | Opens history/recap draft settings |
| Close | Ends the session |

For a clan draft, use **Tag / sync interval**, **Clan roles**, and **Log channel**, then **Save**. Optional role/channel selectors can be cleared. Existing clan tags cannot be renamed in place. **Back to clans** or **Cancel** discards that clan draft. **Delete** opens a separate confirmation; **Confirm removal** queues obsolete-role cleanup and **Keep clan** returns to editing.

History settings expose **Clan history**, **Player history / Elo**, **Collect**, **Weekly**, a destination text-channel selector and **Timing / retention**. They are drafts until **Save**. Timing bounds: collection every 5–1440 minutes, retention 14–365 days, weekly day 0 (Sunday) through 6 (Saturday), hour 0–23 and a valid IANA time zone. New-server defaults: clan/player history on, collection/weekly off, no channel, 15-minute polling, 90-day retention, Monday at 12:00 UTC. Enabling Weekly enables collection; disabling collection disables Weekly; clearing the destination disables Weekly. A selected recap channel must allow view/send/embed/read-history permissions even when validating a draft that has Weekly off.

Permission checks are refreshed when applying changes. Expired sessions, simultaneous actions, changed role settings and conflicting clan/history edits can require opening a fresh menu. Choosing a new config role does not assign it to you: if you lack Manage Server and do not hold the newly selected role, you can lose access immediately.

## `/clan`

All actions are server-only. `action` is the only slash-schema-required option; handlers enforce the additional requirements in the action table.

### Shared option schema

| Option | Type / bounds | Used by |
| --- | --- | --- |
| `action` | Required choice listed below | All actions |
| `clan_tag` | String length 2–5; normalized uppercase; setup validates letters/digits only, no brackets | Clan selection/setup; ignored by actions that do not select clans |
| `member_role` | Role | Setup; required there |
| `officer_role` | Optional role | Setup |
| `leader_role` | Optional role | Setup |
| `join_role` | Optional staff-owned approval role | Setup |
| `log_channel` | Server text channel | Setup |
| `sync_interval` | Integer 2–1440 minutes | Setup; default environment interval, normally 10 |
| `user` | Discord user | Targeted sync, audit, link, unlink |
| `openfront_id` | Public ID/profile URL | Link; required there |
| `page` | Integer at least 1; default 1 | Paged action results |
| `days` | Integer 1–14; default 7 | Recent |
| `view` | `both` (default), `numbers`, `graphs` | Recent |

Only supply options relevant to the chosen action. Optional inputs unrelated to an action generally have no effect; they do not constitute extra filters. Most page-based actions reject out-of-range pages; audit instead returns an empty page when there are no entries.

### Action behavior

| `action` | Additional required inputs | Behavior and pagination |
| --- | --- | --- |
| `setup` | `clan_tag`, `member_role` | Create or replace configuration for that tag; validates mappings, permissions and clan existence |
| `config` | None | Without tag/page: opens menu. With either: shows saved settings, 3 clans/page; optional tag filters |
| `remove` | `clan_tag` | Removes configuration immediately and queues obsolete-role cleanup |
| `sync` | None | Synchronizes selected clans, 10 clans/page; optional `clan_tag` and/or `user` |
| `pending` | None | Members with an approval role who are not yet in its clan, including unlinked users; 15 rows/page; optional tag |
| `roster` | `clan_tag` | Current-server linked members whose live profile confirms membership; 15 rows/page, sorted by name; marks role mismatches and unavailable profiles |
| `audit` | None | Link-change history, 10 entries/page; optional user |
| `link` | `user`, `openfront_id` | Manager approves a human current server member's identity in this server; queues reconciliation |
| `unlink` | `user` | Removes server-only approval; queues cleanup; refuses verified bot-wide identities |
| `coverage` | None | Discord human-link coverage and minimum linked clan fraction, 10 clans/page; optional tag |
| `doctor` | None | Read-only role/API/permission/queue/history checks, 5 clans/page; optional tag |
| `recent` | `clan_tag` | Recent public Team clan match report; `days`/`view`; 5 matches/page; clan history must be enabled |
| `summary` | None | Preview collected previous completed Monday-to-Monday week in the configured time zone; clan history must be enabled |

`summary` summarizes configured server clans and eligible linked server members, rather than filtering by `clan_tag`, `days`, `page` or `view`. It does not send a scheduled recap to the configured destination. See [statistics and history](statistics-and-history.md) for weekly coverage and eligibility.

### Examples

```text
/clan action:setup clan_tag:MARS member_role:@MarsMember officer_role:@MarsOfficer leader_role:@MarsLeader join_role:@Approved log_channel:#clan-log sync_interval:10
/clan action:config clan_tag:MARS
/clan action:sync clan_tag:MARS
/clan action:sync user:@Alice
/clan action:pending clan_tag:MARS page:1
/clan action:roster clan_tag:MARS
/clan action:link user:@Alice openfront_id:HabCsQYR
/clan action:unlink user:@Alice
/clan action:audit user:@Alice page:1
/clan action:coverage
/clan action:doctor clan_tag:MARS
/clan action:recent clan_tag:MARS days:7 view:both page:1
/clan action:summary
/clan action:remove clan_tag:MARS
```

**Setup is a complete replacement.** Running setup on an existing tag with only `member_role` clears omitted officer/leader/approval/log mappings and resets the interval to the environment default. Use the menu to edit individual settings. Unlike menu deletion, slash `remove` has no separate confirmation.

**Sync pagination applies to work, not just output.** Only the selected page of at most 10 clans is synchronized. If there are more clans, invoke subsequent pages too. With a user, that person must be in the server and have an effective link. Without a user, the progress/result response is public and can remain editable for long runs. A response reports member/clan checks, role changes and failed checks; queued jobs can still exist separately.

**Audit scope is server-based.** It shows actor, subject, action, timestamp and old/new public IDs. Selecting yourself additionally includes your global link/unlink and legacy revocation events across their recorded origins; it does not grant other-server local approval histories. Other-user lookups remain scoped to the current server. Audit is still a management-role action.

### Clan cooldowns

| Actions | Cooldown scope |
| --- | --- |
| Setup, remove, link, unlink | 3 seconds per action/server/invoker |
| Sync with `user` | 10 seconds per server/target member |
| Sync without `user` | 60 seconds per server |
| Roster, pending, coverage, doctor, recent, summary | 15 seconds per action/server, shared by managers |

There is no explicit handler cooldown for saved-config display or audit. GUI Diagnostics/Link coverage share their respective server cooldowns with slash reports.

## `/debug`

```text
/debug action:status
/debug action:export_links
/debug action:verbose enabled:true
/debug action:ephemeral enabled:false
```

| Option | Requirement | Values |
| --- | --- | --- |
| `action` | Required | `export_links`, `status`, `verbose`, `ephemeral` |
| `enabled` | Required for `verbose` and `ephemeral` | Boolean `true`/`false`; ignored for status/export |

`status` privately reports current member/link counts, configured clans, pending/retrying role jobs, verbose/private-reply modes, collection state and retained records/Elo, source retries, weekly state/time zone and collection/error indicators. Status and export share a 15-second cooldown per server/invoker.

`export_links` privately attaches the complete JSON snapshot of effective links whose Discord users are currently server members. It includes schema version, export time, server ID/name, member and linked counts, and each user's Discord ID/username/display name, OpenFront ID/saved username, linked time, scope and verification method. The member/link export is not the human-only coverage report; the export code filters membership rather than excluding bots explicitly. It does not export the identity token. Full membership must load successfully; oversized files or failed membership fetches produce no partial export. Access is rechecked before releasing data. Downloaded JSON contains account associations and should be shared accordingly.

The attachment uses this shape (all identities and values below are illustrative):

```json
{
  "schema_version": 1,
  "exported_at": "2026-10-17T12:00:00.000Z",
  "guild": { "id": "GUILD_ID", "name": "Example server" },
  "member_count": 10,
  "linked_user_count": 1,
  "users": [
    {
      "discord_id": "DISCORD_USER_ID",
      "discord_username": "example_user",
      "discord_display_name": "Example member",
      "openfront_id": "PLAYER_ID",
      "openfront_username": "Example player",
      "linked_at": "2026-10-16T12:00:00.000Z",
      "scope": "bot_wide",
      "verification_method": "identity_token"
    }
  ]
}
```

IDs are strings. A stored OpenFront username can be `null`. Server approvals use `scope: "server"` and `verification_method: "admin_manual"`; verified links use `scope: "bot_wide"` with `identity_token` or `profile_discord`. An empty export has `users: []` and a zero linked count. The file has no import/restore command; use the [database backup procedure](operations.md#8-database-migration-snapshots-and-recovery) for full recovery.

`verbose` changes safe explanatory error output (default off). `ephemeral` changes ordinary clan and unlink response visibility (default private/on). Both settings persist per server; the debug command's own responses stay private. Errors do not intentionally expose raw API response bodies, stack traces, SQL or tokens.

## Team events

`/event create` opens an officer's private draft. Supply a title, `start` as `YYYY-MM-DD HH:mm`, and an IANA `timezone` such as `America/Bahia`. Repeated daylight-saving times require an explicit `offset` such as `-04:00`; nonexistent local times are rejected. Check the interpreted date, UTC offset and Discord timestamp before selecting **Publish**. Defaults are 20 seats and 120 minutes; supported limits are 1–100 seats, 15–720 minutes, and a start within the next 365 days.

`/event list` displays up to 100 recent/upcoming records in pages of ten. `/event view id:…` provides the link to the canonical public signup card. Use that card's **Join**, **Withdraw**, **Choose squad**, **Reminder**, pagination and **Refresh** controls. Full events or squads place members on a stable first-in reserve list; repeated Join keeps the original queue position. Signups close at the start instant.

Officers use `/event edit id:…` for private detail editing, squad configuration, member moves and delivery status. Squad lines use `id | name | capacity`, one per line (up to 20); capacities must sum to total event capacity. **Edit squads** saves its total event capacity and squad limits together, so occupied squads can grow or shrink while preserving confirmed seats. A single `-` clears unoccupied squads. Occupied squads cannot be removed, and capacity cannot fall below confirmed occupancy. `/event cancel id:…` closes the event and queues an update of its public card.

An officer running `/availability suggest` receives private **Draft session** buttons alongside the public count/timestamp suggestions. These create unpublished, empty event drafts; they never sign up members or expose their private schedules. Private menus belong to their opener and expire after ten minutes.

Reminder preferences are opt-in and default off. This implementation stores the chosen 15/30/60-minute lead and each member's preference; automatic reminder delivery and event housekeeping are implemented in the following scheduling work.

## Newcomer onboarding

`/onboarding status` opens your private four-step checklist and enrolls you for the selected clan. Use `clan:MARS` to select a configured clan; selection is required when several clans are configured. The checklist shows your effective account link, fresh OpenFront clan membership, saved availability, and confirmed event signup. A server-approved link is labeled **server-only**, and an approval role means **Waiting** for an invitation rather than membership. Unavailable membership data shows **Unknown** with retry guidance.

Save availability with `/availability set` and find an event with `/event list`. A reserve place, withdrawn signup or cancelled event does not complete the event step. A confirmed future signup or retained past signup does; this records signup, not attendance. Past signup evidence expires with the event's 90-day retention eligibility even while cleanup is draining older rows.

Community officers can use `/onboarding status user:@Member clan:MARS` for private inspection without enrolling that member. `/onboarding queue page:1` privately shows enrolled current members ten at a time, their next step and waiting/unknown guidance. Only linked members on the displayed page require profile lookups. **Previous**, **Next**, and **Refresh** reread current state, recheck officer access and allow one action per ten seconds. Private menus belong to their opener, server, channel and original message and expire after ten minutes. Onboarding remains private regardless of ordinary-reply debug settings.

## Statistic milestones

`/milestones view` privately shows your linked account's earned and upcoming public Team lifetime milestones. Initial observations and newly added thresholds earn quietly. Refresh retries unavailable statistics; saved earned cards remain visible during an upstream outage or when announcements are off. Current OpenFront clan membership is required to save a new observation; a Discord approval role alone does not qualify.

`/milestones configure` is private and requires Manage Server or the configured config role. Select a text or announcement channel, optionally edit up to ten ascending unique positive integer thresholds for each metric, enable announcements, and press **Save**. Either threshold list may be empty; both empty pauses automatic profile polling. Draft changes do not apply until saved. Private menus expire after ten minutes and bind their owner, server, channel and message. Every configuration action refreshes access; a changed saved revision requires Refresh or reopening the menu.

The configuration menu lists failed, paused and uncertain deliveries ten at a time. Choose a delivery and use **Retry / reconcile** after correcting permissions. Uncertain sends search for the original bot message before completing; an unproven outcome remains available for review instead of automatically posting a duplicate. Saving any milestone setting cancels unsent jobs from the previous settings revision. Earned milestones remain available in your private view.

## Common command problems

| Message/symptom | Next step |
| --- | --- |
| Provide exactly one input | Remove one of the two identity fields; do not submit both or neither |
| Profile's Discord connection does not match | Generate a fresh Identity Token in OpenFront account settings and use `/link token:…` |
| Verified identity already exists | Its owner uses `/unlink`; a server manager cannot overwrite ownership |
| Config role missing / choose config role first | A Manage Server member opens `/config`, chooses the role, and assigns it to intended managers |
| Debug role missing | Configure a debug role and ensure the caller holds it |
| Menu/statistics expired or settings changed | Reopen the command and repeat from current saved state |
| Wait a few seconds | Respect the action's cooldown; a server-wide report cooldown can be triggered by another manager |
| Page out of range | Use the displayed page count; rerun from page 1 after membership/configuration changes |
| Could not load all server members | Retry; administrator checks Members intent and Discord connectivity |
| Live membership unavailable | Retry later; absence of API membership data is not proof that someone left the clan |
| Missing permissions / role updates fail | Follow the [administration permission checklist](server-administration.md#permission-and-role-troubleshooting) and run doctor |
| History or Elo missing | Check feature toggles, collection/retention, partial coverage and upstream availability in [statistics and history](statistics-and-history.md) |

For bot installation, command registration and service failures, continue with [operations](operations.md).

## Curated challenge wheel

`/wheel spin` publicly draws one enabled complete hosting package and then one map from that package. Settings are never randomized separately. The card includes the selected map, mode/teams, difficulty, bots/nations, map size, disabled units, gold/troop donations, spawn, infinite resources, instant build and hosting instructions. These are compatible suggested settings for a human OpenFront host; competitive balance is not guaranteed. Each member may spin once per five seconds.

Officers use `/wheel presets` to choose a package, `/wheel add` to create one, `/wheel edit [id]` to edit and `/wheel remove [id]` to confirm removal. Omitting the ID opens a private chooser. **Edit basics**, **Edit hosting**, and **Edit options** open ordinary five-field forms; use comma-separated maps/disabled units and yes/no options. Review the complete private preview and press **Save preset** explicitly. **Enable/Disable preset** changes the preview until saved. Allowed maps are World, Europe, Black Sea and Caribbean; the chooser lists supported units. Names allow 80 characters and instructions 1000. Each guild permits 50 presets and each package up to ten distinct supported maps.

Six editable starters appear once per guild: Classic clan teams, Squad skirmish, Naval night, Conventional warfare, Friendly free-for-all, and Humans versus nations. Removing every preset does not restore them; `/wheel add` creates a replacement. Disabling every preset makes spins ask an officer to enable or add a package.

Officer spinners receive a separate private **Create event draft** button. It copies the exact selected settings and instructions into an unpublished event draft; later preset edits/removals do not change that copy. Review the proposed date in event management before publishing. No members are automatically signed up. Private wheel controls belong to their opener, server, channel and original private message, expire after ten minutes, and recheck current officer access. Reopen `/wheel presets` after a stale revision.

## Shared server bingo

`/bingo view` privately shows the current shared 5×5 board and links to its canonical public message. The public card shows five numbered rows, current completion/progress and completed lines, with **Refresh** and **Claim a cell**. Long labels are shortened on the card; `/bingo view cell:14` reads the full immutable challenge. The center (13) is free.

Officers use `/bingo create` to create or resume their own private draft in the chosen destination channel. **Edit challenges** opens two groups of twelve definitions, in `kind | target | description` format, and an optional closing instant in `YYYY-MM-DDTHH:mm:ssZ` UTC format (`-` means no closing date). Supported kinds are `appearances`, `wins`, `contributors`, `shared_game`, `availability`, and `manual`. Targets are 1–1,000,000; manual targets must be 1, descriptions at most 160 characters. Edit all 24 definitions before explicitly pressing **Publish board**. Publication is queued and definitions freeze once published. Boards never reset automatically. `/bingo reset` previews a replacement and requires **Confirm reset**, which archives the old board and queues the replacement.

`/bingo claim cell:14 explanation:… [evidence:https://…]` submits a private manual claim. The public **Claim a cell** button opens the same private form. A repeated pending claim from the same person for the same cell returns the existing claim. Automatic cells and the center reject manual claims. Explanations allow 1000 characters and evidence URLs 500; evidence must use HTTPS and is stored as text without being fetched. Claims close at the optional board closing instant.

Officers use `/bingo review [page:1]` to inspect ten claims at a time. Choose a claim to read its full explanation/evidence, enter `approve` or `reject`, and give an audit reason. Rejecting an approved claim revokes the cell approval. Decisions and explanations remain private. Private controls bind their owner, server, channel, message and board/claim revision and expire after ten minutes; reopen after a change. Each privileged action refreshes officer access. Collection-disabled and unavailable game tracking still allow manual claims and review.

Automatic progress uses retained observed public Team sessions and current linked humans/configured clan tags, plus current humans' availability submissions after board creation. A full fresh scan may take several ticks; automatic cells and mixed lines show refreshing until it completes. Cards label disabled/unavailable collection, incomplete coverage and the retention horizon. Existing progress can decrease after corrections, retention, unlink or departure. A lost/regained line announces only once per board. Refresh queues a card update; it does not fetch OpenFront profiles.

Paused/failed/uncertain deliveries appear in `/bingo create` for unpublished drafts and `/bingo review` for active boards. **Retry / reconcile** rechecks officer access and deliberately retries after permissions are corrected. An uncertain accepted post is reconciled using its existing bot recovery marker; an unproven outcome stays reviewable without an automatic duplicate publication.
