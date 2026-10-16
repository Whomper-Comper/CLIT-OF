import { AttachmentBuilder, ChatInputCommandInteraction, InteractionContextType, SlashCommandBuilder } from "discord.js";
import { requireDebugAccess } from "../access.js";
import { db } from "../db.js";
import { CommandError, privateReply, throttle } from "./support.js";

export const debugCommand = {
  data: new SlashCommandBuilder().setName("debug").setDescription("Export server links or inspect server status (requires the debug role)")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) => option.setName("action").setDescription("Choose a debug action").setRequired(true)
      .addChoices({ name: "Export linked users as JSON", value: "export_links" }, { name: "Server link and queue status", value: "status" },
        { name: "Toggle verbose error explanations", value: "verbose" }, { name: "Toggle ephemeral replies", value: "ephemeral" }))
    .addBooleanOption((option) => option.setName("enabled").setDescription("Required for verbose/ephemeral: true enables, false disables")),

  async execute(i: ChatInputCommandInteraction) {
    if (!i.inCachedGuild()) throw new CommandError("Use `/debug` in a server where the bot is installed.");
    await i.deferReply(privateReply);
    await requireDebugAccess(i.guild, i.user.id);
    const action = i.options.getString("action", true);
    if (action === "verbose" || action === "ephemeral") {
      const enabled = i.options.getBoolean("enabled");
      if (enabled === null) throw new CommandError("Provide the enabled input: true to enable or false to disable this setting.");
      const revision = db.getDebugSettings(i.guildId)!.revision;
      await requireDebugAccess(i.guild, i.user.id);
      db.setDebugOptions(i.guildId, action === "verbose" ? { verboseErrors: enabled } : { ephemeralReplies: enabled }, revision);
      const message = action === "verbose" ? `Verbose error explanations ${enabled ? "enabled" : "disabled"}.`
        : enabled ? "Ordinary command replies are private again."
        : "Ordinary clan and unlink replies are now visible in the channel. Verification, configuration menus, debug tools, and access-denied replies stay private. Existing messages keep their original visibility.";
      await i.editReply({ content: message, allowedMentions: { parse: [] } });
      return;
    }
    if (action !== "export_links" && action !== "status") throw new CommandError("Choose a valid debug action.");
    throttle(`debug:${i.guildId}:${i.user.id}`, 15_000);
    let members;
    try { members = await i.guild.members.fetch(); }
    catch { throw new CommandError("Could not load all server members. No partial export was created; try again later."); }
    // Fetching membership can be slow. Recheck the current debug role before releasing any data.
    await requireDebugAccess(i.guild, i.user.id);
    const links = db.getEffectiveLinks(i.guildId).filter((link) => members.has(link.discord_id))
      .sort((a, b) => a.discord_id.localeCompare(b.discord_id));
    if (action === "status") {
      const jobs = db.getQueueSummary(i.guildId);
      const settings = db.getDebugSettings(i.guildId)!;
      const history = db.history.getStatus(i.guildId), historySettings = db.history.getSettings(i.guildId);
      await i.editReply({ content: `Current server members: **${members.size}**\nLinked members: **${links.length}**\nConfigured clans: **${db.getGuildConfigs(i.guildId).length}**\nRole queue: **${jobs.pending}** pending (**${jobs.retrying}** retrying)\nVerbose errors: **${settings.verbose_errors ? "on" : "off"}**\nEphemeral replies: **${settings.ephemeral_replies ? "on" : "off"}**\nHistory collection: **${historySettings.collection_enabled ? "on" : "off"}** · ${history.clanMatches} clan and ${history.playerMatches} player records\nHistory sources: ${history.pending} configured · ${history.failed} retrying\nWeekly recap: **${historySettings.weekly_enabled ? "on" : "off"}** (${historySettings.timezone})${history.lastCollectedAt ? `\nLast collection: <t:${Math.floor(Date.parse(history.lastCollectedAt) / 1000)}:R>` : "\nNo history collection completed yet."}${history.lastError ? "\nA history error needs attention; use the clan doctor action for details." : ""}`, allowedMentions: { parse: [] } });
      return;
    }
    const data = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      guild: { id: i.guildId, name: i.guild.name },
      member_count: members.size,
      linked_user_count: links.length,
      users: links.map((link) => {
        const member = members.get(link.discord_id)!;
        return {
          discord_id: link.discord_id,
          discord_username: member.user.username,
          discord_display_name: member.displayName,
          openfront_id: link.openfront_id,
          openfront_username: link.openfront_username,
          linked_at: link.linked_at,
          scope: link.verified_method === "admin_manual" ? "server" : "bot_wide",
          verification_method: link.verified_method,
        };
      }),
    };
    const json = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
    if (json.length > (i.attachmentSizeLimit ?? 8 * 1024 * 1024)) {
      throw new CommandError("The complete JSON export exceeds Discord's attachment size limit. No partial file was sent.");
    }
    await i.editReply({ content: `Exported **${links.length}** linked user(s) currently in this server.`,
      files: [new AttachmentBuilder(json, { name: `linked-users-${i.guildId}.json` })], allowedMentions: { parse: [] } });
  },
};
