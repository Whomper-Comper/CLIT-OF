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
| `/link [openfront_id] [token]` | Link via OpenFront ID or profile URL (auto-verifies if logged in via Discord), or paste an Identity Token from OpenFront Settings. |
| `/unlink` | Unlink your Discord account and remove associated clan roles. |
| `/whois [user] [openfront_id]` | Look up the linked OpenFront profile or Discord user. Supports URLs and mentions. |

### Clan Management Commands (`/clan`)

| Subcommand | Description | Permissions |
|---|---|---|
| `/clan setup <clan_tag> <member_role> [officer_role] [leader_role] [join_role] [log_channel] [sync_interval]` | Configure an OpenFront clan for this server (supports multiple clans per server). | `Manage Server` |
| `/clan config [clan_tag]` | View current server clan configurations (omit `clan_tag` to view all). | Everyone |
| `/clan pending [clan_tag]` | List members who have the `join_role` and need an in-game clan invite, with direct profile links. | Everyone |
| `/clan roster <clan_tag> [page]` | Browse linked members in this server who belong to the clan, with OpenFront rank. | Everyone |
| `/clan audit [user] [page]` | View link and unlink history for this server, or your own history. | Everyone (own history) / `Manage Server` (others or server history) |
| `/clan link <user> <openfront_id>` | Create a manual link scoped to this server. Members can replace it with a verified bot-wide `/link`. | `Manage Server` |
| `/clan unlink <user>` | Remove a manual link in this server. Bot-wide verified links can only be removed by their owner with `/unlink`. | `Manage Server` |
| `/clan remove <clan_tag>` | Remove a clan configuration from this server. | `Manage Server` |
| `/clan sync [user] [clan_tag]` | Force an immediate clan sync for a member or the entire server. | `Manage Roles` / `Manage Server` (for server-wide) |

Link and unlink role cleanup is stored durably and removes at most one role per second across the bot. If an API update fails, the worker rechecks that the link still exists before changing roles.

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

Run `npm test` to compile and run isolated regression tests. Tests use an in-memory database and mocked API calls.

`DEFAULT_SYNC_INTERVAL_MINS` must be an integer from 2 to 1440 and is used when `/clan setup` omits `sync_interval`. Existing clan intervals are preserved.

For Linux hosting, install PM2 separately and run `npm run pm2:start` after building. `npm run update` pulls `main`, installs locked dependencies, runs tests, registers commands, and restarts the bot. The GitHub deployment workflow runs this script on pushes to `main` using the configured Oracle SSH secrets. Keep `.env` and `data/` on the host; neither is tracked by Git.

Role cleanup uses a persistent queue that removes at most one configured role per second across the bot. Failed Discord role operations retry with increasing delays. Existing legacy admin-created links are quarantined during migration because their original server cannot be determined safely; admins can recreate them as server-scoped links with `/clan link`.
