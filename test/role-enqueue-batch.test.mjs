import assert from 'node:assert/strict';
import { test } from 'node:test';
process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'test';
process.env.CLIENT_ID = 'test';
const { BotDatabase } = await import('../dist/db.js');

const config = (tag, changes = {}) => ({ guild_id:'g',clan_tag:tag,member_role_id:`member-${tag}`,
  officer_role_id:`officer-${tag}`,leader_role_id:null,join_role_id:null,log_channel_id:null,
  sync_interval_mins:10,last_sync_at:null,...changes });

function countWork(store, action) {
  const originalGet = store.getGuildConfigs;
  const originalPrepare = store.db.prepare;
  let inventories = 0, prepares = 0, queuePrepares = 0;
  const queueRuns = [];
  store.getGuildConfigs = function (...args) { inventories++; return originalGet.apply(this,args); };
  store.db.prepare = function (...args) {
    prepares++;
    if (/^\s*(SELECT role_ids FROM role_jobs|INSERT INTO role_jobs)/.test(args[0])) queuePrepares++;
    const statement = originalPrepare.apply(this,args);
    if (/^\s*INSERT INTO role_jobs/.test(args[0])) return { run(...parameters) {
      const result = statement.run(...parameters);
      queueRuns.push({ memberId: parameters[1], version: parameters[3] });
      return result;
    } };
    return statement;
  };
  try { action(); } finally { store.getGuildConfigs = originalGet; store.db.prepare = originalPrepare; }
  return { inventories, prepares, queuePrepares, queueRuns };
}

test('clan save reads one mapping inventory and reuses statements for a large affected roster', () => {
  const store = new BotDatabase(':memory:');
  try {
    for (let n=0;n<20;n++) store.setGuildClanConfig(config(`T${n}`));
    const ids = Array.from({length:1000}, (_,n) => `u${n}`);
    const work = countWork(store, () => store.setGuildClanConfig(config('T0', {member_role_id:'replacement'}),ids));
    assert.equal(work.inventories,1);
    assert.ok(work.prepares <= 5, `expected constant statement preparation, got ${work.prepares}`);
    assert.equal(store.getQueueSummary('g').pending,1000);
    for (const id of ['u0','u499','u999']) {
      const roles = JSON.parse(store.getJob('g',id).role_ids);
      assert.equal(roles.length,41);
      assert.ok(roles.includes('member-T0'));
      assert.ok(roles.includes('replacement'));
      assert.ok(roles.includes('officer-T19'));
    }
    assert.equal(store.getGuildClanConfig('g','T0').member_role_id,'replacement');
  } finally { store.close(); }
});

test('clan removal batches mapping reads and retains removed and per-member obsolete roles', () => {
  const store = new BotDatabase(':memory:');
  try {
    store.setGuildClanConfig(config('A'));
    store.setGuildClanConfig(config('B'));
    store.enqueueGuild('g','first',['obsolete'],10);
    const createdAt = Date.parse('2001-01-01T00:00:00.000Z');
    store.db.prepare("UPDATE role_jobs SET created_at=? WHERE guild_id='g' AND discord_id='first'").run(createdAt);
    const first = store.getJob('g','first');
    store.retryJob(first,'temporary error');
    store.enqueueGuild('other','first',['unrelated'],7);
    const unrelated = store.getJob('other','first');
    let removed;
    const work = countWork(store, () => { removed = store.deleteGuildClanConfig('g','A',['first','second','first']); });
    assert.equal(removed,true);
    assert.equal(work.inventories,1);
    assert.equal(work.queuePrepares,2);
    assert.deepEqual(work.queueRuns.map(run => run.memberId), ['first','second','first']);
    for (const run of work.queueRuns)
      assert.match(run.version, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(new Set(work.queueRuns.map(run => run.version)).size,3, 'each occurrence receives a fresh UUID');
    const updated = store.getJob('g','first');
    assert.equal(updated.version,work.queueRuns[2].version);
    assert.deepEqual(JSON.parse(updated.role_ids),['member-A','officer-A','member-B','officer-B','obsolete']);
    assert.equal(updated.priority,10);
    assert.equal(updated.created_at,first.created_at);
    assert.equal(updated.created_at,createdAt);
    assert.equal(updated.attempts,0);
    assert.equal(updated.available_at,0);
    assert.equal(updated.last_error,null);
    assert.notEqual(updated.version,first.version);
    assert.deepEqual(store.getJob('other','first'),unrelated);
    assert.deepEqual(JSON.parse(store.getJob('g','second').role_ids),['member-A','officer-A','member-B','officer-B']);
    assert.equal(store.getGuildClanConfig('g','A'),null);
    assert.equal(store.deleteGuildClanConfig('g','A',['third']),false);
    assert.equal(store.getJob('g','third'),null);
  } finally { store.close(); }
});

test('a failed batch rolls back mapping, earlier jobs and cleanup state atomically', () => {
  const store = new BotDatabase(':memory:');
  try {
    store.setGuildClanConfig(config('A'));
    store.enqueueGuild('g','first',['obsolete'],10);
    store.enqueueGuild('g','broken');
    store.db.prepare('INSERT INTO history_clan_matches VALUES(?,?,?,?,?)')
      .run('g','A','kept','2026-11-01T00:00:00.000Z',JSON.stringify({gameId:'kept'}));
    store.db.prepare("UPDATE role_jobs SET role_ids='invalid-json' WHERE guild_id='g' AND discord_id='broken'").run();
    const before = store.getJob('g','first');
    assert.throws(() => store.setGuildClanConfig(config('A',{member_role_id:'new'}),['first','broken']),SyntaxError);
    assert.equal(store.getGuildClanConfig('g','A').member_role_id,'member-A');
    assert.deepEqual(store.getJob('g','first'),before);
    assert.throws(() => store.deleteGuildClanConfig('g','A',['first','broken']),SyntaxError);
    assert.ok(store.getGuildClanConfig('g','A'));
    assert.deepEqual(store.getJob('g','first'),before);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM history_clan_matches').get().n,1);
  } finally { store.close(); }
});

test('empty affected rosters do no queue inventory work; singleton enqueue keeps priority and version guards', () => {
  const store = new BotDatabase(':memory:');
  try {
    assert.equal(countWork(store,() => store.setGuildClanConfig(config('A'))).inventories,0);
    store.enqueueGuild('g','u',['old'],10);
    const old = store.getJob('g','u');
    store.enqueueGuild('g','u',['new'],0);
    const current = store.getJob('g','u');
    assert.equal(current.priority,10);
    assert.deepEqual(JSON.parse(current.role_ids),['member-A','officer-A','new','old']);
    store.finishJob(old);
    assert.deepEqual(store.getJob('g','u'),current);
    store.finishJob(current);
    assert.equal(store.getJob('g','u'),null);
    assert.equal(countWork(store,() => store.deleteGuildClanConfig('g','A')).inventories,0);
  } finally { store.close(); }
});
