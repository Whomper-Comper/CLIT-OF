import { EmbedBuilder, Guild } from "discord.js";
import { db } from "./db.js";
import { openfrontApi } from "./api.js";
import { OpenFrontClanSession } from "./historyTypes.js";
import { alignedBarChart } from "./commands/statsGraph.js";
import { CommandError, label, pageOf, profileLink, shortText } from "./commands/support.js";
import { winRate } from "./playerStats.js";

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

export function clanAnalysis(rows: OpenFrontClanSession[]) {
  const unique = [...new Map(rows.map(row => [row.gameId, row])).values()];
  const wins = unique.filter(row => row.hasWon).length;
  return { games: unique.length, wins, losses: unique.length - wins,
    averageTurnout: unique.length ? unique.reduce((total, row) => total + row.clanPlayerCount, 0) / unique.length : 0,
    peakTurnout: unique.reduce((peak, row) => Math.max(peak, row.clanPlayerCount), 0),
    score: unique.reduce((total, row) => total + row.score, 0) };
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
  const links = db.getEffectiveLinks(guild.id).filter(link => members.has(link.discord_id) && !members.get(link.discord_id)!.user.bot);
  const validIds = new Map(links.map(link => [link.openfront_id, link]));
  const tags = new Set(configs.map(config => config.clan_tag.toUpperCase()));
  const clanRows = configs.map(config => ({ config, rows: db.history.getClanMatches(guild.id, config.clan_tag, start, end) }));
  const allRows = clanRows.flatMap(clan => clan.rows);
  const clanCoverage = db.history.getCoverageBySubject(guild.id, "clan", configs.map(config => config.clan_tag), start, end);
  const completeClans = [...clanCoverage.values()].filter(coverage => coverage.complete).length;
  const players = new Map<string, { games: Set<string>; wins: Set<string> }>();
  const deletionCheck = Date.parse(db.history.getMeta("deletions_last_success") ?? "");
  const deletionsFresh = Number.isFinite(deletionCheck) && Date.now() - deletionCheck < day;
  const rankingsEnabled = settings.player_history_enabled === 1;
  let incomplete = 0;
  for (const row of deletionsFresh && rankingsEnabled ? db.history.getPlayerMatches(guild.id, start, end) : []) {
    const link = validIds.get(row.public_id);
    if (!link || link.discord_id !== row.discord_id || !row.clanTag || !tags.has(row.clanTag.trim().toUpperCase()) || row.gameType.toLowerCase() !== "public" || row.gameMode.toLowerCase() !== "team") continue;
    if (!row.gameEnd) { incomplete++; continue; }
    const entry = players.get(row.public_id) ?? { games: new Set<string>(), wins: new Set<string>() };
    entry.games.add(row.gameId);
    if (row.hasWon) entry.wins.add(row.gameId);
    players.set(row.public_id, entry);
  }
  const ranked = [...players].sort((a, b) => b[1].wins.size - a[1].wins.size || b[1].games.size - a[1].games.size || a[0].localeCompare(b[0]));
  const bestRates = ranked.filter(([, entry]) => entry.games.size >= 3).sort((a, b) => b[1].wins.size / b[1].games.size - a[1].wins.size / a[1].games.size || b[1].games.size - a[1].games.size);
  const playerCoverage = deletionsFresh && rankingsEnabled
    ? db.history.getCoverageBySubject(guild.id, "player", links.map(link => link.openfront_id), start, end) : new Map();
  const completePlayers = [...playerCoverage.values()].filter(coverage => coverage.complete).length;
  const embed = new EmbedBuilder().setTitle("OpenFront weekly clan recap").setColor(completeClans === configs.length && (!rankingsEnabled || completePlayers === links.length) ? 0x3b82f6 : 0xf59e0b)
    .setDescription(`<t:${Math.floor(Date.parse(start) / 1000)}:f> to <t:${Math.floor(Date.parse(end) / 1000)}:f>\n**${new Set(allRows.map(row => row.gameId)).size}** distinct recorded games across **${configs.length}** configured clan(s).`);
  for (const { config, rows } of clanRows.slice(0, 8)) {
    const stats = clanAnalysis(rows);
    embed.addFields({ name: `[${label(config.clan_tag)}]`, value: `${stats.games} recorded games · ${stats.wins} wins · ${stats.losses} losses · ${winRate(BigInt(stats.wins), BigInt(stats.games))}\nPeak tagged turnout ${stats.peakTurnout} · average ${stats.averageTurnout.toFixed(1)} · API score sum ${stats.score.toFixed(2)}`, inline: true });
  }
  const performer = ([id, entry]: typeof ranked[number]) => `${profileLink(id, shortText(validIds.get(id)?.openfront_username || id, 32))} — **${entry.wins.size}** wins / **${entry.games.size}** appearances (${winRate(BigInt(entry.wins.size), BigInt(entry.games.size))})`;
  embed.addFields({ name: "Most recorded wins · linked server members", value: ranked.slice(0, 5).map(performer).join("\n") || (!rankingsEnabled ? "Player history and rankings are disabled in /config." : deletionsFresh ? "No eligible player sessions were collected." : "Player rankings are withheld until the daily deleted-account check succeeds.") },
    { name: "Best recorded win fraction · at least 3 games", value: bestRates.slice(0, 3).map(performer).join("\n") || "No player has at least three collected games." },
    { name: "Clan result entries", value: alignedBarChart([{ name: "Wins", value: BigInt(allRows.filter(row => row.hasWon).length) }, { name: "Losses", value: BigInt(allRows.filter(row => !row.hasWon).length) }]) },
    { name: "Collection coverage", value: `${completeClans}/${configs.length} clans${rankingsEnabled ? ` and ${completePlayers}/${links.length} current linked members` : " (player rankings disabled)"} have a fully checked window. ${completeClans < configs.length || (rankingsEnabled && completePlayers < links.length) ? "Coverage is partial; missing records can change rankings." : "All configured sources were checked for this window."}${configs.length > 8 ? ` Only the first 8 clan breakdowns are displayed; totals include all ${configs.length}.` : ""}\nRankings use stable linked accounts, completed public Team sessions and the clan tag recorded at game time. ${incomplete} record(s) without an end timestamp were excluded. This is not a tournament qualification system.` });
  return embed.setFooter({ text: shortText(`Weekly schedule zone: ${settings.timezone} · ${settings.collection_enabled ? "Automatic collection enabled" : "Automatic collection disabled"}`, 200) });
}
