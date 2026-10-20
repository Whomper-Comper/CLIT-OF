import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { communityFixture } from './helpers/community.mjs';
import { defaultBingoObjectives } from '../dist/community/bingo.js';
import { CommunityService } from '../dist/community/service.js';
const worker = await import('../dist/community/bingoWorker.js').catch(() => ({}));
function setup(f, count = 0) {
  f.addMember('u'); f.db.linkUser('u', 'p', null, 'identity_token');
  f.db.setGuildClanConfig({ guild_id: 'g', clan_tag: 'MARS', member_role_id: 'member', officer_role_id: null,
    leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  const { guild_id, revision, ...draft } = f.db.history.getSettings('g');
  f.db.history.saveSettings('g', { ...draft, collection_enabled: 1 }, revision);
  f.db.history.setMeta('deletions_last_success', new Date(f.now()).toISOString());
  const s = f.db.community.bingo, b = s.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
  s.publish('g', b.id, b.revision, 'public');
  f.db.history.upsertPlayerMatches('g', 'p', 'u', Array.from({ length: count }, (_, n) => ({ public_id: 'p', discord_id: 'u', gameId: `game-${n}`, gameStart: new Date(f.now()).toISOString(), gameEnd: new Date(f.now() + 1000).toISOString(), gameType: 'Public', gameMode: 'Team', clanTag: 'MARS', hasWon: true })));
  return b;
}
function register(f) {
  const tasks = new Map(), handlers = new Map(), stops = new Map();
  worker.registerBingoWork({ registerTask: (k, v) => tasks.set(k, v), registerDelivery: (k, v) => handlers.set(k, v), registerStopHandler: (k, v) => stops.set(k, v) }, f.client, f.db);
  return { task: tasks.get('bingo'), handlers, stop: () => { for (const fn of stops.values()) fn(); } };
}
const tick = f => ({ now: f.now(), currentTime: f.now, stopping: () => false, takeRequest: () => true });
test('production processes 451 source rows as bounded persisted stages and clean ticks skip payloads', async () => {
  const f = communityFixture();
  try {
    const b = setup(f, 451), s = f.db.community.bingo, w = register(f), batches = [];
    s.replaceEvidence = () => { throw Error('Compatibility path forbidden'); };
    const page = s.stageEvidencePage.bind(s); s.stageEvidencePage = (...args) => { const result = page(...args); batches.push(result.processed); return result; };
    for (let n = 0; n < 4; n++) await w.task(tick(f));
    assert.deepEqual(batches.filter(Boolean), [200, 200, 51]);
    assert.equal(s.get('g', b.id).cells[0].progress, 451);
    const reads = batches.length; await w.task(tick(f)); assert.equal(batches.length, reads);
    assert.deepEqual(f.calls.requests, []);
    assert.equal(f.calls.memberFetches.length, 5);
  } finally { await f.close(); }
});
test('fresh roster loss hides old automatic cells and mixed lines during manual review and delivery', async () => {
  const f = communityFixture();
  try {
    const b = setup(f, 1), s = f.db.community.bingo, w = register(f);
    for (let n = 0; n < 3; n++) await w.task(tick(f));
    assert.equal(s.get('g', b.id).cells[3].progress, 1);
    f.guild.members.fetch = async () => new Collection();
    const job = { guildId: 'g', channelId: 'c', subjectId: b.id, revision: 1, kind: 'bingo_update', part: 0 };
    const prepared = await w.handlers.get('bingo_update').prepare(job, f.now(), tick(f));
    assert.match(JSON.stringify(prepared.payload), /Refreshing|refreshing/);
    assert.doesNotMatch(JSON.stringify(prepared.payload), /\(1\/1\)/);
    const claim = s.claim('g', b.id, 13, 'officer', 'Manual objective', null, f.now());
    s.review('g', claim.id, 'officer', true, 'Verified while refresh pending', 1, f.now());
    assert.equal(s.get('g', b.id).cells[13].complete, true);
    await assert.rejects(w.handlers.get('bingo_complete').prepare({ ...job, kind: 'bingo_complete', part: 0 }, f.now(), tick(f)), /fresh evidence/i);
  } finally { await f.close(); }
});
test('publication binds atomically, edits canonical message, failed publication remains retryable', async () => {
  const f = communityFixture();
  try {
    f.addMember('u'); const s = f.db.community.bingo;
    const b = s.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
    s.requestPublish('g', b.id, 1, null, f.now());
    const service = new CommunityService(f.client, f.db, f.api, { now: f.now }); f.services.push(service);
    worker.registerBingoWork(service, f.client, f.db); await service.runOnce();
    assert.equal(s.getActive('g').messageId, 'message-1');
    const claim = s.claim('g', b.id, 13, 'u', 'Done', null, f.now());
    s.review('g', claim.id, 'officer', true, 'Verified', 1, f.now());
    await service.runOnce(); assert.ok(f.calls.edits.length); assert.equal(f.calls.sends.length, 1);
    s.archive('g', b.id, 1, f.now());
    const next = s.createDraft('g', 'c', defaultBingoObjectives(), null, f.now()); s.requestPublish('g', next.id, 1, null, f.now());
    f.channel.send = async () => { throw Object.assign(Error('Missing Permissions'), { code: 50013 }); };
    await service.runOnce(); assert.equal(s.get('g', next.id).status, 'draft');
    assert.equal(s.deliveryJobs('g', next.id).find(j => j.kind === 'bingo_publish').status, 'paused');
  } finally { await f.close(); }
});
test('partial staging invalidates on changed identity/tags and fresh actual clock; unlinked availability counts collection-off', async () => {
  const f = communityFixture();
  try {
    const b = setup(f, 451), s = f.db.community.bingo, w = register(f);
    await w.task(tick(f));
    assert.equal(s.get('g', b.id).cells[0].progress, 0);
    f.db.linkUser('u', 'new-account', null, 'identity_token');
    await w.task(tick(f));
    assert.equal(s.get('g', b.id).cells[0].progress, 0);
    for (let n = 0; n < 4; n++) await w.task(tick(f));
    assert.equal(s.get('g', b.id).cells[0].progress, 0);
    const { guild_id, revision, ...draft } = f.db.history.getSettings('g');
    f.db.history.saveSettings('g', { ...draft, collection_enabled: 0 }, revision);
    f.addMember('unlinked');
    f.db.community.availability.save({ guildId: 'g', discordId: 'unlinked', timezone: 'UTC', windows: [{ id: 'w', weekday: 1, startMinute: 60, endMinute: 120 }] }, 0, f.now());
    for (let n = 0; n < 4; n++) await w.task(tick(f));
    assert.equal(s.get('g', b.id).cells[11].progress, 1);
    const prepared = await w.handlers.get('bingo_update').prepare({ guildId: 'g', channelId: 'c', subjectId: b.id, revision: 1, kind: 'bingo_update' }, f.now(), tick(f));
    assert.match(JSON.stringify(prepared.payload), /disabled.*Manual.*retention/i);
    assert.deepEqual(f.calls.requests, []);
  } finally { await f.close(); }
});
test('fair cursor visits other guilds with one request per tick and never completes an expired source token', async () => {
  const f = communityFixture();
  try {
    const b = setup(f, 451), s = f.db.community.bingo;
    const second = s.createDraft('other', 'other-channel', defaultBingoObjectives(), null, f.now()); s.publish('other', second.id, 1, 'other-message');
    const visits = [];
    const fetch = f.guild.members.fetch;
    f.guild.members.fetch = async options => { visits.push('g'); return fetch(options); };
    const otherGuild = { ...f.guild, id: 'other', members: { fetch: async () => { visits.push('other'); return new Collection(); } } };
    f.client.guilds.cache.set('other', otherGuild);
    const w = register(f);
    for (let n = 0; n < 4; n++) { let requests = 1; await w.task({ ...tick(f), takeRequest: () => requests-- > 0 }); }
    assert.ok(visits.includes('g') && visits.includes('other')); assert.equal(visits.length, 4);
    assert.ok(visits.every((v, n) => n === 0 || v !== visits[n - 1]));
    // The current actual clock changes during the awaited roster, so the old retention token cannot publish.
    let advance = true;
    f.guild.members.fetch = async options => { const result = await fetch(options); if (advance) { advance = false; f.advance(91 * 86400000); } return result; };
    for (let n = 0; n < 5; n++) await w.task(tick(f));
    assert.equal(s.get('g', b.id).cells[0].progress, 0);
  } finally { await f.close(); }
});
test('manual line jobs remain usable collection-off, deduplicate regain, and automatic jobs defer dirty sources', async () => {
  const f = communityFixture();
  try {
    f.addMember('u'); const s = f.db.community.bingo;
    const defs = Array.from({ length: 24 }, (_, i) => ({ kind: 'manual', target: 1, label: `Manual ${i}` }));
    const b = s.createDraft('g', 'c', defs, null, f.now()); s.publish('g', b.id, 1, 'public');
    for (let i = 0; i < 5; i++) { const c = s.claim('g', b.id, i, 'u', 'Done', null, f.now()); s.review('g', c.id, 'officer', true, 'Verified', 1, f.now()); }
    const w = register(f), job = f.db.community.deliveries.list('g').find(j => j.kind === 'bingo_complete');
    const prepared = await w.handlers.get('bingo_complete').prepare(job, f.now(), tick(f));
    assert.ok(prepared); assert.match(JSON.stringify(prepared.payload), /line is complete/);
    s.setManualApproval('g', b.id, 1, 0, false, 'officer', 'Correction', f.now());
    assert.equal(await w.handlers.get('bingo_complete').prepare(job, f.now(), tick(f)), null);
    s.setManualApproval('g', b.id, 1, 0, true, 'officer', 'Reverified', f.now());
    assert.equal(f.db.community.deliveries.list('g').filter(j => j.kind === 'bingo_complete').length, 1);
  } finally { await f.close(); }
});
test('a changed tag or stale deletion feed during the roster await hides automatic progress', async () => {
  for (const change of ['tag', 'health', 'clock']) {
    const f = communityFixture();
    try {
      const b = setup(f, 1), s = f.db.community.bingo, w = register(f);
      for (let n = 0; n < 3; n++) await w.task(tick(f));
      assert.equal(s.get('g', b.id).cells[3].progress, 1);
      const fetch = f.guild.members.fetch;
      f.guild.members.fetch = async options => {
        const result = await fetch(options);
        if (change === 'tag') f.db.deleteGuildClanConfig('g', 'MARS');
        if (change === 'health') f.db.history.setMeta('deletions_error', 'offline');
        if (change === 'clock') f.advance(91 * 86400000);
        return result;
      };
      const job = { guildId: 'g', channelId: 'c', subjectId: b.id, revision: 1, kind: 'bingo_update' };
      const prepared = await w.handlers.get('bingo_update').prepare(job, f.now(), tick(f));
      assert.match(JSON.stringify(prepared.payload), /refreshing/i);
      assert.doesNotMatch(JSON.stringify(prepared.payload), /\(1\/1\)/);
    } finally { await f.close(); }
  }
});
test('publication budget deferral is not failure and an accepted publication binding error requires reconciliation', async () => {
  const f = communityFixture();
  try {
    f.addMember('u'); const s = f.db.community.bingo;
    const b = s.createDraft('g', 'c', defaultBingoObjectives(), null, f.now()); s.requestPublish('g', b.id, 1, null, f.now());
    const limited = new CommunityService(f.client, f.db, f.api, { now: f.now, maxRequestsPerTick: 1 }); f.services.push(limited);
    worker.registerBingoWork(limited, f.client, f.db); await limited.runOnce();
    let job = s.deliveryJobs('g', b.id)[0]; assert.equal(job.status, 'pending'); assert.equal(job.attempts, 0); assert.equal(f.calls.sends.length, 0);
    const service = new CommunityService(f.client, f.db, f.api, { now: f.now }); f.services.push(service); worker.registerBingoWork(service, f.client, f.db);
    const publish = s.publish.bind(s); s.publish = () => { throw Error('Binding failure'); };
    f.advance(60000); await service.runOnce();
    job = s.deliveryJobs('g', b.id)[0]; assert.equal(job.status, 'needs_review'); assert.equal(f.calls.sends.length, 1);
    await service.runOnce(); assert.equal(f.calls.sends.length, 1);
    s.publish = publish; f.db.community.deliveries.retry('g', job.id, job.revision, f.now());
    await service.runOnce(); assert.equal(s.getActive('g').messageId, 'message-1'); assert.equal(f.calls.sends.length, 1);
  } finally { await f.close(); }
});
test('transport revalidates a mixed line after its channel await and defers without consuming an attempt', async () => {
  const f = communityFixture();
  try {
    const original = setup(f, 1), s = f.db.community.bingo;
    s.archive('g', original.id, 1, f.now());
    const defs = defaultBingoObjectives(); for (let n = 0; n < 5; n++) defs[n] = { kind: 'wins', target: 1, label: 'A public Team win' };
    const b = s.createDraft('g', 'c', defs, null, f.now()); s.publish('g', b.id, 1, 'public');
    const w = register(f); for (let n = 0; n < 3; n++) await w.task(tick(f));
    const completion = f.db.community.deliveries.list('g').find(j => j.subjectId === b.id && j.kind === 'bingo_complete'); assert.ok(completion);
    const service = new CommunityService(f.client, f.db, f.api, { now: f.now }); f.services.push(service); worker.registerBingoWork(service, f.client, f.db);
    const fetch = f.client.channels.fetch;
    f.client.channels.fetch = async id => { const result = await fetch(id); f.db.history.setMeta('deletions_error', 'offline'); return result; };
    await service.runOnce();
    const job = f.db.community.deliveries.get(completion.id); assert.equal(job.status, 'pending'); assert.equal(job.attempts, 0);
    assert.equal(f.calls.sends.length, 0);
  } finally { await f.close(); }
});
test('roster outage prepares an unavailable masked card and never licenses automatic completion', async () => {
  const f = communityFixture();
  try {
    const b = setup(f, 1), w = register(f);
    for (let n = 0; n < 3; n++) await w.task(tick(f));
    f.guild.members.fetch = async () => { throw Error('Discord unavailable'); };
    const job = { guildId: 'g', channelId: 'c', subjectId: b.id, revision: 1, kind: 'bingo_update' };
    const prepared = await w.handlers.get('bingo_update').prepare(job, f.now(), tick(f));
    assert.match(JSON.stringify(prepared.payload), /membership.*unavailable/i);
    assert.doesNotMatch(JSON.stringify(prepared.payload), /\(1\/1\)/);
    await assert.rejects(w.handlers.get('bingo_complete').prepare({ ...job, kind: 'bingo_complete', part: 0 }, f.now(), tick(f)), /membership.*unavailable/i);
  } finally { await f.close(); }
});
test('stopping drops a partial worker continuation; a new run abandons it instead of finalizing it', async () => {
  const f = communityFixture();
  try {
    const b = setup(f, 451), s = f.db.community.bingo, w = register(f);
    await w.task(tick(f));
    const old = f.db.db.prepare("SELECT id FROM community_bingo_generations WHERE board_id=? AND status='staging'").get(b.id).id;
    w.stop(); await w.task(tick(f));
    assert.equal(f.db.db.prepare('SELECT status FROM community_bingo_generations WHERE id=?').get(old).status, 'abandoned');
    assert.equal(s.get('g', b.id).cells[0].progress, 0);
  } finally { await f.close(); }
});
