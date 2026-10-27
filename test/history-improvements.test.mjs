import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { HistoryStore } = await import("../dist/historyStore.js");
const { BotDatabase, db: singleton } = await import("../dist/db.js");
const { HistoryCollector } = await import("../dist/historyCollector.js");
after(() => singleton.close());
const at = "2026-10-16T12:00:00.000Z", now = Date.parse(at);
const clan = gameId => ({gameId,clanTag:"MARS",gameStart:at,clanPlayerCount:2,hasWon:true,numTeams:2,playerTeams:"2",totalPlayerCount:20,score:1});
const player = gameId => ({gameId,gameStart:at,gameEnd:at,gameType:"Public",gameMode:"Team",gameRankedType:"Unranked",clientId:"client",username:"Player",clanTag:"MARS",hasWon:true});

test("listing history settings reads all guilds in one query without changing their values", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(raw);
    const insert = raw.prepare(`INSERT INTO history_settings (guild_id,revision,collection_enabled,poll_minutes,weekly_since)
      VALUES (?,?,?,?,?)`);
    for (let i=0; i<100; i++) insert.run(`guild-${i}`,i+1,i%2,5+i,"2026-01-01T00:00:00.000Z");
    let queries = 0;
    const history = new HistoryStore({ prepare(sql) { queries++; return raw.prepare(sql); } });
    const listed = history.listSettings();
    assert.equal(queries,1);
    const baseline = new HistoryStore(raw);
    assert.deepEqual(listed.map(row=>row.guild_id).sort(),Array.from({length:100},(_,i)=>`guild-${i}`).sort());
    for (const row of listed) assert.deepEqual(row,baseline.getSettings(row.guild_id));
  } finally { raw.close(); }
});

for (const kind of ["clan", "player"]) for (const outerTransaction of [false,true]) test(`${kind} page failure rolls back corrections and additions ${outerTransaction ? "inside its caller transaction" : "without a caller transaction"}`, () => {
  const raw = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(raw);
    const history = new HistoryStore(raw);
    const save = rows => kind === "clan" ? history.upsertClanMatches("g","MARS",rows) : history.upsertPlayerMatches("g","public","discord",rows);
    const read = () => kind === "clan" ? history.getClanMatches("g","MARS","2000","2100") : history.getPlayerMatches("g","2000","2100");
    const row = kind === "clan" ? clan : player;
    save([row("original")]);
    if (outerTransaction) {
      raw.exec("BEGIN IMMEDIATE");
      history.setMeta("outer","kept");
    }
    assert.throws(() => save([{...row("original"),hasWon:false},row("new"),{...row("bad"),gameStart:"invalid"}]), RangeError);
    assert.deepEqual(read().map(match=>[match.gameId,match.hasWon]), [["original",true]]);
    save([row("nested")]);
    if (outerTransaction) {
      // Successful nested pages still belong to the caller's transaction.
      assert.equal(history.getMeta("outer"),"kept");
      raw.exec("ROLLBACK");
      assert.equal(history.getMeta("outer"),null);
      assert.deepEqual(read().map(match=>match.gameId), ["original"]);
    } else {
      assert.deepEqual(read().map(match=>match.gameId), ["nested","original"]);
      // A standalone page commits instead of leaving a transaction open.
      raw.exec("BEGIN IMMEDIATE; ROLLBACK");
    }
  } finally { raw.close(); }
});

test("player deletion queries use indexed searches across guilds", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(raw);
    for (const query of ["DELETE FROM history_player_matches WHERE public_id=?", "DELETE FROM history_jobs WHERE kind='player' AND subject=?", "DELETE FROM history_coverage WHERE kind='player' AND subject=?"]) {
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all("public");
      assert.ok(plan.every(row=>!row.detail.startsWith("SCAN ")), `${query}: ${JSON.stringify(plan)}`);
    }
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT MAX(last_work) FROM history_jobs").all();
    assert.ok(plan.some(row=>row.detail.includes("INDEX")), JSON.stringify(plan));
  } finally {raw.close();}
});

test("Elo retention uses the caller's captured clock at its exact boundary", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(raw);
    const history = new HistoryStore(raw), captured = Date.parse("2020-04-01T00:00:00.000Z");
    history.recordElo("g","public","discord","1v1",900,Date.parse("2020-01-01T23:59:59.999Z"));
    history.recordElo("g","public","discord","1v1",1000,Date.parse("2020-01-02T00:00:00.000Z"));
    assert.deepEqual(history.getEloHistory("g","public","1v1","2020-01-01T00:00:00.000Z","2020-04-02T00:00:00.000Z",captured), [{at:"2020-01-02T00:00:00.000Z",rating:1000}]);
  } finally {raw.close();}
});

test("leaderboard collection checks current identities only for IDs present on its page", async () => {
  const db = new BotDatabase(":memory:");
  let collector;
  try {
    const defaults = db.history.getSettings("g");
    db.history.saveSettings("g",{...defaults,collection_enabled:1,clan_history_enabled:0},0);
    db.linkGuildUser("g","manager","one","public-one","One");
    db.linkGuildUser("g","manager","two","public-two","Two");
    db.history.setMeta("deletions_last_success",at);
    const members = new Map([["one",{user:{bot:false}}],["two",{user:{bot:false}}]]);
    const guild = {id:"g",members:{cache:members,fetch:async()=>members}};
    let identityReads=0;
    const original = db.getEffectiveLink.bind(db);
    db.getEffectiveLink = (...args) => {identityReads++;return original(...args);};
    collector = new HistoryCollector({guilds:{cache:new Map([["g",guild]])}},db,{
      getRankedLeaderboardPage:async()=>({ratings:[{publicId:"public-one",ladder:"1v1",rating:1200,rank:1},{publicId:"public-one",ladder:"ffa",rating:1250,rank:1}],hasMore:false,observedAt:at}),
    },{now:()=>now,maxRequestsPerTick:3});
    await collector.collectOnce();
    assert.equal(identityReads,1);
    assert.equal(db.history.getStatus("g").eloObservations,2);
  } finally {await collector?.stop();db.close();}
});
