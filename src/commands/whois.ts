import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction,
  EmbedBuilder, Interaction, MessageFlags, SlashCommandBuilder,
} from "discord.js";
import { db, LinkedUser } from "../db.js";
import { openfrontApi, OpenFrontPlayerProfile } from "../api.js";
import { extractDiscordId, toEpochSeconds } from "../utils.js";
import { PlayerGameMode, PlayerStatsSummary, summarizePlayerStats, winRate } from "../playerStats.js";
import { CommandError, label, playerId, profileLink, shortText, throttle } from "./support.js";
import { alignedBarChart } from "./statsGraph.js";

interface StatsTabs {
  id: string;
  userId: string;
  expiresAt: number;
  base: EmbedBuilder;
  ffa: PlayerStatsSummary | null;
  teams: PlayerStatsSummary | null;
}
const tabs = new Map<string, StatsTabs>();
const tabLifetime = 10 * 60_000;
const tabPrefix = "whois-stats:";

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
    const base = new EmbedBuilder().setTitle(shortText(`Identity: ${name}`, 256)).setColor(unavailable ? 0xf59e0b : 0x3b82f6)
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
      : profile.clans.length ? shortText(profile.clans.map((clan) => `• **[${label(clan.tag)}]** ${label(clan.name)} — ${clan.role}`).join("\n"), 1024)
      : "No current clan memberships." });
    if (profile) {
      const ffa = summarizePlayerStats(profile.stats, "ffa");
      const teams = summarizePlayerStats(profile.stats, "teams");
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
        await interaction.editReply({ embeds: [base], allowedMentions: { parse: [] } });
        return;
      }
      const session = { id: randomUUID(), userId: interaction.user.id, expiresAt: Date.now() + tabLifetime, base, ffa, teams };
      for (const [key, value] of tabs) if (value.expiresAt <= Date.now()) tabs.delete(key);
      if (tabs.size >= 500) tabs.delete(tabs.keys().next().value!);
      tabs.set(session.id, session);
      await interaction.editReply({ embeds: [renderStats(session, "ffa")], components: [tabRow(session, "ffa")], allowedMentions: { parse: [] } });
      return;
    }
    await interaction.editReply({ embeds: [base], allowedMentions: { parse: [] } });
  },
};

export async function handleWhoisStatsInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith(tabPrefix)) return false;
  const [, id, mode] = interaction.customId.split(":");
  if (mode !== "ffa" && mode !== "teams") return false;
  const session = tabs.get(id);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) tabs.delete(id);
    await interaction.reply({ content: "These stats tabs expired. Run `/whois` again to refresh them.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.user.id !== session.userId) {
    await interaction.reply({ content: "Only the person who ran `/whois` can change these stats tabs.", flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.update({ embeds: [renderStats(session, mode)], components: [tabRow(session, mode)], allowedMentions: { parse: [] } });
  return true;
}

function tabRow(session: StatsTabs, selected: PlayerGameMode) {
  const button = (mode: PlayerGameMode, title: string) => new ButtonBuilder()
    .setCustomId(`${tabPrefix}${session.id}:${mode}`).setLabel(title)
    .setStyle(mode === selected ? ButtonStyle.Primary : ButtonStyle.Secondary);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button("ffa", "Free For All"), button("teams", "Teams"));
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
