import type { GuildMember } from "discord.js";
import type { OpenFrontClanMembership } from "./api.js";
import type { GuildClanConfig, LinkedUser } from "./db.js";

export const managedRoles = (configs: GuildClanConfig[]) => [...new Set(configs.flatMap(c =>
  [c.member_role_id, c.officer_role_id, c.leader_role_id].filter((id): id is string => !!id)))];

/** Current linked members and unlinked holders of obsolete mapped roles need reconciliation. */
export function affectedRoleMemberIds(members: Iterable<GuildMember>, links: LinkedUser[], oldConfig: GuildClanConfig | null): string[] {
  const linkedIds = new Set(links.map(link => link.discord_id));
  const oldRoles = managedRoles(oldConfig ? [oldConfig] : []);
  const affected: string[] = [];
  for (const member of members) {
    if (linkedIds.has(member.id) || oldRoles.some(role => member.roles.cache.has(role))) affected.push(member.id);
  }
  return affected;
}

/** A shared role is retained only when at least one configured membership earns it. */
export function desiredRoles(configs: GuildClanConfig[], clans: OpenFrontClanMembership[]): Set<string> {
  const roles = new Set<string>();
  for (const config of configs) {
    const membership = clans.find((clan) => clan.tag.toUpperCase() === config.clan_tag.toUpperCase());
    if (!membership) continue;
    roles.add(config.member_role_id);
    if (membership.role !== "member" && config.officer_role_id) roles.add(config.officer_role_id);
    if (membership.role === "leader" && config.leader_role_id) roles.add(config.leader_role_id);
  }
  return roles;
}
