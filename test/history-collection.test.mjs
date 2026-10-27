import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { BotDatabase, db: singleton } = await import("../dist/db.js");
const { HistoryCollector } = await import("../dist/historyCollector.js");
const { weeklyPeriod } = await import("../dist/historySchedule.js");
const { EmbedBuilder } = await import("discord.js");
after(()=>singleton.close());
const DAY = 86_400_000;
const clanConfig = (guild,tag) => ({guild_id:guild,clan_tag:tag,member_role_id:"role",officer_role_id:null,leader_role_id:null,
  join_role_id:null,log_channel_id:null,sync_interval_mins:10,last_sync_at:null});
const clanRow = (start,gameId="game-1",overrides={})=>({gameId,clanTag:"MARS",clanPlayerCount:3,hasWon:true,numTeams:2,
  playerTeams:"2",totalPlayerCount:30,gameStart:start,score:2,...overrides});
const playerRow = (start,gameId="game-1",overrides={})=>({gameId,gameStart:start,gameEnd:start,gameType:"Public",gameMode:"Team",
  gameRankedType:"Unranked",clientId:"session-client",username:"Old [MARS] name",clanTag:"MARS",hasWon:true,...overrides});
function fixture(options={}) {
  const db = new BotDatabase(":memory:");
  let now = options.now ?? Date.parse("2026-10-16T12:00:00.000Z");
  const members = new Map();
  const guild = {id:"guild",members:{cache:members,fetch:async request=> {
    if (request?.user) {
      const member=members.get(request.user);
      if (!member) throw Object.assign(new Error("Unknown member"),{code:10007});
      return member;
    }
    return members;
  }},channels:{fetch:async()=>null}};
  const client = {guilds:{cache:new Map([[guild.id,guild]])},user:{id:"bot"}};
  const api = {getClanSessions:async(tag,q)=>({results:[],total:0,page:q.page,limit:q.limit}),
    getPlayerSessions:async()=>({results:[],nextCursor:null}),getRecentlyDeletedPlayers:async()=>[],
    getRankedLeaderboardPage:async()=>({ratings:[],hasMore:false,observedAt:new Date(now).toISOString()})};
  const defaults=db.history.getSettings(guild.id);
  db.history.saveSettings(guild.id,{...defaults,collection_enabled:1},0);
  db.setGuildClanConfig(clanConfig(guild.id,"MARS"));
  const collector = new HistoryCollector(client,db,api,{now:()=>now,maxRequestsPerTick:options.budget ?? 8,...options.collector});
  const link=(discord="discord",publicId="public")=> {
    db.linkGuildUser(guild.id,"manager",discord,publicId,"Current name");
    members.set(discord,{id:discord,user:{bot:false}});
  };
  return {db,members,guild,client,api,collector,link,now:()=>now,setNow:(value)=>now=value,
    close:async()=>{await collector.stop();db.close();}};
}
test("history settings default to opt-in collection and validate revisions, schedules and dependencies",()=> {
  const db=new BotDatabase(":memory:");
  try {
    const defaults=db.history.getSettings("g");
    assert.equal(defaults.collection_enabled,0); assert.equal(defaults.weekly_enabled,0);
    const saved=db.history.saveSettings("g",defaults,0);
    assert.equal(saved.revision,1);
    assert.throws(()=>db.history.saveSettings("g",defaults,0),/changed in another session/);
    assert.throws(()=>db.history.saveSettings("g",{...saved,poll_minutes:1},1),/Poll interval/);
    assert.throws(()=>db.history.saveSettings("g",{...saved,retention_days:7},1),/Retention/);
    assert.throws(()=>db.history.saveSettings("g",{...saved,timezone:"Mars/Olympus"},1),/IANA/);
    assert.throws(()=>db.history.saveSettings("g",{...saved,weekly_enabled:1},1),/require collection/);
  } finally {db.close();}
});
test("stored clan sessions deduplicate corrected results and maintain guild isolation and gap coverage",()=> {
  const db=new BotDatabase(":memory:");
  try {
    const start="2026-10-01T00:00:00.000Z",end="2026-10-04T00:00:00.000Z";
    db.history.upsertClanMatches("g","MARS",[clanRow(start),clanRow(start,"game-1",{score:-4,hasWon:false})]);
    db.history.upsertClanMatches("other","MARS",[clanRow(start,"other")]);
    assert.equal(db.history.getClanMatches("g","mars",start,end).length,1);
    assert.equal(db.history.getClanMatches("g","mars",start,end)[0].score,-4);
    const job={guild_id:"g",kind:"clan",subject:"MARS",window_start:start,window_end:"2026-10-02T00:00:00.000Z"};
    db.history.markCoverage(job,Date.now());
    db.history.markCoverage({...job,window_start:"2026-10-03T00:00:00.000Z",window_end:end},Date.now());
    assert.deepEqual(db.history.getClanCoverage("g","MARS",start,end),{complete:false,coveredDays:2,totalDays:3});
    db.history.markCoverage({...job,window_start:"2026-10-02T00:00:00.000Z",window_end:"2026-10-03T00:00:00.000Z"},Date.now());
    assert.equal(db.history.getClanCoverage("g","MARS",start,end).complete,true);
  } finally {db.close();}
});
test("checkpoints survive restart and do not advance on failed pages",async()=> {
  const folder=mkdtempSync(join(tmpdir(),"of-history-")),filename=join(folder,"history.db");
  let db=new BotDatabase(filename);
  try {
    const now=Date.parse("2026-10-16T12:00:00.000Z");
    db.history.ensureJob("g","clan","MARS",now);
    let job=db.history.getJob("g","clan","MARS");
    db.history.advancePage(job,null,2); db.close(); db=null; db=new BotDatabase(filename);
    job=db.history.getJob("g","clan","MARS");
    assert.equal(job.page,2);
    const before=job.window_start;
    db.history.retryJob(job,"rate limited",now);
    const retried=db.history.getJob("g","clan","MARS");
    assert.equal(retried.page,2); assert.equal(retried.window_start,before); assert.equal(retried.next_attempt,now+60_000);
    assert.equal(db.history.getClanCoverage("g","MARS",job.window_start,job.window_end).complete,false);
  } finally {db?.close();rmSync(folder,{recursive:true,force:true});}
});
test("bounded collection rotates through clan and current human identities without name matching",async()=> {
  const f=fixture({budget:3});
  try {
    f.link("one","public-one");f.link("two","public-two");
    f.members.set("robot",{user:{bot:true}});f.db.linkGuildUser("guild","manager","robot","public-bot","bot");
    f.db.linkGuildUser("guild","manager","departed","public-left","left");
    const seen=[];
    f.api.getClanSessions=async(tag,q)=>{seen.push(`clan:${tag}`);return {results:[],total:0,page:q.page,limit:q.limit};};
    f.api.getPlayerSessions=async(publicId,q)=>{assert.equal(q.type,"public");assert.equal(q.filter,"team");seen.push(publicId);return {results:[],nextCursor:null};};
    await f.collector.collectOnce();
    assert.equal(seen.length,2); // One of the three requests was the daily deletion feed.
    await f.collector.collectOnce();
    assert.ok(seen.includes("public-two"));assert.ok(seen.includes("public-one"));assert.ok(seen.includes("clan:MARS"));
    assert.equal(seen.includes("public-bot"),false);assert.equal(seen.includes("public-left"),false);
  } finally {await f.close();}
});
test("an API failure retains its exact window while other jobs still progress",async()=> {
  const f=fixture({budget:4});
  try {
    f.db.setGuildClanConfig(clanConfig("guild","VENUS"));
    f.api.getClanSessions=async(tag,q)=> {if(tag==="MARS")throw new Error("temporary rate limit");return {results:[],total:0,page:q.page,limit:q.limit};};
    await f.collector.collectOnce();
    const failed=f.db.history.getJob("guild","clan","MARS"),successful=f.db.history.getJob("guild","clan","VENUS");
    assert.equal(failed.window_start,"2026-10-09T00:00:00.000Z");assert.equal(failed.attempts,1);assert.match(failed.last_error,/rate limit/);
    assert.ok(successful.window_start>failed.window_start);
  } finally {await f.close();}
});
test("a failed stale player request cannot back off a replacement identity job",async()=> {
  const f=fixture({budget:3});
  try {
    f.link();
    let requested=0;
    f.api.getPlayerSessions=async()=> {
      requested++;
      f.db.unlinkGuildUser("guild","manager","discord");
      f.link();
      const link=f.db.getEffectiveLink("guild","discord");
      f.db.history.ensureJob("guild","player","public",f.now(),"discord",link.linked_at);
      throw new Error("old request failed");
    };
    await f.collector.collectOnce();
    const replacement=f.db.history.getJob("guild","player","public");
    assert.equal(requested,1);
    assert.equal(replacement.identity_version,f.db.getEffectiveLink("guild","discord").linked_at);
    assert.equal(replacement.attempts,0);
    assert.equal(replacement.next_attempt,0);
    assert.equal(replacement.last_error,null);
  } finally {await f.close();}
});
test("an old unknown-member lookup cannot purge a replacement identity's history",async()=> {
  const f=fixture({budget:3});
  try {
    f.link();
    f.api.getPlayerSessions=async(_id,q)=>({results:[playerRow(q.start)],nextCursor:null});
    const originalFetch=f.guild.members.fetch;
    f.guild.members.fetch=async request=> {
      if (!request?.user) return originalFetch(request);
      f.db.unlinkGuildUser("guild","manager","discord");
      f.link("discord","replacement");
      const link=f.db.getEffectiveLink("guild","discord");
      f.db.history.ensureJob("guild","player","replacement",f.now(),"discord",link.linked_at);
      f.db.history.upsertPlayerMatches("guild","replacement","discord",[playerRow("2026-10-15T00:00:00.000Z","replacement-game")]);
      throw Object.assign(new Error("Unknown member"),{code:10007});
    };
    await f.collector.collectOnce();
    const replacement=f.db.history.getJob("guild","player","replacement");
    assert.ok(replacement,"replacement job should survive the old lookup");
    assert.equal(replacement.identity_version,f.db.getEffectiveLink("guild","discord").linked_at);
    assert.deepEqual(f.db.history.getPlayerMatches("guild","2000","2099").map(row=>row.gameId),["replacement-game"]);
  } finally {await f.close();}
});
test("a current unknown-member lookup purges the departed member's history",async()=> {
  const f=fixture({budget:3});
  try {
    f.link();
    f.db.history.upsertPlayerMatches("guild","public","discord",[playerRow("2026-10-15T00:00:00.000Z")]);
    f.api.getPlayerSessions=async(_id,q)=>({results:[playerRow(q.start)],nextCursor:null});
    const originalFetch=f.guild.members.fetch;
    f.guild.members.fetch=async request=> {
      if (!request?.user) return originalFetch(request);
      f.members.delete("discord");
      throw Object.assign(new Error("Unknown member"),{code:10007});
    };
    await f.collector.collectOnce();
    assert.equal(f.db.history.getJob("guild","player","public"),null);
    assert.deepEqual(f.db.history.getPlayerMatches("guild","2000","2099"),[]);
  } finally {await f.close();}
});
test("unlink during a player request prevents storage and immediately purges historical identity rows",async()=> {
  const f=fixture({budget:4});
  try {
    f.link();
    f.api.getPlayerSessions=async(_id,q)=> {f.db.unlinkGuildUser("guild","manager","discord");return {results:[playerRow(q.start)],nextCursor:null};};
    await f.collector.collectOnce();
    assert.deepEqual(f.db.history.getPlayerMatches("guild","2000","2099"),[]);
    assert.equal(f.db.history.getJob("guild","player","public"),null);
    f.link();f.db.history.upsertPlayerMatches("guild","public","discord",[playerRow("2026-10-15T00:00:00.000Z")]);
    f.db.unlinkUser("discord");
    assert.deepEqual(f.db.history.getPlayerMatches("guild","2000","2099"),[]);
  } finally {await f.close();}
});
test("only the configured historical clan tag contributes; inclusive end boundaries are deferred and deduplicated",async()=> {
  const f=fixture({budget:4});
  try {
    f.link();
    f.api.getPlayerSessions=async(_id,q)=>({results:[playerRow(q.start),playerRow(q.start,"other-clan",{clanTag:"VENUS"}),
      playerRow(q.end,"boundary"),playerRow(q.start,"ffa",{gameMode:"Free For All"})],nextCursor:null});
    await f.collector.collectOnce();
    const stored=f.db.history.getPlayerMatches("guild","2000","2099");
    assert.equal(stored.length,1);assert.equal(stored[0].public_id,"public");assert.equal(stored[0].gameId,"game-1");
    f.db.history.upsertPlayerMatches("guild","public","discord",[playerRow(stored[0].gameStart,"game-1",{hasWon:false})]);
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,1);
  } finally {await f.close();}
});
test("a deletion-feed gap beyond seven days clears retained player rows and tombstones deleted identities",async()=> {
  const f=fixture({budget:1});
  try {
    f.link();
    f.db.history.upsertPlayerMatches("guild","public","discord",[playerRow("2026-10-15T00:00:00.000Z")]);
    f.db.history.setMeta("deletions_last_success",new Date(f.now()-8*DAY).toISOString());
    f.api.getRecentlyDeletedPlayers=async(since)=>{
      assert.ok(Date.parse(since) > f.now()-7*DAY,"request arrival must not fall outside the feed's seven-day limit");
      return [{publicId:"public",deletedAt:new Date(f.now()-DAY).toISOString()}];
    };
    await f.collector.collectOnce();
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,0);
    assert.equal(f.db.history.getJob("guild","player","public"),null);
    f.db.history.upsertPlayerMatches("guild","public","discord",[playerRow("2026-10-15T00:00:00.000Z")]);
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,0);
  } finally {await f.close();}
});
test("changing configured clan tags rebuilds player history and coverage while preserving Elo until unlink",async()=> {
  const f=fixture({budget:4});
  try {
    f.link();
    f.api.getPlayerSessions=async(_id,q)=>({results:[playerRow(q.start)],nextCursor:null});
    await f.collector.collectOnce();
    f.db.history.recordElo("guild","public","discord","1v1",1234,f.now());
    const job=f.db.history.getJob("guild","player","public");
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,1);
    assert.equal(f.db.history.getPlayerCoverage("guild","public","2026-10-09T00:00:00.000Z",job.window_start).complete,true);
    f.db.setGuildClanConfig(clanConfig("guild","VENUS"));
    assert.equal(f.db.history.getStatus("guild").eloObservations,1);
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,0);
    assert.equal(f.db.history.getJob("guild","player","public"),null);
    assert.equal(f.db.history.getPlayerCoverage("guild","public","2026-10-09T00:00:00.000Z",job.window_start).complete,false);
    await f.collector.collectOnce();
    assert.ok(f.db.history.getJob("guild","player","public"));
    const rebuilt=f.db.history.getJob("guild","player","public");
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,1);
    assert.equal(f.db.history.getPlayerCoverage("guild","public","2026-10-09T00:00:00.000Z",rebuilt.window_start).complete,true);
    f.db.deleteGuildClanConfig("guild","MARS");
    assert.equal(f.db.history.getStatus("guild").eloObservations,1);
    assert.equal(f.db.history.getPlayerMatches("guild","2000","2099").length,0);
    assert.equal(f.db.history.getJob("guild","player","public"),null);
    assert.equal(f.db.history.getPlayerCoverage("guild","public","2026-10-09T00:00:00.000Z",rebuilt.window_start).complete,false);
    f.db.unlinkUser("discord");
    assert.equal(f.db.history.getStatus("guild").eloObservations,0);
  } finally {await f.close();}
});
test("changing collection settings while an API request is pending prevents that response from being saved",async()=> {
  const f=fixture({budget:2});
  try {
    f.api.getClanSessions=async(_tag,q)=> {
      const settings=f.db.history.getSettings("guild");
      f.db.history.saveSettings("guild",{...settings,collection_enabled:0},settings.revision);
      return {results:[clanRow(q.start)],total:1,page:q.page,limit:q.limit};
    };
    await f.collector.collectOnce();
    assert.equal(f.db.history.getClanMatches("guild","MARS","2000","2099").length,0);
  } finally {await f.close();}
});
test("shutdown waits for the outstanding request and prevents later database writes",async()=> {
  const f=fixture({budget:2});let release;
  try {
    f.api.getClanSessions=(_tag,q)=>new Promise(resolve=>{release=()=>resolve({results:[clanRow(q.start)],total:1,page:q.page,limit:q.limit});});
    const tick=f.collector.collectOnce();
    for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof release,"function");
    const stop=f.collector.stop();release();await Promise.all([tick,stop]);
    assert.equal(f.db.history.getClanMatches("guild","MARS","2000","2099").length,0);
  } finally {await f.close();}
});
test("weekly schedule follows local Monday weeks and DST instead of the host timezone",()=> {
  assert.deepEqual(weeklyPeriod({weekly_day:1,weekly_hour:9,timezone:"America/Bahia"},Date.parse("2026-10-19T12:01:00Z")),{
    scheduledAt:"2026-10-19T12:00:00.000Z",start:"2026-10-12T03:00:00.000Z",end:"2026-10-19T03:00:00.000Z"});
  assert.deepEqual(weeklyPeriod({weekly_day:1,weekly_hour:9,timezone:"America/New_York"},Date.parse("2026-11-02T15:00:00Z")),{
    scheduledAt:"2026-11-02T14:00:00.000Z",start:"2026-10-26T04:00:00.000Z",end:"2026-11-02T05:00:00.000Z"});
});
test("weekly recap delivery persists one report with deterministic nonce and reconciles an interrupted acknowledgement",async()=> {
  const f=fixture({now:Date.now(),budget:1,collector:{buildWeeklyReport:async()=>new EmbedBuilder().setDescription("Partial public Team coverage")}});
  try {
    let settings=f.db.history.getSettings("guild");
    settings=f.db.history.saveSettings("guild",{...settings,weekly_enabled:1,channel_id:"123",timezone:"UTC",weekly_day:1,weekly_hour:9},settings.revision);
    const next=weeklyPeriod(settings,Date.now()+8*DAY);
    f.setNow(Date.parse(next.scheduledAt)+60_000);
    const messages=new Map();messages.find=fn=>[...messages.values()].find(fn);
    let sends=0,failAcknowledgement=true;
    const channel={isTextBased:()=>true,isSendable:()=>true,isDMBased:()=>false,isThread:()=>false,permissionsFor:()=>({has:()=>true}),
      messages:{fetch:async()=>messages},send:async(payload)=> {
        sends++;assert.equal(payload.enforceNonce,true);assert.equal(payload.nonce.length,24);
        const message={id:"message",author:{id:"bot"},embeds:[{footer:payload.embeds[0].data.footer}]};messages.set(message.id,message);
        if(failAcknowledgement){failAcknowledgement=false;throw new Error("connection lost after Discord accepted message");}
        return message;
      }};
    f.guild.channels.fetch=async()=>channel;f.guild.members.me={id:"bot"};
    await f.collector.collectOnce();
    let delivery=f.db.history.getDelivery("guild",next.start,next.end);
    assert.equal(delivery.status,"pending");assert.equal(sends,1);
    f.setNow(f.now()+2*60_000);
    await f.collector.collectOnce();
    delivery=f.db.history.getDelivery("guild",next.start,next.end);
    assert.equal(delivery.status,"sent");assert.equal(delivery.message_id,"message");assert.equal(sends,1);
    await f.collector.collectOnce();assert.equal(sends,1);
  } finally {await f.close();}
});
