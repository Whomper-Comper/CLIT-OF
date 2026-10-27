import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";

test("lobby retention uses ordered terminal and pending indexes", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const terminal = sql.prepare(`EXPLAIN QUERY PLAN
      SELECT id,source,lobby_id FROM lobby_notifications INDEXED BY lobby_notification_terminal_retention
      WHERE updated<? AND status IN ('sent','cancelled','review')
      AND (updated,id)>(?,?) ORDER BY updated,id LIMIT 200`).all(1, 0, "");
    const pending = sql.prepare(`EXPLAIN QUERY PLAN
      SELECT 1 FROM lobby_searches WHERE pending=?`).all("id");
    assert.match(terminal.map((row) => row.detail).join(" "), /lobby_notification_terminal_retention/);
    assert.doesNotMatch(terminal.map((row) => row.detail).join(" "), /TEMP B-TREE/);
    assert.match(pending.map((row) => row.detail).join(" "), /lobby_search_pending/);
  } finally {
    sql.close();
  }
});

test("protected old lobbies do not starve later eligible retention work", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const store = new LobbyStore(sql);
    const insert = sql.prepare(`INSERT INTO lobby_notifications
      (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const live = [];
    for (let i = 0; i < 202; i++) {
      insert.run(`n${i}`, "g", "u", "gen", 1, "s", `l${i}`, "{}", "sent", 0, i);
      if (i < 200) live.push({ source: "s", id: `l${i}` });
    }
    const now = 40 * 86400000;
    store.prune(now, live);
    assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM lobby_notifications").get().count, 202);
    store.prune(now, live);
    assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM lobby_notifications").get().count, 200);
    store.prune(now, []);
    assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM lobby_notifications").get().count, 0);
  } finally {
    sql.close();
  }
});

test("retention index upgrades are additive and repeatable on an existing database", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    sql.exec(`DROP INDEX lobby_notification_terminal_retention;
      DROP INDEX lobby_search_pending;
      INSERT INTO lobby_searches VALUES('g','u','gen','waiting','n',NULL,0);
      INSERT INTO lobby_notifications
        (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
        VALUES ('n','g','u','gen',1,'s','l','{}','sent',0,0);`);
    LobbyStore.initialize(sql);
    LobbyStore.initialize(sql);
    assert.equal(sql.prepare("SELECT pending FROM lobby_searches WHERE guild='g' AND user='u'").get().pending, "n");
    assert.equal(sql.prepare("SELECT status FROM lobby_notifications WHERE id='n'").get().status, "sent");
    assert.equal(sql.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type='index' AND name IN ('lobby_search_pending','lobby_notification_terminal_retention')`).get().count, 2);
  } finally {
    sql.close();
  }
});

test("retention cursor advances across equal timestamps and wraps after reopening", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const insert = sql.prepare(`INSERT INTO lobby_notifications
      (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const live = [];
    for (let i = 0; i < 201; i++) {
      const id = String(i).padStart(3, "0");
      insert.run(id, "g", "u", "gen", 1, "s", id, "{}", "sent", 0, 1);
      if (i < 200) live.push({ source: "s", id });
    }
    const now = 40 * 86400000;
    const store = new LobbyStore(sql);
    store.prune(now, live);
    store.prune(now, live);
    assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM lobby_notifications").get().count, 200);
    new LobbyStore(sql).prune(now, []);
    assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM lobby_notifications").get().count, 0);
  } finally {
    sql.close();
  }
});

test("pruning examines at most 200 terminal records and preserves live and pending alerts", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    LobbyStore.initialize(sql);
    const store = new LobbyStore(sql);
    const insert = sql.prepare(`INSERT INTO lobby_notifications
      (id,guild,user,generation,revision,source,lobby_id,lobby,status,next,updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (let i = 0; i < 202; i++) {
      insert.run(`n${i}`, "g", "u", "gen", 1, "s", `l${i}`, "{}", "sent", 0, i);
    }
    sql.prepare("INSERT INTO lobby_searches VALUES(?,?,?,'waiting',?,NULL,?)")
      .run("g", "u", "gen", "n1", 0);
    const now = 40 * 86400000;
    store.prune(now, [{ source: "s", id: "l0" }]);
    const remaining = sql.prepare("SELECT id FROM lobby_notifications ORDER BY updated").all().map((row) => row.id);
    assert.deepEqual(remaining, ["n0", "n1", "n200", "n201"]);
    store.prune(now, [{ source: "s", id: "l0" }]);
    assert.deepEqual(sql.prepare("SELECT id FROM lobby_notifications ORDER BY updated").all().map((row) => row.id), ["n0", "n1"]);
  } finally {
    sql.close();
  }
});
