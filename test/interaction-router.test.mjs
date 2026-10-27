import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { Client, Collection, Events, MessageFlags } from "discord.js";

process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
let client;
mock.method(Client.prototype, "login", async function () { client = this; return "test"; });
await import("../dist/index.js");
const { db } = await import("../dist/db.js");
const { commandsByName } = await import("../dist/commands/index.js");
const { handleCommunityInteraction } = await import("../dist/community/interactions.js");
const { milestonesCommand } = await import("../dist/commands/milestones.js");
const { defaultBingoObjectives } = await import("../dist/community/bingo.js");
const { communitySessions } = await import("../dist/community/sessions.js");
const route = client.listeners(Events.InteractionCreate)[0];
after(async () => { await client.destroy(); db.close(); mock.restoreAll(); });

test('actual interaction event dispatches saved duel consent through the complete community chain', async () => {
  const guildId = 'router-duel-event';
  try {
    assert.ok(commandsByName.has('duel'));
    const d = db.community.duels.invite({ guildId, channelId: 'duel-channel', messageId: null }, 'challenger', 'opponent', Date.now());
    db.community.duels.bindMessage(guildId, d.id, d.revision, 'duel-message');
    db.community.duels.activate(guildId, d.id, 'duel-channel', 'duel-message', Date.now());
    let memberFetches = 0;
    const i = interaction({ guildId, channelId: 'duel-channel', user: { id: 'opponent' },
      guild: { id: guildId, members: { fetch: async options => {
        memberFetches++;
        assert.deepEqual(options.user, ['challenger', 'opponent']);
        return new Collection(options.user.map(id => [id, { user: { id, bot: false } }]));
      } } },
      message: { id: 'duel-message' }, customId: `clit-duel:${d.id}:accept`,
      async deferReply(payload) { this.deferred = true; this.deferPayload = payload; } });
    await route(i);
    assert.equal(db.community.duels.get(guildId, d.id).status, 'resolved');
    assert.equal(memberFetches, 1);
    assert.equal(i.deferPayload.flags, MessageFlags.Ephemeral);
    assert.equal(i.edits.length, 1);
    assert.equal(i.followups.length, 0);
  } finally { db.community.purgeGuild(guildId); }
});

function interaction(overrides = {}) {
  return {
    guildId: null, deferred: false, replied: false, replies: [], edits: [], followups: [],
    isMessageComponent: () => true, isModalSubmit: () => false, isButton: () => true,
    isChatInputCommand: () => false, isRepliable: () => true,
    customId: "whois-stats:expired",
    reply: async function (value) { this.replies.push(value); this.replied = true; },
    editReply: async function (value) { this.edits.push(value); },
    followUp: async function (value) { this.followups.push(value); },
    ...overrides,
  };
}

test('persistent community prefixes reject forged saved bindings without changing SQLite', async () => {
  const guildId = 'router-all-prefixes';
  const now = Date.now();
  const event = db.community.events.createDraft({ guildId, channelId: 'saved-channel', creatorId: 'owner',
    title: 'private integration title', description: '', startAt: now + 3600000,
    durationMinutes: 60, capacity: 20, squads: [], reminderMinutes: 0 }, now);
  db.community.events.publish(guildId, event.id, event.revision, 'saved-message');
  const draft = db.community.bingo.createDraft(guildId, 'saved-channel', defaultBingoObjectives(), null, now);
  const board = db.community.bingo.publish(guildId, draft.id, draft.revision, 'saved-message');
  const duel = db.community.duels.invite({ guildId, channelId: 'saved-channel', messageId: null }, 'a', 'b', now);
  db.community.duels.bindMessage(guildId, duel.id, duel.revision, 'saved-message');
  const ids = [`event:${event.id}:join:${event.revision}`, `bingo:${board.id}:claim:${board.revision}`,
    `clit-duel:${duel.id}:accept`];
  const snapshot = () => db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name")
    .all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  try {
    const before = snapshot();
    for (const customId of ids) {
      for (const forged of [{ channelId: 'forged-channel' }, { guildId: 'forged-guild', guild: { id: 'forged-guild' } }]) {
        const i = interaction({ guildId, guild: { id: guildId }, channelId: 'saved-channel',
          user: { id: 'owner' }, message: { id: 'saved-message' }, customId,
          isStringSelectMenu: () => false, isChannelSelectMenu: () => false, ...forged });
        await assert.rejects(handleCommunityInteraction(i), /reopen|belong|changed|unavailable|board|binding/i, customId);
        await route(i);
        const response = [...i.replies, ...i.followups, ...i.edits];
        assert.equal(response.length, 1, customId);
        assert.equal(response[0].flags, MessageFlags.Ephemeral, customId);
        assert.doesNotMatch(JSON.stringify(response), /private integration title/);
        assert.deepEqual(snapshot(), before, customId);
      }
    }
  } finally {
    db.community.purgeGuild(guildId);
  }
});

test('each valid private route succeeds before owner, guild, channel and message forgeries are rejected privately', async () => {
  const guildId = 'router-private-valid', now = Date.now();
  const sessions = [];
  const event = db.community.events.createDraft({ guildId, channelId: 'saved-channel', creatorId: 'owner',
    title: 'private integration title', description: '', startAt: now + 3600000,
    durationMinutes: 60, capacity: 20, squads: [], reminderMinutes: 0 }, now);
  const board = db.community.bingo.createDraft(guildId, 'saved-channel', defaultBingoObjectives(), null, now);
  const preset = db.community.wheel.list(guildId)[0];
  db.setManagerRole(guildId, 'manager');
  const member = { id: 'owner', user: { id: 'owner', bot: false },
    roles: { cache: new Collection([['manager', true]]) }, permissions: { has: () => true } };
  const guild = { id: guildId, members: { fetch: async () => member } };
  const fixtures = [
    ['evtmenu', 'event-manage', { eventId: event.id, revision: event.revision }, 'details', 'modal'],
    ['availability', 'availability', { targetId: 'owner', revision: 0, page: 0, selected: null }, 'next', 'update'],
    ['onboarding', 'onboarding-status', { targetId: 'owner', clanTag: 'TEST', page: 0, lastAction: -Infinity, busy: false }, 'refresh', 'edit'],
    ['wheel', 'wheel-editor', { preset, expected: preset.revision, remove: false }, 'basics', 'modal'],
    ['milestones', 'milestones-configure', { draft: db.community.settings.get(guildId), selectedJob: null, page: 0, busy: false }, 'thresholds', 'modal'],
    ['bingomenu', 'bingo-draft', { boardId: board.id, revision: board.revision }, 'edit', 'modal'],
  ];
  const snapshot = () => db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'community_%' ORDER BY name")
    .all().map(({ name }) => [name, db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);
  try {
    for (const [prefix, kind, data, action, output] of fixtures) {
      const s = communitySessions.create({ kind, ownerId: 'owner', guildId, channelId: 'saved-channel',
        messageId: 'saved-message', data }, now);
      sessions.push(s.id);
      const make = (forged = {}) => interaction({ guildId, guild, channelId: 'saved-channel', user: { id: 'owner' },
        message: { id: 'saved-message' }, customId: `${prefix}:${s.id}:${action}`,
        isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
        async deferUpdate() { this.deferred = true; },
        async update(value) { this.updated = value; },
        async showModal(modal) { this.modal = modal.toJSON(); }, ...forged });
      const valid = make();
      assert.equal(await handleCommunityInteraction(valid), true, prefix);
      assert.ok(output === 'modal' ? valid.modal : output === 'update' ? valid.updated : valid.edits.length, prefix);
      const before = snapshot();
      for (const forged of [{ user: { id: 'intruder' } }, { guildId: 'forged-guild', guild: { id: 'forged-guild' } },
        { channelId: 'forged-channel' }, { message: { id: 'forged-message' } }]) {
        await assert.rejects(handleCommunityInteraction(make(forged)), /unavailable|expired|reopen/i, prefix);
        const invalid = make(forged); await route(invalid);
        const response = [...invalid.replies, ...invalid.followups, ...invalid.edits];
        assert.equal(response.length, 1, prefix);
        assert.equal(response[0].flags, MessageFlags.Ephemeral, prefix);
        assert.doesNotMatch(JSON.stringify(response), /private integration title/);
        assert.deepEqual(snapshot(), before, prefix);
      }
    }
  } finally {
    for (const id of sessions) communitySessions.delete(id);
    communitySessions.purgeGuild(guildId);
    db.community.purgeGuild(guildId);
  }
});

test("expired component reply failures cannot escape the interaction event", async (t) => {
  t.mock.method(console, "error", () => {});
  const i = interaction({ reply: async () => { throw Object.assign(new Error("expired"), { code: 10062 }); } });
  await assert.doesNotReject(route(i));
});

test("component failures after acknowledgment keep the original information and send a private error", async (t) => {
  t.mock.method(console, "error", () => {});
  const i = interaction({ deferred: true, reply: async () => { throw new Error("simulated component failure"); } });
  await assert.doesNotReject(route(i));
  assert.equal(i.edits.length, 0, "a component failure must not erase the source message");
  assert.equal(i.followups.length, 1);
  assert.equal(i.followups[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(i.followups[0].allowedMentions, { parse: [] });
  assert.doesNotMatch(i.followups[0].content, /simulated component failure/);
});

test("a failed private error follow-up is contained too", async (t) => {
  t.mock.method(console, "error", () => {});
  const i = interaction({ deferred: true,
    reply: async () => { throw new Error("component failed"); },
    followUp: async () => { throw new Error("Discord unavailable"); } });
  await assert.doesNotReject(route(i));
  assert.equal(i.edits.length, 0);
});

test("unknown slash commands still return a private actionable error", async () => {
  const i = interaction({ isMessageComponent: () => false, isButton: () => false,
    isChatInputCommand: () => true, commandName: "missing" });
  await route(i);
  assert.equal(i.replies.length, 1);
  assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(i.replies[0].content, /no longer available/);
});

test("deferred slash errors replace their own reply and hide unexpected details", async (t) => {
  t.mock.method(console, "error", () => {});
  const command = commandsByName.get("whois");
  t.mock.method(command, "execute", async () => { throw new Error("private exception detail"); });
  const i = interaction({ deferred: true, isMessageComponent: () => false, isButton: () => false,
    isChatInputCommand: () => true, commandName: "whois" });
  await route(i);
  assert.equal(i.edits.length, 1);
  assert.deepEqual(i.edits[0].embeds, []);
  assert.deepEqual(i.edits[0].components, []);
  assert.doesNotMatch(i.edits[0].content, /private exception detail/);
});

function bingoControl(guildId) {
  const draft = db.community.bingo.createDraft(guildId, 'router-channel', defaultBingoObjectives(), null, Date.now());
  const board = db.community.bingo.publish(guildId, draft.id, draft.revision, 'router-board');
  return interaction({ guildId, guild: { id: guildId }, channelId: 'router-channel', user: { id: 'router-user' },
    message: { id: 'router-board' }, customId: `bingo:${board.id}:claim:${board.revision}`,
    async showModal(modal) { this.modal = modal; this.replied = true; } });
}

test('community router awaits the unrelated milestones result and reaches a valid bingo claim control', async () => {
  const guildId = 'router-bingo-direct';
  try {
    const i = bingoControl(guildId);
    assert.equal(await milestonesCommand.handleInteraction(i), false);
    assert.equal(await handleCommunityInteraction(i), true);
    assert.match(i.modal.toJSON().custom_id, /^bingomenu:/);
    assert.equal(i.modal.toJSON().components.length, 3);
  } finally { db.community.purgeGuild(guildId); }
});

test('actual interaction event opens bingo controls before legacy routing', async () => {
  const guildId = 'router-bingo-event';
  try {
    const i = bingoControl(guildId);
    await route(i);
    assert.ok(i.modal, 'the actual event route must open the private claim form');
    assert.equal(i.replies.length, 0);
    assert.equal(i.followups.length, 0);
  } finally { db.community.purgeGuild(guildId); }
});

test('milestones controls still resolve true and unrelated legacy prefixes fall through without type probing', async () => {
  const guildId = 'router-milestones';
  const session = communitySessions.create({ kind: 'milestones-configure', ownerId: 'router-user', guildId,
    channelId: 'router-channel', messageId: 'router-private',
    data: { draft: db.community.settings.get(guildId), selectedJob: null, page: 0, busy: false, lastRead: -Infinity } }, Date.now());
  try {
    const i = interaction({ guildId, channelId: 'router-channel', user: { id: 'router-user' },
      guild: { id: guildId, members: { fetch: async () => ({ permissions: { has: () => true } }) } },
      message: { id: 'router-private' }, customId: `milestones:${session.id}:thresholds`,
      async showModal(modal) { this.modal = modal; } });
    assert.equal(await handleCommunityInteraction(i), true);
    assert.match(i.modal.toJSON().custom_id, /^milestones:/);
    assert.equal(await handleCommunityInteraction({ customId: 'whois-stats:legacy' }), false);
    const legacy = interaction();
    await route(legacy);
    assert.equal(legacy.replies.length, 1);
    assert.equal(legacy.replies[0].flags, MessageFlags.Ephemeral);
  } finally {
    communitySessions.delete(session.id);
    db.community.purgeGuild(guildId);
  }
});

test('actual central event routes a saved lobby continuation from a DM',async()=>{
 const guildId='router-lobby-dm',now=Date.now(),s=db.community.lobbies;
 s.configure(guildId,true,'fallback',now);s.watch(guildId,'owner',{name:'World',map:'World'},now);
 const n=s.select(guildId,'owner',{source:'https://blue.openfront.io',id:'a1234567',map:'World',mode:'Team',category:'team',players:12,capacity:100,startsAt:now+60000,restricted:false},now);s.delivered(n.id,'dm','lobby-message',now);
 client.guilds.cache.set(guildId,{id:guildId,members:{fetch:async()=>({id:'owner',user:{bot:false}})}});
 try{
  const i=interaction({client,guildId:null,channelId:'dm',user:{id:'owner'},customId:`lobby:continue:${n.id}`,message:{id:'lobby-message',edit:async()=>{}},deferReply:async function(p){this.deferred=true;this.deferPayload=p;}});
  await route(i);assert.equal(s.search(guildId,'owner').state,'searching');assert.equal(i.edits.length,1);assert.equal(i.deferPayload.flags,MessageFlags.Ephemeral);
 }finally{client.guilds.cache.delete(guildId);db.community.purgeGuild(guildId);}
});
