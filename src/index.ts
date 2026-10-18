import {
  Client,
  GatewayIntentBits,
  Events,
  ActivityType,
  GuildMember,
} from "discord.js";
import { CONFIG, validateConfig } from "./config.js";
import { db } from "./db.js";
import { ClanSyncService } from "./clanSync.js";

import { commandsByName } from "./commands/index.js";
import { CommandError, privateReply } from "./commands/support.js";
import { OpenFrontApiError, openfrontApi } from "./api.js";
import { HistoryCollector } from "./historyCollector.js";
import { buildWeeklyReport } from "./historyReports.js";
import { handleConfigInteraction } from "./commands/config.js";
import { handleStatsInteraction } from "./commands/stats.js";
import { commandErrorMessage } from "./commands/errorMessages.js";
import { clearDeploymentHealth, writeDeploymentHealth } from "./deploymentHealth.js";
import { createCommunityService } from "./community/runtime.js";
import { handleCommunityInteraction } from "./community/interactions.js";

validateConfig();

const client = new Client({
  allowedMentions: { parse: [] },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Privileged intent: required for role sync & member lookups
  ],
});

const clanSyncService = new ClanSyncService(client);
const communityService = createCommunityService(client, db, openfrontApi);
const historyCollector = new HistoryCollector(client, db, openfrontApi, {
  buildWeeklyReport: async (guildId, start, end) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error("The recap server is no longer available.");
    return buildWeeklyReport(guild, start, end);
  },
});

client.once(Events.ClientReady, (c) => {
  console.log(`[Bot] Ready! Logged in as ${c.user.tag} (${c.user.id})`);

  c.user.setActivity("OpenFront Clans", { type: ActivityType.Watching });

  // Start periodic background clan role sync
  clanSyncService.startScheduler();
  historyCollector.start();
  communityService.start();
  writeDeploymentHealth();
});

// Auto-sync roles when a member joins the Discord server
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const link = db.getEffectiveLink(member.guild.id, member.id);
    if (link) {
      console.log(`[Bot] Linked user ${member.user.tag} joined guild ${member.guild.name}. Syncing roles...`);
      await clanSyncService.syncMember(member);
    }
  } catch (err) {
    console.warn(`[Bot] Error auto-syncing new member ${member.id}:`, err);
  }
});

client.on(Events.GuildMemberRemove, (member) => {
  db.history.purgeMember(member.guild.id, member.id);
  db.community.purgeMember(member.guild.id, member.id);
});
client.on(Events.GuildDelete, (guild) => { db.community.purgeGuild(guild.id); });

// Detect when a member is assigned roles (e.g. given the join_role like "@Mars")
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    // Only proceed if oldMember is a full GuildMember (not partial)
    if (oldMember instanceof GuildMember && newMember instanceof GuildMember) {
      await clanSyncService.handleMemberRoleUpdate(oldMember, newMember);
    }
  } catch (err) {
    console.warn(`[Bot] Error handling GuildMemberUpdate for ${newMember.id}:`, err);
  }
});

// Keep command and component failures inside the Discord event boundary.
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (await handleCommunityInteraction(interaction)) return;
    if (await handleConfigInteraction(interaction)) return;
    if (await handleStatsInteraction(interaction)) return;
    if (!interaction.isChatInputCommand()) return;

    const command = commandsByName.get(interaction.commandName);
    if (!command) throw new CommandError("This command is no longer available. Refresh Discord and try again.");
    await command.execute(interaction, clanSyncService);
  } catch (error) {
    const expected = error instanceof CommandError || error instanceof OpenFrontApiError;
    const source = interaction.isChatInputCommand() ? `command /${interaction.commandName}` : "component";
    if (!expected) console.error(`[Bot] Error handling ${source}:`, error);
    if (!interaction.isRepliable()) return;

    // Formatting may also fail during a storage outage. Never expose raw errors.
    let content = "An unexpected error occurred. Please try again later.";
    try { content = commandErrorMessage(error, interaction.guildId); } catch { /* use the safe fallback */ }
    try {
      if (interaction.deferred || interaction.replied) {
        if (interaction.isChatInputCommand()) {
          await interaction.editReply({ content, embeds: [], components: [], allowedMentions: { parse: [] } });
        } else {
          // An acknowledged button belongs to an existing message; keep its information intact.
          await interaction.followUp({ content, ...privateReply, allowedMentions: { parse: [] } });
        }
      } else {
        await interaction.reply({ content, ...privateReply, allowedMentions: { parse: [] } });
      }
    } catch { /* expired interactions and unavailable Discord cannot be replied to */ }
  }
});

// Stop the scheduler and release resources on either shutdown signal.
async function shutdown() {
  console.log("[Bot] Shutting down gracefully...");
  clearDeploymentHealth();
  clanSyncService.stopScheduler();
  await historyCollector.stop();
  await communityService.stop();
  await client.destroy();
  db.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

client.login(CONFIG.DISCORD_TOKEN).catch(async (err) => {
  console.error("[Bot] Login failed:", err);
  clearDeploymentHealth();
  clanSyncService.stopScheduler();
  await historyCollector.stop();
  await communityService.stop();
  await client.destroy();
  db.close();
  process.exitCode = 1;
});
