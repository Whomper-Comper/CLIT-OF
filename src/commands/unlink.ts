import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { db } from "../db.js";
import { identityLocks, commandReplyOptions, throttle } from "./support.js";

export const unlinkCommand = {
  data: new SlashCommandBuilder().setName("unlink").setDescription("Unlink your OpenFront identity and queue clan role cleanup across servers"),
  async execute(interaction: ChatInputCommandInteraction) {
    throttle(`unlink:${interaction.user.id}`);
    await interaction.deferReply(commandReplyOptions(interaction));
    await identityLocks.run(interaction.user.id, async () => {
      const removed = db.unlinkUser(interaction.user.id, interaction.guildId);
      await interaction.editReply({ content: removed
        ? "Your bot-wide identity and server-only links were removed. Clan role cleanup is queued across servers, one role at a time. You can link again with `/link`."
        : "You have no OpenFront links to remove." });
    });
  },
};
