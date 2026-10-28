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

function selectedFixture() {
  const { sql, store } = fixture();
  store.watch("g", "u", { name: "World", map: "World" }, now);
  const notification = store.select("g", "u", lobby, now);
  const statements = [];
  const counted = new LobbyStore({
    prepare(statement) {
      statements.push(statement);
      return sql.prepare(statement);
    },
    exec(statement) { return sql.exec(statement); },
  });
  return { sql, store: counted, notification, statements };
}

test("delivery validation uses one current-state query", () => {
  const f = selectedFixture();
  try {
    assert.equal(f.store.valid(f.notification), true);
    assert.equal(f.statements.length, 1);
  } finally { f.sql.close(); }
});

for (const fallback of [false, true]) {
  test(`beginning ${fallback ? "fallback" : "DM"} delivery uses one guarded write`, () => {
    const f = selectedFixture();
    try {
      if (fallback) f.store.rejected(f.notification.id, now);
      f.statements.length = 0;
      assert.equal(f.store.begin(f.notification.id, fallback, now + 1), true);
      assert.equal(f.statements.length, 1);
      const saved = f.sql.prepare("SELECT status,updated FROM lobby_notifications WHERE id=?").get(f.notification.id);
      assert.deepEqual({ ...saved }, { status: fallback ? "sending_fallback" : "sending_dm", updated: now + 1 });
      assert.equal(f.store.begin(f.notification.id, fallback, now + 2), false);
      assert.equal(f.sql.prepare("SELECT updated FROM lobby_notifications WHERE id=?").get(f.notification.id).updated, now + 1);
    } finally { f.sql.close(); }
  });
}

const invalidDeliveryStates = [
  ["missing search", "DELETE FROM lobby_searches"],
  ["stopped search", "UPDATE lobby_searches SET state='stopped'"],
  ["changed pending binding", "UPDATE lobby_searches SET pending='other'"],
  ["changed generation", "UPDATE lobby_searches SET generation='other'"],
  ["missing settings", "DELETE FROM lobby_settings"],
  ["disabled settings", "UPDATE lobby_settings SET enabled=0"],
  ["changed settings revision", "UPDATE lobby_settings SET revision=revision+1"],
  ["missing notification", "DELETE FROM lobby_notifications"],
  ["terminal notification", "UPDATE lobby_notifications SET status='sent'"],
];
for (const [name, mutate] of invalidDeliveryStates) {
  for (const fallback of [false, true]) {
    test(`${name} rejects validation and ${fallback ? "fallback" : "DM"} send activation`, () => {
      const f = selectedFixture();
      try {
        if (fallback) f.store.rejected(f.notification.id, now);
        f.sql.exec(mutate);
        const before = f.sql.prepare("SELECT * FROM lobby_notifications").all();
        assert.equal(f.store.valid(f.notification), false);
        assert.equal(f.store.begin(f.notification.id, fallback, now + 1), false);
        assert.deepEqual(f.sql.prepare("SELECT * FROM lobby_notifications").all(), before);
      } finally { f.sql.close(); }
    });
  }
}

test("validation checks the supplied owner, generation and settings snapshot", () => {
  const f = selectedFixture();
  try {
    for (const changed of [
      { id: "other" }, { guild: "other" }, { user: "other" },
      { generation: "other" }, { revision: 2 },
    ]) assert.equal(f.store.valid({ ...f.notification, ...changed }), false);
    assert.equal(f.store.valid(f.notification), true);
  } finally { f.sql.close(); }
});

test("active delivery statuses remain valid while only the matching pending lane can begin", () => {
  for (const [status, dm, fallback] of [
    ["pending_dm", true, false], ["pending_fallback", false, true],
    ["sending_dm", false, false], ["sending_fallback", false, false],
  ]) {
    for (const lane of [false, true]) {
      const f = selectedFixture();
      try {
        f.sql.prepare("UPDATE lobby_notifications SET status=?").run(status);
        assert.equal(f.store.valid(f.notification), true, status);
        assert.equal(f.store.begin(f.notification.id, lane, now + 1), lane ? fallback : dm, status);
      } finally { f.sql.close(); }
    }
  }
});

test("due delivery reads one bounded ordered batch without per-notification queries", () => {
  const f = selectedFixture();
  try {
    f.sql.exec("DELETE FROM lobby_notifications");
    const insert = f.sql.prepare(`INSERT INTO lobby_notifications
      (id,guild,user,generation,revision,source,lobby_id,lobby,status,attempts,next,message,channel,deadline,error,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const rows = [
      ["tie-z", "pending_dm", 2, 3], ["tie-a", "sending_dm", 2, 3],
      ["older", "pending_fallback", 2, 2], ["first", "sending_fallback", 1, 4],
      ["later", "pending_dm", 3, 0], ["terminal", "sent", 0, 0],
      ["future", "pending_dm", now + 1, 0],
    ];
    for (const [id, status, next, updated] of rows)
      insert.run(id, "g", "u", "generation", 7, lobby.source, id, JSON.stringify(lobby),
        status, 2, next, "message", "channel", 123, "saved error", updated);
    const due = f.store.due(now);
    assert.equal(f.statements.length, 1);
    assert.deepEqual(due.map(n => n.id), ["first", "older", "tie-a", "tie-z"]);
    assert.deepEqual(due[0], {
      id: "first", guild: "g", user: "u", generation: "generation", revision: 7,
      lobby, status: "sending_fallback", attempts: 2, next: 1,
      message: "message", channel: "channel", deadline: 123, error: "saved error",
    });
  } finally { f.sql.close(); }
});

test("diagnostics reads one five-row guild-scoped review batch", () => {
  const f = selectedFixture();
  try {
    f.sql.exec("DELETE FROM lobby_notifications");
    const insert = f.sql.prepare(`INSERT INTO lobby_notifications
      (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 8; i++)
      insert.run(`review-${i}`, "g", "u", "generation", 1, lobby.source, `review-${i}`,
        JSON.stringify(lobby), "review", now, i);
    insert.run("other-guild", "other", "u", "generation", 1, lobby.source, "other",
      JSON.stringify(lobby), "review", now, 100);
    insert.run("pending", "g", "u", "generation", 1, lobby.source, "pending",
      JSON.stringify(lobby), "pending_dm", now, 100);
    const jobs = f.store.diagnostics("g");
    assert.equal(f.statements.length, 1);
    assert.deepEqual(jobs.map(n => n.id), ["review-7", "review-6", "review-5", "review-4", "review-3"]);
    assert.deepEqual(jobs[0], {
      id: "review-7", guild: "g", user: "u", generation: "generation", revision: 1,
      lobby, status: "review", attempts: 0, next: now,
      message: null, channel: null, deadline: null, error: null,
    });
  } finally { f.sql.close(); }
});
