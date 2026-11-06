import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandInteractionOptionResolver, MessageFlags } from 'discord.js';
import { communityFixture } from './helpers/community.mjs';
import { createAvailabilityCommand } from '../dist/commands/availability.js';
import { createBingoCommand } from '../dist/commands/bingo.js';
import { createEventCommand } from '../dist/commands/event.js';
import { createOnboardingCommand } from '../dist/commands/onboarding.js';
import { createWheelCommand } from '../dist/commands/wheel.js';
import { createMilestonesCommand } from '../dist/commands/milestones.js';
import { createLobbyCommand } from '../dist/commands/lobby.js';
import { CommandError } from '../dist/commandError.js';

const actions = {
  bingo: ['view', 'create', 'claim', 'review', 'reset'],
  availability: ['set', 'view', 'clear', 'suggest'],
  event: ['create', 'list', 'view', 'edit', 'cancel'],
  onboarding: ['status', 'queue'],
  wheel: ['spin', 'presets', 'add', 'edit', 'remove'],
  milestones: ['view', 'configure'],
  lobby: ['watch', 'list', 'remove', 'resume', 'stop', 'configure'],
};
function commands(f) {
  const deps = { db: f.db, api: f.api, now: f.now };
  return { bingo: createBingoCommand(deps), availability: createAvailabilityCommand(deps),
    event: createEventCommand(deps), onboarding: createOnboardingCommand(deps),
    wheel: createWheelCommand(deps), milestones: createMilestonesCommand(deps),
    lobby: createLobbyCommand(f.db, { now: f.now, feed: { status: 'Connected' } }) };
}
const integers = new Set(['cell', 'page', 'day', 'duration', 'capacity', 'reminder', 'min_players', 'max_players']);
function interaction(f, action, values = {}, { legacy = false, fallback = null } = {}) {
  const supplied = Object.entries(values).map(([name, value]) => ({ name, value,
    type: integers.has(name) ? 4 : name === 'enabled' ? 5 : name === 'user' ? 6 : 3,
    ...(name === 'user' ? { user: { id: value } } : {}) }));
  const data = legacy ? [{ name: action, type: 1, options: supplied }]
    : [...(action === null ? [] : [{ name: 'action', type: 3, value: action }]), ...supplied];
  const options = new CommandInteractionOptionResolver(f.client, data, {});
  if (fallback) options.getSubcommand = () => fallback;
  return { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'u' }, options, replies: [],
    async reply(p) { this.replies.push(p); return { id: 'private' }; },
    async deferReply(p) { this.replies.push(p); },
    async editReply(p) { this.output = p; return { id: 'private' }; },
    async followUp(p) { this.replies.push(p); return { id: 'private' }; } };
}

test('seven serialized command schemas require a first action choice and expose only optional union inputs', async () => {
  const f = communityFixture();
  try {
    const all = commands(f);
    for (const [name, expected] of Object.entries(actions)) {
      const data = all[name].data.toJSON();
      assert.deepEqual(data.contexts, [0], name);
      const [action, ...inputs] = data.options;
      assert.equal(action.name, 'action', name);
      assert.equal(action.type, 3, name);
      assert.equal(action.required, true, name);
      assert.deepEqual(action.choices.map(c => c.value), expected, name);
      assert.ok(inputs.every(o => o.type > 2 && !o.required), name);
      assert.equal(new Set(inputs.map(o => o.name)).size, inputs.length, name);
    }
    const schema = name => all[name].data.toJSON().options;
    assert.equal(schema('availability').find(o => o.name === 'day').choices[0].value, 0);
    assert.equal(schema('lobby').find(o => o.name === 'map').autocomplete, true);
    assert.equal(schema('lobby').find(o => o.name === 'min_players').min_value, 0);
    assert.equal(schema('event').find(o => o.name === 'capacity').max_value, 100);
    assert.equal(schema('bingo').find(o => o.name === 'explanation').max_length, 1000);
  } finally { await f.close(); }
});

test('missing and unknown actions fail before database reads, replies, permissions or cooldowns', async () => {
  const f = communityFixture();
  try {
    const all = commands(f), prepare = f.db.db.prepare;
    let reads = 0;
    f.db.db.prepare = function (...args) { reads++; return prepare.apply(this, args); };
    for (const [name, command] of Object.entries(all)) for (const action of [null, 'unknown', 'toString', 'constructor']) {
      const i = interaction(f, action);
      await assert.rejects(command.execute(i), e => e instanceof CommandError && /action/i.test(e.message), `${name}: ${action}`);
      assert.equal(reads, 0, name);
      assert.equal(i.replies.length, 0, name);
      assert.equal(f.calls.memberFetches.length, 0, name);
    }
  } finally { await f.close(); }
});

test('flat commands reject irrelevant inputs before reads and mutations, including false and zero', async () => {
  const f = communityFixture();
  try {
    const all = commands(f), prepare = f.db.db.prepare;
    let reads = 0;
    f.db.db.prepare = function (...args) { reads++; return prepare.apply(this, args); };
    for (const [name, action, values] of [
      ['bingo', 'create', { cell: 1 }], ['availability', 'clear', { day: 0 }],
      ['event', 'list', { title: 'Ignored title' }], ['onboarding', 'queue', { clan: 'MARS' }],
      ['wheel', 'spin', { id: 'preset' }], ['milestones', 'view', { page: 1 }],
      ['lobby', 'list', { enabled: false }],
    ]) {
      const i = interaction(f, action, values);
      await assert.rejects(all[name].execute(i), /not.*(?:accept|valid)|only.*(?:action|with)|irrelevant/i, name);
      assert.equal(reads, 0, name);
      assert.equal(i.replies.length, 0, name);
    }
  } finally { await f.close(); }
});

test('flat action-specific required inputs fail before database work', async () => {
  const f = communityFixture();
  try {
    const all = commands(f), prepare = f.db.db.prepare;
    let reads = 0;
    f.db.db.prepare = function (...args) { reads++; return prepare.apply(this, args); };
    for (const [name, action, values, missing] of [
      ['bingo', 'claim', { explanation: 'Win' }, 'cell'], ['bingo', 'claim', { cell: 14 }, 'explanation'],
      ['availability', 'set', { start: '18:00', end: '20:00' }, 'day'],
      ['availability', 'set', { day: 0, end: '20:00' }, 'start'],
      ['availability', 'set', { day: 0, start: '18:00' }, 'end'],
      ['event', 'create', { start: '2026-10-19 12:00', timezone: 'UTC' }, 'title'],
      ['event', 'create', { title: 'Night', timezone: 'UTC' }, 'start'],
      ['event', 'create', { title: 'Night', start: '2026-10-19 12:00' }, 'timezone'],
      ...['view', 'edit', 'cancel'].map(action => ['event', action, {}, 'id']),
      ['lobby', 'watch', { min_players: 0 }, 'name'], ['lobby', 'remove', {}, 'id'],
      ['lobby', 'watch', { name: 'Everything' }, 'filter'],
    ]) {
      await assert.rejects(all[name].execute(interaction(f, action, values)), e => e instanceof CommandError && e.message.includes(missing), `${name}: ${action} ${missing}`);
      assert.equal(reads, 0, name);
    }
  } finally { await f.close(); }
});

test('flat availability set accepts Monday zero, preserves first-save timezone and prefers action over fallback', async () => {
  const f = communityFixture();
  try {
    const command = commands(f).availability;
    const values = { day: 0, start: '18:00', end: '20:00' };
    await assert.rejects(command.execute(interaction(f, 'set', values)), /timezone/i);
    const i = interaction(f, 'set', { ...values, timezone: 'UTC' }, { fallback: 'clear' });
    await command.execute(i);
    assert.equal(f.db.community.availability.get('g', 'u').windows[0].weekday, 0);
    assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
    await command.execute(interaction(f, 'set', { day: 1, start: '18:00', end: '20:00' }));
    assert.equal(f.db.community.availability.get('g', 'u').windows.length, 2);
    await command.execute(interaction(f, 'clear'));
    assert.equal(f.db.community.availability.get('g', 'u'), null);
  } finally { await f.close(); }
});

test('flat lobby filters accept zero and disabling with false still requires manager authorization', async () => {
  const f = communityFixture();
  try {
    f.addMember('u');
    const command = commands(f).lobby, store = f.db.community.lobbies;
    store.configure('g', true, 'c', f.now());
    await command.execute(interaction(f, 'watch', { name: 'Empty', min_players: 0, max_players: 0 }));
    assert.equal(store.rules('g', 'u')[0].min, 0);
    await assert.rejects(command.execute(interaction(f, 'configure', { enabled: false })), /Manage Server|config role/i);
    assert.equal(store.settings('g').enabled, true);
    f.db.setManagerRole('g', 'manager'); f.setRoles('u', ['manager']);
    await command.execute(interaction(f, 'configure', { enabled: false }));
    assert.equal(store.settings('g').enabled, false);
  } finally { await f.close(); }
});

test('flat event create preserves private drafts, officer access and DST validation', async () => {
  const f = communityFixture();
  try {
    f.addMember('u');
    const command = commands(f).event;
    const values = { title: 'Team night', start: '2026-11-01 01:30', timezone: 'America/New_York' };
    await assert.rejects(command.execute(interaction(f, 'create', values)), /officer|manager/i);
    f.db.setManagerRole('g', 'manager'); f.setRoles('u', ['manager']);
    await assert.rejects(command.execute(interaction(f, 'create', values)), /repeats|offset/i);
    assert.deepEqual(f.db.community.events.list('g'), []);
    const i = interaction(f, 'create', { ...values, offset: '-04:00', reminder: 0 });
    await command.execute(i);
    const event = f.db.community.events.list('g')[0];
    assert.equal(event.startAt, Date.UTC(2026, 10, 1, 5, 30));
    assert.equal(event.status, 'draft');
    assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(f.calls.sends.length, 0);
  } finally { await f.close(); }
});

test('legacy nested options normalize without counting their subcommand as an irrelevant input', async () => {
  const f = communityFixture();
  try {
    const all = commands(f);
    await all.availability.execute(interaction(f, 'set', { day: 0, start: '18:00', end: '20:00', timezone: 'UTC' }, { legacy: true }));
    assert.equal(f.db.community.availability.get('g', 'u').windows[0].weekday, 0);
    f.db.community.lobbies.configure('g', true, 'c', f.now());
    await all.lobby.execute(interaction(f, 'watch', { name: 'Empty', min_players: 0 }, { legacy: true }));
    assert.equal(f.db.community.lobbies.rules('g', 'u')[0].min, 0);
    const i = interaction(f, 'list', {}, { legacy: true });
    await all.event.execute(i);
    assert.match(JSON.stringify(i.output), /No published events/);
  } finally { await f.close(); }
});
