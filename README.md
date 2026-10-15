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
- **Role-Based Closed Clan Approvals (`join_role`)**:
  - Assign a Discord role (e.g. `@Mars`) to approve a user to join a closed clan in OpenFront.
  - Automatically notifies clan officers in the log channel with a clickable profile link to invite them in-game.
  - Use `/clan pending` to inspect who has the role and is waiting for an in-game clan invitation.
- **Reversible Linking**: Users can `/unlink` their account at any time, which immediately revokes their clan roles.
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
| `/clan sync [user] [clan_tag]` | Sync clan roles immediately (self-sync available to all users; whole-server sync requires permissions). |

### Clan Management Commands (`/clan`)

| Subcommand | Description | Permissions |
|---|---|---|
| `/clan setup <clan_tag> <member_role> [officer_role] [leader_role] [join_role] [log_channel] [sync_interval]` | Configure an OpenFront clan for this server (supports multiple clans per server). | `Manage Server` |
| `/clan config [clan_tag]` | View current server clan configurations (omit `clan_tag` to view all). | Everyone |
| `/clan pending [clan_tag]` | List members who have the `join_role` and need an in-game clan invite, with direct profile links. | Everyone |
| `/clan remove <clan_tag>` | Remove a clan configuration from this server. | `Manage Server` |
| `/clan sync [user] [clan_tag]` | Force an immediate clan sync for a member or the entire server. | `Manage Roles` / `Manage Server` (for server-wide) |

### Admin Commands (`/admin`)

| Subcommand | Description | Permissions |
|---|---|---|
| `/admin link <user> <openfront_id>` | Manually link a member (accepts Public ID or profile URL). | `Manage Server` |
| `/admin unlink <user>` | Manually unlink a member and strip all clan roles across configured clans. | `Manage Server` |

---

## Setup & Installation

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
npm.cmd run register-commands

# Or register instantly to a specific guild (instant update for testing):
GUILD_ID=your_guild_id npm.cmd run register-commands
```

### 4. Start the Bot

```bash
# Build the TypeScript project:
npm.cmd run build

# Start the bot:
npm.cmd start

# Or run in development mode with live tsx:
npm.cmd run dev
```
