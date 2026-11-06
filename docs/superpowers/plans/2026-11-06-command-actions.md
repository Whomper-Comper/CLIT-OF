# Finish command-action consolidation

Continue task 2 of the approved [command cleanup design](../specs/2026-11-04-oracle-arm-bot-design.md). The user requested investigation/fixes for the seven failing cases and continued simple refactoring. Use Node.js and existing SQLite; no push, deployment, registration or executable build.

- [x] Reproduce all seven failures in `test/command-actions.test.mjs`. Cause: the planned flat-action schema and validation were never implemented in the seven handlers.
- [x] Introduce a pure shared action-option builder/parser using explicit per-action required/optional input lists. Validate missing/unknown actions and irrelevant/missing inputs before replies, authorization, cooldowns and database work. Preserve `0`/`false` with null checks and prefer an explicit action over legacy subcommand fallback.
- [x] Flatten availability, bingo, event, onboarding, wheel, milestones and lobby registration inputs without changing bounds, choices, autocomplete, permission/session checks or command names. Enforce a lobby watch filter before storage work.
- [x] Refactor legacy test option stubs to use a shared real Discord resolver, retaining legacy payload coverage and all assertions. Run the existing focused behavioral suites after build.
- [x] Update runtime help strings and project verification guidance; run the full suite, whitespace checks and a separate read-only code review. Keep global/guild registration a future deliberate live operation.

Review exact input ownership by action, duplicate/unknown names, zero/false values, legacy nested options, optional preset IDs, first-save timezone, private replies, access refresh and DST validation. Do not weaken existing tests or discard earlier uncommitted work.

## Verification

The unchanged command-action suite reproduced all seven failures before implementation and passed all eight cases afterward. The affected feature/legacy group passed 131/131. After updating runtime command guidance and its three event-list assertions, the full `npm test` run passed 758/758 on Node 26.4.0 Windows x64 with normal filesystem access, with no skipped tests. The earlier seven-failure gate is resolved. Whitespace checks passed. Command registration and deployment were not run; existing nested requests remain supported until those separate live operations are deliberately performed.

Independent read-only review found no Critical, Important or Minor issues in this change, confirmed preservation of registration metadata and permission/session behavior, and independently passed the action suite (8/8) and whitespace checks. Prior runtime/history/cache/delivery work remained outside this review's scope.
