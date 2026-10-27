# Lobby Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Watch live OpenFront lobbies, DM matching members, fall back to a server ping, and stop unless they continue within 180 seconds.

**Architecture:** A standalone revision-pinned feed adapter normalizes live snapshots. Feature-owned SQLite state and a paced worker handle matching, durable DM/fallback delivery, and continuation controls without changing the guild-only community transport.

**Tech Stack:** TypeScript, discord.js 14, Node WebSocket/fetch, node:sqlite, upstream binary lobby codec.

**Spec:** `docs/superpowers/specs/2026-10-24-lobby-alerts-design.md`

## Global Constraints

- Preserve existing README and agent-guide work; work on current feature branch.
- No live bot login, command registration, or deployment.
- Response deadline: 180 seconds from successful delivery; stale feed cutoff: 30 seconds.
- Maximum ten saved rules per guild/member; all selected conditions must match.
- No game checkout runtime dependency; reject incompatible protocols.
- Definite rejected DM triggers public fallback; uncertain sends require review.

## Review Focus

- Deployment/protocol changes must invalidate feed data, never silently misdecode.
- Stale controls and timeout callbacks cannot mutate replacement searches.
- A settings/rule/membership change during a request must prevent the next send.
- Restart after an uncertain send must not repeat the DM or publish fallback.
- An obsolete lobby before first delivery resumes searching without a deadline.

### Task 1: Feed and matcher

**Files:** `src/lobby/feed.ts`, `src/lobby/codec.ts`, `src/lobby/model.ts`, `src/lobby/vendor/`, `tools/vendor-lobby-codec.mjs`, `test/lobby-feed.test.mjs`.

**Interfaces:** `LobbyFeed.snapshot(): LobbySnapshot | null`, `start(): void`, `stop(): void`; `matches(rule, lobby, now): boolean`; normalized `Lobby` includes source, ID, map, mode, category, count, capacity and start deadline.

- [x] Write failing fixtures for normalization/matching, full/count frames, stale/disconnected data, discovery and incompatible builds.
- [x] Run `node --test test/lobby-feed.test.mjs` and confirm failure before implementation.
- [x] Verify official discovery/feed contract; bundle a pinned standalone decoder with upstream license and provenance, validate and merge bounded binary frames, reconnect with backoff.
- [x] Build and run feed tests; confirm all pass.

### Task 2: Persist searches and notifications

**Files:** `src/lobby/store.ts`, `src/community/store.ts`, `src/community/lifecycle.ts`, `test/lobby-store.test.mjs`.

**Interfaces:** `LobbyStore.initialize(sql)`, `configure`, `watch`, `rules`, `resume`, `stop`, `search`, `select`, `notification`, `delivered`, `continue`, `expire`, `prune`.

- [x] Write failing tests for defaults, filters, ten-rule bound, per-member/guild scope, durable deduplication, generation binding and exact deadline boundary.
- [x] Implement backed-up schema initialization and transactional transitions with injected clock values.
- [x] Test restart expiry, retained filters, disable/departure cleanup, replacement controls and obsolete candidate cancellation.
- [x] Build and run store tests; confirm all pass.

### Task 3: Delivery worker

**Files:** `src/lobby/worker.ts`, `src/lobby/messages.ts`, `test/lobby-delivery.test.mjs`.

**Interfaces:** `LobbyWorker.tick(): Promise<void>`, `start(): void`, `stop(): Promise<void>`; injected feed/client/clock.

- [x] Write failing behavioral tests for DM success, rejected DM fallback/guidance, bounded transient retries, ambiguous send/restart, stale/obsolete lobby, post-await revocation and stop/drain.
- [x] Implement fair bounded scheduling, synchronous final state revalidation and persisted sending outcomes. Button IDs bind notification and generation; message content explains exact deadline.
- [x] Run focused delivery tests and previous lobby suites; confirm all pass.

### Task 4: Commands and runtime

**Files:** `src/commands/lobby.ts`, `src/commands/index.ts`, `src/community/interactions.ts`, `src/index.ts`, `test/lobby-interactions.test.mjs`, existing registry/router tests.

**Interfaces:** `createLobbyCommand(database, options)` returns command definition/execute/handleInteraction. Guild-only slash commands; DM-capable continuation buttons.

- [x] Write failing tests for command inputs, private replies, fresh configure authorization, destination validation, owner/message/deadline validation and search restart.
- [x] Implement watch/list/remove/resume/stop/configure with supported catalog autocomplete; wire startup/shutdown and prefix/autocomplete dispatch.
- [x] Update registry count assertions for the sixteenth command and run actual router tests.

### Task 5: Documentation and final verification

**Files:** README, commands/admin/architecture/development/operations docs; approved spec and this plan.

- [x] Document setup, fallback consent, three-minute continuation, current-player semantics, feed provenance/upgrade limitations and delivery diagnostics.
- [x] Run `npm run build`, `npm test`, and `git diff --check`; report actual results and environment limitations.
- [x] Request a fresh whole-change review, fix material findings with regression tests, and summarize delivered behavior. Leave changes reviewable in the current checkout; do not register or deploy.
