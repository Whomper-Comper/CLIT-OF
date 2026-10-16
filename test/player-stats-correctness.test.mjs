import test from "node:test";
import assert from "node:assert/strict";

const { summarizePlayerStats, winRate } = await import("../dist/playerStats.js");
const leaf = (wins, losses, stats = undefined, recent = undefined) => ({
  wins: String(wins), losses: String(losses), total: String(BigInt(wins) + BigInt(losses)), stats, recent,
});

test("profile type selections keep public, private, singleplayer, ranked and Humans Vs Nations separate", () => {
  const stats = {
    Public: { "Free For All": { Hard: leaf(2, 3) }, Team: { Hard: leaf(4, 1) }, "Humans Vs Nations": { Hard: leaf(90, 10) } },
    Private: { "Free For All": { Easy: leaf(10, 2) }, Team: { Easy: leaf(20, 4) } },
    Singleplayer: { "Free For All": { Easy: leaf(30, 3) }, Team: { Easy: leaf(40, 4) } },
    Ranked: { "1v1": leaf(1, 1) },
  };
  assert.equal(summarizePlayerStats(stats, "ffa", { type: "public" }).games, 5n);
  assert.equal(summarizePlayerStats(stats, "teams", { type: "public" }).games, 5n);
  assert.equal(summarizePlayerStats(stats, "ffa", { type: "private" }).games, 12n);
  assert.equal(summarizePlayerStats(stats, "teams", { type: "singleplayer" }).games, 44n);
  assert.equal(summarizePlayerStats(stats, undefined, { type: "public" }).games, 110n);
  assert.equal(summarizePlayerStats(stats, "ranked", { type: "public" }).games, 2n);
  assert.equal(summarizePlayerStats(stats, "ranked", { type: "private" }), null);
  assert.equal(summarizePlayerStats(stats, "teams").games, 73n);
  assert.equal(summarizePlayerStats(stats).games, 225n);
});

test("recent rates follow exact selected type and mode instead of the global all-mode window", () => {
  const stats = {
    Public: {
      "Free For All": { Easy: leaf(10, 5), Hard: leaf(4, 1) },
      Team: { Hard: leaf(15, 5) },
    },
    Private: { "Free For All": { Easy: leaf(8, 2) } },
    Ranked: { "1v1": leaf(1, 1) },
    recent: {
      all: { games: 60, wins: 50 },
      Public: { all: { games: 40, wins: 29 }, "Free For All": { all: { games: 20, wins: 14 } }, Team: { all: { games: 20, wins: 15 } } },
      Private: { all: { games: 10, wins: 8 }, "Free For All": { all: { games: 10, wins: 8 } } },
      Ranked: { all: { games: 2, wins: 1 } },
    },
  };
  assert.deepEqual(summarizePlayerStats(stats, "ffa", { type: "public" }).recent, { games: 20, wins: 14 });
  assert.deepEqual(summarizePlayerStats(stats, "teams", { type: "public" }).recent, { games: 20, wins: 15 });
  assert.deepEqual(summarizePlayerStats(stats, undefined, { type: "public" }).recent, { games: 40, wins: 29 });
  assert.deepEqual(summarizePlayerStats(stats, "ranked").recent, { games: 2, wins: 1 });
  assert.deepEqual(summarizePlayerStats(stats).recent, { games: 60, wins: 50 });
  // Newest-100 windows from different game types cannot be added together.
  assert.equal(summarizePlayerStats(stats, "ffa").recent, null);
});

test("one selected bucket may supply its exact recent window, while multiple buckets cannot be summed", () => {
  const stats = { Public: { "Free For All": {
    Easy: leaf(8, 2, undefined, { games: 5, wins: 4 }),
  } }, recent: { all: { games: 100, wins: 1 } } };
  assert.deepEqual(summarizePlayerStats(stats, "ffa", { type: "public" }).recent, { games: 5, wins: 4 });
  stats.Public["Free For All"].Hard = leaf(1, 1, undefined, { games: 2, wins: 1 });
  assert.equal(summarizePlayerStats(stats, "ffa", { type: "public" }).recent, null);
});

test("raw totals identify missing buckets and preserve built, launch and trade wire slots", () => {
  const huge = 9_007_199_254_740_993n;
  const stats = { Public: { "Free For All": {
    Easy: leaf(1, 1, {
      units: { city: [String(huge), "999"], port: ["0"], wshp: ["2", "999"] },
      gold: ["999", "999", "17", "999"], attacks: ["19", "999"],
      bombs: { abomb: ["3", "999"], mirv: ["2"], mirvw: ["900"] },
    }),
    Hard: leaf(1, 0, { units: { city: ["2"] } }),
  } } };
  const summary = summarizePlayerStats(stats, "ffa", { type: "public" });
  const details = new Map(summary.details.map(row => [row.name, row]));
  assert.equal(details.get("Cities built").value, huge + 2n);
  assert.equal(details.get("Cities built").partial ?? false, false);
  assert.equal(details.get("Ports built").value, 0n);
  assert.equal(details.get("Ports built").partial, true);
  assert.equal(details.get("Warships built").value, 2n);
  assert.equal(details.get("Trade gold earned").value, 17n);
  assert.equal(details.get("Trade gold earned").partial, true);
  assert.equal(details.get("Troops sent").value, 19n);
  assert.equal(details.get("Nukes launched").value, 5n);
  assert.equal(details.get("Nukes launched").partial, true);
  assert.equal(summary.buildings[0].value, details.get("Cities built").value);
  assert.equal(winRate(1n, 3n), "33.3%");
});
