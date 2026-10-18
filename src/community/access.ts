import type { Guild, Interaction } from "discord.js";
import { db } from "../db.js";
import { CommandError } from "../commandError.js";
import type { EntityBinding } from "./types.js";

export async function requireCommunityOfficer(guild: Guild, userId: string, database = db): Promise<void> {
  const member = await guild.members.fetch({ user: userId, force: true });
  const roles = [database.getGuildSettings(guild.id)?.manager_role_id,
    ...database.getGuildConfigs(guild.id).flatMap(config => [config.officer_role_id, config.leader_role_id])];
  if (member.user.bot || !roles.some(role => role && member.roles.cache.has(role))) {
    throw new CommandError("You need the configured manager, officer, or leader role for this community action.");
  }
}
export function assertCommunityBinding(binding: EntityBinding, interaction: Interaction): void {
  const messageId = "message" in interaction ? interaction.message?.id ?? null : null;
  if (!interaction.guildId || binding.guildId !== interaction.guildId || binding.channelId !== interaction.channelId || binding.messageId !== messageId) {
    throw new CommandError("This control belongs to another server, channel, or message. Reopen it from its original message.");
  }
}
