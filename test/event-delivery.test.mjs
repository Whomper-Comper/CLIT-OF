import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { communityFixture } from './helpers/community.mjs';
const { CommunityService } = await import('../dist/community/service.js');
const { registerEventWork } = await import('../dist/community/eventDelivery.js');
const { CommunityStore } = await import('../dist/community/store.js');
const { renderEvent } = await import('../dist/commands/event.js');

function draft(f, extra = {}) {
  return { guildId: 'g', channelId: 'c', creatorId: 'officer', title: 'Team night', description: 'Play',
    startAt: f.now() + 3600000, durationMinutes: 120, capacity: 100, squads: [], reminderMinutes: 0, ...extra };
}
async function published(f, extra = {}) {
  const s = f.db.community.events, e = s.createDraft(draft(f, extra), f.now());
  const message = await f.channel.send({ embeds: [] });
  f.calls.sends.length = 0;
  return s.publish('g', e.id, 1, message.id);
}
function worker(f, options = {}) {
  const service = new CommunityService(f.client, f.db, f.api, { now: f.now, ...options });
  registerEventWork(service, f.client, f.db);
  f.services.push(service);
  return service;
}
const reminderJobs = f => f.db.community.deliveries.list('g').filter(j => j.kind === 'event_reminder');
const reminders = f => f.calls.sends.filter(p => p.allowedMentions?.users?.length);
function optIn(f, e, id, present = true) {
  if (present) f.addMember(id);
  f.db.community.events.join('g', e.id, id, null, f.now());
  f.db.community.events.setReminder('g', e.id, id, true, f.now());
}

test('default events never enqueue reminders; opted-in 30 minute reminders use the exact due instant', async () => {
  const f = communityFixture();
  try {
    const off = await published(f), on = await published(f, { reminderMinutes: 30 });
    optIn(f, on, '100000000000000001');
    const service = worker(f);
    f.advance(1799999); await service.runOnce(); assert.equal(reminderJobs(f).length, 0);
    f.advance(1); await service.runOnce();
    assert.equal(reminderJobs(f).length, 1);
    assert.equal(reminderJobs(f)[0].dueAt, on.startAt - 1800000);
    assert.equal(reminderJobs(f)[0].subjectId, on.id);
    assert.ok(!reminderJobs(f).some(j => j.subjectId === off.id));
    assert.deepEqual(reminders(f)[0].allowedMentions, { parse: [], users: ['100000000000000001'], roles: [], repliedUser: false });
  } finally { await f.close(); }
});

test('reminder send boundary removes withdrawn, reserve, departed and disabled recipients after enqueue', async () => {
  const f = communityFixture();
  try {
    const e = await published(f, { capacity: 5, reminderMinutes: 30 }), s = f.db.community.events;
    const ids = Array.from({ length: 6 }, (_, i) => String(100000000000000001n + BigInt(i)));
    for (const id of ids) optIn(f, e, id, id !== ids[3]);
    f.advance(1800000);
    const service = worker(f, { maxSendsPerTick: 1 });
    // The coalesced card update consumes the first delivery slot, leaving snapshots queued.
    await service.runOnce(); assert.equal(reminderJobs(f).length, 1);
    s.withdraw('g', e.id, ids[1], new Set(ids.filter(id => id !== ids[3])), f.now());
    s.setReminder('g', e.id, ids[2], false, f.now());
    await service.runOnce();
    assert.deepEqual(reminders(f)[0].allowedMentions.users, [ids[0], ids[4]]);
    assert.doesNotMatch(reminders(f)[0].content, new RegExp(ids[1] + '|' + ids[2] + '|' + ids[3] + '|' + ids[5]));
    assert.equal(f.calls.memberFetches.length, 2, 'two bounded fresh lookups revalidate around channel lookup');
    assert.ok(f.calls.memberFetches.every(args => Array.isArray(args.user) && args.user.length <= 5));
  } finally { await f.close(); }
});

test('time edits, cancellation and the exact start instant cancel queued reminder revisions', async () => {
  for (const action of ['edit', 'cancel', 'start']) {
    const f = communityFixture();
    try {
      const e = await published(f, { reminderMinutes: 30 }); optIn(f, e, '100000000000000001');
      f.advance(1800000); const service = worker(f, { maxSendsPerTick: 1 }); await service.runOnce();
      if (action === 'edit') f.db.community.events.edit('g', e.id, 1, { startAt: e.startAt + 3600000 }, f.now());
      else if (action === 'cancel') f.db.community.events.cancel('g', e.id, 1, f.now());
      else f.advance(1800000);
      await service.runOnce();
      assert.equal(reminders(f).length, 0);
      assert.equal(reminderJobs(f)[0].status, 'cancelled');
    } finally { await f.close(); }
  }
});

test('split reminder parts persist deterministic recipients and never reshuffle newly promoted members', async () => {
  const f = communityFixture();
  try {
    const e = await published(f, { reminderMinutes: 30 }), ids = [];
    for (let n = 0; n < 100; n++) { const id = String(100000000000000000n + BigInt(n)); ids.push(id); optIn(f, e, id); }
    f.advance(1800000); const service = worker(f, { maxSendsPerTick: 1 }); await service.runOnce();
    const before = reminderJobs(f).map(j => [j.key, j.part]); assert.equal(before.length, 3);
    await service.runOnce(); assert.deepEqual(reminders(f)[0].allowedMentions.users, ids.slice(0, 40));
    f.db.community.events.withdraw('g', e.id, ids[40], new Set(ids), f.now());
    await service.stop(); const restarted = worker(f);
    await restarted.runOnce();
    assert.deepEqual(reminderJobs(f).map(j => [j.key, j.part]), before);
    const all = reminders(f).flatMap(p => p.allowedMentions.users);
    assert.equal(all.length, 99); assert.equal(new Set(all).size, 99); assert.ok(!all.includes(ids[40]));
  } finally { await f.close(); }
});

test('fresh membership lookup cannot resurrect reminders after an event revision changes', async () => {
  const f = communityFixture();
  try {
    const e = await published(f, { reminderMinutes: 30 }); optIn(f, e, '100000000000000001');
    const fetch = f.guild.members.fetch;
    f.guild.members.fetch = async args => {
      const result = await fetch(args);
      if (f.db.community.events.get('g', e.id).revision === 1) f.db.community.events.cancel('g', e.id, 1, f.now());
      return result;
    };
    f.advance(1800000); await worker(f).runOnce();
    assert.equal(reminderJobs(f).length, 1); assert.equal(f.calls.memberFetches.length, 1);
    assert.equal(reminders(f).length, 0);
  } finally { await f.close(); }
});

test('retention bounds child deletion when a retired event has a large reserve list', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql); const c = new CommunityStore(sql), s = c.events;
    const e = s.createDraft(draft({ now: () => 1000 }), 1000); s.publish('g', e.id, 1, 'public');
    const insert = sql.prepare('INSERT INTO community_event_signups VALUES(?,?,?,?,?,?,?)');
    for (let n = 0; n < 1001; n++) insert.run('g', e.id, String(n), null, 'reserve', n, 0);
    const pruneAt = 10801001 + 90 * 86400000;
    c.prune(pruneAt);
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM community_event_signups').get().n, 801);
    assert.ok(s.get('g', e.id), 'retain parent until all children have drained');
    for (let n = 0; n < 5; n++) c.prune(pruneAt);
    assert.equal(s.get('g', e.id), null);
  } finally { sql.close(); }
});

test('current guild membership excludes a departed confirmed member without a departure callback', async () => {
  const f = communityFixture();
  try {
    const e = await published(f, { reminderMinutes: 30 });
    optIn(f, e, '100000000000000001'); optIn(f, e, '100000000000000002', false);
    f.advance(1800000); await worker(f).runOnce();
    assert.deepEqual(reminders(f)[0].allowedMentions.users, ['100000000000000001']);
  } finally { await f.close(); }
});

test('publication timeout recovery binds the original card and deliberate retry reconciles without a second post', async () => {
  for (const outcome of ['accepted', 'unknown']) {
    const f = communityFixture();
    try {
      const s = f.db.community.events, e = s.createDraft(draft(f), f.now()); s.requestPublish('g', e.id, 1, f.now());
      const send = f.channel.send;
      f.channel.send = async payload => {
        if (outcome === 'accepted') await send(payload);
        else f.calls.sends.push(payload);
        throw Error('socket timeout');
      };
      const service = worker(f); await service.runOnce();
      const job = f.db.community.deliveries.list('g')[0];
      assert.equal(job.status, outcome === 'accepted' ? 'sent' : 'needs_review');
      assert.equal(s.get('g', e.id).messageId, outcome === 'accepted' ? 'message-1' : null);
      if (outcome === 'unknown') f.db.community.deliveries.retry('g', job.id, 1, f.now());
      await service.runOnce(); assert.equal(f.calls.sends.length, 1);
    } finally { await f.close(); }
  }
});

test('known event cards recover by editing the saved message and shared edit sanitizer preserves explicit users only', async () => {
  const f = communityFixture();
  try {
    const e = await published(f), service = worker(f);
    service.registerDelivery('allowlist-edit', { prepare: async () => ({ messageId: e.messageId, payload: {
      content: '<@100000000000000001> @everyone <@&100000000000000002>',
      allowedMentions: { parse: ['everyone', 'roles', 'users'], users: ['100000000000000001'], roles: ['100000000000000002'], repliedUser: true },
    } }) });
    f.db.community.deliveries.enqueue({ key: 'edit-allowlist', guildId: 'g', channelId: 'c', kind: 'allowlist-edit', subjectId: e.id, revision: 1, dueAt: f.now(), part: 0 });
    await service.runOnce();
    assert.equal(f.calls.sends.length, 0); assert.equal(f.calls.edits.length, 1);
    assert.deepEqual(f.calls.edits[0].allowedMentions, { parse: [], users: ['100000000000000001'], roles: [], repliedUser: false });
    assert.equal(f.calls.edits[0].nonce, undefined);
  } finally { await f.close(); }
});

test('busy housekeeping leaves fresh reminder request capacity and budget deferral never counts as delivery failure', async () => {
  const f = communityFixture();
  try {
    const e = await published(f, { reminderMinutes: 30 }); optIn(f, e, '100000000000000001');
    const service = worker(f);
    service.registerTask('busy', async tick => { while (tick.takeRequest()) await f.api.getPlayer('busy'); });
    f.advance(1800000);
    await service.runOnce();
    assert.equal(reminderJobs(f)[0].attempts, 0, 'exhausted tick budget is scheduling, not a delivery failure');
    assert.equal(reminderJobs(f)[0].status, 'pending');
    assert.equal(f.calls.requests.length + f.calls.memberFetches.length, 8);
    const before = f.calls.requests.length + f.calls.memberFetches.length;
    f.advance(60000); await service.runOnce();
    assert.equal(reminders(f).length, 1, 'persistent busy work cannot starve a reminder on the following tick');
    assert.equal(f.calls.requests.length + f.calls.memberFetches.length - before, 7, 'five task requests plus two fresh member requests; one recovery request remains reserved');
    assert.equal(f.calls.memberFetches.length, 2);
  } finally { await f.close(); }
});

test('one guild membership failure does not prevent another guild from queuing its reminder', async () => {
  const f = communityFixture();
  const warn = console.warn;
  try {
    console.warn = () => {};
    const first = await published(f); f.db.community.events.join('g', first.id, 'gone', null, f.now());
    f.db.community.purgeMember('g', 'gone');
    const other = { ...f.guild, id: 'other', members: { fetch: f.guild.members.fetch } };
    f.client.guilds.cache.set('other', other);
    const e = f.db.community.events.createDraft(draft(f, { guildId: 'other', channelId: 'other-c', reminderMinutes: 30 }), f.now());
    f.db.community.events.publish('other', e.id, 1, 'other-card');
    f.addMember('100000000000000001');
    f.db.community.events.join('other', e.id, '100000000000000001', null, f.now());
    f.db.community.events.setReminder('other', e.id, '100000000000000001', true, f.now());
    f.guild.members.fetch = async () => { throw Error('guild unavailable'); };
    f.client.channels.fetch = async id => id === 'other-c' ? { ...f.channel, guildId: 'other' } : f.channel;
    // The unrelated update has no known fixture card; that job may pause independently.
    f.advance(1800000); await worker(f).runOnce();
    assert.equal(f.db.community.deliveries.list('other').filter(j => j.kind === 'event_reminder').length, 1);
    assert.equal(reminders(f).length, 1);
  } finally { console.warn = warn; await f.close(); }
});

test('housekeeping closes controls at start, finishes at end and promotes a present reserve after departure', async () => {
  const f = communityFixture();
  try {
    const e = await published(f, { capacity: 1 }), s = f.db.community.events;
    f.addMember('reserve'); s.join('g', e.id, 'departed', null, f.now()); s.join('g', e.id, 'reserve', null, f.now());
    f.db.community.purgeMember('g', 'departed'); await worker(f).runOnce();
    assert.equal(s.signup('g', e.id, 'reserve').state, 'confirmed');
    assert.equal(s.promotionDue('g').length, 0); assert.equal(f.calls.memberFetches.length, 1);
    f.advance(3600000); await f.services[0].runOnce();
    const controls = f.calls.edits.at(-1).components[0].components;
    assert.ok(controls.every(b => b.data.disabled));
    f.advance(7200000); await f.services[0].runOnce(); assert.equal(s.get('g', e.id).status, 'finished');
  } finally { await f.close(); }
});

test('retention uses actual end/cancellation age, preserves exact 90 day boundary and cleans signups', async () => {
  const f = communityFixture();
  try {
    const ended = await published(f, { durationMinutes: 15 }), cancelled = await published(f, { startAt: f.now() + 86400000 });
    const s = f.db.community.events; s.join('g', ended.id, 'a', null, f.now()); s.join('g', cancelled.id, 'a', null, f.now());
    s.cancel('g', cancelled.id, 1, f.now());
    f.advance(90 * 86400000); f.db.community.prune(f.now()); assert.ok(s.get('g', cancelled.id));
    f.advance(1); f.db.community.prune(f.now()); assert.equal(s.get('g', cancelled.id), null); assert.deepEqual(s.signups('g', cancelled.id), []);
    assert.ok(s.get('g', ended.id), 'duration contributes to retention even before worker marks finished');
    f.advance(4500000); f.db.community.prune(f.now()); assert.equal(s.get('g', ended.id), null);
  } finally { await f.close(); }
});

test('public participant reads materialize only twenty rows with accurate large reserve counts and indexed queries', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql); const c = new CommunityStore(sql), s = c.events;
    const e = s.createDraft({ ...draft({ now: () => 1000 }), capacity: 1 }, 1000); s.publish('g', e.id, 1, 'public');
    const insert = sql.prepare('INSERT INTO community_event_signups VALUES(?,?,?,?,?,?,?)');
    sql.exec('BEGIN');
    for (let n = 1; n <= 10001; n++) insert.run('g', e.id, `member-${n}`, null, n === 1 ? 'confirmed' : 'reserve', n, 0);
    sql.exec('COMMIT');
    const statements = [], prepare = sql.prepare.bind(sql);
    sql.prepare = query => { const statement = prepare(query); return new Proxy(statement, { get(target, key) {
      if (key === 'all') return (...args) => { const rows = target.all(...args); statements.push({ query, rows: rows.length }); return rows; };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }); };
    assert.equal(s.participants('g', e.id, 1).entries.length, 20);
    const page = s.participants('g', e.id, 501);
    assert.equal(page.entries.length, 1); assert.equal(page.total, 10001); assert.equal(page.confirmed, 1);
    const card = renderEvent(s.get('g', e.id), page, 501, 1000);
    assert.match(JSON.stringify(card), /10000 reserve/); assert.match(JSON.stringify(card), /member-10001/);
    assert.ok(statements.every(row => row.rows <= 21), JSON.stringify(statements));
    for (const row of statements) {
      const binds = row.query.includes('LIMIT') ? [e.id, 'g', 20, 10000] : [e.id, 'g'];
      const plan = prepare('EXPLAIN QUERY PLAN ' + row.query).all(...binds).map(r => r.detail).join('\n');
      assert.match(plan, /INDEX/); assert.doesNotMatch(plan, /SCAN community_event_signups/);
    }
  } finally { sql.close(); }
});

test('event due work and retention use ordered range indexes without scanning every scheduled event', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql); const c = new CommunityStore(sql), s = c.events;
    const plans = [], prepare = sql.prepare.bind(sql);
    sql.prepare = query => {
      const statement = prepare(query);
      return new Proxy(statement, { get(target, key) {
        if (key === 'all') return (...args) => {
          const rows = target.all(...args);
          if (/SELECT .*FROM community_events\s/.test(query.replaceAll('\n', ' '))) {
            plans.push(prepare('EXPLAIN QUERY PLAN ' + query).all(...args).map(r => r.detail).join('\n'));
          }
          return rows;
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    s.reminderDue('g', 1000); s.promotionDue('g', 20); s.maintain('g', 1000); c.prune(1000);
    assert.equal(plans.length, 5);
    for (const plan of plans) {
      assert.match(plan, /USING INDEX/); assert.doesNotMatch(plan, /SCAN community_events|TEMP B-TREE/);
    }
  } finally { sql.close(); }
});

test('squad count keys preserve occupancy validation for valid ids matching object prototype names', async () => {
  const f = communityFixture();
  try {
    const s = f.db.community.events;
    const e = await published(f, { capacity: 3, squads: [{ id: '__proto__', name: 'Alpha', capacity: 2 }, { id: 'other', name: 'Beta', capacity: 1 }] });
    s.join('g', e.id, 'a', '__proto__', f.now()); s.join('g', e.id, 'b', '__proto__', f.now());
    const page = s.participants('g', e.id);
    assert.equal(page.squadConfirmed.__proto__, 2);
    assert.match(JSON.stringify(renderEvent(e, page, 1, f.now())), /Alpha · 2\/2/);
    assert.throws(() => s.edit('g', e.id, 1, { squads: [{ id: '__proto__', name: 'Alpha', capacity: 1 }, { id: 'other', name: 'Beta', capacity: 2 }] }, f.now()), /capacity|occupancy/i);
  } finally { await f.close(); }
});
