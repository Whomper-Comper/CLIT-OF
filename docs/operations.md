# Installation, deployment, backups, and operations

This guide describes the behavior implemented in this repository. It does not certify the state of a live Oracle VM, Discord application, GitHub secrets, PM2 daemon, firewall, or upstream OpenFront service. Commands below are operator instructions; documenting them does not mean they have been run against production.

For Discord usage, see [commands](commands.md), [server administration](server-administration.md), and [statistics and history](statistics-and-history.md). For internals and local checks, see [architecture](architecture.md), [development](development.md), and the [README](../README.md).

## Contents

- [1. Runtime requirements and deployment boundaries](#1-runtime-requirements-and-deployment-boundaries)
- [2. Configure the Discord application](#2-configure-the-discord-application)
- [3. Environment variables and paths](#3-environment-variables-and-paths)
- [4. Local installation](#4-local-installation)
- [5. npm command reference](#5-npm-command-reference)
- [6. Registering and updating slash commands](#6-registering-and-updating-slash-commands)
- [7. Linux production deployment](#7-linux-production-deployment)
- [8. Database, migration snapshots, and recovery](#8-database-migration-snapshots-and-recovery)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Routine maintenance](#10-routine-maintenance)
- [11. Team events and reminders](#11-team-events-and-reminders)
- [Milestone worker and recovery](#milestone-worker-and-recovery)

## 1. Runtime requirements and deployment boundaries

- `package.json` requires **Node.js >=22.13.0**. The workflow pins **22.13.0**. The application uses the built-in `node:sqlite` module; a separate database server or SQLite npm binding is not required. Merely having an earlier Node 22 release does not meet the declared minimum.
- Use npm and the committed `package-lock.json`. `npm ci --include=dev` installs the locked dependency tree, including TypeScript and `tsx`, which compilation, tests, and the source registration command need.
- The application can run directly on Windows or Linux. The provided production deployment script is a **Bash/Linux workflow**, requiring Git, Bash, `tar`, `mktemp`, `flock`, Node/npm, and a separately installed `pm2` executable in `PATH`.
- PM2 is not a package dependency. The ecosystem configuration runs one process named **`clit-of-bot`**, with automatic restarts, file watching disabled, timestamped logs, and a `300M` memory restart threshold. Keep a single bot process for this deployment; the local queues and SQLite state are not a multi-instance coordination system.
- The VM needs outbound access to Discord and the configured OpenFront API; it needs repository access for `git fetch` and registry access for `npm ci`. GitHub Actions also needs SSH access to the VM. The bot entry point does not start an HTTP server or expose an inbound health endpoint.
- Give the runtime user write access to the runtime data directory, configured database directory, adjacent backup directory, readiness marker directory, and `.deploy/`. Immutable release directories also need enough disk space for dependencies and build output.

## 2. Configure the Discord application

1. Create or select the Discord application and bot, obtain its bot token, and copy the application/client ID. Keep the token private; the application ID is not the token.
2. Enable the **Server Members privileged intent** for the bot in the Developer Portal. The client explicitly requests `Guilds` and `GuildMembers`. It uses member joins, leaves, updates, full member fetches, role synchronization, coverage, exports, and history eligibility. It does not request Message Content or Presence intents.
3. Install the application in the intended server with the bot and application-command installation scopes (`bot` and `applications.commands`). The install and Discord application settings are managed outside this repository.
4. Grant the bot **Manage Roles**, and place its highest role **above every member, officer, and leader role it must assign or remove**. Role position still matters after granting permissions. Mapping validation rejects `@everyone`, integration-managed roles, missing roles, and unmanageable synchronized roles.
5. Allow **View Channel**, **Send Messages**, and **Embed Links** in configured clan log channels. Weekly recap channels additionally require **Read Message History** for delivery reconciliation. Allow attachments where users will receive PNG statistics charts or JSON exports; attachment failures are separate from clan log permission checks.
6. In Discord, someone with Manage Server opens `/config` to choose the clan access/config role and, optionally, a separate debug role. This is application authorization, separate from the bot's own permissions. Administrators do not automatically bypass the selected role for ordinary `/clan` or `/debug` actions. Manage Server retains configuration recovery access. See [server administration](server-administration.md).

The approval (`join_role`) role is an input signal, rather than one of the membership/rank roles the bot synchronizes. Its mapping must still be a normal server role and distinct from the synchronized roles. The bot does not grant OpenFront clan membership itself; an in-game officer handles invitations.

## 3. Environment variables and paths

Copy [`.env.example`](../.env.example) into a local `.env`, then fill in the values. Do not commit `.env`, bot tokens, SSH keys, real databases, exports, or private control-panel configuration. Git ignores `.env*` except `.env.example`, runtime `data/`, database files and sidecars, `.deploy/`, logs, and the local control panel.

`src/config.ts` calls `dotenv.config()`. Existing process environment values take precedence over values loaded from `.env`. `.env` is located relative to the process working directory; changing the launch directory can select different configuration or a different default database. The deployment keeps the working directory at the canonical host checkout specifically to keep these paths stable.

### Application configuration

| Variable | Default / requirement | Meaning and validation |
| --- | --- | --- |
| `DISCORD_TOKEN` | Required; empty default | Bot token used for Gateway login and application-command REST registration. Validation checks that it is nonempty, not whether Discord will accept it. |
| `CLIENT_ID` | Required; empty default | Discord application ID used for command registration. Runtime startup validates its presence too. Use the ID belonging to `DISCORD_TOKEN`. |
| `OPENFRONT_API_BASE` | `https://api.openfront.io` | Base for all OpenFront requests, including identity-token validation. Trailing slashes are removed. No URL/host allowlist is applied by configuration validation; only use a trusted endpoint. |
| `DEFAULT_SYNC_INTERVAL_MINS` | `10` | Must convert to an integer from `2` through `1440`. Used for new clan setup/drafts when an interval is omitted. Changing it does not rewrite existing saved clan intervals. |
| `DB_PATH` | Absolute `data/openfront_bot.db` under the current working directory | SQLite database location. An explicitly relative value resolves against the process working directory. Parent directories are created. `:memory:` is useful for isolated checks and registration, and loses all state when that process exits. |
| `GUILD_ID` | Unset | Optional command-registration target. A nonempty environment value wins over the first positional argument. Not used to restrict the running bot to one server. |

Only the first five application variables are represented in `.env.example` (`DB_PATH` is commented out). `GUILD_ID` is read directly by the registration entry point. The token, client ID, and sync interval validator also runs when registering commands.

### Deployment and PM2 environment

These are infrastructure inputs, not Discord server settings. Normally let `deploy.sh` set them rather than adding them to `.env`.

| Variable | Source / fallback | Purpose |
| --- | --- | --- |
| `BOT_DIRECTORY` | Optional input to `deploy.sh`; otherwise the script's directory | Canonical host checkout/runtime directory. The workflow sets it because it executes a temporary copy of the target commit's deployment script. |
| `BOT_RUNTIME_DIR` | Deployment sets canonical checkout; ecosystem otherwise uses its own directory | PM2 working directory. Contains the persistent `.env`, default `data/`, and deployment metadata. |
| `BOT_RELEASE_DIR` | Deployment sets the newly staged release; ecosystem otherwise uses its own directory | Selects `dist/index.js` from the chosen immutable release. |
| `BOT_DEPLOY_COMMIT` | Deployment sets full commit SHA; ecosystem fallback is empty string | Written into the readiness marker so deployment can verify the expected code. |
| `BOT_HEALTH_FILE` | Deployment sets `<runtime>/data/bot-health.json`; ecosystem has the same runtime-relative fallback | Readiness JSON file. A direct `npm start` only writes this marker if the variable is supplied. A custom DB location does not automatically move the health file. |
| `NODE_ENV` | Ecosystem sets `production` | Standard process environment label. It is not a substitute for compiling or installing development tools before build. |
| `DEPLOY_SHA` | Workflow injects `github.sha` into the SSH step | Full SHA passed to the remote deployment script, not an application setting. |

Environment changes require a restarted process. The deployment deletes and recreates the PM2 process with `--update-env`; it is preferable to re-run the verified deployment for production changes instead of relying on an old process definition. Avoid printing the entire environment or full PM2 process JSON into shared logs because it can contain credentials.

## 4. Local installation

Start in a checkout of this repository. Replace example filesystem locations with your own. The bot does not include a local control-panel requirement.

### Windows PowerShell

```powershell
Set-Location 'C:\path\to\discord-bot'
node --version
npm --version
npm ci --include=dev
Copy-Item -LiteralPath '.env.example' -Destination '.env'
```

Copy only when `.env` does not already exist; preserve an existing configuration. Edit `.env` in an editor and set at least `DISCORD_TOKEN` and `CLIENT_ID`. Then build, register for a test server, and start:

```powershell
npm run build
$env:DB_PATH = ':memory:'
npm run register-commands -- YOUR_GUILD_ID
Remove-Item Env:DB_PATH
npm start
```

The temporary `DB_PATH` isolates command registration from persistent bot state. If your shell already had a custom `DB_PATH`, save and restore that value rather than removing it. If `GUILD_ID` is already set in your shell or `.env`, it wins over `YOUR_GUILD_ID` above.

For source development, use `npm run dev` instead of `npm start`. Do not run both with the same credentials/database. Stop a foreground instance with Ctrl+C.

### Linux Bash

```bash
cd /path/to/discord-bot
node --version
npm --version
npm ci --include=dev
cp -n .env.example .env
```

Edit `.env`, then:

```bash
npm run build
DB_PATH=:memory: npm run register-commands -- YOUR_GUILD_ID
npm start
```

`cp -n` preserves an existing `.env`; confirm the file contains the intended settings. Restrict access to secrets and data to the runtime account. `npm start` uses `node --no-warnings dist/index.js`, so build first. The Node flag suppresses warnings; it does not fix runtime errors.

### What successful startup means

The module graph opens the database and performs backed-up migration initialization before the entry point finishes validation and Discord login. A startup with invalid credentials can therefore still create database directories or migration snapshots. Avoid using a production `DB_PATH` for exploratory imports and scripts.

After Discord emits `ClientReady`, the bot logs `[Bot] Ready! Logged in as ...`, sets its activity, starts the clan scheduler and history collector, then publishes the optional readiness marker. Clan due checks run every minute; the role cleanup worker checks every 250 ms and also starts immediately. History collection starts immediately and ticks every minute, subject to its persisted settings, budgets, and backoffs.

The marker proves that this process reached Discord readiness and started background services. It does **not** prove a complete sync finished, OpenFront is healthy, every history job succeeded, or weekly messages can be sent.

`SIGINT` and `SIGTERM` initiate shutdown: clear the process's readiness marker, stop clan timers, await the active history collector, destroy the Discord client, close SQLite, and exit. A failed login clears readiness and performs cleanup with a failing exit code. A forced kill or power loss may leave an old marker; deployment rejects markers with the wrong PID, SHA, or start time.

## 5. npm command reference

| Command | Implemented action | Operational notes |
| --- | --- | --- |
| `npm ci --include=dev` | Install the lockfile dependency tree | Requires access to the package registry. Used by CI and release staging. |
| `npm run build` | `tsc` | Compiles TypeScript into `dist/`; does not start or register the bot. |
| `npm start` | `node --no-warnings dist/index.js` | Runs compiled code in the current directory. |
| `npm run dev` | `tsx src/index.ts` | Runs source directly; no watch flag is configured. |
| `npm run register-commands` | `tsx src/deploy-commands.ts` | Bulk-replaces definitions in the selected registration scope. See below. |
| `npm run pm2:start` | `pm2 start ecosystem.config.cjs` | Requires PM2 and compiled code; defaults to the checkout when release variables are absent. |
| `npm run pm2:stop` | `pm2 stop ecosystem.config.cjs` | Stops the configured application. For an immutable deployment, use the explicit name `pm2 stop clit-of-bot` to avoid ambiguity. |
| `npm run pm2:restart` | `pm2 restart ecosystem.config.cjs` | Convenience command; it is not the immutable staging, testing, or readiness workflow. |
| `npm run update` | `bash deploy.sh` | Linux release workflow targeting fetched `origin/main`. |
| `npm test` | Build, then `node --test test/*.test.mjs` | Regression checks; see [development](development.md). For operator runs, explicitly isolate the database. |

Examples for isolated regression checks:

```bash
DB_PATH=:memory: npm test
```

```powershell
$env:DB_PATH = ':memory:'
npm test
Remove-Item Env:DB_PATH
```

Restore a prior shell value of `DB_PATH` if there was one. Neither passing tests nor a successful build proves a deployed bot can log in; deployment readiness is a separate check.

## 6. Registering and updating slash commands

Registration is explicit; `npm start` does not register slash commands. Both paths submit the complete current command array using REST `PUT`, replacing the application's command definitions **in that selected scope**.

| Selection | Result |
| --- | --- |
| Nonempty `GUILD_ID` in process environment or `.env` | Register guild commands for that server; takes precedence over a CLI argument. |
| No nonempty `GUILD_ID`, first positional argument supplied | Register guild commands for that argument. |
| Neither supplied | Register global application commands. |

Linux examples:

```bash
# Fast iteration in a test server (assuming .env has no overriding GUILD_ID).
DB_PATH=:memory: npm run register-commands -- YOUR_GUILD_ID

# Force global registration even if .env contains GUILD_ID.
GUILD_ID= DB_PATH=:memory: npm run register-commands
```

PowerShell global registration:

```powershell
$env:GUILD_ID = ''
$env:DB_PATH = ':memory:'
npm run register-commands
Remove-Item Env:GUILD_ID
Remove-Item Env:DB_PATH
```

Preserve/restore any previous shell values. In environments where PowerShell removes empty environment assignments, remove `GUILD_ID` from `.env` for a global run; otherwise dotenv can load it again. Check the `[Deploy] Registering ...` log before treating registration as global.

The registration script labels guild updates as immediate and warns global updates may take up to one hour. Those are the script's messages, not a live measurement or guarantee of Discord propagation. Refresh the Discord client and confirm the intended application, server, installation, and scope if old definitions remain.

Guild registration does not clear global commands; global registration does not clear guild commands. Old test-guild definitions may shadow or coexist with global definitions. This repository has no dedicated command to remove only a stale guild/global scope; clear the correct scope deliberately through an appropriate Discord administration/API procedure when needed. Do not use another application's client ID to troubleshoot visibility.

Registration imports command modules and their database dependency. Without `DB_PATH=:memory:`, it can open and initialize the configured persistent database. The production script deliberately runs `DB_PATH=:memory: node <release>/dist/deploy-commands.js` after readiness, avoiding that second production database user.

## 7. Linux production deployment

For Oracle Linux 9 ARM64, follow the [Oracle ARM runbook](oracle-arm.md) alongside this workflow. It includes the ANT capability gate and authorized Node fallback, architecture-specific installation, the Oracle SSH account, offline measurements, and single-process database cutover. Linux architecture CI does not deploy the bot.

### Prepare a host

Create the canonical checkout at `~/discord-bot` or `~/openfront-discord-bot` when using the unmodified workflow. Use a dedicated runtime account, Node meeting the declared minimum, npm, Git, Bash, archive tools, and `flock`. Install PM2 separately, for example with the package installation method appropriate to the host:

```bash
npm install --global pm2
command -v pm2
command -v flock
```

Global installation may require account-specific npm configuration or administrative privileges; the repository does not provision these. Ensure the SSH user can invoke the same Node, npm, and PM2 binaries in a noninteractive session. PM2 state belongs to the operating-system account running it: deploying as a different account can address a different PM2 daemon.

Place `.env` in the canonical checkout, not inside a release. Keep `data/`, backups, and `.deploy/` persistent. An absolute `DB_PATH` makes a custom location explicit. Verify repository fetch permissions and the `origin` remote before deploying.

For a simple checkout-based PM2 launch after building, `npm run pm2:start` is available. For the tested immutable-release path, use:

```bash
cd ~/discord-bot
npm run update
```

To target a particular fetched commit:

```bash
bash deploy.sh FULL_40_CHARACTER_COMMIT_SHA
```

The target must resolve to a commit on fetched `origin/main`; abbreviated SHAs and commits outside that ancestry are rejected. The script always fetches `origin main`, even when a SHA is provided. There is no offline deployment mode.

### What `deploy.sh` actually does

1. Selects `BOT_DIRECTORY` or its own directory as the canonical runtime directory; checks for PM2 and `flock`.
2. Creates `.deploy/releases` and obtains a nonblocking exclusive lock on `.deploy/deploy.lock`. A second local deployment exits with `Another deployment is already running.`
3. Fetches `origin/main`, selects the passed full SHA or fetched main SHA, resolves it, and verifies main ancestry.
4. Creates a unique directory such as `.deploy/releases/<sha>.<random>` and populates it with `git archive <sha>`. It does not copy uncommitted checkout files, `.env`, runtime data, or old build output into that release.
5. In that release, runs `npm ci --include=dev` and `DB_PATH=:memory: npm test`. The old running bot remains online during staging. Failure before switching leaves it running; the incomplete release directory may remain on disk.
6. Reads the previous PM2 release path and deploy SHA when a `clit-of-bot` process exists. Sets runtime, release, commit, and health environment values for the new process.
7. Installs the error trap, records the switch start time, deletes the previous PM2 definition, and starts the new release's `ecosystem.config.cjs` with `--update-env`. Replacing the definition prevents PM2 from retaining an old script path. This is a restart with a period of bot unavailability, not a zero-downtime handoff.
8. Polls up to 60 times, sleeping two seconds between unsuccessful checks. The marker must contain the expected SHA, the current PM2 PID as a positive safe integer, and a parseable `readyAt` at or after this deployment's start, no more than five seconds into the future. It fails with a two-minute readiness message if no check passes; command overhead can add elapsed time.
9. Registers compiled slash commands with an in-memory database. Scope still follows `GUILD_ID` from the runtime environment/`.env`; absent that, registration is global.
10. Runs `pm2 save`, writes `.deploy/current-commit` and `.deploy/current-release`, and removes the error trap. These files describe the last verified successful deployment.
11. Attempts to fast-forward the canonical checkout to the verified commit only if the checkout is clean. A dirty, divergent, or otherwise non-fast-forwardable checkout is left untouched with a warning; the verified release keeps running. This step keeps the manual `npm run update` entry point current without making the checkout the executed release.

Tracked source edits in the canonical checkout are not deployed. Commit and make them available on `origin/main` through the normal review process first. An untracked nonignored file can also make the checkout dirty; ignored `.env`, `data/`, and `.deploy/` are intended to remain local.

### Failure and rollback semantics

After the switch trap is installed, a failing start/readiness check, registration, `pm2 save`, or deployment metadata write triggers the rollback handler. It reports that database and migration backups are preserved. If the prior release has an ecosystem file, it deletes the new process and **attempts** to start prior code with the previous release/commit environment. Otherwise, it attempts to stop the bot. The original deployment exits with failure.

Rollback is best effort: its PM2 commands are allowed to fail, it does not run a second readiness verification for the old code, and it does not save a new PM2 dump in the handler. Inspect PM2 and logs after every failed deployment. `.deploy/current-*` are success metadata, not an authoritative live-process probe, especially after a partial metadata-write failure or manual intervention.

**There is no automatic database rollback.** New code may have migrated or updated the persistent database before readiness fails. Old-code compatibility with that resulting schema must be checked. Command registration is also external state: code rollback does not automatically re-register the previous command definitions if a later deployment step fails.

For a deliberate code rollback, after checking database compatibility, deploying a known-good full SHA through `bash deploy.sh SHA` reuses staging, tests, readiness, and that SHA's command registration. It must remain an ancestor of `origin/main`. Using `npm run pm2:restart` from the canonical checkout is not equivalent to selecting a verified release and may change the executed path; prefer the deployment script.

### GitHub Actions deployment

[The deployment workflow](../.github/workflows/deploy.yml) runs **only by manual dispatch** from GitHub Actions. Pushing or merging into `main` does not deploy the bot. The separate Linux architecture verification workflow still runs on pushes. To deploy deliberately, select **Deploy Bot to Oracle Cloud** in Actions and use **Run workflow** on the intended branch. The deployment workflow grants repository contents read permission, serializes production runs under `production-bot-deployment`, and does not cancel an already running deployment. The job has a 15-minute timeout; the SSH command has a ten-minute timeout.

| Repository secret | Required / fallback | Use |
| --- | --- | --- |
| `ORACLE_HOST` | Required | VM SSH hostname/address. |
| `ORACLE_USERNAME` | Falls back to `ubuntu` | Remote runtime/deployment account. |
| `ORACLE_SSH_KEY` | Required | Private SSH key authorized on that account. |
| `ORACLE_PORT` | Falls back to `22` | SSH port. |

The bot's `.env` remains on the VM. `DISCORD_TOKEN` and `CLIENT_ID` are not named GitHub secrets in this workflow. Repository fetch authentication on the VM is a separate host responsibility; the Actions SSH key does not automatically grant Git repository access.

The job checks out `github.sha`, installs Node 22.13.0 and locked dependencies, and runs `npm test` with an in-memory DB. It injects that same SHA as `DEPLOY_SHA` into SSH, checks its shape, enters `~/discord-bot` or falls back to `~/openfront-discord-bot`, fetches main, writes `git show "$DEPLOY_SHA:deploy.sh"` to a temporary file, and runs it with `BOT_DIRECTORY="$PWD"`. Thus the remote deployment logic comes from the tested target SHA, even when the canonical checkout is older. Tests run again on the host's staged release.

The repository does not establish that these secrets exist, the SSH key works, the remote checkout is current, or an actual production deployment has passed. Inspect the specific workflow run and host process before claiming production success.

### PM2 persistence and inspection

Useful commands under the runtime account:

```bash
pm2 status
pm2 describe clit-of-bot
pm2 logs clit-of-bot --lines 100
cat .deploy/current-commit
cat .deploy/current-release
```

Treat process descriptions and logs as potentially sensitive. PM2's local logs are the process log destination; no explicit `out_file`/`error_file` paths or log-rotation policy are configured in the ecosystem file. `pm2 describe` can identify the local files. Do not publish raw dumps.

The deployment calls `pm2 save`, which saves the process list. **Reboot startup still requires host configuration.** Follow the host's PM2 startup setup, commonly beginning with `pm2 startup`, apply the account-specific instruction it prints, and save the correct process list. The repository does not install or verify that service. Recheck the running script/release and Discord readiness after a controlled restart or reboot.

## 8. Database, migration snapshots, and recovery

### What must persist

The SQLite database holds more than links: clan mappings, server access/debug settings, link audit records, persisted role work, history settings/jobs, retained match/Elo observations, and weekly delivery state. Treat it as private operational data. A JSON link export is useful for review but is **not** a full backup or an implemented restore/import format.

Normal default layout:

```text
<runtime>/
  .env
  data/
    openfront_bot.db
    backups/
      openfront-<path-hash>-<UTC-time>-<uuid>.db
    bot-health.json
  .deploy/
    releases/<commit>.<random>/
    current-commit
    current-release
    deploy.lock
```

SQLite may have journal/WAL/shared-memory sidecars depending on activity and database mode. A raw copy of only a live main database is not a safe general snapshot. The backup implementation explicitly accounts for committed WAL contents.

### Automatic pre-migration snapshots

`BotDatabase` calls `backupDatabaseBeforeMigration` **on each construction for an existing nonempty file**, before opening its write connection and migration transaction. This is not limited to releases that detect schema changes. A restart or an unisolated command-registration import can therefore create another snapshot and rotate older snapshots.

The helper:

1. Skips `:memory:`, empty paths, missing files, and zero-byte files.
2. Creates an adjacent `backups/` directory by default (for a custom database, beside that database, not necessarily under runtime `data/`). Requests mode `0700` for the backup directory.
3. Opens the source read-only with a five-second busy timeout, then uses SQLite `VACUUM INTO` to create a standalone `.partial` snapshot including committed WAL contents.
4. Requests snapshot mode `0600`, opens it read-only, and requires exactly one `PRAGMA integrity_check` result of `ok`.
5. Atomically renames the validated temporary file to `.db`. On snapshot failure, removes the partial file and stops migration with `Could not back up the database before migration. The migration has been stopped.`
6. Retains the newest **five** snapshots for that database by default, rotating only matching path-hash-prefixed `.db` files. Other databases' snapshots and unrelated files are preserved. The helper accepts a retention option of 1–100 and a directory option, but these are not environment settings exposed by the bot.

Permission modes are requested through Node filesystem calls; actual protection depends on the operating system and filesystem, particularly Windows ACLs. Backup directories are local to the same storage by default, so they do not protect against loss of that disk or host. Copy verified backups to access-controlled off-host storage under an operator retention policy. No scheduled independent off-host backup or release-directory cleanup is implemented.

Migrations run in `BEGIN IMMEDIATE`/`COMMIT`, with rollback on a thrown migration error. Historical global `admin_manual` links lack server provenance: migration quarantines them in `legacy_manual_links`, records `legacy_manual_revoked`, queues cleanup, and removes them from active global links. Recreate legitimate approvals in the intended server with `/clan action:link`; do not bypass that migration by editing the database blindly.

### Make an explicit verified snapshot

From a built checkout/release, the helper can be invoked without importing the bot's database singleton:

```bash
node --input-type=module -e 'import { backupDatabaseBeforeMigration } from "./dist/backups.js"; console.log(backupDatabaseBeforeMigration(process.argv[1]));' /absolute/path/to/openfront_bot.db
```

PowerShell uses the same single-quoted JavaScript argument:

```powershell
node --input-type=module -e 'import { backupDatabaseBeforeMigration } from "./dist/backups.js"; console.log(backupDatabaseBeforeMigration(process.argv[1]));' 'C:\absolute\path\to\openfront_bot.db'
```

Use the actual effective database path; this helper does not read `.env` or choose `CONFIG.DB_PATH`. A returned `null` means no snapshot was created. A returned filename is the validated snapshot. A failed or busy backup needs investigation, not a fallback to copying a live `.db` alone. This invocation uses the normal five-snapshot retention, so copy important recovery points out before repeated startup/backup runs rotate them.

### Safe manual restore

Restoring loses updates after the snapshot, including link changes, permission settings, queues, collected history, and delivery records. A historical delivery state can cause attempted recap reconciliation/re-delivery; a historical link can authorize an old identity again. Review the chosen recovery point with those consequences in mind. A restored older schema may be migrated again by the next startup.

1. Pause automatic deployments and any other process that can start this bot. Record the selected code SHA and the actual effective database location. Stop `clit-of-bot` (`pm2 stop clit-of-bot`), or stop the foreground process, and verify it stays stopped. Also stop development instances or utilities using this database. Do not run registration against the disk database during recovery.
2. Choose a known verified snapshot and copy it to a **separate candidate file**, outside the live database filename. Keep the original backup unchanged. Preserve the current database and any `-wal`, `-shm`, and `-journal` sidecars together in a separate incident/recovery folder before replacing anything.
3. Verify the candidate read-only. From a Node installation meeting the engine requirement:

   ```bash
   node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1], {readOnly:true}); try {const rows=db.prepare("PRAGMA integrity_check").all(); console.log(rows); if(rows.length!==1 || rows[0].integrity_check!=="ok") process.exitCode=1;} finally {db.close();}' /absolute/path/to/restore-candidate.db
   ```

   In PowerShell, use the same command with a quoted Windows candidate path. Integrity verification does not verify that this is the intended server data or that the chosen code understands its schema.
4. With **every writer stopped**, move the current database **and each existing matching sidecar** to the incident folder. Use explicit paths; do not move an entire shared `data/` directory or discard its backups. Put a copy of the verified standalone candidate at the exact configured database filename. Do not leave sidecars from the previous database beside the restored file. Preserve the incident copy and the source backup until recovery is confirmed.
5. Ensure the runtime account owns/can read and write the restored file and its parent directory. Keep the configured `DB_PATH` unchanged unless intentionally relocating storage. For a relocation, remember that backup prefixes depend on the absolute database path and the default backup directory changes with it.
6. Start the selected compatible code once. For an immutable deployment, deploy the intended known-good SHA through the normal script when the repository/network are available; it will build/test, open/migrate the restored DB, verify readiness, and register that SHA's definitions. An initial snapshot of the restored DB is expected.
7. Check logs for migration errors, confirm Discord readiness, use `/clan action:doctor` and `/debug action:status` with authorized roles, and verify representative links, clan mappings, queues, collection settings, and recent records. Re-enable deployments only after this review.

There is no bundled one-command restore, downgrade migration, or automatic database selection. If a backup fails integrity checks, preserve it for diagnosis and select another verified recovery point. Do not repeatedly restart a failed migration until disk permissions, capacity, locks, and the underlying error are understood.

## 9. Troubleshooting

Start with the failed operation, timestamp, affected server, expected behavior, and whether the issue affects all users or one configuration. Keep tokens and private exports out of tickets. Server-level diagnostics and host-level deployment health answer different questions.

### Startup and command visibility

| Symptom | Checks and next action |
| --- | --- |
| `Missing environment variables: ...` | Confirm `.env` exists in the effective working directory and required values are nonempty. A shell value overrides `.env`. Check names without printing token values. |
| Invalid sync interval error | Use a whole number from 2 to 1440. Registration validates this too. |
| `node:sqlite` unavailable or startup syntax/module error | Confirm the actual Node binary used by the shell/PM2 meets >=22.13.0; check dependencies and build output. A different SSH `PATH` may select another Node installation. |
| `dist/index.js` missing | Run `npm ci --include=dev` and `npm run build` in a local checkout, or investigate failed release staging. Source edits alone do not update compiled code. |
| `[Bot] Login failed` / bot never becomes ready | Check token validity, application identity, enabled Server Members intent, and outbound Discord connectivity. PM2 being online is not sufficient. |
| Bot online, commands absent/stale | Registration is separate from startup. Check application ID/token pairing, installation scopes, global/guild target, `GUILD_ID` precedence, stale test-guild definitions, and Discord client refresh/propagation. |
| Application does not respond | Inspect process logs, restart loops, permissions and API/storage failures. Interaction error replies can also fail when the interaction expired or Discord is unavailable; the handler intentionally suppresses failures of that final reply attempt. |

### Role synchronization and access

- Use `/clan action:doctor` to refresh roles, bot membership, Manage Roles, role positions, log-channel permissions, clan API connectivity, queue status, and scheduled-sync age. It is read-only. With no configured clan, its clan API connectivity check has no target and cannot establish upstream health.
- Use `/debug action:status` to inspect pending/retrying role work and history/Elo collection issues. The configured debug role is required. A Manage Server user can repair access-role configuration through `/config`; merely being an administrator is not an override for ordinary role-gated actions.
- Discord code `50013` means missing permissions; check hierarchy as well as Manage Roles. `50001` means missing access; check bot installation and channel access. `10007` can mean the member left. `50035` points to an invalid response/attachment shape or platform limit.
- A deleted role or channel needs remapping. Channel-specific overwrites can block a bot whose server permissions look correct. For recap delivery, check Read Message History as well as view/send/embed permissions.
- Role writes share a lane with at least one second between completed write tasks. Persisted cleanup removes one role per turn, rotates across servers, and prioritizes identity unlink cleanup. Large backlogs take time; rapid manual syncs do not make Discord writes instantaneous.
- Failed persisted role jobs keep their error, increment attempts, and retry with exponential delay starting at one minute and capped at one hour. Fix the underlying cause and allow the queue to retry. Avoid deleting jobs as a substitute for fixing permissions: that can leave stale roles in place.
- Scheduled clan sync checks once per minute and honors each saved interval. A recent manual action does not prove the periodic worker is healthy. Doctor warns when a scheduled sync is older than the larger of 15 minutes or three configured intervals.

### OpenFront errors and rate limits

- OpenFront requests have a 15-second timeout. Network/DNS failures, HTTP rejection, invalid JSON, and unexpected response shapes are distinct failure classes internally. Public reads share pending requests and normally cache successful results for 15 seconds (up to 500 entries); a just-changed upstream profile may therefore be briefly stale. Verification uses fresh reads where the code requests them.
- **HTTP 403 on the public ranked leaderboard** means the endpoint blocked access. The Elo command explains that it cannot refresh until the endpoint permits access and preserves existing observations. A clan doctor check against the public clan endpoint can pass while ranked leaderboard access fails; it is not an endpoint-wide health check.
- A leaderboard scan has bounded coverage. Not finding a public ID is unavailable data, not zero Elo, and does not prove a player has no rating. See [statistics and history](statistics-and-history.md).
- **HTTP 429** means upstream rate limiting. Wait and reduce repeated commands. The API wrapper does not implement a universal immediate retry loop for every HTTP request. Persisted history jobs and Elo collection have their own backoffs, and command cooldowns reject bursts before expensive work.
- Identity-token validation handles HTTP 400/401/403 as unsuccessful audience attempts and tries the configured candidate audiences; those statuses on that specific endpoint should not automatically be diagnosed as the same leaderboard access problem. Tokens must never be copied into logs or support messages.
- History collection is separately bounded (normally eight API-request units per minute tick), with persistent cursors and retries. Deleted-player synchronization must be healthy for player collection/Elo work that depends on it; some player work pauses safely when that prerequisite fails. The health marker is not updated to reflect these later upstream failures.
- Enable server verbose errors through authorized `/debug action:verbose enabled:true` when a clearer user-facing explanation helps. Raw exception bodies, tokens, SQL and stack traces are not intentionally exposed in those replies. Check host logs for unexpected failures rather than assuming every expected API rejection is logged as an exception.

### Deployment and infrastructure failures

| Symptom | Interpretation / action |
| --- | --- |
| `PM2 must be installed...` / missing `flock` | Install/provide required host tooling to the actual deployment account and noninteractive `PATH`. |
| `Another deployment is already running.` | Local `flock` is held by an active deployment. Inspect that job; deleting the lock pathname is not a safe way to release an active file lock. |
| SHA/ancestry rejected | Use a full 40-character commit from fetched `origin/main`; verify the remote and whether the requested commit belongs to main history. |
| CI succeeds, SSH fails | Check `ORACLE_*` secrets, SSH reachability, username/key/port, host account permissions, and required checkout location. CI success alone does not demonstrate VM access. |
| Dependency install/fetch fails on VM | Check repository/registry connectivity, authentication, DNS, disk space, and the host's Node/npm versions. Staging failure before the switch leaves prior code online. |
| New process times out on readiness | Check login/intent/DB errors, PM2 PID and executed script, readiness path permissions, and available disk. The checker intentionally rejects stale or wrong-process markers. Investigate the attempted rollback too. |
| Post-ready deployment fails | Registration and `pm2 save` can still fail and trigger code rollback. Check which SHA is actually running and which command definitions reached Discord. |
| Canonical checkout warning after success | New immutable release is running, but the local checkout could not fast-forward. Preserve local edits, reconcile intentionally, and confirm the manual deployment entry point before the next update. |
| Repeated PM2 restarts | Check logs and memory/storage/Node failures. `300M` is a PM2 restart threshold, not a configured host RAM reservation. A readiness marker is not a memory or uptime monitor. |
| Bot missing after reboot | Check host startup-service configuration and the runtime account's saved PM2 process list. The deployment saves PM2 state but does not install a startup service. |

### Storage failures

- `SQLITE_BUSY` / `ERR_SQLITE_BUSY`: connections use a five-second busy timeout. Check for accidental extra bot processes, unisolated registration/imports, utilities holding writes, filesystem issues, and genuinely long-running work. Repeated rapid restarts can add contention.
- Backup/migration failure: check disk capacity, backup-directory permissions, source integrity, and locks. Backup failures are intended to prevent migration; do not disable the backup to get past the error.
- Empty new database after a restart: first check current working directory and `DB_PATH`. Starting from a different directory can create another database while the original remains intact. Stop the unintended process before changing paths.
- Missing history: check retention, collection switches, current membership/link eligibility, deletion synchronization, and source availability before assuming corruption. Retained observations and collected windows are not an unlimited archive of all historical OpenFront data.
- Weekly recap absent: check collection/weekly settings, local schedule/timezone, source completeness, channel permissions, and delivery retry status. See [statistics and history](statistics-and-history.md) for schedule and delivery semantics; restarting is not an instruction to send every past recap.

## 10. Routine maintenance

1. Monitor both process health and application work: PM2 status/restarts, readiness after deployment, doctor output, retrying role/history jobs, Elo errors, and recap delivery status. The readiness file is a startup attestation, not a continuously refreshed heartbeat.
2. Keep off-host verified database snapshots and an intentional retention policy. Test recovery against a separate database path and isolated test credentials/environment; never launch a recovery rehearsal as a second production bot.
3. Watch disk usage in database/history storage, `backups/`, `.deploy/releases/`, dependencies, and PM2 logs. The script does not prune release directories, and the ecosystem file does not configure log rotation. Preserve the active release, a compatible rollback release, and backups needed for recovery before cleaning unused material.
4. Keep the canonical checkout usable for updates. Ignored runtime files belong there; tracked/untracked working changes should be preserved and reconciled intentionally. Check `.deploy/current-*` alongside PM2's actual script path.
5. Review Node/npm/PM2 and dependency updates deliberately. Install the lockfile, run regression checks in isolation, and deploy through readiness verification. Node's minimum declaration is not a promise that every future version has been tested by this repository.
6. Review bot role position and channel overwrites after Discord administration changes. Review selected config/debug roles and their membership. Rotate compromised credentials through their owning service and restart/redeploy with the updated private configuration.
7. After upgrades, exercise a representative member command, configuration access, one clan sync, and enabled history/recap diagnostics. Local tests cover backup WAL consistency, retention isolation, backup failure, readiness marker ownership, migration behavior, and queue reliability; they do not replace live infrastructure checks.

Implementation references: [configuration](../src/config.ts), [startup/shutdown](../src/index.ts), [registration](../src/deploy-commands.ts), [deployment script](../deploy.sh), [PM2 configuration](../ecosystem.config.cjs), [workflow](../.github/workflows/deploy.yml), [readiness writer](../src/deploymentHealth.ts), [readiness checker](../tools/check-deployment-health.mjs), [backups](../src/backups.ts), [database initialization](../src/db.ts), and [backup/readiness regression tests](../test/backups.test.mjs).

## 11. Team events and reminders

Community officers create and manage events through `/event action:create` and `/event action:edit id:…`. Check the interpreted local date, UTC offset and Discord timestamp in the private preview before selecting Publish. A draft is saved before delivery; reopening management shows up to five unresolved publication, card-update or reminder jobs. `/event action:view` links to the canonical signup card. Its participant pages show twenty people at a time with full confirmed/reserve counts.

Reminders are off by default. An officer may choose a lead of 15, 30 or 60 minutes; each member must separately opt in using Reminder on that event's card. Only currently confirmed, opted-in, present human members can be mentioned. Reserves, withdrawals, departures and disabled choices are filtered again before sending. Reminders stay in the event channel; none are sent by DM. Long recipient lists use stable parts of at most forty people. A later promotion does not move recipients between already queued parts.

Signups close exactly at the saved start instant, even if a public card has not refreshed yet. The minute worker queues disabled controls at start and marks an event finished at its end. Editing an event invalidates its old reminder revision; cancellation closes signups, cancels reminders and queues a card update. A reminder discovered at or after start is skipped. Large queues may take multiple bounded ticks to drain, and request-budget deferral does not consume a delivery attempt.

For a paused job, repair channel access, View Channel, Send Messages, Embed Links and Read Message History as appropriate, then use **Retry / reconcile** in event management. An uncertain send or interrupted send lease requires reconciliation against recent bot messages. The worker binds a proved original post, or edits a known canonical card. If it cannot establish the prior outcome, the job remains Needs review and no second event is automatically posted. Preserve the existing message while investigating; repeated retries are not a way to force a duplicate. An accepted post whose database binding failed also requires review. Recovery is bounded to the most recent 100 channel messages and cannot promise exactly-once delivery.

Departure removes active signups and schedules fresh-membership reserve promotion. The worker shares a roster read across that server's promotion batch and uses targeted fresh member reads for reminder recipients. Ended events and signups remain for ninety days after the event's actual end; cancelled events use their cancellation time. Cleanup starts only after that exact boundary and drains bounded child batches, so very large reserve lists may remain slightly longer. Older cancellation records upgraded from the earlier schema conservatively use the saved event end because their original cancellation time was not recorded. Removing the server clears its community event records. Published Discord messages have a separate lifetime and are not deleted by database retention.
## Milestone worker and recovery

Milestone polling and delivery run in the existing community worker with its shared defaults of eight external validation/profile requests and four sends per tick. Guild work rotates, and persisted per-member attempts/backoff prevent one failing profile from blocking later members. A separate durable account gate spaces automatic profile polling by at least 15 minutes across servers and restarts; it stores only account/origin server/member IDs and next-attempt time, expires in bounded batches, and follows personal-data cleanup. A globally blocked account does not consume its server's failure/backoff reservation.

Same-tick raw profile evidence is shared across eligible servers and delivery prepares for at most 60 seconds from request start. Discord membership is freshly checked at delivery boundaries, and current identity, candidate generation, settings revision, configured clan and deletion health are revalidated after awaits. Profile evidence that expires during a slow request safely defers work. Queued delivery/recovery may perform a separate fresh clan-eligibility profile lookup inside the 15 minute polling interval; it shares the request budget and does not observe counters or alter polling cadence. Explicit private view refreshes are also separate from automatic polling.

Milestone-only servers still request the deletion feed using the history collector's existing budget without enabling match collection. Missing, stale (24 hours) or failed deletion health suppresses automatic milestone polling and defers queued cards. Temporary missing clan evidence retries; confirmed clan departure or a stale identity/settings binding cancels the obsolete delivery. Earned cards survive ordinary delivery failures. Use `/milestones action:configure` privately to inspect diagnostics and deliberately retry/reconcile after resolving permissions or checking an uncertain outcome.

## Shared bingo operations

Bingo joins the existing minute community worker and request/send budgets. Each invocation visits at most four active boards using a fair keyset cursor and processes one persisted source page of at most 200 rows per board. Full human roster fetches consume the shared request budget; effective links, deletion suppression, configured tags and actual clock are reread after awaits. No extra OpenFront profile requests are made. Source changes abandon/restart partial stages; only complete generations finalize atomically. Clean sources skip retained-history page reads. Stop clears worker continuation IDs, and abandoned/retired persisted stages drain through existing bounded cleanup.

Initial `bingo_publish` jobs bind their saved revision/message atomically with delivery finish, including reconciliation. `bingo_update` edits the canonical card; state changes coalesce unsent updates. `bingo_complete` validates the current line/board at each delivery boundary. Three roster requests are reserved for preparation and channel/message/reconciliation revalidation. Dirty automatic evidence and request-budget exhaustion defer completion without consuming an attempt; manual-only lines remain usable with collection off. Roster failure produces an unavailable card with automatic cells hidden. Historical notification keys survive corrections/retention so line regain never posts twice.

Use `/bingo action:create` to recover unpublished drafts and `/bingo action:review` for active-board diagnostics, then **Retry / reconcile** after repairing View Channel, Send Messages, Embed Links or Read Message History as appropriate. An accepted message whose database binding fails becomes Needs review. Deliberate reconciliation checks recent bot-authored markers and binds the proven message without reposting. An uncertain outcome that cannot be proven stays reviewable; exactly-once delivery across Discord and SQLite is not promised. Reset requires explicit confirmation, cancels prior-board work and starts a fresh notification namespace. No automatic reset occurs at closure.

## Dice duel delivery and recovery

The registry exposes 16 commands, including lobby alerts. Local build/tests do not update Discord registration; registration, bot startup and deployment are separate deliberate operational steps. Community features add no dependency or service process and retain Node.js >=22.13.0 and the existing backed-up database initialization.

`duel_publish` persists with invitation creation before any public request. The shared worker publishes disabled controls, atomically binds the accepted/reconciled canonical message with delivery completion, then queues `duel_update`. Each publication/edit counts against the existing four outbound operations per minute. No duel background member/API fetches are added; command actions fetch both members together once, then check live state/binding and consent synchronously after that await. Departure invalidates matching in-flight membership snapshots, including commands that have not created an invitation yet.

The optional synchronous `CommunityDeliveryHandler.beforeDeliver(job, now)` runs after all awaited channel/message lookups immediately before the request. It rechecks canonical target, lease, stop state and current state; a changed target cannot be sent. Duel activation uses this boundary to persist `activated_at` once and replace `expires_at` with activation + 120,000ms before rendering the enabled payload. The original creation + 120,000ms remains the hard bound for unactivated publication/activation waiting. Retry/reconciliation never resets activation. This permits almost four minutes from command to final acceptance deadline; an enabling request reduces the usable window by its duration. Backlogged invitations not activated within their original wait deadline expire and advise `/duel` retry. No extra worker runs or larger budgets are used.

Resolve/decline/cancel, sweep expiry, lazy expiry during new invitation/actions, and member closure all enqueue canonical updates in the same savepoint as the state change. Two saved D6 results precede every result display; Refresh retries the stable revision job and reads those rolls after restart without drawing again. Permission failures pause. A failed initial publication remains pending only until its hard wait deadline; concurrent command/rematch requests cannot allocate another invitation for its participants. Ambiguous publications use stable markers/nonces and reconciliation, with unproven outcomes left Needs review rather than blind reposting. Known message updates edit that same ID and never create replacement invitations.

Uncertain initial publications remain eligible for marker reconciliation after their two-minute wait expires or a participant departs, including when a five-minute Sending lease is reclaimed. Normal preparation retains only a recovery payload; the final delivery boundary forbids a fresh send for an unbound terminal invitation or closure. A proven bot-authored marker binds the original message and queues its expired/retry or generic closed edit. Missing or non-bot markers leave Needs review across deliberate retries without publishing another card or reviving consent.

Departure deletes pending personal invitation data and slots while retaining only duel ID, guild/channel/message, revision and closure time in `community_duel_closures`. A departure during an already-started publication can bind that accepted message to the generic closure and queue its closing edit. Pending snapshots cannot recreate removed consent. Closure and terminal retention drain at most 200 each per prune pass using indexed timestamps; guild removal clears both and its delivery jobs. OpenFront unlink/account/history cleanup preserves account-independent duels. Already published Discord messages have a separate lifetime.

## Lobby feed operations

Lobby alerts use OpenFront's public `https://api.openfront.io/cluster.json?site=openfront.io` discovery and a single compatible server's `/w0/lobbies?platform=web` WebSocket. The adjacent game checkout is not a runtime dependency. The feed has a 30-second freshness limit, reconnect backoff of 3–60 seconds, and rejects unsupported builds or draining deployments. Cloudflare/access failures appear as unavailable discovery in `/lobby action:list` and `/lobby action:configure`; they do not generate fabricated matches. Live HTTP verification encountered a Cloudflare challenge. The binary fixtures are synthetic messages encoded by the same source-derived codec that decodes them, so they exercise that codec but do not independently establish interoperability with an upstream encoder or a live server.

The lobby wire protocol is positional binary and changes with the game build. The checked-in decoder is generated from the upstream revision in [vendor provenance](../src/lobby/vendor/NOTICE.md), with some definitions supplied by the generator. After an upstream deployment, maintainers must verify and regenerate the codec/fixtures against its full commit SHA:

```sh
node tools/vendor-lobby-codec.mjs FULL_OPENFRONT_COMMIT_SHA
npm test
```

The generator needs public GitHub access, the pinned Zod dependency, and esbuild supplied by the locked tsx toolchain. Review schema extraction if upstream declarations change. Include the generated codec, upstream license/provenance and binary fixtures in the release; do not merely relax the build check. Runtime needs outbound HTTPS discovery, WSS lobby access and Discord access. No game account token or authenticated game API is used.

After installing this bot update, register the updated command definitions deliberately using the existing registration workflow. No Message Content or Reaction intent is required. Startup starts the feed and a separate paced durable delivery worker; shutdown disconnects it and drains sends before SQLite closes.

A blocked DM produces one fallback ping with DM-enablement guidance. An uncertain send or exhausted retry stops that member's search and appears privately in `/lobby action:configure`. Diagnose the original message/permissions before the member resumes. Repeated frames, restarts and new searches do not resend the same member/lobby notification. Three-minute continuation deadlines use persisted message creation timestamps; old controls cannot revive a stopped or replaced search. Bot-sent messages and backups retain their independent lifetimes.

Candidates cancelled before a send may be selected again if they return and still match; uncertain or completed sends retain their deduplication records. The fallback channel's visibility is checked again against freshly fetched membership immediately before sending. The worker prefilters lobby snapshots in memory and rechecks matching candidates transactionally before selecting them.
