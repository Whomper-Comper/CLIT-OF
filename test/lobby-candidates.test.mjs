import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";

test("candidate rotation reads and updates a full batch with bounded statements", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const insert = sql.prepare("INSERT INTO lobby_searches VALUES(?,?,?,?,?,?,?)");
    for (let i = 0; i < 23; i++) {
      insert.run("g", `u${String(i).padStart(2, "0")}`, `generation-${i}`, "searching", null, null, 0);
    }
    insert.run("g", "waiting", "waiting-generation", "waiting", "notification", 500, 0);
    insert.run("g2", "u00", "other-guild-generation", "searching", null, null, 1000);
    const calls = [];
    const store = new LobbyStore({ prepare(statement) { calls.push(statement); return sql.prepare(statement); } });
    const first = store.candidates(20, 100);
    assert.equal(calls.length, 2);
    assert.deepEqual(first.map(row => row.user), Array.from({length: 20}, (_, i) => `u${String(i).padStart(2, "0")}`));
    assert.deepEqual(first[0], { guild: "g", user: "u00", generation: "generation-0", state: "searching", pending: null, deadline: null });
    assert.equal(sql.prepare("SELECT last_work FROM lobby_searches WHERE guild='g' AND user='u00'").get().last_work, 100);
    assert.equal(sql.prepare("SELECT last_work FROM lobby_searches WHERE guild='g2' AND user='u00'").get().last_work, 1000);
    assert.equal(sql.prepare("SELECT last_work FROM lobby_searches WHERE user='u20'").get().last_work, 0);
    assert.equal(sql.prepare("SELECT last_work FROM lobby_searches WHERE user='waiting'").get().last_work, 0);
    calls.length = 0;
    const next = store.candidates(20, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(next.slice(0, 3).map(row => row.user), ["u20", "u21", "u22"]);
    assert.equal(new Set(next.map(row => row.user)).size, 20);
  } finally {
    sql.close();
  }
});
