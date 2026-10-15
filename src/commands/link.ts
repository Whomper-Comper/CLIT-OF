import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import { db } from "../db.js";
import { openfrontApi } from "../api.js";
import { ClanSyncService } from "../clanSync.js";
import { resolveOpenFrontId, isDiscordSnowflake, extractDiscordId } from "../utils.js";

export const linkCommand = {
  data: new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Discord account to your OpenFront account")
    .addStringOption((opt) =>
      opt
        .setName("openfront_id")
        .setDescription("Your OpenFront Public ID or profile URL (e.g. HabCsQYR or openfront.io/player/HabCsQYR)")
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName("token")
        .setDescription("Identity token from OpenFront Account Settings → Link to third-party site")
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction, clanSync: ClanSyncService) {
    await interaction.deferReply({ ephemeral: true });

    const discordId = interaction.user.id;
    const rawIdInput = interaction.options.getString("openfront_id")?.trim();
    const tokenInput = interaction.options.getString("token")?.trim();

    if (!rawIdInput && !tokenInput) {
      await interaction.editReply({
        content:
          "❌ Please provide either your OpenFront Public ID (`openfront_id:`) or an Identity Token (`token:`).\n\n" +
          "**How to link:**\n" +
          "• **Signed into OpenFront with Discord?** Just run: `/link openfront_id:YOUR_ID`\n" +
          "• **Have a profile URL?** Paste it directly: `/link openfront_id:https://openfront.io/player/YOUR_ID`\n" +
          "• **Signed into OpenFront with Google/Steam/Email?** In OpenFront, go to **Account Settings → Link to a third-party site**, click **Generate Token**, and paste it: `/link token:eyJ...`",
      });
      return;
    }

    let resolvedOpenFrontId: string | null = null;
    let verificationMethod = "profile_discord";

    // --- Path A: Verified via Identity Token ---
    if (tokenInput) {
      const verifiedId = await openfrontApi.verifyIdentityToken(tokenInput);
      if (!verifiedId) {
        await interaction.editReply({
          content:
            "❌ Invalid or expired OpenFront Identity Token.\n\n" +
            "Please go to **OpenFront → Account Settings → Link to a third-party site**, generate a fresh token, and try again (tokens expire after 10 minutes).",
        });
        return;
      }
      resolvedOpenFrontId = verifiedId;
      verificationMethod = "identity_token";
    } else if (rawIdInput) {
      // Check if user accidentally entered a Discord snowflake/mention into openfront_id
      const extractedDiscordId = extractDiscordId(rawIdInput);
      if (extractedDiscordId) {
        await interaction.editReply({
          content:
            `❌ The value \`${rawIdInput}\` is a Discord User ID, not an OpenFront Public ID!\n\n` +
            `• OpenFront Public IDs are 8-character codes like \`HabCsQYR\`.\n` +
            `• You can find yours in your profile URL: \`https://openfront.io/player/HabCsQYR\`.\n` +
            `• If you named your in-game player name a Discord ID, that is your username, not your Public ID. Please use your Public ID or generate an Identity Token: \`/link token:<paste_token>\`.`,
        });
        return;
      }

      resolvedOpenFrontId = resolveOpenFrontId(rawIdInput);
    }

    if (!resolvedOpenFrontId) return;

    // Check again if resolvedOpenFrontId is a Discord snowflake
    if (isDiscordSnowflake(resolvedOpenFrontId)) {
      await interaction.editReply({
        content: `❌ \`${resolvedOpenFrontId}\` appears to be a Discord User ID, not an OpenFront Public ID.`,
      });
      return;
    }

    // Check if another Discord user is already linked to this OpenFront account
    const existingOfUser = db.getUserByOpenFrontId(resolvedOpenFrontId);
    if (existingOfUser && existingOfUser.discord_id !== discordId) {
      await interaction.editReply({
        content: `❌ The OpenFront account \`${resolvedOpenFrontId}\` is already linked to another Discord user (<@${existingOfUser.discord_id}>).`,
      });
      return;
    }

    // Fetch the player profile from OpenFront public API
    const profile = await openfrontApi.getPlayerProfile(resolvedOpenFrontId);
    if (!profile) {
      await interaction.editReply({
        content: `❌ Could not find an OpenFront player with ID \`${resolvedOpenFrontId}\`. Please check the ID or profile link and try again.`,
      });
      return;
    }

    const ofUsername = profile.username || resolvedOpenFrontId;

    // Check verification status:
    // 1. Verified by EdDSA Identity Token (cryptographically signed), OR
    // 2. Verified because OpenFront profile.user.id matches this Discord ID
    //    (Strict check: profile.user.id must match discordId, and must be a valid snowflake).
    const profileDiscordId = profile.user?.id ? extractDiscordId(profile.user.id) : null;
    const isDiscordMatch = Boolean(profileDiscordId && profileDiscordId === discordId);

    const isVerified = verificationMethod === "identity_token" || isDiscordMatch;

    if (isVerified) {
      db.linkUser(discordId, resolvedOpenFrontId, profile.username || null, verificationMethod);

      const embed = new EmbedBuilder()
        .setTitle("✅ Accounts Linked Successfully!")
        .setColor(0x22c55e)
        .setDescription(
          `Your Discord account is now linked to OpenFront account **[${ofUsername}](https://openfront.io/player/${resolvedOpenFrontId})** (\`${resolvedOpenFrontId}\`).\n\n` +
            `Verified via: \`${verificationMethod === "identity_token" ? "OpenFront Cryptographic Identity Token" : "OpenFront Discord Connection"}\`.`
        )
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

      // Trigger immediate clan role sync if in a guild
      if (interaction.member instanceof GuildMember) {
        await clanSync.syncMember(interaction.member);
      }
      return;
    }

    // Not verified via Discord profile and no token was provided — explain options
    const embed = new EmbedBuilder()
      .setTitle("🔐 Account Verification Required")
      .setColor(0x3b82f6)
      .setDescription(
        `We found OpenFront account **[${ofUsername}](https://openfront.io/player/${resolvedOpenFrontId})** (\`${resolvedOpenFrontId}\`), but it does not have your Discord account directly linked in OpenFront.\n\n` +
          `**Choose how you want to verify ownership:**\n\n` +
          `### 🌟 Method 1: Instant Identity Token (Recommended)\n` +
          `1. In OpenFront, open **Account Settings**.\n` +
          `2. Under **Link to a third-party site**, select any site (e.g. \`ofstats.io\`) and click **Generate Token**.\n` +
          `3. Copy the token and paste it here:\n` +
          `   \`/link token:<paste_token_here>\`\n\n` +
          `### 🛡️ Method 2: Clan Officer Approval\n` +
          `Ask a clan officer in this server to run:\n` +
          `\`/admin link user:@${interaction.user.username} openfront_id:${resolvedOpenFrontId}\``
      );

    await interaction.editReply({ embeds: [embed] });
  },
};
