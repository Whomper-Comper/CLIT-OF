import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communityFixture } from './helpers/community.mjs';
import { CommunityStore } from '../dist/community/store.js';
import * as milestones from '../dist/community/milestones.js';

const thresholds = { games: ['10', '50'], wins: ['1'] };
const counters = (games, wins = 0n) => ({ games, wins, losses: games - wins });
const empty = () => ({ counters: null, initialized: new Set(), earned: new Set() });
const binding = (db, guildId = 'g', discordId = 'u') => {
  const link = db.getEffectiveLink(guildId, discordId);
  return { guildId, discordId, publicId: link.openfront_id, linkedAt: link.linked_at };
};
const enable = (db) => db.community.settings.save('g', {
  milestonesEnabled: true, milestoneChannelId: 'c',
  gameThresholds: thresholds.games, winThresholds: thresholds.wins,
}, 0);

// Replacing exact BigInt comparisons with Number would round this boundary.
test('large thresholds stay exact and first observations stay quiet', () => {
  const configured = { games: ['9007199254740993'], wins: ['1'] };
  const first = milestones.evaluateMilestones(empty(), counters(9007199254740993n, 1n), configured);
  assert.deepEqual(first.awards, [
    { metric: 'games', threshold: '9007199254740993', total: '9007199254740993', announce: false },
    { metric: 'wins', threshold: '1', total: '1', announce: false },
  ]);
  assert.equal(milestones.evaluateMilestones(empty(), counters(9007199254740992n), configured).awards.length, 0);
});

test('initialized crossings award every crossed threshold and never repeat after decreases', () => {
  const state = { counters: counters(9n), initialized: new Set(['games:10', 'games:50', 'wins:1']), earned: new Set() };
  const next = milestones.evaluateMilestones(state, counters(51n, 1n), thresholds);
  assert.deepEqual(next.awards.map(a => [a.metric, a.threshold, a.announce]), [
    ['games', '10', true], ['games', '50', true], ['wins', '1', true],
  ]);
  state.earned = new Set(['games:10', 'games:50', 'wins:1']);
  state.counters = counters(2n);
  assert.deepEqual(milestones.evaluateMilestones(state, counters(99n, 5n), thresholds).awards, []);
});

test('new thresholds silently initialize against existing observations without mutating state', () => {
  const state = { counters: counters(9n), initialized: new Set(['games:10']), earned: new Set() };
  const result = milestones.evaluateMilestones(state, counters(51n), { games: ['10', '20'], wins: ['1'] });
  assert.deepEqual(result.awards.map(a => [a.threshold, a.announce]), [['10', true], ['20', false]]);
  assert.deepEqual(result.initialized, ['games:20', 'wins:1']);
  assert.deepEqual([...state.initialized], ['games:10']);
});

test('threshold validation rejects noncanonical, duplicate, descending and excessive decimals', () => {
  for (const games of [['0'], ['01'], ['1.0'], ['1e3'], ['-1'], ['1', '1'], ['10', '9'], Array.from({ length: 11 }, (_, i) => String(i + 1))]) {
    assert.throws(() => milestones.validateMilestoneThresholds({ games, wins: ['1'] }));
  }
  assert.deepEqual(milestones.validateMilestoneThresholds(thresholds), thresholds);
});

test('public Team counters reject partial, inconsistent and unrelated scopes without rounding', () => {
  const stats = { Public: { Team: { Easy: { total: '9007199254740993', wins: '1', losses: '9007199254740992' } } } };
  assert.deepEqual(milestones.readMilestoneCounters(stats), counters(9007199254740993n, 1n));
  for (const value of [null, {}, { Private: stats.Public }, { Public: { 'Free For All': stats.Public.Team } },
    { Public: { Team: { Easy: { total: '10', wins: '2' } } } },
    { Public: { Team: { Easy: { total: '10', wins: '9', losses: '2' } } } },
    { Public: { Team: { Easy: { total: '10', wins: '-1', losses: '2' } } } },
    { Public: { Team: { Easy: { total: '10', wins: '1', losses: '-2' } } } },
    { Public: { Team: { Easy: { total: '-10', wins: '1', losses: '2' } } } },
    { Public: { Team: { Easy: { total: 9007199254740993, wins: 1, losses: 2 } } } },
    { Public: { Team: { Easy: { total: '10', wins: '11', losses: '0' }, Hard: { total: '10', wins: '0', losses: '9' } } } },
    { Public: { Team: { Easy: { total: '10', wins: '1', losses: '9' }, Hard: {} } } },
  ]) assert.equal(milestones.readMilestoneCounters(value), null);
});

test('observations atomically persist unique awards and one combined durable delivery intent', async () => {
  const f = communityFixture();
  try {
    f.db.linkUser('u', 'p', null, 'identity_token');
    enable(f.db);
    const store = f.db.community.milestones;
    const b = binding(f.db);
    store.observe(b, counters(9n), thresholds, 1000);
    assert.equal(f.db.community.deliveries.list('g').length, 0);
    const result = store.observe(b, counters(51n, 1n), thresholds, 2000);
    assert.equal(result.awards.length, 3);
    store.observe(b, counters(51n, 1n), thresholds, 2001);
    store.observe(b, counters(2n), thresholds, 2002);
    store.observe(b, counters(100n, 2n), thresholds, 2003);
    assert.equal(store.listAwards('g', 'p').length, 3);
    const jobs = f.db.community.deliveries.list('g');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'milestone');
    const intent = store.getIntent(jobs[0].subjectId);
    assert.equal(intent.binding.publicId, 'p');
    assert.equal(intent.observedAt, 2000);
    assert.equal(intent.awards.length, 3);
  } finally { await f.close(); }
});

test('silent earned baselines and exact counters survive SQLite reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'milestones-'));
  const file = join(directory, 'state.sqlite');
  let sql;
  try {
    sql = new DatabaseSync(file);
    CommunityStore.initialize(sql);
    let store = new CommunityStore(sql);
    const b = { guildId: 'g', discordId: 'u', publicId: 'p', linkedAt: 'v1' };
    store.milestones.syncCandidates('g', [b], 1);
    const generation = store.milestones.candidateGeneration(b);
    store.milestones.observe(b, counters(9007199254740993n, 1n), thresholds, 1);
    sql.close();
    sql = new DatabaseSync(file);
    store = new CommunityStore(sql);
    assert.equal(store.milestones.getState('g', 'p').counters.games, 9007199254740993n);
    assert.equal(store.milestones.listAwards('g', 'p').length, 3);
    assert.deepEqual(store.milestones.observe(b, counters(9007199254740994n, 1n), thresholds, 2).awards, []);
    store.purgeIdentity('u');
    assert.equal(store.milestones.getState('g', 'p').counters, null);
    assert.throws(() => store.milestones.observe(b, counters(20n), thresholds, 3, generation));
    store.purgeGuild('g');
  } finally {
    sql?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('same-account reverify preserves awards but rejects stale responses and unlink purges only personal scope', async () => {
  const f = communityFixture();
  try {
    f.db.linkUser('u', 'p', null, 'identity_token');
    f.db.linkUser('v', 'q', null, 'identity_token');
    const store = f.db.community.milestones;
    const old = binding(f.db);
    store.observe(old, counters(20n), thresholds, 1);
    store.observe(binding(f.db, 'h'), counters(20n), thresholds, 1);
    store.observe(binding(f.db, 'g', 'v'), counters(20n), thresholds, 1);
    f.db.linkUser('u', 'p', null, 'identity_token');
    assert.equal(store.listAwards('g', 'p').length, 1);
    assert.throws(() => store.observe(old, counters(60n), thresholds, 2));
    store.observe(binding(f.db), counters(21n), thresholds, 2);
    f.db.unlinkUser('u');
    assert.equal(store.listAwards('g', 'p').length, 0);
    assert.equal(store.listAwards('h', 'p').length, 0);
    assert.equal(store.listAwards('g', 'q').length, 1);
    assert.throws(() => store.observe(old, counters(60n), thresholds, 3));
    f.db.linkUser('u', 'r', null, 'identity_token');
    assert.ok(store.observe(binding(f.db), counters(60n), thresholds, 4).awards.every(a => !a.announce));
  } finally { await f.close(); }
});

test('member, account and guild cleanup remove intents and invalidate stale observations', async () => {
  const f = communityFixture();
  try {
    f.db.linkUser('u', 'p', null, 'identity_token');
    enable(f.db);
    const store = f.db.community.milestones;
    const b = binding(f.db);
    store.syncCandidates('g', [b], 1);
    const generation = store.candidateGeneration(b);
    store.observe(b, counters(9n), thresholds, 1);
    store.observe(b, counters(60n), thresholds, 2);
    f.db.community.purgeMember('g', 'u');
    assert.equal(store.listAwards('g', 'p').length, 0);
    assert.equal(f.db.community.deliveries.list('g').length, 0);
    assert.throws(() => store.observe(b, counters(60n), thresholds, 3, generation));
    store.syncCandidates('g', [b], 4);
    assert.throws(() => store.observe(b, counters(60n), thresholds, 4, generation));
    const freshGeneration = store.candidateGeneration(b);
    assert.ok(store.observe(b, counters(60n), thresholds, 4, freshGeneration).awards.every(a => !a.announce));
    f.db.history.purgePlayer('p');
    assert.throws(() => store.observe(b, counters(61n), thresholds, 5));
    assert.deepEqual(store.dueMembers('g', 10000000, 10), []);
    f.db.community.purgeGuild('g');
    assert.equal(store.getState('g', 'p').counters, null);
  } finally { await f.close(); }
});

test('guild candidate polling persists attempts, fair backoff and never-observed members', async () => {
  const f = communityFixture();
  try {
    for (const id of ['u', 'v', 'w']) f.db.linkUser(id, id + '-account', null, 'identity_token');
    const store = f.db.community.milestones;
    const u = binding(f.db), v = binding(f.db, 'g', 'v'), w = binding(f.db, 'h', 'w');
    store.syncCandidates('g', [u, v], 1000);
    store.syncCandidates('h', [w], 1000);
    assert.deepEqual(store.dueMembers('g', 1000, 1), ['u']);
    assert.equal(store.markAttempt(u, 1000), true);
    assert.equal(store.markAttempt(u, 1000), false);
    assert.deepEqual(store.dueMembers('g', 1000, 10), ['v']);
    assert.equal(store.markAttempt(v, 1000), true);
    assert.deepEqual(store.dueMembers('g', 900999, 10), []);
    assert.deepEqual(store.dueMembers('g', 901000, 10), ['u', 'v']);
    assert.equal(store.markAttempt(u, 901000), true);
    assert.deepEqual(store.dueMembers('g', 1801000, 10), ['v']);
    store.observe(u, counters(2n), thresholds, 901001);
    assert.ok(store.dueMembers('g', 1801001, 10).includes('u'));
    store.syncCandidates('g', [u], 1801002);
    assert.ok(!store.dueMembers('g', 9999999, 10).includes('v'));
    assert.deepEqual(store.dueMembers('h', 1000, 10), ['w']);
  } finally { await f.close(); }
});

// Losing the transaction boundary would retain awards after an intent insert fails.
test('failed intent persistence rolls back counters, awards and due scheduling', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    const community = new CommunityStore(sql);
    const b = { guildId: 'g', discordId: 'u', publicId: 'p', linkedAt: 'v1' };
    community.settings.save('g', {
      milestonesEnabled: true, milestoneChannelId: 'c', gameThresholds: ['10', '50'], winThresholds: ['1'],
    }, 0);
    community.milestones.syncCandidates('g', [b], 1);
    community.milestones.observe(b, counters(9n), thresholds, 1);
    sql.exec(`CREATE TRIGGER reject_intent BEFORE INSERT ON community_milestone_intents
      BEGIN SELECT RAISE(ABORT, 'intent unavailable'); END`);
    assert.throws(() => community.milestones.observe(b, counters(51n), thresholds, 2), /intent unavailable/);
    assert.equal(community.milestones.getState('g', 'p').counters.games, 9n);
    assert.equal(community.milestones.listAwards('g', 'p').length, 0);
    assert.equal(community.deliveries.list('g').length, 0);
    assert.deepEqual(community.milestones.dueMembers('g', 900001, 1), ['u']);
  } finally { sql.close(); }
});

test('captured settings revision rejects disable and threshold edits during a fetch', async () => {
  const f = communityFixture();
  try {
    f.db.linkUser('u', 'p', null, 'identity_token');
    const initial = enable(f.db);
    const b = binding(f.db);
    const store = f.db.community.milestones;
    store.syncCandidates('g', [b], 1);
    const generation = store.candidateGeneration(b);
    store.observe(b, counters(9n), thresholds, 1, generation, initial.revision);
    f.db.community.settings.save('g', {
      milestonesEnabled: false, milestoneChannelId: 'c', gameThresholds: ['20'], winThresholds: ['1'],
    }, initial.revision);
    assert.throws(() => store.observe(b, counters(51n), thresholds, 2, generation, initial.revision));
    assert.equal(store.listAwards('g', 'p').length, 0);
    assert.equal(store.getState('g', 'p').counters.games, 9n);
    assert.equal(f.db.community.deliveries.list('g').length, 0);
  } finally { await f.close(); }
});

test('effective local account replacement and scoped cleanup preserve unrelated guilds', async () => {
  const f = communityFixture();
  try {
    f.db.linkGuildUser('g', 'officer', 'u', 'old', null);
    f.db.linkGuildUser('h', 'officer', 'u', 'other', null);
    const store = f.db.community.milestones;
    const old = binding(f.db);
    store.observe(old, counters(20n), thresholds, 1);
    store.observe(binding(f.db, 'h'), counters(20n), thresholds, 1);
    f.db.linkGuildUser('g', 'officer', 'u', 'new', null);
    assert.equal(store.listAwards('g', 'old').length, 0);
    assert.equal(store.listAwards('h', 'other').length, 1);
    assert.throws(() => store.observe(old, counters(60n), thresholds, 2));
    assert.ok(store.observe(binding(f.db), counters(60n), thresholds, 2).awards.every(a => !a.announce));
    f.db.community.purgeGuild('g');
    assert.equal(store.listAwards('g', 'new').length, 0);
    assert.equal(store.listAwards('h', 'other').length, 1);
    f.db.history.purgePlayer('other');
    assert.equal(store.listAwards('h', 'other').length, 0);
  } finally { await f.close(); }
});

test('candidate attempt backoff survives reopening and uses a guild due index', () => {
  const directory = mkdtempSync(join(tmpdir(), 'milestone-attempts-'));
  const file = join(directory, 'state.sqlite');
  let sql;
  try {
    sql = new DatabaseSync(file);
    CommunityStore.initialize(sql);
    let store = new CommunityStore(sql).milestones;
    const b = { guildId: 'g', discordId: 'u', publicId: 'p', linkedAt: 'v1' };
    store.syncCandidates('g', [b], 1);
    assert.equal(store.markAttempt(b, 1), true);
    sql.close();
    sql = new DatabaseSync(file);
    store = new CommunityStore(sql).milestones;
    assert.deepEqual(store.dueMembers('g', 900000, 1), []);
    assert.equal(store.markAttempt(b, 900001), true);
    assert.deepEqual(store.dueMembers('g', 1800001, 1), []);
    assert.deepEqual(store.dueMembers('g', 2700001, 1), ['u']);
    const plan = sql.prepare(`EXPLAIN QUERY PLAN SELECT discord_id FROM community_milestone_candidates
      WHERE guild_id=? AND next_attempt<=? ORDER BY next_attempt,discord_id LIMIT ?`).all('g', 2700001, 1);
    assert.ok(plan.some(row => /SEARCH.*community_milestone_due/.test(String(row.detail))));
    assert.ok(plan.every(row => !/SCAN|TEMP B-TREE/.test(String(row.detail))));
  } finally {
    sql?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retired intent payloads are pruned with completed delivery diagnostics', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    const community = new CommunityStore(sql);
    const b = { guildId: 'g', discordId: 'u', publicId: 'p', linkedAt: 'v1' };
    community.settings.save('g', {
      milestonesEnabled: true, milestoneChannelId: 'c', gameThresholds: ['10', '50'], winThresholds: ['1'],
    }, 0);
    community.milestones.observe(b, counters(9n), thresholds, 1);
    community.milestones.observe(b, counters(51n), thresholds, 2);
    const [job] = community.deliveries.claim(3, 1);
    community.deliveries.finish(job.id, job.leaseId, 'message', 3);
    community.prune(31 * 86400000);
    assert.equal(community.milestones.getIntent(job.subjectId), null);
    assert.equal(community.milestones.listAwards('g', 'p').length, 2);
  } finally { sql.close(); }
});

test('adding a polling inventory respects a recent on-demand observation', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    CommunityStore.initialize(sql);
    const store = new CommunityStore(sql).milestones;
    const b = { guildId: 'g', discordId: 'u', publicId: 'p', linkedAt: 'v1' };
    store.observe(b, counters(9n), thresholds, 1000);
    store.syncCandidates('g', [b], 2000);
    assert.deepEqual(store.dueMembers('g', 900999, 1), []);
    assert.deepEqual(store.dueMembers('g', 901000, 1), ['u']);
  } finally { sql.close(); }
});

test('private observation tokens work without enabled polling and preserve another candidate backoff', async () => {
  const f = communityFixture();
  try {
    f.db.linkUser('u', 'p', null, 'identity_token');
    f.db.linkUser('v', 'q', null, 'identity_token');
    const store = f.db.community.milestones;
    const u = binding(f.db), v = binding(f.db, 'g', 'v');
    store.syncCandidates('g', [v], 1000);
    const vGeneration = store.candidateGeneration(v);
    assert.equal(store.markAttempt(v, 1000, vGeneration), true);
    assert.equal(store.markAttempt(v, 901000, vGeneration), true);
    const generation = store.prepareObservation(u, 901001);
    assert.equal(store.markAttempt(u, 901001, generation), true);
    assert.equal(store.prepareObservation(u, 901002), generation);
    assert.equal(store.markAttempt(u, 901002, generation), false);
    assert.equal(store.candidateGeneration(v), vGeneration);
    assert.deepEqual(store.dueMembers('g', 1801000, 10), []);
    store.observe(u, counters(20n), thresholds, 901003, generation, 0);
    assert.equal(store.listAwards('g', 'p').length, 1);
    assert.equal(f.db.community.deliveries.list('g').length, 0);
    f.db.community.purgeMember('g', 'u');
    const freshGeneration = store.prepareObservation(u, 901004);
    assert.notEqual(freshGeneration, generation);
    assert.throws(() => store.observe(u, counters(60n), thresholds, 901005, generation, 0));
    assert.ok(store.observe(u, counters(60n), thresholds, 901005, freshGeneration, 0).awards.every(a => !a.announce));
    f.db.history.purgePlayer('p');
    assert.throws(() => store.prepareObservation(u, 901006));
  } finally { await f.close(); }
});

test('verified global promotion preserves matching local awards and purges replaced scopes', async () => {
  const f = communityFixture();
  try {
    f.db.linkGuildUser('g', 'officer', 'u', 'p', null);
    f.db.linkGuildUser('h', 'officer', 'u', 'old', null);
    f.db.linkUser('v', 'q', null, 'identity_token');
    const store = f.db.community.milestones;
    store.observe(binding(f.db), counters(20n), thresholds, 1);
    store.observe(binding(f.db, 'h'), counters(20n), thresholds, 1);
    store.observe(binding(f.db, 'g', 'v'), counters(20n), thresholds, 1);
    f.db.linkUser('u', 'p', null, 'identity_token');
    assert.equal(store.listAwards('g', 'p').length, 1);
    assert.equal(store.listAwards('h', 'old').length, 0);
    const previous = binding(f.db);
    f.db.linkUser('u', 'new', null, 'identity_token');
    assert.equal(store.listAwards('g', 'p').length, 0);
    assert.equal(store.listAwards('g', 'q').length, 1);
    assert.throws(() => store.observe(previous, counters(60n), thresholds, 2));
    assert.ok(store.observe(binding(f.db), counters(60n), thresholds, 2).awards.every(a => !a.announce));
  } finally { await f.close(); }
});

for (const scenario of [
  { name: 'empty games', configured: { games: [], wins: ['1'] }, earned: ['wins:1'] },
  { name: 'empty wins', configured: { games: ['10', '50'], wins: [] }, earned: ['games:10', 'games:50'] },
  { name: 'both metrics empty', configured: { games: [], wins: [] }, earned: [] },
]) {
  test(`threshold configuration accepts ${scenario.name} through pure evaluation and persisted settings`, async () => {
    assert.deepEqual(milestones.validateMilestoneThresholds(scenario.configured), scenario.configured);
    const evaluated = milestones.evaluateMilestones(empty(), counters(51n, 1n), scenario.configured);
    assert.deepEqual(evaluated.awards.map(award => `${award.metric}:${award.threshold}`), scenario.earned);
    assert.ok(evaluated.awards.every(award => !award.announce));
    const f = communityFixture();
    try {
      f.db.linkUser('u', 'p', null, 'identity_token');
      const saved = f.db.community.settings.save('g', {
        milestonesEnabled: true, milestoneChannelId: 'c',
        gameThresholds: scenario.configured.games, winThresholds: scenario.configured.wins,
      }, 0);
      assert.deepEqual(saved.gameThresholds, scenario.configured.games);
      assert.deepEqual(saved.winThresholds, scenario.configured.wins);
      const store = f.db.community.milestones;
      store.observe(binding(f.db), counters(9n), scenario.configured, 1);
      const crossing = store.observe(binding(f.db), counters(51n, 1n), scenario.configured, 2);
      assert.deepEqual(crossing.awards.map(award => `${award.metric}:${award.threshold}`), scenario.earned);
      assert.deepEqual([...store.getState('g', 'p').earned], scenario.earned);
      assert.equal(store.getState('g', 'p').counters.games, 51n);
      assert.equal(f.db.community.deliveries.list('g').length, scenario.earned.length ? 1 : 0);
    } finally { await f.close(); }
  });
}

for (const scenario of [
  {
    name: 'a single difficulty bucket',
    stats: { Public: { Team: { Easy: { total: '10', wins: '1', losses: '2' } } } },
    expected: { games: 10n, wins: 1n, losses: 2n },
    earned: ['games:10', 'wins:1'],
  },
  {
    name: 'multiple difficulty buckets with exact large aggregate totals',
    stats: { Public: { Team: {
      Easy: { total: '10', wins: '1', losses: '2' },
      Hard: { total: '9007199254740993', wins: '1', losses: '9007199254740990' },
    } } },
    expected: { games: 9007199254741003n, wins: 2n, losses: 9007199254740992n },
    earned: ['games:10', 'games:50', 'wins:1'],
  },
]) {
  test(`positive counter gaps remain available and award milestones for ${scenario.name}`, async () => {
    const current = milestones.readMilestoneCounters(scenario.stats);
    assert.deepEqual(current, scenario.expected);
    const f = communityFixture();
    try {
      f.db.linkUser('u', 'p', null, 'identity_token');
      enable(f.db);
      const store = f.db.community.milestones;
      store.observe(binding(f.db), { games: 9n, wins: 0n, losses: 2n }, thresholds, 1);
      const result = store.observe(binding(f.db), current, thresholds, 2);
      assert.deepEqual(result.awards.map(award => `${award.metric}:${award.threshold}`), scenario.earned);
      assert.ok(result.awards.every(award => award.announce));
      assert.deepEqual(store.getState('g', 'p').counters, scenario.expected);
      const [job] = f.db.community.deliveries.list('g');
      const intent = store.getIntent(job.subjectId);
      assert.deepEqual(intent.awards.map(award => `${award.metric}:${award.threshold}`), scenario.earned);
      assert.equal(intent.awards[0].total, String(scenario.expected.games));
      assert.throws(() => store.observe(binding(f.db), { games: 10n, wins: 9n, losses: 2n }, thresholds, 3));
      assert.deepEqual(store.getState('g', 'p').counters, scenario.expected);
    } finally { await f.close(); }
  });
}
