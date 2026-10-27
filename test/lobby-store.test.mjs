import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";
const now = 1800000000000;
const lobby = {
  source: "https://blue.openfront.io",
  id: "a1234567",
  map: "World",
  mode: "Team",
  category: "team",
  players: 12,
  capacity: 100,
  startsAt: now + 60000,
  restricted: false,
};
function fixture() {
  const sql = new DatabaseSync(":memory:");
  LobbyStore.initialize(sql);
  const store = new LobbyStore(sql);
  store.configure("g", true, "c", now);
  return { sql, store };
}
test("requires server setup, validates and limits rules without losing them on timeout", () => {
  const { store: s, sql } = fixture();
  assert.throws(
    () => s.watch("other", "u", { name: "World", map: "World" }, now),
    /configure|enabled/i,
  );
  assert.throws(
    () => s.watch("g", "u", { name: "Bad", min: 20, max: 10 }, now),
    /minimum/i,
  );
  assert.throws(() => s.watch("g", "u", { name: "Bad" }, now), /filter/i);
  for (let n = 0; n < 10; n++)
    s.watch("g", "u", { name: `r${n}`, map: "World" }, now);
  assert.throws(
    () => s.watch("g", "u", { name: "eleven", map: "World" }, now),
    /ten|10/i,
  );
  assert.equal(s.rules("g", "u").length, 10);
  assert.equal(s.rules("g", "other").length, 0);
  sql.close();
});
test("one alert per lobby, three minute continuation is owner/message bound and cannot extend on restart", () => {
  const { store: s, sql } = fixture();
  s.watch("g", "u", { name: "World", map: "World" }, now);
  const n = s.select("g", "u", lobby, now);
  assert.ok(n);
  assert.equal(s.select("g", "u", { ...lobby, id: "other" }, now), null);
  s.delivered(n.id, "dm", "m", now);
  assert.equal(s.search("g", "u").deadline, now + 180000);
  assert.throws(
    () => s.continue(n.id, "other", "dm", "m", now + 1),
    /belong|your|owner/i,
  );
  assert.throws(
    () => s.continue(n.id, "u", "dm", "wrong", now + 1),
    /message|expired/i,
  );
  s.continue(n.id, "u", "dm", "m", now + 179999);
  assert.equal(s.search("g", "u").state, "searching");
  assert.equal(s.select("g", "u", lobby, now), null);
  assert.throws(
    () => s.continue(n.id, "u", "dm", "m", now + 179999),
    /expired|active|used/i,
  );
  const n2 = s.select("g", "u", { ...lobby, id: "second" }, now + 1);
  s.delivered(n2.id, "dm", "m2", now + 1);
  s.expire(now + 180001);
  assert.equal(s.search("g", "u").state, "stopped");
  assert.equal(s.rules("g", "u").length, 1);
  assert.throws(
    () => s.continue(n2.id, "u", "dm", "m2", now + 180001),
    /expired/i,
  );
  s.resume("g", "u", now + 180002);
  assert.equal(s.search("g", "u").state, "searching");
  sql.close();
});
test("rule removal, disabled settings and obsolete candidates invalidate pending work", () => {
  const { store: s, sql } = fixture();
  const rule = s.watch("g", "u", { name: "World", map: "World" }, now);
  const n = s.select("g", "u", lobby, now);
  s.obsolete(n.id, now);
  assert.equal(s.search("g", "u").state, "searching");
  s.remove("g", "u", rule.id, now);
  assert.equal(s.search("g", "u").state, "stopped");
  s.watch("g", "u", { name: "World", map: "World" }, now);
  s.configure("g", false, "c", now);
  assert.equal(s.search("g", "u").state, "stopped");
  assert.throws(() => s.resume("g", "u", now), /enabled/i);
  sql.close();
});

test("removing a filter does not restart stopped or waiting searches", () => {
  const { store: s, sql } = fixture();
  const first = s.watch("g", "u", { name: "first", map: "World" }, now);
  const second = s.watch("g", "u", { name: "second", mode: "Team" }, now);
  s.stop("g", "u", now);
  s.remove("g", "u", first.id, now);
  assert.equal(s.search("g", "u").state, "stopped");
  s.watch("g", "u", { name: "third", map: "World" }, now);
  const n = s.select("g", "u", lobby, now);
  s.delivered(n.id, "dm", "m", now);
  s.remove("g", "u", second.id, now);
  assert.equal(s.search("g", "u").state, "waiting");
  s.expire(now + 180000);
  assert.equal(s.search("g", "u").state, "stopped");
  sql.close();
});

test("a restart reads the same deadline and old controls cannot affect a replacement search", () => {
  const { store: s, sql } = fixture();
  s.watch("g", "u", { name: "World", map: "World" }, now);
  const n = s.select("g", "u", lobby, now);
  s.delivered(n.id, "dm", "m", now);
  const restarted = new LobbyStore(sql);
  assert.equal(restarted.search("g", "u").deadline, now + 180000);
  restarted.stop("g", "u", now + 1000);
  restarted.resume("g", "u", now + 1001);
  restarted.expire(now + 180000);
  assert.equal(restarted.search("g", "u").state, "searching");
  assert.throws(
    () => restarted.continue(n.id, "u", "dm", "m", now + 180001),
    /expired|used/,
  );
  assert.equal(restarted.search("g", "u").state, "searching");
  sql.close();
});
