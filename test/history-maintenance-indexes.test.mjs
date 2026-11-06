import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HistoryStore, DAY } from "../dist/historyStore.js";

const indexes = {
  history_player_inventory: ["history_player_matches", ["guild_id", "public_id", "discord_id"]],
  history_elo_inventory: ["history_observed_elo", ["guild_id", "public_id", "discord_id"]],
  history_coverage_retention: ["history_coverage", ["guild_id", "end"]],
  history_job_due: ["history_jobs", ["guild_id", "next_attempt"]],
};
const at = "2026-10-16T12:00:00.000Z", now = Date.parse(at);
const tables = ["history_player_matches", "history_observed_elo", "history_jobs", "history_coverage", "history_clan_matches", "history_weekly_deliveries"];
const snapshot = db => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
const dropIndexes = db => db.exec(Object.keys(indexes).map(name => `DROP INDEX IF EXISTS ${name}`).join(";"));
const rows = (db, table, columns) => db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${columns}`).all().map(row => Object.values(row));

function tracedStore(db) {
  const calls = [];
  const history = new HistoryStore({ prepare(sql) {
    const statement = db.prepare(sql);
    return Object.fromEntries(["all", "get", "run", "iterate"].map(method => [method, (...parameters) => {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map(row => row.detail);
      const result = statement[method](...parameters);
      calls.push({ sql, parameters, plan, result });
      return result;
    }]));
  } });
  return { history, calls };
}

function seedMembership(db) {
  const match = db.prepare("INSERT INTO history_player_matches VALUES(?,?,?,?,?,?)");
  const elo = db.prepare("INSERT INTO history_observed_elo VALUES(?,?,?,'1v1',?,?,1000)");
  const history = new HistoryStore(db);
  for (const guild of ["g", "other"]) {
    for (const [publicId, discordId] of [["kept", "member"], ["orphan-match", "gone"], ["replaced", "member"], ["multi", "old"], ["multi", "current"]])
      match.run(guild, publicId, discordId, `game-${discordId}`, at, "{}");
    for (const [i, publicId, discordId] of [[1, "kept", "member"], [2, "orphan-elo", "gone"], [3, "multi", "old"], [4, "multi", "current"], [5, "multi", null], [6, "public", null]])
      elo.run(guild, publicId, discordId, i, at);
    history.ensureJob(guild, "player", "job-only", now, "gone", "version");
    history.ensureJob(guild, "player", "kept", now, "member", "version");
    history.ensureJob(guild, "player", "multi", now, "current", "version");
    history.ensureJob(guild, "clan", "MARS", now);
    const checkpoint = history.getJob(guild, "player", "kept");
    history.advancePage(checkpoint, "checkpoint", 7);
    history.retryJob(checkpoint, "temporary failure", now);
    for (const subject of ["kept", "orphan-match", "orphan-elo", "job-only", "multi", "replaced"])
      history.markCoverage({ guild_id: guild, kind: "player", subject, window_start: at, window_end: "2026-10-17T12:00:00.000Z" }, now);
  }
}

test("maintenance indexes upgrade retained data idempotently inside the existing migration transaction", () => {
  const db = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(db);
    dropIndexes(db);
    seedMembership(db);
    const before = snapshot(db);
    db.exec("BEGIN IMMEDIATE");
    HistoryStore.initialize(db);
    for (const [name, [table, columns]] of Object.entries(indexes)) {
      assert.deepEqual(db.prepare(`PRAGMA index_info(${name})`).all().map(row => row.name), columns, name);
      const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=? AND tbl_name=?").get(name, table)?.sql;
      assert.ok(sql, name);
      if (name === "history_elo_inventory") assert.match(sql, /WHERE discord_id IS NOT NULL/i);
    }
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?))").get(JSON.stringify(Object.keys(indexes))).count, 0);
    assert.deepEqual(snapshot(db), before, "migration rollback retains existing history");
    HistoryStore.initialize(db);
    HistoryStore.initialize(db);
    assert.deepEqual(snapshot(db), before, "reopening preserves matches, Elo, coverage and retry checkpoints");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { db.close(); }
});

test("covering membership inventories preserve orphan cleanup, multiple associations and public Elo", () => {
  const results = [];
  for (const indexed of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      HistoryStore.initialize(db);
      if (!indexed) dropIndexes(db);
      seedMembership(db);
      const untouched = snapshot(db).map(table => table.filter(row => row.guild_id === "other"));
      const { history, calls } = tracedStore(db);
      history.prunePlayerMembers("g", [{ discord_id: "member", openfront_id: "kept" }, { discord_id: "current", openfront_id: "multi" }]);
      const inventory = calls.find(call => call.sql.includes("UNION SELECT subject AS public_id"));
      assert.deepEqual(inventory.result.map(row => [row.public_id, row.discord_id]), [
        ["job-only", "gone"], ["kept", "member"], ["multi", "current"], ["multi", "old"],
        ["orphan-elo", "gone"], ["orphan-match", "gone"], ["replaced", "member"],
      ]);
      assert.deepEqual(rows(db, "history_player_matches", "guild_id,public_id,discord_id").filter(row => row[0] === "g"), [["g", "kept", "member"]]);
      assert.deepEqual(rows(db, "history_observed_elo", "guild_id,public_id,discord_id").filter(row => row[0] === "g"), [
        ["g", "kept", "member"], ["g", "multi", null], ["g", "multi", "current"], ["g", "public", null],
      ]);
      assert.deepEqual(rows(db, "history_jobs", "guild_id,kind,subject").filter(row => row[0] === "g"), [["g", "clan", "MARS"], ["g", "player", "kept"]]);
      assert.deepEqual(rows(db, "history_coverage", "guild_id,subject").filter(row => row[0] === "g"), [["g", "kept"]]);
      assert.deepEqual(snapshot(db).map(table => table.filter(row => row.guild_id === "other")), untouched);
      results.push({ data: snapshot(db), plan: inventory.plan });
    } finally { db.close(); }
  }
  assert.deepEqual(results[1].data, results[0].data, "indexes preserve all pruning results");
  for (const name of ["history_player_inventory", "history_elo_inventory"])
    assert.ok(results[1].plan.some(detail => detail.includes(`COVERING INDEX ${name}`)), JSON.stringify(results[1].plan));
});

function seedRetention(db) {
  const history = new HistoryStore(db), cutoff = "2026-10-02T00:00:00.000Z";
  for (const guild of ["g", "other"]) {
    for (const [label, instant] of [["before", Date.parse(cutoff) - 1], ["boundary", Date.parse(cutoff)], ["after", Date.parse(cutoff) + 1]]) {
      const time = new Date(instant).toISOString();
      db.prepare("INSERT INTO history_player_matches VALUES(?,?,?,?,?,?)").run(guild, label, "member", label, time, "{}");
      db.prepare("INSERT INTO history_clan_matches VALUES(?,'MARS',?,?,?)").run(guild, label, time, "{}");
      for (const kind of ["clan", "player"])
        history.markCoverage({ guild_id: guild, kind, subject: label, window_start: "2026-10-01T00:00:00.000Z", window_end: time }, now);
      db.prepare("INSERT INTO history_weekly_deliveries(guild_id,period_start,period_end,channel_id,nonce,status) VALUES(?,'2026-09-01',?,'123',?,'sent')").run(guild, time, label);
      const eloTime = new Date(now - 14 * DAY + instant - Date.parse(cutoff)).toISOString();
      db.prepare("INSERT INTO history_observed_elo VALUES(?,?,NULL,'1v1',1,?,1000)").run(guild, label, eloTime);
      history.ensureJob(guild, "player", label, now, "member", "version");
      db.prepare("UPDATE history_jobs SET window_start=?,window_end=?,page=4,cursor='cursor',attempts=2,last_error='retry',next_attempt=123 WHERE guild_id=? AND subject=?").run(time, at, guild, label);
    }
  }
  return cutoff;
}

test("indexed retention keeps strict cutoff boundaries, retry state and unrelated guilds", () => {
  const results = [];
  for (const indexed of [false, true]) {
    const db = new DatabaseSync(":memory:");
    try {
      HistoryStore.initialize(db);
      if (!indexed) dropIndexes(db);
      const cutoff = seedRetention(db);
      const untouched = snapshot(db).map(table => table.filter(row => row.guild_id === "other"));
      const { history, calls } = tracedStore(db);
      history.retain("g", 14, now);
      for (const [table, identity] of [["history_player_matches", "public_id"], ["history_observed_elo", "public_id"], ["history_clan_matches", "game_id"], ["history_weekly_deliveries", "nonce"]])
        assert.deepEqual(db.prepare(`SELECT ${identity} AS identity FROM ${table} WHERE guild_id='g' ORDER BY ${identity}`).all().map(row => row.identity), ["after", "boundary"], table);
      assert.deepEqual(rows(db, "history_coverage", "guild_id,kind,subject").filter(row => row[0] === "g"), [
        ["g", "clan", "after"], ["g", "clan", "boundary"], ["g", "player", "after"], ["g", "player", "boundary"],
      ]);
      const clamped = history.getJob("g", "player", "before");
      assert.equal(clamped.window_start, cutoff);
      assert.equal(clamped.window_end, "2026-10-03T00:00:00.000Z");
      assert.equal(clamped.page, 1); assert.equal(clamped.cursor, null);
      assert.equal(clamped.attempts, 2); assert.equal(clamped.last_error, "retry"); assert.equal(clamped.next_attempt, 123);
      assert.equal(history.getJob("g", "player", "boundary").page, 4);
      assert.deepEqual(snapshot(db).map(table => table.filter(row => row.guild_id === "other")), untouched);
      results.push({ data: snapshot(db), plan: calls.find(call => call.sql.startsWith("DELETE FROM history_coverage")).plan });
    } finally { db.close(); }
  }
  assert.deepEqual(results[1].data, results[0].data);
  assert.ok(results[1].plan.some(detail => /history_coverage_retention.*guild_id=\?.*end<\?/.test(detail)), JSON.stringify(results[1].plan));
});

test("due admission preserves inclusive deadlines, multi-guild fairness, clan-only gating and retries", () => {
  const db = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(db);
    const history = new HistoryStore(db);
    for (const [guild, kind, subject, deadline, work] of [
      ["a", "clan", "A", now, 1], ["a", "clan", "B", now - 1, 1], ["a", "player", "A", now, 1],
      ["b", "clan", "A", now, 1], ["b", "player", "first", now, 0],
      ["a", "player", "future", now + 1, -1], ["excluded", "clan", "hidden", 0, -2],
    ]) {
      history.ensureJob(guild, kind, subject, now, kind === "player" ? "member" : null, "version");
      db.prepare("UPDATE history_jobs SET next_attempt=?,last_work=?,page=5,cursor='saved',attempts=2,last_error='saved error' WHERE guild_id=? AND kind=? AND subject=?").run(deadline, work, guild, kind, subject);
    }
    const key = job => job && `${job.guild_id}:${job.kind}:${job.subject}`;
    assert.equal(history.nextJob(now, []), null);
    assert.equal(history.nextJob(now - 2, ["a", "b"]), null);
    assert.equal(key(history.nextJob(now, ["b", "a"])), "b:player:first");
    assert.equal(key(history.nextJob(now, ["b", "a"], false)), "a:clan:A");
    assert.equal(key(history.nextJob(now - 1, ["a", "b"])), "a:clan:B");
    const selected = [];
    for (let i = 0; i < 5; i++) {
      const job = history.nextJob(now, ["b", "a"]);
      selected.push(key(job));
      assert.equal(job.page, 5); assert.equal(job.cursor, "saved"); assert.equal(job.attempts, 2);
      history.touchJob(job);
    }
    assert.deepEqual(selected, ["b:player:first", "a:clan:A", "a:clan:B", "a:player:A", "b:clan:A"]);
    assert.equal(key(history.nextJob(now + 1, ["a", "b"])), "a:player:future");
    const retried = history.getJob("a", "clan", "A");
    history.retryJob(retried, "temporary", now);
    assert.equal(history.getJob("a", "clan", "A").next_attempt, now + 240_000);
    assert.equal(key(history.nextJob(now, ["a", "b"], false)), "a:clan:B");
  } finally { db.close(); }
});

test("sparse due admission searches the guild and next_attempt range", () => {
  const db = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(db);
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<999)
      INSERT INTO history_jobs(guild_id,kind,subject,window_start,window_end,next_attempt,last_work)
      SELECT 'g','player','p'||x,'2026-10-01','2026-10-02',9999999999999,x FROM n;
      UPDATE history_jobs SET next_attempt=${now} WHERE subject='p999';`);
    const { history, calls } = tracedStore(db);
    assert.equal(history.nextJob(now, ["g"]).subject, "p999");
    assert.ok(calls[0].plan.some(detail => /history_job_due.*guild_id=\?.*next_attempt<\?/.test(detail)), JSON.stringify(calls[0].plan));
    db.exec("UPDATE history_jobs SET next_attempt=0");
    assert.equal(history.nextJob(now, ["g"]).subject, "p0", "all-due backfill retains last_work order");
    assert.equal(history.nextJob(now, ["g"], false), null);
  } finally { db.close(); }
});
