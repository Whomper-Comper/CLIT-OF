# Scheduling, Availability, and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let members find common playing times, join capacity-limited squad events, and complete newcomer steps that officers can inspect.

**Architecture:** Availability projects recurring local windows onto real instants; event stores own transactional signups/reserves; onboarding derives progress from current data. Commands render public events and private personal/management views. The shared worker delivers optional reminders and maintains event state.

**Tech Stack:** TypeScript, discord.js 14, SQLite, `Intl`, `node:test`; no new dependencies.

**Spec:** [Approved design sections 1-3](../specs/2026-10-18-clan-community-features-design.md); [foundation contracts/order](2026-10-18-clan-community.md).

## Global Constraints

- All new commands are server-only.
- A member's raw recurring availability is visible only to that member and officers; public suggestions show counts rather than a list of private schedules.
- The bot never holds a database transaction across an awaited Discord/API request.
- Reminders are optional and off by default.
- Signups close at the start instant.
- Inherit the foundation's runtime, permission, dependency, mention, and lifecycle constraints.

## Review Focus

- Repeated clock hours must not manufacture availability between two real windows (task 1).
- An overnight window must count the previous weekday after midnight (task 1).
- Two withdrawals/promotions arriving together must leave a valid reserve order and capacity (task 2).
- A changed event time must invalidate reminders already queued for its old revision (task 3).
- Clan API unavailability must display Unknown without undoing or inventing clan approval (task 4).

### Task 1: Weekly availability, real-time projection, and suggestions

**Files:** Create `src/community/time.ts`, `src/community/availability.ts`, `src/commands/availability.ts`, `test/community-time.test.mjs`, `test/availability.test.mjs`; extend `src/community/store.ts`, `lifecycle.ts`, `interactions.ts`, `src/commands/index.ts`; update `docs/commands.md` and `docs/server-administration.md`.

**Interfaces:** `LocalWindow = { id: string; weekday: number; startMinute: number; endMinute: number }` (Monday=0); `MemberAvailability = { guildId: string; discordId: string; timezone: string; windows: LocalWindow[]; revision: number; updatedAt: number }`; `AvailabilityStore.get(guildId, discordId): MemberAvailability | null`, `.list(guildId): MemberAvailability[]`, `.save(input: Omit<MemberAvailability, 'revision' | 'updatedAt'>, expectedRevision: number, now: number): MemberAvailability`, `.clear(guildId: string, discordId: string): void`. Expose `db.community.availability`.

`possibleInstants(local: string, timezone: string): number[]` accepts `YYYY-MM-DD HH:mm`; `resolveEventStart(local: string, timezone: string, offset?: string): number` rejects zero matches and requires a matching `+/-HH:mm` offset for multiple matches. `projectAvailability(member: MemberAvailability, start: number, end: number): { start: number; end: number }[]` returns merged disjoint UTC intervals. `suggestAvailability(members: MemberAvailability[], now: number, durationMinutes = 120): { start: number; end: number; memberIds: string[] }[]` returns up to three distinct suggestions for the next 14 days. `memberIds` is internal and never rendered publicly.

- [ ] **Step 1: Write tests for validation/projection/counting and private/public command payloads.** Include:

```js
test('event wall times reject gaps and disambiguate folds', () => {
  assert.deepEqual(possibleInstants('2026-03-08 02:30', 'America/New_York'), []);
  assert.throws(() => resolveEventStart('2026-11-01 01:30', 'America/New_York'), /offset/i);
  assert.equal(resolveEventStart('2026-11-01 01:30', 'America/New_York', '-05:00'), Date.parse('2026-11-01T06:30:00Z'));
  assert.throws(() => resolveEventStart('2026-02-30 18:00', 'UTC'), /date/i);
});
```

For a New York Sunday 01:00-01:30 recurring window at the fall transition, assert projections `[05:00Z,05:30Z)` and `[06:00Z,06:30Z)` rather than a continuous 90 minutes. Assert Bahia Friday 23:00-01:00 includes local Saturday 00:30. Reject invalid zones, zero-length windows, 15 windows, and durations outside 30-720 minutes. Suggestion tests cover duplicate/adjacent windows, full-duration coverage, fractional-hour zones, counts once per member, past starts, descending count/ascending time order, 30-minute starts, and suppression of overlapping equal-member suggestions. Commands deny viewing another member unless officer, return personal replies privately, and strip IDs/windows from public suggestions.

- [ ] **Step 2: Build and run `node --test test/community-time.test.mjs test/availability.test.mjs`.** Expected red for the new exports/command registration.
- [ ] **Step 3: Implement these interfaces and register `/availability set|view|clear|suggest`.** `set` adds/replaces one weekday/start/end window using the saved timezone, requiring timezone on the first save; `view` supplies private edit/delete controls; `clear` removes a selected window or all windows. Validate 14 windows, half-open 30-720 minute windows and 30-240 minute suggestion duration. Persist local rules. Project by intersecting local windows with constant-offset intervals, splitting at timezone transitions; do not stretch a folded partial hour into unavailable time. Merge intervals before scoring, filter to freshly fetched current members, and paginate personal lists. Use private ten-minute owner-bound edit sessions. Add an officer-only Create event draft action once task 2 exists. Extend member/guild cleanup and retention-safe availability change evidence for future bingo use.
- [ ] **Step 4: Rebuild and run both suites plus `test/access-config.test.mjs`.** Expected pass, including same-zone schedule behavior after an offset transition and no changes to existing recap timezone semantics.
- [ ] **Step 5: Commit `feat: add timezone-aware member availability and overlap suggestions`.** Include this task's source, tests, registrations, and docs only.

### Task 2: Atomic event/squad state and Discord signup flows

**Files:** Create `src/community/events.ts`, `src/commands/event.ts`, `test/events.test.mjs`, `test/event-interactions.test.mjs`; extend store/lifecycle/interactions/command registry and availability's event-draft action; update command/administration docs.

**Interfaces:** `EventDraftInput = { guildId: string; channelId: string; creatorId: string; title: string; description: string; startAt: number; durationMinutes: number; capacity: number; squads: { id: string; name: string; capacity: number }[]; reminderMinutes: 0 | 15 | 30 | 60; settingsText?: string }`. `EventRecord` extends this plus `{ id: string; messageId: string | null; status: 'draft' | 'scheduled' | 'cancelled' | 'finished'; revision: number; createdAt: number }`. `EventSignup = { discordId: string; squadId: string | null; state: 'confirmed' | 'reserve'; sequence: number; reminder: boolean }`.

Expose `db.community.events: EventStore` with `.createDraft(input, now): EventRecord`, `.get(guildId, eventId): EventRecord | null`, `.list(guildId): EventRecord[]`, `.signups(guildId, eventId): EventSignup[]`, `.publish(guildId, eventId, revision, messageId): EventRecord`, `.edit(guildId, eventId, revision, changes: Partial<EventDraftInput>, now): EventRecord`, `.cancel(guildId, eventId, revision, now): EventRecord`, `.join(guildId, eventId, userId, squadId: string | null, now): EventSignup`, `.withdraw(guildId, eventId, userId, eligibleMembers: Set<string>, now): void`, `.move(guildId, eventId, userId, squadId: string, eligibleMembers: Set<string>, now): EventSignup`, `.setReminder(guildId, eventId, userId, enabled: boolean, now): void`, `.promote(guildId, eventId, eligibleMembers: Set<string>, now): void`. All implicit ID/time parameters are `string`/`number`. `renderEvent(event, signups, page = 1): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }` exports from the command file. `createEventDraft(i: Interaction, seed: Partial<EventDraftInput>): Promise<void>` opens an officer-only private draft for reuse by suggestions/wheel.

- [ ] **Step 1: Add state-machine and command tests.** Use a two-seat unsquadded event with four members; assert `join` yields confirmed/confirmed/reserve/reserve, repeating Join does not alter sequence, and the first withdrawal promotes only the oldest present reserve. Repeat with separate one-seat squads, a departed first reserve, an atomic squad move, and nested rollback. Assert a lower-than-occupancy capacity edit and removal of an occupied squad fail without changes. At exactly `startAt`, Join and reserve promotion reject. Restart a real test DB and assert identical ordered signups. Interaction tests assert owner/officer checks, public message binding, malformed IDs, 20-squad selection limits, 100-member list pagination, and explicit date/offset preview before publish.
- [ ] **Step 2: Build and run `node --test test/events.test.mjs test/event-interactions.test.mjs`.** Expected red for the new state/command exports.
- [ ] **Step 3: Implement event/squad/signup tables and the named flows.** Enforce 15-720 minutes, start within 365 days, capacity 1-100/default20, duration default120, at most20 squads whose capacities sum correctly. Use unique `(event,user)` and stable sequence values inside SAVEPOINT transitions. Refresh relevant memberships before promotion and pass the eligible set into the transaction; no awaited fetch inside it. Departures remove active signups and mark remaining promotions due for the worker. Register `/event create|list|view|edit|cancel`; use private sessions for squad editing, member moves and publish preview. Publish a saved draft through the shared delivery path and bind the resulting message only to its matching revision; failed publication stays recoverable. Private squad selectors bind their own owner/session/message and retain a checked reference to the original public event, rather than comparing the ephemeral selector message ID to the public message ID. Every public action rereads the event. Add Join/Withdraw/Choose squad/Reminder and list/refresh controls with bounded rendering.
- [ ] **Step 4: Rebuild and run both new suites and `test/availability.test.mjs`.** Expected pass; event drafts created from suggestions remain unpublished and empty until confirmed.
- [ ] **Step 5: Commit `feat: add persistent team events and squad signups` with related tests/docs.**

### Task 3: Event reminders, lifecycle, and recoverable publication

**Files:** Create `src/community/eventDelivery.ts`, `test/event-delivery.test.mjs`; extend `runtime.ts`, `lifecycle.ts`, `events.ts`, `src/commands/event.ts`; update `docs/operations.md` and `docs/architecture.md`.

**Interfaces:** `registerEventWork(service: CommunityService, client: Client, db: BotDatabase): void` installs the event housekeeping task and `event_publish`, `event_update`, `event_reminder` delivery handlers. `prepareEventDelivery(job: DeliveryJob, guild: Guild, db: BotDatabase, now: number): Promise<PreparedDelivery | null>` reloads event revision, destination access and eligible signup/reminder data. Event management lists/reconciles/retries its jobs through foundation delivery APIs.

- [ ] **Step 1: Write delivery tests.** Assert no reminder for a default event; 30-minute enabled reminders enqueue at `startAt - 1_800_000`; only current opted-in confirmed participants appear in `allowedMentions.users`. Withdrawn/reserve/departed members are absent. Change time/cancel after enqueue and assert zero obsolete sends. At `now === startAt`, overdue reminders cancel. Test split reminder parts with stable keys; known publication recovery edits/binds the original message, ambiguous timeout pauses for reconciliation, and no automatic second event appears. Expired signups disable controls; prune only events ended/cancelled more than90 days earlier. A member departure schedules and completes correct reserve promotion.
- [ ] **Step 2: Build and run `node --test test/event-delivery.test.mjs`.** Expected red for missing event worker/handlers.
- [ ] **Step 3: Implement the handlers, optional reminders, event completion, promotion work, message refresh and officer job recovery UI.** Queue idempotently by event/revision/kind/part. Publish through the foundation handler's `delivered` callback so initial/reconciled sends bind exactly the matching draft revision. Snapshot deterministic recipient chunks when creating split reminder jobs, then filter each chunk against current eligibility at send time; do not reshuffle already-sent parts. Use the shared send budget and stale-revision cancellation. Delete retained event/signups only after90 days; clear server-owned records on guild removal. Do not create DM reminders or automatically enable a reminder for a member.
- [ ] **Step 4: Build and run event delivery/state/interaction suites plus foundation delivery tests.** Expected all pass with four sends at most in a default tick.
- [ ] **Step 5: Commit `feat: deliver opt-in event reminders with restart recovery`.**

### Task 4: Derived newcomer checklist and private officer queue

**Files:** Create `src/community/onboarding.ts`, `src/commands/onboarding.ts`, `test/onboarding.test.mjs`; extend store/lifecycle/interactions/command registry; update command and administration docs.

**Interfaces:** `OnboardingStore.enroll(guildId: string, discordId: string, clanTag: string, now: number): void`, `.list(guildId: string): { discordId: string; clanTag: string; enrolledAt: number; completedAt: number | null }[]`, `.markCompletion(guildId: string, discordId: string, completed: boolean, now: number): void`; expose `.onboarding`. `buildOnboardingStatus(guild: Guild, discordId: string, clanTag: string, db: BotDatabase, api: OpenFrontApi, now: number): Promise<{ steps: { key: 'link' | 'clan' | 'availability' | 'event'; state: 'complete' | 'incomplete' | 'waiting' | 'unknown'; detail: string }[]; nextStep: string | null }>`.

- [ ] **Step 1: Write status/authorization tests.** Assert an approval-role holder missing target clan membership is Waiting; a fresh profile membership is Complete; profile failure is Unknown; server-approved linking is labeled server-only; another linked account cannot inherit the previous account's membership result. Confirmed future or retained past signup satisfies the final step; reserve/cancelled/withdrawn does not. Clearing availability or unlinking reevaluates the relevant step. Multiple configured clans require selection. Officer queue is private, paginated10 at a time, restricted after role revocation, and never queries profiles for unlinked members.
- [ ] **Step 2: Build and run `node --test test/onboarding.test.mjs`.** Expected red for status/command exports.
- [ ] **Step 3: Implement enrollment, derived steps, completion marker, `/onboarding status|queue`, and private Refresh/next-step guidance.** Enroll on first self-status with the selected clan. Fresh-fetch profile/membership and recheck identity before saving completion or rendering; use Unknown on failure. Queue only enrolled current members, fresh-fetch at most the10 linked profiles on its current page, and throttle queue navigation. Preserve the distinction between signup and attendance. Extend unlink/account-replacement/departure/guild cleanup without changing existing account verification.
- [ ] **Step 4: Build and run onboarding, availability, and event suites plus `test/bot.test.mjs`.** Expected all pass; no unrelated role/history change.
- [ ] **Step 5: Commit `feat: guide clan onboarding and show officer follow-up queue`.**
