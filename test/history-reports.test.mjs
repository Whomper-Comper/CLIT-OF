import assert from "node:assert/strict";
import { after, test } from "node:test";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { db } = await import("../dist/db.js");
const { openfrontApi } = await import("../dist/api.js");
const { loadRecentClanMatches, clanAnalysis, renderClanRecent, buildWeeklyReport } = await import("../dist/historyReports.js");
after(() => db.close());
const now = Date.parse("2026-10-16T12:00:00Z");
const row = (gameId, extra = {}) => ({ gameId, clanTag:"MARS", clanPlayerCount:3, hasWon:true, numTeams:2, playerTeams:"2",totalPlayerCount:30,gameStart:"2026-10-16T10:00:00Z",score:0.2,...extra });
test("recent clan loader uses at most one-day windows, deduplicates and labels request limits", async (t) => {
  const queries = [];
  t.mock.method(openfrontApi,"getClanSessions", async (_tag,q) => {
    queries.push(q);
    return { results:[row("same"),row("wrong-clan",{clanTag:"VENUS"}),row("at-end",{gameStart:"2026-10-16T12:00:00Z"}),row("before-start",{gameStart:"2026-10-14T11:59:59Z"})],total:4,page:q.page,limit:q.limit };
  });
  const sample = await loadRecentClanMatches("MARS",2,now,2);
  assert.deepEqual(sample.rows.map(row=>row.gameId),["same"]);
  assert.equal(sample.complete,true);
  assert.deepEqual(queries,[
    {start:"2026-10-15T12:00:00.000Z",end:"2026-10-16T12:00:00.000Z",page:1,limit:50},
    {start:"2026-10-14T12:00:00.000Z",end:"2026-10-15T12:00:00.000Z",page:1,limit:50},
  ]);
  const partial = await loadRecentClanMatches("MARS",2,now,1);
  assert.equal(partial.complete,false);
  assert.match(renderClanRecent("MARS",partial).toJSON().description,/Partial sample/);
});
test("clan analysis and display keep numeric and graph views consistent", () => {
  const rows = [row("one"),row("two",{hasWon:false,clanPlayerCount:8,score:-0.4})];
  const stats = clanAnalysis([...rows,rows[0]]);
  assert.deepEqual(stats,{games:2,wins:1,losses:1,averageTurnout:5.5,peakTurnout:8,score:-0.2});
  const sample = {rows,complete:true,start:"2026-10-15T12:00:00Z",end:"2026-10-16T12:00:00Z",requests:1};
  const numbers = renderClanRecent("MARS",sample,1,"numbers").toJSON();
  assert.match(numbers.fields.find(field=>field.name==="Recorded results").value,/\*\*2\*\* games · \*\*1\*\* wins · \*\*1\*\* losses · \*\*50\.0%\*\*/);
  assert.match(numbers.fields.find(field=>field.name==="Recorded results").value,/Average tagged turnout: \*\*5\.5\*\* · Peak: \*\*8\*\*/);
  assert.ok(!numbers.fields.some(field=>field.name==="Tagged clan turnout"));
  const graph = renderClanRecent("MARS",sample,1,"graphs").toJSON();
  const turnout=graph.fields.find(field=>field.name==="Tagged clan turnout").value;
  assert.match(turnout,/1 player\s+░+\s+0/);
  assert.match(turnout,/2–3 players\s+█+\s+1/);
  assert.match(turnout,/4–7 players\s+░+\s+0/);
  assert.match(turnout,/8\+ players\s+█+\s+1/);
  assert.ok(!graph.fields.some(field=>field.name==="Recorded results"));
  assert.throws(()=>renderClanRecent("MARS",sample,2),/Choose a page/);
});
test("weekly ranking uses exact current links and historical tags; missing coverage remains explicit", async () => {
  const guildId="history-recap",start="2026-10-12T00:00:00Z",end="2026-10-19T00:00:00Z";
  db.history.setMeta("deletions_last_success",new Date().toISOString());
  db.setGuildClanConfig({guild_id:guildId,clan_tag:"MARS",member_role_id:"member",officer_role_id:null,leader_role_id:null,join_role_id:null,log_channel_id:null,sync_interval_mins:10,last_sync_at:null});
  db.linkUser("present","player-present","Present","identity_token");
  db.linkUser("left","player-left","Left","identity_token");
  db.history.upsertClanMatches(guildId,"MARS",[row("one")]);
  const session = (gameId,extra={}) => ({gameId,gameStart:"2026-10-16T10:00:00Z",gameEnd:"2026-10-16T11:00:00Z",gameType:"Public",gameMode:"Team",gameRankedType:"unranked",clientId:"ephemeral",username:"Present",clanTag:"MARS",hasWon:true,...extra});
  db.history.upsertPlayerMatches(guildId,"player-present","present",[session("one"),session("two"),session("three"),session("unfinished",{gameEnd:null}),session("other-tag",{clanTag:"VENUS"})]);
  db.history.upsertPlayerMatches(guildId,"player-left","left",[session("left-game")]);
  const guild = {id:guildId,members:{fetch:async()=>new Map([["present",{user:{bot:false}}]])}};
  const report = (await buildWeeklyReport(guild,start,end)).toJSON();
  const best = report.fields.find(field=>field.name.includes("Most recorded wins")).value;
  assert.match(best,/3.*wins.*3.*appearances/);
  assert.doesNotMatch(best,/Left|player-left/);
  assert.match(report.fields.find(field=>field.name==="Collection coverage").value,/Coverage is partial/);
  assert.match(report.fields.find(field=>field.name==="Collection coverage").value,/1 record\(s\) without an end timestamp/);
  assert.ok(JSON.stringify(report).length<6000);
  db.history.setMeta("deletions_last_success", "2000-01-01T00:00:00.000Z");
  const stale = (await buildWeeklyReport(guild,start,end)).toJSON();
  assert.match(stale.fields.find(field=>field.name.includes("Most recorded wins")).value,/withheld/);
  assert.doesNotMatch(stale.fields.find(field=>field.name.includes("Most recorded wins")).value,/Present/);
});
