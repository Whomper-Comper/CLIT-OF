# Oracle Linux ARM hosting and runtime verification

The migration default is **Oracle Linux 9 on a 64-bit Ampere/aarch64 VM with 6 GB RAM**. The bot remains a single process using its existing SQLite database. More host RAM is capacity for the OS, bot, release staging and backups; it does not justify parallel bot instances or unbounded caches.

## Runtime decision

ANT is the preferred candidate runtime, subject to an explicit compatibility gate. Run the probe with the candidate executable from the repository root:

```sh
ant --version
ant --help
ant tools/check-runtime.mjs
```

The probe imports no bot configuration or entry point, opens only an in-memory SQLite database, and makes no network requests. It checks the required SQLite API, ordered statement iteration and synchronous savepoint behavior first, then crypto, module imports, timezone/DST handling, typed data and Discord builders. Its JSON result and exit status are the authority: exit 0 means these local capabilities passed; exit 1 blocks a runtime switch. It is a preflight, not proof of real TLS/Gateway traffic, backup recovery, bot shutdown or Discord login.

**Verified compatibility result:** the official ANT **16.5.c41757b4.0** Windows x64 release, with the release asset's SHA256 digest verified, fails the first gate: `TypeError: Cannot resolve module: node:sqlite`. The bot imports that API for persistent storage and migration backups. This check is a Windows result, not an executed Linux ARM result. ANT's source inventory also lacks this built-in; repeat the gate on the target host when evaluating another build. Do not change the interpreter merely because ANT starts quickly or supports TypeScript.

The user-authorized fallback is the bot's existing **Node.js >=22.13.0** runtime. Use a maintained, patched release satisfying that floor. The architecture CI checks the patched Node 22 line on Linux x64 and ARM64. Build/test tools and the current PM2/deployment script also use Node/npm. No SQLite adapter or alternate Discord transport is introduced.

The optimization publication `1e13640` passed both Node 22 / Ubuntu 24.04 x64 and Node 22 / Ubuntu 24.04 ARM64 jobs in [architecture verification run 42048524530](https://github.com/Whomper-Comper/CLIT-OF/actions/runs/42048524530). This verifies the Linux architecture matrix on that revision; Oracle Linux host/runtime and live Discord checks remain part of cutover.

```sh
node --version
npm --version
npm ci --include=dev
node tools/check-runtime.mjs
DB_PATH=:memory: npm test
```

Run the standalone preflight after dependencies are installed. If a future ANT release passes, also require the full regression suite under an appropriate runner, filesystem backup/recovery checks, signal/shutdown behavior, and a deliberate staging Guild/Gateway test on Oracle ARM before changing production startup. Keep Node as the rollback interpreter. No ANT compilation or application executable packaging is required.

## Host preflight

Use a dedicated runtime account and confirm actual image, architecture, libc, disk and available memory:

```sh
uname -m
cat /etc/os-release
getconf GNU_LIBC_VERSION
free -m
df -h .
command -v node npm pm2 git bash tar mktemp flock
```

Expect `aarch64` on the ARM host; install binaries for that architecture and verify the chosen runtime against the installed system libraries. Oracle Linux uses `dnf`; Ubuntu package instructions and the `ubuntu` SSH account are not an Oracle Linux setup guide. OCI Oracle Linux images normally start with the `opc` SSH account. Explicitly configure the deployment account using `ORACLE_USERNAME`, rather than relying on the existing workflow's Ubuntu fallback. Preserve working keys and verify noninteractive SSH before cutover.

Install dependencies on the destination using the lockfile. Do not copy x64 `node_modules`, native accelerators or development binaries onto ARM. Install PM2 separately as described in [operations](operations.md#7-linux-production-deployment). Keep one PM2 instance; preserve the `300M` memory restart threshold until measured RSS/restart behavior justifies an operational change. A 6 GB host does not automatically change this process threshold.

## Reproducible offline measurement

Build before running the benchmark:

```sh
npm run build
node --expose-gc tools/benchmark-bot.mjs
# Optional bounded fixture sizes: games per clan, players, games per player, iterations
node --expose-gc tools/benchmark-bot.mjs 2000 250 100 5
```

The benchmark suppresses dotenv loading, sets test credentials and an in-memory database, forbids fetch, seeds ten clans, and calls the real weekly-report implementation. It prints elapsed report times, process CPU, RSS/peak RSS, a timer-delay observation across the workload, and a report SHA256. The default fixture has 20,000 clan rows and 25,000 player rows. The timer observation represents blocking across the entire run, not a percentile of production event-loop delay. Peak RSS includes fixture setup; optional explicit GC and allocator behavior affect results.

Compare unchanged and updated revisions using identical arguments, runtime, machine and GC setting. Keep the same report hash and operation-count regressions alongside timings. Repeat on the Oracle host; Windows/x64 results cannot establish an ARM speedup. Record steady-state RSS, CPU, worker duration/backlog, interaction acknowledgement age and PM2 restart history during an authorized staging run. Avoid timing thresholds in ordinary regression tests.

The [architecture evidence](architecture.md#local-performance-evidence) also records idle session release, bounded API admission, configuration queue preparation and history index measurements. API defaults bound each instance to eight active loaders and 64 waiting for at most two seconds; overload returns the existing safe retry-later error. These limits are constructor options, with no new `.env` settings. Session cleanup uses unreferenced timers and keeps existing ten-minute caps. Added SQLite indexes improve maintenance reads while increasing storage and write work; include ingestion and backup duration when profiling the ARM host.

## Cutover and rollback

1. Prepare and verify the ARM release before moving traffic. Release staging installs and tests while the old process may still run; account for that peak RAM and disk usage.
2. Stop the old bot before taking the final transfer snapshot. Use a consistent SQLite backup that includes committed WAL data; copying an active `.db` alone is insufficient. Preserve `.env`, database, backups and runtime path configuration securely, independently of Git.
3. Transfer the snapshot and private configuration to their intended persistent paths. Keep the previous host stopped. Never run both hosts against this identity/queue state or start multiple bot instances.
4. Verify snapshot integrity and permissions, then use the existing immutable-release/readiness workflow deliberately. Check PID, revision and startup time, followed by a private config channel selection/save, role sync, lobby continuation and report smoke test in the intended server.
5. Register the action-choice definitions in the intended scope deliberately. Guild and global command sets are separate; updating one does not clear the other. Legacy interaction parsing supports the transition, but registration is still required to show the new inputs.
6. If readiness or smoke checks fail, stop the new process before restoring the previous runtime/code. Follow the migration backup and schema compatibility notes in [operations](operations.md); an automatic code rollback does not undo database migrations. Reconcile uncertain Discord deliveries instead of blindly resending them.

Creating this runbook and passing local tests do not provision a VM, register commands or deploy the bot.
