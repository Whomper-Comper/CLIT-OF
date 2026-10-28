import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'test';
process.env.CLIENT_ID = 'test';
const { db } = await import('../dist/db.js');
const { openfrontApi } = await import('../dist/api.js');
const { clanCommand } = await import('../dist/commands/clan.js');
after(() => db.close());

function fixture(id, action) {
  const guildId = `report-${id}`, actor = `actor-${id}`, user = `user-${id}`;
  db.setManagerRole(guildId, 'manager');
  db.setGuildClanConfig({ guild_id: guildId, clan_tag: 'ABC', member_role_id: 'rank', officer_role_id: null,
    leader_role_id: null, join_role_id: 'approval', log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  db.linkGuildUser(guildId, 'manager', user, `acct-${id}`, 'Player');
  let permitted = true;
  const person = { id: user, user: { bot: false }, roles: { cache: new Map([['approval', true]]) } };
  const guild = { id: guildId, members: { fetch: async request => request?.user === actor
    ? { id: actor, roles: { cache: new Map(permitted ? [['manager', true]] : []) } }
    : new Map([[user, person]]) } };
  person.guild = guild;
  const i = { guild, guildId, user: { id: actor }, member: { roles: { cache: new Map([['manager', true]]) } },
    inCachedGuild: () => true, options: { getString: key => key === 'action' ? action : key === 'clan_tag' ? 'ABC' : null,
      getInteger: () => null, getRole: () => null, getUser: () => null, getChannel: () => null },
    deferReply: async () => {}, editReply: async function(value) { this.output = value; } };
  return { guildId, user, person, i, revoke: () => { permitted = false; } };
}

for (const action of ['pending', 'roster']) test(`${action} rejects revoked access after a slow lookup`, async t => {
  const f = fixture(`auth-${action}`, action);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => { entered(); await waiting; return { username: 'Player', clans: [{ tag: 'ABC', role: 'member' }] }; });
  const sync = { getPendingJoinMembers: async () => { entered(); await waiting; return []; } };
  const pending = clanCommand.execute(f.i, sync);
  await ready;
  f.revoke(); release();
  await assert.rejects(pending, /role|permission|access/i);
  assert.equal(f.i.output, undefined);
});

test('roster excludes a binding reverified while another profile lookup is pending', async t => {
  const f = fixture('roster-link', 'roster');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => { entered(); await waiting; return { username: 'Player', clans: [{ tag: 'ABC', role: 'member' }] }; });
  const pending = clanCommand.execute(f.i, {});
  await ready;
  db.linkGuildUser(f.guildId, 'manager', f.user, 'acct-roster-link', 'Player');
  release(); await pending;
  assert.doesNotMatch(JSON.stringify(f.i.output.embeds[0].toJSON()), /acct-roster-link/);
});

test('pending excludes a binding removed while a profile lookup is pending', async () => {
  const f = fixture('pending-link', 'pending');
  const link = db.getEffectiveLink(f.guildId, f.user);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = clanCommand.execute(f.i, { getPendingJoinMembers: async () => {
    entered(); await waiting; return [{ member: f.person, link, ofUsername: 'Player' }];
  } });
  await ready;
  db.unlinkGuildUser(f.guildId, 'manager', f.user);
  release(); await pending;
  assert.doesNotMatch(JSON.stringify(f.i.output.embeds[0].toJSON()), /acct-pending-link|user-pending-link/);
});

test('pending excludes a member whose approval role was removed during lookup', async () => {
  const f = fixture('pending-role', 'pending');
  const link = db.getEffectiveLink(f.guildId, f.user);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = clanCommand.execute(f.i, { getPendingJoinMembers: async () => {
    entered(); await waiting; return [{ member: f.person, link, ofUsername: 'Player' }];
  } });
  await ready;
  f.person.roles.cache.delete('approval');
  release(); await pending;
  assert.doesNotMatch(JSON.stringify(f.i.output.embeds[0].toJSON()), /acct-pending-role|user-pending-role/);
});

test('roster rejects a clan mapping changed during profile lookup', async t => {
  const f = fixture('roster-config', 'roster');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => { entered(); await waiting; return { username: 'Player', clans: [{ tag: 'ABC', role: 'member' }] }; });
  const pending = clanCommand.execute(f.i, {});
  await ready;
  const config = db.getGuildClanConfig(f.guildId, 'ABC');
  db.setGuildClanConfig({ ...config, member_role_id: 'changed-rank' });
  release();
  await assert.rejects(pending, /configuration changed/i);
  assert.equal(f.i.output, undefined);
});
