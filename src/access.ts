import { ChatInputCommandInteraction, Guild, PermissionFlagsBits } from "discord.js";
import { db } from "./db.js";
import { CommandError } from "./commands/support.js";

export function checkClanAccess(interaction: ChatInputCommandInteraction<"cached">) {
  const role = db.getGuildSettings(interaction.guildId)?.manager_role_id;
  if (!role) throw new CommandError("Someone with Manage Server permission must choose the config role in `/config` first.");
  if (!interaction.member.roles.cache.has(role)) throw new CommandError(`You need the <@&${role}> role to use /clan commands.`);
}

/** Refresh membership on every action so a previously opened menu cannot retain revoked access. */
export async function hasClanAccess(guild: Guild, user: string): Promise<boolean> {
  if (!db.getGuildSettings(guild.id)) return false;
  const member = await guild.members.fetch({ user, force: true });
  const role = db.getGuildSettings(guild.id)?.manager_role_id;
  return !!role && member.roles.cache.has(role);
}

export async function requireClanAccess(guild: Guild, user: string) {
  if (!await hasClanAccess(guild, user)) throw new CommandError("Your config role is missing or was removed. Ask a server manager to check `/config`.");
}

export function checkConfigAccess(i: ChatInputCommandInteraction<"cached">) {
  const role = db.getGuildSettings(i.guildId)?.manager_role_id;
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !(role && i.member.roles.cache.has(role))) {
    throw new CommandError("You need Manage Server permission or the configured config role to open configuration.");
  }
}

export async function hasConfigAccess(guild: Guild, user: string): Promise<boolean> {
  const member = await guild.members.fetch({ user, force: true });
  const role = db.getGuildSettings(guild.id)?.manager_role_id;
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || !!role && member.roles.cache.has(role);
}

export async function requireConfigAccess(guild: Guild, user: string) {
  if (!await hasConfigAccess(guild, user)) throw new CommandError("You need Manage Server permission or the configured config role to change configuration.");
}

/** Debug exports require the explicitly selected role, including for owners and administrators. */
export async function requireDebugAccess(guild: Guild, user: string) {
  if (!db.getDebugSettings(guild.id)?.debug_role_id) throw new CommandError("Choose a debug role in `/config` before using `/debug`.");
  const member = await guild.members.fetch({ user, force: true });
  const role = db.getDebugSettings(guild.id)?.debug_role_id;
  if (!role || !member.roles.cache.has(role)) throw new CommandError("You need this server's configured debug role to use `/debug`.");
}
