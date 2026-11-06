# ANT investigation and weekly history optimization

The user requested continuing optimization and ARM compatibility work, including investigating ANT and replacing `node:sqlite`. Routine fixes and measurements are authorized; preserve the existing uncommitted continuation in this checkout. No push, deployment, command registration or EXE build.

## Decisions and alternatives

Keep the existing Node fallback while verifying ANT independently of SQLite. Replacing the driver alone cannot address the observed missing `crypto.randomInt` and incorrect timezone/DST formatting in ANT 16.5 Windows x64. Investigate native FFI, native npm drivers and sql.js; record their verified limits before selecting a production replacement. Do not migrate persistent storage to an in-memory export model.

For weekly reports, retain SQLite and the existing synchronous streaming API. Add an optional inventory of exact public-ID/Discord-ID pairs to `HistoryStore.iteratePlayerMatches`; filter in SQL using one JSON parameter, preserving guild scope, time bounds and order. Empty inventory must avoid a payload query. Existing unfiltered callers keep their behavior. Use scalar player counters because the SQLite primary key already guarantees one canonical row per guild/account/game; retain the cross-clan distinct-game set.

## Implementation and verification

- [x] Add failing preflight regressions: a missing SQLite module must not hide independent failures; output excludes raw errors/private environment. Validate exact crypto and timezone capabilities independently.
- [x] Add failing history regressions: identity filtering before decoding, empty/duplicate/escaped inventories, current membership after fetch, guild/time/order/correction preservation, indexed time selection and exact report results. Protect bounded counter storage with operation counts.
- [x] Implement the minimal probe/report/store changes; build and run focused suites using the documented Node fallback.
- [x] Repeat the offline workload with identical arguments and report hash; distinguish Windows measurements from ARM verification.
- [x] Update runtime/replacement documentation and agent guidance with evidence. Run the full suite, whitespace checks and a separate review of this continuation.

## Review focus

Do not multiply records for duplicate bindings, mix owners sharing a public ID, treat an empty inventory as unfiltered, hold SQLite iterators across awaits, or claim that builder imports validate live Discord transport. Linux ARM CI configuration is not an executed Oracle Linux measurement. Preserve pre-migration WAL snapshots and all existing uncommitted changes.

## Results and remaining gate

Focused regressions passed 12/12 after four new/strengthened cases first failed for the intended missing behavior. That iteration's full suite outside the filesystem sandbox passed 751/758; the seven pre-existing command-action failures and their subsequent resolution are documented in [the follow-up](../../ant-sqlite.md#verification-follow-up). No command handlers/tests were weakened to hide that unfinished work. TypeScript compilation and whitespace checks passed.

Independent read-only review found no Critical/Important issues. Its one minor query-plan assertion suggestion was incorporated to protect both time bounds, alongside the existing guild check. Runtime results and benchmark observations are in the assessment and architecture documentation. A final extra investigation verified better-sqlite3 13.0.3's npm SHA512; its bundled Windows Node-API addon crashed ANT with crash reporting disabled but passed the identical in-memory experiment on Node. This supersedes the initial assumption that current better-sqlite3 necessarily requires the V8 ABI. Production adapter adoption and Oracle execution remain future work; no deployment/push/EXE build occurred.
