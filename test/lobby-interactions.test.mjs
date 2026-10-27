import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags, ChannelType } from "discord.js";
import { communityFixture } from "./helpers/community.mjs";
import { createLobbyCommand } from "../dist/commands/lobby.js";
function interaction(f, sub, values = {}) {
  const replies = [];
  return {
    guildId: "g",
    guild: f.guild,
    client: f.client,
    user: { id: "u" },
    channelId: "c",
    replies,
    options: {
      getSubcommand: () => sub,
      getString: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
      getBoolean: (n) => values[n] ?? null,
      getChannel: (n) => values[n] ?? null,
    },
    reply: async (p) => replies.push(p),
    deferReply: async (p) => replies.push(p),
    editReply: async (p) => replies.push(p),
  };
}
test("watch/list/stop/resume are private and validate the supported map catalog", async () => {
  const f = communityFixture();
  try {
    const cmd = createLobbyCommand(f.db, {
      now: f.now,
      feed: { status: "Connected" },
    });
    f.db.community.lobbies.configure("g", true, "c", f.now());
    const i = interaction(f, "watch", {
      name: "World teams",
      map: "world",
      mode: "Team",
      min_players: 10,
    });
    await cmd.execute(i);
    assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(i.replies[0].content, /fallback|ping/i);
    assert.equal(f.db.community.lobbies.rules("g", "u")[0].map, "World");
    await assert.rejects(
      cmd.execute(interaction(f, "watch", { name: "bad", map: "madeup" })),
      /map/i,
    );
    await cmd.execute(interaction(f, "stop"));
    assert.equal(f.db.community.lobbies.search("g", "u").state, "stopped");
    await cmd.execute(interaction(f, "resume"));
    assert.equal(f.db.community.lobbies.search("g", "u").state, "searching");
    const list = interaction(f, "list");
    await cmd.execute(list);
    assert.match(list.replies[0].content, /World teams/);
  } finally {
    await f.close();
  }
});
test("configuration requires fresh authorization and valid destination permissions", async () => {
  const f = communityFixture();
  try {
    f.addMember("u");
    const cmd = createLobbyCommand(f.db, { now: f.now });
    const i = interaction(f, "configure", { enabled: true });
    await assert.rejects(cmd.execute(i), /Manage Server|config role/i);
    assert.equal(f.db.community.lobbies.settings("g").enabled, false);
  } finally {
    await f.close();
  }
});
test("DM continuation checks ownership, message and current server membership", async () => {
  const f = communityFixture();
  try {
    f.addMember("u");
    const s = f.db.community.lobbies,
      cmd = createLobbyCommand(f.db, { now: f.now });
    s.configure("g", true, "c", f.now());
    s.watch("g", "u", { name: "World", map: "World" }, f.now());
    const n = s.select(
      "g",
      "u",
      {
        source: "https://blue.openfront.io",
        id: "a1234567",
        map: "World",
        mode: "Team",
        category: "team",
        players: 12,
        capacity: 100,
        startsAt: f.now() + 60000,
        restricted: false,
      },
      f.now(),
    );
    s.delivered(n.id, "dm", "m", f.now());
    const i = {
      ...interaction(f, ""),
      guild: null,
      guildId: null,
      channelId: "dm",
      message: { id: "m" },
      isButton: () => true,
      customId: `lobby:continue:${n.id}`,
    };
    await assert.rejects(
      cmd.handleInteraction({ ...i, user: { id: "intruder" } }),
      /belong/i,
    );
    await assert.rejects(
      cmd.handleInteraction({ ...i, message: { id: "forged" } }),
      /message/i,
    );
    assert.equal(await cmd.handleInteraction(i), true);
    assert.equal(s.search("g", "u").state, "searching");
    await assert.rejects(cmd.handleInteraction(i), /expired|used/i);
  } finally {
    await f.close();
  }
});

test("manager can disable alerts after fallback channel has been deleted", async () => {
  const f = communityFixture();
  try {
    const member = f.addMember("u");
    member.permissions.has = () => true;
    f.guild.members.me = member;
    f.db.community.lobbies.configure("g", true, "deleted", f.now());
    f.guild.channels.fetch = async () => null;
    const cmd = createLobbyCommand(f.db, { now: f.now });
    await cmd.execute(interaction(f, "configure", { enabled: false }));
    assert.equal(f.db.community.lobbies.settings("g").enabled, false);
  } finally {
    await f.close();
  }
});

test("member and guild lifecycle purge saved searches while unrelated members remain", async () => {
  const f = communityFixture();
  try {
    const s = f.db.community.lobbies;
    s.configure("g", true, "c", f.now());
    s.watch("g", "u", { name: "one", map: "World" }, f.now());
    s.watch("g", "v", { name: "two", mode: "Team" }, f.now());
    f.db.community.purgeMember("g", "u");
    assert.equal(s.rules("g", "u").length, 0);
    assert.equal(s.search("g", "u"), null);
    assert.equal(s.rules("g", "v").length, 1);
    f.db.community.purgeGuild("g");
    assert.equal(s.search("g", "v"), null);
    assert.equal(s.settings("g").enabled, false);
  } finally {
    await f.close();
  }
});
test("list paginates ten long filters within Discord content limits", async () => {
  const f = communityFixture();
  try {
    const s = f.db.community.lobbies;
    s.configure("g", true, "c", f.now());
    for (let n = 0; n < 10; n++)
      s.watch(
        "g",
        "u",
        {
          name: `${n}` + "x".repeat(59),
          map: "World",
          mode: "Team",
          category: "team",
          min: 1,
          max: 100,
        },
        f.now(),
      );
    const cmd = createLobbyCommand(f.db, { now: f.now });
    const i = interaction(f, "list", { page: 2 });
    await cmd.execute(i);
    const content = i.replies[0].content;
    assert.ok(content.length <= 2000);
    assert.match(content, /Page 2\/2/);
    assert.equal((content.match(/\*\*\d+x+/g) ?? []).length, 5);
  } finally {
    await f.close();
  }
});
