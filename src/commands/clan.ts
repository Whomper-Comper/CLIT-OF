import { SlashCommandBuilder, ChannelType, InteractionContextType } from "discord.js";
import { executeClanCommand } from "./clanHandlers.js";

export const clanCommand = {
  data: new SlashCommandBuilder()
    .setName("clan").setContexts(InteractionContextType.Guild)
    .setDescription("Manage OpenFront clan role synchronization")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Configure an OpenFront clan (requires the server's clan access role)")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setMinLength(2).setMaxLength(5).setDescription("The OpenFront Clan Tag (e.g. UN, ABC)").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("member_role").setDescription("Discord role given to all clan members").setRequired(true)
        )
        .addRoleOption((opt) =>
          opt.setName("officer_role").setDescription("Discord role given to clan officers and leader").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt.setName("leader_role").setDescription("Discord role given to the clan leader").setRequired(false)
        )
        .addRoleOption((opt) =>
          opt
            .setName("join_role")
            .setDescription("Discord role given to users approved to join this clan (notifies officers to invite them)")
            .setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName("log_channel")
            .setDescription("Channel where role changes and sync notices are posted")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("sync_interval")
            .setDescription("Sync interval in minutes (2–1440; uses the configured default if omitted)")
            .setMinValue(2)
            .setMaxValue(1440)
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Open the configuration menu, or view saved settings with tag/page")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("View a saved clan configuration; omit tag/page to open menu").setRequired(false)
        )
        .addIntegerOption((opt) => opt.setName("page").setDescription("Result page").setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a clan configuration from this server")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("The clan tag to remove").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("sync")
        .setDescription("Force an immediate clan role sync")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("Specific user to sync (leave blank for whole server)").setRequired(false)
        )
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("Specific clan to sync (leave blank for all)").setRequired(false)
        )
        .addIntegerOption((opt) => opt.setName("page").setDescription("Result page").setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub
        .setName("pending")
        .setDescription("List users with the clan join role who need an in-game clan invite")
        .addStringOption((opt) =>
          opt.setName("clan_tag").setDescription("Specific clan tag to check (omit for all)").setRequired(false)
        )
        .addIntegerOption((opt) => opt.setName("page").setDescription("Result page").setMinValue(1))
    )
    .addSubcommand((sub) =>
      sub.setName("roster").setDescription("Show linked members of a configured OpenFront clan")
        .addStringOption((opt) => opt.setName("clan_tag").setDescription("Clan tag to list").setRequired(true))
        .addIntegerOption((opt) => opt.setName("page").setDescription("Page number").setMinValue(1).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub.setName("audit").setDescription("View link changes made in this server")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to inspect").setRequired(false))
        .addIntegerOption((opt) => opt.setName("page").setDescription("Page number").setMinValue(1).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub.setName("link").setDescription("Approve a member's OpenFront link in this server only")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to link").setRequired(true))
        .addStringOption((opt) => opt.setName("openfront_id").setDescription("OpenFront public ID or profile URL").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub.setName("unlink").setDescription("Remove a server-only member link")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to unlink").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("coverage").setDescription("Compare current Discord and OpenFront clan link coverage")
      .addStringOption((opt) => opt.setName("clan_tag").setDescription("Clan tag to inspect; omit for all configured clans"))
      .addIntegerOption((opt) => opt.setName("page").setDescription("Result page").setMinValue(1)))
    .addSubcommand((sub) => sub.setName("doctor").setDescription("Check roles, permissions, API connectivity and cleanup jobs")
      .addStringOption((opt) => opt.setName("clan_tag").setDescription("Clan tag to inspect; omit for all configured clans"))
      .addIntegerOption((opt) => opt.setName("page").setDescription("Result page").setMinValue(1))),

  execute: executeClanCommand,
};
