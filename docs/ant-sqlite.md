# ANT and replacing Node's SQLite driver

Historical investigation: the user subsequently selected Node.js with its built-in SQLite driver and stopped ANT compatibility work. The experiments below remain reference material.

## Decision and verified scope

Keep the existing Node fallback for the bot. Replacing `node:sqlite` is technically plausible through ANT's native FFI, but is insufficient to run this bot correctly today. No production driver, schema, startup interpreter or dependencies were changed by this investigation.

On 6 November 2026, the official latest-release API still returned **ANT 16.5.c41757b4.0**, released 24 October. The cached Windows x64 ZIP's SHA256 matched the release digest, `ceed339fa339a7b8fa69df9db57ca48e1ce70674ec282911f0f2c6042fcb0fa4`. The release inventory includes Linux aarch64 glibc and musl assets; their presence is not an executed Oracle Linux test. No WSL distribution was available locally. See the [release](https://github.com/theMackabu/ant/releases/tag/v16.5.c41757b4.0) and [Oracle ARM runbook](oracle-arm.md).

The expanded credential-free probe runs all capability groups even when SQLite fails:

```sh
ant --version
ant --help
ant tools/check-runtime.mjs
# Existing authorized fallback
node tools/check-runtime.mjs
```

| Group | ANT 16.5, Windows x64 | Meaning |
| --- | --- | --- |
| SQLite | Fails to resolve `node:sqlite` | Production storage and migration backups cannot load. |
| Crypto | Missing `node:crypto.randomInt` | Dice, duels and wheel selection need this API. Hashing, UUIDs, WebCrypto digest and the jose import passed separate exploratory checks. |
| Intl | Fails `intl.timezone-options` | Scheduling/availability require real IANA zones, requested formatting and DST behavior. |
| Networking | Passes local API-presence check | No TLS handshake, Discord login, REST call or Gateway connection was attempted. |
| Discord | Imports and builder serialization pass | This does not validate live transport or shutdown. |
| Data | Clone/BigInt/typed-array/zlib checks pass | This is a small local capability sample. |

The exploratory timezone check requested `en-GB`, a two-digit hour and `hourCycle: h23`. For midnight UTC, both `America/Bahia` and `America/New_York` returned `9:00:00 PM` in January and July; New York should instead return `19` and `20`. The Bahia midnight parts check also failed. Do not infer correct timezone support from the existence of `Intl.DateTimeFormat`.

Local Node **26.4.0 / Windows x64** passed every group. The package floor remains Node **22.13.0**; the existing Linux Node 22 x64/ARM64 workflow remains the architecture gate and was not run remotely in this session.

## Replacement options

| Option | Assessment for this bot |
| --- | --- |
| Keep `node:sqlite` | Current supported choice. Preserves direct disk persistence, synchronous transactions, existing migration backups and a large regression suite without another native dependency. |
| Native SQLite via `ant:ffi` | Plausible ANT route. A disposable Windows experiment passed SQLite open/prepare/step/finalize/close, savepoint rollback and JSON extraction. Requires a maintained adapter, library packaging/version checks and all persistence tests on ARM. |
| `better-sqlite3` 13.0.3 | Current release uses Node-API and ships native prebuilds including Linux ARM64. A disposable test of its Windows x64 package crashed ANT 16.5; the same package and test passed on Node 26.4.0. It is not a verified ANT replacement. |
| `sql.js` | Its usual storage is an in-memory virtual database imported/exported as a byte array. That changes the bot's durability and memory model; it is unsuitable as a drop-in persistence replacement. WebAssembly being present does not establish disk durability. |
| SQLite CLI subprocess per query | Does not preserve the current shared connection and composable synchronous transactions. A persistent helper/service would be a separate architecture change. |

The native experiment used ANT's `dlopen`, `alloc`, pointer read and defined SQLite C signatures with the installed Windows `winsqlite3.dll` (**SQLite 3.53.4**). It opened only `:memory:`, rolled back an insert through a savepoint, prepared a query combining the empty-table count with `json_extract`, received `SQLITE_ROW` (100) and `ffi-ok`, finalized the statement and closed the connection/library. This proves limited C-call feasibility, **not** a complete driver, parameter-binding correctness, crash recovery or Linux behavior. The experiment is local scratch work, not a production fallback.

The separate better-sqlite3 experiment downloaded **13.0.3** from the npm registry into an ignored scratch directory and verified the archive's published SHA512 integrity. No root dependency/lockfile was changed or install lifecycle script run. Its manifest lists `node-addon-api ^8.0.0` and the archive contains glibc/musl Linux ARM64 and Windows x64/ARM64 prebuilds. With ANT crash reporting disabled, importing/constructing an in-memory database ended the process with a fatal exception before any result was printed. The same experiment passed on Node 26.4.0, including rollback, JSON extraction, bound INSERT RETURNING, iteration and affected-row counts. The experiment does not locate the native crash within ANT or establish whether Linux has the same fault. Older descriptions of better-sqlite3 as necessarily tied to the V8 ABI do not describe this release.

References: ANT's [FFI SQLite example](https://github.com/theMackabu/ant/blob/master/examples/ffi/sqlite/sqlite3.js) and [FFI declarations](https://github.com/theMackabu/ant/blob/master/src/types/modules/ffi.d.ts); better-sqlite3's [13.0.3 release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3), [native binding](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/src/better_sqlite3.cpp) and [API](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/api.md); sql.js's [documented memory/export model](https://github.com/sql-js/sql.js#readme). ANT master examples are moving references, not the source identity of the tested release.

## Requirements before adopting an adapter

The runtime imports are in `src/db.ts` and `src/backups.ts`; domain stores also import the `DatabaseSync` type, and many tests construct the Node database directly. Changing two imports alone does not verify a replacement.

An adapter must preserve `exec`, prepared `run/get/all/iterate`, positional bindings, null/text/blob/integer handling, `changes`, synchronous iterator disposal and deterministic ordering. It must support the actual SQL inventory, including JSON table functions, UPSERT/RETURNING, savepoints and rollback inside caller-owned transactions. Avoid a giant `IN` bind list: report inventories use one JSON parameter. Do not substitute asynchronous transactions.

Persistent validation must include read-only open, missing/corrupt database failure, lock/busy handling, existing schema/data and repeatable migrations. Preserve `VACUUM INTO` snapshots containing committed WAL data, `integrity_check`, close-before-rename, failure stopping migration and per-database retention. Re-run disk/reopen, deletion, retry and delivery fixtures against the candidate backend, not a mixture where only the singleton uses the adapter.

On Oracle Linux 9 ARM64, verify the installed SQLite library's architecture, SQL features and version explicitly; do not assume the OS library matches Windows or Node's bundled SQLite. Then resolve the independent crypto and Intl blockers, run the complete suite with a compatible test runner, check signals/shutdown, and deliberately validate TLS/Gateway behavior in staging before changing startup. Keep Node and the existing consistent backup as rollback paths.

## Verification follow-up

The historical history-optimization check passed **751/758** tests on Node 26.4.0 Windows x64 outside the filesystem sandbox. Its seven failures were in `test/command-actions.test.mjs` and reflected the then-unimplemented action conversion, rather than ANT/SQLite behavior. Subsequent [Node command-action work](superpowers/plans/2026-11-06-command-actions.md) completed the seven handlers and their shared validation without weakening those tests; the full suite now passes **758/758**. Backup/readiness rename failures seen in the sandbox disappeared with normal filesystem access. These local checks do not establish deployment or Oracle ARM validation.
