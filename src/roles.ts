import { OpenFrontClanMembership } from "./api.js";
import { GuildClanConfig } from "./db.js";

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
