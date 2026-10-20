import test from 'node:test';
import assert from 'node:assert/strict';
import { communityFixture } from './helpers/community.mjs';
import { CommunityService } from '../dist/community/service.js';
const duel = await import('../dist/commands/duel.js').catch(() => ({}));
const worker = await import('../dist/community/duelWorker.js').catch(() => ({}));

function interaction(f, actor = 'a', opponent = 'b') {
  return { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: actor },
    options: { getUser: () => ({ id: opponent }) },
    async deferReply(payload) { this.deferred = payload; },
    async editReply(payload) { this.output = payload; return { id: 'private' }; } };
}
function control(f, record, action, actor = 'b', extra = {}) {
  return { ...interaction(f, actor), customId: `clit-duel:${record.id}:${action}`,
    message: { id: record.messageId }, isButton: () => true, async deferUpdate() { this.deferred = true; },
    ...extra };
}
function setup(t, roll = () => 4) {
  const f = communityFixture();
  f.addMember('a'); f.addMember('b'); f.addMember('third');
  const command = duel.createDuelCommand({ db: f.db, now: f.now, roll });
  const service = new CommunityService(f.client, f.db, f.api, { now: f.now });
  worker.registerDuelWork(service, f.client, f.db);
  f.services.push(service);
  t.after(() => f.close());
  return { ...f, command, service };
}
const record = f => {
  const row = f.db.db.prepare('SELECT id FROM community_duels ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
  return row ? f.db.community.duels.get('g', row.id) : null;
};
async function invite(f) {
  const i = interaction(f);
  await f.command.execute(i);
  await f.service.runOnce();
  return record(f);
}
const buttons = payload => payload.components.flatMap(row => row.components).map(b => b.toJSON());

test('server-only command queues durable public invitation and binds before enabling controls', async t => {
  const f = setup(t);
  const i = interaction(f);
  await f.command.execute(i);
  assert.ok(i.deferred.flags);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.db.community.deliveries.list('g')[0].kind, 'duel_publish');
  await f.service.runOnce();
  assert.equal(f.calls.sends.length, 1);
  assert.ok(buttons(f.calls.sends[0]).every(b => b.disabled));
  assert.equal(record(f).messageId, 'message-1');
  assert.equal(buttons(f.calls.edits.at(-1)).find(b => b.label === 'Accept').disabled, false);
  assert.equal(f.calls.memberFetches.length, 1);
  assert.deepEqual(f.calls.sends[0].allowedMentions, { parse: [] });
  assert.equal(f.command.data.toJSON().contexts[0], 0);
});

test('self, bot, missing member and direct messages reject without invitations', async t => {
  const f = setup(t);
  f.addMember('robot', [], true);
  for (const opponent of ['a', 'robot', 'missing']) {
    await assert.rejects(f.command.execute(interaction(f, 'a', opponent)), /different|human|member/i);
  }
  await assert.rejects(f.command.execute({ ...interaction(f), guild: null, guildId: null }), /server/i);
  assert.equal(record(f), null);
});

test('simultaneous accept clicks draw exactly twice and persist before any public result request', async t => {
  let draws = 0;
  const f = setup(t, () => ++draws === 1 ? 2 : 6);
  const d = await invite(f);
  await Promise.all([f.command.handleInteraction(control(f, d, 'accept')), f.command.handleInteraction(control(f, d, 'accept'))]);
  assert.equal(draws, 2);
  assert.deepEqual([record(f).challengerRoll, record(f).opponentRoll], [2, 6]);
  assert.equal(f.calls.edits.length, 1);
  await f.service.runOnce();
  assert.match(JSON.stringify(f.calls.edits.at(-1)), /wins|winner/i);
  assert.ok(buttons(f.calls.edits.at(-1)).filter(b => ['Accept', 'Decline', 'Cancel'].includes(b.label)).every(b => b.disabled));
  assert.equal(buttons(f.calls.edits.at(-1)).some(b => b.label === 'Rematch'), false);
});

test('actor and canonical guild/channel/message bindings reject forged controls before member fetches', async t => {
  const f = setup(t), d = await invite(f);
  const before = f.calls.memberFetches.length;
  for (const i of [control(f, d, 'accept', 'third'), control(f, d, 'cancel'),
    control(f, d, 'refresh', 'a', { guildId: 'other' }),
    control(f, d, 'decline', 'b', { channelId: 'other' }),
    control(f, d, 'accept', 'b', { message: { id: 'other' } })]) {
    await assert.rejects(f.command.handleInteraction(i), /only|server|message|channel|unavailable/i);
  }
  assert.equal(f.calls.memberFetches.length, before);
  assert.equal(record(f).status, 'pending');
  assert.equal(await f.command.handleInteraction({ customId: 'legacy:button' }), false);
});

test('failed result edit and new worker refresh recover the exact stored rolls without RNG', async t => {
  let draws = 0;
  const f = setup(t, () => ++draws);
  const d = await invite(f);
  await f.command.handleInteraction(control(f, d, 'accept'));
  const message = f.messages.get(d.messageId), edit = message.edit;
  message.edit = async () => { throw Object.assign(new Error('Forbidden'), { code: 50013 }); };
  await f.service.runOnce();
  assert.equal(f.db.community.deliveries.list('g').at(-1).status, 'paused');
  message.edit = edit;
  const resumed = new CommunityService(f.client, f.db, f.api, { now: f.now });
  worker.registerDuelWork(resumed, f.client, f.db); f.services.push(resumed);
  const restarted = duel.createDuelCommand({ db: f.db, now: f.now, roll: () => { throw Error('reroll'); } });
  await restarted.handleInteraction(control(f, d, 'refresh'));
  await resumed.runOnce();
  assert.equal(draws, 2);
  assert.deepEqual([record(f).challengerRoll, record(f).opponentRoll], [1, 2]);
  assert.equal(f.calls.edits.at(-1).embeds[0].description, duel.renderDuel(record(f)).embeds[0].data.description);
  assert.equal(f.calls.sends.length, 1);
});

test('departure while bulk membership validation awaits deletes consent and closes canonical controls', async t => {
  let draws = 0;
  const f = setup(t, () => ++draws), d = await invite(f);
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => {
    const found = await fetch(options);
    f.db.community.purgeMember('g', 'b');
    return found;
  };
  await assert.rejects(f.command.handleInteraction(control(f, d, 'accept')), /changed|member|unavailable/i);
  assert.equal(draws, 0);
  assert.equal(record(f), null);
  await f.service.runOnce();
  const closed = f.calls.edits.at(-1);
  assert.match(JSON.stringify(closed), /closed|unavailable/i);
  assert.ok(buttons(closed).every(b => b.disabled));
  const closure = f.db.db.prepare('SELECT * FROM community_duel_closures').get();
  assert.equal(Object.values(closure).includes('a'), false);
  assert.equal(Object.values(closure).includes('b'), false);
});

test('departure during initial validation cannot recreate pending personal data', async t => {
  const f = setup(t), fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => {
    const found = await fetch(options);
    f.db.community.purgeMember('g', 'b');
    return found;
  };
  await assert.rejects(f.command.execute(interaction(f)), /changed|member|unavailable/i);
  assert.equal(record(f), null);
});

test('expiry sweep and lazy expiry both persist canonical updates atomically', async t => {
  const f = setup(t), first = await invite(f);
  f.advance(120000);
  await f.command.execute(interaction(f));
  assert.equal(f.db.community.duels.get('g', first.id).status, 'expired');
  const jobs = f.db.community.deliveries.list('g');
  assert.ok(jobs.some(j => j.subjectId === first.id && j.revision === 2 && j.kind === 'duel_update'));
  await f.service.runOnce();
  assert.match(JSON.stringify(f.calls.edits[1]), /expired/i);
  f.advance(120000);
  await f.service.runOnce();
  assert.equal(record(f).status, 'expired');
  assert.ok(buttons(f.calls.edits.at(-1)).every(b => b.disabled || b.label === 'Refresh'));
});

test('deadline crossed during validation returns expiration with no draws', async t => {
  const f = setup(t, () => { throw Error('expired RNG'); }), d = await invite(f);
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => { const found = await fetch(options); f.advance(120000); return found; };
  await f.command.handleInteraction(control(f, d, 'accept'));
  assert.equal(record(f).status, 'expired');
  await f.service.runOnce();
  assert.match(JSON.stringify(f.calls.edits.at(-1)), /expired/i);
});

test('tie rematches require fresh acceptance, cooldown and unique pending slots under races', async t => {
  const f = setup(t), d = await invite(f);
  await f.command.handleInteraction(control(f, d, 'accept'));
  await f.service.runOnce();
  assert.ok(buttons(f.calls.edits.at(-1)).some(b => b.label === 'Rematch'));
  await assert.rejects(f.command.handleInteraction(control(f, d, 'rematch', 'a')), /cooldown|30 seconds/i);
  f.advance(30000);
  const results = await Promise.allSettled([f.command.handleInteraction(control(f, d, 'rematch', 'a')),
    f.command.handleInteraction(control(f, d, 'rematch', 'b'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const fresh = record(f);
  assert.equal(fresh.rematchOf, d.id); assert.equal(fresh.status, 'pending');
  assert.equal(fresh.challengerRoll, null);
  await f.service.runOnce();
  assert.equal(f.calls.sends.length, 2);
  await f.command.handleInteraction(control(f, record(f), 'accept', fresh.opponentId));
  assert.equal(record(f).status, 'resolved');
});

test('shared router dispatches real duel buttons and preserves legacy/unrelated fallthrough', async t => {
  const f = setup(t), d = await invite(f);
  const { duelCommand } = await import('../dist/commands/duel.js');
  const { handleCommunityInteraction } = await import('../dist/community/interactions.js');
  const original = duelCommand.handleInteraction;
  duelCommand.handleInteraction = f.command.handleInteraction;
  t.after(() => { duelCommand.handleInteraction = original; });
  assert.equal(await handleCommunityInteraction(control(f, d, 'decline')), true);
  assert.equal(record(f).status, 'declined');
  assert.equal(await handleCommunityInteraction({ customId: 'legacy:control' }), false);
  assert.equal(await handleCommunityInteraction({}), false);
});

test('worker bounds expiry updates to four outbound requests and uses indexed closure retention', async t => {
  const f = setup(t);
  for (let n = 0; n < 9; n++) {
    const d = f.db.community.duels.invite({ guildId: 'g', channelId: 'c', messageId: null }, `a${n}`, `b${n}`, f.now());
    f.db.community.duels.bindMessage('g', d.id, d.revision, `public${n}`);
    f.messages.set(`public${n}`, { id: `public${n}`, author: { id: 'bot' },
      edit: async payload => { f.calls.edits.push(payload); return { id: `public${n}` }; } });
  }
  f.advance(120000);
  await f.service.runOnce();
  assert.equal(f.calls.edits.length, 4);
  assert.equal(f.calls.sends.length, 0);
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM community_duels WHERE status='expired'").get().n, 9);
});

test('fresh membership failure without a gateway departure event closes pending consent', async t => {
  const f = setup(t), d = await invite(f), fetch = f.guild.members.fetch;
  f.guild.members.fetch = async options => { const found = await fetch(options); found.delete('b'); return found; };
  await assert.rejects(f.command.handleInteraction(control(f, d, 'accept')), /human|member/i);
  assert.equal(record(f), null);
  await f.service.runOnce();
  assert.match(JSON.stringify(f.calls.edits.at(-1)), /closed/i);
});

test('binding is checked again after membership awaits and unrelated departures do not invalidate consent', async t => {
  const f = setup(t), d = await invite(f), fetch = f.guild.members.fetch;
  const click = control(f, d, 'accept');
  f.guild.members.fetch = async options => {
    const found = await fetch(options);
    click.message.id = 'forged-after-await';
    return found;
  };
  await assert.rejects(f.command.handleInteraction(click), /message|channel|server/i);
  assert.equal(record(f).status, 'pending');
  f.guild.members.fetch = async options => {
    const found = await fetch(options);
    f.db.community.purgeMember('g', 'third');
    return found;
  };
  await f.command.handleInteraction(control(f, d, 'accept'));
  assert.equal(record(f).status, 'resolved');
});

test('accepted publication timeout reconciles and binds one canonical invitation without another post', async t => {
  const f = setup(t), send = f.channel.send;
  f.channel.send = async payload => { await send(payload); throw Error('network timeout'); };
  await f.command.execute(interaction(f));
  await f.service.runOnce();
  assert.equal(f.calls.sends.length, 1);
  assert.equal(record(f).messageId, 'message-1');
  assert.equal(record(f).status, 'pending');
  assert.equal(f.db.community.deliveries.list('g').every(j => j.status === 'sent'), true);
  assert.equal(buttons(f.calls.edits.at(-1)).find(b => b.label === 'Accept').disabled, false);
});

test('a participant leaving an in-flight publication binds and closes only minimal transport metadata', async t => {
  const f = setup(t), send = f.channel.send;
  f.channel.send = async payload => {
    const message = await send(payload);
    f.db.community.purgeMember('g', 'b');
    return message;
  };
  await f.command.execute(interaction(f));
  await f.service.runOnce();
  assert.equal(record(f), null);
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.db.db.prepare('SELECT message_id FROM community_duel_closures').get().message_id, 'message-1');
  assert.match(JSON.stringify(f.calls.edits.at(-1)), /closed/i);
  assert.equal(f.db.community.deliveries.list('g').every(j => j.status === 'sent'), true);
});

test('permission-failed publication remains unique and expires without an automatic replacement', async t => {
  const f = setup(t);
  f.channel.send = async () => { throw Object.assign(Error('Forbidden'), { code: 50013 }); };
  await f.command.execute(interaction(f));
  await f.service.runOnce();
  assert.equal(f.db.community.deliveries.list('g')[0].status, 'paused');
  await assert.rejects(f.command.execute(interaction(f)), /pending/i);
  f.advance(120000);
  await f.service.runOnce();
  assert.equal(record(f).status, 'expired');
  assert.equal(f.calls.sends.length, 0);
});

test('cancel and late decline/cancel/refresh persist canonical update intents without a sweep', async t => {
  const f = setup(t);
  for (const [action, late, expected] of [
    ['cancel', false, 'cancelled'], ['decline', true, 'expired'],
    ['cancel', true, 'expired'], ['refresh', true, 'expired'],
  ]) {
    const d = await invite(f);
    if (late) f.advance(120000);
    await f.command.handleInteraction(control(f, d, action, action === 'cancel' ? 'a' : 'b'));
    const saved = f.db.community.duels.get('g', d.id);
    assert.equal(saved.status, expected);
    assert.ok(f.db.community.deliveries.list('g').some(j => j.kind === 'duel_update' && j.subjectId === d.id && j.revision === 2));
    await f.service.runOnce();
    f.advance(120000);
  }
});

test('closure retention drains 451 transport references in indexed batches and guild purge removes them', async t => {
  const f = setup(t);
  const add = f.db.db.prepare('INSERT INTO community_duel_closures VALUES(?,?,?,?,?,?)');
  for (let n = 0; n < 451; n++) add.run(`closed-${n}`, 'g', 'c', `m${n}`, 2, f.now());
  const plan = f.db.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM community_duel_closures WHERE closed_at<? ORDER BY closed_at,id LIMIT 200').all(f.now());
  assert.ok(plan.some(row => row.detail.includes('community_duel_closure_retention')));
  assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
  f.advance(30 * 86400000 + 1);
  for (const expected of [251, 51, 0]) {
    f.db.community.prune(f.now());
    assert.equal(f.db.db.prepare('SELECT count(*) n FROM community_duel_closures').get().n, expected);
  }
  add.run('guild-cleanup', 'g', 'c', 'message', 2, f.now());
  f.db.community.purgeGuild('g');
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM community_duel_closures').get().n, 0);
});

test('production runtime cadence enables an ordinary invitation within its first four-send tick', async t => {
  const f = setup(t);
  t.mock.method(Date, 'now', f.now);
  const { createCommunityService } = await import('../dist/community/runtime.js');
  const production = createCommunityService(f.client, f.db, f.api);
  f.services.push(production);
  await production.runOnce();
  f.advance(1);
  await f.command.execute(interaction(f));
  f.advance(59999);
  await production.runOnce();
  assert.equal(f.calls.sends.length, 1);
  assert.equal(f.calls.edits.length, 1);
  assert.equal(buttons(f.calls.edits[0]).find(b => b.label === 'Accept').disabled, false);
  assert.equal(record(f).expiresAt - f.now(), 120000);
});

test('production cadence with three queued invitations preserves the shared four-send budget and fixed deadlines', async t => {
  const f = setup(t);
  t.mock.method(Date, 'now', f.now);
  const { createCommunityService } = await import('../dist/community/runtime.js');
  const production = createCommunityService(f.client, f.db, f.api);
  f.services.push(production);
  await production.runOnce();
  f.advance(1);
  for (let n = 0; n < 3; n++) {
    f.addMember(`a${n}`); f.addMember(`b${n}`);
    await f.command.execute(interaction(f, `a${n}`, `b${n}`));
  }
  f.advance(59999);
  await production.runOnce();
  assert.equal(f.calls.sends.length, 3);
  assert.equal(f.calls.edits.length, 1);
  f.advance(60000);
  await production.runOnce();
  assert.equal(f.calls.sends.length, 3);
  assert.equal(f.calls.edits.length, 3);
  assert.equal(record(f).expiresAt - f.now(), 120000);
  f.advance(60000);
  await production.runOnce();
  assert.equal(f.db.db.prepare("SELECT count(*) n FROM community_duels WHERE status='expired'").get().n, 1);
  assert.equal(f.calls.sends.length, 3);
});

test('canonical activation uses the clock after awaited lookups and retries never extend the acceptance window', async t => {
  const f = setup(t), fetch = f.channel.messages.fetch;
  f.channel.messages.fetch = async input => {
    const result = await fetch(input);
    if (typeof input === 'string') f.advance(10000);
    return result;
  };
  const d = await invite(f);
  const activated = record(f);
  assert.equal(activated.activatedAt, d.createdAt + 10000);
  assert.equal(activated.expiresAt, activated.activatedAt + 120000);
  assert.match(JSON.stringify(f.calls.edits[0]), new RegExp(String(Math.floor(activated.expiresAt / 1000))));
  const edit = f.messages.get(d.messageId).edit;
  f.messages.get(d.messageId).edit = async () => { throw Object.assign(Error('Forbidden'), { code: 50013 }); };
  await f.command.handleInteraction(control(f, d, 'refresh'));
  await f.service.runOnce();
  f.advance(30000);
  f.messages.get(d.messageId).edit = edit;
  await f.command.handleInteraction(control(f, d, 'refresh'));
  await f.service.runOnce();
  assert.equal(record(f).activatedAt, activated.activatedAt);
  assert.equal(record(f).expiresAt, activated.expiresAt);
});

test('unactivated invitation reaching the exact hard wait deadline never enables consent', async t => {
  const f = setup(t), fetch = f.channel.messages.fetch;
  await f.command.execute(interaction(f));
  f.advance(119999);
  f.channel.messages.fetch = async input => {
    const result = await fetch(input);
    if (typeof input === 'string') f.advance(1);
    return result;
  };
  await f.service.runOnce();
  assert.equal(record(f).status, 'expired');
  assert.equal(record(f).activatedAt, null);
  assert.ok(f.calls.edits.every(payload => buttons(payload).filter(b => b.label === 'Accept').every(b => b.disabled)));
});

test('failed first enabling edit keeps its durable activation and deadline across worker recovery', async t => {
  const f = setup(t), send = f.channel.send;
  let originalEdit;
  f.channel.send = async payload => {
    const message = await send(payload);
    originalEdit = message.edit;
    message.edit = async () => { throw Object.assign(Error('Forbidden'), { code: 50013 }); };
    return message;
  };
  await f.command.execute(interaction(f));
  await f.service.runOnce();
  const activated = record(f);
  assert.equal(activated.activatedAt, f.now());
  assert.equal(f.calls.edits.length, 0);
  f.advance(30000);
  f.messages.get(activated.messageId).edit = originalEdit;
  const restarted = new CommunityService(f.client, f.db, f.api, { now: f.now });
  worker.registerDuelWork(restarted, f.client, f.db); f.services.push(restarted);
  f.db.community.duels.refresh('g', activated.id, f.now());
  await restarted.runOnce();
  assert.equal(record(f).activatedAt, activated.activatedAt);
  assert.equal(record(f).expiresAt, activated.expiresAt);
  assert.equal(record(f).expiresAt - f.now(), 90000);
  assert.equal(f.calls.sends.length, 1);
});

test('backlog beyond the original activation wait expires only unactivated invitations', async t => {
  const f = setup(t);
  t.mock.method(Date, 'now', f.now);
  const { createCommunityService } = await import('../dist/community/runtime.js');
  const production = createCommunityService(f.client, f.db, f.api); f.services.push(production);
  await production.runOnce();
  f.advance(1);
  for (let n = 0; n < 5; n++) {
    f.addMember(`a${n}`); f.addMember(`b${n}`);
    await f.command.execute(interaction(f, `a${n}`, `b${n}`));
  }
  f.advance(59999); await production.runOnce();
  assert.equal(f.calls.sends.length + f.calls.edits.length, 4);
  f.advance(60000); await production.runOnce();
  assert.equal(f.calls.sends.length + f.calls.edits.length, 8);
  f.advance(60000); await production.runOnce();
  const rows = f.db.db.prepare('SELECT status,activated_at,expires_at FROM community_duels ORDER BY rowid').all();
  assert.deepEqual(rows.map(row => row.status), ['pending', 'pending', 'pending', 'expired', 'expired']);
  assert.ok(rows.slice(0, 3).every(row => row.expires_at - row.activated_at === 120000));
  assert.ok(rows.slice(3).every(row => row.activated_at === null));
  assert.equal(f.calls.sends.length, 5);
});

test('initialization upgrades pre-activation duel schema while preserving existing state', async t => {
  const f = setup(t);
  const d = f.db.community.duels.invite({ guildId: 'g', channelId: 'c', messageId: null }, 'a', 'b', f.now());
  f.db.db.exec('ALTER TABLE community_duels DROP COLUMN activated_at');
  const { CommunityStore } = await import('../dist/community/store.js');
  CommunityStore.initialize(f.db.db);
  const upgraded = new CommunityStore(f.db.db).duels.get('g', d.id);
  assert.equal(upgraded.activatedAt, null);
  assert.equal(upgraded.expiresAt, d.expiresAt);
  assert.equal(upgraded.challengerId, 'a');
  assert.equal(f.db.db.prepare('SELECT count(*) n FROM community_duel_participants').get().n, 2);
});

test('twenty concurrent refreshes coalesce one stable revision job and one canonical edit', async t => {
  const f = setup(t), d = await invite(f);
  await f.command.handleInteraction(control(f, d, 'accept'));
  await f.service.runOnce();
  const beforeEdits = f.calls.edits.length, beforeJobs = f.db.community.deliveries.list('g').length;
  await Promise.all(Array.from({ length: 20 }, () => f.command.handleInteraction(control(f, d, 'refresh', 'third'))));
  assert.equal(f.db.community.deliveries.list('g').length, beforeJobs);
  assert.equal(f.db.community.deliveries.list('g').filter(j => j.status === 'pending').length, 1);
  await f.service.runOnce();
  assert.equal(f.calls.edits.length, beforeEdits + 1);
  assert.equal(f.calls.sends.length, 1);
});

test('interrupted accepted publication reclaims its five-minute lease and closes the proven expired card', async t => {
  const f = setup(t), send = f.channel.send;
  let entered, release;
  const accepted = new Promise(resolve => { entered = resolve; });
  const suspended = new Promise(resolve => { release = resolve; });
  f.channel.send = async payload => {
    const message = await send(payload);
    entered();
    await suspended;
    return message;
  };
  await f.command.execute(interaction(f));
  const interrupted = f.service.runOnce();
  await accepted;
  const publication = f.db.community.deliveries.list('g')[0];
  assert.equal(publication.status, 'sending');
  assert.equal(record(f).messageId, null);
  assert.equal(f.calls.sends.length, 1);
  try {
    f.advance(300001);
    const restarted = new CommunityService(f.client, f.db, f.api, { now: f.now });
    worker.registerDuelWork(restarted, f.client, f.db); f.services.push(restarted);
    await restarted.runOnce();
    assert.equal(f.db.community.deliveries.get(publication.id).status, 'sent');
    assert.equal(record(f).status, 'expired');
    assert.equal(record(f).messageId, 'message-1');
    assert.equal(record(f).activatedAt, null);
    assert.equal(f.calls.sends.length, 1);
    assert.match(JSON.stringify(f.calls.edits.at(-1)), /expired.*try again/i);
    assert.ok(buttons(f.calls.edits.at(-1)).filter(b => b.label === 'Accept').every(b => b.disabled));
  } finally {
    release();
    await interrupted;
  }
  assert.equal(f.db.community.deliveries.get(publication.id).status, 'sent');
});

test('departure after accepted publication plus timeout reconciles only the generic canonical closure', async t => {
  const f = setup(t), send = f.channel.send;
  f.channel.send = async payload => {
    await send(payload);
    f.db.community.purgeMember('g', 'b');
    throw Error('accepted send timed out');
  };
  await f.command.execute(interaction(f));
  await f.service.runOnce();
  assert.equal(record(f), null);
  assert.equal(f.calls.sends.length, 1);
  const closure = f.db.db.prepare('SELECT * FROM community_duel_closures').get();
  assert.equal(closure.message_id, 'message-1');
  assert.equal(Object.values(closure).includes('a'), false);
  assert.equal(Object.values(closure).includes('b'), false);
  assert.equal(f.db.community.deliveries.list('g').every(job => job.status === 'sent'), true);
  assert.match(JSON.stringify(f.calls.edits.at(-1)), /closed/i);
  assert.deepEqual(f.calls.edits.at(-1).components, []);
});

test('expired uncertain publication without a bot marker stays reviewable on manual retries without a fresh send', async t => {
  const { deliveryMarker } = await import('../dist/community/deliveries.js');
  for (const departure of [false, true]) {
    const f = setup(t), fetch = f.channel.messages.fetch;
    let attempts = 0, reconciliations = 0;
    f.channel.send = async () => { attempts++; throw Error('unknown send outcome'); };
    f.channel.messages.fetch = async input => {
      if (typeof input !== 'string') reconciliations++;
      return fetch(input);
    };
    await f.command.execute(interaction(f));
    await f.service.runOnce();
    const publication = f.db.community.deliveries.list('g')[0];
    assert.equal(publication.status, 'needs_review');
    assert.equal(reconciliations, 1);
    f.messages.set('forged-marker', { id: 'forged-marker', author: { id: 'third' }, content: deliveryMarker(publication), embeds: [] });
    if (departure) f.db.community.purgeMember('g', 'b');
    f.advance(300001);
    for (let n = 0; n < 2; n++) {
      f.db.community.deliveries.retry('g', publication.id, publication.revision, f.now());
      await f.service.runOnce();
      assert.equal(f.db.community.deliveries.get(publication.id).status, 'needs_review');
      if (departure) {
        assert.equal(record(f), null);
        assert.equal(f.db.community.duels.closure('g', publication.subjectId).messageId, null);
      } else {
        assert.equal(record(f).status, 'expired');
        assert.equal(record(f).messageId, null);
        assert.equal(record(f).activatedAt, null);
      }
    }
    assert.equal(reconciliations, 3);
    assert.equal(attempts, 1);
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.edits.length, 0);
  }
});

test('expired or departed unbound publications with no prior send never publish a fresh closing card', async t => {
  for (const departure of [false, true]) {
    const f = setup(t);
    await f.command.execute(interaction(f));
    const publication = f.db.community.deliveries.list('g')[0];
    if (departure) f.db.community.purgeMember('g', 'b');
    else f.advance(120000);
    await f.service.runOnce();
    assert.equal(f.db.community.deliveries.get(publication.id).status, 'cancelled');
    assert.equal(f.calls.sends.length, 0);
    assert.equal(f.calls.edits.length, 0);
  }
});
