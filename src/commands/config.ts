import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType,
  ChatInputCommandInteraction, EmbedBuilder, Interaction, InteractionContextType, ModalBuilder,
  PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from "discord.js";
import { db } from "../db.js";
import { hasConfigAccess, requireConfigAccess } from "../access.js";
import { OpenFrontApiError, openfrontApi } from "../api.js";
import { ClanDraft, clanDraft, configSnapshot, newClanDraft, normalizeClanTag, validateClanDraft } from "../setupConfig.js";
import { CommandError, label, privateReply, shortText, throttle } from "./support.js";
import { buildCoverageReport, buildDoctorEmbeds, reportSettingsGuard } from "../reporting.js";
import { commandErrorMessage } from "./errorMessages.js";
import { HistorySettings } from "../historyStore.js";
import { affectedRoleMemberIds } from "../roles.js";
import { ExpiringSessions } from "../expiringSessions.js";

type Screen = "home" | "clans" | "access_page" | "diagnostics" | "draft" | "roles" | "logs" | "confirm" | "history";
interface Session {
  id: string; user: string; guild: string; expires: number; page: number; screen: Screen;
  draft: ClanDraft | null; tag: string | null; snapshot: string; accessRevision: number; debugRevision: number;
  historyDraft: Omit<HistorySettings, "guild_id" | "revision">; historyRevision: number;
  dirty?: boolean; historyDirty?: boolean; busy?: boolean;
}
const sessions = new ExpiringSessions<Session>(200, session => session.expires);
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
    const started = Date.now();
    let stage = "acknowledgement", sessionId: string | undefined;
    try {
      await i.deferReply(privateReply);
      stage = "access";
      const allowed = await hasConfigAccess(i.guild, i.user.id);
      if (!allowed) throw new CommandError("You need Manage Server permission or the configured config role to open this menu.");
      stage = "session";
      const { guild_id: _guild, revision: historyRevision, ...historyDraft } = db.history.getSettings(i.guildId);
      const s: Session = { id: randomUUID(), user: i.user.id, guild: i.guildId, expires: Date.now() + lifetime,
        page: 0, screen: "home", draft: null, tag: null, snapshot: "null", accessRevision: db.getGuildSettings(i.guildId)?.revision ?? 0,
        debugRevision: db.getDebugSettings(i.guildId)?.revision ?? 0, historyDraft, historyRevision };
      sessions.set(s.id, s); sessionId = s.id;
      stage = "redraw";
      await i.editReply(render(s, allowed));
    } catch (error) {
      if (sessionId) sessions.delete(sessionId);
      if (error instanceof CommandError) throw error;
      logConfigFailure(i, "open", stage, error, started, false);
      // The central listener may log unexpected errors verbatim. Forward only a
      // controlled error, keeping Discord request bodies and tokens inside here.
      let message = "An unexpected error occurred. Please try again later.";
      try { message = commandErrorMessage(error, i.guildId); } catch { /* retain safe fallback */ }
      throw new CommandError(message);
    }
  },
};

function render(s: Session, allowed: boolean, notice = "") {
  const embed = new EmbedBuilder().setTitle(allowed ? "OpenFront server configuration" : "Set or recover clan access")
    .setColor(0x3b82f6).setFooter({ text: "Private menu · expires after 10 minutes · every change rechecks access" });
  const components: ActionRowBuilder<any>[] = [];
  if (!allowed || s.screen === "home") {
    const configs = db.getGuildConfigs(s.guild);
    const jobs = db.getQueueSummary(s.guild);
    embed.setDescription(`Choose a settings page. Clan and history changes require Save.${notice ? `\n\n${notice}` : ""}`)
      .addFields({ name: "Server summary", value: `**Configured clans:** ${configs.length}\n**Role jobs:** ${jobs.pending} queued (${jobs.retrying} retrying)` });
    components.push(row(button(s, "clans", "Clans", ButtonStyle.Primary), button(s, "access_page", "Access"),
      button(s, "history", "History & recaps"), button(s, "diagnostics", "Diagnostics")));
    components.push(row(button(s, "close", "Close")));
  } else if (s.screen === "access_page") {
    const settings = db.getGuildSettings(s.guild);
    const debug = db.getDebugSettings(s.guild);
    const debugRole = debug?.debug_role_id;
    embed.setTitle("Configuration access")
      .setDescription(`Both role selectors save immediately. Manage Server permission can recover configuration access.${notice ? `\n\n${notice}` : ""}`)
      .addFields(
        { name: "Config role", value: `${settings ? `<@&${settings.manager_role_id}>` : "Not selected"}\nRequired for other /clan actions, including for administrators.` },
        { name: "Debug role", value: `${debugRole ? `<@&${debugRole}>` : "Disabled"}\nClear the selector to disable /debug.` },
      );
    const accessSelect = new RoleSelectMenuBuilder().setCustomId(`${prefix}${s.id}:access`)
      .setPlaceholder("Set config role (saves immediately)").setMinValues(1).setMaxValues(1);
    if (settings?.manager_role_id) accessSelect.setDefaultRoles(settings.manager_role_id);
    const debugSelect = new RoleSelectMenuBuilder().setCustomId(`${prefix}${s.id}:debug_access`)
      .setPlaceholder("Set debug role (clear to disable; saves immediately)").setMinValues(0).setMaxValues(1);
    if (debugRole) debugSelect.setDefaultRoles(debugRole);
    components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(accessSelect),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(debugSelect));
    components.push(row(button(s, "home", "Back"), button(s, "close", "Close")));
  } else if (s.screen === "clans") {
    const configs = db.getGuildConfigs(s.guild);
    const pages = Math.max(1, Math.ceil(configs.length / 25));
    s.page = Math.min(s.page, pages - 1);
    const choices = configs.slice(s.page * 25, (s.page + 1) * 25);
    embed.setTitle("Clan configuration").setDescription(`Choose a clan to edit, or create one. Changes require Save.${notice ? `\n\n${notice}` : ""}`);
    if (choices.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`${prefix}${s.id}:clan`).setPlaceholder(`Edit a clan · page ${s.page + 1}/${pages}`)
      .addOptions(choices.map((c) => ({ label: shortText(`[${c.clan_tag}]`, 100), value: c.clan_tag, description: `Sync every ${c.sync_interval_mins} minutes` })))));
    components.push(row(button(s, "new", "New clan", ButtonStyle.Primary), button(s, "previous", "Previous").setDisabled(s.page === 0),
      button(s, "next", "Next").setDisabled(s.page >= pages - 1)));
    components.push(row(button(s, "home", "Back"), button(s, "close", "Close")));
  } else if (s.screen === "diagnostics") {
    const debug = db.getDebugSettings(s.guild);
    embed.setTitle("Configuration diagnostics").setDescription("Run a fresh check of bot permissions and clan mappings, or inspect linked-member coverage.")
      .addFields({ name: "Replies and errors", value: `**Verbose errors:** ${debug?.verbose_errors ? "On" : "Off"}\n**Ordinary private replies:** ${debug?.ephemeral_replies === 0 ? "Off (public)" : "On"}\nUse /debug with the debug role to change these settings.` });
    components.push(row(button(s, "doctor", "Run diagnostics", ButtonStyle.Primary), button(s, "coverage", "Link coverage")));
    components.push(row(button(s, "home", "Back"), button(s, "close", "Close")));
  } else if (s.screen === "history") {
    const h = s.historyDraft, on = (value: number) => value ? "On" : "Off";
    embed.setTitle("Match history and weekly recap settings")
      .setDescription(`**Status:** ${s.historyDirty ? "Unsaved changes" : "Saved settings"}. Changes require Save.${notice ? `\n\n${notice}` : ""}`)
      .addFields(
        { name: "Available history", value: `**Clan match commands:** ${on(h.clan_history_enabled)}\n**Player history / Elo:** ${on(h.player_history_enabled)}`, inline: true },
        { name: "Collection and retention", value: `**Automatic collection:** ${on(h.collection_enabled)} · every ${h.poll_minutes} minutes\n**Retention:** ${h.retention_days} days`, inline: true },
        { name: "Weekly recap", value: `**Weekly recap:** ${on(h.weekly_enabled)}\n**Destination:** ${h.channel_id ? `<#${h.channel_id}>` : "Not selected"}\n**Schedule:** ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][h.weekly_day]} at ${String(h.weekly_hour).padStart(2, "0")}:00 (${h.timezone})` },
        { name: "What the reports cover", value: "Recaps describe the previous completed week. Match collection initially backfills seven days; partial coverage is labelled. Elo observations start when collected, use the saved retention, and require an accessible public leaderboard." },
      );
    const toggle = (action: string, title: string, enabled: number) => button(s, action, `${title}: ${on(enabled)}`, enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
    components.push(row(toggle("history_clans", "Clan history", h.clan_history_enabled), toggle("history_players", "Player history / Elo", h.player_history_enabled),
      toggle("history_collect", "Collect", h.collection_enabled), toggle("history_weekly", "Weekly", h.weekly_enabled), button(s, "history_timing", "Timing / retention")));
    const channel = new ChannelSelectMenuBuilder().setCustomId(`${prefix}${s.id}:history_channel`).setPlaceholder("Weekly recap channel (clear to disable recap)")
      .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
    if (h.channel_id) channel.setDefaultChannels(h.channel_id);
    components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel));
    components.push(row(button(s, "history_save", "Save", ButtonStyle.Success), button(s, "home", "Back"), button(s, "history_cancel", "Cancel")));
  } else if (s.draft) {
    const d = s.draft;
    const role = (id: string | null) => id ? `<@&${id}>` : "Not selected";
    embed.setTitle(`Clan settings · ${s.screen === "roles" ? "Roles" : s.screen === "logs" ? "Logging" : "General"}`)
      .setDescription(`**Draft clan:** ${label(d.clan_tag) || "New clan"}\n**Status:** ${s.dirty ? "Unsaved changes" : "Saved settings"}\n\n${notice || "Changes are saved only when you choose Save."}`)
      .addFields(
        { name: "Clan roles", value: `**Member:** ${role(d.member_role_id)}\n**Officer:** ${role(d.officer_role_id)}\n**Leader:** ${role(d.leader_role_id)}`, inline: true },
        { name: "Approval and logging", value: `**Approval:** ${role(d.join_role_id)}\n**Logs:** ${d.log_channel_id ? `<#${d.log_channel_id}>` : "Off"}`, inline: true },
        { name: "Role synchronization", value: `**Sync interval:** ${d.sync_interval_mins} minutes`, inline: true },
      );
    if (s.screen === "roles") {
      for (const [field, title, required] of [["member_role_id", "Member role", true], ["officer_role_id", "Officer role", false], ["leader_role_id", "Leader role", false], ["join_role_id", "Approval role", false]] as const) {
        const select = new RoleSelectMenuBuilder().setCustomId(`${prefix}${s.id}:${field}`).setPlaceholder(title)
          .setMinValues(required ? 1 : 0).setMaxValues(1);
        if (d[field]) select.setDefaultRoles(d[field]!);
        components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select));
      }
      components.push(row(button(s, "draft", "Back"), button(s, "save", "Save", ButtonStyle.Success), button(s, "cancel", "Cancel")));
    } else if (s.screen === "logs") {
      const select = new ChannelSelectMenuBuilder().setCustomId(`${prefix}${s.id}:log_channel_id`).setPlaceholder("Optional log channel")
        .setChannelTypes(ChannelType.GuildText).setMinValues(0).setMaxValues(1);
      if (d.log_channel_id) select.setDefaultChannels(d.log_channel_id);
      components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(select));
      components.push(row(button(s, "draft", "Back"), button(s, "save", "Save", ButtonStyle.Success), button(s, "cancel", "Cancel")));
    } else if (s.screen === "confirm") {
      embed.setColor(0xef4444).setFields([]).setDescription(`Remove **[${label(d.clan_tag)}]** from this server? Obsolete roles will be queued for cleanup.`);
      components.push(row(button(s, "remove", "Confirm removal", ButtonStyle.Danger), button(s, "draft", "Keep clan")));
    } else {
      components.push(row(button(s, "basics", "Tag / sync interval", ButtonStyle.Primary), button(s, "roles", "Roles"),
        button(s, "logs", "Logging"), button(s, "delete", "Delete", ButtonStyle.Danger).setDisabled(!s.tag)));
      components.push(row(button(s, "clans", "Back"), button(s, "save", "Save", ButtonStyle.Success), button(s, "cancel", "Cancel")));
    }
  }
  return { content: null, embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
}

export async function handleConfigInteraction(i: Interaction): Promise<boolean> {
  if (!(i.isMessageComponent() || i.isModalSubmit()) || !i.customId.startsWith(prefix)) return false;
  let locked: Session | undefined;
  let stage = "session";
  let committed = false;
  const started = Date.now();
  const [id, action] = i.customId.slice(prefix.length).split(":");
  try {
    if (!i.inCachedGuild()) throw new CommandError("This menu is only available in its original server.");
    const stored = sessions.get(id);
    if (!stored || stored.expires <= Date.now()) { sessions.delete(id); throw new CommandError("This menu expired. Open /config again."); }
    if (stored.user !== i.user.id || stored.guild !== i.guildId) throw new CommandError("Open your own /config menu to change settings.");
    if (stored.busy) throw new CommandError("A change is still running in this menu. Wait for it to finish.");
    stored.busy = true;
    locked = stored;
    const s: Session = { ...stored, draft: stored.draft ? { ...stored.draft } : null, historyDraft: { ...stored.historyDraft } };
    // Publish drafts only after Discord accepts the redraw. Durable writes must
    // retain their new snapshot/revision even if the subsequent redraw fails.
    const commit = () => { Object.assign(stored, s); committed = true; };
    const redraw = async (notice = "", allowed = true) => {
      stage = "redraw";
      ensureLive(stored);
      await i.editReply(render(s, allowed, notice));
      Object.assign(stored, s);
    };
    if (action === "close") {
      stage = "acknowledgement";
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
      stage = "acknowledgement";
      await i.showModal(modal); return true;
    }
    if (action === "history_timing" && i.isButton() && s.screen === "history") {
      const role = db.getGuildSettings(i.guildId)?.manager_role_id;
      if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild) && !(role && i.member.roles.cache.has(role))) throw new CommandError("You need Manage Server permission or the config role.");
      const h = s.historyDraft;
      const modal = new ModalBuilder().setCustomId(`${prefix}${s.id}:history_details`).setTitle("History collection and recap timing");
      for (const [key, title, value] of [["poll", "Collection interval minutes (5–1440)", h.poll_minutes], ["retention", "Retention days (14–365)", h.retention_days],
        ["day", "Weekly day (0 Sunday through 6 Saturday)", h.weekly_day], ["hour", "Weekly hour (0–23)", h.weekly_hour], ["timezone", "Time zone (e.g. America/Bahia or UTC)", h.timezone]] as const) {
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(key).setLabel(title).setStyle(TextInputStyle.Short).setValue(String(value)).setMaxLength(64)));
      }
      stage = "acknowledgement";
      await i.showModal(modal); return true;
    }
    // A modal must be shown as the initial response; all other actions can defer immediately.
    if (action !== "basics" && action !== "history_timing") {
      stage = "acknowledgement";
      if (i.isMessageComponent() || i.isModalSubmit() && i.isFromMessage()) await i.deferUpdate();
      else throw new CommandError("Open the configuration menu again.");
    }
    stage = "access";
    const allowed = await hasConfigAccess(i.guild, i.user.id);
    if (!allowed) throw new CommandError("You no longer have Manage Server permission or the config role. A server manager can recover access with /config.");
    ensureLive(stored);
    stage = "action";
    let notice = "";
    if (action === "debug_access" && i.isRoleSelectMenu()) {
      const selected = i.values[0] ?? null;
      if (selected) {
        const role = await i.guild.roles.fetch(selected);
        if (!role || role.id === i.guildId || role.managed) throw new CommandError("Choose a normal server role other than @everyone.");
      }
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(stored);
      const saved = db.setDebugRole(i.guildId, selected, s.debugRevision);
      s.debugRevision = saved.revision;
      s.screen = "access_page";
      commit();
      await redraw(selected ? "Debug role saved." : "Debug command disabled.");
      return true;
    }
    if (action === "access" && i.isRoleSelectMenu()) {
      const role = await i.guild.roles.fetch(i.values[0]);
      if (!role || role.id === i.guildId || role.managed) throw new CommandError("Choose a normal server role other than @everyone.");
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(stored);
      const saved = db.setManagerRole(i.guildId, role.id, s.accessRevision);
      s.accessRevision = saved.revision;
      s.screen = "access_page";
      commit();
      await redraw("Config role saved.", await hasConfigAccess(i.guild, i.user.id));
      return true;
    }
    if (action === "clan" && i.isStringSelectMenu()) {
      const c = db.getGuildClanConfig(i.guildId, i.values[0]);
      if (!c) throw new CommandError("That clan was removed. Open the menu again.");
      s.draft = clanDraft(c); s.tag = c.clan_tag; s.snapshot = configSnapshot(c); s.screen = "draft"; s.dirty = false;
    } else if (action === "history") {
      const { guild_id: _guild, revision, ...draft } = db.history.getSettings(i.guildId);
      s.historyDraft = draft; s.historyRevision = revision; s.screen = "history"; s.historyDirty = false;
    } else if (action === "history_details" && i.isModalSubmit() && s.screen === "history") {
      s.historyDirty = true;
      const h = s.historyDraft;
      h.poll_minutes = Number(i.fields.getTextInputValue("poll")); h.retention_days = Number(i.fields.getTextInputValue("retention"));
      h.weekly_day = Number(i.fields.getTextInputValue("day")); h.weekly_hour = Number(i.fields.getTextInputValue("hour"));
      h.timezone = i.fields.getTextInputValue("timezone").trim();
    } else if (action === "history_channel" && i.isChannelSelectMenu() && s.screen === "history") {
      s.historyDirty = true;
      s.historyDraft.channel_id = i.values[0] ?? null;
      notice = s.historyDraft.channel_id ? "Recap channel selected (unsaved). Choose Save to apply." : "Recap channel cleared (unsaved); weekly recap disabled. Choose Save to apply.";
      if (!s.historyDraft.channel_id) s.historyDraft.weekly_enabled = 0;
    } else if (["history_clans", "history_players", "history_collect", "history_weekly"].includes(action) && s.screen === "history") {
      s.historyDirty = true;
      const fields = { history_clans: "clan_history_enabled", history_players: "player_history_enabled", history_collect: "collection_enabled", history_weekly: "weekly_enabled" } as const;
      const field = fields[action as keyof typeof fields];
      s.historyDraft[field] = s.historyDraft[field] ? 0 : 1;
      if (field === "weekly_enabled" && s.historyDraft.weekly_enabled) s.historyDraft.collection_enabled = 1;
      if (field === "collection_enabled" && !s.historyDraft.collection_enabled) s.historyDraft.weekly_enabled = 0;
    } else if (action === "history_save" && s.screen === "history") {
      const h = { ...s.historyDraft };
      if (h.channel_id) {
        const channel = await i.guild.channels.fetch(h.channel_id), me = await i.guild.members.fetchMe();
        if (!channel || channel.type !== ChannelType.GuildText || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) {
          throw new CommandError("Choose a text channel where the bot can view, send, embed links and read message history for recap delivery.");
        }
      }
      await requireConfigAccess(i.guild, i.user.id); ensureLive(stored);
      let saved: HistorySettings;
      try { saved = db.history.saveSettings(i.guildId, h, s.historyRevision); }
      catch (error) {
        const message = error instanceof Error ? error.message : "Could not save history settings.";
        if (/History toggles|Poll interval|Retention|Weekly day|Weekly hour|IANA timezone|Weekly recaps|server text channel|History settings changed/.test(message)) throw new CommandError(message);
        throw error;
      }
      s.historyRevision = saved.revision; s.historyDirty = false;
      commit();
      await redraw("History settings saved. Automatic collection and recaps use these settings."); return true;
    } else if (action === "new") {
      s.draft = newClanDraft(); s.tag = null; s.snapshot = "null"; s.screen = "draft"; s.dirty = true;
    } else if (["home", "clans", "access_page", "diagnostics", "cancel", "history_cancel"].includes(action)) {
      s.screen = action === "cancel" ? "clans" : action === "history_cancel" ? "home" : action as Screen;
      s.draft = null;
    }
    else if (action === "previous") { s.screen = "clans"; s.page = Math.max(0, s.page - 1); }
    else if (action === "next") { s.screen = "clans"; s.page++; }
    else if (["roles", "logs", "draft"].includes(action)) s.screen = action as Screen;
    else if (action === "delete" && s.tag) s.screen = "confirm";
    else if (action === "details" && i.isModalSubmit() && s.draft) {
      s.dirty = true;
      if (!s.tag) s.draft.clan_tag = normalizeClanTag(i.fields.getTextInputValue("tag"));
      s.draft.sync_interval_mins = Number(i.fields.getTextInputValue("interval"));
      s.screen = "draft";
    } else if (i.isRoleSelectMenu() && s.draft && ["member_role_id", "officer_role_id", "leader_role_id", "join_role_id"].includes(action)) {
      s.dirty = true;
      (s.draft as unknown as Record<string, string | null>)[action] = i.values[0] ?? null;
    } else if (action === "log_channel_id" && i.isChannelSelectMenu() && s.draft) {
      s.draft.log_channel_id = i.values[0] ?? null; s.dirty = true;
      notice = s.draft.log_channel_id ? "Log channel selected (unsaved). Choose Save to apply." : "Log channel cleared (unsaved). Choose Save to apply.";
    } else if (action === "save" && s.draft) {
      const draft = { ...s.draft };
      const errors = await validateClanDraft(i.guild, draft);
      if (errors.length) throw new CommandError(errors.join("\n"));
      const info = await openfrontApi.getClanInfo(draft.clan_tag);
      if (!info) throw new CommandError("That OpenFront clan was not found. Check the tag.");
      const all = await i.guild.members.fetch();
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(stored);
      if (configSnapshot(db.getGuildClanConfig(i.guildId, draft.clan_tag)) !== s.snapshot) throw new CommandError("This clan changed in another session. Reopen it before saving.");
      const old = db.getGuildClanConfig(i.guildId, draft.clan_tag);
      const affected = affectedRoleMemberIds(all.values(), db.getEffectiveLinks(i.guildId), old);
      db.setGuildClanConfig({ ...draft, guild_id: i.guildId, last_sync_at: null }, affected);
      s.tag = draft.clan_tag; s.snapshot = configSnapshot({ ...draft, guild_id: i.guildId, last_sync_at: null }); s.screen = "draft"; s.dirty = false;
      commit();
      await redraw("Saved. Role reconciliation is queued."); return true;
    } else if (action === "remove" && s.tag && s.screen === "confirm") {
      const current = db.getGuildClanConfig(i.guildId, s.tag);
      if (!current || configSnapshot(current) !== s.snapshot) throw new CommandError("This clan changed in another session. Reopen it before removing it.");
      const all = await i.guild.members.fetch();
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(stored);
      if (configSnapshot(db.getGuildClanConfig(i.guildId, s.tag)) !== s.snapshot) throw new CommandError("The configuration changed. Reopen the menu.");
      const affected = affectedRoleMemberIds(all.values(), db.getEffectiveLinks(i.guildId), current);
      db.deleteGuildClanConfig(i.guildId, s.tag, affected);
      s.draft = null; s.tag = null; s.screen = "clans";
      commit();
      await redraw("Clan removed. Obsolete roles are queued for cleanup."); return true;
    } else if (action === "doctor" || action === "coverage") {
      throttle(`${action}:${i.guildId}`, 15_000);
      const currentSettings = reportSettingsGuard(i.guildId);
      const configs = db.getGuildConfigs(i.guildId);
      const coverage = action === "coverage" ? await buildCoverageReport(i.guild, configs) : null;
      const embeds = coverage?.embeds ?? await buildDoctorEmbeds(i.guild, configs, { accessRoleId: db.getGuildSettings(i.guildId)?.manager_role_id, jobs: db.getQueueSummary(i.guildId) });
      await requireConfigAccess(i.guild, i.user.id);
      ensureLive(stored);
      currentSettings();
      coverage?.assertCurrent();
      await i.followUp({ embeds, ...privateReply, allowedMentions: { parse: [] } }); return true;
    } else throw new CommandError("That menu action is no longer available. Reopen /config.");
    await redraw(notice);
  } catch (error) {
    const expected = error instanceof CommandError || error instanceof OpenFrontApiError || error instanceof Error && /^(The (access role|debug role)|Debug settings) changed in another session\./.test(error.message);
    if (!expected) logConfigFailure(i, action, stage, error, started, committed);
    let content = "An unexpected error occurred. Please try again later.";
    if (committed) content = "Settings saved, but the menu could not refresh. Reopen /config to review the saved settings.";
    else { try { content = commandErrorMessage(error, i.guildId); } catch { /* retain safe fallback */ } }
    try {
      if (i.deferred || i.replied) await i.followUp({ content, ...privateReply, allowedMentions: { parse: [] } });
      else await i.reply({ content, ...privateReply, allowedMentions: { parse: [] } });
    } catch (recoveryError) { logConfigFailure(i, action, "recovery", recoveryError, started, committed); }
  } finally { if (locked) locked.busy = false; }
  return true;
}

function ensureLive(s: Session) {
  if (sessions.get(s.id) !== s || s.expires <= Date.now()) throw new CommandError("This menu expired. Open /config again.");
}

const diagnosticActions = new Set(["open", "clans", "access_page", "diagnostics", "home", "cancel", "history_cancel", "close", "access", "debug_access", "clan", "new", "previous", "next",
  "draft", "roles", "logs", "basics", "details", "delete", "remove", "save", "member_role_id", "officer_role_id", "leader_role_id", "join_role_id", "log_channel_id",
  "history", "history_timing", "history_details", "history_channel", "history_clans", "history_players", "history_collect", "history_weekly", "history_save", "doctor", "coverage"]);

/** Discord errors can carry request bodies and webhook tokens. Never log the error object. */
function logConfigFailure(i: Interaction, action: string, stage: string, error: unknown, started: number, committed: boolean) {
  const value = error && typeof error === "object" ? error as { code?: unknown; name?: unknown } : {};
  const code = typeof value.code === "number" && Number.isSafeInteger(value.code) ? value.code : undefined;
  const name = ["Error", "TypeError", "RangeError", "DiscordAPIError", "HTTPError", "AbortError"].includes(String(value.name)) ? String(value.name) : "Error";
  const now = Date.now();
  console.warn("[Config] Interaction failure", {
    action: diagnosticActions.has(action) ? action : "unknown", stage, code, name,
    elapsedMs: Math.max(0, now - started),
    interactionAgeMs: Number.isFinite(i.createdTimestamp) ? Math.max(0, now - i.createdTimestamp) : null,
    deferred: "deferred" in i && i.deferred, replied: "replied" in i && i.replied, committed,
  });
}
