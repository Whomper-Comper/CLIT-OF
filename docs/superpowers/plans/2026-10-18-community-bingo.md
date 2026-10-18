# Shared Server Bingo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each server a shared5x5 challenge board with trustworthy observed progress and officer-approved custom claims.

**Architecture:** Immutable board definitions and deduplicated evidence feed a pure cell/line evaluator. A worker refreshes eligible retained-game/availability evidence; private officer flows manage publication, claims and explicit reset while the public message stays bounded.

**Tech Stack:** TypeScript, SQLite, discord.js14, existing retained player sessions, `node:test`.

**Spec:** [Approved design section6 and privacy rules](../specs/2026-10-18-clan-community-features-design.md); [foundation contracts](2026-10-18-clan-community.md). Scheduling must already provide availability/events/onboarding.

## Global Constraints

- All new commands are server-only.
- One active5x5 board exists per server, with a free center,24 immutable challenge definitions, creation time, optional closing date, and revision.
- Manual objectives stay usable with collection off.
- Game evidence follows the server's player-history retention window.
- A board reset creates a new notification namespace.
- Inherit foundation budgets, officer checks, private claims/review, and atomic lifecycle rules.

## Review Focus

- A match starts before board creation but arrives afterward: never count it (task1).
- A win is corrected to a loss or its account loses eligibility: recompute affected cells/lines (task1).
- Expiring evidence can undo visible progress without reannouncing a regained line (task1).
- A pending approval/reset button targets a replaced board: reject against board ID/revision (task2).
- Very long custom challenge/evidence text cannot overflow public cards or trigger mentions (task2).

### Task 1: Board definitions, evidence, and line evaluation

**Files:** Create `src/community/bingo.ts`, `src/community/bingoEvidence.ts`, `test/bingo.test.mjs`, `test/bingo-evidence.test.mjs`; extend store/lifecycle, availability-clear and history-clear hooks; update architecture/statistics docs.

**Interfaces:** `BingoObjective = { kind: 'appearances' | 'wins' | 'contributors' | 'shared_game' | 'availability' | 'manual'; target: number; label: string }`; `BingoCell = { index: number; objective: BingoObjective | null; complete: boolean; progress: number }`, where index12 is the free center. `BingoBoard = { id: string; guildId: string; channelId: string; messageId: string | null; createdAt: number; closesAt: number | null; status: 'draft' | 'active' | 'archived'; revision: number; cells: BingoCell[] }`; `BingoEvidence = { key: string; boardId: string; discordId: string; publicId: string | null; kind: 'game' | 'availability'; gameId: string | null; at: number; won: boolean }`.

`defaultBingoObjectives(): BingoObjective[]` returns the exact12 automatic/12 manual objectives in the spec. `evaluateBingo(cells: BingoCell[], evidence: BingoEvidence[], approvedCells: Set<number>): { cells: BingoCell[]; lines: string[]; complete: boolean }` emits stable `row:0`...`column:4`/`diagonal:0|1` keys. `collectBingoEvidence(board: BingoBoard, matches: StoredPlayerSession[], available: MemberAvailability[], identities: Map<string, IdentityBinding>, clanTags: Set<string>, retentionStart: number): BingoEvidence[]` consumes only eligible data already supplied by callers.

`BingoStore.createDraft(guildId: string, channelId: string, objectives: BingoObjective[], closesAt: number | null, now: number): BingoBoard`, `.get(guildId: string, boardId: string): BingoBoard | null`, `.getActive(guildId: string): BingoBoard | null`, `.publish(guildId: string, boardId: string, revision: number, messageId: string): BingoBoard`, `.replaceEvidence(guildId: string, boardId: string, revision: number, evidence: BingoEvidence[]): void`, `.refresh(guildId: string, boardId: string, now: number): BingoBoard`, `.archive(guildId: string, boardId: string, revision: number, now: number): void`. Expose `.bingo`; revisions guard definitions/reset, while evidence updates do not invalidate other members' unrelated claims.

- [ ] **Step 1: Add evaluator/evidence tests.** Include:

```js
test('a complete top row has one stable line key', () => {
  const objectives = defaultBingoObjectives();
  assert.equal(objectives.length, 24);
  assert.equal(objectives.filter(o => o.kind === 'manual').length, 12);
  const cells = Array.from({ length: 25 }, (_, index) => ({ index, objective: index === 12 ? null : { kind: 'manual', target: 1, label: String(index) }, complete: index === 12, progress: 0 }));
  assert.deepEqual(evaluateBingo(cells, [], new Set([0, 1, 2, 3, 4])).lines, ['row:0']);
});
```

Test default targets/names, free center, all12 lines, same evidence twice, unique account/game wins, distinct contributors versus repeated appearances, max same-game group size, and three distinct availability submitters. Ignore pre-board/closure-boundary/unfinished/FFA/private/wrong-clan games, stale identity and absent members. Correcting a win or purging/retaining evidence recomputes progress. Test line loss/regain enqueues a completion only once per board, while a new board can announce again. Clearing player history removes game evidence without removing manual approvals/availability evidence; clearing availability removes its member evidence.
- [ ] **Step 2: Build and run `node --test test/bingo.test.mjs test/bingo-evidence.test.mjs`.** Expected red for new store/evaluator.
- [ ] **Step 3: Implement immutable25-cell boards, unique active-board constraints, evidence replacement and notification keys.** Apply date/type/clan/current-identity eligibility before replacing current evidence. Freeze cells at publish; center is free and cannot receive a claim. Keep only retained evidence, update rows/columns/diagonals atomically, and separate current completion from historical notification keys. Extend retention, unlink/account/deletion/member/guild cleanup and optional availability lifecycle callback, so privacy removal cannot reappear from a cached read. Archive/reset removes old controls and retains records for90 days.
- [ ] **Step 4: Build and run new bingo suites plus existing history-collection, onboarding and availability suites.** Expected all pass and collection-disabled game progress is visibly unavailable rather than asserted complete.
- [ ] **Step 5: Commit `feat: track shared bingo boards and deduplicated challenge evidence`.**

### Task 2: Claims, officer review, public board, and worker updates

**Files:** Create `src/community/bingoWorker.ts`, `src/commands/bingo.ts`, `test/bingo-interactions.test.mjs`, `test/bingo-worker.test.mjs`; extend runtime/interactions/command registry; update command, administration and operations docs.

**Interfaces:** `BingoStore.claim(guildId: string, boardId: string, cell: number, actorId: string, explanation: string, evidenceUrl: string | null, now: number): { id: string; status: 'pending' | 'approved' | 'rejected' }`, `.review(guildId: string, claimId: string, officerId: string, approve: boolean, reason: string, expectedRevision: number, now: number): void`, `.claims(guildId: string, boardId: string): { id: string; cell: number; actorId: string; status: string; revision: number }[]`. Review can explicitly revoke a prior manual approval with a reason. `registerBingoWork(service: CommunityService, client: Client, db: BotDatabase): void`; `renderBingoBoard(board: BingoBoard): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }`.

- [ ] **Step 1: Add interaction/worker tests.** Assert duplicate pending claims return the same ID; automatic/free-center claims are rejected; only current officers can approve/revoke/reset; changing board ID/revision invalidates old controls. Assert HTTPS evidence is stored as text/link and never fetched, custom descriptions are bounded/escaped, and a worst-case board stays within embed/content/component limits. Exercise explicit reset confirmation, draft customization of all24 cells, failed publication recovery, collection-disabled/manual-only behavior, stale deletion-feed state, retention labeling, fair guild ticks, and line notification deduplication. Use the foundation fixture to inspect payloads and counts rather than matching full decorative copy.
- [ ] **Step 2: Build and run `node --test test/bingo-interactions.test.mjs test/bingo-worker.test.mjs`.** Expected red for new command/worker exports.
- [ ] **Step 3: Implement `/bingo view|create|claim|review|reset`.** Provide officer-owned private draft cell editing and explicit publication/reset preview; public board shows five numbered rows, progress, lines and Refresh/Claim actions. Claims/explanations/review are private and audited. Register collection-health-aware evidence recomputation using retained sessions; no extra OpenFront requests are needed. Queue `bingo_update` and `bingo_complete` work through shared delivery preparation with active-board binding checks; use `delivered` to bind initial/reconciled publication IDs, with later updates editing that message. Include background updates after claims/privacy/retention changes. Manual review remains usable if history is disabled; display its automatic tracking limitation on the card.
- [ ] **Step 4: Build and run all bingo suites and foundation delivery/access tests.** Expected all pass; server A's reset/review cannot alter server B.
- [ ] **Step 5: Commit `feat: add shared bingo cards and officer-reviewed claims`.**
