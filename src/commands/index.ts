import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { ClanSyncService } from "../clanSync.js";
import { linkCommand } from "./link.js";
import { unlinkCommand } from "./unlink.js";
import { whoisCommand } from "./whois.js";
import { statsCommand } from "./stats.js";
import { clanCommand } from "./clan.js";
import { configCommand } from "./config.js";
import { debugCommand } from "./debug.js";
import { diceCommand } from "./dice.js";
import { availabilityCommand } from "./availability.js";
import { eventCommand } from "./event.js";
import { onboardingCommand } from "./onboarding.js";
import { wheelCommand } from "./wheel.js";

interface BotCommand {
  data: Pick<SlashCommandBuilder, "name" | "toJSON">;
  execute(interaction: ChatInputCommandInteraction, sync: ClanSyncService): Promise<void>;
}
export const commands: BotCommand[] = [linkCommand, unlinkCommand, whoisCommand, statsCommand, clanCommand, configCommand, debugCommand, diceCommand, availabilityCommand, eventCommand, onboardingCommand, wheelCommand];
export const commandsByName = new Map(commands.map((command) => [command.data.name, command]));
