import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'test';
process.env.CLIENT_ID = 'test';
const { db } = await import('../dist/db.js');
const { openfrontApi } = await import('../dist/api.js');
const { clanCommand } = await import('../dist/commands/clan.js');
const { buildCoverageReport } = await import('../dist/reporting.js');
after(() => db.close());

function fixture(id, action) {
  const guildId = `report-${id}`, actor = `actor-${id}`, user = `user-${id}`;
  db.setManagerRole(guildId, 'manager');
  db.setGuildClanConfig({ guild_id: guildId, clan_tag: 'ABC', member_role_id: 'rank', officer_role_id: null,
    leader_role_id: null, join_role_id: 'approval', log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  db.linkGuildUser(guildId, 'manager', user, `acct-${id}`, 'Player');
  let permitted = true;
  const person = { id: user, user: { bot: false }, roles: { cache: new Map([['approval', true]]) } };
  const guild = { id: guildId, roles: { fetch: async () => new Map([['rank', { id: 'rank', managed: false }], ['manager', { id: 'manager', managed: false }]]) },
    channels: { fetch: async () => null }, members: { cache: new Map([[user, person]]), fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }), fetch: async request => request?.user === actor
    ? { id: actor, roles: { cache: new Map(permitted ? [['manager', true]] : []) } }
    : new Map([[user, person]]) } };
  person.guild = guild;
  const i = { guild, guildId, user: { id: actor }, member: { roles: { cache: new Map([['manager', true]]) } },
    inCachedGuild: () => true, options: { getString: key => key === 'action' ? action : key === 'clan_tag' ? 'ABC' : null,
      getInteger: () => null, getRole: () => null, getUser: () => null, getChannel: () => null },
    deferReply: async () => {}, editReply: async function(value) { this.output = value; } };
  return { guildId, user, person, i, revoke: () => { permitted = false; } };
}

for (const action of ['pending', 'roster', 'coverage', 'doctor']) test(`${action} rejects revoked access after a slow lookup`, async t => {
  const f = fixture(`auth-${action}`, action);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => { entered(); await waiting; return { username: 'Player', clans: [{ tag: 'ABC', role: 'member' }] }; });
  t.mock.method(openfrontApi, 'getClanInfo', async () => { entered(); await waiting; return { tag: 'ABC', memberCount: 10 }; });
  const sync = { getPendingJoinMembers: async () => { entered(); await waiting; return []; } };
  const pending = clanCommand.execute(f.i, sync);
  await ready;
  f.revoke(); release();
  await assert.rejects(pending, /role|permission|access/i);
  assert.equal(f.i.output, undefined);
});

for (const action of ['coverage', 'doctor']) test(`${action} rejects a mapping edited during its API lookup`, async t => {
  const f = fixture(`mapping-${action}`, action);
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [{ tag: 'ABC' }] }));
  t.mock.method(openfrontApi, 'getClanInfo', async () => {
    db.setGuildClanConfig({ ...db.getGuildClanConfig(f.guildId, 'ABC'), member_role_id: 'replacement' });
    return { tag: 'ABC', memberCount: 10 };
  });
  await assert.rejects(clanCommand.execute(f.i, {}), /settings|configuration changed/i);
  assert.equal(f.i.output, undefined);
});

for (const change of ['identity', 'departure']) test(`coverage rejects ${change} during final authorization`, async t => {
  const f = fixture(`coverage-final-auth-${change}`, 'coverage');
  const fetch = f.i.guild.members.fetch;
  let checks = 0;
  f.i.guild.members.fetch = async request => {
    if (request?.user && ++checks === 2) {
      if (change === 'identity') db.unlinkGuildUser(f.guildId, 'manager', f.user);
      else {
        f.i.guild.members.cache.delete(f.user);
        db.history.purgeMember(f.guildId, f.user);
        db.community.purgeMember(f.guildId, f.user);
      }
    }
    return fetch(request);
  };
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [{ tag: 'ABC' }] }));
  t.mock.method(openfrontApi, 'getClanInfo', async () => ({ tag: 'ABC', memberCount: 10 }));
  await assert.rejects(clanCommand.execute(f.i, {}), /membership|identit.*changed/i);
  assert.equal(f.i.output, undefined);
});

test('coverage rejects an identity unlinked between rendering and the caller resuming', async t => {
  const f = fixture('coverage-render-caller-race', 'coverage');
  const fetch = f.i.guild.members.fetch;
  let fullFetches = 0;
  f.i.guild.members.fetch = request => {
    if (!request && ++fullFetches === 2) {
      // Cross the member-fetch wrapper and builder continuations, then unlink
      // after rendering but before the command captures any caller-side guard.
      queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
        db.unlinkGuildUser(f.guildId, 'manager', f.user);
      })));
    }
    return fetch(request);
  };
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [{ tag: 'ABC' }] }));
  t.mock.method(openfrontApi, 'getClanInfo', async () => ({ tag: 'ABC', memberCount: 10 }));
  await assert.rejects(clanCommand.execute(f.i, {}), /identit.*changed/i);
  assert.equal(db.getEffectiveLink(f.guildId, f.user), null);
  assert.equal(f.i.output, undefined, 'coverage rendered before unlink must not be released');
});

test('coverage ignores identity changes for people outside the server during final authorization', async t => {
  const f = fixture('coverage-unrelated-identity', 'coverage');
  const fetch = f.i.guild.members.fetch;
  let checks = 0;
  f.i.guild.members.fetch = async request => {
    if (request?.user && ++checks === 2) db.linkUser('unrelated-person', 'unrelated-account', 'Unrelated', 'identity_token');
    return fetch(request);
  };
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [{ tag: 'ABC' }] }));
  t.mock.method(openfrontApi, 'getClanInfo', async () => ({ tag: 'ABC', memberCount: 10 }));
  await clanCommand.execute(f.i, {});
  assert.match(f.i.output.embeds[0].toJSON().fields.find(field => field.name === 'Discord Members Linked').value, /^1 \/ 1/);
});

for (const change of ['unlink', 'reverify', 'replace', 'departure', 'new-link']) test(`coverage recalculates current checks after ${change} during clan totals lookup`, async t => {
  const f = fixture(`coverage-${change}`, 'coverage');
  const additional = { id: 'additional', user: { bot: false } };
  let currentMembers = new Map([[f.user, f.person], ['additional', additional]]);
  f.i.guild.members.fetch = async () => {
    f.i.guild.members.cache = currentMembers;
    return currentMembers;
  };
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [{ tag: 'ABC' }] }));
  t.mock.method(openfrontApi, 'getClanInfo', async () => {
    if (change === 'unlink') db.unlinkGuildUser(f.guildId, 'manager', f.user);
    if (change === 'reverify' || change === 'replace') db.linkGuildUser(f.guildId, 'manager', f.user,
      change === 'replace' ? 'replacement-account' : `acct-coverage-${change}`, 'Player');
    if (change === 'departure') currentMembers = new Map([['additional', additional]]);
    if (change === 'new-link') db.linkGuildUser(f.guildId, 'manager', 'additional', 'additional-account', 'New');
    return { tag: 'ABC', memberCount: 10 };
  });
  const { embeds: [embed] } = await buildCoverageReport(f.i.guild, db.getGuildConfigs(f.guildId));
  const fields = embed.toJSON().fields;
  const linked = fields.find(field => field.name === 'Discord Members Linked').value;
  const checks = fields.find(field => field.name === 'Current Clan Membership Checks').value;
  const clan = fields.find(field => field.name.includes('Clan Members Linked')).value;
  if (change === 'unlink' || change === 'departure') {
    assert.match(linked, change === 'unlink' ? /^0 \/ 2/ : /^0 \/ 1/);
    assert.match(checks, /^0 profiles checked successfully out of 0/);
    assert.match(clan, /At least 0 \/ 10/);
  } else {
    assert.match(linked, change === 'new-link' ? /^2 \/ 2/ : /^1 \/ 2/);
    assert.match(checks, change === 'new-link' ? /^1 profiles checked successfully out of 2/ : /^0 profiles checked successfully out of 1/);
    assert.match(checks, /1 not checked.*counts are partial/);
    assert.match(clan, change === 'new-link' ? /At least 1 \/ 10/ : /At least 0 \/ 10/);
  }
});

test('coverage fails closed when the final member refresh fails', async t => {
  const f = fixture('coverage-refresh-failure', 'coverage');
  let calls = 0;
  f.i.guild.members.fetch = async () => { if (++calls > 1) throw new Error('unavailable'); return new Map([[f.user, f.person]]); };
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ clans: [] }));
  t.mock.method(openfrontApi, 'getClanInfo', async () => ({ tag: 'ABC', memberCount: 10 }));
  await assert.rejects(buildCoverageReport(f.i.guild, db.getGuildConfigs(f.guildId)), /Could not load all server members/);
});

for (const protectedApproval of [true, false]) test(`roster ${protectedApproval ? 'preserves another clan approval role without a warning' : 'warns about an actual surplus rank role'}`, async t => {
  const f = fixture(`roster-approval-${protectedApproval}`, 'roster');
  const config = db.getGuildClanConfig(f.guildId, 'ABC');
  db.setGuildClanConfig({ ...config, officer_role_id: 'extra-rank' });
  db.setGuildClanConfig({ ...config, clan_tag: 'DEF', member_role_id: 'other-rank',
    join_role_id: protectedApproval ? 'extra-rank' : 'other-approval' });
  f.person.roles.cache.set('rank', true);
  f.person.roles.cache.set('extra-rank', true);
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => ({ username: 'Player', clans: [{ tag: 'ABC', role: 'member' }] }));
  await clanCommand.execute(f.i, {});
  const description = f.i.output.embeds[0].toJSON().description;
  assert.match(description, /Player/);
  if (protectedApproval) assert.doesNotMatch(description, /roles need sync/);
  else assert.match(description, /roles need sync/);
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
