import type { Interaction } from "discord.js";
import { availabilityCommand } from "../commands/availability.js";
import { eventCommand } from "../commands/event.js";

/** Feature command modules add their prefix dispatch here as they are introduced. */
export async function handleCommunityInteraction(interaction: Interaction): Promise<boolean> {
  return await eventCommand.handleInteraction(interaction) || availabilityCommand.handleInteraction(interaction);
}
