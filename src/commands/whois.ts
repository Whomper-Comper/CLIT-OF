import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { db, type LinkedUser } from "../db.js";
import { openfrontApi, type OpenFrontPlayerProfile } from "../api.js";
import { extractDiscordId, toEpochSeconds } from "../utils.js";
import { CommandError, label, playerId, profileLink, shortText, throttle } from "./support.js";

/** Identity lookup stays small; match results and charts live in /stats. */
export const whoisCommand = {
  data: new SlashCommandBuilder().setName("whois").setDescription("Find someone's linked Discord and OpenFront identity")
    .addUserOption(option => option.setName("user").setDescription("Discord user to look up"))
    .addStringOption(option => option.setName("openfront_id").setDescription("OpenFront public ID, profile URL, or Discord ID")),
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
    catch (error) { if (!link) throw error; unavailable = true; }
    if (!profile && !link) throw new CommandError("That OpenFront profile was not found, and no link is available here.");
    const name = profile?.username || link?.openfront_username || id;
    const connectedId = link?.discord_id ?? (profile?.user?.id ? extractDiscordId(profile.user.id) : null);
    const embed = new EmbedBuilder().setTitle(shortText(`Identity: ${label(name)}`, 256))
      .setColor(unavailable ? 0xf59e0b : 0x3b82f6)
      .addFields({ name: "OpenFront Profile", value: profileLink(id, name) },
        { name: "Public ID", value: id, inline: true },
        { name: "Discord User", value: connectedId ? `<@${connectedId}>` : "No linked Discord user", inline: true });
    if (link) embed.addFields({ name: "Link Scope", value: link.verified_method === "admin_manual" ? "Approved in this server" : "Verified bot-wide", inline: true });
    if (unavailable) embed.setDescription("OpenFront is unavailable. Showing the saved identity link.");
    else if (!profile) embed.setDescription("The saved link remains, but its OpenFront profile was not found.");
    embed.addFields({ name: "Clans", value: unavailable ? "OpenFront API is unavailable; live membership could not be checked."
      : !profile ? "Live membership could not be checked."
      : !profile.clans ? "Clan membership was not included in the API response."
      : profile.clans.length ? shortText(profile.clans.map(clan => `• **[${label(clan.tag)}]** ${label(clan.name)} — ${label(clan.role)}`).join("\n"), 1024)
      : "No current clan memberships." });
    const created = profile ? toEpochSeconds(profile.createdAt) : null;
    if (created !== null) embed.addFields({ name: "OpenFront Account Created", value: `<t:${created}:D>`, inline: true });
    embed.setFooter({ text: "Use /stats for results, maps, game history and Elo." });
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
