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
import { linkCommand } from "./commands/link.js";
import { unlinkCommand } from "./commands/unlink.js";
import { whoisCommand } from "./commands/whois.js";
import { clanCommand } from "./commands/clan.js";
import { adminCommand } from "./commands/admin.js";

validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // Privileged intent: required for role sync & member lookups
  ],
});

const clanSyncService = new ClanSyncService(client);

client.once(Events.ClientReady, (c) => {
  console.log(`[Bot] Ready! Logged in as ${c.user.tag} (${c.user.id})`);

  c.user.setActivity("OpenFront Clans", { type: ActivityType.Watching });

  // Start periodic background clan role sync
  clanSyncService.startScheduler();
});

// Auto-sync roles when a member joins the Discord server
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const link = db.getUserByDiscordId(member.id);
    if (link) {
      console.log(`[Bot] Linked user ${member.user.tag} joined guild ${member.guild.name}. Syncing roles...`);
      await clanSyncService.syncMember(member);
    }
  } catch (err) {
    console.warn(`[Bot] Error auto-syncing new member ${member.id}:`, err);
  }
});

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

// Slash Command Router
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case "link":
        await linkCommand.execute(interaction, clanSyncService);
        break;

      case "unlink":
        await unlinkCommand.execute(interaction, clanSyncService);
        break;

      case "whois":
        await whoisCommand.execute(interaction);
        break;

      case "clan":
        await clanCommand.execute(interaction, clanSyncService);
        break;

      case "admin":
        await adminCommand.execute(interaction, clanSyncService);
        break;

      default:
        console.warn(`[Bot] Unknown command received: ${commandName}`);
        await interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  } catch (error) {
    console.error(`[Bot] Error executing command /${commandName}:`, error);

    const errorMessage = "⚠️ An unexpected error occurred while processing this command.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorMessage }).catch(() => null);
    } else {
      await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => null);
    }
  }
});

// Process signal handling
process.on("SIGINT", () => {
  console.log("[Bot] Shutting down gracefully...");
  clanSyncService.stopScheduler();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[Bot] Shutting down gracefully...");
  clanSyncService.stopScheduler();
  client.destroy();
  process.exit(0);
});

// Start bot
if (CONFIG.DISCORD_TOKEN) {
  client.login(CONFIG.DISCORD_TOKEN).catch((err) => {
    console.error("[Bot] Login failed:", err);
  });
} else {
  console.warn("[Bot] Cannot log in: DISCORD_TOKEN is empty. Please set it in discord-bot/.env");
}
