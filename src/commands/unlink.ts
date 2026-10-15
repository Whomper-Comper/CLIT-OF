import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db } from "../db.js";
import { CommandLimits } from "../queues.js";

const unlinkLimits = new CommandLimits();

export const unlinkCommand = {
  data: new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Unlink your Discord account from your OpenFront account"),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!unlinkLimits.take(interaction.user.id, 10_000)) {
      await interaction.reply({ content: "Please wait a few seconds before trying to unlink again.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const existing = db.getUserByDiscordId(discordId);

    if (!existing) {
      if (interaction.guild && db.getGuildLink(interaction.guild.id, discordId)) {
        db.unlinkGuildUser(interaction.guild.id, discordId, discordId);
        await interaction.editReply({ content: "Your manual link in this server was removed. Configured clan roles will be cleared in order." });
        return;
      }
      await interaction.editReply({
        content: "ℹ️ Your Discord account is not currently linked to any OpenFront account.",
      });
      return;
    }

    db.unlinkUser(discordId, interaction.guildId);

    const embed = new EmbedBuilder()
      .setTitle("🔓 Account Unlinked")
      .setColor(0xeab308)
      .setDescription(
        `Successfully unlinked Discord user <@${discordId}> from OpenFront account \`${existing.openfront_id}\`.\n\n` +
          `Your bot-wide link and server-specific approvals were removed. Clan roles will be cleared in order across the servers where they were configured. You can re-link at any time using \`/link\`.`
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
