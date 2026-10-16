import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  ChatInputCommandInteraction, EmbedBuilder, Interaction, InteractionContextType, ModalBuilder,
  PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { db, managedRoles } from "../db.js";
import { hasConfigAccess, requireConfigAccess } from "../access.js";
import { openfrontApi } from "../api.js";
import { ClanDraft, clanDraft, configSnapshot, newClanDraft, normalizeClanTag, validateClanDraft } from "../setupConfig.js";
import { CommandError, label, privateReply, shortText, throttle } from "./support.js";
import { buildCoverageEmbeds, buildDoctorEmbeds } from "../reporting.js";

type Screen = "home" | "draft" | "roles" | "logs" | "confirm";
interface Session {
  id: string; user: string; guild: string; expires: number; page: number; screen: Screen;
  draft: ClanDraft | null; tag: string | null; snapshot: string; accessRevision: number; debugRevision: number;
  busy?: boolean;
}
const sessions = new Map<string, Session>();
const prefix = "clit-config:";
const lifetime = 10 * 60_000;
const button = (s: Session, action: string, text: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(`${prefix}${s.id}:${action}`).setLabel(text).setStyle(style);
const row = (...buttons: ButtonBuilder[]) => new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

export const configCommand = {
  data: new SlashCommandBuilder().setName("config").setDescription("Open server configuration (Manage Server permission or config role)")
    .setContexts(InteractionContextType.Guild),
  async execute(i: ChatInputCommandInteraction) {
    if (!i.inCachedGuild()) throw new CommandError("Open /config in a server where the bot is installed.");
    await i.deferReply(privateReply);
    const allowed = await hasConfigAccess(i.guild, i.user.id);
    if (!allowed) throw new CommandError("You need Manage Server permission or the configured config role to open this menu.");
    for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id);
    if (sessions.size >= 200) sessions.delete(sessions.keys().next().value!);
    const s: Session = { id: randomUUID(), user: i.user.id, guild: i.guildId, expires: Date.now() + lifetime,
      page: 0, screen: "home", draft: null, tag: null, snapshot: "null", accessRevision: db.getGuildSettings(i.guildId)?.revision ?? 0,
      debugRevision: db.getDebugSettings(i.guildId)?.revision ?? 0 };
    sessions.set(s.id, s);
    await i.editReply(render(s, allowed));
  },
};

function render(s: Session, allowed: boolean, notice = "") {
  const settings = db.getGuildSettings(s.guild);
  const configs = db.getGuildConfigs(s.guild);
  const jobs = db.getQueueSummary(s.guild);
  const embed = new EmbedBuilder().setTitle(allowed ? "OpenFront server configuration" : "Set or recover clan access")
    .setColor(0x3b82f6).setFooter({ text: "Private menu · expires after 10 minutes · every change rechecks access" });
  const access = settings ? `<@&${settings.manager_role_id}>` : "Not selected";
  const debugRole = db.getDebugSettings(s.guild)?.debug_role_id;
  const summary = `**Config role:** ${access}\n**Debug role:** ${debugRole ? `<@&${debugRole}>` : "Disabled"}\n**Configured clans:** ${configs.length}\n**Role jobs:** ${jobs.pending} queued (${jobs.retrying} retrying)`;
  const components: ActionRowBuilder<any>[] = [];
  if (!allowed || s.screen === "home") {
    embed.setDescription(`${summary}\n\n${allowed ? "Choose a clan to edit, or create one. Changing the config role below saves immediately. Manage Server permission also grants configuration access; other /clan actions require the selected role." : "Open this menu with Manage Server permission or the config role."}${notice ? `\n\n${notice}` : ""}`);
    components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(new RoleSelectMenuBuilder()
      .setCustomId(`${prefix}${s.id}:access`).setPlaceholder("Set config role (saves immediately)").setMinValues(1).setMaxValues(1)));
    if (allowed) {
      const debugSelect = new RoleSelectMenuBuilder().setCustomId(`${prefix}${s.id}:debug_access`)
        .setPlaceholder("Set debug role (clear to disable; saves immediately)").setMinValues(0).setMaxValues(1);
      if (debugRole) debugSelect.setDefaultRoles(debugRole);
      components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(debugSelect));
      const pages = Math.max(1, Math.ceil(configs.length / 25));
      s.page = Math.min(s.page, pages - 1);
      const choices = configs.slice(s.page * 25, (s.page + 1) * 25);
      if (choices.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`${prefix}${s.id}:clan`).setPlaceholder(`Edit a clan · page ${s.page + 1}/${pages}`)
        .addOptions(choices.map((c) => ({ label: shortText(`[${c.clan_tag}]`, 100), value: c.clan_tag, description: `Sync every ${c.sync_interval_mins} minutes` })))));
      components.push(row(button(s, "new", "New clan", ButtonStyle.Primary), button(s, "previous", "Previous").setDisabled(s.page === 0),
        button(s, "next", "Next").setDisabled(s.page >= pages - 1), button(s, "doctor", "Diagnostics"), button(s, "coverage", "Link coverage")));
    }
    components.push(row(button(s, "close", "Close")));
  } else if (s.draft) {
    const d = s.draft;
    const role = (id: string | null) => id ? `<@&${id}>` : "Not selected";
    embed.setDescription(`**Draft clan:** ${label(d.clan_tag) || "New clan"}\n**Member:** ${role(d.member_role_id)}\n**Officer:** ${role(d.officer_role_id)}\n**Leader:** ${role(d.leader_role_id)}\n**Approval:** ${role(d.join_role_id)}\n**Logs:** ${d.log_channel_id ? `<#${d.log_channel_id}>` : "Off"}\n**Sync interval:** ${d.sync_interval_mins} minutes\n\n${notice || "Changes are saved only when you choose Save."}`);
    if (s.screen === "roles") {
      for (const [field, title, required] of [["member_role_id", "Member role", true], ["officer_role_id", "Officer role", false], ["leader_role_id", "Leader role", false], ["join_role_id", "Approval role", false]] as const) {
        const select = new RoleSelectMenuBuilder().setCustomId(`${prefix}${s.id}:${field}`).setPlaceholder(title)
          .setMinValues(required ? 1 : 0).setMaxValues(1);
        if (d[field]) select.setDefaultRoles(d[field]!);
        components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select));
      }
      components.push(row(button(s, "draft", "Back"), button(s, "save", "Save", ButtonStyle.Success), button(s, "home", "Cancel")));
    } else if (s.screen === "logs") {
      const select = new ChannelSelectMenuBuilder().setCustomId(`${prefix}${s.id}:log_channel_id`).setPlaceholder("Optional log channel")
        .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
      if (d.log_channel_id) select.setDefaultChannels(d.log_channel_id);
      components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select));
      components.push(row(button(s, "draft", "Back"), button(s, "save", "Save", ButtonStyle.Success), button(s, "home", "Cancel")));
    } else if (s.screen === "confirm") {
      embed.setDescription(`Remove **[${label(d.clan_tag)}]** from this server? Obsolete roles will be queued for cleanup.`);
      components.push(row(button(s, "remove", "Confirm removal", ButtonStyle.Danger), button(s, "draft", "Keep clan")));
    } else {
      components.push(row(button(s, "basics", "Tag / sync interval", ButtonStyle.Primary), button(s, "roles", "Clan roles"),
        button(s, "logs", "Log channel"), button(s, "save", "Save", ButtonStyle.Success), button(s, "delete", "Delete", ButtonStyle.Danger).setDisabled(!s.tag)));
      components.push(row(button(s, "home", "Back to clans"), button(s, "close", "Close")));
    }
  }
  return { content: null, embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
}

export async function handleConfigInteraction(i: Interaction): Promise<boolean> {
  if (!(i.isMessageComponent() || i.isModalSubmit()) || !i.customId.startsWith(prefix)) return false;
  let locked: Session | undefined;
  try {
    if (!i.inCachedGuild()) throw new CommandError("This menu is only available in its original server.");
    const [id, action] = i.customId.slice(prefix.length).split(":");
    const s = sessions.get(id);
    if (!s || s.expires <= Date.now()) { sessions.delete(id); throw new CommandError("This menu expired. Open /config again."); }
    if (s.user !== i.user.id || s.guild !== i.guildId) throw new CommandError("Open your own /config menu to change settings.");
    if (s.busy) throw new CommandError("A change is still running in this menu. Wait for it to finish.");
    s.busy = true;
    locked = s;
    if (action === "close") {
      sessions.delete(s.id);
      if (i.isMessageComponent()) await i.update({ content: "Configuration menu closed.", embeds: [], components: [] });
      return true;
    }
    if (action === "basics" && i.isButton() && s.draft) {
      const role = db.getGuildSettings(i.guildId)?.manager_role_id;
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !(role && i.member.roles.cache.has(role))) throw new CommandError("You need Manage Server permission or the config role.");
      // Opening a form changes no persistent state. Submission and Save refresh permissions.
      const modal = new ModalBuilder().setCustomId(`${prefix}${s.id}:details`).setTitle("Clan settings");
      if (!s.tag) {
        const tag = new TextInputBuilder().setCustomId("tag").setLabel("OpenFront clan tag (2–5 letters or numbers)")
          .setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(5);
        if (s.draft.clan_tag) tag.setValue(s.draft.clan_tag);
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(tag));
      }
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("interval")
        .setLabel("Sync interval in minutes (2–1440)").setStyle(TextInputStyle.Short).setValue(String(s.draft.sync_interval_mins)).setMaxLength(4)));
      await i.showModal(modal); return true;
    }
    // A modal must be shown as the initial response; all other actions can defer immediately.
    if (action !== "basics") {
      if (i.isMessageComponent() || i.isModalSubmit() && i.isFromMessage()) await i.deferUpdate();
      else throw new CommandError("Open the configuration menu again.");
    }
    const allowed = await hasConfigAccess(i.guild, i.user.id);
    if (!allowed) throw new CommandError("You no longer have Manage Server permission or the config role. A server manager can recover access with /config.");
    if (action === "debug_access" && i.isRoleSelectMenu()) {
      const selected = i.values[0] ?? null;
      if (selected) {
        const role = await i.guild.roles.fetch(selected);
        if (!role || role.id === i.guildId || role.managed) throw new CommandError("Choose a normal server role other than @everyone.");
      }
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(s);
      const saved = db.setDebugRole(i.guildId, selected, s.debugRevision);
      s.debugRevision = saved.revision;
      s.screen = "home";
      await i.editReply(render(s, true, selected ? "Debug role saved." : "Debug command disabled."));
      return true;
    }
    if (action === "access" && i.isRoleSelectMenu()) {
      const role = await i.guild.roles.fetch(i.values[0]);
      if (!role || role.id === i.guildId || role.managed) throw new CommandError("Choose a normal server role other than @everyone.");
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(s);
      const saved = db.setManagerRole(i.guildId, role.id, s.accessRevision);
      s.accessRevision = saved.revision;
      s.screen = "home";
      await i.editReply(render(s, await hasConfigAccess(i.guild, i.user.id), "Config role saved."));
      return true;
    }
    if (action === "clan" && i.isStringSelectMenu()) {
      const c = db.getGuildClanConfig(i.guildId, i.values[0]);
      if (!c) throw new CommandError("That clan was removed. Open the menu again.");
      s.draft = clanDraft(c); s.tag = c.clan_tag; s.snapshot = configSnapshot(c); s.screen = "draft";
    } else if (action === "new") {
      s.draft = newClanDraft(); s.tag = null; s.snapshot = "null"; s.screen = "draft";
    } else if (action === "home") { s.screen = "home"; s.draft = null; }
    else if (action === "previous") s.page = Math.max(0, s.page - 1);
    else if (action === "next") s.page++;
    else if (["roles", "logs", "draft"].includes(action)) s.screen = action as Screen;
    else if (action === "delete" && s.tag) s.screen = "confirm";
    else if (action === "details" && i.isModalSubmit() && s.draft) {
      if (!s.tag) s.draft.clan_tag = normalizeClanTag(i.fields.getTextInputValue("tag"));
      s.draft.sync_interval_mins = Number(i.fields.getTextInputValue("interval"));
      s.screen = "draft";
    } else if (i.isRoleSelectMenu() && s.draft && ["member_role_id", "officer_role_id", "leader_role_id", "join_role_id"].includes(action)) {
      (s.draft as unknown as Record<string, string | null>)[action] = i.values[0] ?? null;
    } else if (action === "log_channel_id" && i.isChannelSelectMenu() && s.draft) s.draft.log_channel_id = i.values[0] ?? null;
    else if (action === "save" && s.draft) {
      const draft = { ...s.draft };
      const errors = await validateClanDraft(i.guild, draft);
      if (errors.length) throw new CommandError(errors.join("\n"));
      const info = await openfrontApi.getClanInfo(draft.clan_tag);
      if (!info) throw new CommandError("That OpenFront clan was not found. Check the tag.");
      const all = await i.guild.members.fetch();
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(s);
      if (configSnapshot(db.getGuildClanConfig(i.guildId, draft.clan_tag)) !== s.snapshot) throw new CommandError("This clan changed in another session. Reopen it before saving.");
      const old = db.getGuildClanConfig(i.guildId, draft.clan_tag);
      const oldRoles = managedRoles(old ? [old] : []);
      const affected = [...all.values()].filter((m) => db.getEffectiveLink(i.guildId, m.id) || oldRoles.some((r) => m.roles.cache.has(r))).map((m) => m.id);
      db.setGuildClanConfig({ ...draft, guild_id: i.guildId, last_sync_at: null }, affected);
      s.tag = draft.clan_tag; s.snapshot = configSnapshot(db.getGuildClanConfig(i.guildId, s.tag)); s.screen = "draft";
      await i.editReply(render(s, true, "Saved. Role reconciliation is queued.")); return true;
    } else if (action === "remove" && s.tag && s.screen === "confirm") {
      const current = db.getGuildClanConfig(i.guildId, s.tag);
      if (!current || configSnapshot(current) !== s.snapshot) throw new CommandError("This clan changed in another session. Reopen it before removing it.");
      const all = await i.guild.members.fetch();
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(s);
      if (configSnapshot(db.getGuildClanConfig(i.guildId, s.tag)) !== s.snapshot) throw new CommandError("The configuration changed. Reopen the menu.");
      const roles = managedRoles([current]);
      const affected = [...all.values()].filter((m) => db.getEffectiveLink(i.guildId, m.id) || roles.some((r) => m.roles.cache.has(r))).map((m) => m.id);
      db.deleteGuildClanConfig(i.guildId, s.tag, affected);
      s.draft = null; s.tag = null; s.screen = "home";
      await i.editReply(render(s, true, "Clan removed. Obsolete roles are queued for cleanup.")); return true;
    } else if (action === "doctor" || action === "coverage") {
      throttle(`${action}:${i.guildId}`, 15_000);
      const configs = db.getGuildConfigs(i.guildId);
      const embeds = action === "doctor" ? await buildDoctorEmbeds(i.guild, configs, { accessRoleId: db.getGuildSettings(i.guildId)?.manager_role_id, jobs: db.getQueueSummary(i.guildId) })
        : await buildCoverageEmbeds(i.guild, configs);
      await i.followUp({ embeds, ...privateReply, allowedMentions: { parse: [] } }); return true;
    } else throw new CommandError("That menu action is no longer available. Reopen /config.");
    await i.editReply(render(s, true));
  } catch (error) {
    const content = error instanceof Error ? shortText(error.message, 1900) : "Could not update configuration. Please try again.";
    if (i.deferred || i.replied) await i.followUp({ content, ...privateReply, allowedMentions: { parse: [] } }).catch(() => null);
    else await i.reply({ content, ...privateReply, allowedMentions: { parse: [] } }).catch(() => null);
  } finally { if (locked) locked.busy = false; }
  return true;
}

function ensureLive(s: Session) {
  if (sessions.get(s.id) !== s || s.expires <= Date.now()) throw new CommandError("This menu expired. Open /config again.");
}
