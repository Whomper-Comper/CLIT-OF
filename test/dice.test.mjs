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
function fixture(sides = null) {
  const events = [];
  const interaction = {
    user: { id: `dice-user-${++sequence}` },
    options: { getInteger: (name) => { assert.equal(name, "sides"); return sides; } },
    reply: async (payload) => { events.push(["reply", payload]); },
    deferReply: async (...args) => { events.push(["defer", ...args]); },
    editReply: async (payload) => { events.push(["edit", payload]); },
  };
  return { interaction, events };
}

test("dice registration exposes one optional integer from 2 to 1000", () => {
  const data = diceCommand.data.toJSON();
  assert.equal(data.name, "dice");
  assert.equal(data.options.length, 1);
  assert.equal(data.options[0].name, "sides");
  assert.equal(data.options[0].type, 4);
  assert.equal(data.options[0].required, false);
  assert.equal(data.options[0].min_value, 2);
  assert.equal(data.options[0].max_value, 1000);
});

test("dice defaults to D6, defers publicly, animates six frames, then reveals the roll", async () => {
  const { interaction, events } = fixture();
  const command = createDiceCommand({
    roll: (min, max) => { events.push(["roll", min, max]); return 4; },
    sleep: async (milliseconds) => { events.push(["sleep", milliseconds]); },
  });
  await command.execute(interaction);
  assert.deepEqual(events, [
    ["roll", 1, 7], ["defer"],
    ["edit", "🎲 Rolling."], ["sleep", 500],
    ["edit", "🎲 Rolling.."], ["sleep", 500],
    ["edit", "🎲 Rolling..."], ["sleep", 500],
    ["edit", "🎲 Rolling."], ["sleep", 500],
    ["edit", "🎲 Rolling.."], ["sleep", 500],
    ["edit", "🎲 Rolling..."], ["sleep", 500],
    ["edit", "🎲 You rolled a **4** (D6)!"],
  ]);
});

test("dice permits both configured size boundaries and requests inclusive result boundaries", async () => {
  for (const sides of [2, 1000]) {
    for (const result of [1, sides]) {
      const { interaction, events } = fixture(sides);
      const command = createDiceCommand({
        roll: (min, max) => { assert.equal(min, 1); assert.equal(max, sides + 1); return result; },
        sleep: async () => {},
      });
      await command.execute(interaction);
      assert.deepEqual(events.at(-1), ["edit", `🎲 You rolled a **${result}** (D${sides})!`]);
    }
  }
});

test("invalid dice sizes reply privately without drawing or starting an animation", async () => {
  const command = createDiceCommand({
    roll: () => { throw new Error("Must not draw"); },
    sleep: async () => { throw new Error("Must not sleep"); },
  });
  for (const sides of [1, 0, -3, 1001, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { interaction, events } = fixture(sides);
    await command.execute(interaction);
    assert.deepEqual(events, [["reply", { content: "Invalid dice size!", flags: MessageFlags.Ephemeral }]]);
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
