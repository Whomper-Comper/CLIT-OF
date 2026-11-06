import { EmbedBuilder, Guild } from "discord.js";
import { db } from "./db.js";
import { openfrontApi } from "./api.js";
import { OpenFrontClanSession } from "./historyTypes.js";
import { alignedBarChart } from "./commands/statsGraph.js";
import { CommandError, label, pageOf, profileLink, shortText } from "./commands/support.js";
import { winRate } from "./playerStats.js";
import { humanMemberLinks } from "./memberLinks.js";

const day = 86_400_000;
export type HistoryView = "numbers" | "graphs" | "both";
export interface ClanHistorySample { rows: OpenFrontClanSession[]; complete: boolean; start: string; end: string; requests: number }

/** Bound work independently of API totals; never present a limited sample as a complete window. */
export async function loadRecentClanMatches(tag: string, days = 7, now = Date.now(), maxRequests = 24): Promise<ClanHistorySample> {
  if (!Number.isInteger(days) || days < 1 || days > 14) throw new CommandError("Choose history days from 1 to 14.");
  const end = Math.floor(now / 60_000) * 60_000, start = end - days * day;
  const rows = new Map<string, OpenFrontClanSession>();
  const deadline = Date.now() + 60_000;
  let requests = 0, complete = true;
  outer: for (let upper = end; upper > start;) {
    const lower = Math.max(start, upper - day);
    let page = 1;
    while (true) {
      if (requests >= maxRequests || Date.now() >= deadline || page > 200) { complete = false; break outer; }
      requests++;
      const data = await openfrontApi.getClanSessions(tag, { start: new Date(lower).toISOString(), end: new Date(upper).toISOString(), page, limit: 50 });
      if (!data) throw new CommandError("That OpenFront clan was not found.");
      for (const row of data.results) {
        const timestamp = Date.parse(row.gameStart);
        if (row.clanTag.trim().toUpperCase() !== tag.trim().toUpperCase() || !Number.isFinite(timestamp) || timestamp < lower || timestamp > upper) {
          complete = false;
          continue;
        }
        if (timestamp < upper) rows.set(row.gameId, row);
      }
      if (page * data.limit >= data.total) break;
      if (!data.results.length) { complete = false; break outer; }
      page++;
    }
    upper = lower;
  }
  return { rows: [...rows.values()].sort((a, b) => b.gameStart.localeCompare(a.gameStart) || a.gameId.localeCompare(b.gameId)),
    complete, start: new Date(start).toISOString(), end: new Date(end).toISOString(), requests };
}

/** Consume canonical rows once, optionally collecting distinct games across clans. */
function summarizeClanMatches(rows: Iterable<OpenFrontClanSession>, gameIds?: Set<string>) {
  let games = 0, wins = 0, turnout = 0, peakTurnout = 0, score = 0;
  for (const row of rows) {
    gameIds?.add(row.gameId);
    games++;
    if (row.hasWon) wins++;
    turnout += row.clanPlayerCount;
    peakTurnout = Math.max(peakTurnout, row.clanPlayerCount);
    score += row.score;
  }
  return { games, wins, losses: games - wins, averageTurnout: games ? turnout / games : 0, peakTurnout, score };
}

export function clanAnalysis(rows: OpenFrontClanSession[]) {
  const unique = new Map(rows.map(row => [row.gameId, row]));
  return summarizeClanMatches(unique.values());
}

export function renderClanRecent(tag: string, sample: ClanHistorySample, page = 1, view: HistoryView = "both"): EmbedBuilder {
  const stats = clanAnalysis(sample.rows), selected = pageOf(sample.rows, page, 5);
  const start = Math.floor(Date.parse(sample.start) / 1000), end = Math.floor(Date.parse(sample.end) / 1000);
  const embed = new EmbedBuilder().setColor(sample.complete ? 0x3b82f6 : 0xf59e0b).setTitle(`[${label(tag)}] Recent matches and analysis`)
    .setDescription(`Recorded public Team appearances · <t:${start}:f> to <t:${end}:f>\n${sample.complete ? "Complete requested API window." : "Partial sample: request/time limits or inconsistent API results prevented complete coverage; totals cover only matching records returned."}`);
  if (view !== "graphs") embed.addFields({ name: "Recorded results", value: `**${stats.games}** games · **${stats.wins}** wins · **${stats.losses}** losses · **${winRate(BigInt(stats.wins), BigInt(stats.games))}** win rate\nAverage tagged turnout: **${stats.averageTurnout.toFixed(1)}** · Peak: **${stats.peakTurnout}**\nRecorded API score sum: **${stats.score.toFixed(2)}**` });
  if (view !== "numbers") {
    embed.addFields({ name: "Results", value: alignedBarChart([{ name: "Wins", value: BigInt(stats.wins) }, { name: "Losses", value: BigInt(stats.losses) }]) },
      { name: "Tagged clan turnout", value: alignedBarChart([
        { name: "1 player", value: BigInt(sample.rows.filter(row => row.clanPlayerCount === 1).length) },
        { name: "2–3 players", value: BigInt(sample.rows.filter(row => row.clanPlayerCount >= 2 && row.clanPlayerCount <= 3).length) },
        { name: "4–7 players", value: BigInt(sample.rows.filter(row => row.clanPlayerCount >= 4 && row.clanPlayerCount <= 7).length) },
        { name: "8+ players", value: BigInt(sample.rows.filter(row => row.clanPlayerCount >= 8).length) },
      ]) });
  }
  if (!selected.items.length) embed.addFields({ name: "Recent matches", value: "No recorded matches in this window." });
  for (const row of selected.items) embed.addFields({ name: `${label(row.gameId)} · ${row.hasWon ? "Win" : "Loss"}`,
    value: `<t:${Math.floor(Date.parse(row.gameStart) / 1000)}:f>\n${row.clanPlayerCount} tagged player(s) · ${row.numTeams} teams · ${row.totalPlayerCount} total players · score ${row.score.toFixed(2)}` });
  return embed.setFooter({ text: `${selected.footer} · Results describe tagged appearances; they do not verify account identity or live presence.` });
}

/** Preview and scheduled delivery use the same analysis and exactly the same historical window. */
export async function buildWeeklyReport(guild: Guild, start: string, end: string): Promise<EmbedBuilder> {
  const settings = db.history.getSettings(guild.id), configs = db.getGuildConfigs(guild.id);
  const members = await guild.members.fetch();
  const links = humanMemberLinks(db.getEffectiveLinks(guild.id), members);
  const validIds = new Map(links.map(link => [link.openfront_id, link]));
  const tags = new Set(configs.map(config => config.clan_tag.toUpperCase()));
  const gameIds = new Set<string>();
  let clanWins = 0, clanLosses = 0;
  const clanStats = configs.map(config => {
    // The store yields one canonical row per clan/game, including any correction.
    const stats = summarizeClanMatches(db.history.iterateClanMatches(guild.id, config.clan_tag, start, end), gameIds);
    clanWins += stats.wins;
    clanLosses += stats.losses;
    return { config, stats };
  });
  const clanCoverage = db.history.getCoverageBySubject(guild.id, "clan", configs.map(config => config.clan_tag), start, end);
  const completeClans = [...clanCoverage.values()].filter(coverage => coverage.complete).length;
  const players = new Map<string, { games: number; wins: number }>();
  const deletionCheck = Date.parse(db.history.getMeta("deletions_last_success") ?? "");
  const deletionsFresh = Number.isFinite(deletionCheck) && Date.now() - deletionCheck < day;
  const rankingsEnabled = settings.player_history_enabled === 1;
  let incomplete = 0;
  for (const row of deletionsFresh && rankingsEnabled ? db.history.iteratePlayerMatches(guild.id, start, end,
    links.map(link => ({ publicId: link.openfront_id, discordId: link.discord_id }))) : []) {
    const link = validIds.get(row.public_id);
    if (!link || link.discord_id !== row.discord_id || !row.clanTag || !tags.has(row.clanTag.trim().toUpperCase()) || row.gameType.toLowerCase() !== "public" || row.gameMode.toLowerCase() !== "team") continue;
    if (!row.gameEnd) { incomplete++; continue; }
    // The store's (guild_id,public_id,game_id) primary key has already applied
    // corrections/deduplication; player aggregates need no retained game IDs.
    const entry = players.get(row.public_id) ?? { games: 0, wins: 0 };
    entry.games++;
    if (row.hasWon) entry.wins++;
    players.set(row.public_id, entry);
  }
  const ranked = [...players].sort((a, b) => b[1].wins - a[1].wins || b[1].games - a[1].games || a[0].localeCompare(b[0]));
  const bestRates = ranked.filter(([, entry]) => entry.games >= 3).sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games || b[1].games - a[1].games);
  const playerCoverage = deletionsFresh && rankingsEnabled
    ? db.history.getCoverageBySubject(guild.id, "player", links.map(link => link.openfront_id), start, end) : new Map();
  const completePlayers = [...playerCoverage.values()].filter(coverage => coverage.complete).length;
  const embed = new EmbedBuilder().setTitle("OpenFront weekly clan recap").setColor(completeClans === configs.length && (!rankingsEnabled || completePlayers === links.length) ? 0x3b82f6 : 0xf59e0b)
    .setDescription(`<t:${Math.floor(Date.parse(start) / 1000)}:f> to <t:${Math.floor(Date.parse(end) / 1000)}:f>\n**${gameIds.size}** distinct recorded games across **${configs.length}** configured clan(s).`);
  for (const { config, stats } of clanStats.slice(0, 8)) {
    embed.addFields({ name: `[${label(config.clan_tag)}]`, value: `${stats.games} recorded games · ${stats.wins} wins · ${stats.losses} losses · ${winRate(BigInt(stats.wins), BigInt(stats.games))}\nPeak tagged turnout ${stats.peakTurnout} · average ${stats.averageTurnout.toFixed(1)} · API score sum ${stats.score.toFixed(2)}`, inline: true });
  }
  const performer = ([id, entry]: typeof ranked[number]) => `${profileLink(id, shortText(validIds.get(id)?.openfront_username || id, 32))} — **${entry.wins}** wins / **${entry.games}** appearances (${winRate(BigInt(entry.wins), BigInt(entry.games))})`;
  embed.addFields({ name: "Most recorded wins · linked server members", value: ranked.slice(0, 5).map(performer).join("\n") || (!rankingsEnabled ? "Player history and rankings are disabled in /config." : deletionsFresh ? "No eligible player sessions were collected." : "Player rankings are withheld until the daily deleted-account check succeeds.") },
    { name: "Best recorded win fraction · at least 3 games", value: bestRates.slice(0, 3).map(performer).join("\n") || "No player has at least three collected games." },
    { name: "Clan result entries", value: alignedBarChart([{ name: "Wins", value: BigInt(clanWins) }, { name: "Losses", value: BigInt(clanLosses) }]) },
    { name: "Collection coverage", value: `${completeClans}/${configs.length} clans${rankingsEnabled ? ` and ${completePlayers}/${links.length} current linked members` : " (player rankings disabled)"} have a fully checked window. ${completeClans < configs.length || (rankingsEnabled && completePlayers < links.length) ? "Coverage is partial; missing records can change rankings." : "All configured sources were checked for this window."}${configs.length > 8 ? ` Only the first 8 clan breakdowns are displayed; totals include all ${configs.length}.` : ""}\nRankings use stable linked accounts, completed public Team sessions and the clan tag recorded at game time. ${incomplete} record(s) without an end timestamp were excluded. This is not a tournament qualification system.` });
  return embed.setFooter({ text: shortText(`Weekly schedule zone: ${settings.timezone} · ${settings.collection_enabled ? "Automatic collection enabled" : "Automatic collection disabled"}`, 200) });
}
