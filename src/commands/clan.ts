import { ChannelType, InteractionContextType, SlashCommandBuilder } from "discord.js";
import { executeClanCommand } from "./clanHandlers.js";

const actions = [
  ["setup", "Configure a clan"],
  ["config", "Open the configuration menu or view saved settings"],
  ["remove", "Remove a clan configuration"],
  ["sync", "Force an immediate role sync"],
  ["pending", "List people waiting for a clan invite"],
  ["roster", "Show linked members of a clan"],
  ["audit", "View link changes made in this server"],
  ["link", "Approve a member's OpenFront link in this server"],
  ["unlink", "Remove a server-only member link"],
  ["coverage", "Compare Discord and clan link coverage"],
  ["doctor", "Check roles, permissions, API and cleanup jobs"],
] as const;

export const clanCommand = {
  data: new SlashCommandBuilder()
    .setName("clan").setContexts(InteractionContextType.Guild)
    .setDescription("Manage OpenFront clan role synchronization")
    .addStringOption((option) => option.setName("action").setDescription("Choose the clan action")
      .setRequired(true).addChoices(...actions.map(([name]) => ({ name, value: name }))))
    .addStringOption((option) => option.setName("clan_tag").setDescription("OpenFront clan tag (used by setup, sync, reports, and more)").setMinLength(2).setMaxLength(5))
    .addRoleOption((option) => option.setName("member_role").setDescription("Setup: Discord role given to all clan members"))
    .addRoleOption((option) => option.setName("officer_role").setDescription("Setup: Discord role given to officers and leader"))
    .addRoleOption((option) => option.setName("leader_role").setDescription("Setup: Discord role given to the clan leader"))
    .addRoleOption((option) => option.setName("join_role").setDescription("Setup: role for users approved to join the clan"))
    .addChannelOption((option) => option.setName("log_channel").setDescription("Setup: channel for role changes and sync notices")
      .addChannelTypes(ChannelType.GuildText))
    .addIntegerOption((option) => option.setName("sync_interval").setDescription("Setup: sync interval in minutes (2–1440)").setMinValue(2).setMaxValue(1440))
    .addUserOption((option) => option.setName("user").setDescription("Member for sync, audit, link, or unlink"))
    .addStringOption((option) => option.setName("openfront_id").setDescription("Link: OpenFront public ID or player profile URL"))
    .addIntegerOption((option) => option.setName("page").setDescription("Result page for paged actions").setMinValue(1)),

  execute: executeClanCommand,
};
