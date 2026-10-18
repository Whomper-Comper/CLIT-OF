# Clan Community Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship all seven approved community features inside the existing Discord bot.

**Architecture:** Add focused feature stores sharing the existing SQLite connection, thin Discord command/component handlers, and one bounded community worker. Each feature plan adds its own schema, lifecycle cleanup, routes, and documentation so it can be built and tested independently after the foundation. Keep existing role/history services separate.

**Tech Stack:** TypeScript, discord.js 14, Node.js built-in SQLite, `node:test`, `Intl`, `node:crypto`.

**Spec:** [Approved design](../specs/2026-10-18-clan-community-features-design.md).

## Global Constraints

- All new commands are server-only.
- Keep the existing `/dice` interface unchanged and add `/duel` separately.
- Cards and boards are polished Discord embeds with buttons; no image-generation service or new rendering dependency is required.
- The separate desktop control panel is outside this change.
- The bot never holds a database transaction across an awaited Discord/API request.
- Existing history/role budgets remain independent and unchanged.
- Keep the existing Node.js >=22.13.0 floor; add no package dependency.
- Persist and compare statistics counters as exact decimal text/BigInt, not floating-point numbers.
- Do not register commands, run a live bot, deploy, push, or modify runtime data as part of local implementation verification.

## Review Focus

- Membership/profile lookups finish after a role or identity changed: reject stale writes and recheck permissions (foundation, scheduling, milestone tests).
- A timezone fold repeats only part of an availability window: preserve two real intervals without bridging unavailable minutes (scheduling task 1).
- Discord accepted a message before a local crash: recover/reconcile the existing result without posting another result (foundation delivery tests and feature publication tests).
- A former participant's evidence is removed from a bingo line: recompute visible progress without announcing the same line again (bingo task 1).
- A malformed/cross-server component targets a valid object ID: no state change or data disclosure (every command task and final route tests).

## Plan sequence and file ownership

Execute foundation task 1 here, then the following feature plans in order, then final integration task 2 here. All plans inherit the approved spec and this document's contracts. Do not implement features while this plan is awaiting user review.

1. [Scheduling, availability, and onboarding](2026-10-18-community-scheduling.md): `src/community/time.ts`, `availability.ts`, `events.ts`, `eventDelivery.ts`, `onboarding.ts`; corresponding command files.
2. [Curated challenge wheel](2026-10-18-community-wheel.md): `src/community/wheel.ts`, `wheelPresets.ts`; `src/commands/wheel.ts`.
3. [Milestone cards](2026-10-18-community-milestones.md): `src/community/milestones.ts`, `milestoneWorker.ts`; `src/commands/milestones.ts`.
4. [Server bingo](2026-10-18-community-bingo.md): `src/community/bingo.ts`, `bingoEvidence.ts`, `bingoWorker.ts`; `src/commands/bingo.ts`.
5. [Dice duels](2026-10-18-community-duels.md): `src/community/duels.ts`; `src/commands/duel.ts`.

Foundation owns `src/community/store.ts`, `types.ts`, `transactions.ts`, `settings.ts`, `sessions.ts`, `deliveries.ts`, `service.ts`, `runtime.ts`, `access.ts`, `interactions.ts`, `lifecycle.ts`, and `test/helpers/community.mjs`. Each feature adds its store property/initializer and cleanup handlers to these shared files, plus its command to `src/commands/index.ts`. In the same feature commit, update the explicit expected command-name list in `test/bot.test.mjs`; keep the legacy command/option assertions intact. This avoids imports of files that do not exist in an earlier commit and keeps intermediate commits verifiable. Do not restructure unrelated existing modules.

### Task 1: Persistent foundation, authorization, and bounded delivery

**Files:** Create the foundation-owned files above; modify `src/db.ts` (constructor and identity mutations), `src/historyStore.ts` (deletion/history-clear hooks), `src/index.ts` (startup, routing, shutdown/departure); create `test/community-core.test.mjs`, `test/community-delivery.test.mjs`, `test/community-access.test.mjs`; update `docs/architecture.md`.

**Interfaces:**

- `CommunityStore.initialize(sql: DatabaseSync): void`; `new CommunityStore(sql: DatabaseSync)`; `BotDatabase.community: CommunityStore`. Initially expose `.deliveries: DeliveryStore` and `.settings: CommunitySettingsStore`; feature plans add their own properties.
- `withCommunityTransaction<T>(sql: DatabaseSync, action: () => T): T`: a unique SAVEPOINT/release/rollback wrapper that composes with existing outer transactions.
- Shared `EntityBinding = { guildId: string; channelId: string; messageId: string | null }`; `IdentityBinding = { guildId: string; discordId: string; publicId: string; linkedAt: string }` in `types.ts`.
- `CommunitySettings = { guildId: string; revision: number; milestonesEnabled: boolean; milestoneChannelId: string | null; gameThresholds: string[]; winThresholds: string[] }`; `CommunitySettingsStore.get(guildId: string): CommunitySettings`, `.list(): CommunitySettings[]`, `.save(guildId: string, draft: Omit<CommunitySettings, 'guildId' | 'revision'>, expectedRevision: number): CommunitySettings` in `settings.ts`. Unsaved defaults are disabled/null with games10/50/100/250/500 and wins1/10/25/50/100; revisions start at0 and first save becomes1.
- `PrivateCommunitySession = { id: string; kind: string; ownerId: string; guildId: string; channelId: string; messageId: string | null; expiresAt: number; data: unknown }`; `CommunitySessions.create(input: Omit<PrivateCommunitySession, 'id' | 'expiresAt'>, now: number): PrivateCommunitySession`, `.bind(id: string, messageId: string): void`, `.get(id: string, ownerId: string, binding: EntityBinding, now: number): PrivateCommunitySession`, `.delete(id: string): void` in `sessions.ts`. Keep at most200 sessions across new private community menus, expiring after600,000ms. A command-specific kind check narrows `data`; mismatches/expiry reject with reopen guidance. Public persistent controls never depend on these in-memory sessions.
- `requireCommunityOfficer(guild: Guild, userId: string): Promise<void>`: fresh member fetch, then reread manager and mapped officer/leader roles. Reuse `requireConfigAccess` for announcement configuration. `assertCommunityBinding(binding: EntityBinding, interaction: Interaction): void` rejects a mismatched guild/channel/message.
- `DeliveryInput = { key: string; guildId: string; channelId: string; kind: string; subjectId: string; revision: number; dueAt: number; part: number }`; `DeliveryJob` adds `id`, `status`, `leaseId`, `leaseUntil`, `attempts`, `messageId`, `lastError`, and `nextAttempt`. Statuses: `pending | sending | sent | failed | paused | needs_review | cancelled`.
- `DeliveryStore.enqueue(input: DeliveryInput): DeliveryJob`, `.claim(now: number, limit: number): DeliveryJob[]`, `.finish(id: string, leaseId: string, messageId: string): boolean`, `.fail(id: string, leaseId: string, outcome: 'transient' | 'paused' | 'needs_review', error: string, now: number): void`, `.cancelSubject(guildId: string, kind: string, subjectId: string): void`, `.list(guildId: string): DeliveryJob[]`, `.retry(guildId: string, jobId: string, expectedRevision: number, now: number): void`.
- `PreparedDelivery = { payload: MessageCreateOptions; messageId?: string }`; `CommunityTick = { now: number; takeRequest(): boolean; stopping(): boolean }`; task callback `(tick: CommunityTick) => Promise<void>`; `CommunityDeliveryHandler = { prepare(job: DeliveryJob): Promise<PreparedDelivery | null>; delivered?(job: DeliveryJob, messageId: string): void }`. `null` means obsolete/cancelled. `delivered` performs synchronous database binding only and runs atomically with `DeliveryStore.finish`; event/bingo handlers use it to publish the matching saved revision with the resulting message ID. Reconciliation calls it too. A post-send binding failure becomes Needs review rather than another automatic post. A job's marker is included in its embed footer; stable nonce is derived from its key and part. Strip create-only fields before editing an existing message.
- `new CommunityService(client: Client, db: BotDatabase, api: OpenFrontApi, options?: { now?: () => number; tickMs?: number; maxRequestsPerTick?: number; maxSendsPerTick?: number })`; `.registerTask(key: string, task: (tick: CommunityTick) => Promise<void>): void`, `.registerDelivery(kind: string, handler: CommunityDeliveryHandler): void`, `.start(): void`, `.runOnce(): Promise<void>`, `.stop(): Promise<void>`.
- `createCommunityService(client: Client, db: BotDatabase, api: OpenFrontApi): CommunityService` in `runtime.ts` registers feature work as each feature is added. `handleCommunityInteraction(i: Interaction): Promise<boolean>` in `interactions.ts` dispatches registered prefixes, initially returning false. Call it within the existing error boundary.
- Lifecycle methods `.purgeIdentity(discordId: string, guildId?: string): void`, `.purgeAccount(publicId: string): void`, `.purgeMember(guildId: string, discordId: string): void`, `.purgeGuild(guildId: string): void`, `.clearGameEvidence(guildId?: string): void`, `.prune(now: number): void` are on `CommunityStore` and delegate to `lifecycle.ts`. Each owner plan extends them for its records. Use current mutation context to preserve same-account re-verification while invalidating stale async bindings.
- Add optional history cleanup callbacks `new HistoryStore(sql, cleanup?: { purgeAccount(publicId: string): void; clearGameEvidence(guildId?: string): void })`. Invoke them from deleted-account, guild-player-history-clear, and global-player-history-clear paths; retain one-argument construction compatibility.
- `communityFixture()` in `test/helpers/community.mjs` returns `{ db, client, guild, api, now, advance(ms), addMember(id, roles?, bot?), setRoles(id, roles), calls, close() }`; `db` is in memory; `calls` contains `requests`, `sends`, `edits`, and `memberFetches` arrays; `close(): Promise<void>` drains services and closes DB. Set test environment before importing DB modules, matching existing fixtures.

- [ ] **Step 1: Add regression tests with real in-memory SQLite and controlled fake Discord calls.** Include these assertions and named cases; helper-only mocks must not duplicate production state transitions:

```js
test('delivery keys deduplicate and claims have a five-minute lease', async () => {
  const f = communityFixture();
  const job = { key: 'same', guildId: 'g', channelId: 'c', kind: 'test', subjectId: 's', revision: 1, dueAt: f.now(), part: 0 };
  assert.equal(f.db.community.deliveries.enqueue(job).id, f.db.community.deliveries.enqueue(job).id);
  assert.equal(f.db.community.deliveries.claim(f.now(), 1)[0].leaseUntil, f.now() + 300_000);
  await f.close();
});
```

Also assert: reopening an on-disk test DB preserves a pending job and existing clan/link rows; a deliberately failed outer transaction removes its new job; a stale lease cannot finish a newer claim; unauthorized/mismatched components cause zero writes; role revocation during a deferred fetch denies access; the new officer helper does not relax `/clan` or `/debug`. Worker tests assert eight-request/four-send defaults, fairness across busy guilds, one shared promise for concurrent ticks, stop/drain, permission pause, deterministic retry bounds, and ambiguous sends becoming `needs_review` if recent-message reconciliation cannot prove the result. A recovered message finishes without a second send.

- [ ] **Step 2: Run `npm run build`, then `node --test test/community-core.test.mjs test/community-delivery.test.mjs test/community-access.test.mjs`.** Expected red: missing community imports/properties. Do not count syntax errors or unavailable runtimes as the intended failure.
- [ ] **Step 3: Implement the contracts above.** Create core settings/delivery/guild-work tables with guild/due/identity indexes inside the backed-up migration transaction. Initialize `community` before constructing history callbacks. Tick every 60,000 ms with eight requests, four sends and five-minute delivery leases; tasks only enqueue, while the service sends/edits through current revision validation. Use bounded exponential retry at 1, 2, 4, 8, 16, then 30 minutes, pausing after ten definite failures. Permission failures pause immediately; ambiguous sends reconcile or require review. Preserve existing budgets and mention suppression. Wire startup/shutdown/login-failure cleanup and member/guild removal. Update only identity cleanup hooks whose feature methods exist in this task.
- [ ] **Step 4: Run the three new suites plus `test/bot.test.mjs`, `test/access-config.test.mjs`, `test/history-collection.test.mjs`, and `test/interaction-router.test.mjs` after building.** Expected all pass; document test DB backup rename restrictions honestly and use the established approval mechanism if needed.
- [ ] **Step 5: Commit the foundation and its tests/docs.** Stage only the named source/test/doc files; message `feat: add persistent community services and access checks`.

### Task 2: Whole-release integration and documentation

**Files:** Create `test/community-integration.test.mjs`; use all new feature tests; modify `test/interaction-router.test.mjs`, `test/bot.test.mjs`, `README.md`, `docs/commands.md`, `docs/server-administration.md`, `docs/architecture.md`, `docs/statistics-and-history.md`, `docs/development.md`, `docs/operations.md`; adjust only affected feature source if integration reveals a defect.

**Interfaces:** Consume every feature plan's exports and command registration. Produce one working command list containing the original eight plus `event`, `availability`, `onboarding`, `wheel`, `milestones`, `bingo`, and `duel`; one service runtime with all feature hooks; final local verification evidence.

- [ ] **Step 1: Add final routing/lifecycle regressions.** Assert command names total 15 with no duplicates; old `/dice` options are exactly `sides`/`count`; all seven new builders restrict context to Guild. Send a forged component for each prefix and assert no state change. Exercise signup -> onboarding -> availability bingo evidence, milestone disable -> pending send cancellation, and account deletion -> history plus community purge while another guild/account remains intact. Serialize worst-case cards/lists and assert each Discord field/content/component limit rather than fixed copy or pixel positions.
- [ ] **Step 2: Run `npm run build`, then `node --test test/interaction-router.test.mjs test/bot.test.mjs test/community-integration.test.mjs`.** Create `test/community-integration.test.mjs` for the cross-feature cases. Expected red for uncovered integration behavior, or green if existing feature coverage already implements it; do not break correct code merely to force red.
- [ ] **Step 3: Resolve concrete integration gaps and finish documentation.** Every command, subcommand, option/default, officer/config permission, private/public flow, enablement step, collection dependency, cleanup rule, and delivery recovery action must be documented. Explain that times render locally, presets suggest human-hosted games, milestones baseline old awards silently, bingo uses retained observations, reminders are opt-in, and duels persist rolls. Update test inventories and source/table maps. No live operation is needed.
- [ ] **Step 4: Run `npm test` and `git diff --check`.** Expected build succeeds; all existing/new individual tests pass with zero failures. Record the actual test count and any platform limitation. Do not rerun passing suites without a subsequent change or unresolved concern. Review source/serialization evidence for privacy, capacity, and deduplication before claiming completion.
- [ ] **Step 5: Obtain final independent code review using the execution method chosen by the user; fix valid findings and rerun affected verification.** Use the applicable review/verification/branch-finishing skills at execution time. Stage exact changed files and commit `feat: complete clan community feature integration`. Preserve local-only handoff/report files and runtime secrets/data. Summarize implemented behavior, verification and remaining live registration/deployment steps.

## Execution choice

Recommended: **Native** execution in this chat, because the feature plans share storage, lifecycle, and delivery interfaces and benefit from one implementer maintaining those boundaries. The alternative is **Subagent-driven**, with a separate implementer/reviewer per task and greater context/review cost. Either method executes all plans; neither changes scope. Wait for the user's plan review and method choice before product-code changes.
