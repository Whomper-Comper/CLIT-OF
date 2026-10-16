import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { db } from "../db.js";
import { openfrontApi } from "../api.js";
import { extractDiscordId } from "../utils.js";
import { CommandError, identityLocks, playerId, privateReply, profileLink, throttle } from "./support.js";

export const linkCommand = {
  data: new SlashCommandBuilder().setName("link").setDescription("Verify and link your OpenFront account across the bot")
    .addStringOption((option) => option.setName("openfront_id").setDescription("OpenFront public ID or player profile URL"))
    .addStringOption((option) => option.setName("token").setDescription("Identity token from OpenFront account settings").setMaxLength(4096)),

  async execute(interaction: ChatInputCommandInteraction) {
    const input = interaction.options.getString("openfront_id")?.trim();
    const token = interaction.options.getString("token")?.trim();
    if (Boolean(input) === Boolean(token)) throw new CommandError("Provide exactly one of `openfront_id` or `token`. Use a player profile URL, or generate an Identity Token in OpenFront account settings.");
    throttle(`link:${interaction.user.id}`);
    await interaction.deferReply(privateReply);
    await identityLocks.run(interaction.user.id, async () => {
      const verifiedId = token ? await openfrontApi.verifyIdentityToken(token) : null;
      if (token && !verifiedId) throw new CommandError("That Identity Token is invalid or expired. Generate a new one in OpenFront account settings.");
      const id = playerId(verifiedId ?? input!);
      const profile = await openfrontApi.getPlayerProfile(id, { fresh: true });
      if (!profile) throw new CommandError("That OpenFront player was not found. Check the ID or profile URL.");
      const discordMatch = profile.user?.id && extractDiscordId(profile.user.id) === interaction.user.id;
      if (!token && !discordMatch) {
        await interaction.editReply({ content: `We found ${profileLink(id, profile.username || id)}, but its Discord connection does not match your account. Generate an **Identity Token** in OpenFront account settings and run \`/link token:<token>\`. A server manager can also create a server-only approval with \`/clan link\`.` });
        return;
      }
      const existing = db.getUserByOpenFrontId(id);
      if (existing && existing.discord_id !== interaction.user.id) throw new CommandError("That OpenFront account is already linked to another Discord user. Its current owner must unlink it first.");
      db.linkUser(interaction.user.id, id, profile.username ?? null, token ? "identity_token" : "profile_discord", interaction.guildId);
      await interaction.editReply({ embeds: [new EmbedBuilder().setTitle("OpenFront account linked").setColor(0x22c55e)
        .setDescription(`Your bot-wide identity is now ${profileLink(id, profile.username || id)}. Clan role updates are queued across configured servers.`)] });
    });
  },
};
