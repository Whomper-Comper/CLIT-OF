// Reproducible, offline weekly-report workload. Build first; compare the same
// arguments, runtime and machine. No timing thresholds belong in regression tests.
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config = () => ({ parsed: {} });
process.env.DB_PATH = ':memory:';
process.env.DISCORD_TOKEN = 'offline-benchmark';
process.env.CLIENT_ID = 'offline-benchmark';
globalThis.fetch = async () => { throw new Error('External requests are forbidden in this benchmark.'); };
const { db } = await import('../dist/db.js');
const { buildWeeklyReport } = await import('../dist/historyReports.js');
const input = process.argv.slice(2).map(Number);
const [gamesPerClan = 2000, players = 250, gamesPerPlayer = 100, iterations = 5] = input;
if ([gamesPerClan, players, gamesPerPlayer, iterations].some(n => !Number.isSafeInteger(n) || n < 1) ||
    gamesPerClan > 10000 || players > 1000 || gamesPerPlayer > 1000 || iterations > 20) {
  console.error('Usage: node [--expose-gc] tools/benchmark-bot.mjs [gamesPerClan:1-10000 players:1-1000 gamesPerPlayer:1-1000 iterations:1-20]');
  process.exit(1);
}
const guildId = 'offline-benchmark';
const start = '2026-10-12T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
const members = new Map();
try {
  db.history.setMeta('deletions_last_success', new Date().toISOString());
  for (let clan = 0; clan < 10; clan++) {
    const tag = `C${String(clan).padStart(2, '0')}`;
    db.setGuildClanConfig({ guild_id: guildId, clan_tag: tag, member_role_id: 'rank', officer_role_id: null,
      leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
    db.history.upsertClanMatches(guildId, tag, Array.from({ length: gamesPerClan }, (_, game) => ({
      gameId: `game-${game}`, clanTag: tag, clanPlayerCount: game % 12 + 1, hasWon: (clan + game) % 3 !== 0,
      numTeams: 2, playerTeams: '2', totalPlayerCount: 30, gameStart: '2026-10-16T10:00:00.000Z', score: 0.2,
    })));
    db.history.markCoverage({ guild_id: guildId, kind: 'clan', subject: tag, window_start: start, window_end: end }, Date.now());
  }
  for (let player = 0; player < players; player++) {
    const discordId = `user-${player}`, publicId = `account-${player}`;
    members.set(discordId, { id: discordId, user: { bot: false } });
    db.linkGuildUser(guildId, 'benchmark-manager', discordId, publicId, `Player ${player}`);
    db.history.upsertPlayerMatches(guildId, publicId, discordId, Array.from({ length: gamesPerPlayer }, (_, game) => ({
      gameId: `game-${game}`, gameStart: '2026-10-16T10:00:00.000Z', gameEnd: '2026-10-16T11:00:00.000Z',
      gameType: 'Public', gameMode: 'Team', gameRankedType: 'unranked', clientId: 'ephemeral',
      username: `Player ${player}`, clanTag: `C${String(player % 10).padStart(2, '0')}`, hasWon: (player + game) % 3 !== 0,
    })));
    db.history.markCoverage({ guild_id: guildId, kind: 'player', subject: publicId, window_start: start, window_end: end }, Date.now());
  }
  const guild = { id: guildId, members: { fetch: async () => members } };
  const durationsMs = [];
  let report;
  globalThis.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const cpuBefore = process.cpuUsage();
  const timerStart = performance.now();
  const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - timerStart), 0));
  for (let index = 0; index < iterations; index++) {
    const before = performance.now();
    report = (await buildWeeklyReport(guild, start, end)).toJSON();
    durationsMs.push(Number((performance.now() - before).toFixed(2)));
  }
  const timerDelayMs = Number((await timer).toFixed(2));
  const cpu = process.cpuUsage(cpuBefore);
  console.log(JSON.stringify({ runtime: process.version, platform: process.platform, arch: process.arch,
    fixture: { clans: 10, gamesPerClan, players, gamesPerPlayer, iterations },
    durationsMs, cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, timerDelayMs,
    rssBefore, rssAfter: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024,
    explicitGc: typeof globalThis.gc === 'function',
    reportSha256: createHash('sha256').update(JSON.stringify(report)).digest('hex'),
  }, null, 2));
} finally { db.close(); }
