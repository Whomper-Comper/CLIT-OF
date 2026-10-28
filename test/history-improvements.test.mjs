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

test('batched coverage preserves overlapping intervals, gaps, clipping and subject isolation in one indexed read', () => {
  const raw = new DatabaseSync(':memory:');
  try {
    HistoryStore.initialize(raw);
    const history = new HistoryStore(raw), start = '2026-10-12T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
    const add = (subject, from, until, guild = 'g', kind = 'player') => history.markCoverage({
      guild_id: guild, kind, subject, window_start: from, window_end: until }, now);
    add('complete', '2026-10-11T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
    add('complete', '2026-10-13T00:00:00.000Z', '2026-10-17T00:00:00.000Z');
    add('complete', '2026-10-17T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
    add('gap', start, '2026-10-14T00:00:00.000Z');
    add('gap', '2026-10-15T00:00:00.000Z', end);
    add('tail', start, '2026-10-18T00:00:00.000Z');
    add('outside', '2026-10-11T00:00:00.000Z', start);
    add('outside', end, '2026-10-20T00:00:00.000Z');
    add('gap', start, end, 'other');
    add('gap', start, end, 'g', 'clan');
    const plans = [];
    let reads = 0;
    const counted = new HistoryStore({ prepare(query) {
      reads++;
      const statement = raw.prepare(query);
      return { iterate(...parameters) {
        plans.push(...raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map(row => row.detail));
        return statement.iterate(...parameters);
      } };
    } });
    const coverage = counted.getCoverageBySubject('g', 'player', ['complete', 'gap', 'tail', 'missing', 'outside', 'complete'], start, end);
    assert.deepEqual([...coverage], [
      ['complete', { complete: true, coveredDays: 7, totalDays: 7 }],
      ['gap', { complete: false, coveredDays: 6, totalDays: 7 }],
      ['tail', { complete: false, coveredDays: 6, totalDays: 7 }],
      ['missing', { complete: false, coveredDays: 0, totalDays: 7 }],
      ['outside', { complete: false, coveredDays: 0, totalDays: 7 }],
    ]);
    assert.equal(reads, 1);
    assert.ok(plans.some(detail => /SEARCH history_coverage.*guild_id=\?.*kind=\?.*subject=\?/.test(detail)), JSON.stringify(plans));
    assert.ok(plans.every(detail => !/SCAN history_coverage/.test(detail)), JSON.stringify(plans));
    for (const subject of coverage.keys()) assert.deepEqual(history.getPlayerCoverage('g', subject, start, end), coverage.get(subject));
    assert.deepEqual([...history.getCoverageBySubject('g', 'clan', [' gap ', 'GAP'], start, end)], [['GAP', { complete: false, coveredDays: 0, totalDays: 7 }]]);
    assert.deepEqual([...counted.getCoverageBySubject('g', 'player', ['complete'], 'invalid', end)], [['complete', { complete: false, coveredDays: 0, totalDays: 0 }]]);
    assert.deepEqual([...counted.getCoverageBySubject('g', 'player', [], start, end)], []);
    assert.equal(reads, 1, 'invalid windows and empty inventories need no query');
  } finally { raw.close(); }
});

test("Elo pruning reads retention settings once and respects each guild's cutoff", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(raw);
    const captured = Date.parse("2026-10-27T12:00:00.000Z");
    const specs = [["short",14,14],["long",120,120],["missing",null,90],
      ["dm",null,90],["low",0,1],["high",999,365],["invalid","invalid",90]];
    const settings = raw.prepare("INSERT INTO history_settings(guild_id,revision,retention_days) VALUES(?,1,?)");
    const insert = raw.prepare(`INSERT INTO history_observed_elo
      (guild_id,public_id,discord_id,ladder,hour_bucket,observed_at,rating) VALUES(?,?,NULL,'1v1',?,?,1000)`);
    for (const [guild, configured, days] of specs) {
      if (configured !== null) settings.run(guild, configured);
      const boundary = captured - days * 86400000;
      insert.run(guild, "old", Math.floor((boundary-1)/3600000), new Date(boundary-1).toISOString());
      insert.run(guild, "kept", Math.floor(boundary/3600000), new Date(boundary).toISOString());
    }
    let prepares = 0;
    const history = new HistoryStore({ prepare(sql) { prepares++; return raw.prepare(sql); } });
    history.pruneEloObservations(captured);
    assert.equal(prepares, 2);
    const rows = raw.prepare("SELECT guild_id,public_id FROM history_observed_elo ORDER BY guild_id").all();
    assert.deepEqual(rows.map(row => [row.guild_id, row.public_id]), specs.map(([guild]) => [guild,"kept"]).sort((a,b)=>a[0].localeCompare(b[0])));
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

test("identity cleanup uses indexed identity and guild probes after repeatable migration", () => {
  const raw = new DatabaseSync(":memory:");
  try {
    HistoryStore.initialize(raw);
    // Simulate an existing database populated before the cleanup indexes were added.
    raw.exec(`DROP INDEX IF EXISTS history_player_identity;
      DROP INDEX IF EXISTS history_elo_identity;
      DROP INDEX IF EXISTS history_job_identity;`);
    const baseline = new HistoryStore(raw);
    for (const guild of ["g","other"]) {
      baseline.upsertPlayerMatches(guild,"match-only","target",[player("target-game")]);
      baseline.ensureJob(guild,"player","job-only",now,"target","version");
      baseline.recordElo(guild,"elo-only","target","1v1",1000,now);
      for (const publicId of ["match-only","job-only","elo-only"])
        baseline.markCoverage({guild_id:guild,kind:"player",subject:publicId,window_start:at,window_end:"2026-10-17T12:00:00.000Z"},now);
      for (let i=0;i<50;i++) {
        baseline.upsertPlayerMatches(guild,`unrelated-${i}`,`member-${i}`,[player("other-game")]);
        baseline.ensureJob(guild,"player",`unrelated-${i}`,now,`member-${i}`,"version");
        baseline.recordElo(guild,`unrelated-${i}`,`member-${i}`,"1v1",1100,now);
      }
      baseline.recordElo(guild,"public-profile",null,"1v1",1200,now);
    }
    const tables = ["history_player_matches","history_observed_elo","history_jobs","history_coverage"];
    const snapshot = () => tables.map(table=>raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    HistoryStore.initialize(raw);
    HistoryStore.initialize(raw);
    assert.deepEqual(snapshot(),before,"adding indexes and reopening must preserve retained data");

    const plans = [];
    const history = new HistoryStore({prepare(query) {
      const statement = raw.prepare(query);
      if (!query.startsWith("SELECT") || !query.includes("discord_id=?")) return statement;
      return {all(...parameters) {
        plans.push({query,details:raw.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map(row=>row.detail)});
        return statement.all(...parameters);
      }};
    }});
    history.purgeMember("g","target");
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_player_matches WHERE guild_id='other' AND discord_id='target'").get().count,1);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_coverage WHERE guild_id='g'").get().count,0);
    history.purgeIdentity("target");
    for (const table of tables.slice(0,3))
      assert.equal(raw.prepare(`SELECT count(*) AS count FROM ${table} WHERE discord_id='target'`).get().count,0,table);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_coverage").get().count,0);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_player_matches").get().count,100);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_jobs").get().count,100);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_observed_elo").get().count,102);
    assert.equal(raw.prepare("SELECT count(*) AS count FROM history_observed_elo WHERE discord_id IS NULL").get().count,2);

    assert.equal(plans.length,3,"exercise the global lookup and both scoped member lookups");
    for (const {query,details} of plans) for (const table of tables.slice(0,3)) {
      const access = details.find(detail=>detail.startsWith(`SEARCH ${table} `));
      assert.ok(access?.includes("COVERING INDEX") && access.includes("discord_id=?"),`${query}: ${JSON.stringify(details)}`);
      if (query.includes("WHERE guild_id=?"))
        assert.ok(access.includes("guild_id=?"),`${table} must constrain both the identity and guild`);
    }
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
