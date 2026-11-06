# Configuration reliability, action commands and Oracle ARM design

Runtime follow-up: the user subsequently selected Node.js with built-in SQLite and stopped ANT compatibility work. The original runtime exploration below is historical; current hosting instructions are in [the Oracle ARM runbook](../../oracle-arm.md).

## Approved intent

Improve an existing OpenFront Discord bot for Oracle Linux ARM hosting: repair unreliable log-channel configuration, organize config/clan pages, make multi-action command families consistent with `/clan`, and reduce repeated work and transient memory allocation. The migration default is Oracle Linux 9 ARM64 with 6 GB RAM. Existing identities, permissions, persistence and recovery guarantees remain authoritative.

## Decisions

- Use focused config pages: Clans, Access, History & recaps, Diagnostics; clan editing groups General, Roles and Logging. Preserve explicit Save, immediate access-role saves, pagination, expiry, conflicts and removal confirmation.
- Use required `action` choices for bingo, availability, event, onboarding, wheel, milestones and lobby. Preserve roots and action names. Flatten action-specific inputs to optional slash inputs, then require/reject them for the selected action; retain legacy subcommand parsing during registration transition.
- Require an ANT compatibility gate and permit the existing Node fallback if a required production API is unavailable. Do not rewrite SQLite or Discord transport solely to force a runtime switch.
- Keep one bot process, worker budgets and the shared one-second role-write pacer. No global message/member cache disablement, API concurrency expansion or retention/scheduling redesign in this iteration.
- Make configuration response errors observable through safe stage/code/timing diagnostics. Never log interaction tokens, webhook URLs, bodies or raw external errors. Roll back unsaved changes if redraw fails; retain successfully persisted state/revisions if a later reply fails.

## Evidence and reliability boundary

The initial unchanged suite passed 722 cases on local Node 26.4.0. The reported live symptom is a red Discord “Interaction failed” when selecting the log channel. A reproduction through real interaction classes, the central listener and message serialization succeeds locally with mocked Discord REST/membership boundaries. Injected acknowledgement and redraw failures expose missing diagnostics in the original handler. The live cause is unconfirmed because the configured SSH key is unavailable. Local tests cannot establish that a deployment, network, token or channel works; live diagnosis remains a separate authorized operation.

## Performance approach

Share the initial roster for selected/due clan synchronization and traverse member-first, using the existing short-lived profile cache and final fresh rosters per clan before pending-invite logs. Preserve identity/config checks after awaits and per-clan success timestamps.

Replace repeated whole-feed copies during lobby send validation with defensive indexed point reads. Stream weekly SQLite rows into aggregates rather than retaining all decoded payload arrays. Avoid sweeping the API cache before its earliest expiry, and avoid caching bounded recovery message scans while preserving canonical-message caching.

Measure operation counts and representative offline CPU/RSS/timer observations against unchanged output. No speedup percentage or Oracle ARM measurement is assumed. Preserve existing array store APIs and public feed snapshots for compatible callers.

## Verification and delivery

Use regression-first changes, focused tests after compilation, independent task review, complete-suite integration checks and a final independent review. Include Linux x64/ARM64 verification without deployment and an offline capability/workload tool. Update user documentation and project guidance with verified behavior and limitations.

The implementation does not include GitHub pushes, live command registration, production deployment, VM provisioning or executable packaging. The runbook covers future consistent database transfer, single-process cutover, readiness, smoke checks and rollback.
