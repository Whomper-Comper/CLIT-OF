import type { Interaction } from "discord.js";
import { availabilityCommand } from "../commands/availability.js";
import { eventCommand } from "../commands/event.js";
import { onboardingCommand } from "../commands/onboarding.js";
import { wheelCommand } from "../commands/wheel.js";
import { milestonesCommand } from "../commands/milestones.js";

/** Feature command modules add their prefix dispatch here as they are introduced. */
export async function handleCommunityInteraction(interaction: Interaction): Promise<boolean> {
  return await eventCommand.handleInteraction(interaction) || await availabilityCommand.handleInteraction(interaction) ||
    await onboardingCommand.handleInteraction(interaction) || await wheelCommand.handleInteraction(interaction) || milestonesCommand.handleInteraction(interaction);
}
