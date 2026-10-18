import type { Guild, GuildMember, Interaction } from "discord.js";
import { db } from "../db.js";
import { CommandError } from "../commandError.js";
import type { EntityBinding } from "./types.js";

export async function requireCommunityOfficer(guild: Guild, userId: string, database = db): Promise<void> {
  const member = await guild.members.fetch({ user: userId, force: true });
  if (!hasCommunityOfficerRole(guild.id,member,database)) {
    throw new CommandError("You need the configured manager, officer, or leader role for this community action.");
  }
}
/** A fresh roster can decide whether to offer private management controls without fetching twice.
 * Actual privileged actions still call requireCommunityOfficer immediately before mutation. */
export function hasCommunityOfficerRole(guildId:string,member:GuildMember,database=db):boolean {
  const roles=[database.getGuildSettings(guildId)?.manager_role_id,
    ...database.getGuildConfigs(guildId).flatMap(config=>[config.officer_role_id,config.leader_role_id])];
  return !member.user.bot&&roles.some(role=>!!role&&member.roles.cache.has(role));
}
export function assertCommunityBinding(binding: EntityBinding, interaction: Interaction): void {
  const messageId = "message" in interaction ? interaction.message?.id ?? null : null;
  if (!interaction.guildId || binding.guildId !== interaction.guildId || binding.channelId !== interaction.channelId || binding.messageId !== messageId) {
    throw new CommandError("This control belongs to another server, channel, or message. Reopen it from its original message.");
  }
}
