import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { communityFixture } from './helpers/community.mjs';
import { milestoneFixture } from './helpers/milestones.mjs';
import { CommunityStore } from '../dist/community/store.js';
import { DeliveryStore } from '../dist/community/deliveries.js';
import { createMilestonesCommand } from '../dist/commands/milestones.js';
import { CommunitySessions } from '../dist/community/sessions.js';
import { buildOnboardingStatus } from '../dist/community/onboarding.js';
import { defaultBingoObjectives } from '../dist/community/bingo.js';
import { collectBingoEvidence } from '../dist/community/bingoEvidence.js';
import { createCommunityService } from '../dist/community/runtime.js';
import { renderEvent } from '../dist/commands/eventViews.js';
import { renderBingoBoard } from '../dist/commands/bingoViews.js';
import { renderDuel } from '../dist/commands/duelViews.js';
import { createAvailabilityCommand } from '../dist/commands/availability.js';
import { createOnboardingCommand } from '../dist/commands/onboarding.js';
import { createEventCommand } from '../dist/commands/event.js';
import { createWheelCommand } from '../dist/commands/wheel.js';
import { wheelCard, wheelPreview } from '../dist/commands/wheelForms.js';
import { STARTER_PRESETS, SUPPORTED_UNITS } from '../dist/community/wheelPresets.js';

function clan(f, guildId = 'g') {
  f.db.setGuildClanConfig({ guild_id: guildId, clan_tag: 'MARS', member_role_id: 'member',
    officer_role_id: 'officer', leader_role_id: null, join_role_id: null,
    log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
}
function availability(f, guildId = 'g', discordId = 'u') {
  return f.db.community.availability.save({ guildId, discordId, timezone: 'UTC',
    windows: [{ id: 'w', weekday: 0, startMinute: 600, endMinute: 720 }] }, 0, f.now());
}
function event(f, extra = {}) {
  return f.db.community.events.createDraft({ guildId: 'g', channelId: 'c', creatorId: 'officer',
    title: 'Clan night', description: '', startAt: f.now() + 3600000, durationMinutes: 120,
    capacity: 20, squads: [], reminderMinutes: 0, ...extra }, f.now());
}

test('signup and saved availability complete onboarding and feed bingo through the actual shared runtime', async (t) => {
  const f = communityFixture();
  try {
    t.mock.method(Date, 'now', f.now);
    clan(f);
    f.addMember('u');
    f.db.linkUser('u', 'player', null, 'identity_token');
    f.api.getPlayerProfile = async () => ({ clans: [{ tag: 'MARS' }] });
    f.db.community.onboarding.enroll('g', 'u', 'MARS', f.now());
    const draft = f.db.community.bingo.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
    const board = f.db.community.bingo.publish('g', draft.id, draft.revision, 'board');
    const scheduled = event(f);
    f.db.community.events.publish('g', scheduled.id, scheduled.revision, 'event');
    f.db.community.events.join('g', scheduled.id, 'u', null, f.now());
    let status = await buildOnboardingStatus(f.guild, 'u', 'MARS', f.db, f.api, f.now());
    assert.equal(status.steps.find(s => s.key === 'availability').state, 'incomplete');
    availability(f);
    status = await buildOnboardingStatus(f.guild, 'u', 'MARS', f.db, f.api, f.now());
    assert.equal(status.nextStep, null);
    assert.equal(f.db.community.onboarding.list('g')[0].completedAt, f.now());
    assert.match(status.steps.find(s => s.key === 'event').detail, /not proof of attendance/);
    const service = createCommunityService(f.client, f.db, f.api);
    f.services.push(service);
    // One persisted source phase per turn: games, then availability, then finalized publication.
    for (let n = 0; n < 3; n++) await service.runOnce();
    assert.equal(f.db.community.bingo.get('g', board.id).cells[11].progress, 1);
    assert.equal(f.db.community.bingo.listEvidence('g', board.id).filter(e => e.kind === 'availability').length, 1);
    await service.stop();
    const calls = JSON.stringify(f.calls);
    await service.runOnce();
    assert.equal(JSON.stringify(f.calls), calls, 'stopped runtime must release no new requests or deliveries');
    f.db.community.availability.clear('g', 'u');
    assert.equal(f.db.community.bingo.get('g', board.id).cells[11].progress, 0);
    assert.equal((await buildOnboardingStatus(f.guild, 'u', 'MARS', f.db, f.api, f.now())).steps[2].state, 'incomplete');
  } finally { await f.close(); }
});

test('disabling milestones cancels pending and leased awards without affecting event delivery', async () => {
  const f = milestoneFixture();
  try {
    const settings = f.db.community.settings.save('g', { milestonesEnabled: true, milestoneChannelId: 'c',
      gameThresholds: ['10'], winThresholds: ['1'] }, 0);
    const d = f.db.community.deliveries;
    const make = (key, kind) => d.enqueue({ key, kind, guildId: 'g', channelId: 'c', subjectId: key,
      revision: settings.revision, part: 0, dueAt: f.now() });
    const leased = make('leased', 'milestone');
    d.claim(f.now(), 1);
    const pending = make('pending', 'milestone');
    const untouched = make('event', 'event_publish');
    f.db.community.settings.save('g', { ...settings, milestonesEnabled: false }, settings.revision);
    for (const job of [leased, pending]) {
      assert.equal(d.get(job.id).status, 'cancelled');
      assert.equal(d.get(job.id).leaseId, null);
    }
    assert.equal(d.get(untouched.id).status, 'pending');
  } finally { await f.close(); }
});

test('account deletion purges history and derived community data across guilds while preserving another account', async () => {
  const f = communityFixture();
  try {
    f.db.linkUser('u', 'deleted', null, 'identity_token');
    f.db.linkUser('v', 'retained', null, 'identity_token');
    const untouchedBinding = { guildId: 'untouched', discordId: 'v', publicId: 'retained',
      linkedAt: f.db.getEffectiveLink('untouched', 'v').linked_at };
    f.db.community.milestones.observe(untouchedBinding, { games: 99n, wins: 9n, losses: 90n },
      { games: ['10'], wins: ['1'] }, f.now());
    availability(f, 'untouched', 'v');
    const untouched = () => JSON.stringify({ milestones: f.db.community.milestones.listAwards('untouched', 'retained'),
      availability: f.db.community.availability.get('untouched', 'v') });
    const untouchedBefore = untouched();
    for (const guildId of ['g', 'other']) {
      clan(f, guildId);
      const settings = f.db.history.getSettings(guildId);
      f.db.history.saveSettings(guildId, { ...settings, collection_enabled: 1 }, settings.revision);
      f.db.history.setMeta('deletions_last_success', new Date(f.now()).toISOString());
      const draft = f.db.community.bingo.createDraft(guildId, 'c', defaultBingoObjectives(), null, f.now());
      const board = f.db.community.bingo.publish(guildId, draft.id, draft.revision, `board-${guildId}`);
      const identities = new Map();
      const matches = [];
      for (const [discordId, publicId] of [['u', 'deleted'], ['v', 'retained']]) {
        const binding = { guildId, discordId, publicId, linkedAt: f.db.getEffectiveLink(guildId, discordId).linked_at };
        identities.set(discordId, binding);
        f.db.community.milestones.observe(binding, { games: 11n, wins: 1n, losses: 10n }, { games: ['10'], wins: ['1'] }, f.now());
        f.db.community.onboarding.enroll(guildId, discordId, 'MARS', f.now());
        f.db.community.onboarding.markCompletion(guildId, discordId, true, f.now(), { publicId, clanTag: 'MARS' });
        const match = { public_id: publicId, discord_id: discordId, gameId: `game-${publicId}`,
          gameStart: new Date(f.now()).toISOString(), gameEnd: new Date(f.now() + 1000).toISOString(),
          gameType: 'Public', gameMode: 'Team', clanTag: 'MARS', hasWon: true };
        matches.push(match);
        f.db.history.upsertPlayerMatches(guildId, publicId, discordId, [match]);
      }
      const available = availability(f, guildId);
      const evidence = collectBingoEvidence(board, matches, [available], identities, new Set(['MARS']), 0);
      f.db.community.bingo.replaceEvidence(guildId, board.id, board.revision, evidence, undefined, f.now());
    }
    f.db.history.purgePlayer('deleted');
    assert.equal(untouched(), untouchedBefore);
    assert.equal(f.db.community.milestones.getState('untouched', 'retained').counters.games, 99n);
    assert.equal(f.db.history.isDeleted('deleted'), true);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM history_player_matches WHERE public_id='deleted'").get().n, 0);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) n FROM history_player_matches WHERE public_id='retained'").get().n, 2);
    for (const guildId of ['g', 'other']) {
      assert.equal(f.db.community.milestones.getState(guildId, 'deleted').counters, null);
      assert.equal(f.db.community.milestones.getState(guildId, 'retained').counters.games, 11n);
      const enrollments = f.db.community.onboarding.list(guildId);
      assert.equal(enrollments.find(e => e.discordId === 'u').completedAt, null);
      assert.equal(enrollments.find(e => e.discordId === 'v').completedAt, f.now());
      const board = f.db.community.bingo.getActive(guildId);
      const evidence = f.db.community.bingo.listEvidence(guildId, board.id);
      assert.equal(evidence.some(e => e.publicId === 'deleted'), false);
      assert.equal(evidence.some(e => e.publicId === 'retained'), true);
      assert.equal(evidence.some(e => e.kind === 'availability'), true);
      assert.equal(f.db.community.availability.get(guildId, 'u').windows.length, 1);
    }
  } finally { await f.close(); }
});

function assertDiscordLimits(payload) {
  const json = JSON.parse(JSON.stringify(payload));
  assert.ok((json.content?.length ?? 0) <= 2000);
  assert.ok((json.embeds?.length ?? 0) <= 10);
  let total = 0;
  for (const embed of json.embeds ?? []) {
    for (const [text, limit] of [[embed.title, 256], [embed.description, 4096],
      [embed.author?.name, 256], [embed.footer?.text, 2048]]) {
      assert.ok((text?.length ?? 0) <= limit);
      total += text?.length ?? 0;
    }
    assert.ok((embed.fields?.length ?? 0) <= 25);
    for (const field of embed.fields ?? []) {
      assert.ok(field.name.length <= 256 && field.value.length <= 1024);
      total += field.name.length + field.value.length;
    }
  }
  assert.ok(total <= 6000, `embed text ${total}`);
  assert.ok((json.components?.length ?? 0) <= 5);
  for (const row of json.components ?? []) {
    assert.ok(row.components.length <= 5);
    for (const c of row.components) {
      assert.ok((c.custom_id?.length ?? 0) <= 100);
      assert.ok((c.label?.length ?? 0) <= 80);
      assert.ok((c.placeholder?.length ?? 0) <= 150);
      assert.ok((c.options?.length ?? 0) <= 25);
      for (const option of c.options ?? []) {
        for (const value of [option.label, option.value, option.description]) assert.ok((value?.length ?? 0) <= 100);
      }
    }
  }
}

test('maximum event, bingo, duel and milestone cards serialize within every Discord text and component budget', async () => {
  const f = milestoneFixture();
  try {
    const draft = event(f, { title: '_'.repeat(100), description: '_'.repeat(1000), capacity: 100,
      squads: Array.from({ length: 20 }, (_, n) => ({ id: `s${n}`, name: '_'.repeat(30), capacity: 5 })),
      settingsText: '_'.repeat(500) });
    const scheduled = f.db.community.events.publish('g', draft.id, draft.revision, 'event');
    const signups = Array.from({ length: 120 }, (_, n) => ({ discordId: String(100000000000000000n + BigInt(n)),
      squadId: `s${n % 20}`, state: n < 100 ? 'confirmed' : 'reserve', sequence: n, reminder: true }));
    for (const page of [1, 6]) assertDiscordLimits(renderEvent(scheduled, signups, page, f.now()));
    const objectives = Array.from({ length: 24 }, () => ({ kind: 'manual', target: 1, label: '_'.repeat(160) }));
    const bingo = f.db.community.bingo.createDraft('g', 'c', objectives, null, f.now());
    assertDiscordLimits(renderBingoBoard(bingo));
    const duel = f.db.community.duels.invite({ guildId: 'g', channelId: 'c', messageId: null },
      '100000000000000001', '100000000000000002', f.now());
    assertDiscordLimits(renderDuel(duel));
    assertDiscordLimits(renderDuel({ ...duel, status: 'resolved', challengerRoll: 6, opponentRoll: 6 }));
    const command = createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() });
    const i = { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'manager' },
      options: { getSubcommand: () => 'configure' }, async deferReply() {},
      async editReply(payload) { assertDiscordLimits(payload); return { id: 'private' }; } };
    await command.execute(i);
    const preset = { ...STARTER_PRESETS[0], name: '_'.repeat(80), instructions: '_'.repeat(1000),
      disabledUnits: [...SUPPORTED_UNITS] };
    assertDiscordLimits({ embeds: [wheelCard(preset, 'World')] });
    assertDiscordLimits(wheelPreview({ id: 'preview', data: { preset, expected: 0 } }));
  } finally { await f.close(); }
});

test('full availability, onboarding, event and wheel lists serialize their real private command payloads', async () => {
  const f = milestoneFixture();
  try {
    const windows = Array.from({ length: 14 }, (_, n) => ({ id: `window-${n}`, weekday: n % 7,
      startMinute: n < 7 ? 600 : 800, endMinute: n < 7 ? 630 : 80 }));
    f.db.community.availability.save({ guildId: 'g', discordId: 'u', timezone: 'America/Argentina/Buenos_Aires', windows }, 0, f.now());
    for (let n = 0; n < 100; n++) {
      const e = event(f, { title: '_'.repeat(100) });
      f.db.community.events.publish('g', e.id, e.revision, `event-${n}`);
    }
    for (let n = 0; n < 11; n++) {
      const id = String(100000000000000000n + BigInt(n));
      f.addMember(id);
      f.db.community.onboarding.enroll('g', id, 'MARS', f.now());
    }
    f.db.community.wheel.list('g');
    for (let n = 6; n < 50; n++) f.db.community.wheel.save({
      ...STARTER_PRESETS[0], id: `preset-${n}`, guildId: 'g', name: '_'.repeat(80) }, 0);
    const dependencies = { db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() };
    async function execute(command, sub, values = {}, user = 'manager') {
      let output;
      await command.execute({ guild: f.guild, guildId: 'g', channelId: 'c', user: { id: user },
        options: { getSubcommand: () => sub, getInteger: key => values[key] ?? null,
          getString: key => values[key] ?? null, getUser: key => values[key] ?? null },
        async deferReply() {}, async editReply(payload) {
          assertDiscordLimits(payload);
          output = JSON.parse(JSON.stringify(payload));
          return { id: 'private-list' };
        } });
      return output;
    }
    const available = await execute(createAvailabilityCommand(dependencies), 'view', { page: 2 }, 'u');
    assert.equal(available.components[0].components[0].options.length, 7);
    const queue = await execute(createOnboardingCommand(dependencies), 'queue');
    assert.equal(queue.embeds[0].fields.length, 10);
    const events = await execute(createEventCommand(dependencies), 'list', { page: 10 });
    assert.equal(events.embeds[0].description.match(/\/event view/g).length, 10);
    const wheel = await execute(createWheelCommand(dependencies), 'presets');
    assert.deepEqual(wheel.components.map(r => r.components[0].options.length), [25, 25]);
  } finally { await f.close(); }
});

test('milestone diagnostics return an indexed bounded page from large mixed-feature retained history', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    const insert = sql.prepare(`INSERT INTO community_deliveries
      (id,delivery_key,guild_id,channel_id,kind,subject_id,revision,due_at,part,status,next_attempt,updated_at)
      VALUES(?,?,?,'c',?,'subject',1,?,0,?,0,0)`);
    sql.exec('BEGIN');
    for (let n = 0; n < 12000; n++) {
      insert.run(`j${n}`, `key${n}`, n < 10000 ? 'g' : 'other', n % 2 ? 'milestone' : 'event_publish', Math.floor(n / 500),
        n % 101 === 1 ? ['paused', 'failed', 'needs_review'][n % 3] : 'sent');
    }
    sql.exec('COMMIT');
    const expected = new DeliveryStore(sql).list('g').filter(j => j.kind === 'milestone' &&
      ['paused', 'failed', 'needs_review'].includes(j.status));
    let query, parameters, returned = 0;
    const store = new DeliveryStore({ prepare(text) {
      query = text;
      const statement = sql.prepare(text);
      return { all(...args) { parameters = args; const rows = statement.all(...args); returned += rows.length; return rows; } };
    } });
    const page = store.diagnosticsPage('g', 'milestone', 1);
    assert.deepEqual(page.jobs.map(j => j.id), expected.slice(10, 20).map(j => j.id));
    assert.equal(page.hasNext, true);
    assert.equal(returned, 11);
    const plan = sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map(r => r.detail).join('\n');
    assert.match(plan, /SEARCH community_deliveries USING INDEX community_delivery_diagnostics/);
    assert.doesNotMatch(plan, /SCAN community_deliveries|TEMP B-TREE/);
    const last = store.diagnosticsPage('g', 'milestone', Math.floor(expected.length / 10));
    assert.equal(last.hasNext, false);
    assert.deepEqual(last.jobs.map(j => j.id), expected.slice(Math.floor(expected.length / 10) * 10).map(j => j.id));
    assert.deepEqual(store.diagnosticsPage('missing', 'milestone', 0), { jobs: [], hasNext: false });
  } finally { sql.close(); }
});

test('actual milestone configuration uses bounded diagnostics and preserves exact next/previous pages', async () => {
  const f = milestoneFixture();
  try {
    for (let n = 0; n < 21; n++) {
      const job = f.db.community.deliveries.enqueue({ key: `diagnostic-${n}`, guildId: 'g', channelId: 'c',
        kind: 'milestone', subjectId: 'player', revision: 0, dueAt: n, part: 0 });
      f.db.db.prepare("UPDATE community_deliveries SET status='paused' WHERE id=?").run(job.id);
    }
    f.db.community.deliveries.list = () => { throw Error('unbounded guild history read'); };
    const c = createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() });
    const i = { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'manager' },
      options: { getSubcommand: () => 'configure' }, async deferReply() {},
      async editReply(payload) { this.output = payload; return { id: 'private' }; } };
    await c.execute(i);
    const control = (payload, label) => payload.components.flatMap(r => r.toJSON().components).find(b => b.label === label);
    const selected = payload => payload.components.flatMap(r => r.toJSON().components).find(b => b.options)?.options.map(o => o.value);
    const first = selected(i.output);
    assert.equal(first.length, 10);
    async function click(label) {
      const b = control(i.output, label);
      await c.handleInteraction({ ...i, customId: b.custom_id, message: { id: 'private' },
        isButton: () => true, isChannelSelectMenu: () => false, isStringSelectMenu: () => false,
        isModalSubmit: () => false, async deferUpdate() {}, async editReply(payload) { i.output = payload; } });
    }
    await click('Next');
    assert.equal(selected(i.output).length, 10);
    assert.ok(selected(i.output).every(id => !first.includes(id)));
    await click('Next');
    assert.equal(selected(i.output).length, 1);
    assert.equal(control(i.output, 'Next').disabled, true);
    await click('Previous');
    await click('Previous');
    assert.deepEqual(selected(i.output), first);
    assert.equal(control(i.output, 'Previous').disabled, true);
  } finally { await f.close(); }
});
