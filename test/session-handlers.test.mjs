import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import dotenv from 'dotenv';
dotenv.config = () => ({ parsed: {} });
process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'test';
process.env.CLIENT_ID = 'test';
const { ExpiringSessions } = await import('../dist/expiringSessions.js');
const { db } = await import('../dist/db.js');
const { openfrontApi } = await import('../dist/api.js');
const { statsCommand, handleStatsInteraction } = await import('../dist/commands/stats.js');
const { configCommand, handleConfigInteraction } = await import('../dist/commands/config.js');
after(() => db.close());
let sequence = 0;

// Observe retained registry contents without adding production instrumentation or
// retaining payloads in mock call histories. Actual handlers still own sessions.
function registries(t) {
  const found = new Set(), original = ExpiringSessions.prototype.set;
  ExpiringSessions.prototype.set = function (...args) { found.add(this); return original.apply(this, args); };
  t.after(() => { ExpiringSessions.prototype.set = original; for (const registry of found) registry.clear(); });
  return found;
}
function stats(period) {
  const id = ++sequence;
  return { guildId: `sessions-g-${id}`, user: { id: `sessions-u-${id}` },
    options: { getUser: () => null, getString: key => ({ openfront_id: `p${id}`, period, view: 'numbers' })[key] ?? null },
    deferReply: async () => {}, editReply: async function (output) { this.output = output; return { id: `message-${id}` }; } };
}
const controlId = i => i.output.components[0].components[0].data.custom_id.split(':')[1];
function statsButton(i, action) {
  return { guildId: i.guildId, user: i.user, message: { id: `message-${i.user.id.split('-').at(-1)}` },
    customId: `stats-pages:${controlId(i)}:${action}`, isButton: () => true,
    deferUpdate: async () => {}, editReply: async function (output) { this.output = output; },
    reply: async function (output) { this.replyOutput = output; }, followUp: async function (output) { this.followUpOutput = output; } };
}
const profile = () => ({ username: 'Test', createdAt: '2025-01-01T00:00:00Z', clans: [], stats: {} });

test('real stats handlers release forty five-mode, thousand-match payloads while idle', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-01T00:00:00Z') });
  const captured = registries(t);
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => profile());
  t.mock.method(openfrontApi, 'getPlayerGames', async (player, query = {}) => {
    const page = Number(query.cursor ?? 0), mode = query.filter ?? 'all';
    return { results: Array.from({ length: 100 }, (_, index) => ({ gameId: `${player}-${mode}-${page}-${index}`,
      start: new Date(Date.now() - (page * 100 + index + 1) * 1000).toISOString(), durationSeconds: 500,
      map: 'World', mode: mode === 'team' ? 'Team' : mode === 'hvn' ? 'Humans Vs Nations' : 'Free For All',
      type: 'public', playerTeams: null, rankedType: mode === 'ranked' ? '1v1' : 'unranked',
      result: 'victory', totalPlayers: 100, username: 'Synthetic', clanTag: null })), nextCursor: page < 9 ? String(page + 1) : null };
  });
  for (let n = 0; n < 40; n++) {
    const i = stats('7d'); await statsCommand.execute(i);
    for (const mode of ['team', 'hvn', 'ranked', 'all']) await handleStatsInteraction(statsButton(i, mode));
  }
  assert.equal(captured.size, 1);
  const registry = [...captured][0];
  assert.equal(registry.size, 40);
  const payloadCount = () => [...registry.entries()].reduce((sum, [, s]) => sum + [...s.analytics.values()].reduce((n, a) => n + a.games.length, 0), 0);
  assert.equal(payloadCount(), 200_000);
  t.mock.timers.tick(599_999); assert.equal(payloadCount(), 200_000);
  t.mock.timers.tick(1);
  assert.equal(registry.size, 0); assert.equal(payloadCount(), 0);
});

for (const revoke of ['deleted', 'expired']) test(`stats cap evicts oldest and ${revoke} in-flight history cannot republish its session`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-01T00:00:00Z') });
  const captured = registries(t);
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => profile());
  const oldest = stats(); await statsCommand.execute(oldest);
  let latest;
  for (let n = 0; n < 500; n++) { latest = stats(); await statsCommand.execute(latest); }
  const registry = [...captured][0]; assert.equal(registry.size, 500);
  const evicted = statsButton(oldest, 'history'); await handleStatsInteraction(evicted);
  assert.match(evicted.replyOutput.content, /expired/);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  t.mock.method(openfrontApi, 'getPlayerGames', async () => { entered(); await new Promise(resolve => { release = resolve; }); return { results: [], nextCursor: null }; });
  const request = statsButton(latest, 'history'), pending = handleStatsInteraction(request);
  await waiting;
  if (revoke === 'deleted') registry.clear();
  else t.mock.timers.tick(600_000);
  assert.equal(registry.size, 0);
  release(); await pending;
  assert.equal(registry.size, 0); assert.equal(request.output, undefined);
  assert.match(request.followUpOutput.content, /expired while loading/);
});

function config() {
  const id = ++sequence, userId = `config-u-${id}`;
  const member = { id: userId, user: { bot: false }, roles: { cache: new Map() }, permissions: { has: () => true } };
  const guild = { id: `config-g-${id}`, members: { fetch: async () => member }, roles: { fetch: async () => null } };
  return { guildId: guild.id, guild, user: { id: userId }, member, memberPermissions: member.permissions,
    inCachedGuild: () => true, deferReply: async () => {}, editReply: async function (output) { this.output = output; } };
}
function configButton(i, action) {
  return { ...i, customId: `clit-config:${controlId(i)}:${action}`, output: undefined,
    isMessageComponent: () => true, isModalSubmit: () => false, isButton: () => true,
    isRoleSelectMenu: () => false, isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
    deferUpdate: async function () { this.deferred = true; }, reply: async function (output) { this.output = output; },
    followUp: async function (output) { this.followUpOutput = output; }, editReply: async function (output) { this.output = output; } };
}

test('config cap evicts oldest and idle expiry releases all two hundred remaining drafts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-01T00:00:00Z') });
  const captured = registries(t), oldest = config(); await configCommand.execute(oldest);
  let latest;
  for (let n = 0; n < 200; n++) { latest = config(); await configCommand.execute(latest); }
  const registry = [...captured][0]; assert.equal(registry.size, 200);
  const evicted = configButton(oldest, 'new'); await handleConfigInteraction(evicted);
  assert.match(evicted.output.content, /menu expired/);
  await handleConfigInteraction(configButton(latest, 'new'));
  t.mock.timers.tick(599_999); assert.equal(registry.size, 200);
  t.mock.timers.tick(1); assert.equal(registry.size, 0);
});

for (const revoke of ['deleted', 'expired']) test(`config ${revoke} during awaited access lookup cannot publish a draft or redraw`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-01T00:00:00Z') });
  const captured = registries(t), i = config(); await configCommand.execute(i);
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  i.guild.members.fetch = async () => { entered(); await new Promise(resolve => { release = resolve; }); return i.member; };
  const request = configButton(i, 'new'), pending = handleConfigInteraction(request);
  await waiting;
  const registry = [...captured][0];
  if (revoke === 'deleted') registry.clear();
  else t.mock.timers.tick(600_000);
  release(); await pending;
  assert.equal(registry.size, 0);
  assert.equal(request.output, undefined);
  assert.match(request.followUpOutput.content, /menu expired/);
});
