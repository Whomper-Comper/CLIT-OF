import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { db, LinkedUser } from "../db.js";
import { openfrontApi, OpenFrontPlayerProfile } from "../api.js";
import { extractDiscordId, toEpochSeconds } from "../utils.js";
import { CommandError, label, playerId, profileLink, shortText, throttle } from "./support.js";

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
    const embed = new EmbedBuilder().setTitle(shortText(`Identity: ${name}`, 256)).setColor(unavailable ? 0xf59e0b : 0x3b82f6)
      .addFields({ name: "OpenFront Profile", value: profileLink(id, name) },
        { name: "Discord User", value: connectedId ? `<@${connectedId}>` : "No linked Discord user", inline: true });
    if (link) {
      const epoch = toEpochSeconds(link.linked_at);
      embed.addFields({ name: "Link Scope", value: link.verified_method === "admin_manual" ? "Approved in this server" : "Verified bot-wide", inline: true },
        { name: "Linked Since", value: epoch !== null ? `<t:${epoch}:F> (<t:${epoch}:R>)` : "Unknown" });
    } else {
      embed.setDescription("This profile is public and has no identity link available in this context.");
    }
    embed.addFields({ name: "Clans", value: unavailable ? "OpenFront API is unavailable; live membership could not be checked."
      : !profile ? "The stored link remains, but its OpenFront profile was not found."
      : !profile.clans ? "Clan membership was not included in the API response."
      : profile.clans.length ? shortText(profile.clans.map((clan) => `• **[${label(clan.tag)}]** ${label(clan.name)} — ${clan.role}`).join("\n"), 1024)
      : "No current clan memberships." });
    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};
