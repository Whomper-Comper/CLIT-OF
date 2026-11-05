import { ChannelType, Guild, PermissionFlagsBits } from "discord.js";
import { CONFIG } from "./config.js";
import { GuildClanConfig } from "./db.js";

export type ClanDraft = Omit<GuildClanConfig, "guild_id" | "last_sync_at">;

export function newClanDraft(tag = ""): ClanDraft {
  return {
    clan_tag: normalizeClanTag(tag), member_role_id: "", officer_role_id: null,
    leader_role_id: null, join_role_id: null, log_channel_id: null,
    sync_interval_mins: CONFIG.DEFAULT_SYNC_INTERVAL_MINS,
  };
}

export function normalizeClanTag(tag: string): string {
  return tag.trim().toUpperCase();
}

export function clanDraft(config: GuildClanConfig): ClanDraft {
  const { guild_id, last_sync_at, ...draft } = config;
  return draft;
}

// Background sync timestamps do not count as configuration edits.
export function configSnapshot(config: GuildClanConfig | null): string {
  // SELECT * follows physical column order, including columns appended by legacy
  // migrations. Compare the same fields in a stable order for drafts and rows.
  return JSON.stringify(config ? {
    clan_tag: config.clan_tag,
    member_role_id: config.member_role_id,
    officer_role_id: config.officer_role_id,
    leader_role_id: config.leader_role_id,
    join_role_id: config.join_role_id,
    log_channel_id: config.log_channel_id,
    sync_interval_mins: config.sync_interval_mins,
  } : null);
}

export function draftErrors(draft: ClanDraft): string[] {
  const errors: string[] = [];
  if (!/^[A-Z0-9]{2,5}$/.test(draft.clan_tag)) {
    errors.push("Enter an OpenFront clan tag of 2–5 letters or numbers, without brackets.");
  }
  if (!Number.isInteger(draft.sync_interval_mins) || draft.sync_interval_mins < 2 || draft.sync_interval_mins > 1440) {
    errors.push("Choose a whole number of minutes between 2 and 1440.");
  }
  if (!draft.member_role_id) errors.push("Choose a member role.");
  const roles = [draft.member_role_id, draft.officer_role_id, draft.leader_role_id].filter(Boolean);
  if (new Set(roles).size !== roles.length) errors.push("Use different roles for members, officers and the leader.");
  if (draft.join_role_id && roles.includes(draft.join_role_id)) {
    errors.push("The approval role must be different from the roles assigned by clan sync.");
  }
  return errors;
}

export async function validateClanDraft(guild: Guild, draft: ClanDraft): Promise<string[]> {
  const errors = draftErrors(draft);
  if (errors.length) return errors;

  // Refresh roles and the bot member so validation reflects current permissions.
  const [roles, bot] = await Promise.all([guild.roles.fetch(), guild.members.fetchMe()]);
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    errors.push("Give the bot Manage Roles permission before saving.");
  }
  const mappings = [
    ["Member", draft.member_role_id], ["Officer", draft.officer_role_id],
    ["Leader", draft.leader_role_id], ["Approval", draft.join_role_id],
  ] as const;
  for (const [label, id] of mappings) {
    if (!id) continue;
    const role = roles.get(id);
    if (!role) errors.push(`${label} role was deleted. Choose another role.`);
    else if (id === guild.id || role.managed) errors.push(`${label} role must be a normal server role; @everyone and integration roles cannot be used.`);
    else if (label !== "Approval" && bot.roles.highest.comparePositionTo(role) <= 0) {
      errors.push(`Move the bot's role above the ${label.toLowerCase()} role in Server Settings → Roles.`);
    }
  }
  if (draft.log_channel_id) {
    const channel = await guild.channels.fetch(draft.log_channel_id);
    if (!channel || channel.type !== ChannelType.GuildText) {
      errors.push("Choose an existing text channel for logs.");
    } else if (!channel.permissionsFor(bot)?.has([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
    ])) {
      errors.push("Allow the bot to View Channel, Send Messages and Embed Links in the log channel.");
    }
  }
  return errors;
}
