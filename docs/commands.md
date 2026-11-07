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
- [/duel](#duel)
- [/availability](#availability)
- [/config](#config)
- [/clan](#clan)
- [/debug](#debug)
- [Statistic milestones](#statistic-milestones)
- [Shared server bingo](#shared-server-bingo)
- [Common command problems](#common-command-problems)
- [Team events](#team-events)
- [Newcomer onboarding](#newcomer-onboarding)
- [Community command option schema](#community-command-option-schema)
- [Curated challenge wheel](#curated-challenge-wheel)
- [Live OpenFront lobby alerts](#live-openfront-lobby-alerts)

## Entering commands

Type `/` in Discord, choose the bot's command, then fill in Discord's named input fields. Examples below use `option:value` to describe those fields. Select users, roles and channels through Discord's picker; example names such as `@Alice`, `@ClanManager`, and `#clan-log` are illustrative.

`/clan`, `/debug`, `/bingo`, `/availability`, `/event`, `/onboarding`, `/wheel`, `/milestones`, and `/lobby` have one required **action option**. Use `/bingo action:view` or `/clan action:sync`. For `/bingo`, `/availability`, `/event`, `/onboarding`, `/wheel`, `/milestones` and `/lobby`, missing required inputs and inputs belonging to another action produce a private actionable error before work begins. Clan/debug input behavior is described in their own sections. Discord can show a friendly label for a choice while its underlying value is the value documented here. Existing subcommand registrations remain accepted during rollout, but new registrations use action choices; guild and global registrations must be updated separately.

There are sixteen registered commands: `/link`, `/unlink`, `/whois`, `/stats`, `/clan`, `/config`, `/debug`, `/dice`, `/availability`, `/event`, `/onboarding`, `/wheel`, `/milestones`, `/bingo`, `/duel`, and `/lobby`. `/config`, `/clan`, `/debug`, `/availability`, `/event`, `/onboarding`, `/wheel`, `/milestones`, `/bingo`, `/duel`, and `/lobby` are explicitly server-only. The other builders do not declare a server-only context; availability outside servers also depends on the application's installation and Discord command contexts. In a DM, identity lookups use verified bot-wide links, not server approvals.

### Accepted identity inputs

OpenFront public IDs are case-sensitive tokens of 1–22 letters, digits, underscores or hyphens. Inputs recognized as Discord snowflakes (17–20 digits) are rejected when an OpenFront account is required. A profile URL is also accepted, for example `https://openfront.io/player/HabCsQYR`. The resolver also understands `/player/ID` paths with prefixes, supported `publicID`/`publicId`/`player`/`id` query parameters and profile hash links. Paste a public profile link rather than an account name.

For `/whois` and `/stats`, `openfront_id` additionally accepts a Discord user ID or mention. That path looks up a saved identity; it does not interpret the number as an OpenFront account. Supply exactly one identity option; leaving both empty does **not** default to yourself.

## Visibility and permissions

| Command or action | Access | Normal visibility |
| --- | --- | --- |
| `/link` | Account owner verifies ownership | Always private |
| `/unlink` | Your own links | Private by default; server setting can make public |
| `/whois`, `/stats`, valid `/dice` | No selected management role required | Public |
| `/duel` | Current human server members; the opponent alone accepts/declines, the challenger cancels | Private acknowledgment; public invitation and result |
| `/config`, `/clan action:config` | Manage Server permission **or** configured manager role | Always private |
| All other `/clan` actions | Must hold configured manager role | Private by default, except roster and whole-clan sync are public |
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
/availability action:set day:Friday start:23:00 end:01:00 timezone:America/Bahia
/availability action:view
/availability action:view user:@Alice page:2
/availability action:clear window:ID_FROM_VIEW
/availability action:clear
/availability action:suggest duration:120
```

Save up to 14 weekly windows of 30 minutes to 12 hours, including overnight windows. Times use local `HH:mm` and weekdays; a timezone is required on the first save and reused afterward. Changing timezone changes how all your local windows project. A matching weekday/start/end replaces the same window; supply its `window` ID to replace it with different times. Zero-length windows are invalid. `/availability action:clear` without a window removes all your recurring availability.

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

## `/duel`

`/duel opponent:@member` queues a public invitation between two different current human members in the same server. The private acknowledgment confirms the request. The public card offers **Accept**, **Decline**, **Cancel**, and **Refresh** after the saved invitation is bound to its canonical message. Only the opponent can accept/decline; only the challenger can cancel. Each member may have one pending duel per server, and challengers wait 30 seconds between invitations.

Publication/activation may wait up to two minutes in the shared queue. A saved activation immediately before the first request enabling consent starts the two-minute acceptance deadline. The usable window is reduced by that enabling request's duration. Retries never extend it. Total waiting plus acceptance can approach four minutes from the command; a busy queue can instead expire an invitation before activation. Use `/duel` again after an expired invitation. Disabled cards show their activation wait deadline, and enabled cards show their acceptance deadline.

Acceptance freshly checks both memberships and saves two independent cryptographic D6 rolls atomically before any public result update. The higher roll wins. A tie offers **Rematch** to either participant, creating a new invitation that still requires the other person's fresh acceptance and respects pending slots/cooldowns. There are no bets, currency or rankings. Button acknowledgments are private and public changes use the shared background queue; notification mentions are suppressed.

**Refresh** recovers the saved state on the original public card after an update failure; it cannot reroll. Participant departure removes pending personal invitation data and queues a generic closed card. Declined, cancelled, expired and resolved cards disable their original consent controls. Completed records remain for 30 days; published Discord messages have a separate lifetime. Existing `/dice` settings and animation are unchanged.

## `/config`

```text
/config
```

No options. Opens a private, invoker-only server menu for 10 minutes. Manage Server permission or the configured manager role is required. The home page shows a compact configured-clan and pending/retrying-job summary with focused settings pages.

| Page / control | Behavior |
| --- | --- |
| Clans | Choose a saved clan or New clan; Previous/Next pages contain up to 25 clans |
| Access | Select normal config/debug roles; both selectors save immediately; clearing debug disables `/debug` |
| History & recaps | Opens history/recap draft settings with explicit Save |
| Diagnostics | Doctor and link-coverage reports plus current reply/error settings |
| Close | Ends the session |

Clan editing groups settings into **General**, **Roles**, and **Logging**. For an existing clan, a valid selection, clear, or interval submission saves immediately. For a new clan, enter the exact tag and select a member role, then choose **Create clan** once. **Cancel** discards the new draft. Creation and edits use Discord validation and work during OpenFront outages. **Delete** opens a separate confirmation. **Confirm removal** queues obsolete-role cleanup.

If Discord rejects a draft redraw, the previous draft stays in the session. A committed edit stays saved even if the following reply fails. Reopen `/config` to see the saved settings if the menu fails to refresh.

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
| `setup` | `clan_tag`, `member_role` | Create or replace configuration for that tag after validating tag format, Discord mappings and permissions |
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

`/event action:create` opens an officer's private draft. Supply a title, `start` as `YYYY-MM-DD HH:mm`, and an IANA `timezone` such as `America/Bahia`. Repeated daylight-saving times require an explicit `offset` such as `-04:00`; nonexistent local times are rejected. Check the interpreted date, UTC offset and Discord timestamp before selecting **Publish**. Defaults are 20 seats and 120 minutes; supported limits are 1–100 seats, 15–720 minutes, and a start within the next 365 days.

`/event action:list` displays up to 100 recent/upcoming records in pages of ten. `/event action:view id:…` provides the link to the canonical public signup card. Use that card's **Join**, **Withdraw**, **Choose squad**, **Reminder**, pagination and **Refresh** controls. Full events or squads place members on a stable first-in reserve list; repeated Join keeps the original queue position. Signups close at the start instant.

Officers use `/event action:edit id:…` for private detail editing, squad configuration, member moves and delivery status. Squad lines use `id | name | capacity`, one per line (up to 20); capacities must sum to total event capacity. **Edit squads** saves its total event capacity and squad limits together, so occupied squads can grow or shrink while preserving confirmed seats. A single `-` clears unoccupied squads. Occupied squads cannot be removed, and capacity cannot fall below confirmed occupancy. `/event action:cancel id:…` closes the event and queues an update of its public card.

An officer running `/availability action:suggest` receives private **Draft session** buttons alongside the public count/timestamp suggestions. These create unpublished, empty event drafts; they never sign up members or expose their private schedules. Private menus belong to their opener and expire after ten minutes.

Reminder preferences are opt-in and default off. Choose a 15/30/60-minute lead (default 0/off); only opted-in, currently confirmed members receive a mention. The worker skips reminders discovered after the start, revalidates membership and promotes eligible reserves when seats open. Cancelled/finished events and signups retire after 90 days. Discord timestamps render in each reader's local time.

## Newcomer onboarding

`/onboarding action:status` opens your private four-step checklist and enrolls you for the selected clan. Use `clan:MARS` to select a configured clan; selection is required when several clans are configured. The checklist shows your effective account link, fresh OpenFront clan membership, saved availability, and confirmed event signup. A server-approved link is labeled **server-only**, and an approval role means **Waiting** for an invitation rather than membership. Unavailable membership data shows **Unknown** with retry guidance.

Save availability with `/availability action:set` and find an event with `/event action:list`. A reserve place, withdrawn signup or cancelled event does not complete the event step. A confirmed future signup or retained past signup does; this records signup, not attendance. Past signup evidence expires with the event's 90-day retention eligibility even while cleanup is draining older rows.

Community officers can use `/onboarding action:status user:@Member clan:MARS` for private inspection without enrolling that member. `/onboarding action:queue page:1` privately shows enrolled current members ten at a time, their next step and waiting/unknown guidance. Only linked members on the displayed page require profile lookups. **Previous**, **Next**, and **Refresh** reread current state, recheck officer access and allow one action per ten seconds. Private menus belong to their opener, server, channel and original message and expire after ten minutes. Onboarding remains private regardless of ordinary-reply debug settings.

## Statistic milestones

`/milestones action:view` privately shows your linked account's earned and upcoming public Team lifetime milestones. Initial observations and newly added thresholds earn quietly. Refresh retries unavailable statistics; saved earned cards remain visible during an upstream outage or when announcements are off. Current OpenFront clan membership is required to save a new observation; a Discord approval role alone does not qualify.

`/milestones action:configure` is private and requires Manage Server or the configured manager role. Select a text or announcement channel, optionally edit up to ten ascending unique positive integer thresholds for each metric, enable announcements, and press **Save**. Either threshold list may be empty; both empty pauses automatic profile polling. Draft changes do not apply until saved. Private menus expire after ten minutes and bind their owner, server, channel and message. Every configuration action refreshes access; a changed saved revision requires Refresh or reopening the menu.

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

## Community command option schema

All seven community commands are server-only. The complete option schema below supplements the flows in this reference; `required` is explicit and every other option is optional.

| Action | Options and defaults |
| --- | --- |
| `/availability action:set` | `day` required (Monday–Sunday / 0–6), `start`/`end` required (`HH:mm`), `timezone` required on first save then reused, `window` to replace an existing ID |
| `/availability action:view` | `user` defaults to self (other members require community officer access); `page` 1–2, default 1 |
| `/availability action:clear` | `window` optional; omission clears all own windows |
| `/availability action:suggest` | `duration` 30–240 minutes, default 120 |
| `/event action:create` | `title` required (100 chars), `start` required (`YYYY-MM-DD HH:mm`), `timezone` required (IANA); `offset` for folds; `description` default empty (1000 chars); `capacity` 1–100 default 20; `duration` 15–720 default 120; `reminder` 0/15/30/60 default 0 |
| `/event action:list` | `page` 1–10, default 1; published records only |
| `/event action:view`, `/event action:edit`, `/event action:cancel` | `id` required; edit/cancel/create require community officer access |
| `/onboarding action:status` | `clan` (32 chars) required when several configured clans exist; `user` defaults to self, another member requires officer access |
| `/onboarding action:queue` | Officer-only; `page` starts at 1, default 1, ten enrolled current members per page |
| `/wheel action:spin`, `/wheel action:presets`, `/wheel action:add` | No action-specific inputs; presets/add require officer access |
| `/wheel action:edit`, `/wheel action:remove` | Officer-only; `id` optional (100 chars), omission opens chooser |
| `/milestones action:view`, `/milestones action:configure` | No action-specific inputs; configure requires Manage Server or configured manager role |
| `/bingo action:view` | `cell` 1–25 optional; omission shows whole board privately |
| `/bingo action:create`, `/bingo action:reset` | Officer-only, no action-specific inputs; draft destination is the channel where create runs, reset uses the active board's destination |
| `/bingo action:claim` | `cell` required 1–25, `explanation` required (1000 chars), `evidence` optional (HTTPS, 500 chars) |
| `/bingo action:review` | Officer-only; `page` 1–10000, default 1 |
| `/duel` | `opponent` required, a different current human member; no OpenFront link required |

Community officers hold the configured manager role or a configured clan officer/leader role. This does not grant legacy clan/debug access. Configuration permission is Manage Server or manager role. Public outputs are event cards, count-only overlap suggestions, wheel spins, opted-in milestone announcements, published bingo boards and duels. Availability details, onboarding, drafts/settings, bingo claims/review and access errors are private. All private community menus share a 200-session, ten-minute bound and validate their owner and saved context.

## Curated challenge wheel

`/wheel action:spin` publicly draws one enabled complete hosting package and then one map from that package. Settings are never randomized separately. The card includes the selected map, mode/teams, difficulty, bots/nations, map size, disabled units, gold/troop donations, spawn, infinite resources, instant build and hosting instructions. These are compatible suggested settings for a human OpenFront host; competitive balance is not guaranteed. Each member may spin once per five seconds.

Officers use `/wheel action:presets` to choose a package, `/wheel action:add` to create one, `/wheel action:edit [id]` to edit and `/wheel action:remove [id]` to confirm removal. Omitting the ID opens a private chooser. **Edit basics**, **Edit hosting**, and **Edit options** open ordinary five-field forms; use comma-separated maps/disabled units and yes/no options. Review the complete private preview and press **Save preset** explicitly. **Enable/Disable preset** changes the preview until saved. Allowed maps are World, Europe, Black Sea and Caribbean; the chooser lists supported units. Names allow 80 characters and instructions 1000. Each guild permits 50 presets and each package up to ten distinct supported maps.

Six editable starters appear once per guild: Classic clan teams, Squad skirmish, Naval night, Conventional warfare, Friendly free-for-all, and Humans versus nations. Removing every preset does not restore them; `/wheel action:add` creates a replacement. Disabling every preset makes spins ask an officer to enable or add a package.

Officer spinners receive a separate private **Create event draft** button. It copies the exact selected settings and instructions into an unpublished event draft; later preset edits/removals do not change that copy. Review the proposed date in event management before publishing. No members are automatically signed up. Private wheel controls belong to their opener, server, channel and original private message, expire after ten minutes, and recheck current officer access. Reopen `/wheel action:presets` after a stale revision.

## Shared server bingo

`/bingo action:view` privately shows the current shared 5×5 board and links to its canonical public message. The public card shows five numbered rows, current completion/progress and completed lines, with **Refresh** and **Claim a cell**. Long labels are shortened on the card; `/bingo action:view cell:14` reads the full immutable challenge. The center (13) is free.

Officers use `/bingo action:create` to create or resume their own private draft in the command's channel. **Edit challenges** opens two groups of twelve definitions, in `kind | target | description` format, and an optional closing instant in `YYYY-MM-DDTHH:mm:ssZ` UTC format (`-` means no closing date). Supported kinds are `appearances`, `wins`, `contributors`, `shared_game`, `availability`, and `manual`. Targets are 1–1,000,000; manual targets must be 1, descriptions at most 160 characters. Edit all 24 definitions before explicitly pressing **Publish board**. Publication is queued and definitions freeze once published. Boards never reset automatically. `/bingo action:reset` previews a replacement and requires **Confirm reset**, which archives the old board and queues the replacement.

`/bingo action:claim cell:14 explanation:… [evidence:https://…]` submits a private manual claim. The public **Claim a cell** button opens the same private form. A repeated pending claim from the same person for the same cell returns the existing claim. Automatic cells and the center reject manual claims. Explanations allow 1000 characters and evidence URLs 500; evidence must use HTTPS and is stored as text without being fetched. Claims close at the optional board closing instant.

Officers use `/bingo action:review [page:1]` to inspect ten claims at a time. Choose a claim to read its full explanation/evidence, enter `approve` or `reject`, and give an audit reason. Rejecting an approved claim revokes the cell approval. Decisions and explanations remain private. Private controls bind their owner, server, channel, message and board/claim revision and expire after ten minutes; reopen after a change. Each privileged action refreshes officer access. Collection-disabled and unavailable game tracking still allow manual claims and review.

Automatic progress uses retained observed public Team sessions and current linked humans/configured clan tags, plus current humans' availability submissions after board creation. A full fresh scan may take several ticks; automatic cells and mixed lines show refreshing until it completes. Cards label disabled/unavailable collection, incomplete coverage and the retention horizon. Existing progress can decrease after corrections, retention, unlink or departure. A lost/regained line announces only once per board. Refresh queues a card update; it does not fetch OpenFront profiles.

Paused/failed/uncertain deliveries appear in `/bingo action:create` for unpublished drafts and `/bingo action:review` for active boards. **Retry / reconcile** rechecks officer access and deliberately retries after permissions are corrected. An uncertain accepted post is reconciled using its existing bot recovery marker; an unproven outcome stays reviewable without an automatic duplicate publication.

## Live OpenFront lobby alerts

`/lobby` slash commands are server-only. Alert buttons also work in DMs. No OpenFront account link is required.

| Action | Inputs and behavior |
| --- | --- |
| `/lobby action:configure` | Managers inspect enabled state, fallback destination, feed status, and up to five delivery diagnostics. Optional `enabled` and `channel` update settings; channel must be an ordinary server text channel. Changes stop existing searches. |
| `/lobby action:watch` | Required `name` (1–60 characters); optional `map` (autocomplete), `mode`, `category`, `min_players`, `max_players`. At least one filter is required. Save at most ten rules. Saving starts/restarts your search. |
| `/lobby action:list [page:1]` | Private search state, feed status, and saved rules/IDs; five rules per page. |
| `/lobby action:remove id:…` | Remove your rule without restarting a stopped search or bypassing a pending response. Removing the last rule stops searching. |
| `/lobby action:stop` | Stop your search while retaining filters. |
| `/lobby action:resume` | Restart with saved filters. |

All selected fields in a rule must match; different rules are alternatives. Map matching is exact after trimming/case normalization. Counts are **currently connected players**, not capacity, bots, or team size, and must be integers from 0 to 1000. Modes include Free For All, Team, and Humans Vs Nations. Categories are ffa, team, special, and hosted. Full, restricted, started, stale, or lobbies without capacity or a start window are excluded. A missing map or mode fails a rule that requests that field; a rule that does not request it can still match.

The bot tries a DM first. Discord's confirmed blocked-DM rejection triggers a ping in the configured server channel, including instructions to enable direct messages from server members. Saving/resuming opts into that fallback. Only the affected player is mentioned. Network failures with an uncertain send outcome stop the search for manager review rather than risking a duplicate public ping.

Each delivered alert has a **Continue searching** button. Searching pauses while delivery/your answer is pending. Click within **three minutes after successful delivery** to continue; otherwise searching stops. The deadline survives restarts and cannot be extended by repeat clicks. Only the intended player can use the button, even in a public fallback. A started/vanished lobby does not remove your ability to continue searching. Saved rules survive timeout; use `/lobby action:resume`. The same lobby does not alert you again after resuming.

A candidate that becomes unavailable before any send can be selected again if it later matches. Confirmed or uncertain sends retain duplicate protection. Before a fallback ping, the bot checks the member's current access to the channel; if access has been lost, delivery stops for review.

Live monitoring requires a compatible pinned OpenFront lobby build and access to public discovery/WebSockets. `/lobby action:list` shows feed availability; it does not claim that an unavailable feed is searching successfully. See [operations](operations.md#lobby-feed-operations).
