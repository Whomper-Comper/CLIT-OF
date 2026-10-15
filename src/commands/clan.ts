import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import { CONFIG } from "../config.js";
import { db } from "../db.js";
import { openfrontApi } from "../api.js";
import { ClanSyncService } from "../clanSync.js";
import { toEpochSeconds } from "../utils.js";

/**
 * Consolidated /clan command with subcommands: setup, config, remove, sync, pending.
 */
export const clanCommand = {
  data: new SlashCommandBuilder()
    .setName("clan")
    .setDescription("Manage OpenFront clan role synchronization")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Configure an OpenFront clan for this server (requires Manage Server)")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("The OpenFront Clan Tag (e.g. UN, ABC)").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("member_role").setDescription("Discord role given to all clan members").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("officer_role").setDescription("Discord role given to clan officers and leader").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("leader_role").setDescription("Discord role given to the clan leader").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt
            .setName("join_role")
            .setDescription("Discord role given to users approved to join this clan (notifies officers to invite them)")
            .setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName("log_channel")
            .setDescription("Channel where role changes and sync notices are posted")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("sync_interval")
            .setDescription("Automatic sync interval in minutes (default: 10, min: 2, max: 1440)")
            .setMinValue(2)
            .setMaxValue(1440)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("View clan configurations for this server")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("View a specific clan config (omit to see all)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a clan configuration from this server (requires Manage Server)")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("The clan tag to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("sync")
        .setDescription("Force an immediate clan role sync")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("Specific user to sync (leave blank for whole server)").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("Specific clan to sync (leave blank for all)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("pending")
        .setDescription("List users with the clan join role who need an in-game clan invite")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("Specific clan tag to check (omit for all)").setRequired(false)
        )
    ),

  async execute(interaction: ChatInputCommandInteraction, clanSync: ClanSyncService) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case "setup":
        return handleSetup(interaction);
      case "config":
        return handleConfig(interaction);
      case "remove":
        return handleRemove(interaction);
      case "sync":
        return handleSync(interaction, clanSync);
      case "pending":
        return handlePending(interaction, clanSync);
    }
  },
};

// ──────────────────────────────────────────────────────────
//  /clan setup
// ──────────────────────────────────────────────────────────

async function handleSetup(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This command must be used in a Discord server.", ephemeral: true });
    return;
  }

  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "❌ You need `Manage Server` permission to configure clans.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const clanTag = interaction.options.getString("clan_tag", true).toUpperCase().trim();
  const memberRole = interaction.options.getRole("member_role", true);
  const officerRole = interaction.options.getRole("officer_role");
  const leaderRole = interaction.options.getRole("leader_role");
  const joinRole = interaction.options.getRole("join_role");
  const logChannel = interaction.options.getChannel("log_channel");
  const syncInterval = interaction.options.getInteger("sync_interval") ?? CONFIG.DEFAULT_SYNC_INTERVAL_MINS;

  // Verify clan exists on OpenFront
  const clanInfo = await openfrontApi.getClanInfo(clanTag);

  db.setGuildClanConfig({
    guild_id: interaction.guild.id,
    clan_tag: clanTag,
    member_role_id: memberRole.id,
    officer_role_id: officerRole?.id || null,
    leader_role_id: leaderRole?.id || null,
    join_role_id: joinRole?.id || null,
    log_channel_id: logChannel?.id || null,
    sync_interval_mins: syncInterval,
    last_sync_at: null,
  });

  const embed = new EmbedBuilder()
    .setTitle(`⚙️ Clan Sync Configured: [${clanTag}]`)
    .setColor(0x22c55e)
    .setDescription(
      clanInfo
        ? `Connected to OpenFront Clan **${clanInfo.name}** (\`${clanInfo.tag}\`).\n${clanInfo.description || ""}`
        : `Saved configuration for clan tag **[${clanTag}]** (Note: Clan info was not found on API, will verify during sync).`
    )
    .addFields(
      { name: "Clan Tag", value: `\`${clanTag}\``, inline: true },
      { name: "Member Role", value: `<@&${memberRole.id}>`, inline: true },
      { name: "Officer Role", value: officerRole ? `<@&${officerRole.id}>` : "*Not set*", inline: true },
      { name: "Leader Role", value: leaderRole ? `<@&${leaderRole.id}>` : "*Not set*", inline: true },
      { name: "Join Role (Approvals)", value: joinRole ? `<@&${joinRole.id}>` : "*Not set*", inline: true },
      { name: "Log Channel", value: logChannel ? `<#${logChannel.id}>` : "*None*", inline: true },
      { name: "Sync Interval", value: `${syncInterval} minutes`, inline: true }
    )
    .setFooter({ text: "Use /clan sync to trigger an immediate sync." })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ──────────────────────────────────────────────────────────
//  /clan config
// ──────────────────────────────────────────────────────────

async function handleConfig(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This command must be used in a Discord server.", ephemeral: true });
    return;
  }

  const specificTag = interaction.options.getString("clan_tag")?.toUpperCase().trim();

  if (specificTag) {
    const config = db.getGuildClanConfig(interaction.guild.id, specificTag);
    if (!config) {
      await interaction.reply({
        content: `ℹ️ No configuration found for clan **[${specificTag}]** in this server.`,
        ephemeral: true,
      });
      return;
    }

    const embed = buildConfigEmbed(config);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } else {
    const configs = db.getGuildConfigs(interaction.guild.id);
    if (configs.length === 0) {
      await interaction.reply({
        content: "ℹ️ No OpenFront clans are configured for this server. Use `/clan setup` to configure one.",
        ephemeral: true,
      });
      return;
    }

    const embeds = configs.map(buildConfigEmbed);
    await interaction.reply({ embeds, ephemeral: true });
  }
}

function buildConfigEmbed(config: ReturnType<typeof db.getGuildClanConfig> & {}): EmbedBuilder {
  const epoch = toEpochSeconds(config.last_sync_at);
  const lastSyncDisplay = epoch ? `<t:${epoch}:F> (<t:${epoch}:R>)` : "Never";

  return new EmbedBuilder()
    .setTitle(`Clan Config: [${config.clan_tag}]`)
    .setColor(0x3b82f6)
    .addFields(
      { name: "Clan Tag", value: `\`${config.clan_tag}\``, inline: true },
      { name: "Member Role", value: `<@&${config.member_role_id}>`, inline: true },
      { name: "Officer Role", value: config.officer_role_id ? `<@&${config.officer_role_id}>` : "*None*", inline: true },
      { name: "Leader Role", value: config.leader_role_id ? `<@&${config.leader_role_id}>` : "*None*", inline: true },
      { name: "Join Role", value: config.join_role_id ? `<@&${config.join_role_id}>` : "*None*", inline: true },
      { name: "Log Channel", value: config.log_channel_id ? `<#${config.log_channel_id}>` : "*None*", inline: true },
      { name: "Sync Interval", value: `${config.sync_interval_mins} mins`, inline: true },
      { name: "Last Sync", value: lastSyncDisplay, inline: true }
    )
    .setTimestamp();
}

// ──────────────────────────────────────────────────────────
//  /clan remove
// ──────────────────────────────────────────────────────────

async function handleRemove(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This command must be used in a Discord server.", ephemeral: true });
    return;
  }

  if (
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    await interaction.reply({
      content: "❌ You need `Manage Server` permission to remove clan configurations.",
      ephemeral: true,
    });
    return;
  }

  const clanTag = interaction.options.getString("clan_tag", true).toUpperCase().trim();
  const removed = db.deleteGuildClanConfig(interaction.guild.id, clanTag);

  await interaction.reply({
    content: removed
      ? `✅ Clan configuration for **[${clanTag}]** removed from this server.`
      : `ℹ️ No clan configuration was found for **[${clanTag}]** in this server.`,
    ephemeral: true,
  });
}

// ──────────────────────────────────────────────────────────
//  /clan sync
// ──────────────────────────────────────────────────────────

async function handleSync(interaction: ChatInputCommandInteraction, clanSync: ClanSyncService) {
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This command must be used in a Discord server.", ephemeral: true });
    return;
  }

  const configs = db.getGuildConfigs(interaction.guild.id);
  if (configs.length === 0) {
    await interaction.reply({
      content: "❌ No OpenFront clans are configured for this server yet. Run `/clan setup` first.",
      ephemeral: true,
    });
    return;
  }

  const targetUser = interaction.options.getUser("user");
  const specificClanTag = interaction.options.getString("clan_tag")?.toUpperCase().trim();

  // If syncing the whole guild (no target user), require permissions
  if (!targetUser) {
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    ) {
      await interaction.reply({
        content:
          "❌ You need `Manage Roles` or `Manage Server` permission to sync the entire server. You can still sync yourself: `/clan sync user:@yourself`.",
        ephemeral: true,
      });
      return;
    }
  }

  await interaction.deferReply({
    ephemeral: Boolean(targetUser && targetUser.id === interaction.user.id),
  });

  if (targetUser) {
    // ── Single-user sync ──────────────────────────────────
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!member) {
      await interaction.editReply({ content: `❌ Member <@${targetUser.id}> is not in this server.` });
      return;
    }

    const link = db.getUserByDiscordId(targetUser.id);
    if (!link) {
      await interaction.editReply({
        content: `ℹ️ <@${targetUser.id}> is not linked to any OpenFront account. They can link using \`/link\`.`,
      });
      return;
    }

    // Filter to specific clan if requested
    const relevantConfigs = specificClanTag
      ? configs.filter((c) => c.clan_tag === specificClanTag)
      : configs;

    if (relevantConfigs.length === 0) {
      await interaction.editReply({ content: `❌ No configuration found for clan **[${specificClanTag}]**.` });
      return;
    }

    const results = [];
    for (const config of relevantConfigs) {
      const result = await clanSync.syncMemberForClan(member, link, config);
      if (result.rolesAdded.length > 0 || result.rolesRemoved.length > 0) {
        await clanSync.logRoleChange(interaction.guild, config, member, result);
      }
      results.push(result);
    }

    const fields = results.map((r) => ({
      name: `[${r.clanTag}]`,
      value:
        (r.inClan ? `✅ In Clan (${r.clanRole})` : "❌ Not in Clan") +
        (r.rolesAdded.length > 0 ? `\n+${r.rolesAdded.map((id) => `<@&${id}>`).join(", ")}` : "") +
        (r.rolesRemoved.length > 0 ? `\n−${r.rolesRemoved.map((id) => `<@&${id}>`).join(", ")}` : "") +
        (r.error ? `\n⚠️ ${r.error}` : ""),
      inline: true,
    }));

    const embed = new EmbedBuilder()
      .setTitle(`Clan Sync: ${member.user.tag}`)
      .setColor(results.some((r) => r.inClan) ? 0x22c55e : 0xef4444)
      .addFields(...fields)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } else {
    // ── Full guild sync ───────────────────────────────────
    const relevantConfigs = specificClanTag
      ? configs.filter((c) => c.clan_tag === specificClanTag)
      : configs;

    if (relevantConfigs.length === 0) {
      await interaction.editReply({ content: `❌ No configuration found for clan **[${specificClanTag}]**.` });
      return;
    }

    const allResults = [];
    for (const config of relevantConfigs) {
      const results = await clanSync.syncGuildClan(interaction.guild, config);
      allResults.push({ config, results });
    }

    const fields = allResults.map(({ config, results }) => {
      const inClanCount = results.filter((r) => r.inClan).length;
      const rolesChanged = results.reduce((s, r) => s + r.rolesAdded.length + r.rolesRemoved.length, 0);
      return {
        name: `[${config.clan_tag}]`,
        value: `${results.length} members synced\n${inClanCount} in clan • ${rolesChanged} role changes`,
        inline: true,
      };
    });

    const totalMembers = allResults.reduce((s, { results }) => s + results.length, 0);

    const embed = new EmbedBuilder()
      .setTitle(`Clan Sync Complete`)
      .setColor(0x22c55e)
      .setDescription(`Synchronized **${totalMembers}** linked member(s) across **${allResults.length}** clan(s).`)
      .addFields(...fields)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
}

// ──────────────────────────────────────────────────────────
//  /clan pending
// ──────────────────────────────────────────────────────────

async function handlePending(interaction: ChatInputCommandInteraction, clanSync: ClanSyncService) {
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This command must be used in a Discord server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const specificTag = interaction.options.getString("clan_tag")?.toUpperCase().trim();
  const configs = specificTag
    ? db.getGuildConfigs(interaction.guild.id).filter((c) => c.clan_tag === specificTag)
    : db.getGuildConfigs(interaction.guild.id);

  if (configs.length === 0) {
    await interaction.editReply({
      content: specificTag
        ? `ℹ️ No configuration found for clan **[${specificTag}]** in this server.`
        : "ℹ️ No OpenFront clans are configured for this server.",
    });
    return;
  }

  const clansWithJoinRole = configs.filter((c) => Boolean(c.join_role_id));
  if (clansWithJoinRole.length === 0) {
    await interaction.editReply({
      content:
        "ℹ️ None of the configured clans have a `join_role` set.\n" +
        "You can configure one with `/clan setup` using the `join_role:` option (e.g. `@Mars`).",
    });
    return;
  }

  const embeds: EmbedBuilder[] = [];

  for (const config of clansWithJoinRole) {
    const pendingList = await clanSync.getPendingJoinMembers(interaction.guild, config);

    const embed = new EmbedBuilder()
      .setTitle(`Pending In-Game Clan Invites: [${config.clan_tag}]`)
      .setColor(pendingList.length > 0 ? 0xf59e0b : 0x22c55e);

    if (pendingList.length === 0) {
      embed.setDescription(
        `✅ All members with the <@&${config.join_role_id}> role are already in the **[${config.clan_tag}]** clan on OpenFront!`
      );
    } else {
      const linkedPending = pendingList.filter((p) => p.link !== null);
      const unlinkedPending = pendingList.filter((p) => p.link === null);

      const sections: string[] = [];

      if (linkedPending.length > 0) {
        sections.push(
          `**🛡️ Ready for In-Game Invite (${linkedPending.length}):**\n` +
            linkedPending
              .slice(0, 15)
              .map(
                (p) =>
                  `• <@${p.member.id}> — **[${p.ofUsername}](https://openfront.io/player/${p.link!.openfront_id})** (\`${p.link!.openfront_id}\`)`
              )
              .join("\n") +
            (linkedPending.length > 15 ? `\n*… and ${linkedPending.length - 15} more*` : "")
        );
      }

      if (unlinkedPending.length > 0) {
        sections.push(
          `**⚠️ Has Role but Not Linked (${unlinkedPending.length}):**\n` +
            unlinkedPending
              .slice(0, 10)
              .map((p) => `• <@${p.member.id}> (Needs to run \`/link\`)`)
              .join("\n") +
            (unlinkedPending.length > 10 ? `\n*… and ${unlinkedPending.length - 10} more*` : "")
        );
      }

      embed.setDescription(
        `Members with <@&${config.join_role_id}> who need an in-game clan invitation:\n\n` +
          sections.join("\n\n")
      );
      embed.setFooter({ text: `${pendingList.length} member(s) total` });
    }

    embeds.push(embed);
  }

  await interaction.editReply({ embeds });
}
