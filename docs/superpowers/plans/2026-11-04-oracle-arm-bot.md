# Config reliability, command cleanup, and Oracle Linux ARM implementation

Approved design: [configuration and Oracle ARM design](../specs/2026-11-04-oracle-arm-bot-design.md). Work proceeds in independent, reviewed tasks.

## Constraints

- Target Oracle Linux 9 ARM64 with 6 GB RAM by default; verify ANT first and use the explicitly authorized Node fallback when required APIs are unavailable.
- Keep identity, permission, revision, tombstone, deletion, retry and post-await checks; synchronous SQLite transactions; one bot process; existing worker budgets and role-write pacing.
- Push only with separate explicit authorization. Live registration, deployment, EXE builds, credentials in output and production database experiments remain outside this implementation.
- Baseline: 722 tests passed on Node 26.4.0. Windows sandbox backup renames need an unchanged elevated rerun.
- The live red channel-selection interaction failure is not reproduced locally. Safe diagnostics and authorized live evidence are needed before claiming its cause fixed.

## Tasks

1. Configuration reliability and organized pages: actual-router select/change/clear/save regressions; safe stage/error/timing diagnostics; unsaved draft rollback on failed redraw; committed-save recovery; Clans/Access/History & recaps/Diagnostics navigation and General/Roles/Logging clan sections. Preserve immediate access saves, conflict protection, limits and pagination; group saved clan reports.
2. Command consolidation: convert bingo, availability, event, onboarding, wheel, milestones and lobby to required action choices with optional union inputs, null-safe per-action validation and legacy subcommand acceptance. Preserve names, bounds, permissions, visibility, cooldowns and autocomplete.
3. Lobby/cache/recovery efficiency: indexed defensive per-lobby freshness lookup; conservative API cache expiry frontier; uncached bounded reconciliation history scans, preserving canonical message/member caches.
4. Weekly report streaming: synchronous history iterators with compatible array APIs; single-pass aggregation retaining only compact totals/identifiers; preserve exact rankings, coverage, all-clan totals and eight displayed breakdowns.
5. Clan synchronization batching: one initial roster per guild/selected-config batch; member-first traversal with existing profile TTL and guarded helpers; deterministic overlapping locks; separate per-clan results/last-sync state and final fresh mismatch rosters.
6. ANT/ARM verification and documentation: isolated capability probe, Linux x64/ARM64 verification without deployment, reproducible workload measurement, and complete Oracle migration/runtime documentation and project guidance.

## Verification

Each behavioral change gets a failing regression first and focused verification after compilation. Check operation counts as well as behavior for performance work. Review each task, run the complete suite and diff checks after integration, then obtain an independent whole-change review. Report measurements and limitations without extrapolating local checks to live Discord or Oracle performance.

## Follow-up optimization pass

The initial implementation was published as `8357b45`. The user authorized continued substantial optimization and refactoring after that publication. Offline audits identified four concrete follow-up tasks; these preserve the constraints above:

1. Add covering retained-member inventories and selective coverage-retention/due-job indexes through repeatable schema initialization. Preserve pruning scope, exact cutoffs and fair job selection. Verify query plans alongside behavior and document index storage/write costs.
2. Release expired statistics, configuration and private community sessions during idle periods. Use bounded registries with an unreferenced expiry timer, preserve existing caps and ten-minute deadlines, and retain all binding and post-await revocation checks. Use deterministic clocks/schedulers in tests.
3. Remove the redundant cache-insertion clone while preserving per-caller defensive copies. Bound API-instance network/body/validation work with eight active slots, a FIFO queue of at most 64 and a two-second queue deadline; validate constructor overrides. Keep same-key coalescing, distinct fresh reads, generation ordering, controlled errors and existing fetch timeouts.
4. Batch role-job enqueue preparation during clan configuration saves/removals. Read the unchanged mapping inventory once, reuse statements, and retain per-member obsolete roles, priority, versions, creation order, retries and atomic rollback. A synthetic 5,000-member/20-clan save exposed 5,000 mapping reads and 15,002 statement preparations in the original path.

These tasks have disjoint source ownership and may run in parallel; final compilation and integration verification are serialized. Broad retention batching, blanket Discord member-cache limits, persistent roster caches and a graph rewrite remain deferred because their correctness or benefit is not established. Each follow-up receives a scoped review and publication includes updated documentation and agent guidance.
