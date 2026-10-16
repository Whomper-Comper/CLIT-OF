import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { MessageFlags } = await import("discord.js");
const { diceCommand, createDiceCommand } = await import("../dist/commands/dice.js");
after(() => db.close());

let sequence = 0;
function fixture(sides = null, count = null) {
  const events = [];
  const interaction = {
    user: { id: `dice-user-${++sequence}` },
    options: { getInteger: (name) => {
      assert.ok(["sides", "count"].includes(name));
      return name === "sides" ? sides : count;
    } },
    reply: async (payload) => { events.push(["reply", payload]); },
    deferReply: async (...args) => { events.push(["defer", ...args]); },
    editReply: async (payload) => { events.push(["edit", payload]); },
  };
  return { interaction, events };
}

test("dice registration exposes optional sides from 1 to 1000 and count from 1 to 25", () => {
  const data = diceCommand.data.toJSON();
  assert.equal(data.name, "dice");
  assert.equal(data.options.length, 2);
  assert.equal(data.options[0].name, "sides");
  assert.equal(data.options[0].type, 4);
  assert.equal(data.options[0].required, false);
  assert.equal(data.options[0].min_value, 1);
  assert.equal(data.options[0].max_value, 1000);
  assert.equal(data.options[1].name, "count");
  assert.equal(data.options[1].type, 4);
  assert.equal(data.options[1].required, false);
  assert.equal(data.options[1].min_value, 1);
  assert.equal(data.options[1].max_value, 25);
});

test("dice defaults to one D6, defers publicly, animates five frames, then reveals the roll", async () => {
  const { interaction, events } = fixture();
  const command = createDiceCommand({
    roll: (min, max) => { events.push(["roll", min, max]); return 4; },
    sleep: async (milliseconds) => { events.push(["sleep", milliseconds]); },
  });
  await command.execute(interaction);
  assert.deepEqual(events, [
    ["roll", 1, 7], ["defer"],
    ["edit", "🎲 Rolling."], ["sleep", 600],
    ["edit", "🎲 Rolling.."], ["sleep", 600],
    ["edit", "🎲 Rolling..."], ["sleep", 600],
    ["edit", "🎲 Rolling."], ["sleep", 600],
    ["edit", "🎲 Rolling.."], ["sleep", 600],
    ["edit", "🎲 **Rolled 1d6!**\n\nResult: **4**"],
  ]);
});

test("dice permits both configured size boundaries and requests inclusive result boundaries", async () => {
  for (const sides of [1, 2, 3, 1000]) {
    for (const result of [1, sides]) {
      const { interaction, events } = fixture(sides);
      const command = createDiceCommand({
        roll: (min, max) => { assert.equal(min, 1); assert.equal(max, sides + 1); return result; },
        sleep: async () => {},
      });
      await command.execute(interaction);
      const critical = sides < 3 ? "" : result === sides ? " 🎉 CRITICAL MAX!" : " 💀 CRITICAL MIN!";
      assert.deepEqual(events.at(-1), ["edit", `🎲 **Rolled 1d${sides}!**\n\nResult: **${result}**${critical}`]);
    }
  }
  for (const sides of [1, 2, 1000]) {
    let draws = 0;
    const { interaction, events } = fixture(sides, 25);
    const command = createDiceCommand({
      roll: (min, max) => {
        assert.equal(min, 1);
        assert.equal(max, sides + 1);
        return ++draws % 2 ? sides : 1;
      },
      sleep: async () => {},
    });
    await command.execute(interaction);
    const output = events.at(-1)[1];
    assert.equal(draws, 25);
    assert.ok(output.length <= 2000);
    assert.ok(output.includes("**Die 25:**"));
    assert.ok(output.includes(`**Total: ${13 * sides + 12}**`));
    if (sides >= 3) {
      assert.ok(output.includes("🎉 Critical Max: 13"));
      assert.ok(output.includes("💀 Critical Min: 12"));
    } else {
      assert.ok(!output.includes("CRITICAL"));
      assert.ok(!output.includes("Critical"));
    }
  }
});

test("invalid dice configurations reply privately without drawing or starting an animation", async () => {
  const command = createDiceCommand({
    roll: () => { throw new Error("Must not draw"); },
    sleep: async () => { throw new Error("Must not sleep"); },
  });
  const invalid = [0, -3, 1001, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
    .map((sides) => [sides, null]);
  invalid.push(...[0, -1, 26, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((count) => [6, count]));
  for (const [sides, count] of invalid) {
    const { interaction, events } = fixture(sides, count);
    await command.execute(interaction);
    assert.deepEqual(events, [["reply", { content: "❌ Invalid dice configuration!", flags: MessageFlags.Ephemeral }]]);
  }
});

test("dice rate limiting prevents repeated animation edits and random draws", async () => {
  const { interaction, events } = fixture();
  let draws = 0;
  const command = createDiceCommand({ roll: () => { draws++; return 1; }, sleep: async () => {} });
  await command.execute(interaction);
  const firstLength = events.length;
  await assert.rejects(command.execute(interaction), /Please wait/);
  assert.equal(draws, 1);
  assert.equal(events.length, firstLength);
});
