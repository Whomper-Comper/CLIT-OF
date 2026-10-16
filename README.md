# OpenFront Discord Clan & Identity Bot (CLIT-OF)

A standalone Discord bot that connects Discord accounts with OpenFront accounts, automatically syncs clan memberships to Discord server roles, manages closed clan approvals, and provides two-way identity lookup.

---

## Features

- **Link by OpenFront ID or Profile URL**: Paste raw public IDs (`HabCsQYR`) or full URLs (`https://openfront.io/player/HabCsQYR`).
- **Instant Discord OAuth Matching**: If the player signed into OpenFront using Discord, linking is verified instantly with zero friction.
- **Cryptographic Identity Tokens**: For players who signed into OpenFront via Steam, Google, or Email, generate an Identity Token in OpenFront Account Settings and link securely without changing your in-game name.
- **Discord ID Spoofing Protection**: Validates identifiers to prevent attacks such as players naming their in-game guest accounts after Discord IDs.
- **Accurate Timezone Display**: All timestamps are stored in UTC ISO-8601 with localized Discord relative and absolute formatting (`<t:TIMESTAMP:F> (<t:TIMESTAMP:R>)`), rendering accurately in the user's local timezone.
- **Multi-Clan Support**: A single Discord server can configure multiple OpenFront clans (e.g. Clan `MARS`, Clan `VENUS`, etc.).
- **Guild-Scoped Admin Links**: Admin-approved links are isolated to one server; member-verified links work bot-wide and admins cannot overwrite them.
- **Link History and Clan Rosters**: Choose `audit` or `roster` as the action in `/clan` to see scoped link changes or verified and approved clan members in the current server.
- **Private Configuration Menu**: Choose `config` in `/clan` to edit clans, role mappings, approval roles, log channels and sync intervals with Discord buttons, selectors and forms. Each server chooses its own required clan access role.
- **Player Statistics**: `/stats` provides mode, period and map filters, a dedicated Buildings page, game history and observed Elo charts. Switch between graphs and exact numbers on the existing message. `/whois` stays a compact identity lookup.
- **Match History and Clan Analysis**: `/clan` action `recent` shows public Team history with numerical results and aligned graphs. `/stats` has a Game history page that keeps the selected mode, scope, period and map.
- **Weekly Recaps**: Optional persistent collection produces scheduled weekly clan results, turnout statistics, and rankings for linked server members. Configure the destination, collection interval, retention, and local schedule inside Discord.
- **Link Coverage and Diagnostics**: Choose `coverage` or `doctor` in `/clan` to compare linked people with current Discord membership and OpenFront clan sizes or check roles, permissions, API connectivity and queued work.
- **Role-Based Closed Clan Approvals (`join_role`)**:
  - Assign a Discord role (e.g. `@Mars`) to approve a user to join a closed clan in OpenFront.
  - Automatically notifies clan officers in the log channel with a clickable profile link to invite them in-game.
  - Choose `pending` in `/clan` to inspect who has the role and is waiting for an in-game clan invitation.
- **Reversible Linking**: Users can `/unlink` their verified bot-wide link at any time; queued cleanup removes configured clan roles across servers at a paced rate.
- **Clan Role Synchronization**:
  - Automatically gives configured Discord roles (`Member`, `Officer`, `Leader`) to linked members in the clan.
  - Automatically removes roles when a player leaves the clan.
  - Periodic background sync (configurable interval, default: 10 minutes).
  - Immediate sync by choosing `sync` in `/clan` or when a linked member joins the server.
- **Two-Way Identity Lookup (`/whois`)**:
  - Find an OpenFront profile by Discord user mention or ID (`/whois user:@Alice`).
  - Find a Discord user by OpenFront Public ID or profile URL (`/whois openfront_id:HabCsQYR`).
- **Zero Heavy Dependencies**: Uses Node 22+ built-in `node:sqlite` for fast, lightweight, and robust local persistence.

---

## Commands

### Member Commands

| Command | Description |
|---|---|
| `/link [openfront_id] [token]` | Provide exactly one public ID/profile URL or Identity Token to verify your bot-wide identity. |
| `/unlink` | Remove all your bot-wide and server-only links, including in DMs, and queue clan role cleanup. |
| `/whois [user] [openfront_id]` | Provide exactly one Discord user or OpenFront ID/profile URL. Shows the profile, public ID, linked Discord identity, link scope, clans and account creation date. |
| `/stats [user] [openfront_id] [view] [scope] [mode] [period] [map] [ladder]` | Detailed results for exactly one identity. Choose public/private/singleplayer/all scope, FFA/Team/HvN/Ranked/All mode, a time period and an optional map. Buttons switch between Statistics, Buildings, Game history and Elo, and between Graphs and Numbers. The `view` option sets the initial display; ladder selects 1v1, 2v2 or Ranked FFA Elo. |
| `/dice [sides] [count]` | Roll 1–25 independent secure dice with 1–1000 sides (default 1d6). Five rolling frames run at 600ms each. Shows each result, the total and critical min/max counts; D1 and D2 cannot crit. Four-second per-user cooldown. |

To compare `/stats` with another site or bot, match the account, game mode, match type and reporting units. Teams contains exactly unranked `Team` games; Humans Vs Nations and Ranked have their own modes. Public is the default scope. Use `scope:all` to include all match types for the chosen mode. Recent win rates use an exact matching newest-games aggregate when available. OpenFront's own summary shows several building metrics as **per-game averages**, while this bot labels its building counts as **lifetime totals**. Missing buckets stay unavailable or partial rather than being treated as zero.

### Statistics filters and Elo

Use `/stats openfront_id:re0Umnqe mode:ffa period:30d map:World view:numbers` to inspect one player's recorded FFA performance on World over the last 30 days. Periods are all time, the last 24 hours, 7, 30, 90 or 365 days. Map matching ignores case, spaces and separators.

Unfiltered all-time mode statistics use OpenFront's account counters. A period or map selection uses exact-account game history and reports wins, losses, incomplete matches, completed-game win rate and average completed-game duration. History scans stop after 10 API pages or a time budget; partial samples are labelled, including when no matching map has been found in the scanned pages. Even a fully scanned history is limited to records exposed by OpenFront. Filtered views do not claim period/map building totals because that endpoint does not include them.

The **Buildings** page shows cities, ports, defense posts, factories and missile silos for the selected mode and match scope. Its aligned graphs and exact numbers are **lifetime totals**, even when a period or map is selected. The page states that those filters do not apply to building counters. It stays available when player history is disabled, and all-time Statistics also retains its building rows. Use the **Graphs** or **Numbers** buttons on any page to change the current message without rerunning `/stats`.

The Elo page draws a PNG line graph of **observed official ratings** for separate 1v1, 2v2 and Ranked FFA ladders. OpenFront exposes current public leaderboard ratings but has no documented public Elo history endpoint. Old ratings are not reconstructed from win/loss totals. A new player starts with a point and builds a trend as further observations arrive. Public leaderboard access can return HTTP 403, and a bounded lookup can miss a player outside the scanned pages; these states stay unavailable instead of becoming zero Elo.

Opening Elo can save a current exact-ID observation. With player history and automatic collection enabled, the background worker also rotates through public leaderboard pages for linked current human server members. Observations persist across restarts, keep the latest point per hour and use the configured history retention (90 days by default). Collection failures back off and appear in `/debug action:status` and `/clan action:doctor`. Elo is a global ranked rating; map, ordinary game mode and match-type filters do not redefine it. The period and selected Elo ladder apply to its chart.

### Debug tools (`/debug`)

Choose a separate **debug role** in `/config`. Only members holding that role can use `/debug`, including administrators and the server owner. Clearing the selector disables `/debug`. Manage Server permission or the config role allows changing this setting, with fresh permission checks and protection against overlapping edits.

| Command | Description |
|---|---|
| `/debug action:export_links` | Privately download a JSON snapshot of all linked users currently in this server. |
| `/debug action:status` | Privately show current member/link counts, configured clan count, and pending/retrying role jobs. |
| `/debug action:verbose enabled:true` | Enable clearer error explanations and likely causes for this server. Set `enabled:false` to restore short errors. |
| `/debug action:ephemeral enabled:false` | Make ordinary clan and unlink replies public. Set `enabled:true` to restore their default private replies. |

Verbose mode is off by default and private replies are on by default. Only the configured debug role can change these settings. Settings persist per server; status reports both modes. Verbose output contains actionable explanations for API timeouts, rate limits, access failures, invalid inputs and other errors; raw exception bodies, tokens and stack traces are not shown. Verification, configuration menus, debug tools/JSON exports, and replies rejecting access remain private. Already-created messages keep their original visibility.

The `/stats` lifetime mode tabs show aligned, full-width graphs for wins/losses and buildings built: cities, ports, defense posts, factories and missile silos. Fixed columns inside monospace code blocks align every bar and number. Missing data appears as `N/A`, partial totals end with `+`, and large chart counts use `~` scientific abbreviations; exact available counters remain in lifetime totals. Buildings use the API's built counter, excluding upgrades and captures.

The JSON includes `schema_version`, `exported_at`, server ID/name, member/link counts, and a `users` array containing Discord ID/username/display name, stored OpenFront ID/username, link timestamp, scope, and verification method. IDs remain strings. Verified bot-wide links take precedence over approvals from this server. Departed members and approvals belonging to other servers are excluded. Names are the stored/current snapshot; the export does not call OpenFront. Tokens, credentials, private configuration, and audit history are not exported. Empty results produce a valid JSON file; failed membership reads or an attachment exceeding Discord's limit produce an error instead of a partial file. Access is checked again after fetching membership.

### Clan Management (`/clan`)

Use the single `/clan` command and select an `action`; the remaining inputs are optional and apply to the selected action. Clan actions require the server's selected **config role**, including for administrators and the server owner. Configuration is the exception: **Manage Server permission or the config role** grants access to `/config` and `/clan` with action `config`. To begin, someone with Manage Server opens the menu, chooses a server role and assigns it to the people who should manage clans. Manage Server always allows configuration recovery if the role is deleted or no longer assigned.

| Action | Inputs and description | Permissions |
|---|---|---|
| `/clan action:setup` | Set `clan_tag` and `member_role`; optionally set `officer_role`, `leader_role`, `join_role`, `log_channel`, and `sync_interval`. | Clan access role |
| `/clan action:config` | Open the private GUI; optionally supply `clan_tag` or `page` to view saved settings, three per page. | Manage Server or config role |
| `/clan action:pending` | List pending clan invitations; optionally filter by `clan_tag` and `page`. | Clan access role |
| `/clan action:roster` | Set `clan_tag` to browse linked people currently in this Discord who belong to the clan, with OpenFront rank; optionally set `page`. | Clan access role |
| `/clan action:audit` | View link changes recorded in this server, optionally filtered by `user` and `page`. | Clan access role |
| `/clan action:link` | Set `user` and `openfront_id` to approve a manual link in this server. A verified bot-wide `/link` supersedes it. | Clan access role |
| `/clan action:unlink` | Set `user` to remove a server-only link. Verified bot-wide links can only be removed by their owner. | Clan access role |
| `/clan action:remove` | Set `clan_tag` to remove a clan configuration and queue obsolete role cleanup. | Clan access role |
| `/clan action:sync` | Sync a member or the server; optionally set `user`, `clan_tag`, and `page` (up to ten clan configurations per page). | Clan access role |
| `/clan action:coverage` | Compare current human Discord membership and clan link coverage; optionally set `clan_tag` and `page` (ten clans per page). | Clan access role |
| `/clan action:doctor` | Check live configuration, Discord permissions, OpenFront connectivity and queue health; optionally set `clan_tag` and `page` (five clans per page). | Clan access role |
| `/clan action:recent clan_tag:MARS` | Recent recorded matches and analysis; optionally set `days` (1–14, default 7), `page` (five matches), and `view` (`numbers`, `graphs`, or `both`). | Clan access role |
| `/clan action:summary` | Preview the previous completed week's recap from collected records, with explicit coverage and ranking limits. | Clan access role |

### History configuration and collection

Open `/config` or `/clan action:config`, then choose **Match history / weekly recap**. Clan and player history are enabled by default. Automatic collection and weekly posting start disabled; choose a channel and enable the settings you want, then **Save**. Manage Server permission or the config role grants configuration access. Changes recheck permissions and reject expired or conflicting drafts.

- Toggle clan history commands, player history/Elo, automatic collection, and weekly recaps independently. Enabling weekly recaps enables collection; disabling collection or clearing the destination disables recaps. Disabling player history also clears retained player history and Elo observations, disables period/map analysis and stops player ranking collection for this server. Lifetime profile statistics and `/whois` remain available.
- Choose a server text channel where the bot has View Channel, Send Messages, Embed Links, and Read Message History. Delivery uses persistent period tracking, a deterministic nonce, and recent-message reconciliation to reduce duplicate posts after interrupted acknowledgements.
- **Timing / retention** sets collection intervals (5–1440 minutes), history retention (14–365 days), the weekly send day (0 Sunday through 6 Saturday), hour (0–23), and an IANA time zone. Defaults are every 15 minutes, 90 days retention, and Monday at **12:00 UTC (UTC+0)**. Existing original 09:00 America/Bahia defaults migrate once to 12:00 UTC, preserving other custom schedules and avoiding an immediate duplicate recap. Weekly periods are the preceding completed local Monday–Monday week, respecting the saved zone and daylight saving changes.

Collection initially backfills seven UTC days, then rechecks recent dates for delayed results and corrections. It stores one record per server/clan/game or server/player/game; retrying pages updates records rather than double counting them. Daily windows and opaque cursors persist across restarts. A bounded worker rotates through sources, retries errors with backoff, and operates independently of role cleanup. High-volume servers may need time to finish a backfill; reports explicitly label unchecked coverage. Retention is applied automatically. The daily public deletion feed removes deleted players' history; a missed deletion window clears retained player history before recollection.

Weekly rankings use exact linked account IDs for current human Discord members, matching the clan tag recorded in their public Team sessions. They show most recorded wins and best recorded win fraction with at least three completed games. Records without an end timestamp do not enter rankings. These are activity summaries, not custom tournament-win awards. The API does not supply per-match building totals here, so the recap does not claim weekly cities/ports/buildings built. Unlinking, relinking, member departure, or clan removal invalidates affected retained player data and collection coverage. Existing published messages keep their original content.

Recent clan analysis covers tagged public Team appearances, using the API's recorded result, turnout, team count, and score. A request/time cap may produce a clearly labelled partial sample; its counts describe only fetched records. Analysis does not prove that every tagged player is a current clan member. Player history fetches public account records only when its page is opened, displays up to 100 matches per filter/session in five-game pages, and preserves opaque pagination cursors. Buttons bind to their requester, server, and original message and expire after ten minutes. Unknown and incomplete outcomes remain explicit. No live-match status or guessed spectator/replay links are generated.

`/debug action:status` and `/clan action:doctor` include collection and recap health. Consult the [official OpenFront API documentation](https://github.com/openfrontio/OpenFrontIO/blob/main/docs/API.md) for endpoint coverage; the deployed clan endpoint requires explicit windows of at most one day.

Role changes share a queue with a one-second gap between writes. Unlink cleanup has priority over ordinary sync, and equal-priority work rotates between servers after each write. Cleanup survives restarts, backs off failed jobs without blocking other servers, and rechecks identity and configuration before applying changes. Obsolete ranks are removed before new roles are granted. Public server-sync messages are updated when the run completes, including long runs.

Setup accepts OpenFront tags of 2–5 letters or numbers and checks role hierarchy, duplicate mappings, and log-channel permissions before saving. The GUI saves drafts explicitly, expires after ten minutes, rechecks access, and rejects concurrent edits. API outages leave current clan roles intact. Public profiles and clan information are cached for 15 seconds, with simultaneous requests shared; ownership verification always fetches fresh data.

Coverage excludes Discord bots and departed members. The Discord linked/total count is exact for the fetched membership snapshot. OpenFront's complete clan roster requires account authentication, so clan coverage is the **minimum confirmed linked clan members present in this Discord / OpenFront clan size**. Membership checks examine up to 250 linked people in 90 seconds and clearly mark partial results. Missing statistics are reported as unavailable.

---

## Setup & Installation

Requires Node.js **22.13.0 or newer** (for built-in SQLite). Install dependencies with `npm ci`.

This repository contains only the Discord bot. The desktop control panel is maintained separately. `/link` and `/unlink` manage a verified bot-wide identity. `/clan` with action `link` or `unlink` manages an administrator-approved identity for this server only. Server admins cannot replace or remove a member’s verified bot-wide link.

### 1. Discord Developer Portal Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give your bot a name (e.g. `OpenFront Clan Bot`).
3. Under the **Bot** tab:
   - Click **Reset Token** and copy your **Bot Token**.
   - Under **Privileged Gateway Intents**, enable **Server Members Intent** (required so the bot can see guild members and manage roles).
4. Under the **OAuth2** tab:
   - Copy your **Client ID** (Application ID).
   - Under **URL Generator**, select scopes: `bot` and `applications.commands`.
   - Select bot permissions: `Manage Roles`, `View Channels`, `Send Messages`, `Embed Links`, `Read Message History`.
   - Copy the generated URL and use it to invite the bot to your Discord server.
5. In your Discord server:
   - Ensure the bot's role is positioned **higher** than the clan roles in **Server Settings -> Roles** (Discord requires bots to be higher than roles they manage).

### 2. Environment Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_application_client_id_here
OPENFRONT_API_BASE=https://api.openfront.io
DEFAULT_SYNC_INTERVAL_MINS=10
```

### 3. Register Slash Commands

Deploy the slash commands to Discord:

```bash
# Register globally (available in all servers, takes up to 1h to propagate):
npm run register-commands

# Or register instantly to a specific guild (instant update for testing):
npm run register-commands -- your_guild_id
```

### 4. Start the Bot

```bash
# Build the TypeScript project:
npm run build

# Start the bot:
npm start

# Or run the TypeScript source directly:
npm run dev
```

## Verification and deployment

Run `npm test` to compile and run isolated regression tests. Tests use in-memory or temporary databases and mocked API calls.

`DEFAULT_SYNC_INTERVAL_MINS` must be an integer from 2 to 1440 and is used when `/clan` action `setup` omits `sync_interval`. Existing clan intervals are preserved.

For Linux hosting, install PM2 separately and run `npm run pm2:start` after building. `npm run update` fetches `main`, stages an immutable commit in `.deploy/releases`, installs locked dependencies and tests it while the old bot stays online. It then restarts PM2, verifies that the expected commit and process reached Discord's ready event, registers commands, and saves the process list. A failed health check attempts to restart the previous code. Database files are preserved rather than automatically rolled back.

The GitHub workflow tests the pushed SHA before SSH deployment and deploys that same SHA with serialized production runs. The runtime directory stays at the host checkout so `.env` and relative database paths remain stable. `.deploy/current-commit` identifies the verified running release. After success, a clean canonical checkout is fast-forwarded so manual updates use the current deployment script; a dirty or divergent checkout is left untouched. Keep `.env`, `data/` and `.deploy/` on the host; they are ignored by Git. Deployment sets `BOT_DEPLOY_COMMIT`, `BOT_RELEASE_DIR`, `BOT_RUNTIME_DIR` and `BOT_HEALTH_FILE`; these do not need to be added to `.env`.

Before opening an existing database for migrations, the bot creates a consistent SQLite snapshot, verifies its integrity and retains the newest five snapshots for that database in the adjacent `backups` directory (normally `data/backups`). A failed backup stops migration. New and in-memory databases do not require a snapshot.

Role cleanup uses a persistent queue that removes at most one configured role per second across the bot. Failed Discord role operations retry with increasing delays. Existing legacy admin-created links are quarantined during migration because their original server cannot be determined safely; admins can recreate them as server-scoped links with `/clan` action `link`.
