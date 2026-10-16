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
- **Link History and Clan Rosters**: `/clan audit` shows scoped link changes and `/clan roster` lists verified or approved clan members in the current server.
- **Private Configuration Menu**: Use `/clan config` to edit clans, role mappings, approval roles, log channels and sync intervals with Discord buttons, selectors and forms. Each server chooses its own required clan access role.
- **Player Statistics**: `/whois` includes recorded games, wins, losses, win rate, recent results and available lifetime counters from OpenFront.
- **Link Coverage and Diagnostics**: `/clan coverage` compares linked people with current Discord membership and OpenFront clan sizes; `/clan doctor` checks roles, permissions, API connectivity and queued work.
- **Role-Based Closed Clan Approvals (`join_role`)**:
  - Assign a Discord role (e.g. `@Mars`) to approve a user to join a closed clan in OpenFront.
  - Automatically notifies clan officers in the log channel with a clickable profile link to invite them in-game.
  - Use `/clan pending` to inspect who has the role and is waiting for an in-game clan invitation.
- **Reversible Linking**: Users can `/unlink` their verified bot-wide link at any time; queued cleanup removes configured clan roles across servers at a paced rate.
- **Clan Role Synchronization**:
  - Automatically gives configured Discord roles (`Member`, `Officer`, `Leader`) to linked members in the clan.
  - Automatically removes roles when a player leaves the clan.
  - Periodic background sync (configurable interval, default: 10 minutes).
  - Immediate sync on `/clan sync` or when a linked member joins the server.
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
| `/whois [user] [openfront_id]` | Provide exactly one Discord user or OpenFront ID/profile URL. Shows server-only links only in their server. |

### Clan Management Commands (`/clan`)

Clan actions require the server's selected **config role**, including for administrators and the server owner. Configuration is the exception: **Manage Server permission or the config role** grants access to `/config` and `/clan config`. To begin, someone with Manage Server opens the menu, chooses a server role and assigns it to the people who should manage clans. Manage Server always allows configuration recovery if the role is deleted or no longer assigned.

| Subcommand | Description | Permissions |
|---|---|---|
| `/clan setup <clan_tag> <member_role> [officer_role] [leader_role] [join_role] [log_channel] [sync_interval]` | Configure an OpenFront clan for this server. | Clan access role |
| `/clan config [clan_tag] [page]` | Open the private GUI; supply a tag or page to view saved settings, three per page. | Manage Server or config role |
| `/clan pending [clan_tag] [page]` | List pending clan invitations, 15 per page. | Clan access role |
| `/clan roster <clan_tag> [page]` | Browse linked people currently in this Discord who belong to the clan, with OpenFront rank. | Clan access role |
| `/clan audit [user] [page]` | View link changes recorded in this server, or your own history. | Clan access role |
| `/clan link <user> <openfront_id>` | Approve a manual link in this server. A verified bot-wide `/link` supersedes it. | Clan access role |
| `/clan unlink <user>` | Remove a server-only link. Verified bot-wide links can only be removed by their owner. | Clan access role |
| `/clan remove <clan_tag>` | Remove a clan configuration and queue obsolete role cleanup. | Clan access role |
| `/clan sync [user] [clan_tag] [page]` | Sync a member or the server, up to ten clan configurations per page. | Clan access role |
| `/clan coverage [clan_tag] [page]` | Compare current human Discord membership and clan link coverage, ten clans per page. | Clan access role |
| `/clan doctor [clan_tag] [page]` | Check live configuration, Discord permissions, OpenFront connectivity and queue health, five clans per page. | Clan access role |

Role changes share a queue with a one-second gap between writes. Unlink cleanup has priority over ordinary sync, and equal-priority work rotates between servers after each write. Cleanup survives restarts, backs off failed jobs without blocking other servers, and rechecks identity and configuration before applying changes. Obsolete ranks are removed before new roles are granted. Public server-sync messages are updated when the run completes, including long runs.

Setup accepts OpenFront tags of 2–5 letters or numbers and checks role hierarchy, duplicate mappings, and log-channel permissions before saving. The GUI saves drafts explicitly, expires after ten minutes, rechecks access, and rejects concurrent edits. API outages leave current clan roles intact. Public profiles and clan information are cached for 15 seconds, with simultaneous requests shared; ownership verification always fetches fresh data.

Coverage excludes Discord bots and departed members. The Discord linked/total count is exact for the fetched membership snapshot. OpenFront's complete clan roster requires account authentication, so clan coverage is the **minimum confirmed linked clan members present in this Discord / OpenFront clan size**. Membership checks examine up to 250 linked people in 90 seconds and clearly mark partial results. Missing statistics are reported as unavailable.

---

## Setup & Installation

Requires Node.js **22.13.0 or newer** (for built-in SQLite). Install dependencies with `npm ci`.

This repository contains only the Discord bot. The desktop control panel is maintained separately. `/link` and `/unlink` manage a verified bot-wide identity. `/clan link` and `/clan unlink` manage an administrator-approved identity for this server only. Server admins cannot replace or remove a member’s verified bot-wide link.

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

`DEFAULT_SYNC_INTERVAL_MINS` must be an integer from 2 to 1440 and is used when `/clan setup` omits `sync_interval`. Existing clan intervals are preserved.

For Linux hosting, install PM2 separately and run `npm run pm2:start` after building. `npm run update` fetches `main`, stages an immutable commit in `.deploy/releases`, installs locked dependencies and tests it while the old bot stays online. It then restarts PM2, verifies that the expected commit and process reached Discord's ready event, registers commands, and saves the process list. A failed health check attempts to restart the previous code. Database files are preserved rather than automatically rolled back.

The GitHub workflow tests the pushed SHA before SSH deployment and deploys that same SHA with serialized production runs. The runtime directory stays at the host checkout so `.env` and relative database paths remain stable. `.deploy/current-commit` identifies the verified running release. After success, a clean canonical checkout is fast-forwarded so manual updates use the current deployment script; a dirty or divergent checkout is left untouched. Keep `.env`, `data/` and `.deploy/` on the host; they are ignored by Git. Deployment sets `BOT_DEPLOY_COMMIT`, `BOT_RELEASE_DIR`, `BOT_RUNTIME_DIR` and `BOT_HEALTH_FILE`; these do not need to be added to `.env`.

Before opening an existing database for migrations, the bot creates a consistent SQLite snapshot, verifies its integrity and retains the newest five snapshots for that database in the adjacent `backups` directory (normally `data/backups`). A failed backup stops migration. New and in-memory databases do not require a snapshot.

Role cleanup uses a persistent queue that removes at most one configured role per second across the bot. Failed Discord role operations retry with increasing delays. Existing legacy admin-created links are quarantined during migration because their original server cannot be determined safely; admins can recreate them as server-scoped links with `/clan link`.
