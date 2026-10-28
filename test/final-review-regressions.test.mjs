import assert from 'node:assert/strict';
import test from 'node:test';
import { communityFixture } from './helpers/community.mjs';
import { milestoneFixture, profile } from './helpers/milestones.mjs';
import { createEventCommand } from '../dist/commands/event.js';
import { createAvailabilityCommand } from '../dist/commands/availability.js';
import { createMilestonesCommand } from '../dist/commands/milestones.js';
import { CommunitySessions } from '../dist/community/sessions.js';
import { CommandLimits } from '../dist/queues.js';

const draft = f => ({ guildId: 'g', channelId: 'c', creatorId: 'u', title: 'Visible event',
  description: '', startAt: f.now() + 3600000, durationMinutes: 60, capacity: 2,
  squads: [{ id: 'a', name: 'A', capacity: 1 }, { id: 'b', name: 'B', capacity: 1 }], reminderMinutes: 0 });
function interaction(f, extra = {}) {
  return { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'u' }, message: { id: 'private' },
    isButton: () => true, isStringSelectMenu: () => false, isModalSubmit: () => false,
    async deferReply() {}, async deferUpdate() {}, async reply(p) { this.output = p; },
    async update(p) { this.output = p; }, async editReply(p) { this.output = p; return { id: 'private' }; },
    ...extra };
}
function saved(sessions, f, kind, data) {
  return sessions.create({ kind, ownerId: 'u', guildId: 'g', channelId: 'c', messageId: 'private', data }, f.now());
}
const snapshot = f => f.db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name")
  .all().map(({ name }) => [name, f.db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
function officer(f) { f.addMember('u', ['manager']); f.db.setManagerRole('g', 'manager'); }
function pendingLookup(f, after, match) {
  const fetch = f.guild.members.fetch;
  let release, reached;
  const pending = new Promise(resolve => { reached = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  f.guild.members.fetch = async options => {
    if (match(options)) { reached(); await resume; after(); }
    return fetch(options);
  };
  return { pending, release };
}

for (const revoke of ['role', 'mapping']) {
  test(`event move rejects officer ${revoke} revoked during the final roster lookup`, async () => {
    const f = communityFixture();
    try {
      officer(f); f.addMember('target'); f.addMember('reserve');
      const sessions = new CommunitySessions(), store = f.db.community.events;
      const e = store.createDraft(draft(f), f.now()); store.publish('g', e.id, 1, 'public');
      store.join('g', e.id, 'target', 'a', f.now()); store.join('g', e.id, 'reserve', 'a', f.now());
      const s = saved(sessions, f, 'event-move', { eventId: e.id, revision: 1 });
      const command = createEventCommand({ db: f.db, now: f.now, sessions });
      const gate = pendingLookup(f, () => revoke === 'role' ? f.setRoles('u', []) :
        f.db.setManagerRole('g', 'replacement', f.db.getGuildSettings('g').revision), o => !('user' in o));
      const i = interaction(f, { customId: `evtmenu:${s.id}:save`, isButton: () => false, isModalSubmit: () => true,
        fields: { getTextInputValue: k => k === 'member' ? 'target' : 'b' } });
      const action = command.handleInteraction(i);
      await gate.pending;
      const before = snapshot(f); gate.release();
      await assert.rejects(action, /officer|manager/i);
      assert.deepEqual(snapshot(f), before);
      assert.equal(i.output, undefined);
    } finally { await f.close(); }
  });
}

for (const kind of ['event-manage', 'event-move', 'event-squad']) {
  for (const invalidation of ['revoke', 'expire', 'valid']) {
    test(`${kind} ${invalidation === 'valid' ? 'accepts a valid control' : `rejects ${invalidation} without data or jobs changing`} after authorization`, async () => {
      const f = communityFixture();
      try {
        officer(f); f.addMember('target');
        const sessions = new CommunitySessions(), store = f.db.community.events;
        let e = store.createDraft(draft(f), f.now());
        if (kind !== 'event-manage') {
          e = store.publish('g', e.id, 1, 'public');
          store.join('g', e.id, kind === 'event-squad' ? 'u' : 'target', 'a', f.now());
        }
        const s = saved(sessions, f, kind, { eventId: e.id, revision: 1, publicMessageId: e.messageId });
        const command = createEventCommand({ db: f.db, now: f.now, sessions });
        const gate = pendingLookup(f, () => {
          if (invalidation === 'revoke') sessions.delete(s.id);
          if (invalidation === 'expire') f.advance(600000);
        },
          o => kind === 'event-manage' ? 'user' in o : !('user' in o));
        const i = interaction(f, { customId: `evtmenu:${s.id}:${kind === 'event-manage' ? 'publish' : kind === 'event-squad' ? 'select' : 'save'}`,
          isButton: () => kind === 'event-manage', isModalSubmit: () => kind === 'event-move',
          isStringSelectMenu: () => kind === 'event-squad', values: ['b'],
          fields: { getTextInputValue: k => k === 'member' ? 'target' : 'b' } });
        const action = command.handleInteraction(i);
        await gate.pending; const before = snapshot(f); gate.release();
        if (invalidation === 'valid') {
          assert.equal(await action, true);
          if (kind === 'event-manage') assert.equal(f.db.community.deliveries.list('g').length, 1);
          else assert.equal(store.signup('g', e.id, kind === 'event-squad' ? 'u' : 'target').squadId, 'b');
          assert.ok(i.output);
        } else {
          await assert.rejects(action, /expired|unavailable|reopen/i);
          assert.deepEqual(snapshot(f), before);
          assert.equal(i.output, undefined);
        }
      } finally { await f.close(); }
    });
  }
}

for (const invalidation of ['revoke', 'expire', 'valid']) {
  test(`availability draft source is ${invalidation} after shared opener authorization`, async () => {
    const f = communityFixture();
    try {
      officer(f);
      const sessions = new CommunitySessions(), event = createEventCommand({ db: f.db, now: f.now, sessions });
      const command = createAvailabilityCommand({ db: f.db, now: f.now, sessions, createDraft: event.createDraft });
      const s = saved(sessions, f, 'availability-suggest', [draft(f)]);
      const gate = pendingLookup(f, () => {
        if (invalidation === 'revoke') sessions.delete(s.id);
        if (invalidation === 'expire') f.advance(600000);
      }, () => true);
      const i = interaction(f, { customId: `availability:${s.id}:draft0` });
      const action = command.handleInteraction(i);
      await gate.pending; const before = snapshot(f); gate.release();
      if (invalidation === 'valid') {
        assert.equal(await action, true);
        assert.equal(f.db.community.events.list('g').length, 1);
        assert.deepEqual(f.db.community.deliveries.list('g'), []);
      } else {
        await assert.rejects(action, /expired|unavailable|reopen/i);
        assert.deepEqual(snapshot(f), before);
        assert.equal(i.output, undefined);
      }
    } finally { await f.close(); }
  });
}

test('public event list filters drafts before its 100 record cap', async () => {
  const f = communityFixture();
  try {
    const store = f.db.community.events, e = store.createDraft(draft(f), f.now());
    store.publish('g', e.id, 1, 'public');
    for (let n = 0; n < 105; n++) store.createDraft({ ...draft(f), title: 'Hidden draft', startAt: f.now() + 7200000 + n }, f.now());
    const command = createEventCommand({ db: f.db, now: f.now });
    const i = interaction(f, { options: { getSubcommand: () => 'list', getInteger: () => null } });
    const before = snapshot(f);
    await command.execute(i);
    assert.match(JSON.stringify(i.output), /Visible event/);
    assert.doesNotMatch(JSON.stringify(i.output), /Hidden draft/);
    assert.deepEqual(snapshot(f), before);
  } finally { await f.close(); }
});

test('bounded command limits refuse new keys at capacity without evicting active cooldowns', () => {
  const limits = new CommandLimits(2);
  assert.equal(limits.take('a', 10000, 1000), true);
  assert.equal(limits.take('b', 10000, 1000), true);
  assert.equal(limits.take('c', 10000, 1000), false);
  assert.equal(limits.take('a', 10000, 1000), false);
  assert.equal(limits.take('c', 10000, 11000), true);
});

test('multi-key command limits reserve all keys together or leave them unchanged', () => {
  const limits = new CommandLimits(3);
  assert.equal(limits.take('account:busy', 10000, 1000), true);
  assert.equal(limits.takeAll(['member:other', 'account:busy'], 10000, 1001), false);
  assert.equal(limits.take('member:other', 10000, 1001), true);
  assert.equal(limits.takeAll(['member:new', 'account:new'], 10000, 1001), false);
  assert.equal(limits.take('member:new', 10000, 1001), true);
  assert.equal(limits.takeAll(['member:fresh', 'account:fresh'], 10000, 11001), true);
  assert.equal(limits.take('member:fresh', 10000, 11001), false);
});

function cooldownIterations(limits) {
  const entries = limits.until, iterate = entries[Symbol.iterator];
  const counts = { scans: 0, entries: 0 };
  entries[Symbol.iterator] = function* () {
    counts.scans++;
    for (const entry of iterate.call(this)) { counts.entries++; yield entry; }
  };
  return counts;
}

test('command limits avoid scanning unexpired cooldowns for admissions and rejections', () => {
  const limits = new CommandLimits(1001), counts = cooldownIterations(limits);
  for (let n = 0; n < 1000; n++) assert.equal(limits.take(`member:${n}`, 10000, 1000), true);
  for (let n = 0; n < 1000; n++) assert.equal(limits.takeAll(['unreserved', `member:${n}`], 10000, 1001), false);
  assert.equal(limits.takeAll(['unreserved', 'unreserved'], 10000, 1001), true);
  assert.equal(limits.take('at-capacity', 10000, 1001), false);
  assert.deepEqual(counts, { scans: 0, entries: 0 });
});

test('command limits sweep mixed expirations at their exact boundaries before rejecting', () => {
  const limits = new CommandLimits(2);
  assert.equal(limits.take('long', 10000, 1000), true);
  assert.equal(limits.take('short', 1000, 1000), true);
  const counts = cooldownIterations(limits);
  assert.equal(limits.take('replacement', 3000, 1999), false);
  assert.equal(limits.take('long', 10000, 2000), false);
  assert.deepEqual(counts, { scans: 1, entries: 2 });
  assert.equal(limits.takeAll(['replacement', 'extra'], 3000, 2000), false);
  assert.equal(limits.take('replacement', 3000, 2000), true);
  assert.equal(limits.take('long', 10000, 2001), false);
  assert.deepEqual(counts, { scans: 1, entries: 2 });
  assert.equal(limits.take('next', 1000, 5000), true);
  assert.deepEqual(counts, { scans: 2, entries: 4 });
  assert.equal(limits.take('long', 10000, 5000), false);
});

for (const duration of [0, -10]) {
  test(`command limits retain immediate expiry semantics for duration ${duration}`, () => {
    const limits = new CommandLimits(1);
    assert.equal(limits.take('old', duration, 1000), true);
    assert.equal(limits.take('replacement', 1000, 1000), true);
    assert.equal(limits.take('replacement', 1000, 1000), false);
    assert.equal(limits.take('next', 1000, 2000), true);
  });
}

test('command limits preserve expiry cleanup across backward and forward clock changes', () => {
  const limits = new CommandLimits(2);
  assert.equal(limits.take('long', 10000, 1000), true);
  assert.equal(limits.take('short', 1000, 1000), true);
  assert.equal(limits.take('long', 10000, 2000), false);
  assert.equal(limits.take('short', 100, 1500), true, 'a rejection must not leave an expired key to revive after rollback');
  assert.equal(limits.take('short', 100, 1550), false);
  assert.equal(limits.take('short', 1, 1600), true, 'a new earlier expiry after rollback must trigger cleanup');
  assert.equal(limits.take('new', 5000, 500), false);
  assert.equal(limits.take('new', 5000, 1601), true);
  assert.equal(limits.take('long', 10000, 11000), true);
});

test('milestone opens and different valid menus share foreground cooldown and in-flight work', async () => {
  const f = milestoneFixture();
  try {
    const command = createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() });
    const open = () => interaction(f, { options: { getSubcommand: () => 'view' } });
    const refresh = i => interaction(f, { customId: i.output.components[0].components[2].data.custom_id });
    const first = open(); await command.execute(first);
    const before = snapshot(f);
    const second = open(); await command.execute(second);
    const extra = open(); await command.execute(extra);
    await command.handleInteraction(refresh(first)); await command.handleInteraction(refresh(second));
    await command.handleInteraction(refresh(extra));
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.calls.memberFetches.length, 2);
    assert.deepEqual(snapshot(f), before);
    assert.match(JSON.stringify(second.output), /saved earned milestones/);
    f.advance(10000);
    let release, started;
    const pending = new Promise(resolve => { started = resolve; });
    const resume = new Promise(resolve => { release = resolve; });
    f.api.getPlayerProfile = async (id, options) => {
      f.calls.requests.push([id, options]); started(); await resume; return profile('10', '1');
    };
    const action = command.handleInteraction(refresh(first)); await pending;
    f.advance(10000); // Expiring the cooldown cannot admit overlapping reads.
    const during = snapshot(f);
    const third = open(); await command.execute(third);
    await command.handleInteraction(refresh(second));
    assert.equal(f.calls.requests.length, 2);
    assert.equal(f.calls.memberFetches.length, 3);
    assert.deepEqual(snapshot(f), during);
    release(); await action;
    assert.equal(f.calls.memberFetches.length, 4);
    assert.ok(f.calls.requests.every(([, options]) => options.fresh === true));
    f.api.getPlayerProfile = async () => profile('11', '1');
    f.advance(10000);
    await command.handleInteraction(refresh(third));
    assert.equal(f.calls.memberFetches.length, 6);
    assert.equal(f.db.community.milestones.getState('g', 'player').counters.games, 11n);
  } finally { await f.close(); }
});

test('milestone foreground gate follows both members and accounts across guild menus', async () => {
  const f = milestoneFixture();
  try {
    const command = createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() });
    const open = extra => interaction(f, { options: { getSubcommand: () => 'view' }, ...extra });
    await command.execute(open());
    f.addMember('v');
    f.db.linkGuildUser('h', 'admin', 'v', 'player', null);
    const before = snapshot(f);
    const sharedAccount = open({ guildId: 'h', guild: { ...f.guild, id: 'h' }, user: { id: 'v' } });
    await command.execute(sharedAccount);
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.calls.memberFetches.length, 2);
    assert.deepEqual(snapshot(f), before);
    f.db.linkGuildUser('g', 'admin', 'u', 'replacement', null);
    const replaced = snapshot(f);
    await command.execute(open());
    assert.equal(f.calls.requests.length, 1);
    assert.deepEqual(snapshot(f), replaced);
  } finally { await f.close(); }
});

test('a blocked shared-account refresh does not consume another member cooldown', async () => {
  const f = milestoneFixture();
  try {
    const command = createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions: new CommunitySessions() });
    const open = extra => interaction(f, { options: { getSubcommand: () => 'view' }, ...extra });
    await command.execute(open());
    f.addMember('v');
    f.db.linkGuildUser('h', 'admin', 'v', 'player', null);
    const other = { guildId: 'h', guild: { ...f.guild, id: 'h' }, user: { id: 'v' } };
    await command.execute(open(other));
    assert.equal(f.calls.requests.length, 1);
    f.db.linkGuildUser('h', 'admin', 'v', 'replacement', null);
    await command.execute(open(other));
    assert.equal(f.calls.requests.length, 2);
    assert.equal(f.calls.requests[1][0], 'replacement');
  } finally { await f.close(); }
});

test('a suppressed milestone refresh still rejects source revocation during acknowledgment', async () => {
  const f = milestoneFixture();
  try {
    const sessions = new CommunitySessions();
    const command = createMilestonesCommand({ db: f.db, api: f.api, now: f.now, sessions });
    const open = interaction(f, { options: { getSubcommand: () => 'view' } });
    await command.execute(open);
    const id = open.output.components[0].components[2].data.custom_id;
    const i = interaction(f, { customId: id, async deferUpdate() { sessions.delete(id.split(':')[1]); } });
    const before = snapshot(f);
    await assert.rejects(command.handleInteraction(i), /unavailable|expired|reopen/i);
    assert.deepEqual(snapshot(f), before);
    assert.equal(i.output, undefined);
    assert.equal(f.calls.requests.length, 1);
  } finally { await f.close(); }
});
