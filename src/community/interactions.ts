import type { Interaction } from "discord.js";
import { availabilityCommand } from "../commands/availability.js";

/** Feature command modules add their prefix dispatch here as they are introduced. */
export async function handleCommunityInteraction(interaction: Interaction): Promise<boolean> {
  return availabilityCommand.handleInteraction(interaction);
}
