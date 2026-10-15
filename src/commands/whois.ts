import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import { db } from "../db.js";
import { openfrontApi } from "../api.js";
import { resolveOpenFrontId, extractDiscordId, toEpochSeconds } from "../utils.js";

export const whoisCommand = {
  data: new SlashCommandBuilder()
    .setName("whois")
    .setDescription("Find the OpenFront account linked to a Discord user, or find a Discord user by OpenFront ID")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The Discord user to look up").setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("openfront_id")
        .setDescription("The OpenFront Public ID or profile URL to look up")
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser("user");
    const rawOpenfrontInput = interaction.options.getString("openfront_id")?.trim();

    if (!targetUser && !rawOpenfrontInput) {
      await interaction.editReply({
        content: "❌ Please provide either a Discord user (`user:`) or an OpenFront ID / URL (`openfront_id:`).",
      });
      return;
    }

    let link = null;

    if (targetUser) {
      // ── Lookup by Discord user ──────────────────────────────
      link = interaction.guild ? db.getEffectiveLink(interaction.guild.id, targetUser.id) : db.getUserByDiscordId(targetUser.id);
      if (!link) {
        await interaction.editReply({
          content: `ℹ️ Discord user <@${targetUser.id}> is not linked to any OpenFront account.`,
        });
        return;
      }
    } else if (rawOpenfrontInput) {
      // ── Lookup by OpenFront ID / URL ────────────────────────
      const maybeDiscordId = extractDiscordId(rawOpenfrontInput);

      if (maybeDiscordId) {
        // The input is a Discord snowflake / mention. Check if this Discord user is linked.
        const discordLink = interaction.guild ? db.getEffectiveLink(interaction.guild.id, maybeDiscordId) : db.getUserByDiscordId(maybeDiscordId);
        if (discordLink) {
          link = discordLink;
        } else {
          // Check if an OpenFront account actually has this numeric ID
          const ofLink = db.getUserByOpenFrontId(maybeDiscordId);
          if (ofLink) {
            link = ofLink;
          } else {
            await interaction.editReply({
              content:
                `⚠️ The input \`${rawOpenfrontInput}\` is a Discord user ID, not an OpenFront Public ID.\n\n` +
                `• No linked OpenFront account was found for Discord user <@${maybeDiscordId}>.\n` +
                `• OpenFront Public IDs are 8-character codes like \`HabCsQYR\` (from profile URLs: \`https://openfront.io/player/HabCsQYR\`).\n` +
                `• To look up a Discord user, you can also use: \`/whois user:@username\`.`,
            });
            return;
          }
        }
      } else {
        const resolvedId = resolveOpenFrontId(rawOpenfrontInput);
        link = interaction.guild ? db.getEffectiveLinkByOpenFrontId(interaction.guild.id, resolvedId) : db.getUserByOpenFrontId(resolvedId);

        if (!link) {
          // Not in local DB, but check if the OpenFront profile exists on API
          const profile = await openfrontApi.getPlayerProfile(resolvedId);

          if (profile?.user?.id && extractDiscordId(profile.user.id)) {
            const embed = new EmbedBuilder()
              .setTitle(`OpenFront Player: ${profile.username || resolvedId}`)
              .setColor(0x3b82f6)
              .setDescription(
                `This OpenFront account is not yet registered in the bot database, but its OpenFront profile has a connected Discord account:`
              )
              .addFields(
                {
                  name: "OpenFront Profile",
                  value: `[${profile.username || resolvedId}](https://openfront.io/player/${resolvedId}) (\`${resolvedId}\`)`,
                  inline: true,
                },
                {
                  name: "Discord Account",
                  value: `<@${profile.user.id}> (${profile.user.username})`,
                  inline: true,
                },
                {
                  name: "Clans",
                  value:
                    profile.clans && profile.clans.length > 0
                      ? profile.clans.map((c) => `• **[${c.tag}]** ${c.name} — *${c.role}*`).join("\n")
                      : "None",
                  inline: false,
                }
              )
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
          }

          if (profile) {
            const embed = new EmbedBuilder()
              .setTitle(`OpenFront Player: ${profile.username || resolvedId}`)
              .setColor(0xf59e0b)
              .setDescription(`This OpenFront account exists on OpenFront, but has no Discord account linked.`)
              .addFields(
                {
                  name: "OpenFront Profile",
                  value: `[${profile.username || resolvedId}](https://openfront.io/player/${resolvedId}) (\`${resolvedId}\`)`,
                  inline: true,
                },
                {
                  name: "Clans",
                  value:
                    profile.clans && profile.clans.length > 0
                      ? profile.clans.map((c) => `• **[${c.tag}]** ${c.name} — *${c.role}*`).join("\n")
                      : "None",
                  inline: false,
                }
              )
              .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
            return;
          }

          await interaction.editReply({
            content: `ℹ️ No Discord account is linked with OpenFront ID \`${resolvedId}\`, and no profile was found on OpenFront for that ID.`,
          });
          return;
        }
      }
    }

    if (!link) return;

    // ── Display full linked identity card ──────────────────────
    const profile = await openfrontApi.getPlayerProfile(link.openfront_id);
    const ofUsername = profile?.username || link.openfront_username || link.openfront_id;

    const epoch = toEpochSeconds(link.linked_at);
    const linkedSinceDisplay = epoch ? `<t:${epoch}:F> (<t:${epoch}:R>)` : link.linked_at;

    const embed = new EmbedBuilder()
      .setTitle(`Identity: ${ofUsername}`)
      .setColor(0x22c55e)
      .addFields(
        { name: "Discord User", value: `<@${link.discord_id}>`, inline: true },
        {
          name: "OpenFront Profile",
          value: `[${ofUsername}](https://openfront.io/player/${link.openfront_id}) (\`${link.openfront_id}\`)`,
          inline: true,
        },
        { name: "Verification Method", value: `\`${link.verified_method}\``, inline: true },
        { name: "Linked Since", value: linkedSinceDisplay, inline: false }
      );

    if (profile?.clans && profile.clans.length > 0) {
      embed.addFields({
        name: "Clans",
        value: profile.clans.map((c) => `• **[${c.tag}]** ${c.name} — *${c.role}*`).join("\n"),
        inline: false,
      });
    } else {
      embed.addFields({
        name: "Clans",
        value: "Not currently in any clan.",
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
