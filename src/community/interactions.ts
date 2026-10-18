import type { Interaction } from "discord.js";

/** Feature command modules add their prefix dispatch here as they are introduced. */
export async function handleCommunityInteraction(_interaction: Interaction): Promise<boolean> { return false; }
