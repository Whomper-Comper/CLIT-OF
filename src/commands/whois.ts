import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
  EmbedBuilder, Interaction, MessageFlags, SlashCommandBuilder,
} from "discord.js";
import { db, LinkedUser } from "../db.js";
import { openfrontApi, OpenFrontPlayerGame, OpenFrontPlayerProfile } from "../api.js";
import { extractDiscordId, toEpochSeconds } from "../utils.js";
import { PlayerGameMode, PlayerStatsSummary, summarizePlayerStats, winRate } from "../playerStats.js";
import { CommandError, label, playerId, profileLink, shortText, throttle } from "./support.js";
import { alignedBarChart } from "./statsGraph.js";
import { commandErrorMessage } from "./errorMessages.js";

interface StatsTabs {
  id: string;
  userId: string;
  guildId: string | null;
  messageId: string | null;
  playerId: string;
  expiresAt: number;
  busy: boolean;
  base: EmbedBuilder;
  ffa: PlayerStatsSummary | null;
  teams: PlayerStatsSummary | null;
  mode: PlayerGameMode;
  page: "stats" | "history";
  filter: HistoryFilter;
  history: Map<HistoryFilter, HistoryPages>;
}
type HistoryFilter = "all" | "ffa" | "team";
interface HistoryPages {
  pages: OpenFrontPlayerGame[][];
  index: number;
  nextCursor: string | null;
  cursors: Set<string>;
  gameIds: Set<string>;
  batches: number;
  count: number;
}
const tabs = new Map<string, StatsTabs>();
const tabLifetime = 10 * 60_000;
const tabPrefix = "whois-stats:";
const historyPageSize = 5;
const historyMatchLimit = 100;
const historyBatchLimit = 20;
const historyEnabled = (guildId: string | null) => !guildId || db.history.getSettings(guildId).player_history_enabled === 1;

export const whoisCommand = {
  data: new SlashCommandBuilder().setName("whois").setDescription("Look up a Discord user or OpenFront public ID")
    .addUserOption((option) => option.setName("user").setDescription("Discord user to look up"))
    .addStringOption((option) => option.setName("openfront_id").setDescription("OpenFront public ID, profile URL, or Discord ID")),

  async execute(interaction: ChatInputCommandInteraction) {
    const user = interaction.options.getUser("user");
    const input = interaction.options.getString("openfront_id")?.trim();
    if (Boolean(user) === Boolean(input)) throw new CommandError("Provide exactly one of `user` or `openfront_id`.");
    throttle(`whois:${interaction.user.id}`, 3000);
    await interaction.deferReply();
    const discordId = user?.id ?? (input ? extractDiscordId(input) : null);
    let link: LinkedUser | null;
    let id: string;
    if (discordId) {
      link = interaction.guildId ? db.getEffectiveLink(interaction.guildId, discordId) : db.getUserByDiscordId(discordId);
      if (!link) throw new CommandError(`Discord user <@${discordId}> has no link available here.`);
      id = link.openfront_id;
    } else {
      id = playerId(input!);
      link = interaction.guildId ? db.getEffectiveLinkByOpenFrontId(interaction.guildId, id) : db.getUserByOpenFrontId(id);
    }
    let profile: OpenFrontPlayerProfile | null = null;
    let unavailable = false;
    try { profile = await openfrontApi.getPlayerProfile(id); }
    catch (error) {
      if (!link) throw error;
      unavailable = true;
    }
    if (!profile && !link) throw new CommandError("That OpenFront profile was not found, and no link is available here.");
    const name = profile?.username || link?.openfront_username || id;
    const connectedId = link?.discord_id ?? (profile?.user?.id ? extractDiscordId(profile.user.id) : null);
    const base = new EmbedBuilder().setTitle(shortText(`Identity: ${label(name)}`, 256)).setColor(unavailable ? 0xf59e0b : 0x3b82f6)
      .addFields({ name: "OpenFront Profile", value: profileLink(id, name) },
        { name: "Discord User", value: connectedId ? `<@${connectedId}>` : "No linked Discord user", inline: true });
    if (link) {
      const epoch = toEpochSeconds(link.linked_at);
      base.addFields({ name: "Link Scope", value: link.verified_method === "admin_manual" ? "Approved in this server" : "Verified bot-wide", inline: true },
        { name: "Linked Since", value: epoch !== null ? `<t:${epoch}:F> (<t:${epoch}:R>)` : "Unknown" });
    } else {
      base.setDescription("This profile is public and has no identity link available in this context.");
    }
    base.addFields({ name: "Clans", value: unavailable ? "OpenFront API is unavailable; live membership could not be checked."
      : !profile ? "The stored link remains, but its OpenFront profile was not found."
      : !profile.clans ? "Clan membership was not included in the API response."
      : profile.clans.length ? shortText(profile.clans.map((clan) => `• **[${label(clan.tag)}]** ${label(clan.name)} — ${label(clan.role)}`).join("\n"), 1024)
      : "No current clan memberships." });
    let ffa: PlayerStatsSummary | null = null;
    let teams: PlayerStatsSummary | null = null;
    if (profile) {
      ffa = summarizePlayerStats(profile.stats, "ffa");
      teams = summarizePlayerStats(profile.stats, "teams");
      const ranked = summarizePlayerStats(profile.stats, "ranked");
      const all = summarizePlayerStats(profile.stats);
      const created = toEpochSeconds(profile.createdAt);
      if (created !== null) base.addFields({ name: "OpenFront Account Created", value: `<t:${created}:D>`, inline: true });
      if (ranked) {
        const number = (value: bigint) => value.toLocaleString("en-US");
        base.addFields({ name: "Ranked Record", value: `${number(ranked.wins)} wins · ${number(ranked.losses)} losses · ${winRate(ranked.wins, ranked.games)} win rate`, inline: true });
      }
      if (!all) {
        base.addFields({ name: "OpenFront Statistics", value: "No recorded statistics were provided by OpenFront." });
      }
    }
    const session: StatsTabs = { id: randomUUID(), userId: interaction.user.id, guildId: interaction.guildId,
      messageId: null, playerId: id, expiresAt: Date.now() + tabLifetime, busy: false,
      base, ffa, teams, mode: "ffa", page: "stats", filter: "all", history: new Map() };
    for (const [key, value] of tabs) if (value.expiresAt <= Date.now()) tabs.delete(key);
    if (tabs.size >= 500) tabs.delete(tabs.keys().next().value!);
    tabs.set(session.id, session);
    try {
      const message = await interaction.editReply({ embeds: [renderStats(session, "ffa")], components: controls(session), allowedMentions: { parse: [] } });
      session.messageId = message?.id ?? null;
    } catch (error) {
      tabs.delete(session.id);
      throw error;
    }
  },
};

export async function handleWhoisStatsInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith(tabPrefix)) return false;
  const [, id, action, extra] = interaction.customId.split(":");
  if (extra !== undefined || !["ffa", "teams", "stats", "history", "all", "team", "history-ffa", "previous", "next"].includes(action)) return false;
  const session = tabs.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) tabs.delete(id);
    await interaction.reply({ content: "These profile pages expired. Run `/whois` again to refresh them.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: "Only the person who ran `/whois` can change these profile pages.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.guildId !== session.guildId || !session.messageId || interaction.message.id !== session.messageId) {
    await interaction.reply({ content: "These controls belong to a different profile message. Run `/whois` again.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (session.busy) {
    await interaction.reply({ content: "A profile page is still loading. Please try again in a moment.", flags: MessageFlags.Ephemeral });
    return true;
  }
  const wantsHistory = !["ffa", "teams", "stats"].includes(action);
  if (wantsHistory && !historyEnabled(session.guildId)) {
    await interaction.reply({ content: "Player game history is disabled in this server's configuration.", flags: MessageFlags.Ephemeral });
    return true;
  }
  session.busy = true;
  try {
    await interaction.deferUpdate();
    if (!sessionLive(session)) {
      await interaction.followUp({ content: "These profile pages expired. Run `/whois` again.", flags: MessageFlags.Ephemeral });
      return true;
    }
    let historyError: string | undefined;
    if (!wantsHistory) {
      if (action === "ffa" || action === "teams") session.mode = action;
      session.page = "stats";
    } else {
      const filter = action === "history-ffa" ? "ffa" : action === "team" ? "team" : action === "all" ? "all" : session.filter;
      try {
        await loadHistory(session, filter, action === "next");
      } catch (error) {
        historyError = commandErrorMessage(error, session.guildId);
      }
      // A slow API read cannot revive expired or disabled controls, or publish newly disabled data.
      if (!sessionLive(session) || !historyEnabled(session.guildId)) {
        await interaction.followUp({ content: sessionLive(session) ? "Player game history was disabled while this page loaded."
          : "These profile pages expired while loading. Run `/whois` again.", flags: MessageFlags.Ephemeral });
        return true;
      }
      session.filter = filter;
      session.page = "history";
      const pages = session.history.get(filter);
      if (action === "previous" && pages) pages.index = Math.max(0, pages.index - 1);
      else if (action === "next" && pages && !historyError) pages.index = Math.min(pages.index + 1, pages.pages.length - 1);
    }
    await interaction.editReply({ embeds: [session.page === "stats" ? renderStats(session, session.mode) : renderHistory(session, historyError)],
      components: controls(session), allowedMentions: { parse: [] } });
  } finally {
    session.busy = false;
  }
  return true;
}

function sessionLive(session: StatsTabs) {
  return tabs.get(session.id) === session && session.expiresAt > Date.now();
}

async function loadHistory(session: StatsTabs, filter: HistoryFilter, advance: boolean) {
  const existing = session.history.get(filter);
  if (existing && (!advance || existing.index + 1 < existing.pages.length || !existing.nextCursor || existing.count >= historyMatchLimit)) return;
  const cursor = existing?.nextCursor ?? undefined;
  const response = await openfrontApi.getPlayerGames(session.playerId, { ...(filter === "all" ? {} : { filter }), ...(cursor ? { cursor } : {}) });
  if (!sessionLive(session) || !historyEnabled(session.guildId)) return;
  if (response === null) throw new CommandError("OpenFront could not find this player's game history. The account may have been deleted or the public ID may no longer be available. Run `/whois` again to check the profile.");
  const state = existing ?? { pages: [], index: 0, nextCursor: null, cursors: new Set<string>(), gameIds: new Set<string>(), batches: 0, count: 0 };
  if (cursor) state.cursors.add(cursor);
  state.batches++;
  const results: OpenFrontPlayerGame[] = [];
  for (const game of response.results) {
    if (state.gameIds.has(game.gameId) || state.count + results.length >= historyMatchLimit) continue;
    state.gameIds.add(game.gameId);
    results.push(game);
  }
  const chunks: OpenFrontPlayerGame[][] = [];
  for (let offset = 0; offset < results.length; offset += historyPageSize) chunks.push(results.slice(offset, offset + historyPageSize));
  if (!chunks.length && !state.pages.length) chunks.push([]);
  state.pages.push(...chunks);
  state.count += results.length;
  const next = response.nextCursor;
  state.nextCursor = next && next !== cursor && !state.cursors.has(next) && state.count < historyMatchLimit && state.batches < historyBatchLimit ? next : null;
  session.history.set(filter, state);
}

function tabRow(session: StatsTabs, selected: PlayerGameMode) {
  const button = (mode: PlayerGameMode, title: string) => new ButtonBuilder()
    .setCustomId(`${tabPrefix}${session.id}:${mode}`).setLabel(title)
    .setStyle(mode === selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button("ffa", "Free For All"), button("teams", "Teams"));
}

function controls(session: StatsTabs): ActionRowBuilder<ButtonBuilder>[] {
  const button = (action: string, title: string, selected = false, disabled = false) => new ButtonBuilder()
    .setCustomId(`${tabPrefix}${session.id}:${action}`).setLabel(title)
    .setStyle(selected ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled);
  if (session.page === "stats") {
    return [tabRow(session, session.mode), ...(historyEnabled(session.guildId)
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(button("history", "Game history"))] : [])];
  }
  const state = session.history.get(session.filter);
  const next = !!state && (state.index + 1 < state.pages.length || state.nextCursor !== null);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button("stats", "Statistics"), button("history", "Game history", true)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("all", "All modes", session.filter === "all"),
      button("history-ffa", "Free For All", session.filter === "ffa"), button("team", "Teams", session.filter === "team")),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button("previous", "Previous", false, !state || state.index === 0),
      button("next", "Next", false, !next))];
}

function renderHistory(session: StatsTabs, error?: string) {
  const embed = EmbedBuilder.from(session.base).setFields((session.base.data.fields ?? [])
    .filter((field) => ["OpenFront Profile", "Discord User", "Link Scope"].includes(field.name)));
  const historyLabel = (value: string) => label(shortText(value, 40));
  const state = session.history.get(session.filter);
  const games = state?.pages[state.index] ?? [];
  const filter = session.filter === "ffa" ? "Free For All" : session.filter === "team" ? "Teams" : "All modes";
  embed.addFields({ name: `Recorded game history · ${filter}`, value: "Recorded historical matches from OpenFront. Incomplete games have no final result and are excluded from win rate."
    + (session.filter === "team" ? " This filter contains Team games; Humans Vs Nations games are available in All modes." : "") });
  if (error) embed.addFields({ name: "History could not be refreshed", value: shortText(error, 1024) });
  if (!games.length && !error) embed.addFields({ name: "Recorded games", value: "No recorded games were returned for this player and filter." });
  for (const game of games) {
    const epoch = toEpochSeconds(game.start);
    const result = game.result === "victory" ? "Victory" : game.result === "defeat" ? "Defeat" : "Incomplete / no final result";
    const minutes = Math.floor(game.durationSeconds / 60);
    const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : minutes ? `${minutes}m` : "Under 1m";
    embed.addFields({ name: `${result} · ${historyLabel(game.map)}`, value: `${epoch === null ? "Unknown date" : `<t:${epoch}:f>`} · ${duration}\n`
      + `${historyLabel(game.mode)} · ${historyLabel(game.type)}${game.rankedType ? ` · ${historyLabel(game.rankedType)}` : ""} · ${game.totalPlayers === null ? "Unknown player count" : `${game.totalPlayers} players`}\n`
      + `Recorded as ${historyLabel(game.username)}${game.clanTag ? ` [${historyLabel(game.clanTag)}]` : ""}\nMatch ID: ${historyLabel(game.gameId)}` });
  }
  if (games.length) {
    const wins = games.filter((game) => game.result === "victory").length;
    const losses = games.filter((game) => game.result === "defeat").length;
    embed.addFields({ name: `This page · ${winRate(BigInt(wins), BigInt(wins + losses))} completed win rate`, value: alignedBarChart([
      { name: "Wins", value: BigInt(wins) }, { name: "Losses", value: BigInt(losses) }, { name: "Incomplete", value: BigInt(games.length - wins - losses) },
    ]) });
  }
  embed.setFooter({ text: `History page ${(state?.index ?? 0) + 1} · up to ${historyMatchLimit} recent matches per filter · recorded history can differ from lifetime stats` });
  return embed;
}

function renderStats(session: StatsTabs, mode: PlayerGameMode) {
  const embed = EmbedBuilder.from(session.base);
  const stats = mode === "ffa" ? session.ffa : session.teams;
  const title = mode === "ffa" ? "Free For All Stats" : "Teams Stats";
  if (!stats) {
    embed.addFields({ name: title, value: `No recorded ${mode === "ffa" ? "Free For All" : "Teams"} statistics were provided by OpenFront.` });
    return embed;
  }
  const number = (value: bigint) => value.toLocaleString("en-US");
  embed.addFields({ name: title, value: `**Games:** ${number(stats.games)} · **Wins:** ${number(stats.wins)} · **Losses:** ${number(stats.losses)} · **Win rate:** ${winRate(stats.wins, stats.games)}` },
    { name: "Wins / losses", value: alignedBarChart([{ name: "Wins", value: stats.wins }, { name: "Losses", value: stats.losses }]) },
    { name: "Buildings built", value: alignedBarChart(stats.buildings) + "\nN/A = unavailable · + = partial total · ~ = abbreviated count. Exact available totals below." });
  if (stats.details.length) embed.addFields({ name: "Lifetime totals", value: stats.details.map((item) => `${item.name}: **${number(item.value)}**`).join("\n") });
  embed.setFooter({ text: `${title} · all recorded public, private and singleplayer matches${stats.partial ? " · some statistics were unavailable" : ""}` });
  return embed;
}
