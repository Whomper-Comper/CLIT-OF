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
    return { results:[row("same",{gameStart:q.start}),row("at-end",{gameStart:q.end})],total:2,page:q.page,limit:q.limit };
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
test("recent clan loader marks mismatched clan or daily window responses as incomplete", async (t) => {
  t.mock.method(openfrontApi,"getClanSessions", async (_tag,q) => q.start === "2026-10-15T12:00:00.000Z" ? {
    results:[row("valid",{gameStart:q.start}),row("wrong-clan",{clanTag:"VENUS",gameStart:q.start}),
      row("outside-day",{gameStart:"2026-10-14T13:00:00Z"})],total:3,page:q.page,limit:q.limit,
  } : { results:[],total:0,page:q.page,limit:q.limit });
  const sample = await loadRecentClanMatches("MARS",2,now,2);
  assert.deepEqual(sample.rows.map(item=>item.gameId),["valid"]);
  assert.equal(sample.complete,false);
  assert.match(renderClanRecent("MARS",sample).toJSON().description,/inconsistent/i);
});
test("recent clan history includes the start and shared day boundary but excludes the overall end", async (t) => {
  const start = "2026-10-14T12:00:00.000Z";
  const boundary = "2026-10-15T12:00:00.000Z";
  const end = "2026-10-16T12:00:00.000Z";
  t.mock.method(openfrontApi,"getClanSessions", async (_tag,q) => ({
    results: q.start === boundary
      ? [row("boundary",{gameStart:boundary}),row("end",{gameStart:end})]
      : [row("start",{gameStart:start}),row("boundary",{gameStart:boundary})],
    total:2,page:q.page,limit:q.limit,
  }));
  const sample = await loadRecentClanMatches("MARS",2,now,2);
  assert.equal(sample.complete,true);
  assert.deepEqual(sample.rows.map(item=>item.gameId),["boundary","start"]);
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

test('weekly recap batches coverage and reads each clan payload once while preserving totals and gaps', async t => {
  const guildId = 'weekly-batch', start = '2026-10-12T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
  const members = new Map();
  db.history.setMeta('deletions_last_success', new Date().toISOString());
  for (let i = 0; i < 10; i++) {
    const tag = `C${String(i).padStart(2, '0')}`;
    db.setGuildClanConfig({ guild_id: guildId, clan_tag: tag, member_role_id: 'rank', officer_role_id: null,
      leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
    db.history.upsertClanMatches(guildId, tag, [row('weekly-shared', { clanTag: tag }),
      row(`weekly-only-${i}`, { clanTag: tag, hasWon: i % 2 === 0 })]);
    db.history.markCoverage({ guild_id: guildId, kind: 'clan', subject: tag,
      window_start: start, window_end: i === 9 ? '2026-10-15T00:00:00.000Z' : end }, now);
  }
  for (let i = 0; i < 1_000; i++) {
    const discordId = `weekly-user-${i}`, publicId = `weekly-account-${i}`;
    members.set(discordId, { id: discordId, user: { bot: false } });
    db.linkGuildUser(guildId, 'manager', discordId, publicId, `Player ${i}`);
    db.history.markCoverage({ guild_id: guildId, kind: 'player', subject: publicId,
      window_start: start, window_end: i === 999 ? '2026-10-18T00:00:00.000Z' : end }, now);
  }
  const counts = { clanQueries: 0, coverageQueries: 0, payloadRows: 0, decodes: 0 };
  const prepare = db.db.prepare.bind(db.db);
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, ...args) => {
    const decoded = parse(text, ...args);
    if (decoded?.gameId?.startsWith('weekly-')) counts.decodes++;
    return decoded;
  });
  t.mock.method(db.db, 'prepare', query => {
    const statement = prepare(query);
    if (query.startsWith('SELECT') && query.includes('FROM history_coverage')) counts.coverageQueries++;
    if (!query.startsWith('SELECT payload FROM history_clan_matches')) return statement;
    return { all() { assert.fail('Weekly clan payloads must stream, not materialize with all()'); }, *iterate(...parameters) {
      counts.clanQueries++;
      for (const row of statement.iterate(...parameters)) {
        counts.payloadRows++;
        yield row;
      }
    } };
  });
  const report = (await buildWeeklyReport({ id: guildId, members: { fetch: async () => members } }, start, end)).toJSON();
  assert.deepEqual(counts, { clanQueries: 10, coverageQueries: 2, payloadRows: 20, decodes: 20 });
  assert.match(report.description, /\*\*11\*\* distinct recorded games across \*\*10\*\*/);
  assert.match(report.fields.find(field => field.name === 'Collection coverage').value, /9\/10 clans and 999\/1000 current linked members.*Coverage is partial/);
  assert.match(report.fields.find(field => field.name === '[C00]').value, /2 recorded games · 2 wins · 0 losses/);
  assert.match(report.fields.find(field => field.name === '[C01]').value, /2 recorded games · 1 wins · 1 losses/);
  assert.equal(report.fields.filter(field => /^\[C/.test(field.name)).length, 8);
  assert.match(report.fields.find(field => field.name === 'Clan result entries').value, /Wins\s+█+\s+15/);
  assert.match(report.fields.find(field => field.name === 'Clan result entries').value, /Losses\s+[█░]+\s+5/);
});

test('history iterators preserve canonical corrections, scope, half-open bounds and deterministic order', () => {
  const guild = 'iterator-contract', start = '2026-10-12T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
  const sessions = [row('boundary-start', { gameStart: start }), row('b'), row('a'),
    row('boundary-end', { gameStart: end }), row('before', { gameStart: '2026-10-11T23:59:59.999Z' })];
  db.history.upsertClanMatches(guild, 'MARS', sessions);
  db.history.upsertClanMatches(guild, 'MARS', [row('a', { hasWon: false, score: -4 })]);
  db.history.upsertClanMatches('other-iterator-guild', 'MARS', [row('other-guild')]);
  db.history.upsertClanMatches(guild, 'VENUS', [row('other-tag', { clanTag: 'VENUS' })]);
  const clan = [...db.history.iterateClanMatches(guild, ' mars ', start, end)];
  assert.deepEqual(clan.map(item => item.gameId), ['a', 'b', 'boundary-start']);
  assert.equal(clan[0].hasWon, false);
  assert.equal(clan[0].score, -4);
  assert.deepEqual(db.history.getClanMatches(guild, ' mars ', start, end), clan);
  const player = sessions.map(item => ({ gameId: item.gameId, gameStart: item.gameStart, gameEnd: end,
    gameType: 'Public', gameMode: 'Team', gameRankedType: 'unranked', clientId: 'ephemeral', username: 'Player', clanTag: 'MARS', hasWon: true }));
  db.history.upsertPlayerMatches(guild, 'iterator-account', 'old-owner', player);
  db.history.upsertPlayerMatches(guild, 'iterator-account', 'new-owner', [{ ...player[2], hasWon: false }]);
  db.history.upsertPlayerMatches('other-iterator-guild', 'iterator-account', 'other-owner', [player[0]]);
  const stored = [...db.history.iteratePlayerMatches(guild, start, end)];
  assert.deepEqual(stored.map(item => [item.gameId, item.public_id, item.discord_id, item.hasWon]), [
    ['a', 'iterator-account', 'new-owner', false], ['b', 'iterator-account', 'old-owner', true],
    ['boundary-start', 'iterator-account', 'old-owner', true],
  ]);
  assert.deepEqual(db.history.getPlayerMatches(guild, start, end), stored);
  // Breaking early must close the underlying SQLite statement too.
  for (const _row of db.history.iteratePlayerMatches(guild, start, end)) break;
  db.history.upsertPlayerMatches(guild, 'iterator-account', 'new-owner', [{ ...player[2], hasWon: true }]);
});

test('weekly recap streams large mixed player history once without retaining decoded rows and preserves exact rankings', async t => {
  const guildId = 'weekly-mixed', start = '2026-10-12T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
  const members = new Map();
  db.history.setMeta('deletions_last_success', new Date().toISOString());
  db.setGuildClanConfig({ guild_id: guildId, clan_tag: 'MARS', member_role_id: 'rank', officer_role_id: null,
    leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  db.history.upsertClanMatches(guildId, 'MARS', [row('mixed-clan-a'), row('mixed-clan-b', { hasWon: false })]);
  const session = (gameId, extra = {}) => ({ gameId, gameStart: '2026-10-16T10:00:00.000Z', gameEnd: '2026-10-16T11:00:00.000Z',
    gameType: 'pUbLiC', gameMode: 'tEaM', gameRankedType: 'unranked', clientId: 'ephemeral', username: 'Player', clanTag: ' mars ', hasWon: false, ...extra });
  function addPlayer(name, wins, games, present = true, bot = false, linked = true) {
    const discordId = `mixed-user-${name}`, publicId = `mixed-account-${name}`;
    if (present) members.set(discordId, { id: discordId, user: { bot } });
    if (linked) db.linkGuildUser(guildId, 'manager', discordId, publicId, name);
    db.history.upsertPlayerMatches(guildId, publicId, discordId,
      Array.from({ length: games }, (_, i) => session(`mixed-${name}-${i}`, { hasWon: i < wins })));
  }
  for (let i = 0; i < 120; i++) addPlayer(`background-${i}`, 0, 30);
  for (const [name, wins, games] of [['Alpha', 4, 6], ['Beta', 4, 5], ['Gamma', 4, 5], ['Delta', 3, 3], ['Epsilon', 2, 2], ['Zeta', 2, 4]]) addPlayer(name, wins, games);
  addPlayer('Left', 30, 30, false);
  addPlayer('Bot', 30, 30, true, true);
  addPlayer('Unlinked', 30, 30, true, false, false);
  db.history.upsertPlayerMatches(guildId, 'mixed-account-Alpha', 'mixed-user-Alpha', [
    session('mixed-private', { gameType: 'Private', hasWon: true }), session('mixed-ffa', { gameMode: 'FFA', hasWon: true }),
    session('mixed-wrong-tag', { clanTag: 'VENUS', hasWon: true }), session('mixed-no-tag', { clanTag: null, hasWon: true }),
    session('mixed-unfinished', { gameEnd: null, hasWon: true }),
  ]);
  db.history.upsertPlayerMatches(guildId, 'mixed-account-Alpha', 'wrong-discord-owner', [session('mixed-wrong-owner', { hasWon: true })]);
  // A corrected canonical win must count once, independently of insertion order.
  db.history.upsertPlayerMatches(guildId, 'mixed-account-Beta', 'mixed-user-Beta', [session('mixed-Beta-0', { hasWon: false })]);
  db.history.upsertPlayerMatches(guildId, 'mixed-account-Beta', 'mixed-user-Beta', [session('mixed-Beta-0', { hasWon: true })]);
  const counts = { clanReads: 0, playerReads: 0, payloadRows: 0, decodes: 0, activeIterators: 0 };
  let retainedPlayerGameIds = 0;
  const add = Set.prototype.add;
  t.mock.method(Set.prototype, 'add', function (value) {
    if (typeof value === 'string' && /^mixed-(?:background-|Alpha-|Beta-|Gamma-|Delta-|Epsilon-|Zeta-)/.test(value)) retainedPlayerGameIds++;
    return add.call(this, value);
  });
  const prepare = db.db.prepare.bind(db.db), parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, ...args) => {
    const decoded = parse(text, ...args);
    if (decoded?.gameId?.startsWith('mixed-')) counts.decodes++;
    return decoded;
  });
  t.mock.method(db.db, 'prepare', query => {
    const statement = prepare(query);
    const clan = query.startsWith('SELECT payload FROM history_clan_matches');
    const player = query.startsWith('SELECT public_id,discord_id,payload FROM history_player_matches');
    if (!clan && !player) return statement;
    return { all() { assert.fail('Weekly payload queries must not materialize raw rows'); }, *iterate(...args) {
      if (clan) counts.clanReads++; else counts.playerReads++;
      for (const row of statement.iterate(...args)) { counts.payloadRows++; yield row; }
    } };
  });
  for (const method of ['getClanMatches', 'getPlayerMatches']) t.mock.method(db.history, method, () => assert.fail('Weekly reports must not use array compatibility APIs'));
  for (const method of ['iterateClanMatches', 'iteratePlayerMatches']) {
    const iterate = db.history[method].bind(db.history);
    t.mock.method(db.history, method, function* (...args) {
      counts.activeIterators++;
      try {
        for (const row of iterate(...args)) {
          // Access to a decoded row must finish before requesting the next one.
          // Retaining [...rows], flatMap or raw row arrays fails on later access.
          const { proxy, revoke } = Proxy.revocable(row, {});
          try { yield proxy; } finally { revoke(); }
        }
      } finally { counts.activeIterators--; }
    });
  }
  const report = (await buildWeeklyReport({ id: guildId, members: { fetch: async () => {
    assert.equal(counts.activeIterators, 0);
    return members;
  } } }, start, end)).toJSON();
  assert.deepEqual(counts, { clanReads: 1, playerReads: 1, payloadRows: 3632, decodes: 3632, activeIterators: 0 });
  assert.equal(retainedPlayerGameIds, 0, 'Player aggregation must retain counters rather than game-ID inventories');
  const wins = report.fields.find(field => field.name.startsWith('Most recorded wins')).value;
  const rates = report.fields.find(field => field.name.startsWith('Best recorded win fraction')).value;
  assert.deepEqual(wins.split('\n').map(line => line.match(/^\[([^\]]+)\]/)[1]), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Zeta']);
  assert.match(wins, /Alpha.*\*\*4\*\* wins \/ \*\*6\*\* appearances \(66\.7%\)/);
  assert.match(wins, /Zeta.*\*\*2\*\* wins \/ \*\*4\*\* appearances \(50\.0%\)/);
  assert.deepEqual(rates.split('\n').map(line => line.match(/^\[([^\]]+)\]/)[1]), ['Delta', 'Beta', 'Gamma']);
  assert.match(rates, /Delta.*\(100\.0%\)/);
  assert.match(rates, /Beta.*\(80\.0%\)/);
  assert.doesNotMatch(wins + rates, /Left|Bot|Unlinked|Epsilon/);
  assert.match(report.fields.find(field => field.name === 'Collection coverage').value, /1 record\(s\) without an end timestamp/);
});
