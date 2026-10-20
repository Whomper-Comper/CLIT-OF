import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communityFixture } from './helpers/community.mjs';

const { CommunityStore } = await import('../dist/community/store.js');
const binding = { guildId: 'g', channelId: 'c', messageId: null };
const day = 86_400_000;

function fixture(t) {
  const f = communityFixture();
  t.after(() => f.close());
  return { ...f, duels: f.db.community.duels };
}

test('accepting twice reuses two independent saved D6 draws', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  let calls = 0;
  const roll = (min, max) => {
    assert.equal(min, 1);
    assert.equal(max, 7);
    return ++calls === 1 ? 1 : 6;
  };
  const first = f.duels.resolve('g', duel.id, 'b', f.now(), roll);
  const repeated = f.duels.resolve('g', duel.id, 'b', f.now(), roll);
  assert.equal(calls, 2);
  assert.deepEqual([first.challengerRoll, repeated.opponentRoll], [1, 6]);
  assert.deepEqual(repeated, first);
  assert.equal(first.status, 'resolved');
  assert.equal(first.revision, 2);
  assert.equal(first.resolvedAt, f.now());
});

for (const [a, b] of [[6, 1], [1, 6], [4, 4]]) {
  test(`preserves challenger/opponent order for ${a}/${b}`, t => {
    const f = fixture(t);
    const duel = f.duels.invite(binding, 'a', 'b', f.now());
    const rolls = [a, b];
    const saved = f.duels.resolve('g', duel.id, 'b', f.now(), () => rolls.shift());
    assert.deepEqual([saved.challengerRoll, saved.opponentRoll], [a, b]);
    assert.deepEqual(f.duels.get('g', duel.id), saved);
  });
}

test('only opponent consents or declines and only challenger cancels, including duplicates', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  for (const actor of ['a', 'stranger']) {
    assert.throws(() => f.duels.resolve('g', duel.id, actor, f.now()), /opponent/i);
    assert.throws(() => f.duels.decline('g', duel.id, actor, f.now()), /opponent/i);
  }
  for (const actor of ['b', 'stranger']) {
    assert.throws(() => f.duels.cancel('g', duel.id, actor, f.now()), /challenger/i);
  }
  const saved = f.duels.resolve('g', duel.id, 'b', f.now(), () => 3);
  assert.throws(() => f.duels.resolve('g', duel.id, 'stranger', f.now()), /opponent/i);
  assert.deepEqual(f.duels.resolve('g', duel.id, 'b', f.now(), () => assert.fail('redraw')), saved);
});

test('rejects self invitations and scopes lookups and mutations to the saved guild', t => {
  const f = fixture(t);
  assert.throws(() => f.duels.invite(binding, 'a', 'a', f.now()), /different|yourself/i);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  assert.equal(f.duels.get('other', duel.id), null);
  for (const method of ['resolve', 'decline', 'cancel']) {
    assert.throws(() => f.duels[method]('other', duel.id, 'b', f.now()), /unavailable|reopen/i);
  }
  assert.throws(() => f.duels.bindMessage('other', duel.id, duel.revision, 'm'), /unavailable|changed/i);
  assert.equal(f.duels.get('g', duel.id).status, 'pending');
});

test('either participant occupies one pending slot per server', t => {
  const f = fixture(t);
  f.duels.invite(binding, 'a', 'b', f.now());
  for (const [a, b] of [['a', 'c'], ['c', 'a'], ['b', 'c'], ['c', 'b']]) {
    assert.throws(() => f.duels.invite(binding, a, b, f.now()), /pending/i);
  }
  assert.equal(f.duels.invite({ ...binding, guildId: 'other' }, 'a', 'b', f.now()).status, 'pending');
});

for (const [method, actor, status] of [['resolve', 'b', 'resolved'], ['decline', 'b', 'declined'], ['cancel', 'a', 'cancelled']]) {
  test(`${method} releases both slots and remains terminal`, t => {
    const f = fixture(t);
    const duel = f.duels.invite(binding, 'a', 'b', f.now());
    const saved = f.duels[method]('g', duel.id, actor, f.now(), () => 2);
    assert.equal(saved.status, status);
    assert.equal(saved.resolvedAt, f.now());
    assert.deepEqual(f.duels[method]('g', duel.id, actor, f.now(), () => assert.fail('redraw')), saved);
    assert.equal(f.duels.invite(binding, 'c', 'a', f.now()).status, 'pending');
    assert.equal(f.duels.invite(binding, 'd', 'b', f.now()).status, 'pending');
    assert.deepEqual(f.duels.resolve('g', duel.id, 'b', f.now(), () => assert.fail('revival')), saved);
  });
}

test('challenger cooldown survives terminal transitions and ends exactly at 30 seconds', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  f.duels.cancel('g', duel.id, 'a', f.now());
  f.advance(29_999);
  assert.throws(() => f.duels.invite(binding, 'a', 'c', f.now()), /cooldown|30 seconds/i);
  f.advance(1);
  assert.equal(f.duels.invite(binding, 'a', 'c', f.now()).status, 'pending');
});

test('expiry occurs at exactly two minutes and persists without a background tick', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  assert.equal(duel.expiresAt, f.now() + 120_000);
  assert.deepEqual(f.duels.expire(f.now() + 119_999), []);
  const expired = f.duels.resolve('g', duel.id, 'b', f.now() + 120_000, () => assert.fail('expired draw'));
  assert.equal(expired.status, 'expired');
  assert.equal(expired.resolvedAt, duel.expiresAt);
  assert.equal(expired.challengerRoll, null);
  assert.equal(f.duels.invite(binding, 'a', 'b', f.now() + 120_000).status, 'pending');
});

test('new invitations retire only their participants expired slots before claiming them', t => {
  const f = fixture(t);
  const first = f.duels.invite(binding, 'a', 'b', f.now());
  const unrelated = f.duels.invite(binding, 'c', 'd', f.now());
  f.advance(120_000);
  f.duels.invite(binding, 'e', 'b', f.now());
  assert.equal(f.duels.get('g', first.id).status, 'expired');
  assert.equal(f.duels.get('g', unrelated.id).status, 'pending');
  assert.deepEqual(f.duels.expire(f.now()).map(d => d.id), [unrelated.id]);
});

test('RNG failure and invalid draws roll back the claim and preserve participant slots', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  let calls = 0;
  assert.throws(() => f.duels.resolve('g', duel.id, 'b', f.now(), () => {
    if (++calls === 2) throw new Error('entropy unavailable');
    return 3;
  }), /entropy unavailable/);
  assert.deepEqual(f.duels.get('g', duel.id), duel);
  assert.throws(() => f.duels.invite(binding, 'c', 'b', f.now()), /pending/i);
  for (const invalid of [0, 7, 1.5, NaN, Promise.resolve(2)]) {
    assert.throws(() => f.duels.resolve('g', duel.id, 'b', f.now(), () => invalid), /roll/i);
    assert.deepEqual(f.duels.get('g', duel.id), duel);
  }
  assert.equal(f.duels.resolve('g', duel.id, 'b', f.now(), () => 5).challengerRoll, 5);
});

test('a pending transition is claimed before RNG and recursive accept cannot draw again', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  let calls = 0;
  const saved = f.duels.resolve('g', duel.id, 'b', f.now(), () => {
    calls++;
    assert.equal(f.duels.get('g', duel.id).status, 'resolved');
    assert.throws(() => f.duels.resolve('g', duel.id, 'b', f.now(), () => assert.fail('recursive draw')), /changed|unavailable/i);
    return 4;
  });
  assert.equal(calls, 2);
  assert.deepEqual([saved.challengerRoll, saved.opponentRoll], [4, 4]);
});

for (const [method, actor] of [['decline', 'b'], ['cancel', 'a']]) {
  test(`${method} after deadline persists expiry rather than late consent state`, t => {
    const f = fixture(t);
    const duel = f.duels.invite(binding, 'a', 'b', f.now());
    const saved = f.duels[method]('g', duel.id, actor, duel.expiresAt);
    assert.equal(saved.status, 'expired');
    assert.equal(saved.resolvedAt, duel.expiresAt);
    assert.equal(f.duels.invite(binding, 'c', 'a', duel.expiresAt).status, 'pending');
    assert.equal(f.duels.invite(binding, 'd', 'b', duel.expiresAt).status, 'pending');
  });
}

test('production RNG persists valid D6 values and a non-tie cannot create a rematch', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  const saved = f.duels.resolve('g', duel.id, 'b', f.now());
  for (const value of [saved.challengerRoll, saved.opponentRoll]) {
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 6);
  }
  const other = f.duels.invite(binding, 'c', 'd', f.now());
  const rolls = [1, 6];
  f.duels.resolve('g', other.id, 'd', f.now(), () => rolls.shift());
  assert.throws(() => f.duels.invite(binding, 'd', 'c', f.now(), other.id), /tie/i);
});

test('message binding is guild/revision scoped and cannot move to another message', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  f.duels.bindMessage('g', duel.id, 1, 'm');
  f.duels.bindMessage('g', duel.id, 1, 'm');
  assert.equal(f.duels.get('g', duel.id).messageId, 'm');
  assert.throws(() => f.duels.bindMessage('g', duel.id, 1, 'forged'), /changed|bound/i);
  assert.throws(() => f.duels.bindMessage('g', duel.id, 0, 'm'), /changed|unavailable/i);
  const saved = f.duels.resolve('g', duel.id, 'b', f.now(), () => 2);
  assert.equal(saved.messageId, 'm');
  assert.throws(() => f.duels.bindMessage('g', duel.id, 1, 'm'), /changed|unavailable/i);
});

test('tie rematches are fresh consent-based invitations restricted to the original pair', t => {
  const f = fixture(t);
  const original = f.duels.invite(binding, 'a', 'b', f.now());
  assert.throws(() => f.duels.invite(binding, 'b', 'a', f.now(), original.id), /tie|resolved/i);
  f.duels.resolve('g', original.id, 'b', f.now(), () => 4);
  assert.throws(() => f.duels.invite(binding, 'c', 'a', f.now(), original.id), /participant|pair/i);
  assert.throws(() => f.duels.invite({ ...binding, guildId: 'other' }, 'b', 'a', f.now(), original.id), /unavailable|tie/i);
  const rematch = f.duels.invite(binding, 'b', 'a', f.now(), original.id);
  assert.equal(rematch.rematchOf, original.id);
  assert.equal(rematch.status, 'pending');
  assert.equal(rematch.challengerRoll, null);
  assert.throws(() => f.duels.invite(binding, 'b', 'a', f.now(), original.id), /pending/i);
  assert.throws(() => f.duels.resolve('g', rematch.id, 'b', f.now()), /opponent/i);
  assert.equal(f.duels.resolve('g', rematch.id, 'a', f.now(), () => 1).status, 'resolved');
});

test('savepoints compose with outer rollback without leaving cooldowns or slots', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    const store = new CommunityStore(sql);
    sql.exec('BEGIN');
    const duel = store.duels.invite(binding, 'a', 'b', 0);
    sql.exec('ROLLBACK');
    assert.equal(store.duels.get('g', duel.id), null);
    assert.equal(store.duels.invite(binding, 'a', 'b', 0).status, 'pending');
  } finally { sql.close(); }
});

test('reopening preserves pending slots, cooldowns, bindings and outcomes without another draw', () => {
  const directory = mkdtempSync(join(tmpdir(), 'community-duel-'));
  const path = join(directory, 'duels.db');
  let sql = new DatabaseSync(path);
  try {
    CommunityStore.initialize(sql);
    let store = new CommunityStore(sql);
    const duel = store.duels.invite(binding, 'a', 'b', 0);
    store.duels.bindMessage('g', duel.id, 1, 'm');
    const pending = store.duels.invite(binding, 'c', 'd', 0);
    const saved = store.duels.resolve('g', duel.id, 'b', 10, () => 6);
    sql.close();
    sql = new DatabaseSync(path);
    CommunityStore.initialize(sql);
    store = new CommunityStore(sql);
    assert.deepEqual(store.duels.resolve('g', duel.id, 'b', 20, () => assert.fail('restart draw')), saved);
    assert.throws(() => store.duels.invite(binding, 'a', 'b', 29_999), /cooldown|30 seconds/i);
    assert.throws(() => store.duels.invite(binding, 'e', 'd', 30_000), /pending/i);
    assert.equal(store.duels.get('g', pending.id).status, 'pending');
  } finally {
    sql.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('member cleanup removes pending duels and both slots but retains saved results and unrelated servers', t => {
  const f = fixture(t);
  const pending = f.duels.invite(binding, 'a', 'b', f.now());
  const other = f.duels.invite({ ...binding, guildId: 'other' }, 'a', 'b', f.now());
  const resolved = f.duels.invite(binding, 'c', 'd', f.now());
  f.duels.resolve('g', resolved.id, 'd', f.now(), () => 2);
  f.db.community.purgeMember('g', 'a');
  assert.equal(f.duels.get('g', pending.id), null);
  assert.equal(f.duels.get('other', other.id).status, 'pending');
  assert.equal(f.duels.invite(binding, 'a', 'b', f.now()).status, 'pending');
  f.db.community.purgeMember('g', 'd');
  assert.equal(f.duels.get('g', resolved.id).status, 'resolved');
  f.db.community.purgeGuild('g');
  assert.equal(f.duels.get('g', resolved.id), null);
  assert.equal(f.duels.invite(binding, 'a', 'b', f.now()).status, 'pending');
  assert.equal(f.duels.get('other', other.id).status, 'pending');
});

test('account and identity cleanup preserve account-independent invitations', t => {
  const f = fixture(t);
  const duel = f.duels.invite(binding, 'a', 'b', f.now());
  f.db.community.purgeIdentity('a');
  f.db.community.purgeAccount('account');
  f.db.community.clearGameEvidence('g');
  assert.deepEqual(f.duels.get('g', duel.id), duel);
});

test('all terminal statuses retain thirty days from their actual terminal instant', t => {
  const f = fixture(t);
  for (const [method, actor, a, b] of [['resolve', 'b', 'a', 'b'], ['decline', 'd', 'c', 'd'], ['cancel', 'e', 'e', 'f']]) {
    const duel = f.duels.invite(binding, a, b, f.now());
    const saved = f.duels[method]('g', duel.id, actor, f.now() + 1000, () => 2);
    f.db.community.prune(saved.resolvedAt + 30 * day);
    assert.ok(f.duels.get('g', saved.id));
    f.db.community.prune(saved.resolvedAt + 30 * day + 1);
    assert.equal(f.duels.get('g', saved.id), null);
  }
  const expired = f.duels.invite(binding, 'h', 'i', f.now());
  const saved = f.duels.expire(expired.expiresAt + day)[0];
  assert.equal(saved.resolvedAt, expired.expiresAt);
  f.db.community.prune(saved.resolvedAt + 30 * day);
  assert.ok(f.duels.get('g', saved.id));
  f.db.community.prune(saved.resolvedAt + 30 * day + 1);
  assert.equal(f.duels.get('g', saved.id), null);
  const pending = f.duels.invite(binding, 'j', 'k', f.now());
  f.db.community.prune(f.now() + 90 * day);
  assert.equal(f.duels.get('g', pending.id).status, 'pending');
});

test('expiry and stale cooldown/terminal pruning drain bounded indexed batches', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    const store = new CommunityStore(sql);
    const ids = [];
    for (let n = 0; n < 451; n++) ids.push(store.duels.invite(binding, `a${n}`, `b${n}`, 0).id);
    assert.deepEqual([store.duels.expire(120_000).length, store.duels.expire(120_000).length, store.duels.expire(120_000).length], [200, 200, 51]);
    const count = table => Number(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
    const remaining = [];
    const cooldowns = [];
    for (let n = 0; n < 3; n++) {
      store.prune(120_001 + 30 * day);
      remaining.push(ids.filter(id => store.duels.get('g', id)).length);
      cooldowns.push(count('community_duel_cooldowns'));
    }
    assert.deepEqual(remaining, [251, 51, 0]);
    assert.deepEqual(cooldowns, [251, 51, 0]);
    assert.equal(count('community_duel_participants'), 0);
    for (const query of [
      "SELECT id FROM community_duels WHERE status='pending' AND expires_at<=120000 ORDER BY expires_at,id LIMIT 200",
      "SELECT id FROM community_duels WHERE status!='pending' AND resolved_at<120000 ORDER BY resolved_at,id LIMIT 200",
      'SELECT rowid FROM community_duel_cooldowns WHERE available_at<=120000 ORDER BY available_at LIMIT 200',
    ]) {
      const detail = sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all().map(row => row.detail).join(' ');
      assert.match(detail, /USING INDEX|USING COVERING INDEX/);
      assert.doesNotMatch(detail, /TEMP B-TREE/);
    }
  } finally { sql.close(); }
});
