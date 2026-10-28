import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'test';
process.env.CLIENT_ID = 'test';
const { db } = await import('../dist/db.js');
const { openfrontApi } = await import('../dist/api.js');
const { whoisCommand } = await import('../dist/commands/whois.js');
const { statsCommand, handleStatsInteraction } = await import('../dist/commands/stats.js');
after(() => db.close());

let nextId = 0;
function lookup(command, scope, input, serial, period = null) {
  const guildId = scope === 'guild' ? `guild-${serial}` : null;
  const subject = `subject-${serial}`, account = `account-${++nextId}`;
  if (guildId) db.linkGuildUser(guildId, 'manager', subject, account, 'Stored');
  else db.linkUser(subject, account, 'Stored', 'identity_token');
  const interaction = {
    guildId, user: { id: `reader-${serial}` },
    options: { getUser: name => name === 'user' && input === 'user' ? { id: subject } : null,
      getString: name => name === 'openfront_id' && input === 'id' ? account : name === 'period' ? period : null },
    deferReply: async () => {}, editReply: async function (value) { this.output = value; return { id: `message-${serial}` }; },
  };
  return { command, guildId, subject, account, interaction, unlink() {
    if (guildId) db.unlinkGuildUser(guildId, 'manager', subject); else db.unlinkUser(subject);
  }, reverify() {
    if (guildId) db.linkGuildUser(guildId, 'manager', subject, account, 'Stored');
    else db.linkUser(subject, account, 'Stored', 'identity_token');
  } };
}
const profile = { username: 'Player', clans: [], stats: null, createdAt: '2026-01-01T00:00:00.000Z' };

for (const [commandName, command] of [['whois', whoisCommand], ['stats', statsCommand]])
  for (const input of ['user', 'id']) for (const scope of ['guild', 'dm']) for (const action of ['unlink', 'reverify']) {
    test(`${commandName} rejects ${scope} ${input} lookup if the link changes during profile loading (${action})`, async t => {
      const f = lookup(command, scope, input, `${commandName}-${scope}-${input}-${action}`);
      let release, started;
      const ready = new Promise(resolve => { started = resolve; });
      t.mock.method(openfrontApi, 'getPlayerProfile', () => new Promise(resolve => { release = resolve; started(); }));
      const pending = command.execute(f.interaction);
      await ready;
      f[action]();
      release(profile);
      await assert.rejects(pending, /link.*changed|identity.*changed/i);
      assert.equal(f.interaction.output, undefined);
    });
  }

test('standalone public-ID lookups still work without a saved link', async t => {
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => profile);
  for (const [name, command] of [['whois', whoisCommand], ['stats', statsCommand]]) {
    const interaction = { guildId: 'unrelated-guild', user: { id: `standalone-${name}` },
      options: { getUser: () => null, getString: key => key === 'openfront_id' ? 'standalone' : null },
      deferReply: async () => {}, editReply: async function (value) { this.output = value; return { id: 'standalone-message' }; } };
    await command.execute(interaction);
    assert.ok(interaction.output.embeds.length);
  }
});

for (const [name, command] of [['whois', whoisCommand], ['stats', statsCommand]])
  test(`${name} does not use a removed link as an API-failure fallback`, async t => {
    const f = lookup(command, 'guild', 'user', `fallback-${name}`);
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    t.mock.method(openfrontApi, 'getPlayerProfile', () => new Promise((_resolve, reject) => { release = reject; started(); }));
    const pending = command.execute(f.interaction);
    await ready;
    f.unlink();
    release(new Error('API unavailable'));
    await assert.rejects(pending, /link.*changed|identity.*changed/i);
    assert.equal(f.interaction.output, undefined);
  });

test('stats rejects a link removed while filtered analytics are loading', async t => {
  const f = lookup(statsCommand, 'guild', 'user', 'analytics', '7d');
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => profile);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  t.mock.method(openfrontApi, 'getPlayerGames', () => new Promise(resolve => { release = resolve; started(); }));
  const pending = statsCommand.execute(f.interaction);
  await ready;
  f.unlink();
  release({ results: [], nextCursor: null });
  await assert.rejects(pending, /link.*changed|identity.*changed/i);
  assert.equal(f.interaction.output, undefined);
});

test('stats controls reject a removed link rather than refreshing an obsolete association', async t => {
  const f = lookup(statsCommand, 'guild', 'user', 'button');
  t.mock.method(openfrontApi, 'getPlayerProfile', async () => profile);
  await statsCommand.execute(f.interaction);
  const customId = f.interaction.output.components.flatMap(row => row.components).find(button => button.data.label === 'Buildings').data.custom_id;
  f.unlink();
  let edited, reply;
  const button = { customId, guildId: f.guildId, user: f.interaction.user, message: { id: 'message-button' },
    isButton: () => true, deferUpdate: async () => {}, editReply: async value => { edited = value; },
    reply: async value => { reply = value; }, followUp: async value => { reply = value; } };
  assert.equal(await handleStatsInteraction(button), true);
  assert.equal(edited.components.length, 0);
  assert.doesNotMatch(JSON.stringify(edited.embeds[0].toJSON()), /account-/);
  assert.match(reply.content, /link.*changed|identity.*changed/i);
});
