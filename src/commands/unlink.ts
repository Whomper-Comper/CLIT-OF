import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import { db } from "../db.js";

export const unlinkCommand = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your Discord account from your OpenFront account"),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const existing = db.getUserByDiscordId(discordId);

    if (!existing) {
      await interaction.editReply({
        content: "ℹ️ Your Discord account is not currently linked to any OpenFront account.",
      });
      return;
    }

    // Remove from DB
    db.unlinkUser(discordId);

    // Strip all clan roles from every configured clan in this guild
    if (interaction.guild && interaction.member instanceof GuildMember) {
      const configs = db.getGuildConfigs(interaction.guild.id);
      for (const config of configs) {
        const rolesToRemove = [
          config.member_role_id,
          config.officer_role_id,
          config.leader_role_id,
        ].filter((r): r is string => Boolean(r));

        for (const roleId of rolesToRemove) {
          if (interaction.member.roles.cache.has(roleId)) {
            try {
              await interaction.member.roles.remove(roleId);
            } catch (err) {
              console.warn(`[Unlink] Failed to remove role ${roleId} from ${discordId}:`, err);
            }
          }
        }
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("🔓 Account Unlinked")
      .setColor(0xeab308)
      .setDescription(
        `Successfully unlinked Discord user <@${discordId}> from OpenFront account \`${existing.openfront_id}\`.\n\n` +
          `Any associated clan roles have been removed. You can re-link at any time using \`/link\`.`
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
