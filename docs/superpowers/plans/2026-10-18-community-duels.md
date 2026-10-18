# Dice Duel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two consenting members roll persistent D6 results and show the higher roll as the winner.

**Architecture:** A SQLite state machine owns pending participant slots, cooldowns, expiry and stored rolls. The command checks live membership, binds public buttons, and renders the saved outcome; restart recovery never draws again.

**Tech Stack:** TypeScript, SQLite, discord.js14, `node:crypto`, `node:test`.

**Spec:** [Approved design section7](../specs/2026-10-18-clan-community-features-design.md); [foundation contracts](2026-10-18-clan-community.md).

## Global Constraints

- All new commands are server-only.
- Keep the existing `/dice` interface unchanged and add `/duel` separately.
- Invitations expire after two minutes.
- Limit each member to one pending duel per server and apply a30-second invitation cooldown per challenger.
- Store resolved rolls before showing an animation/result so a restart or failed Discord edit cannot reroll the outcome.
- There are no bets, currency, or ranked standings.

## Review Focus

- Two Accept clicks race: only one transition draws two numbers (task1).
- A persisted result survives a failed Discord edit/restart unchanged (tasks1-2).
- The opponent leaves while membership validation is in flight: cancel/reject instead of resolving (task2).
- Repeated/simultaneous rematch requests still require fresh acceptance and pending-slot limits (task2).
- A forged Accept/Cancel/Refresh from another guild or message cannot change the invitation (task2).

### Task 1: Persistent invitation/result state machine

**Files:** Create `src/community/duels.ts`, `test/duels.test.mjs`; extend store/lifecycle and core retention; update architecture docs.

**Interfaces:** `DuelRecord` extends `EntityBinding` with `{ id: string; challengerId: string; opponentId: string; status: 'pending' | 'resolved' | 'declined' | 'cancelled' | 'expired'; challengerRoll: number | null; opponentRoll: number | null; createdAt: number; expiresAt: number; resolvedAt: number | null; revision: number; rematchOf: string | null }`. `DuelStore.invite(binding: EntityBinding, challengerId: string, opponentId: string, now: number, rematchOf?: string): DuelRecord`, `.get(guildId: string, duelId: string): DuelRecord | null`, `.bindMessage(guildId: string, duelId: string, revision: number, messageId: string): void`, `.resolve(guildId: string, duelId: string, actorId: string, now: number, roll?: (min: number, maxExclusive: number) => number): DuelRecord`, `.decline(guildId: string, duelId: string, actorId: string, now: number): DuelRecord`, `.cancel(guildId: string, duelId: string, actorId: string, now: number): DuelRecord`, `.expire(now: number): DuelRecord[]`. Expose `.duels`.

- [ ] **Step 1: Write real-store transitions, boundary and reopen tests.** Include:

```js
test('accepting twice reuses the saved independent D6 rolls', () => {
  const f = communityFixture();
  const duel = f.db.community.duels.invite({ guildId: 'g', channelId: 'c', messageId: null }, 'a', 'b', f.now());
  let calls = 0;
  const roll = (min, max) => { assert.equal(min, 1); assert.equal(max, 7); return ++calls === 1 ? 1 : 6; };
  const first = f.db.community.duels.resolve('g', duel.id, 'b', f.now(), roll);
  const repeated = f.db.community.duels.resolve('g', duel.id, 'b', f.now(), roll);
  assert.equal(calls, 2);
  assert.deepEqual([first.challengerRoll, repeated.opponentRoll], [1, 6]);
  return f.close();
});
```

Also assert both winner orders, tie, opponent-only consent/decline, challenger-only cancellation, same-member rejection, per-server pending slots for either participant, cooldown at29,999/30,000ms, expiry at120,000ms, rollback on RNG failure, reopens preserving results, and guild/member cleanup. Sequential duplicate tests exercise the atomic compare-and-transition, while command tests add genuinely concurrent deferred interactions.
- [ ] **Step 2: Build and run `node --test test/duels.test.mjs`.** Expected red for new state machine.
- [ ] **Step 3: Implement the store with unique active participant rows and durable cooldowns.** Claim pending state inside the savepoint before calling `randomInt(1,7)` twice; duplicate authorized Accept reads stored outcome without drawing. Release participant slots in the same transaction as every terminal transition. Record expiry/rolls before any awaited rendering. Purge resolved/expired/declined/cancelled records30 days after their terminal time, with bounded stale-cooldown cleanup.
- [ ] **Step 4: Build and run duel and existing dice suites plus foundation core tests.** Expected pass; dice registration/animation remains unchanged.
- [ ] **Step 5: Commit `feat: persist consent-based dice duel outcomes`.**

### Task 2: Challenge buttons, rematches, expiry, and recovery

**Files:** Create `src/commands/duel.ts`, `test/duel-interactions.test.mjs`; extend runtime/interactions/command registry/lifecycle; update command, administration, operations and README docs.

**Interfaces:** `createDuelCommand(dependencies?: { db?: BotDatabase; now?: () => number; roll?: (min: number, maxExclusive: number) => number })` returns the slash command; `handleDuelInteraction(i: Interaction): Promise<boolean>` handles `clit-duel:` actions; `registerDuelWork(service: CommunityService, client: Client, db: BotDatabase): void` queues expiry/result message updates and registers `duel_update` preparation. `renderDuel(record: DuelRecord)` returns an embed/components payload derived exclusively from saved state.

- [ ] **Step 1: Write controlled interaction tests.** Assert `/duel opponent` rejects bots/self/departed members, invites publicly, and binds its message before enabling action buttons. Defer two Accept interactions, resolve both, and assert two RNG calls total and one saved result. Reject Accept by a third party, Cancel by the opponent, and cross-server/channel/message controls. On failed result edit, Refresh/restart displays identical saved rolls without RNG. An opponent disappearing during validation cannot resolve; departure/expiry disables controls. Tied-result Rematch creates a pending invitation between the same participants with fresh consent, still enforcing cooldown/unique pending slots, and simultaneous rematches cannot create two invitations.
- [ ] **Step 2: Build and run `node --test test/duel-interactions.test.mjs`.** Expected red for new handlers/registration.
- [ ] **Step 3: Implement the command and persistent controls.** Refresh both guild memberships before resolution and check the stored actor/action/binding/expiry again before writing. Render a brief optional rolling state only after storing the result; final payload identifies each saved roll and winner/tie. Preserve Rematch only for tied results and Refresh for recovery; terminal invitations have Accept/Decline/Cancel disabled. Queue expired/departed/cancelled message updates through the shared worker, within its existing four-send budget. Publication failures reconcile or cancel the pending record instead of creating duplicate invitations. No direct messages or wagering features.
- [ ] **Step 4: Build and run duel interaction/state, existing dice, router, and foundation delivery suites.** Expected all pass, including exact invitation bounds and stable outcomes after failure.
- [ ] **Step 5: Commit `feat: add dice challenge buttons and consent-based rematches`.**
