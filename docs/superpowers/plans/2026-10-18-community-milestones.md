# Milestone Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Award exact-statistic milestone cards once per threshold, with quiet initial baselines and optional public announcements.

**Architecture:** A pure BigInt evaluator feeds an account-bound observation/award store. A bounded worker polls eligible profiles and queues combined cards; private configuration and view commands share those same records and validate identity after every fetch.

**Tech Stack:** TypeScript, SQLite, discord.js14, existing `summarizePlayerStats`, `node:test`.

**Spec:** [Approved design section5 and cleanup](../specs/2026-10-18-clan-community-features-design.md); [foundation contracts](2026-10-18-clan-community.md).

## Global Constraints

- All new commands are server-only.
- Use the existing BigInt statistics parser without converting counters through floating-point numbers.
- On the first valid observation of an account or newly added threshold, save already reached thresholds as earned, visible in `view`, without posting old achievements.
- Poll eligible current linked clan members at most once per 15 minutes.
- Inherit foundation authorization, request/send budgets, shutdown, stale-identity and cleanup rules.

## Review Focus

- A very large counter near a threshold must not round up/down (task1).
- Adding a threshold after observations exist must not announce an old achievement (task1).
- A partial or arithmetically inconsistent stats bucket must not award anything (task1).
- Disabling announcements while a profile fetch is pending must prevent the queued card (task2).
- Milestone-only servers still need healthy deletion-feed synchronization when history collection is off (task2).

### Task 1: Exact counters, baselines, and durable awards

**Files:** Create `src/community/milestones.ts`, `test/milestones.test.mjs`; extend store/lifecycle and only affected identity cleanup hooks in `src/db.ts`; update statistics/history docs.

**Interfaces:** `MilestoneCounters = { games: bigint; wins: bigint; losses: bigint }`; `MilestoneThresholds = { games: string[]; wins: string[] }`; `MilestoneState = { counters: MilestoneCounters | null; initialized: Set<string>; earned: Set<string> }`; keys are `games:<decimal>` or `wins:<decimal>`. `MilestoneEvaluation = { awards: { metric: 'games' | 'wins'; threshold: string; total: string; announce: boolean }[]; initialized: string[] }`.

`readMilestoneCounters(stats: unknown): MilestoneCounters | null` uses public Team mode and rejects partial or inconsistent counters. `validateMilestoneThresholds(input: MilestoneThresholds): MilestoneThresholds` accepts at most10 ascending unique positive decimal integer strings per metric. `evaluateMilestones(state: MilestoneState, current: MilestoneCounters, thresholds: MilestoneThresholds): MilestoneEvaluation` is pure. `MilestoneStore.observe(binding: IdentityBinding, counters: MilestoneCounters, thresholds: MilestoneThresholds, now: number): MilestoneEvaluation`, `.getState(guildId: string, publicId: string): MilestoneState`, `.listAwards(guildId: string, publicId: string): { metric: 'games' | 'wins'; threshold: string; total: string; observedAt: number }[]`, `.dueMembers(guildId: string, now: number, limit: number): string[]`. Expose `.milestones`; use decimal-text columns.

- [ ] **Step 1: Add pure/store regressions.** Include:

```js
test('large thresholds stay exact and first observations stay quiet', () => {
  const thresholds = { games: ['9007199254740993'], wins: ['1'] };
  const current = { games: 9007199254740993n, wins: 1n, losses: 9007199254740992n };
  const first = evaluateMilestones({ counters: null, initialized: new Set(), earned: new Set() }, current, thresholds);
  assert.equal(first.awards.find(a => a.metric === 'games').threshold, '9007199254740993');
  assert.ok(first.awards.every(a => a.announce === false));
});
```

Also test a previously initialized10/50 threshold crossing from9 to51 queues both once; newly configured thresholds initialize silently; count decreases/repeats never award again; inconsistent `wins+losses > games`, missing/partial data and sparse unrelated scopes are unavailable; rereading an on-disk test DB preserves baselines. Same-account verification preserves awards, a changed account initializes separately, unlink/deletion purges personal records, and another guild/account is unaffected.
- [ ] **Step 2: Build and run `node --test test/milestones.test.mjs`.** Expected red for the new exports/store property.
- [ ] **Step 3: Implement these interfaces with per-account threshold initialization and unique award keys.** Defaults are games10/50/100/250/500 and wins1/10/25/50/100. Keep thresholds and counters as BigInt/decimal text. Write observations, earned awards and notification intents atomically; group announcements later by one account/check. Add member/account/guild cleanup and same-account re-verification preservation. Store last successful observation/next eligible attempt for fair polling without spinning on failing profiles.
- [ ] **Step 4: Build and run milestone, player-stat correctness, history-collection, and foundation core suites.** Expected all pass, including existing deletion/identity tests.
- [ ] **Step 5: Commit `feat: persist exact statistic milestones and silent baselines`.**

### Task 2: Private settings/views and opt-in public cards

**Files:** Create `src/community/milestoneWorker.ts`, `src/commands/milestones.ts`, `test/milestone-delivery.test.mjs`, `test/milestone-interactions.test.mjs`; extend runtime/interactions/command registry, `src/historyCollector.ts`; update command, administration, operations and statistics docs.

**Interfaces:** `registerMilestoneWork(service: CommunityService, client: Client, db: BotDatabase, api: OpenFrontApi): void`; `prepareMilestoneDelivery(job: DeliveryJob, guild: Guild, db: BotDatabase, now: number): Promise<PreparedDelivery | null>`; `createMilestonesCommand(dependencies?: { db?: BotDatabase; api?: OpenFrontApi; now?: () => number })` returns the command object. Settings use foundation `CommunitySettingsStore` with `milestonesEnabled`, `milestoneChannelId`, `gameThresholds`, `winThresholds` and revision.

- [ ] **Step 1: Add worker/configuration tests.** Start two enabled guilds with more than8 due members; count upstream calls across successive ticks and assert each eligible account eventually runs, no account runs twice inside900,000ms, and cards use the four-send shared budget. Defer a profile promise, change its effective link or disable announcements, then resolve it; assert no obsolete awards/jobs or sends. Include:

```js
test('announcement settings default to disabled with approved thresholds', () => {
  const f = communityFixture();
  const settings = f.db.community.settings.get('g');
  assert.equal(settings.milestonesEnabled, false);
  assert.equal(settings.milestoneChannelId, null);
  assert.deepEqual(settings.gameThresholds, ['10', '50', '100', '250', '500']);
  assert.deepEqual(settings.winThresholds, ['1', '10', '25', '50', '100']);
  return f.close();
});
```

Assert channel validation and permission refresh before Save, revision-conflict rejection, no public leak from private views, first baseline emits no card, multiple crossings produce one card, missing data displays unavailable, paused delivery lists/reconciles through private configuration, and milestone-only servers trigger deletion sync without enabling history collection. A stale/failed deletion checkpoint suppresses automatic polling/sending.
- [ ] **Step 2: Build and run both new milestone suites.** Expected red for command/worker wiring.
- [ ] **Step 3: Implement `/milestones view|configure` and private ten-minute settings sessions.** Reuse configuration access for destination/threshold/enablement edits; view uses the caller's link. Register fair polling and milestone delivery preparation. Extend the history collector's existing `needsDeletionSync` condition to include enabled milestone servers, preserving its existing feed request budget and tombstones. Cards show observed values/time and public profile, not an invented achievement date. Refresh current link, clan eligibility, settings revision and deletion health before persisting/sending; cancellation on disable removes pending jobs. Expose deliberate retry/reconciliation and durable earned-card views.
- [ ] **Step 4: Build and run all milestone, foundation-delivery, existing history-collection and access-config suites.** Expected pass, with collection remaining off when only milestones are enabled.
- [ ] **Step 5: Commit `feat: add milestone cards and opt-in announcement controls`.**
