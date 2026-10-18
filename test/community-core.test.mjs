import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { communityFixture } from './helpers/community.mjs';
const { BotDatabase } = await import('../dist/db.js');
const { withCommunityTransaction } = await import('../dist/community/transactions.js');
const { CommunitySessions } = await import('../dist/community/sessions.js');
const { CommunityStore } = await import('../dist/community/store.js');
const input = (now, extra = {}) => ({ key: 'same', guildId: 'g', channelId: 'c', kind: 'test', subjectId: 's', revision: 1, dueAt: now, part: 0, ...extra });

test('delivery keys deduplicate and claims have a five-minute lease', async () => {
  const f = communityFixture();
  try {
    const job = input(f.now());
    assert.equal(f.db.community.deliveries.enqueue(job).id, f.db.community.deliveries.enqueue(job).id);
    assert.equal(f.db.community.deliveries.claim(f.now(), 1)[0].leaseUntil, f.now() + 300_000);
  } finally { await f.close(); }
});

test('reopening a database preserves community jobs and existing links and clans', () => {
  const directory = mkdtempSync(join(tmpdir(), 'community-core-')), file = join(directory, 'bot.db');
  let db;
  try {
    db = new BotDatabase(file);
    db.linkUser('u', 'a', 'Alice', 'identity_token');
    db.setGuildClanConfig({ guild_id: 'g', clan_tag: 'TEST', member_role_id: 'm', officer_role_id: null, leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
    const job = db.community.deliveries.enqueue(input(1));
    db.close(); db = new BotDatabase(file);
    assert.equal(db.community.deliveries.list('g')[0].id, job.id);
    assert.equal(db.community.deliveries.list('g')[0].status, 'pending');
    assert.equal(db.getUserByDiscordId('u').openfront_id, 'a');
    assert.equal(db.getGuildConfigs('g')[0].clan_tag, 'TEST');
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('community savepoints compose with outer transactions and roll back failed actions', () => {
  const sql = new DatabaseSync(':memory:'); CommunityStore.initialize(sql);
  const store = new CommunityStore(sql);
  try {
    sql.exec('BEGIN'); store.deliveries.enqueue(input(1)); sql.exec('ROLLBACK');
    assert.deepEqual(store.deliveries.list('g'), []);
    assert.throws(() => withCommunityTransaction(sql, () => { store.deliveries.enqueue(input(1)); throw new Error('abort'); }), /abort/);
    assert.deepEqual(store.deliveries.list('g'), []);
    withCommunityTransaction(sql, () => withCommunityTransaction(sql, () => store.deliveries.enqueue(input(1))));
    assert.equal(store.deliveries.list('g').length, 1);
  } finally { sql.close(); }
});

test('stale leases cannot finish, fail, or overwrite a newer claim', async () => {
  const f = communityFixture();
  try {
    const d = f.db.community.deliveries; d.enqueue(input(f.now()));
    const first = d.claim(f.now(), 1)[0]; f.advance(300_000);
    const second = d.claim(f.now(), 1)[0];
    assert.notEqual(first.leaseId, second.leaseId);
    assert.equal(d.finish(first.id, first.leaseId, 'old'), false);
    d.fail(first.id, first.leaseId, 'paused', 'old', f.now());
    assert.equal(d.finish(second.id, second.leaseId, 'new'), true);
    assert.equal(d.list('g')[0].messageId, 'new');
  } finally { await f.close(); }
});

test('settings use exact decimal thresholds and reject stale revisions and invalid thresholds', async () => {
  const f = communityFixture();
  try {
    const s = f.db.community.settings;
    assert.deepEqual(s.get('g'), { guildId: 'g', revision: 0, milestonesEnabled: false, milestoneChannelId: null, gameThresholds: ['10','50','100','250','500'], winThresholds: ['1','10','25','50','100'] });
    const draft = { milestonesEnabled: true, milestoneChannelId: 'c', gameThresholds: ['10', '9007199254740993'], winThresholds: ['1'] };
    assert.equal(s.save('g', draft, 0).revision, 1);
    assert.throws(() => s.save('g', draft, 0), /changed|reopen/i);
    for (const gameThresholds of [['2','1'], ['1','1'], ['0'], ['1.5']]) assert.throws(() => s.save('g', { ...draft, gameThresholds }, 1), /threshold/i);
    assert.equal(s.list()[0].gameThresholds[1], '9007199254740993');
  } finally { await f.close(); }
});

test('private sessions enforce owner, binding, expiry, and a shared 200-session bound', () => {
  const sessions = new CommunitySessions(), binding = { guildId: 'g', channelId: 'c', messageId: 'm' };
  const create = () => sessions.create({ ...binding, kind: 'test', ownerId: 'u', data: { value: 1 } }, 0);
  const first = create(); sessions.bind(first.id, 'm');
  assert.equal(sessions.get(first.id, 'u', binding, 599999).data.value, 1);
  for (const [owner, target] of [['v', binding], ['u', { ...binding, guildId: 'other' }], ['u', { ...binding, channelId: 'other' }], ['u', { ...binding, messageId: 'other' }]]) assert.throws(() => sessions.get(first.id, owner, target, 0), /reopen/i);
  assert.throws(() => sessions.get(first.id, 'u', binding, 600000), /reopen/i);
  const oldest = create(); for (let n = 0; n < 200; n++) create();
  assert.throws(() => sessions.get(oldest.id, 'u', binding, 0), /reopen/i);
  const last = create(); sessions.delete(last.id);
  assert.throws(() => sessions.get(last.id, 'u', binding, 0), /reopen/i);
});

test('retry is guild and revision scoped and cancelled jobs cannot be revived', async () => {
  const f = communityFixture();
  try {
    const d = f.db.community.deliveries, job = d.enqueue(input(f.now()));
    const claim = d.claim(f.now(),1)[0]; d.fail(job.id, claim.leaseId, 'paused', 'Missing permission', f.now());
    assert.throws(() => d.retry('other',job.id,1,f.now()), /changed|unavailable/i);
    assert.throws(() => d.retry('g',job.id,2,f.now()), /changed|unavailable/i);
    d.retry('g',job.id,1,f.now()); assert.equal(d.list('g')[0].status,'pending');
    d.cancelSubject('g','test','s');
    assert.throws(() => d.retry('g',job.id,1,f.now()), /changed|unavailable/i);
  } finally { await f.close(); }
});

test('guild purge removes settings/jobs and pruning keeps active work but expires terminal diagnostics', async () => {
  const f = communityFixture();
  try {
    const d = f.db.community.deliveries;
    d.enqueue(input(f.now())); let job = d.claim(f.now(),1)[0]; d.finish(job.id,job.leaseId,'m');
    d.enqueue(input(f.now(),{ key: 'active' }));
    f.advance(30*86400000+1); f.db.community.prune(f.now());
    assert.deepEqual(d.list('g').map(j => j.key),['active']);
    f.db.community.settings.save('g',f.db.community.settings.get('g'),0);
    f.db.community.purgeGuild('g');
    assert.deepEqual(d.list('g'),[]); assert.equal(f.db.community.settings.get('g').revision,0);
  } finally { await f.close(); }
});

test('history deletion and privacy clears call community cleanup, preserving standalone HistoryStore use', async (t) => {
  const f = communityFixture(), calls = [];
  try {
    t.mock.method(f.db.community,'purgeAccount',id => calls.push(['account',id]));
    t.mock.method(f.db.community,'clearGameEvidence',guild => calls.push(['games',guild]));
    f.db.history.purgePlayer('a'); f.db.history.clearGuildPlayerMatches('g'); f.db.history.clearAllPlayerHistory();
    assert.deepEqual(calls,[['account','a'],['games','g'],['games',undefined]]);
  } finally { await f.close(); }
});

test('identity mutations preserve same-account records but invalidate lookup timestamps and purge replacements', async (t) => {
  const f = communityFixture(), calls = [];
  try {
    t.mock.method(f.db.community,'purgeIdentity',(...args) => calls.push(args));
    f.db.linkUser('u','a','A','identity_token'); const old = f.db.getUserByDiscordId('u').linked_at;
    f.db.linkUser('u','a','A','identity_token');
    assert.notEqual(f.db.getUserByDiscordId('u').linked_at,old);
    assert.equal(calls.length,0);
    f.db.linkUser('u','b','B','identity_token'); f.db.unlinkUser('u');
    assert.deepEqual(calls,[['u'],['u']]);
    f.db.linkGuildUser('g','officer','u','a','A'); f.db.linkGuildUser('g','officer','u','b','B'); f.db.unlinkGuildUser('g','officer','u');
    assert.deepEqual(calls.slice(2),[['u','g'],['u','g']]);
  } finally { await f.close(); }
});

test('unlink and relink in one clock millisecond cannot restore a stale identity binding', async (t) => {
  const f=communityFixture();
  try {
    t.mock.method(Date,'now',()=>1792324800000);
    f.db.linkUser('u','a','A','identity_token'); const first=f.db.getUserByDiscordId('u').linked_at;
    f.db.unlinkUser('u'); f.db.linkUser('u','a','A','identity_token');
    assert.notEqual(f.db.getUserByDiscordId('u').linked_at,first);
    f.db.linkGuildUser('g','officer','v','b','B'); const local=f.db.getGuildLink('g','v').linked_at;
    f.db.linkUser('v','b','B','identity_token');
    assert.notEqual(f.db.getEffectiveLink('g','v').linked_at,local);
  } finally {await f.close();}
});

test('cancelling an old pending job retains diagnostics for thirty days after cancellation',async()=>{
  const f=communityFixture();
  try {
    f.db.community.deliveries.enqueue(input(f.now()-90*86400000));
    f.db.community.deliveries.cancelSubject('g','test','s',f.now());f.db.community.prune(f.now());
    assert.equal(f.db.community.deliveries.list('g')[0]?.status,'cancelled');
    f.advance(30*86400000+1);f.db.community.prune(f.now());assert.deepEqual(f.db.community.deliveries.list('g'),[]);
  } finally {await f.close();}
});
