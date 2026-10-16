import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { ClanSyncService } from "../clanSync.js";
import { linkCommand } from "./link.js";
import { unlinkCommand } from "./unlink.js";
import { whoisCommand } from "./whois.js";
import { clanCommand } from "./clan.js";
import { configCommand } from "./config.js";
import { debugCommand } from "./debug.js";

interface BotCommand {
  data: Pick<SlashCommandBuilder, "name" | "toJSON">;
  execute(interaction: ChatInputCommandInteraction, sync: ClanSyncService): Promise<void>;
}
export const commands: BotCommand[] = [linkCommand, unlinkCommand, whoisCommand, clanCommand, configCommand, debugCommand];
export const commandsByName = new Map(commands.map((command) => [command.data.name, command]));
