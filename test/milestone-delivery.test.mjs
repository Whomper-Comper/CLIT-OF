import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection } from 'discord.js';
import { milestoneFixture, enable, binding, profile } from './helpers/milestones.mjs';
import { CommunityService } from '../dist/community/service.js';
import { registerMilestoneWork, prepareMilestoneDelivery } from '../dist/community/milestoneWorker.js';
import { HistoryCollector } from '../dist/historyCollector.js';

function service(f) {
  const s = new CommunityService(f.client, f.db, f.api, { now: f.now });
  registerMilestoneWork(s, f.client, f.db, f.api);
  f.services.push(s);
  return s;
}
function queue(f, id = 'u') {
  const b = binding(f, 'g', id), store = f.db.community.milestones;
  const generation = store.prepareObservation(b, f.now());
  store.observe(b, { games: 9n, wins: 0n, losses: 0n }, { games: ['10', '50'], wins: ['1'] }, f.now(), generation, 1);
  store.observe(b, { games: 51n, wins: 2n, losses: 0n }, { games: ['10', '50'], wins: ['1'] }, f.now(), generation, 1);
  return f.db.community.deliveries.list('g').find(j => f.db.community.milestones.getIntent(j.subjectId)?.binding.discordId === id);
}
test('polling establishes quiet baselines then sends one combined card with exact observed totals', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const s = service(f);
    await s.runOnce();
    assert.equal(f.db.community.milestones.getState('g', 'player').counters.games, 9n);
    assert.equal(f.calls.sends.length, 0);
    f.advance(900000);
    f.api.getPlayerProfile = async () => profile('51', '2');
    await s.runOnce();
    assert.equal(f.calls.sends.length, 1);
    const text = JSON.stringify(f.calls.sends[0]);
    assert.match(text, /10.*50/);
    assert.match(text, /51/);
    assert.match(text, /Observed/);
    assert.match(text, /openfront.io\/player\/player/);
    assert.equal(f.db.community.deliveries.list('g').length, 1);
  } finally { await f.close(); }
});
test('fair polling shares eight requests across guilds and never repeats accounts inside fifteen minutes', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    for (let n = 0; n < 12; n++) {
      f.addMember(`u${n}`);
      f.db.linkGuildUser('g', 'admin', `u${n}`, `p${n}`, null);
    }
    const other = { ...f.guild, id: 'other' };
    f.client.guilds.cache.set('other', other);
    f.db.setGuildClanConfig({ ...f.db.getGuildConfigs('g')[0], guild_id: 'other' });
    enable(f, 'other');
    f.db.linkGuildUser('other', 'admin', 'u', 'other-player', null);
    const s = service(f);
    const fetched = new Set();
    for (let n = 0; n < 15; n++) {
      const before = f.calls.requests.length + f.calls.memberFetches.length;
      await s.runOnce();
      const total = f.calls.requests.length + f.calls.memberFetches.length;
      assert.ok(total - before <= 8);
      for (const [id] of f.calls.requests) fetched.add(id);
    }
    assert.ok(fetched.has('other-player'));
    assert.equal(fetched.size, 14);
    assert.equal(f.calls.requests.length, 14);
  } finally { await f.close(); }
});
test('pending profile work cannot persist after settings, identity, cleanup or clan eligibility changes', async () => {
  for (const mutation of [
    f => f.db.community.settings.save('g', { ...f.db.community.settings.get('g'), milestonesEnabled: false }, 1),
    f => f.db.linkGuildUser('g', 'admin', 'u', 'replacement', null),
    f => f.db.community.purgeMember('g', 'u'),
    f => f.db.history.setMeta('deletions_error', 'failed'),
    f => f.db.deleteGuildClanConfig('g', 'MARS'),
  ]) {
    const f = milestoneFixture();
    try {
      enable(f);
      f.api.getPlayerProfile = async () => {
        mutation(f);
        return profile('51', '2');
      };
      await service(f).runOnce();
      assert.equal(f.db.community.milestones.getState('g', 'player').counters, null);
      assert.equal(f.db.community.deliveries.list('g').length, 0);
    } finally { await f.close(); }
  }
});
test('deletion health and empty thresholds suppress automatic profile polling', async () => {
  for (const change of [
    f => f.db.history.setMeta('deletions_error', 'failed'),
    f => f.db.history.setMeta('deletions_last_success', new Date(f.now() - 86400001).toISOString()),
    f => f.db.community.settings.save('g', { ...f.db.community.settings.get('g'), gameThresholds: [], winThresholds: [] }, 1),
  ]) {
    const f = milestoneFixture();
    try {
      enable(f);
      change(f);
      await service(f).runOnce();
      assert.equal(f.calls.requests.length, 0);
    } finally { await f.close(); }
  }
});
test('milestone-only servers synchronize deletions without enabling history collection', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    f.db.history.setMeta('deletions_last_success', '');
    let feeds = 0;
    f.api.getRecentlyDeletedPlayers = async () => { feeds++; return []; };
    const c = new HistoryCollector(f.client, f.db, f.api, { now: f.now });
    await c.collectOnce();
    await c.stop();
    assert.equal(feeds, 1);
    assert.equal(f.db.history.getSettings('g').collection_enabled, 0);
    assert.equal(f.calls.requests.length, 0);
  } finally { await f.close(); }
});
test('settings listing decodes the same rows and revisions with one query', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { CommunityStore } = await import('../dist/community/store.js');
  const { CommunitySettingsStore } = await import('../dist/community/settings.js');
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    let count = 0;
    const store = new CommunitySettingsStore({
      exec: text => sql.exec(text),
      prepare(text) { count++; return sql.prepare(text); },
    });
    const expected = [];
    for (let n = 0; n < 1000; n++) {
      const id = `g${String(n).padStart(4, '0')}`;
      let row = store.save(id, store.get(id), 0);
      if (n % 2) row = store.save(id, { ...row, gameThresholds: [] }, 1);
      expected.push(row);
    }
    count = 0;
    assert.deepEqual(store.list(), expected);
    assert.equal(count, 1);
  } finally { sql.close(); }
});

test('unhealthy deletion feed defers an earned card instead of discarding its delivery', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const job = queue(f);
    f.db.history.setMeta('deletions_error', 'failed');
    await service(f).runOnce();
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.db.community.deliveries.get(job.id).status, 'pending');
    assert.equal(f.db.community.milestones.listAwards('g', 'player').length, 3);
  } finally { await f.close(); }
});
test('later delivery validation is fresh, bounded, shares repeated prepare proof and never observes counters', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const job = queue(f), s = service(f);
    f.advance(60000);
    f.channel.send = async () => { throw Object.assign(new Error('forbidden'), { code: 50013 }); };
    await s.runOnce();
    assert.equal(f.calls.requests.length, 1);
    assert.deepEqual(f.calls.requests[0], ['player', { fresh: true }]);
    assert.equal(f.db.community.deliveries.get(job.id).status, 'paused');
    assert.equal(f.db.community.milestones.getState('g', 'player').counters.games, 51n);
    f.db.community.deliveries.retry('g', job.id, 1, f.now());
    f.advance(60000);
    f.api.getPlayerProfile = async () => { f.calls.requests.push(['player']); return profile('100', '9', []); };
    await s.runOnce();
    assert.equal(f.calls.requests.length, 2);
    assert.equal(f.db.community.deliveries.get(job.id).status, 'cancelled');
    assert.equal(f.db.community.milestones.getState('g', 'player').counters.games, 51n);
  } finally { await f.close(); }
});
test('same-tick polling evidence avoids a second profile read and honors send and request budgets', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const s = service(f);
    await s.runOnce();
    f.advance(900000);
    f.api.getPlayerProfile = async (id) => { f.calls.requests.push([id]); return profile('51', '2'); };
    const before = f.calls.memberFetches.length;
    await s.runOnce();
    assert.equal(f.calls.requests.length, 2);
    assert.equal(f.calls.sends.length, 1);
    assert.ok(1 + f.calls.memberFetches.length - before <= 8);
    assert.ok(f.calls.sends.length <= 4);
  } finally { await f.close(); }
});
test('a long membership await expires shared profile proof and safely defers the card', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const job = queue(f);
    const original = f.guild.members.fetch;
    f.guild.members.fetch = async options => {
      const result = await original(options);
      if (options?.user) f.advance(60001);
      return result;
    };
    await service(f).runOnce();
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.db.community.deliveries.get(job.id).status, 'pending');
  } finally { await f.close(); }
});
test('disable during channel lookup cancels a claimed delivery and shutdown never sends', async () => {
  for (const action of ['disable', 'stop']) {
    const f = milestoneFixture();
    try {
      enable(f);
      const job = queue(f), s = service(f);
      f.client.channels.fetch = async () => {
        if (action === 'disable') f.db.community.settings.save('g', { ...f.db.community.settings.get('g'), milestonesEnabled: false }, 1);
        else void s.stop();
        return f.channel;
      };
      await s.runOnce();
      assert.equal(f.calls.sends.length, 0);
      assert.notEqual(f.db.community.deliveries.get(job.id).status, 'sent');
    } finally { await f.close(); }
  }
});

test('temporary unknown clan evidence defers cards; confirmed departure cancels them', async () => {
  for (const [response, status] of [[null, 'pending'], [{}, 'pending'], [profile('51', '2', []), 'cancelled']]) {
    const f = milestoneFixture();
    try {
      enable(f);
      const job = queue(f);
      f.api.getPlayerProfile = async () => response;
      await service(f).runOnce();
      assert.equal(f.calls.sends.length, 0);
      assert.equal(f.db.community.deliveries.get(job.id).status, status);
    } finally { await f.close(); }
  }
});
test('reconciliation rereads membership and reuses profile evidence while never duplicating a recovered card', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const job = queue(f);
    const { deliveryMarker } = await import('../dist/community/deliveries.js');
    const claimed = f.db.community.deliveries.claim(f.now(), 1)[0];
    f.db.community.deliveries.fail(claimed.id, claimed.leaseId, 'needs_review', 'uncertain', f.now());
    f.messages.set('recovered', { id: 'recovered', author: { id: 'bot' }, content: '',
      embeds: [{ footer: { text: deliveryMarker(job) } }] });
    f.db.community.deliveries.retry('g', job.id, 1, f.now());
    const before = f.calls.memberFetches.length;
    await service(f).runOnce();
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.calls.memberFetches.length - before, 4);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.db.community.deliveries.get(job.id).messageId, 'recovered');
  } finally { await f.close(); }
});

test('reconciliation reserves fresh validation capacity while other accounts are due for polling', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const job = queue(f);
    const { deliveryMarker } = await import('../dist/community/deliveries.js');
    const claimed = f.db.community.deliveries.claim(f.now(), 1)[0];
    f.db.community.deliveries.fail(claimed.id, claimed.leaseId, 'needs_review', 'uncertain', f.now());
    f.db.community.deliveries.retry('g', job.id, 1, f.now());
    assert.equal(f.db.community.deliveries.get(job.id).reconcileRequired, true);
    assert.ok(!f.db.community.milestones.dueMembers('g', f.now(), 8).includes('u'));
    f.messages.set('recovered-busy', {
      id: 'recovered-busy', author: { id: 'bot' }, content: '',
      embeds: [{ footer: { text: deliveryMarker(job) } }],
    });
    for (let n = 0; n < 6; n++) {
      const id = `busy${n}`;
      f.addMember(id);
      f.db.linkGuildUser('g', 'admin', id, `busy-account${n}`, null);
    }

    await service(f).runOnce();

    const recovered = f.db.community.deliveries.get(job.id);
    assert.equal(recovered.status, 'sent');
    assert.equal(recovered.messageId, 'recovered-busy');
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.requests.filter(([id]) => id === 'player').length, 1);
    assert.ok(f.calls.requests.some(([id]) => id.startsWith('busy-account')));
    assert.equal(f.calls.memberFetches.filter(options => options?.user === 'u').length, 3);
    assert.ok(f.calls.requests.length + f.calls.memberFetches.length <= 8);
    assert.ok(f.db.community.milestones.dueMembers('g', f.now(), 8).some(id => id.startsWith('busy')));
    assert.equal(f.db.community.milestones.getState('g', 'player').counters.games, 51n);
  } finally { await f.close(); }
});

test('global polling gate survives reopen, preserves local backoff when blocked and opens at the exact boundary', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { CommunityStore } = await import('../dist/community/store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'milestone-gate-'));
  let sql = new DatabaseSync(join(folder, 'state.sqlite'));
  try {
    CommunityStore.initialize(sql);
    let community = new CommunityStore(sql);
    const a = { guildId: 'a', discordId: 'u', publicId: 'shared', linkedAt: 'v1' };
    const b = { ...a, guildId: 'b' };
    for (const binding of [a, b]) community.milestones.syncCandidates(binding.guildId, [binding], 1000);
    assert.equal(community.milestones.markPollingAttempt(a, 1000), true);
    assert.equal(community.milestones.markPollingAttempt(b, 1001), false);
    community.purgeGuild('a');
    assert.equal(sql.prepare('SELECT guild_id FROM community_milestone_account_attempts').get().guild_id, 'b');
    sql.close();
    sql = new DatabaseSync(join(folder, 'state.sqlite'));
    community = new CommunityStore(sql);
    assert.deepEqual(community.milestones.duePollingMembers('b', 900999, 8), []);
    assert.equal(community.milestones.markPollingAttempt(b, 900999), false);
    assert.deepEqual(community.milestones.duePollingMembers('b', 901000, 8), ['u']);
    assert.equal(community.milestones.markPollingAttempt(b, 901000), true);
    // Globally blocked reservations did not increment b's local failure count.
    assert.deepEqual(community.milestones.dueMembers('b', 1801000, 8), ['u']);
    community.purgeAccount('shared');
    assert.equal(sql.prepare('SELECT count(*) n FROM community_milestone_account_attempts').get().n, 0);
    community.milestones.syncCandidates('a', [a], 2000000);
    community.milestones.markPollingAttempt(a, 2000000);
    community.milestones.syncCandidates('a', [], 2000001);
    community.purgeIdentity('u');
    assert.equal(sql.prepare('SELECT count(*) n FROM community_milestone_account_attempts').get().n, 0);
    for (let n = 0; n < 250; n++) {
      const binding = { ...a, discordId: `u${n}`, publicId: `p${n}` };
      community.milestones.prepareObservation(binding, 3000000);
      community.milestones.markPollingAttempt(binding, 3000000);
    }
    community.prune(3900001);
    assert.equal(sql.prepare('SELECT count(*) n FROM community_milestone_account_attempts').get().n, 50);
    community.prune(3900001);
    assert.equal(sql.prepare('SELECT count(*) n FROM community_milestone_account_attempts').get().n, 0);
  } finally {
    sql.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
test('one account in two enabled guilds shares raw profile evidence and remains globally paced', async () => {
  const f = milestoneFixture();
  try {
    enable(f);
    const other = { ...f.guild, id: 'other' };
    f.client.guilds.cache.set('other', other);
    f.db.setGuildClanConfig({ ...f.db.getGuildConfigs('g')[0], guild_id: 'other' });
    f.db.linkGuildUser('other', 'admin', 'u', 'player', null);
    enable(f, 'other');
    const s = service(f);
    await s.runOnce();
    assert.equal(f.calls.requests.length, 1);
    assert.equal(f.db.community.milestones.getState('g', 'player').counters.games, 9n);
    assert.equal(f.db.community.milestones.getState('other', 'player').counters.games, 9n);
    for (let n = 0; n < 3; n++) { f.advance(60000); await s.runOnce(); }
    assert.equal(f.calls.requests.length, 1);
    f.advance(720000);
    await s.runOnce();
    assert.equal(f.calls.requests.length, 2);
  } finally { await f.close(); }
});
