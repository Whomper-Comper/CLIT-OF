import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
  EmbedBuilder, Interaction, MessageFlags, SlashCommandBuilder,
} from "discord.js";
import { db, LinkedUser } from "../db.js";
import { openfrontApi, OpenFrontApiError, OpenFrontPlayerGame } from "../api.js";
import { extractDiscordId, toEpochSeconds } from "../utils.js";
import { PlayerStatsSummary, PlayerStatsType, summarizePlayerStats, winRate } from "../playerStats.js";
import { AnalyticsMode, AnalyticsPeriod, loadPlayerAnalytics, normalizeMapName } from "../playerAnalytics.js";
import { CommandError, label, playerId, profileLink, shortText, throttle } from "./support.js";
import { alignedBarChart } from "./statsGraph.js";
import { eloLineGraph, RatingGraphPoint } from "./statsLineGraph.js";
import { commandErrorMessage } from "./errorMessages.js";

type Analytics = NonNullable<Awaited<ReturnType<typeof loadPlayerAnalytics>>>;
type Ladder = "1v1" | "2v2" | "ffa";
interface HistoryPages {
  pages: OpenFrontPlayerGame[][]; index: number; nextCursor: string | null;
  cursors: Set<string>; gameIds: Set<string>; batches: number; count: number;
}
interface StatsTabs {
  id: string; userId: string; guildId: string | null; messageId: string | null; playerId: string; discordId: string | null;
  expiresAt: number; now: number; busy: boolean; base: EmbedBuilder; stats: unknown; identityVersion: string | null;
  mode: AnalyticsMode; view: "graphs" | "numbers"; scope: PlayerStatsType; period: AnalyticsPeriod;
  map?: string; page: "stats" | "buildings" | "history" | "elo"; ladder: Ladder;
  history: Map<AnalyticsMode, HistoryPages>; analytics: Map<AnalyticsMode, Analytics>;
  elo?: { points: RatingGraphPoint[]; current?: number; message?: string; ladder: Ladder };
  eloAttemptedAt?: number; eloRefreshMessage?: string;
}
const tabs = new Map<string, StatsTabs>();
const tabLifetime = 10 * 60_000, tabPrefix = "stats-pages:", historyPageSize = 5, historyMatchLimit = 100, historyBatchLimit = 20;
const modes: AnalyticsMode[] = ["ffa", "team", "hvn", "ranked", "all"];
const periods: AnalyticsPeriod[] = ["all", "24h", "7d", "30d", "90d", "365d"];
const historyEnabled = (guildId: string | null) => !guildId || db.history.getSettings(guildId).player_history_enabled === 1;
const usesHistoryStats = (session: StatsTabs) => session.period !== "all" || !!session.map;

export const statsCommand = {
  data: new SlashCommandBuilder().setName("stats").setDescription("Explore OpenFront statistics, maps, match history and Elo")
    .addUserOption((option) => option.setName("user").setDescription("Discord user to look up"))
    .addStringOption((option) => option.setName("openfront_id").setDescription("OpenFront public ID, profile URL, or Discord ID"))
    .addStringOption((option) => option.setName("view").setDescription("Show aligned graphs or exact numbers (default: graphs)")
      .addChoices({ name: "Graphs", value: "graphs" }, { name: "Raw numbers", value: "numbers" }))
    .addStringOption((option) => option.setName("scope").setDescription("Match types to include (default: public)")
      .addChoices({ name: "Public matches", value: "public" }, { name: "Private matches", value: "private" },
        { name: "Singleplayer matches", value: "singleplayer" }, { name: "All match types", value: "all" }))
    .addStringOption((option) => option.setName("mode").setDescription("Game mode (default: Free For All)")
      .addChoices({ name: "Free For All", value: "ffa" }, { name: "Teams", value: "team" },
        { name: "Humans Vs Nations", value: "hvn" }, { name: "Ranked", value: "ranked" }, { name: "All modes", value: "all" }))
    .addStringOption((option) => option.setName("period").setDescription("Match period in UTC; recent periods use recorded history")
      .addChoices({ name: "All time", value: "all" }, { name: "Last 24 hours", value: "24h" }, { name: "Last 7 days", value: "7d" },
        { name: "Last 30 days", value: "30d" }, { name: "Last 90 days", value: "90d" }, { name: "Last 365 days", value: "365d" }))
    .addStringOption((option) => option.setName("map").setDescription("Exact map name, such as World (case insensitive)").setMaxLength(100))
    .addStringOption((option) => option.setName("ladder").setDescription("Ranked Elo ladder (default: 1v1)")
      .addChoices({ name: "1v1", value: "1v1" }, { name: "2v2", value: "2v2" }, { name: "Ranked FFA", value: "ffa" })),

  async execute(interaction: ChatInputCommandInteraction) {
    const user = interaction.options.getUser("user"), input = interaction.options.getString("openfront_id")?.trim();
    const selectedScope = interaction.options.getString("scope"), selectedMode = interaction.options.getString("mode"), selectedPeriod = interaction.options.getString("period");
    const scope: PlayerStatsType = selectedScope === "private" || selectedScope === "singleplayer" || selectedScope === "all" ? selectedScope : "public";
    const mode: AnalyticsMode = modes.includes(selectedMode as AnalyticsMode) ? selectedMode as AnalyticsMode : "ffa";
    const period: AnalyticsPeriod = periods.includes(selectedPeriod as AnalyticsPeriod) ? selectedPeriod as AnalyticsPeriod : "all";
    const selectedLadder = interaction.options.getString("ladder"), ladder: Ladder = selectedLadder === "2v2" || selectedLadder === "ffa" ? selectedLadder : "1v1";
    const map = interaction.options.getString("map")?.trim() || undefined;
    if (Boolean(user) === Boolean(input)) throw new CommandError("Provide exactly one of `user` or `openfront_id`.");
    if (map && (map.length > 100 || /[\r\n\u0000-\u001f]/.test(map) || !normalizeMapName(map))) throw new CommandError("Provide a map name of up to 100 characters on one line.");
    if ((period !== "all" || map) && !historyEnabled(interaction.guildId)) throw new CommandError("Player game history is disabled in this server's configuration. Enable it to use periods or maps.");
    throttle(`stats:${interaction.user.id}`, 3000);
    await interaction.deferReply();
    const discordId = user?.id ?? (input ? extractDiscordId(input) : null);
    let link: LinkedUser | null, id: string;
    if (discordId) {
      link = interaction.guildId ? db.getEffectiveLink(interaction.guildId, discordId) : db.getUserByDiscordId(discordId);
      if (!link) throw new CommandError(`Discord user <@${discordId}> has no link available here.`);
      id = link.openfront_id;
    } else {
      id = playerId(input!);
      link = interaction.guildId ? db.getEffectiveLinkByOpenFrontId(interaction.guildId, id) : db.getUserByOpenFrontId(id);
    }
    let profile;
    try { profile = await openfrontApi.getPlayerProfile(id); }
    catch (error) { if (!link) throw error; }
    if (!profile && !link) throw new CommandError("That OpenFront profile was not found, and no link is available here.");
    const name = profile?.username || link?.openfront_username || id;
    const base = new EmbedBuilder().setTitle(shortText(`Stats: ${label(name)}`, 256)).setColor(profile ? 0x3b82f6 : 0xf59e0b)
      .addFields({ name: "OpenFront Profile", value: profileLink(id, name) });
    if (!profile) base.setDescription("The stored link is available, but live profile statistics could not be loaded.");
    const now = Date.now();
    const session: StatsTabs = { id: randomUUID(), userId: interaction.user.id, guildId: interaction.guildId, messageId: null,
      playerId: id, discordId: link?.discord_id ?? null, identityVersion: link?.linked_at ?? null, expiresAt: now + tabLifetime, now, busy: false, base, stats: profile?.stats, mode, scope, period, map, ladder,
      view: interaction.options.getString("view") === "numbers" ? "numbers" : "graphs", page: "stats", history: new Map(), analytics: new Map() };
    for (const [key, value] of tabs) if (value.expiresAt <= now) tabs.delete(key);
    if (tabs.size >= 500) tabs.delete(tabs.keys().next().value!);
    tabs.set(session.id, session);
    try {
      let error: string | undefined;
      if (usesHistoryStats(session)) {
        try { await ensureAnalytics(session); }
        catch (cause) { error = commandErrorMessage(cause, session.guildId); }
        if (!sessionLive(session)) throw new CommandError("These statistics expired while loading. Run `/stats` again.");
        if (!historyEnabled(session.guildId)) throw new CommandError("Player game history was disabled while these statistics loaded.");
      }
      const message = await interaction.editReply(render(session, error));
      session.messageId = message?.id ?? null;
    } catch (error) { tabs.delete(session.id); throw error; }
  },
};

export async function handleStatsInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton() && interaction.customId.startsWith("whois-stats:")) {
    await interaction.reply({ content: "Statistics moved to `/stats`. Run it again to open fresh pages.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!interaction.isButton() || !interaction.customId.startsWith(tabPrefix)) return false;
  const [, id, action, extra] = interaction.customId.split(":");
  if (extra !== undefined || ![...modes, "stats", "buildings", "history", "elo", "graphs", "numbers", "previous", "next", "elo-1v1", "elo-2v2", "elo-ffa"].includes(action)) return false;
  const session = tabs.get(id);
  const reject = async (content: string) => { await interaction.reply({ content, flags: MessageFlags.Ephemeral }); return true; };
  if (!session || session.expiresAt <= Date.now()) {
    if (session) tabs.delete(id);
    return reject("These statistics expired. Run `/stats` again to refresh them.");
  }
  if (interaction.user.id !== session.userId) return reject("Only the person who ran `/stats` can change these pages.");
  if (interaction.guildId !== session.guildId || !session.messageId || interaction.message.id !== session.messageId) return reject("These controls belong to a different statistics message. Run `/stats` again.");
  if (session.busy) return reject("A statistics page is still loading. Please try again in a moment.");
  if ((action === "next" || action === "previous") && session.page !== "history") return reject("Open Game history before changing its page.");
  const targetPage = action === "stats" || action === "buildings" || action === "history" || action === "elo" ? action
    : action.startsWith("elo-") ? "elo" : session.page;
  const needsHistory = targetPage === "history" || targetPage === "elo" || (targetPage === "stats" && usesHistoryStats(session));
  if (needsHistory && !historyEnabled(session.guildId)) return reject("Player game history is disabled in this server's configuration.");
  session.busy = true;
  try {
    await interaction.deferUpdate();
    if (!sessionLive(session)) { await interaction.followUp({ content: "These statistics expired. Run `/stats` again.", flags: MessageFlags.Ephemeral }); return true; }
    if (modes.includes(action as AnalyticsMode)) session.mode = action as AnalyticsMode;
    else if (action === "stats" || action === "buildings" || action === "history" || action === "elo") session.page = action;
    else if (action === "graphs" || action === "numbers") session.view = action;
    else if (action.startsWith("elo-")) { session.ladder = action.slice(4) as Ladder; session.page = "elo"; if (session.elo?.ladder !== session.ladder) session.elo = undefined; }
    let error: string | undefined;
    try {
      if (usesHistoryStats(session) && (session.page === "stats" || session.page === "history")) await ensureAnalytics(session);
      if (session.page === "history") await loadHistory(session, action === "next");
      if (session.page === "elo" && (!session.elo || (action !== "graphs" && action !== "numbers"))) await loadElo(session);
    } catch (cause) { error = commandErrorMessage(cause, session.guildId); }
    if (!sessionLive(session) || (needsHistory && !historyEnabled(session.guildId))) {
      await interaction.followUp({ content: sessionLive(session) ? "Player game history was disabled while this page loaded."
        : "These statistics expired while loading. Run `/stats` again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    const state = session.history.get(session.mode);
    if (session.page === "history" && state) {
      if (action === "previous") state.index = Math.max(0, state.index - 1);
      if (action === "next" && !error) state.index = Math.min(state.index + 1, state.pages.length - 1);
    }
    await interaction.editReply(render(session, error));
  } finally { session.busy = false; }
  return true;
}

function sessionLive(session: StatsTabs) { return tabs.get(session.id) === session && session.expiresAt > Date.now(); }

async function ensureAnalytics(session: StatsTabs) {
  if (session.analytics.has(session.mode)) return;
  const result = await loadPlayerAnalytics(openfrontApi, session.playerId, { mode: session.mode, scope: session.scope,
    period: session.period, map: session.map, now: session.now });
  if (!result) throw new CommandError("OpenFront could not find this player's game history. Run `/stats` again to check the profile.");
  if (sessionLive(session) && historyEnabled(session.guildId)) session.analytics.set(session.mode, result);
}

async function loadHistory(session: StatsTabs, advance: boolean) {
  const existing = session.history.get(session.mode);
  if (usesHistoryStats(session)) {
    if (existing) return;
    await ensureAnalytics(session);
    const analytics = session.analytics.get(session.mode);
    if (analytics) session.history.set(session.mode, historyState(analytics.games));
    return;
  }
  if (existing && (!advance || existing.index + 1 < existing.pages.length || !existing.nextCursor || existing.count >= historyMatchLimit)) return;
  const cursor = existing?.nextCursor ?? undefined;
  const response = await openfrontApi.getPlayerGames(session.playerId, { ...(session.mode === "all" ? {} : { filter: session.mode }),
    ...(session.scope === "all" ? {} : { type: session.scope }), ...(cursor ? { cursor } : {}) });
  if (!sessionLive(session) || !historyEnabled(session.guildId)) return;
  if (response === null) throw new CommandError("OpenFront could not find this player's game history. The account may have been deleted or the public ID may no longer be available. Run `/stats` again to check the profile.");
  const state = existing ?? historyState([]);
  if (cursor) state.cursors.add(cursor);
  state.batches++;
  const results: OpenFrontPlayerGame[] = [];
  for (const game of response.results) {
    if (state.gameIds.has(game.gameId) || state.count + results.length >= historyMatchLimit) continue;
    state.gameIds.add(game.gameId); results.push(game);
  }
  if (state.count === 0 && state.pages.length === 1 && !state.pages[0].length) state.pages = [];
  for (let offset = 0; offset < results.length; offset += historyPageSize) state.pages.push(results.slice(offset, offset + historyPageSize));
  if (!state.pages.length) state.pages.push([]);
  state.count += results.length;
  const next = response.nextCursor;
  state.nextCursor = next && next !== cursor && !state.cursors.has(next) && state.count < historyMatchLimit && state.batches < historyBatchLimit ? next : null;
  session.history.set(session.mode, state);
}

function historyState(games: OpenFrontPlayerGame[]): HistoryPages {
  const pages: OpenFrontPlayerGame[][] = [];
  for (let offset = 0; offset < games.length; offset += historyPageSize) pages.push(games.slice(offset, offset + historyPageSize));
  return { pages: pages.length ? pages : [[]], index: 0, nextCursor: null, cursors: new Set(), gameIds: new Set(games.map(game => game.gameId)), batches: 0, count: games.length };
}

async function loadElo(session: StatsTabs) {
  let message = session.eloRefreshMessage;
  if (!session.eloAttemptedAt || Date.now()-session.eloAttemptedAt >= 30_000) {
    session.eloAttemptedAt = Date.now();
    message = undefined;
    try {
      const response = await openfrontApi.getPlayerRatings(session.playerId);
      if (!sessionLive(session) || !historyEnabled(session.guildId)) return;
      if (session.discordId) {
        const link = session.guildId ? db.getEffectiveLink(session.guildId,session.discordId) : db.getUserByDiscordId(session.discordId);
        if (!link || link.openfront_id !== session.playerId || link.linked_at !== session.identityVersion) {
          session.elo = { points: [], ladder: session.ladder, message: "The identity link changed while ratings loaded. Run `/stats` again to refresh it." };
          return;
        }
      }
      for (const rating of response.ratings) db.history.recordElo(session.guildId ?? "dm", session.playerId, session.discordId, rating.ladder, rating.rating, Date.parse(rating.observedAt ?? response.observedAt));
      if (!response.ratings.some(rating => rating.ladder === session.ladder)) message = response.complete
        ? "This player was not found on the selected public ranked ladder. Existing observations are shown below."
        : "This player was not found within the bounded leaderboard lookup. Existing observations are shown below; this does not prove they are unranked.";
    } catch (error) {
      message = error instanceof OpenFrontApiError && error.status === 403
        ? "OpenFront blocked access to its public ranked leaderboard (HTTP 403). The bot cannot refresh Elo until that endpoint allows access. Existing observations remain available."
        : `Current rating could not be refreshed: ${commandErrorMessage(error, session.guildId)} Existing observations remain available.`;
    }
    session.eloRefreshMessage = message;
  }
  if (!sessionLive(session) || !historyEnabled(session.guildId)) return;
  const end = Date.now(), days = session.period === "24h" ? 1 : session.period === "all" ? null : Number(session.period.slice(0, -1));
  const points = db.history.getEloHistory(session.guildId ?? "dm", session.playerId, session.ladder,
    new Date(days === null ? 0 : session.now - days * 86_400_000).toISOString(), new Date(end + 1).toISOString());
  session.elo = { points, ladder: session.ladder, current: points.at(-1)?.rating,
    message: (message ? message + "\n" : "") + "Only real ratings observed by this bot are stored, within the configured history retention. Older Elo cannot be reconstructed from wins or losses." };
}

function controls(session: StatsTabs): ActionRowBuilder<ButtonBuilder>[] {
  const button = (action: string, title: string, selected = false, disabled = false) => new ButtonBuilder()
    .setCustomId(`${tabPrefix}${session.id}:${action}`).setLabel(title).setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled);
  const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(...modes.map(mode => button(mode, modeLabel(mode), session.mode === mode, session.page === "elo"))),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("stats", "Statistics", session.page === "stats"),
      ...(historyEnabled(session.guildId) ? [button("history", "Game history", session.page === "history"), button("elo", "Elo", session.page === "elo")] : []),
      button("buildings", "Buildings", session.page === "buildings"))];
  if (session.page === "history") {
    const state = session.history.get(session.mode), next = !!state && (state.index + 1 < state.pages.length || state.nextCursor !== null);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("previous", "Previous", false, !state || state.index === 0), button("next", "Next", false, !next)));
  } else if (session.page === "elo") rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("elo-1v1", "1v1", session.ladder === "1v1"), button("elo-2v2", "2v2", session.ladder === "2v2"), button("elo-ffa", "Ranked FFA", session.ladder === "ffa")));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(button("graphs", "Graphs", session.view === "graphs"), button("numbers", "Numbers", session.view === "numbers")));
  return rows;
}

function render(session: StatsTabs, error?: string) {
  let embed: EmbedBuilder;
  const files: AttachmentBuilder[] = [];
  if (session.page === "buildings") embed = renderBuildings(session);
  else if (session.page === "history") embed = renderHistory(session, error);
  else if (session.page === "elo") {
    embed = renderElo(session, error);
    const graph = session.view === "graphs" ? eloLineGraph(session.elo?.points ?? []) : null;
    if (graph) { files.push(new AttachmentBuilder(graph, { name: "elo-history.png" })); embed.setImage("attachment://elo-history.png"); }
  } else embed = renderStats(session, error);
  return { embeds: [embed], components: controls(session), files, attachments: [], allowedMentions: { parse: [] as never[] } };
}

function renderHistory(session: StatsTabs, error?: string) {
  const embed = EmbedBuilder.from(session.base), state = session.history.get(session.mode), games = state?.pages[state.index] ?? [];
  const safe = (value: string) => label(shortText(value, 40));
  embed.addFields({ name: `Recorded game history · ${modeLabel(session.mode)}`, value: selectionLabel(session)
    + "\nIncomplete games have no final result and are excluded from win rate." });
  if (error) embed.addFields({ name: "History could not be refreshed", value: shortText(error, 1024) });
  if (!games.length && !error) embed.addFields({ name: "Recorded games", value: "No recorded games were returned for this player and filter." });
  for (const game of games) {
    const epoch = toEpochSeconds(game.start), result = game.result === "victory" ? "Victory" : game.result === "defeat" ? "Defeat" : "Incomplete / no final result";
    embed.addFields({ name: `${result} · ${safe(game.map)}`, value: `${epoch === null ? "Unknown date" : `<t:${epoch}:f>`} · ${duration(game.durationSeconds)}\n`
      + `${safe(game.mode)} · ${safe(game.type)}${game.rankedType ? ` · ${safe(game.rankedType)}` : ""} · ${game.totalPlayers === null ? "Unknown player count" : `${game.totalPlayers} players`}\n`
      + `Recorded as ${safe(game.username)}${game.clanTag ? ` [${safe(game.clanTag)}]` : ""}\nMatch ID: ${safe(game.gameId)}` });
  }
  if (games.length) {
    const wins = games.filter(game => game.result === "victory").length, losses = games.filter(game => game.result === "defeat").length;
    const results = [{ name: "Wins", value: BigInt(wins) }, { name: "Losses", value: BigInt(losses) }, { name: "Incomplete", value: BigInt(games.length - wins - losses) }];
    embed.addFields({ name: `This page · ${winRate(BigInt(wins), BigInt(wins + losses))} completed win rate`, value: session.view === "graphs" ? alignedBarChart(results) : numericRows(results) });
  }
  const analytics = session.analytics.get(session.mode);
  if (usesHistoryStats(session) && analytics) embed.addFields({ name: "History coverage", value: coverageLabel(analytics) });
  embed.setFooter({ text: `${scopeLabel(session.scope)} · history page ${(state?.index ?? 0) + 1} · ${usesHistoryStats(session) ? "bounded matching history" : `up to ${historyMatchLimit} recent matches per mode`} · history can differ from lifetime totals` });
  return embed;
}

function renderStats(session: StatsTabs, error?: string) {
  const embed = EmbedBuilder.from(session.base);
  if (error) embed.addFields({ name: "Statistics could not be refreshed", value: shortText(error, 1024) });
  if (usesHistoryStats(session)) {
    const result = session.analytics.get(session.mode);
    embed.addFields({ name: "Match selection", value: selectionLabel(session) });
    embed.addFields({ name: "Building stats", value: "Open **Buildings** for lifetime cities, ports, defense posts, factories and missile silos. Use **Graphs** or **Numbers** to change the display. Period and map filters apply to match results." });
    if (!result) { embed.addFields({ name: "Recorded statistics", value: "The selected history could not be loaded. Use Statistics to try again." }); return embed; }
    embed.addFields({ name: `${modeLabel(session.mode)} · recorded results`, value: `**Games:** ${result.total.toLocaleString("en-US")} · **Wins:** ${result.wins.toLocaleString("en-US")} · **Losses:** ${result.losses.toLocaleString("en-US")} · **Incomplete:** ${result.incomplete.toLocaleString("en-US")}\n**Completed win rate:** ${result.winRate}` });
    const rows = [{ name: "Wins", value: BigInt(result.wins) }, { name: "Losses", value: BigInt(result.losses) }, { name: "Incomplete", value: BigInt(result.incomplete) }];
    if (session.view === "graphs") embed.addFields({ name: "Results", value: alignedBarChart(rows) });
    if (result.averageDurationSeconds !== null) embed.addFields({ name: "Average match duration", value: duration(result.averageDurationSeconds), inline: true });
    if (result.maps.length) embed.addFields({ name: session.map ? "Selected map performance" : "Map performance · most played", value: shortText(result.maps.slice(0, 8).map(map => `**${label(shortText(map.map, 40))}:** ${map.total} games · ${map.wins}W / ${map.losses}L · ${map.winRate}`).join("\n"), 1024) });
    embed.addFields({ name: "History coverage", value: coverageLabel(result) });
    embed.setFooter({ text: `${scopeLabel(session.scope)} · ${modeLabel(session.mode)} · dated/map-filtered history has no building counters` });
    return embed;
  }
  const stats = lifetimeSummary(session);
  const title = `${modeLabel(session.mode)} Stats`;
  if (!stats) {
    embed.addFields({ name: title, value: "No recorded statistics were provided by OpenFront for this scope and mode." });
    embed.setFooter({ text: `${scopeLabel(session.scope)} · ${modeLabel(session.mode)} · all time` }); return embed;
  }
  addLifetime(embed, stats, title, session.view);
  const incomplete = stats.partial || stats.buildings.some(item => item.partial) || stats.details.some(item => item.partial);
  embed.setFooter({ text: `${scopeLabel(session.scope)} · ${modeLabel(session.mode)} · lifetime totals${incomplete ? " · some counters unavailable or partial" : ""}` });
  return embed;
}

function lifetimeSummary(session: StatsTabs) {
  const filter = session.mode === "all" ? undefined : session.mode === "team" ? "teams" : session.mode;
  return summarizePlayerStats(session.stats, filter, { type: session.scope, includeRanked: true });
}

function renderBuildings(session: StatsTabs) {
  const stats = lifetimeSummary(session);
  const buildings = stats?.buildings ?? ["Cities", "Ports", "Defense posts", "Factories", "Missile silos"]
    .map(name => ({ name, value: null, partial: false }));
  const embed = EmbedBuilder.from(session.base)
    .addFields({ name: "Building stats · lifetime totals", value: `${scopeLabel(session.scope)} · ${modeLabel(session.mode)}\nPeriod and map filters do not apply to these building totals.` },
      { name: "Buildings built", value: session.view === "graphs" ? alignedBarChart(buildings) : numericRows(buildings) });
  if (session.view === "graphs") embed.addFields({ name: "Exact available building totals", value: numericRows(buildings) });
  if (!stats) embed.addFields({ name: "Building data unavailable", value: "OpenFront did not provide building counters for this mode and scope." });
  const partial = buildings.some(item => item.partial || item.value === null);
  embed.setFooter({ text: `${scopeLabel(session.scope)} · ${modeLabel(session.mode)} · lifetime buildings${partial ? " · some counters unavailable or partial" : ""}` });
  return embed;
}

function addLifetime(embed: EmbedBuilder, stats: PlayerStatsSummary, title: string, view: "graphs" | "numbers") {
  const number = (value: bigint) => value.toLocaleString("en-US");
  embed.addFields({ name: title, value: `**Games:** ${number(stats.games)} · **Wins:** ${number(stats.wins)} · **Losses:** ${number(stats.losses)} · **Win rate:** ${winRate(stats.wins, stats.games)}` });
  if (view === "graphs") embed.addFields({ name: "Wins / losses", value: alignedBarChart([{ name: "Wins", value: stats.wins }, { name: "Losses", value: stats.losses }]) });
  embed.addFields({ name: "Buildings built · lifetime totals", value: view === "graphs" ? alignedBarChart(stats.buildings) : numericRows(stats.buildings) });
  const details = view === "graphs" ? stats.details : stats.details.filter(item => !/^(Cities|Ports|Defense posts|Factories|Missile silos) built$/.test(item.name));
  let lines: string[] = [], continued = false;
  const flush = () => { embed.addFields({ name: continued ? "Lifetime totals (continued)" : "Lifetime totals", value: lines.join("\n") }); lines = []; continued = true; };
  for (const item of details) { const line = `${item.name}: **${number(item.value)}**${item.partial ? " (partial)" : ""}`; if (lines.join("\n").length + line.length + 1 > 1024) flush(); lines.push(line); }
  if (lines.length) flush();
}

function renderElo(session: StatsTabs, error?: string) {
  const embed = EmbedBuilder.from(session.base).addFields({ name: `Ranked Elo over time · ${session.ladder === "ffa" ? "FFA" : session.ladder}`, value: "Account ranked rating, independent of map, match scope and game-mode filters. Only the selected period applies to this page." });
  if (error) embed.addFields({ name: "Elo could not be refreshed", value: shortText(error, 1024) });
  const points = session.elo?.points ?? [];
  if (session.elo?.current !== undefined) embed.addFields({ name: "Latest observed Elo", value: session.elo.current.toLocaleString("en-US"), inline: true });
  if (session.elo?.message) embed.addFields({ name: "Rating coverage", value: shortText(session.elo.message, 1024) });
  if (!points.length && !error) embed.addFields({ name: "Recorded rating history", value: "No dated rating samples are available for this period." });
  else if (points.length && session.view === "numbers") embed.addFields({ name: "Recent observed rating samples", value: shortText(points.slice(-10).map(point => `${new Date(point.at).toISOString().replace("T", " ").slice(0, 16)} UTC: **${point.rating.toLocaleString("en-US")}**`).join("\n"), 1024) });
  if (points.length === 1) embed.addFields({ name: "Tracking has started", value: "One observation is a point. At least two dated observations are needed to show a change over time." });
  embed.setFooter({ text: `${periodLabel(session.period)} · observed ranked ratings · gaps have no reconstructed values` });
  return embed;
}

function selectionLabel(session: StatsTabs) { return `${scopeLabel(session.scope)} · ${modeLabel(session.mode)} · ${periodLabel(session.period)}${session.map ? `\nMap: **${label(session.map)}** (exact name)` : ""}`; }
function coverageLabel(result: Analytics) {
  const coverage = result.coverage;
  return `${coverage.complete ? "Complete for the history returned by OpenFront in this selection." : "Partial selection; more matching results may exist."}\n`
    + `${coverage.scanned.toLocaleString("en-US")} records scanned across ${coverage.pages} API page(s). Stop: ${coverage.reason.replaceAll("_", " ")}. History can differ from lifetime account totals.`;
}
function modeLabel(mode: AnalyticsMode) { return mode === "ffa" ? "Free For All" : mode === "team" ? "Teams" : mode === "hvn" ? "Humans Vs Nations" : mode === "ranked" ? "Ranked" : "All modes"; }
function periodLabel(period: AnalyticsPeriod) { return period === "all" ? "All time" : period === "24h" ? "Last 24 hours" : `Last ${period.slice(0, -1)} days`; }
function scopeLabel(scope: PlayerStatsType) { return scope === "all" ? "All public, private and singleplayer matches" : scope === "public" ? "Public matches" : scope === "private" ? "Private matches" : "Singleplayer matches"; }
function duration(seconds: number) { const minutes = Math.floor(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m` : "Under 1m"; }
function numericRows(rows: { name: string; value: bigint | null; partial?: boolean }[]) { return rows.map(item => `${item.name}: ${item.value === null ? "Unavailable" : `**${item.value.toLocaleString("en-US")}**${item.partial ? " (partial)" : ""}`}`).join("\n"); }
