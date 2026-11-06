import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";

const now = 1_900_000_000_000;
const active = ["pending_dm", "pending_fallback", "sending_dm", "sending_fallback"];
const statuses = [...active, "sent", "cancelled", "review"];
const oldIndex = "CREATE INDEX lobby_notification_due ON lobby_notifications(status,next,updated)";
const columns = sql => sql.prepare("PRAGMA index_info(lobby_notification_due)").all().map(row => row.name);
const snapshot = sql => ["lobby_settings", "lobby_rules", "lobby_searches", "lobby_notifications"].map(
  table => sql.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
);
const schemaVersion = sql => sql.prepare("PRAGMA schema_version").get().schema_version;

function insertNotification(sql) {
  const statement = sql.prepare(`INSERT INTO lobby_notifications
    (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
    VALUES(?,?,?,'generation',7,'source',?,'{}',?,?,?)`);
  return (id, status, next = now, updated = now, guild = "g", user = id) =>
    statement.run(id, guild, user, id, status, next, updated);
}

// Capture the statement emitted by the real due() method. The instrumented copy
// only adds a nondeterministic always-true predicate; it retains the real order,
// status predicate, bound cutoff and limit, and never hints the planner.
function measureDue(sql, cutoff) {
  let query;
  const store = new LobbyStore({ prepare(text) {
    query = text;
    return sql.prepare(text);
  } });
  const notifications = store.due(cutoff);
  const plan = sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(cutoff).map(row => row.detail);
  let visits = 0;
  sql.function("due_probe", (_id) => { visits++; return 1; });
  const instrumented = query.replace(/ ORDER BY/, " AND due_probe(id) ORDER BY");
  assert.notEqual(instrumented, query, "instrument the actual due selector");
  const probePlan = sql.prepare(`EXPLAIN QUERY PLAN ${instrumented}`).all(cutoff).map(row => row.detail);
  const probed = sql.prepare(instrumented).all(cutoff);
  assert.deepEqual(probePlan, plan, "instrumentation retains production planner choices");
  assert.deepEqual(probed.map(row => row.id), notifications.map(row => row.id));
  return { notifications, visits, plan };
}

test("due lookup bounds candidate work for 20,000 timestamp ties while preserving ID order", t => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const insert = insertNotification(sql);
    sql.exec("BEGIN");
    for (let i = 0; i < 20_000; i++)
      insert(`n${String(20_000 - i).padStart(6, "0")}`, active[i % 4]);
    sql.exec("COMMIT");
    const indexed = measureDue(sql, now);
    assert.deepEqual(indexed.notifications.map(row => row.id), ["n000001", "n000002", "n000003", "n000004"]);
    assert.ok(indexed.visits <= 32, `ordered index must stop early, visited ${indexed.visits}`);
    assert.ok(indexed.plan.some(detail => /USING INDEX lobby_notification_due/.test(detail)));
    // A negative control makes the work assertion sensitive to a missing index.
    sql.exec("DROP INDEX lobby_notification_due");
    const absent = measureDue(sql, now);
    assert.deepEqual(absent.notifications, indexed.notifications);
    assert.equal(absent.visits, 20_000);
    sql.exec(oldIndex);
    const legacy = measureDue(sql, now);
    assert.deepEqual(legacy.notifications, indexed.notifications);
    assert.equal(legacy.visits, 20_000);
    t.diagnostic(JSON.stringify({ indexed: indexed.visits, absent: absent.visits, legacy: legacy.visits, plan: indexed.plan }));
  } finally { sql.close(); }
});

test("due lookup preserves all recovery statuses and bounded work across 100,000 mixed rows", t => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    sql.exec(`DROP INDEX lobby_notification_due; ${oldIndex}`);
    const insert = insertNotification(sql);
    sql.exec("BEGIN");
    for (let i = 0; i < 100_000; i++)
      insert(`n${String(100_000 - i).padStart(6, "0")}`, statuses[i % 7],
        i % 5 === 0 ? now + 1 : now - i % 10, now - i % 3, `g${i % 17}`, `u${i}`);
    sql.exec("COMMIT");
    const cutoffs = [now - 10, now - 1, now, now + 1];
    const legacy = cutoffs.map(cutoff => measureDue(sql, cutoff));
    LobbyStore.initialize(sql);
    const upgraded = cutoffs.map(cutoff => measureDue(sql, cutoff));
    for (let i = 0; i < cutoffs.length; i++) {
      assert.deepEqual(upgraded[i].notifications, legacy[i].notifications);
      assert.ok(upgraded[i].visits <= 32, `cutoff ${cutoffs[i]} visited ${upgraded[i].visits}`);
    }
    assert.deepEqual(upgraded[0].notifications, []);
    assert.equal(upgraded[0].visits, 0);
    for (const result of upgraded.slice(1)) {
      assert.deepEqual(result.notifications.map(row => row.id), ["n000011", "n000101", "n000131", "n000191"]);
      assert.deepEqual(result.notifications.map(row => row.status), ["pending_fallback", "sending_dm", "pending_dm", "sending_fallback"]);
    }
    assert.ok(legacy[2].visits > 40_000);
    assert.ok(upgraded[2].plan.some(detail => /USING INDEX lobby_notification_due/.test(detail)));
    t.diagnostic(JSON.stringify({ legacy: legacy.map(row => row.visits), upgraded: upgraded.map(row => row.visits), plan: upgraded[2].plan }));
  } finally { sql.close(); }
});

test("inclusive due cutoff keeps validation and obsolete handling after bounded selection", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const store = new LobbyStore(sql), insert = insertNotification(sql);
    sql.exec("INSERT INTO lobby_settings VALUES('g',1,'channel',7)");
    insert("a-terminal", "sent", now - 1);
    for (const [i, status] of active.entries()) {
      const id = `n${i}`;
      insert(id, status);
      sql.prepare("INSERT INTO lobby_searches VALUES('g',?,'generation','delivering',?,NULL,?)").run(id, id, now - 100);
    }
    insert("z-future", "pending_dm", now + 1);
    assert.deepEqual(store.due(now - 1), []);
    const due = store.due(now);
    assert.deepEqual(due.map(row => row.id), ["n0", "n1", "n2", "n3"]);
    assert.deepEqual(due.map(row => row.status), active);
    assert.ok(due.every(row => store.valid(row)));
    sql.exec("UPDATE lobby_searches SET generation='replaced' WHERE user='n0'");
    assert.equal(store.valid(due[0]), false);
    store.obsolete("n0", now);
    assert.equal(store.notification("n0"), null);
    assert.equal(store.search("g", "n0").generation, "replaced");
    assert.ok(due.slice(1).every(row => store.valid(row)));
    store.obsolete("n2", now);
    assert.equal(store.notification("n2").status, "sending_dm", "retain uncertain-send recovery evidence");
    sql.exec("UPDATE lobby_settings SET revision=8 WHERE guild='g'");
    assert.ok(due.slice(1).every(row => !store.valid(row)));
  } finally { sql.close(); }
});

test("legacy due index upgrade preserves rows and checkpoints, rolls back, and avoids repeat rewrites", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    sql.exec(`DROP INDEX lobby_notification_due; ${oldIndex};
      CREATE TABLE custom_state(value TEXT);
      INSERT INTO custom_state VALUES('keep');
      CREATE INDEX custom_notification_lookup ON lobby_notifications(source,user);
      INSERT INTO lobby_settings VALUES('g',1,'channel',7);
      INSERT INTO lobby_rules VALUES('rule','g','u','{"name":"World","map":"World"}');`);
    const insert = insertNotification(sql);
    for (const status of statuses) insert(status, status, now - 5, now - 10);
    sql.exec(`UPDATE lobby_notifications SET attempts=2,message='message',channel='channel',deadline=${now + 180000},error='retry checkpoint';
      INSERT INTO lobby_searches VALUES('g','u','generation','delivering','sending_dm',NULL,${now - 500});
      INSERT INTO lobby_searches VALUES('g','waiting','generation','waiting','sent',${now + 180000},${now - 1000});`);
    const before = snapshot(sql);
    const customSchema = sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'custom_%' ORDER BY name").all();
    sql.exec("BEGIN IMMEDIATE");
    LobbyStore.initialize(sql);
    assert.deepEqual(columns(sql), ["status", "next", "updated", "id"]);
    sql.exec("ROLLBACK");
    assert.deepEqual(columns(sql), ["status", "next", "updated"]);
    assert.deepEqual(snapshot(sql), before);

    // Mimic BotDatabase's existing initialization transaction, injecting a later
    // initialization failure after the replacement completed.
    assert.throws(() => {
      sql.exec("BEGIN IMMEDIATE");
      try {
        LobbyStore.initialize(sql);
        sql.exec("SELECT missing_initialization_function()");
        sql.exec("COMMIT");
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    }, /missing_initialization_function/);
    assert.deepEqual(columns(sql), ["status", "next", "updated"]);
    assert.deepEqual(snapshot(sql), before);

    LobbyStore.initialize(sql);
    assert.deepEqual(columns(sql), ["status", "next", "updated", "id"]);
    const version = schemaVersion(sql);
    LobbyStore.initialize(sql);
    LobbyStore.initialize(sql);
    assert.equal(schemaVersion(sql), version, "unchanged initialization does not drop/recreate indexes");
    assert.deepEqual(snapshot(sql), before);
    assert.deepEqual(sql.prepare("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'custom_%' ORDER BY name").all(), customSchema);
    assert.equal(sql.prepare("SELECT value FROM custom_state").get().value, "keep");
    assert.equal(sql.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { sql.close(); }
});

test("fresh initialization creates the ordered index once and preserves custom same-name definitions", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    assert.deepEqual(columns(sql), ["status", "next", "updated", "id"]);
    const version = schemaVersion(sql);
    LobbyStore.initialize(sql);
    assert.equal(schemaVersion(sql), version);
    for (const definition of [
      "ON lobby_notifications(status,next,updated) WHERE status='pending_dm'",
      "ON lobby_notifications(status,next DESC,updated)",
      "ON lobby_notifications(status COLLATE NOCASE,next,updated)",
      "ON lobby_notifications(next,updated)",
    ]) {
      sql.exec(`DROP INDEX lobby_notification_due; CREATE INDEX lobby_notification_due ${definition}`);
      const before = sql.prepare("SELECT sql FROM sqlite_schema WHERE name='lobby_notification_due'").get().sql;
      const version = schemaVersion(sql);
      LobbyStore.initialize(sql);
      assert.equal(sql.prepare("SELECT sql FROM sqlite_schema WHERE name='lobby_notification_due'").get().sql, before);
      assert.equal(schemaVersion(sql), version);
    }
  } finally { sql.close(); }
});
