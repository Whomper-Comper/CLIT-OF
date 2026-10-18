# Curated Challenge Wheel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spin complete, compatible map/settings presets that officers can edit through Discord.

**Architecture:** A validated static catalog and six starter presets feed a guild-scoped preset store. A spin makes two bounded cryptographic selections (preset, allowed map); the command renders all relevant hosting settings and can seed an event draft.

**Tech Stack:** TypeScript, SQLite, discord.js14, `node:crypto`, `node:test`.

**Spec:** [Approved design section4](../specs/2026-10-18-clan-community-features-design.md); [foundation contracts](2026-10-18-clan-community.md).

## Global Constraints

- All new commands are server-only.
- A preset bundles an allowed map selection and settings; never generate each setting independently.
- The bot schedules sessions and presents settings for a human to host in OpenFront.
- A five-second per-user cooldown bounds repeated spins.
- Inherit foundation permissions, sessions, mention suppression, and no-new-dependency constraints.

## Review Focus

- An edited FFA preset retaining team-count settings is rejected (task1).
- A zero-bot Humans Vs Nations preset must keep nations enabled (task1).
- All presets disabled or removed produces an actionable response, not an invalid random range (task1).
- A seeded event outlives its source preset edit without silently changing its settings (task1).
- Cross-guild preset/component IDs and revoked officer roles never mutate another guild (task1).

### Task 1: Validated presets, safe spins, and officer editing

**Files:** Create `src/community/wheelPresets.ts`, `src/community/wheel.ts`, `src/commands/wheel.ts`, `test/wheel.test.mjs`; extend store/lifecycle/interactions/command registry; update command, administration, and architecture docs.

**Interfaces:** `WheelPreset = { id: string; guildId: string; name: string; maps: string[]; mode: 'Team' | 'Free For All'; teams: number | 'Duos' | 'Trios' | 'Quads' | 'Humans Vs Nations' | null; difficulty: 'Easy' | 'Medium' | 'Hard' | 'Impossible'; bots: number; nations: number | 'default' | 'disabled'; mapSize: 'Normal' | 'Compact'; disabledUnits: string[]; donateGold: boolean; donateTroops: boolean; randomSpawn: boolean; infiniteGold: boolean; infiniteTroops: boolean; instantBuild: boolean; instructions: string; enabled: boolean; revision: number }`. `STARTER_PRESETS` and `SUPPORTED_MAPS` export from `wheelPresets.ts`.

`validateWheelPreset(input: WheelPreset): WheelPreset`; `spinWheel(presets: WheelPreset[], roll?: (min: number, maxExclusive: number) => number): { preset: WheelPreset; map: string }`. `WheelStore.list(guildId: string): WheelPreset[]`, `.save(input: WheelPreset, expectedRevision: number): WheelPreset`, `.remove(guildId: string, presetId: string, expectedRevision: number): void`; expose `.wheel`. Lazy-seed the six presets only on first guild initialization; record initialization separately so removing all presets does not reseed them. Consume scheduling's `createEventDraft` for officer-only event creation with a copied settings description.

- [ ] **Step 1: Write preset/command tests.** Verify all six named starters exactly match the approved map/settings table, including zero bots for Humans Vs Nations and all four nuclear units disabled for Conventional warfare. Include:

```js
test('wheel uses the selected package and chooses only one of its allowed maps', () => {
  const draws = [1, 0];
  const result = spinWheel(STARTER_PRESETS, (min, max) => {
    const value = draws.shift(); assert.ok(value >= min && value < max); return value;
  });
  assert.equal(result.preset.name, 'Squad skirmish');
  assert.equal(result.map, 'Europe');
  assert.equal(result.preset.teams, 'Quads');
  assert.equal(result.preset.bots, 50);
});
```

Reject51 presets,11 maps, duplicate maps, unsupported maps/units/difficulties, bot counts outside0-400, invalid positive nation counts, FFA with teams, Team without teams, and HvN with disabled nations. Also test exact RNG bounds, no enabled presets, cooldown before drawing, revision conflict, private officer edit sessions, forged components, and copied event settings remaining unchanged after preset edits.
- [ ] **Step 2: Build and run `node --test test/wheel.test.mjs`.** Expected red for new exports/command.
- [ ] **Step 3: Implement the named interfaces and `/wheel spin|presets|add|edit|remove`.** Keep a small explicit supported map catalog containing World, Europe, Black Sea, and Caribbean; adding maps is a deliberate source update. Validate the complete settings bundle, store presets with revisions, and use `randomInt` by default. Provide readable form/select controls through owner-bound private sessions; do not require JSON or filesystem editing. Public spin embeds list all approved hosting fields; private preview validates before save. Add a permission-checked event-draft button containing the copied package, with no automatic publication/signups. Extend guild cleanup.
- [ ] **Step 4: Build and run wheel, event interaction, foundation access, and existing dice suites.** Expected all pass; confirm every preset form fits five inputs/row limits and no public card exposes private availability.
- [ ] **Step 5: Commit `feat: add curated map and settings challenge wheel` with tests/docs.**
