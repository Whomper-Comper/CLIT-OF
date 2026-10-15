import { REST, Routes } from "discord.js";
import { CONFIG, validateConfig } from "./config.js";
import { linkCommand } from "./commands/link.js";
import { unlinkCommand } from "./commands/unlink.js";
import { whoisCommand } from "./commands/whois.js";
import { clanCommand } from "./commands/clan.js";

validateConfig();

const commands = [
  linkCommand.data.toJSON(),
  unlinkCommand.data.toJSON(),
  whoisCommand.data.toJSON(),
  clanCommand.data.toJSON(),
];

const rest = new REST({ version: "10" }).setToken(CONFIG.DISCORD_TOKEN);

async function deploy() {
  try {
    console.log(`[Deploy] Started refreshing ${commands.length} application (/) commands.`);

    // If GUILD_ID is provided in args or env, deploy to guild (instant update)
    const guildId = process.env.GUILD_ID || process.argv[2];

    if (guildId) {
      console.log(`[Deploy] Registering commands to Guild: ${guildId}`);
      await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, guildId), {
        body: commands,
      });
      console.log(`[Deploy] Successfully registered commands to Guild ${guildId}.`);
    } else {
      console.log(`[Deploy] Registering commands globally (may take up to 1 hour to propagate across Discord)...`);
      await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), {
        body: commands,
      });
      console.log(`[Deploy] Successfully registered global application commands.`);
    }
  } catch (error) {
    console.error("[Deploy] Failed to deploy commands:", error);
    process.exit(1);
  }
}

deploy();
