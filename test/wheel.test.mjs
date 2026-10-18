import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags } from 'discord.js';
import { communityFixture } from './helpers/community.mjs';
const catalog = await import('../dist/community/wheelPresets.js').catch(() => ({}));
const wheel = await import('../dist/community/wheel.js').catch(() => ({}));
const commands = await import('../dist/commands/wheel.js').catch(() => ({}));
const { CommunitySessions } = await import('../dist/community/sessions.js');
const preset = (extra = {}) => ({ ...structuredClone(catalog.STARTER_PRESETS?.[0]), guildId: 'g', ...extra });

test('all six packages provide the approved complete hosting rules', () => {
  assert.equal(typeof catalog.validateWheelPreset, 'function');
  const expected = [
    ['Classic clan teams', ['World', 'Europe'], 'Team', 2, 'Medium', 100, []],
    ['Squad skirmish', ['Europe', 'Black Sea'], 'Team', 'Quads', 'Medium', 50, []],
    ['Naval night', ['Black Sea', 'Caribbean'], 'Team', 2, 'Medium', 100, []],
    ['Conventional warfare', ['World', 'Europe'], 'Team', 2, 'Medium', 100, ['Atom Bomb', 'Hydrogen Bomb', 'MIRV', 'MIRV Warhead']],
    ['Friendly free-for-all', ['Europe', 'World'], 'Free For All', null, 'Medium', 100, []],
    ['Humans versus nations', ['World', 'Europe'], 'Team', 'Humans Vs Nations', 'Hard', 0, []],
  ];
  assert.equal(catalog.STARTER_PRESETS.length, 6);
  for (const [n, p] of catalog.STARTER_PRESETS.entries()) {
    const validated = catalog.validateWheelPreset({ ...p, guildId: 'g' });
    assert.deepEqual([validated.name, p.maps, p.mode, p.teams, p.difficulty, p.bots, p.disabledUnits], expected[n]);
    assert.equal(p.nations, n === 1 ? 'disabled' : 'default');
    for (const field of ['donateGold', 'donateTroops', 'enabled']) assert.equal(p[field], true);
    for (const field of ['randomSpawn', 'infiniteGold', 'infiniteTroops', 'instantBuild']) assert.equal(p[field], false);
    assert.equal(p.mapSize, 'Normal');
  }
  assert.match(catalog.STARTER_PRESETS[2].instructions, /naval/i);
});

test('wheel selects a whole enabled package then one compatible map with exact RNG bounds', () => {
  assert.equal(typeof wheel.spinWheel, 'function');
  const calls = [], draws = [1, 0];
  const result = wheel.spinWheel(catalog.STARTER_PRESETS, (min, max) => {
    calls.push([min, max]);
    return draws.shift();
  });
  assert.deepEqual(calls, [[0, 6], [0, 2]]);
  assert.equal(result.preset.name, 'Squad skirmish');
  assert.equal(result.map, 'Europe');
  assert.equal(result.preset.teams, 'Quads');
  assert.equal(result.preset.bots, 50);
  assert.throws(() => wheel.spinWheel([preset({ enabled: false })]), /enabled|add/i);
  assert.throws(() => wheel.spinWheel(Array.from({ length: 51 }, () => preset())), /50/);
});

test('invalid or incompatible settings reject before saving', () => {
  assert.equal(typeof catalog.validateWheelPreset, 'function');
  const bad = [
    { maps: Array(11).fill('World') }, { maps: [] }, { maps: ['World', 'World'] },
    { maps: ['Unknown'] }, { disabledUnits: ['Laser'] }, { difficulty: 'Extreme' },
    { bots: -1 }, { bots: 401 }, { bots: 1.5 }, { nations: 0 }, { nations: 401 },
    { nations: 1.5 }, { mode: 'Free For All', teams: 2 }, { teams: null },
    { teams: 'Humans Vs Nations', nations: 'disabled' }, { teams: 0 },
    { mapSize: 'Tiny' }, { donateGold: 'yes' }, { instructions: 'x'.repeat(1001) },
    { name: '' }, { disabledUnits: ['MIRV', 'MIRV'] },
  ];
  for (const patch of bad) assert.throws(() => catalog.validateWheelPreset(preset(patch)), undefined, JSON.stringify(patch));
  assert.equal(catalog.validateWheelPreset(preset({ teams: 'Humans Vs Nations', bots: 0 })).bots, 0);
});

test('guild store seeds once, enforces limits/revisions and keeps deletions across store recreation', async () => {
  const f = communityFixture();
  try {
    const store = f.db.community.wheel;
    assert.ok(store, 'WheelStore is installed');
    const initial = store.list('g');
    assert.equal(initial.length, 6);
    assert.equal(store.list('other').length, 6);
    const changed = store.save({ ...initial[0], name: 'Changed' }, 1);
    assert.equal(changed.revision, 2);
    assert.throws(() => store.save(initial[0], 1), /changed|revision/i);
    assert.throws(() => store.remove('other', changed.id, 2), /changed|unavailable|revision/i);
    for (const p of store.list('g')) store.remove('g', p.id, p.revision);
    assert.deepEqual(store.list('g'), []);
    assert.equal(store.list('other').length, 6);
    for (let n = 0; n < 50; n++) store.save(preset({ id: `custom-${n}`, revision: 0 }), 0);
    assert.throws(() => store.save(preset({ id: 'overflow', revision: 0 }), 0), /50/);
    f.db.community.purgeGuild('g');
    assert.equal(store.list('g').length, 6);
  } finally { await f.close(); }
});

function interaction(f, sub, values = {}) {
  return {
    guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'u' },
    options: { getSubcommand: () => sub, getString: key => values[key] ?? null },
    async deferReply(payload) { this.deferred = payload; },
    async editReply(payload) { this.output = payload; return { id: 'private' }; },
    async reply(payload) { this.output = payload; return { id: 'private' }; },
    async followUp(payload) { this.followup = payload; return { id: 'followup' }; },
  };
}
function control(f, id, extra = {}) {
  return {
    ...interaction(f, ''), customId: id, message: { id: 'private' },
    isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false, isFromMessage: () => true,
    async update(payload) { this.output = payload; },
    async showModal(payload) { this.modal = payload; }, ...extra,
  };
}
const button = (payload, text) => payload.components.flatMap(row => row.components).find(item => item.data.label === text).data.custom_id;
function setup(f, extra = {}) {
  assert.equal(typeof commands.createWheelCommand, 'function');
  f.addMember('u', ['manager']);
  f.db.setManagerRole('g', 'manager');
  return commands.createWheelCommand({ db: f.db, now: f.now, sessions: new CommunitySessions(), ...extra });
}

test('member spins publicly with cooldown before RNG and officer-only private draft followup', async () => {
  const f = communityFixture();
  try {
    let draws = 0;
    const c = setup(f, { roll: min => { draws++; return min; } });
    const i = interaction(f, 'spin');
    await c.execute(i);
    assert.equal(i.deferred?.flags, undefined);
    assert.deepEqual(i.output.components, []);
    assert.match(JSON.stringify(i.output), /Classic clan teams|donations|Infinite gold|Manual/i);
    assert.equal(i.followup.flags, MessageFlags.Ephemeral);
    assert.equal(f.calls.memberFetches.length, 1);
    await assert.rejects(c.execute(interaction(f, 'spin')), /wait|seconds/i);
    assert.equal(draws, 2);
    f.advance(5000);
    f.setRoles('u', []);
    const member = interaction(f, 'spin');
    await c.execute(member);
    assert.equal(member.followup, undefined);
  } finally { await f.close(); }
});

test('private editor validates preview then explicitly saves all form settings', async () => {
  const f = communityFixture();
  try {
    const c = setup(f);
    const i = interaction(f, 'add');
    await c.execute(i);
    assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    const sections = [
      ['Edit basics', { name: 'Custom package', maps: 'Europe, Caribbean', mode: 'Free For All', teams: 'none', difficulty: 'Hard' }],
      ['Edit hosting', { bots: '0', nations: '12', mapSize: 'Compact', disabledUnits: 'Atom Bomb, MIRV', instructions: 'Keep all these instructions.' }],
      ['Edit options', { donateGold: 'no', donateTroops: 'yes', randomSpawn: 'yes', resources: 'both', instantBuild: 'yes' }],
    ];
    let menu = i.output;
    for (const [name, values] of sections) {
      const edit = control(f, button(menu, name));
      await c.handleInteraction(edit);
      assert.doesNotThrow(() => edit.modal.toJSON());
      assert.equal(edit.modal.components.length, 5);
      assert.ok(edit.modal.components.every(row => row.components.length === 1));
      const save = control(f, edit.modal.data.custom_id, {
        isButton: () => false, isModalSubmit: () => true,
        fields: { getTextInputValue: key => values[key] },
      });
      await c.handleInteraction(save);
      menu = save.output;
    }
    assert.equal(f.db.community.wheel.list('g').length, 6, 'preview never persists');
    await c.handleInteraction(control(f, button(menu, 'Save preset')));
    const saved = f.db.community.wheel.list('g').find(p => p.name === 'Custom package');
    assert.equal(saved.mode, 'Free For All');
    assert.equal(saved.teams, null);
    assert.equal(saved.nations, 12);
    assert.equal(saved.mapSize, 'Compact');
    assert.deepEqual(saved.disabledUnits, ['Atom Bomb', 'MIRV']);
    assert.equal(saved.instructions, 'Keep all these instructions.');
    assert.equal(saved.donateGold, false);
    for (const field of ['randomSpawn', 'infiniteGold', 'infiniteTroops', 'instantBuild']) assert.equal(saved[field], true);
  } finally { await f.close(); }
});

test('persisted initialization survives store recreation and guild reads use the composite index', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const sql = new DatabaseSync(':memory:');
  try {
    wheel.WheelStore.initialize(sql);
    let store = new wheel.WheelStore(sql);
    for (const p of store.list('g')) store.remove('g', p.id, p.revision);
    store = new wheel.WheelStore(sql);
    assert.deepEqual(store.list('g'), []);
    const plan = sql.prepare('EXPLAIN QUERY PLAN SELECT payload FROM community_wheel_presets WHERE guild_id=? ORDER BY rowid LIMIT 50').all('g');
    assert.match(plan.map(row => row.detail).join('\n'), /SEARCH community_wheel_presets USING INDEX.*guild_id=/);
    assert.doesNotMatch(plan.map(row => row.detail).join('\n'), /SCAN community_wheel_presets/);
  } finally { sql.close(); }
});

test('editor rejects forged bindings, revoked officer, expired sessions and stale presets', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), p = f.db.community.wheel.list('g')[0];
    const i = interaction(f, 'edit', { id: p.id });
    await c.execute(i);
    const id = button(i.output, 'Save preset');
    for (const forged of [{ user: { id: 'other' } }, { guildId: 'other' }, { channelId: 'other' }, { message: { id: 'other' } }]) {
      await assert.rejects(c.handleInteraction(control(f, id, forged)), /reopen/i);
    }
    f.setRoles('u', []);
    await assert.rejects(c.handleInteraction(control(f, id)), /officer|manager/i);
    f.setRoles('u', ['manager']);
    f.db.community.wheel.save({ ...p, name: 'Changed' }, 1);
    await assert.rejects(c.handleInteraction(control(f, id)), /changed|reopen/i);
    f.advance(600001);
    await assert.rejects(c.handleInteraction(control(f, id)), /expired|reopen/i);
    assert.equal(await c.handleInteraction({ customId: 'legacy:anything' }), false);
  } finally { await f.close(); }
});

test('spin draft copies complete settings and instructions independently of later preset edits', async () => {
  const f = communityFixture();
  try {
    const { createEventCommand } = await import('../dist/commands/event.js');
    const event = createEventCommand({ db: f.db, now: f.now, sessions: new CommunitySessions() });
    const c = setup(f, { roll: min => min, createDraft: event.createDraft });
    const p = f.db.community.wheel.list('g')[0];
    f.db.community.wheel.save({ ...p, disabledUnits: [...catalog.SUPPORTED_UNITS], instructions: 'x'.repeat(1000) }, 1);
    const i = interaction(f, 'spin');
    await c.execute(i);
    const id = button(i.followup, 'Create event draft');
    f.db.community.wheel.save({ ...f.db.community.wheel.list('g')[0], instructions: 'Changed later', bots: 3 }, 2);
    f.setRoles('u', []);
    await assert.rejects(c.handleInteraction(control(f, id, { message: { id: 'followup' } })), /officer|manager/i);
    f.setRoles('u', ['manager']);
    await c.handleInteraction(control(f, id, { message: { id: 'followup' } }));
    const draft = f.db.community.events.list('g')[0];
    assert.equal(draft.status, 'draft');
    assert.equal(draft.description, 'x'.repeat(1000));
    assert.ok(draft.settingsText.length <= 500);
    assert.match(draft.settingsText, /World|100 bots|MIRV Warhead|Factory|Instant build|Infinite troops/);
    assert.doesNotMatch(draft.settingsText, /3 bots/);
    assert.deepEqual(f.db.community.events.signups('g', draft.id), []);
    assert.equal(f.calls.sends.length, 0);
  } finally { await f.close(); }
});

test('wheel is registered and community routing reaches its prefix without touching unrelated types', async () => {
  const { commandsByName } = await import('../dist/commands/index.js');
  assert.equal(commandsByName.has('wheel'), true);
  const { handleCommunityInteraction } = await import('../dist/community/interactions.js');
  await assert.rejects(handleCommunityInteraction({ customId: 'wheel:missing:save', isButton: () => true,
    guild: { id: 'g' }, guildId: 'g', channelId: 'c', user: { id: 'u' }, message: { id: 'missing' } }), /reopen/i);
});

test('draft rejects a session revoked or expired during fresh membership lookup without repeated fetches', async () => {
  for (const revoke of ['expired', 'removed']) {
    const f = communityFixture();
    try {
      const { createEventCommand } = await import('../dist/commands/event.js');
      const sessions = new CommunitySessions();
      const event = createEventCommand({ db: f.db, now: f.now, sessions });
      const c = setup(f, { sessions, roll: min => min, createDraft: event.createDraft });
      const i = interaction(f, 'spin');
      await c.execute(i);
      const id = button(i.followup, 'Create event draft');
      const fetch = f.guild.members.fetch;
      f.guild.members.fetch = async options => {
        const member = await fetch(options);
        if (revoke === 'expired') f.advance(600001);
        else sessions.purgeMember('g', 'u');
        return member;
      };
      const before = f.calls.memberFetches.length;
      await assert.rejects(c.handleInteraction(control(f, id, { message: { id: 'followup' } })), /reopen|expired/i);
      assert.equal(f.calls.memberFetches.length - before, 1);
      assert.deepEqual(f.db.community.events.list('g'), []);
    } finally { await f.close(); }
  }
});

test('editor rejects malformed settings before save and invalidates a session removed during authorization', async () => {
  const f = communityFixture();
  try {
    const sessions = new CommunitySessions(), c = setup(f, { sessions });
    const p = f.db.community.wheel.list('g')[0];
    const i = interaction(f, 'edit', { id: p.id });
    await c.execute(i);
    const edit = control(f, button(i.output, 'Edit basics'));
    await c.handleInteraction(edit);
    await assert.rejects(c.handleInteraction(control(f, edit.modal.data.custom_id, {
      isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: key => ({ name: 'Bad', maps: 'World', mode: 'Free For All', teams: '2', difficulty: 'Medium' })[key] },
    })), /Free For All|teams/i);
    assert.deepEqual(f.db.community.wheel.list('g')[0], p);
    const fetch = f.guild.members.fetch;
    f.guild.members.fetch = async options => { const member = await fetch(options); sessions.purgeGuild('g'); return member; };
    await assert.rejects(c.handleInteraction(control(f, button(i.output, 'Save preset'))), /reopen/i);
    assert.deepEqual(f.db.community.wheel.list('g')[0], p);
  } finally { await f.close(); }
});

test('officer picker handles fifty presets within Discord limits and confirms removals without reseeding', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), store = f.db.community.wheel;
    for (const p of store.list('g')) store.remove('g', p.id, p.revision);
    for (let n = 0; n < 50; n++) store.save(preset({ id: `p-${n}`, name: `Package ${n}`, revision: 0 }), 0);
    const i = interaction(f, 'remove');
    await c.execute(i);
    assert.equal(i.output.components.length, 2);
    for (const row of i.output.components) {
      assert.equal(row.toJSON().components[0].options.length, 25);
    }
    const id = i.output.components[1].components[0].data.custom_id;
    const selected = control(f, id, { isButton: () => false, isStringSelectMenu: () => true, values: ['p-49'] });
    await c.handleInteraction(selected);
    assert.equal(store.list('g').length, 50);
    await c.handleInteraction(control(f, button(selected.output, 'Remove preset')));
    assert.equal(store.list('g').length, 49);
    for (const p of store.list('g')) store.remove('g', p.id, p.revision);
    await assert.rejects(c.execute(interaction(f, 'spin')), /No enabled presets|add/i);
  } finally { await f.close(); }
});

test('simultaneous draft clicks consume the copied package once before opening event management', async () => {
  const f = communityFixture();
  try {
    const { createEventCommand } = await import('../dist/commands/event.js');
    const event = createEventCommand({ db: f.db, now: f.now, sessions: new CommunitySessions() });
    const c = setup(f, { roll: min => min, createDraft: event.createDraft });
    const i = interaction(f, 'spin');
    await c.execute(i);
    const id = button(i.followup, 'Create event draft');
    const results = await Promise.allSettled([1, 2].map(() => c.handleInteraction(control(f, id, { message: { id: 'followup' } }))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.db.community.events.list('g').length, 1);
  } finally { await f.close(); }
});
