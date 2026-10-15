import { Client, Guild, GuildMember, TextChannel, EmbedBuilder } from "discord.js";
import { db, GuildClanConfig, LinkedUser } from "./db.js";
import { openfrontApi } from "./api.js";

export interface SyncResult {
  discordId: string;
  openfrontId: string;
  clanTag: string;
  inClan: boolean;
  clanRole?: string;
  rolesAdded: string[];
  rolesRemoved: string[];
  error?: string;
}

export interface JoinRoleMismatch {
  discordId: string;
  openfrontId: string;
  openfrontUsername: string | null;
  clanTag: string;
}

export class ClanSyncService {
  private client: Client;
  private timer: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Start the background periodic clan sync scheduler.
   */
  startScheduler() {
    if (this.timer) clearInterval(this.timer);

    // Run every 1 minute to check which guilds/clans are due for sync
    this.timer = setInterval(() => {
      this.checkAndSyncAllGuilds().catch((err) => {
        console.error("[ClanSync] Periodic sync error:", err);
      });
    }, 60 * 1000);

    console.log("[ClanSync] Periodic sync scheduler started.");
  }

  stopScheduler() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Checks all guild clan configurations and syncs those that are due.
   */
  async checkAndSyncAllGuilds() {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      const configs = db.getAllGuildConfigs();
      const now = Date.now();

      // Group configs by guild for efficiency
      const byGuild = new Map<string, GuildClanConfig[]>();
      for (const config of configs) {
        const arr = byGuild.get(config.guild_id) ?? [];
        arr.push(config);
        byGuild.set(config.guild_id, arr);
      }

      for (const [guildId, guildConfigs] of byGuild) {
        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) continue;

        for (const config of guildConfigs) {
          const lastSync = config.last_sync_at ? new Date(config.last_sync_at).getTime() : 0;
          const intervalMs = (config.sync_interval_mins || 10) * 60 * 1000;

          if (now - lastSync >= intervalMs) {
            console.log(`[ClanSync] Auto-syncing clan [${config.clan_tag}] in guild ${guild.name}...`);
            await this.syncGuildClan(guild, config);
          }
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync all linked members in a guild for a specific clan config.
   */
  async syncGuildClan(guild: Guild, config: GuildClanConfig): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const mismatches: JoinRoleMismatch[] = [];

    // Fetch guild members
    let members;
    try {
      members = await guild.members.fetch();
    } catch (err) {
      console.warn(`[ClanSync] Failed to fetch guild members for ${guild.id}, using cache:`, err);
      members = guild.members.cache;
    }

    for (const [memberId, member] of members) {
      if (member.user.bot) continue;

      const link = db.getUserByDiscordId(memberId);
      if (!link) {
        // Even if not linked, check for join_role mismatch (they have the role but no link)
        if (config.join_role_id && member.roles.cache.has(config.join_role_id)) {
          mismatches.push({
            discordId: memberId,
            openfrontId: "(not linked)",
            openfrontUsername: null,
            clanTag: config.clan_tag,
          });
        }
        continue;
      }

      const result = await this.syncMemberForClan(member, link, config);
      results.push(result);

      if (result.rolesAdded.length > 0 || result.rolesRemoved.length > 0) {
        await this.logRoleChange(guild, config, member, result);
      }

      // Check join_role mismatch: member has join_role but is NOT in the clan in OpenFront
      if (config.join_role_id && member.roles.cache.has(config.join_role_id) && !result.inClan && !result.error) {
        mismatches.push({
          discordId: memberId,
          openfrontId: link.openfront_id,
          openfrontUsername: link.openfront_username,
          clanTag: config.clan_tag,
        });
      }
    }

    // Post join-role mismatch notification (if any)
    if (mismatches.length > 0) {
      await this.logJoinRoleMismatches(guild, config, mismatches);
    }

    db.updateClanLastSync(guild.id, config.clan_tag);
    return results;
  }

  /**
   * Sync clan roles for a single member across ALL configured clans for their guild.
   */
  async syncMember(member: GuildMember): Promise<SyncResult[]> {
    const configs = db.getGuildConfigs(member.guild.id);
    if (configs.length === 0) return [];

    const link = db.getUserByDiscordId(member.id);
    if (!link) return [];

    const results: SyncResult[] = [];
    for (const config of configs) {
      const result = await this.syncMemberForClan(member, link, config);
      if (result.rolesAdded.length > 0 || result.rolesRemoved.length > 0) {
        await this.logRoleChange(member.guild, config, member, result);
      }
      results.push(result);
    }
    return results;
  }

  /**
   * Sync clan roles for a single member for a specific clan config.
   */
  async syncMemberForClan(
    member: GuildMember,
    link: LinkedUser,
    config: GuildClanConfig
  ): Promise<SyncResult> {
    const result: SyncResult = {
      discordId: member.id,
      openfrontId: link.openfront_id,
      clanTag: config.clan_tag,
      inClan: false,
      rolesAdded: [],
      rolesRemoved: [],
    };

    try {
      const profile = await openfrontApi.getPlayerProfile(link.openfront_id);
      if (!profile) {
        result.error = "Profile not found or API unreachable";
        return result;
      }

      // Update stored username if changed
      if (profile.username && profile.username !== link.openfront_username) {
        db.updateUsername(link.discord_id, profile.username);
      }

      const targetClanTag = config.clan_tag.toUpperCase();
      const clanMembership = profile.clans?.find(
        (c) => c.tag.toUpperCase() === targetClanTag
      );

      const targetRolesToAdd: string[] = [];
      const rolesToRemove: string[] = [];

      const memberRoleId = config.member_role_id;
      const officerRoleId = config.officer_role_id;
      const leaderRoleId = config.leader_role_id;

      if (clanMembership) {
        result.inClan = true;
        result.clanRole = clanMembership.role;

        // Base member role
        if (memberRoleId) targetRolesToAdd.push(memberRoleId);

        // Officer role
        if (clanMembership.role === "officer" || clanMembership.role === "leader") {
          if (officerRoleId) targetRolesToAdd.push(officerRoleId);
        } else if (officerRoleId && member.roles.cache.has(officerRoleId)) {
          rolesToRemove.push(officerRoleId);
        }

        // Leader role
        if (clanMembership.role === "leader") {
          if (leaderRoleId) targetRolesToAdd.push(leaderRoleId);
        } else if (leaderRoleId && member.roles.cache.has(leaderRoleId)) {
          rolesToRemove.push(leaderRoleId);
        }
      } else {
        // Player is NOT in this clan (or left)
        result.inClan = false;
        if (memberRoleId && member.roles.cache.has(memberRoleId)) {
          rolesToRemove.push(memberRoleId);
        }
        if (officerRoleId && member.roles.cache.has(officerRoleId)) {
          rolesToRemove.push(officerRoleId);
        }
        if (leaderRoleId && member.roles.cache.has(leaderRoleId)) {
          rolesToRemove.push(leaderRoleId);
        }
      }

      // Apply role additions
      for (const roleId of targetRolesToAdd) {
        if (!member.roles.cache.has(roleId)) {
          try {
            await member.roles.add(roleId);
            result.rolesAdded.push(roleId);
          } catch (err) {
            console.error(`[ClanSync] Failed to add role ${roleId} to ${member.id}:`, err);
          }
        }
      }

      // Apply role removals
      for (const roleId of rolesToRemove) {
        if (member.roles.cache.has(roleId)) {
          try {
            await member.roles.remove(roleId);
            result.rolesRemoved.push(roleId);
          } catch (err) {
            console.error(`[ClanSync] Failed to remove role ${roleId} from ${member.id}:`, err);
          }
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }

    return result;
  }

  /**
   * Retrieves members with the join_role who are pending in-game clan invitation.
   */
  async getPendingJoinMembers(
    guild: Guild,
    config: GuildClanConfig
  ): Promise<{
    member: GuildMember;
    link: LinkedUser | null;
    inClan: boolean;
    ofUsername: string | null;
  }[]> {
    if (!config.join_role_id) return [];

    let members;
    try {
      members = await guild.members.fetch();
    } catch {
      members = guild.members.cache;
    }

    const pendingList: {
      member: GuildMember;
      link: LinkedUser | null;
      inClan: boolean;
      ofUsername: string | null;
    }[] = [];

    const targetClanTag = config.clan_tag.toUpperCase();

    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (!member.roles.cache.has(config.join_role_id)) continue;

      const link = db.getUserByDiscordId(member.id);
      if (!link) {
        pendingList.push({
          member,
          link: null,
          inClan: false,
          ofUsername: null,
        });
        continue;
      }

      const profile = await openfrontApi.getPlayerProfile(link.openfront_id);
      if (!profile) throw new Error("Could not check pending clan invites: OpenFront API unavailable.");
      const inClan = Boolean(
        profile.clans?.some((c) => c.tag.toUpperCase() === targetClanTag)
      );

      if (!inClan) {
        pendingList.push({
          member,
          link,
          inClan: false,
          ofUsername: profile?.username || link.openfront_username || link.openfront_id,
        });
      }
    }

    return pendingList;
  }

  /**
   * Reacts to member role additions: if a user is given a join_role, alerts
   * the log channel and checks if they can be synced.
   */
  async handleMemberRoleUpdate(oldMember: GuildMember, newMember: GuildMember) {
    const configs = db.getGuildConfigs(newMember.guild.id);
    if (configs.length === 0) return;

    for (const config of configs) {
      if (!config.join_role_id) continue;

      const hadRole = oldMember.roles.cache.has(config.join_role_id);
      const hasRole = newMember.roles.cache.has(config.join_role_id);

      // Triggered when join_role is newly added to the member
      if (!hadRole && hasRole) {
        console.log(`[ClanSync] Member ${newMember.user.tag} was given join_role for [${config.clan_tag}]`);
        const link = db.getUserByDiscordId(newMember.id);

        if (!link) {
          // Alert in log channel that they need to link
          if (config.log_channel_id) {
            const channel = newMember.guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
            if (channel?.isTextBased()) {
              const embed = new EmbedBuilder()
                .setTitle(`📢 Clan Role Assigned: [${config.clan_tag}]`)
                .setColor(0x3b82f6)
                .setDescription(
                  `<@${newMember.id}> was given the <@&${config.join_role_id}> role!\n\n` +
                    `⚠️ **Action Needed:** They have not linked their OpenFront account yet.\n` +
                    `They should run: \`/link\` with their OpenFront profile ID or Identity Token.`
                )
                .setTimestamp();
              await channel.send({ embeds: [embed] }).catch(() => null);
            }
          }
        } else {
          // Member is linked — check if already in clan or needs invite
          const result = await this.syncMemberForClan(newMember, link, config);
          if (result.inClan) {
            // Already in clan — roles granted!
            if (result.rolesAdded.length > 0) {
              await this.logRoleChange(newMember.guild, config, newMember, result);
            }
          } else if (!result.error) {
            // Needs in-game invite!
            if (config.log_channel_id) {
              const channel = newMember.guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
              if (channel?.isTextBased()) {
                const name = link.openfront_username || link.openfront_id;
                const embed = new EmbedBuilder()
                  .setTitle(`🔔 New Clan Member Approval: [${config.clan_tag}]`)
                  .setColor(0xf59e0b)
                  .setDescription(
                    `<@${newMember.id}> has been approved for **[${config.clan_tag}]** in Discord (<@&${config.join_role_id}>).\n\n` +
                      `**OpenFront Account:** [${name}](https://openfront.io/player/${link.openfront_id}) (\`${link.openfront_id}\`)\n\n` +
                      `🛡️ **Officer Action:** Please invite or accept **${name}** into the [${config.clan_tag}] clan in-game!`
                  )
                  .setTimestamp();
                await channel.send({ embeds: [embed] }).catch(() => null);
              }
            }
          }
        }
      }
    }
  }

  public async logRoleChange(
    guild: Guild,
    config: GuildClanConfig,
    member: GuildMember,
    result: SyncResult
  ) {
    if (!config.log_channel_id) return;

    try {
      const channel = guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
      if (!channel || !channel.isTextBased()) return;

      const embed = new EmbedBuilder()
        .setTitle(`Clan Sync Update: [${config.clan_tag}]`)
        .setColor(result.inClan ? 0x22c55e : 0xef4444)
        .setDescription(`Role changes for <@${member.id}> (OF: [\`${result.openfrontId}\`](https://openfront.io/player/${result.openfrontId}))`)
        .addFields(
          {
            name: "Status",
            value: result.inClan ? `In Clan (${result.clanRole})` : "Left Clan / Not In Clan",
            inline: true,
          },
          {
            name: "Roles Added",
            value: result.rolesAdded.length > 0 ? result.rolesAdded.map((r) => `<@&${r}>`).join(", ") : "None",
            inline: true,
          },
          {
            name: "Roles Removed",
            value: result.rolesRemoved.length > 0 ? result.rolesRemoved.map((r) => `<@&${r}>`).join(", ") : "None",
            inline: true,
          }
        )
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[ClanSync] Failed to send log to channel ${config.log_channel_id}:`, err);
    }
  }

  /**
   * Posts a summary notification when users have the join_role but are
   * not yet members of the corresponding OpenFront clan.
   */
  private async logJoinRoleMismatches(
    guild: Guild,
    config: GuildClanConfig,
    mismatches: JoinRoleMismatch[]
  ) {
    if (!config.log_channel_id || mismatches.length === 0) return;

    try {
      const channel = guild.channels.cache.get(config.log_channel_id) as TextChannel | undefined;
      if (!channel || !channel.isTextBased()) return;

      const lines = mismatches.slice(0, 20).map((m) => {
        if (m.openfrontId === "(not linked)") {
          return `• <@${m.discordId}> — *Not linked with /link yet*`;
        }
        const name = m.openfrontUsername || m.openfrontId;
        return `• <@${m.discordId}> — **[${name}](https://openfront.io/player/${m.openfrontId})** (\`${m.openfrontId}\`)`;
      });

      if (mismatches.length > 20) {
        lines.push(`… and ${mismatches.length - 20} more`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`🔔 Pending Clan Invites: [${config.clan_tag}]`)
        .setColor(0xf59e0b)
        .setDescription(
          `The following users have the <@&${config.join_role_id}> role but are **not yet in the [${config.clan_tag}] clan** on OpenFront.\n` +
            `A clan officer can invite them in-game using their profile link:\n\n${lines.join("\n")}`
        )
        .setFooter({ text: `${mismatches.length} user(s) pending clan invite` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[ClanSync] Failed to send join-role mismatch log:`, err);
    }
  }
}
