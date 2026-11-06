# Oracle Linux ARM hosting and runtime verification

The migration default is **Oracle Linux 9 on a 64-bit Ampere/aarch64 VM with 6 GB RAM**. The bot remains a single process using its existing SQLite database. More host RAM is capacity for the OS, bot, release staging and backups; it does not justify parallel bot instances or unbounded caches.

## Runtime decision

Use **Node.js >=22.13.0** with its existing built-in SQLite driver. The user selected Node and stopped the ANT investigation. Earlier experiments remain in the [historical runtime assessment](ant-sqlite.md); they are not an active hosting prerequisite.

### Version and architecture compatibility

There is **one bot codebase for x86-64 and ARM64**, not separate feature versions. CPU architecture determines which runtime executable and native dependencies to install; an x86-64 executable does not run natively on ARM64, or vice versa. Install dependencies on each destination with `npm ci` rather than transferring `node_modules` between architectures.

| Runtime / platform | Verified status | Meaning for hosting |
| --- | --- | --- |
| Node.js 22.13.0 or newer | Required API floor declared by the project; Linux CI uses the patched Node 22 line | Supported runtime; use an architecture-matched, maintained build |
| Linux x86-64 + Node 22 | Full regression suite and runtime gate passed | Same bot features and persistence format as ARM64 |
| Linux ARM64 + Node 22 | Full regression suite and runtime gate passed on Ubuntu 24.04 ARM64 | Supports the ARM architecture; Oracle Linux deployment and live Discord smoke checks remain separate |
| Windows x64 + Node 26.4.0 | Local regression and offline performance measurements passed | Benchmark environment, not a requirement to upgrade the Oracle host to Node 26 |
| ANT 16.5.c41757b4.0, Windows x64 | Runtime gate failed resolving `node:sqlite` | Cannot replace Node for this bot in the tested configuration |
| ANT on Linux ARM64 / other versions | Not executed or certified by this work | Historical exploration only; do not infer support from another architecture or version |

**Performance disclaimer:** published RAM/query/render measurements compare bot implementations on Windows x64 under Node, not ANT versus Node or ARM versus x86. No ANT speedup or Oracle ARM throughput improvement was measured. More RAM and a different CPU do not guarantee a particular latency or CPU improvement. Run the same workload on the destination before making host-performance claims.

**Historical compatibility result:** the official ANT **16.5.c41757b4.0** Windows x64 release, with the release asset's SHA256 digest verified, failed the first gate: `TypeError: Cannot resolve module: node:sqlite`. The bot imports that API for persistent storage and migration backups. This check is a Windows result, not an executed Linux ARM result. ANT's source inventory also lacked this built-in. These results document the earlier investigation; Node remains the selected runtime.

Use a maintained, patched Node release satisfying the API floor. The architecture CI checks the patched Node 22 line on Linux x64 and ARM64. Build/test tools and the current PM2/deployment script also use Node/npm. No SQLite adapter or alternate Discord transport is introduced.

The optimization publication `1e13640` passed both Node 22 / Ubuntu 24.04 x64 and Node 22 / Ubuntu 24.04 ARM64 jobs in [architecture verification run 42048524530](https://github.com/Whomper-Comper/CLIT-OF/actions/runs/42048524530). This verifies the Linux architecture matrix on that revision; Oracle Linux host/runtime and live Discord checks remain part of cutover.

Verification runs for pull requests, manual dispatch and pushes to `main` or `feat/**`. The separate Oracle deployment workflow is manual-only (`workflow_dispatch`); publishing a commit does not deploy it.

Install dependencies, then run the local preflight and tests from the repository root:

```sh
node --version
npm --version
npm ci --include=dev
node tools/check-runtime.mjs
DB_PATH=:memory: npm test
```

The probe imports no bot configuration or entry point, opens only an in-memory SQLite database, and makes no network requests. It checks SQLite bindings, JSON table functions, RETURNING, affected-row counts, iteration and synchronous savepoints, then independently checks crypto, module imports, timezone/DST handling, typed data and Discord builders. A SQLite failure does not hide the other results. Exit 0 means these local capabilities passed; exit 1 blocks that runtime build. The probe does not validate real TLS/Gateway traffic, backup recovery, shutdown or Discord login. Verify filesystem recovery, signals and deliberate staging Guild/Gateway behavior on Oracle ARM before cutover. No executable packaging is required.

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
