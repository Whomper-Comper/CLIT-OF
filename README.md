# OpenFront Discord Clan & Identity Bot (CLIT-OF)

A standalone Discord bot for connecting Discord and OpenFront accounts, synchronizing clan roles, browsing player statistics and match history, and producing optional weekly clan recaps.

The bot uses TypeScript, discord.js 14, and Node.js built-in SQLite. It requires **Node.js 22.13.0 or newer**. The desktop control panel is maintained separately.

For Oracle Linux ARM hosting, use the [Oracle ARM runbook](docs/oracle-arm.md). Node.js with its built-in SQLite driver remains the selected runtime and storage setup.

Coverage reports, weekly recaps and history collection use shared current-human membership filtering. Reports retain fresh roster/identity checks, streamed history aggregation and explicit coverage limits. The action-choice command definitions accept legacy subcommand requests during registration rollout; guild and global registration remain separate operations.

## Documentation

Start with the guide for your role. The detailed references describe the implementation in this repository, including its limits; they do not certify a live deployment or upstream API availability.

| Guide | What it covers |
|---|---|
| [Community playbook](docs/community-playbook.md) | Set up the seven community features, run a first clan night, help newcomers, and recover failed updates |
| [Command reference](docs/commands.md) | Every command and clan action, options, defaults, examples, permissions, visibility, and cooldowns |
| [Server administration](docs/server-administration.md) | First configuration, access roles, clan role mappings, approvals, synchronization, diagnostics, and configuration drafts |
| [Statistics and history](docs/statistics-and-history.md) | Filters, lifetime counters, buildings, partial coverage, observed Elo, collection, weekly recaps, and retention |
| [Installation and operations](docs/operations.md) | Discord application setup, environment variables, Windows/Linux installation, PM2, deployment, backups, recovery, and troubleshooting |
| [Oracle Linux ARM](docs/oracle-arm.md) | Node runtime checks, architecture checks, offline measurement, single-process migration and rollback |
| [Architecture](docs/architecture.md) | Runtime flows, source map, database tables, queues, identity rules, caching, sessions, and reliability boundaries |
| [Development](docs/development.md) | Local workflow, test inventory, targeted checks, and extending commands, settings, and data collection |
| [Agent guidance](AGENTS.md) | Shared instructions for AI agents working locally or from GitHub |
| [Local agent handoff](docs/local-agent-guide.md) | Portable checkout, verification, and publication workflow, with boundaries for related projects |

## What the bot does

- Verifies a member's OpenFront identity using a matching Discord connection or an Identity Token.
- Shares member-verified identity across the bot, while keeping manager-approved identities scoped to one Discord server.
- Maps multiple OpenFront clans and their member/officer/leader ranks to Discord roles.
- Tracks approval-role holders waiting for an in-game invitation to a closed clan.
- Provides compact identity lookup with `/whois` and detailed Statistics, Buildings, Game history, and Elo pages with `/stats`.
- Offers private Discord configuration with explicit Save, expiring drafts, permission refreshes, and conflict checks.
- Reports linked-member coverage, configuration problems, pending jobs, and scoped identity audit entries.
- Optionally collects history and sends scheduled weekly summaries of recorded public Team activity.
- Provides private role-restricted debug status and JSON link exports.
- Rolls secure independent dice with animation, totals, and critical min/max results for dice with at least three sides.
- Coordinates clan nights with local availability, squad signups, reserves, opt-in reminders and newcomer checklists.
- Watches live OpenFront lobbies with saved filters, sends DMs with a server-ping fallback, and stops unless the player continues within three minutes.
- Adds curated hosting challenges, optional milestone announcements, shared bingo with officer-reviewed claims and consent-based dice duels.

## Quick start for hosting

These steps assume you have a Discord application, its bot token and application ID, and permission to invite the bot. The [operations guide](docs/operations.md) covers those prerequisites and production hosting in detail.

### 1. Install and configure

From the repository root:

```sh
npm ci
```

Copy the example configuration:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```sh
# Linux/macOS
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_application_id_here
OPENFRONT_API_BASE=https://api.openfront.io
DEFAULT_SYNC_INTERVAL_MINS=10
```

Keep the token private. Runtime database files default to `data/openfront_bot.db`; `.env`, runtime data, and deployment releases are ignored by Git. The [environment reference](docs/operations.md) explains the optional database path and deployment-managed variables.

Enable **Server Members Intent** for the application, invite it with `bot` and `applications.commands`, and grant the bot **Manage Roles**. Channels used for reports/logs need the appropriate view/send/embed/history permissions. Place the bot's highest role above every role it manages.

### 2. Register commands

```sh
# Testing: register this application's commands in one server
npm run register-commands -- YOUR_GUILD_ID

# Production: register this application's global command set
npm run register-commands
```

Replace `YOUR_GUILD_ID` with the Discord server ID. Registration replaces the application's command set in the chosen scope; it does not start the bot. A nonempty `GUILD_ID` in the environment or `.env` takes precedence over the argument; global registration requires both to be absent. Global registration and guild registration are separate scopes. See [command registration](docs/operations.md) for details and an isolated database option.

### 3. Build and start

```sh
npm run build
npm start
```

For source development, use `npm run dev`. Keep one active bot process against a given runtime database. For Linux production with PM2, follow the [deployment runbook](docs/operations.md).

### 4. Configure your server in Discord

1. Someone with **Manage Server** opens `/config`.
2. Open **Access**, select a **config role** (it saves immediately), and assign it to clan managers.
3. Hold that role yourself before running other `/clan` actions.
4. Configure a clan and its member role through the GUI or `/clan action:setup`.
5. Ask members to verify with `/link`, then run a sync and inspect `/clan action:doctor`.
6. Enable collection/recaps only if wanted, select a destination, and save the history settings.

For example, after choosing the config role and assigning it to yourself:

```text
/clan action:setup clan_tag:MARS member_role:@MarsMember
/clan action:sync clan_tag:MARS
/clan action:doctor clan_tag:MARS
```

The role and tag are examples. The [administration guide](docs/server-administration.md) explains rank mappings, safe edits, approvals, and permissions.

## Command overview

Discord commands below use named options. Multi-action commands use a required `action` choice: for example `/clan action:recent`, `/bingo action:view`, and `/event action:list`. This also applies to `/availability`, `/onboarding`, `/wheel`, `/milestones`, `/lobby`, and `/debug`.

| Command | Purpose |
|---|---|
| `/link` | Verify your bot-wide identity using exactly one public ID/profile URL or Identity Token |
| `/unlink` | Remove your verified and server-only links and queue role cleanup |
| `/whois` | Look up exactly one Discord user or public OpenFront account |
| `/stats` | Browse one account's statistics, lifetime buildings, recorded games, and observed ranked ratings |
| `/dice` | Roll 1–25 dice with 1–1000 sides; defaults to one six-sided die |
| `/event` | Publish sessions, choose squads, join confirmed/reserve places and opt into reminders |
| `/availability` | Privately save weekly local windows and publicly suggest overlap counts |
| `/onboarding` | Follow a private newcomer checklist or review the officer follow-up queue |
| `/wheel` | Spin curated map/settings packages for a human host; officers edit presets |
| `/milestones` | View exact public Team milestones privately; configure opt-in announcements |
| `/bingo` | Share a persistent board using retained observations and private manual claims |
| `/duel opponent:@member` | Invite a current server member to a public, consent-based D6 duel |
| `/lobby` | Save lobby filters and receive DM alerts with fallback pings and three-minute continuation |
| `/config` | Open private server configuration |
| `/clan` | Set up clans, sync, inspect pending approvals/rosters/audits/coverage/health, manage server links, or view history/recaps |
| `/debug` | Inspect status, export current member links, or change verbose/private-reply settings using a separate debug role |

See the [complete command reference](docs/commands.md) for every input and action.

The registry contains 16 commands: the original eight, seven community commands, and the server-only lobby command. Community officers use the manager role or configured clan officer/leader roles; milestone announcement settings require configuration access (Manage Server or manager role). Existing clan/debug access stays independent.

For community setup, configure clan mappings, check destination permissions, then create an event or bingo draft in its intended channel. Availability, onboarding, wheel and duels need no collection toggle. Milestone announcements start disabled; enable and Save in `/milestones action:configure`. Automatic bingo game cells require enabled player-history collection and healthy deletion synchronization; manual claims and availability evidence remain usable independently. Events display Discord timestamps in each reader's local time, reminders are opt-in, and duels save their rolls before displaying results. See [community setup and recovery](docs/server-administration.md#community-release-setup).

### Identity examples

```text
/link openfront_id:PLAYER_ID
/link token:IDENTITY_TOKEN
/whois user:@Alice
/stats user:@Alice mode:team period:7d view:numbers
/stats openfront_id:PLAYER_ID mode:ffa period:30d map:World
/dice sides:20 count:2
```

`PLAYER_ID` and `IDENTITY_TOKEN` are placeholders. Use only your own token for verification. Linking with an ID requires the profile's Discord identity to match the requesting user; merely knowing a public ID is not ownership proof.

## Rules that matter

**Permissions.** Manage Server or the selected config role grants configuration access. Every other `/clan` action requires the selected config role, including for administrators and the server owner. `/debug` requires its separately selected debug role, with no administrator/owner bypass.

**Identity scope.** Verified links work bot-wide and take precedence over server approvals. Managers cannot replace or remove another user's verified link. A server approval never grants ownership across other servers.

**Statistics units.** Unfiltered all-time statistics use profile counters. Period/map results use bounded game-history scans and label partial coverage. Buildings are lifetime built totals for the selected scope/mode, even when a period or map is selected. Incomplete matches do not count as losses in filtered completed-game win rate.

**Elo coverage.** Elo charts contain actual observations collected by this bot, with separate 1v1, 2v2, and Ranked FFA series. There is no reconstructed history before tracking began. Leaderboard HTTP 403 or a bounded lookup miss is reported as unavailable rather than zero rating.

**History and recaps.** Clan/player history are enabled by default; automatic collection and weekly posting are disabled by default. Default retention is 90 days, collection interval 15 minutes, and scheduled delivery Monday at 12:00 UTC. Recaps cover the previous completed local Monday-to-Monday week. They summarize collected tagged public Team activity, with explicit coverage limits.

**Privacy and persistence.** Verification, configuration, debug tools/exports, and access rejections stay private. Other reply visibility depends on the command and server settings. Disabling player history clears that server's retained player history and Elo. Unlink, deletion-feed processing, membership changes, and retention clean up affected data; old published Discord messages and backup snapshots have separate lifetimes.

**Reliability.** Role writes share a paced queue, with unlink cleanup prioritized and failed work retried. Existing nonempty databases receive verified backup snapshots before opening migrations, retaining five snapshots per database. Deployment verifies a process-specific ready marker and attempts code rollback on failure; it does not automatically roll back database data.

Each rule and its practical limits are expanded in the relevant guide above.

## Project scripts

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript into `dist/` |
| `npm start` | Run the compiled bot |
| `npm run dev` | Run TypeScript source with `tsx` |
| `npm run register-commands -- [guild_id]` | Replace guild commands using `GUILD_ID` or an argument; global when neither is set |
| `npm test` | Build, then run all `test/*.test.mjs` files |
| `npm run pm2:start` / `pm2:stop` / `pm2:restart` | Manage the configured PM2 process; PM2 is installed separately |
| `npm run update` | Run the Bash production deployment script; requires its Linux hosting prerequisites |

The [development guide](docs/development.md) describes verification and the test suites. The [operations guide](docs/operations.md) explains logs, readiness checks, migration failures, command registration, rollback, and recovery.
