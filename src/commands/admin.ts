import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} from "discord.js";
import { db } from "../db.js";
import { openfrontApi } from "../api.js";
import { ClanSyncService } from "../clanSync.js";
import { resolveOpenFrontId, extractDiscordId } from "../utils.js";

/**
 * Consolidated /admin command with subcommands: link, unlink.
 */
export const adminCommand = {
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Admin commands for managing linked OpenFront accounts")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("link")
        .setDescription("Manually link a Discord user to an OpenFront account (requires Manage Server)")
        .addUserOption((opt) => opt.setName("user").setDescription("The Discord user to link").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("openfront_id")
            .setDescription("The OpenFront Public ID or profile URL")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("unlink")
        .setDescription("Manually unlink a Discord user from their OpenFront account (requires Manage Server)")
        .addUserOption((opt) => opt.setName("user").setDescription("The Discord user to unlink").setRequired(true))
    ),

  async execute(interaction: ChatInputCommandInteraction, clanSync: ClanSyncService) {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case "link":
        return handleAdminLink(interaction, clanSync);
      case "unlink":
        return handleAdminUnlink(interaction);
    }
  },
};

// ──────────────────────────────────────────────────────────
//  /admin link
// ──────────────────────────────────────────────────────────

async function handleAdminLink(interaction: ChatInputCommandInteraction, clanSync: ClanSyncService) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user", true);
  const rawId = interaction.options.getString("openfront_id", true).trim();

  // Validate that openfront_id is NOT a Discord user ID or mention
  const maybeDiscordId = extractDiscordId(rawId);
  if (maybeDiscordId) {
    await interaction.editReply({
      content:
        `❌ \`${rawId}\` is a Discord user ID, not an OpenFront Public ID!\n\n` +
        `• OpenFront Public IDs are 8-character codes like \`HabCsQYR\` (from player profile URLs: \`https://openfront.io/player/HabCsQYR\`).\n` +
        `• Do not enter Discord IDs or in-game usernames here.`,
    });
    return;
  }

  const openfrontId = resolveOpenFrontId(rawId);

  // Check if another user has this OF ID
  const existing = db.getUserByOpenFrontId(openfrontId);
  if (existing && existing.discord_id !== targetUser.id) {
    await interaction.editReply({
      content: `⚠️ OpenFront account \`${openfrontId}\` is already linked to <@${existing.discord_id}>. Unlink them first if this was a mistake.`,
    });
    return;
  }

  // Verify OpenFront account exists
  const profile = await openfrontApi.getPlayerProfile(openfrontId);
  const ofUsername = profile?.username || openfrontId;

  db.linkUser(targetUser.id, openfrontId, profile?.username || null, "admin_manual");

  const embed = new EmbedBuilder()
    .setTitle("✅ Admin Linked User Successfully")
    .setColor(profile ? 0x22c55e : 0xf59e0b)
    .setDescription(
      `Linked <@${targetUser.id}> to OpenFront account **[${ofUsername}](https://openfront.io/player/${openfrontId})** (\`${openfrontId}\`).` +
        (!profile ? "\n\n⚠️ *Note: Profile was not found on the OpenFront API at this time, but the link was recorded.*" : "")
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });

  // Sync member roles if present in this server
  if (interaction.guild) {
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (member) {
      await clanSync.syncMember(member);
    }
  }
}

// ──────────────────────────────────────────────────────────
//  /admin unlink
// ──────────────────────────────────────────────────────────

async function handleAdminUnlink(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user", true);
  const existing = db.getUserByDiscordId(targetUser.id);

  if (!existing) {
    await interaction.editReply({
      content: `ℹ️ <@${targetUser.id}> is not linked to any OpenFront account.`,
    });
    return;
  }

  db.unlinkUser(targetUser.id);

  // Remove clan roles from the member across all configured clans in the guild
  if (interaction.guild) {
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const configs = db.getGuildConfigs(interaction.guild.id);

    if (member) {
      for (const config of configs) {
        const rolesToRemove = [
          config.member_role_id,
          config.officer_role_id,
          config.leader_role_id,
        ].filter((r): r is string => Boolean(r));

        for (const roleId of rolesToRemove) {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => null);
          }
        }
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle("🔓 Admin Unlinked User")
    .setColor(0xeab308)
    .setDescription(
      `Unlinked <@${targetUser.id}> from OpenFront account \`${existing.openfront_id}\` and removed all associated clan roles.`
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
