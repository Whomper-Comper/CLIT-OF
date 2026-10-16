import { ChatInputCommandInteraction, EmbedBuilder, Guild, GuildMember } from "discord.js";
import { db, GuildClanConfig, managedRoles } from "../db.js";
import { openfrontApi } from "../api.js";
import { ClanSyncService, SyncResult } from "../clanSync.js";
import { configSnapshot, newClanDraft, normalizeClanTag, validateClanDraft } from "../setupConfig.js";
import { toEpochSeconds } from "../utils.js";
import { desiredRoles } from "../roles.js";
import { CommandError, identityLocks, label, pageOf, playerId, privateReply, profileLink, sendEmbeds, shortText, throttle } from "./support.js";
import { checkClanAccess, checkConfigAccess, requireClanAccess, requireConfigAccess } from "../access.js";
import { configCommand } from "./config.js";
import { buildCoverageEmbeds, buildDoctorEmbeds } from "../reporting.js";

type GuildCommand = ChatInputCommandInteraction<"cached">;
const pageNumber = (i: GuildCommand) => i.options.getInteger("page") ?? 1;

async function members(guild: Guild) {
  try { return await guild.members.fetch(); }
  catch { throw new CommandError("Could not load all server members. Please try again."); }
}

async function member(guild: Guild, id: string): Promise<GuildMember> {
  try { return await guild.members.fetch(id); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 10007) throw new CommandError("That user is not a member of this server.");
    throw new CommandError("Could not load that server member. Please try again.");
  }
}

function configs(i: GuildCommand): GuildClanConfig[] {
  const tag = i.options.getString("clan_tag");
  const result = db.getGuildConfigs(i.guildId).filter((config) => !tag || config.clan_tag === normalizeClanTag(tag));
  if (!result.length) throw new CommandError(tag ? "That clan is not configured in this server." : "No clans are configured in this server. Ask a server manager to use `/clan setup`.");
  return result;
}

export async function executeClanCommand(interaction: ChatInputCommandInteraction, sync: ClanSyncService) {
  if (!interaction.inCachedGuild()) throw new CommandError("Use `/clan` in a Discord server where the bot is installed.");
  const i = interaction;
  const action = i.options.getSubcommand();
  if (action === "config") checkConfigAccess(i);
  else checkClanAccess(i);
  if (action === "config" && !i.options.getString("clan_tag") && !i.options.getInteger("page")) return configCommand.execute(i);
  if (action === "sync") {
    const target = i.options.getUser("user");
    throttle(target ? `sync:${i.guildId}:${target.id}` : `sync:${i.guildId}:all`, target ? 10_000 : 60_000);
  }
  if (["roster", "pending", "coverage", "doctor"].includes(action)) throttle(`${action}:${i.guildId}`, 15_000);
  if (["setup", "remove", "link", "unlink"].includes(action)) throttle(`${action}:${i.guildId}:${i.user.id}`, 3000);
  await i.deferReply(action === "roster" || (action === "sync" && !i.options.getUser("user")) ? {} : privateReply);
  if (action === "config") await requireConfigAccess(i.guild, i.user.id);
  else await requireClanAccess(i.guild, i.user.id);
  switch (action) {
    case "setup": return setup(i);
    case "remove": return remove(i);
    case "config": return config(i);
    case "sync": return synchronize(i, sync);
    case "pending": return pending(i, sync);
    case "roster": return roster(i);
    case "audit": return audit(i);
    case "link": return guildLink(i);
    case "unlink": return guildUnlink(i);
    case "coverage": return sendEmbeds(i, await buildCoverageEmbeds(i.guild, reportConfigs(i), pageNumber(i)));
    case "doctor": return sendEmbeds(i, await buildDoctorEmbeds(i.guild, reportConfigs(i), {
      page: pageNumber(i), accessRoleId: db.getGuildSettings(i.guildId)?.manager_role_id, jobs: db.getQueueSummary(i.guildId),
    }));
    default: throw new CommandError("That command is no longer available. Refresh Discord and try again.");
  }
}

function reportConfigs(i: GuildCommand) {
  return i.options.getString("clan_tag") ? configs(i) : db.getGuildConfigs(i.guildId);
}

async function setup(i: GuildCommand) {
  const tag = normalizeClanTag(i.options.getString("clan_tag", true));
  const previous = db.getGuildClanConfig(i.guildId, tag);
  const snapshot = configSnapshot(previous);
  const draft = { ...newClanDraft(tag), member_role_id: i.options.getRole("member_role", true).id,
    officer_role_id: i.options.getRole("officer_role")?.id ?? null,
    leader_role_id: i.options.getRole("leader_role")?.id ?? null,
    join_role_id: i.options.getRole("join_role")?.id ?? null,
    log_channel_id: i.options.getChannel("log_channel")?.id ?? null,
  };
  draft.sync_interval_mins = i.options.getInteger("sync_interval") ?? draft.sync_interval_mins;
  const errors = await validateClanDraft(i.guild, draft);
  if (errors.length) throw new CommandError(errors.join("\n"));
  const clan = await openfrontApi.getClanInfo(tag);
  if (!clan) throw new CommandError("That OpenFront clan does not exist. Check the clan tag.");
  const allMembers = await members(i.guild);
  await requireClanAccess(i.guild, i.user.id);
  if (configSnapshot(db.getGuildClanConfig(i.guildId, tag)) !== snapshot) throw new CommandError("This clan configuration changed while setup was running. Run setup again.");
  const oldRoles = managedRoles(previous ? [previous] : []);
  const affected = [...allMembers.values()].filter((m) => db.getEffectiveLink(i.guildId, m.id) || oldRoles.some((role) => m.roles.cache.has(role))).map((m) => m.id);
  db.setGuildClanConfig({ ...draft, guild_id: i.guildId, last_sync_at: null }, affected);
  await sendEmbeds(i, [configEmbed({ ...draft, guild_id: i.guildId, last_sync_at: null }).setTitle(`Clan configured: [${tag}]`)
    .setDescription(`Connected to **${label(clan.name)}**. Role updates are queued when existing mappings change.`)]);
}

async function remove(i: GuildCommand) {
  const [selected] = configs(i);
  const snapshot = configSnapshot(selected);
  const allMembers = await members(i.guild);
  await requireClanAccess(i.guild, i.user.id);
  if (configSnapshot(db.getGuildClanConfig(i.guildId, selected.clan_tag)) !== snapshot) throw new CommandError("The configuration changed while removal was running. Try again.");
  const oldRoles = managedRoles([selected]);
  const affected = [...allMembers.values()].filter((m) => db.getEffectiveLink(i.guildId, m.id) || oldRoles.some((role) => m.roles.cache.has(role))).map((m) => m.id);
  db.deleteGuildClanConfig(i.guildId, selected.clan_tag, affected);
  await i.editReply({ content: `Removed **[${selected.clan_tag}]** from this server. Cleanup of its obsolete roles is queued.` });
}

function configEmbed(c: GuildClanConfig) {
  const epoch = toEpochSeconds(c.last_sync_at);
  const role = (id: string | null) => id ? `<@&${id}>` : "None";
  return new EmbedBuilder().setTitle(`Clan configuration: [${shortText(c.clan_tag, 32)}]`).setColor(0x3b82f6)
    .addFields({ name: "Member Role", value: role(c.member_role_id), inline: true },
      { name: "Officer Role", value: role(c.officer_role_id), inline: true },
      { name: "Leader Role", value: role(c.leader_role_id), inline: true },
      { name: "Approval Role", value: role(c.join_role_id), inline: true },
      { name: "Log Channel", value: c.log_channel_id ? `<#${c.log_channel_id}>` : "None", inline: true },
      { name: "Sync Interval", value: `${c.sync_interval_mins} minutes`, inline: true },
      { name: "Last Successful Sync", value: epoch !== null ? `<t:${epoch}:F> (<t:${epoch}:R>)` : "Never" });
}

async function config(i: GuildCommand) {
  const selected = pageOf(configs(i), pageNumber(i), 3);
  await sendEmbeds(i, selected.items.map((c) => configEmbed(c).setFooter({ text: selected.footer })));
}

async function synchronize(i: GuildCommand, sync: ClanSyncService) {
  const selected = configs(i);
  // Validate the requested page before applying any role changes.
  const page = pageOf(selected, pageNumber(i), 10);
  const target = i.options.getUser("user");
  // Public messages remain editable with the bot token after an interaction expires.
  const progress = !target ? await i.editReply({ content: "Clan sync is running. Role changes are paced; this message will show the result when it finishes." }) : null;
  const results: { config: GuildClanConfig; results: SyncResult[] }[] = [];
  if (target) {
    const targetMember = await member(i.guild, target.id);
    const link = db.getEffectiveLink(i.guildId, target.id);
    if (!link) throw new CommandError("That member has no OpenFront link in this server. They can use `/link`.");
    for (const c of page.items) {
      const result = await sync.syncMemberForClan(targetMember, link, c);
      if (result.rolesAdded.length || result.rolesRemoved.length) await sync.logRoleChange(i.guild, c, targetMember, result);
      results.push({ config: c, results: [result] });
    }
  } else {
    for (const c of page.items) results.push({ config: c, results: await sync.syncGuildClan(i.guild, c) });
  }
  const flat = results.flatMap((r) => r.results);
  const failed = flat.filter((r) => r.error).length;
  const unique = new Set(flat.map((r) => r.discordId)).size;
  const embed = new EmbedBuilder().setTitle(failed ? "Clan sync finished with errors" : "Clan sync complete").setColor(failed ? 0xf59e0b : 0x22c55e)
    .setDescription(`${unique} linked member(s) checked across ${page.items.length} clan(s). ${failed} failed check(s).`)
    .setFooter({ text: page.footer });
  for (const c of page.items) {
    const list = results.find((r) => r.config.clan_tag === c.clan_tag)!.results;
    const errors = list.filter((r) => r.error);
    const changes = list.reduce((count, r) => count + r.rolesAdded.length + r.rolesRemoved.length, 0);
    embed.addFields({ name: `[${c.clan_tag}]`, value: target && list[0]?.error ? `Could not sync: ${shortText(list[0].error, 300)}`
      : `${list.filter((r) => !r.error && r.inClan).length} in clan · ${changes} role changes · ${errors.length} failed check(s)`, inline: true });
  }
  if (progress) await progress.edit({ content: null, embeds: [embed], allowedMentions: { parse: [] } });
  else await sendEmbeds(i, [embed]);
}

async function pending(i: GuildCommand, sync: ClanSyncService) {
  const available = configs(i).filter((c) => c.join_role_id);
  if (!available.length) throw new CommandError("No approval role is configured for the selected clans. A server manager can set join_role in /clan setup.");
  const lines: string[] = [];
  for (const c of available) {
    const list = await sync.getPendingJoinMembers(i.guild, c);
    for (const entry of list) lines.push(entry.link
      ? `• [${c.clan_tag}] <@${entry.member.id}> — ${profileLink(entry.link.openfront_id, entry.ofUsername || entry.link.openfront_id)}`
      : `• [${c.clan_tag}] <@${entry.member.id}> — needs to use /link`);
  }
  const page = pageOf(lines, pageNumber(i), 15);
  await sendEmbeds(i, [new EmbedBuilder().setTitle("Pending clan invitations").setColor(lines.length ? 0xf59e0b : 0x22c55e)
    .setDescription(page.items.join("\n") || "No pending invitations were found.")
    .setFooter({ text: `${page.footer} · ${lines.length} pending invitation(s)` })]);
}

async function roster(i: GuildCommand) {
  const [c] = configs(i);
  const allMembers = await members(i.guild);
  const links = db.getEffectiveLinks(i.guildId).filter((link) => allMembers.has(link.discord_id));
  const rows: { id: string; name: string; line: string }[] = [];
  let next = 0;
  let unavailable = 0;
  await Promise.all(Array.from({ length: Math.min(4, links.length) }, async () => {
    while (next < links.length) {
      const link = links[next++];
      try {
        const profile = await openfrontApi.getPlayerProfile(link.openfront_id);
        if (!profile || !profile.clans) { unavailable++; continue; }
        if (db.getEffectiveLink(i.guildId, link.discord_id)?.openfront_id !== link.openfront_id) continue;
        const clan = profile.clans.find((entry) => entry.tag.toUpperCase() === c.clan_tag);
        if (!clan) continue;
        const name = profile.username || link.openfront_username || link.openfront_id;
        const discordMember = allMembers.get(link.discord_id)!;
        const expected = [c.member_role_id,
          clan.role !== "member" ? c.officer_role_id : null, clan.role === "leader" ? c.leader_role_id : null].filter((id): id is string => !!id);
        const wanted = desiredRoles(db.getGuildConfigs(i.guildId), profile.clans);
        const mismatch = expected.some((id) => !discordMember.roles.cache.has(id)) ||
          managedRoles([c]).some((id) => discordMember.roles.cache.has(id) && !wanted.has(id));
        rows.push({ id: link.discord_id, name, line: `• <@${link.discord_id}> — ${profileLink(link.openfront_id, name)} · ${clan.role}${mismatch ? " · roles need sync" : ""}` });
      } catch { unavailable++; }
    }
  }));
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const page = pageOf(rows, pageNumber(i), 15);
  await sendEmbeds(i, [new EmbedBuilder().setTitle(`Clan roster: [${c.clan_tag}]`).setColor(0x3b82f6)
    .setDescription(page.items.map((row) => row.line).join("\n") || (unavailable ? "Profiles could not all be checked; the roster may be incomplete." : "No linked clan members were found in this server."))
    .setFooter({ text: `${page.footer} · ${rows.length} member(s)${unavailable ? ` · ${unavailable} profile(s) unavailable` : ""}` })]);
}

async function audit(i: GuildCommand) {
  const target = i.options.getUser("user");
  const ownHistory = target?.id === i.user.id;
  const entries = db.getAudit(i.guildId, target?.id ?? null, pageNumber(i), ownHistory);
  const lines = entries.map((entry) => {
    const epoch = toEpochSeconds(entry.created_at);
    const actor = /^\d+$/.test(entry.actor_id) ? `<@${entry.actor_id}>` : "Migration";
    return `• ${epoch !== null ? `<t:${epoch}:f>` : "Unknown date"} · **${label(entry.action.replaceAll("_", " "))}** · <@${entry.discord_id}> · by ${actor}` +
      (entry.old_id ? ` · ${label(entry.old_id)}` : "") + (entry.new_id ? ` → ${label(entry.new_id)}` : "");
  });
  await sendEmbeds(i, [new EmbedBuilder().setTitle(target ? `Link history: ${shortText(target.username, 80)}` : "Server link history")
    .setColor(0x3b82f6).setDescription(lines.join("\n") || "No link changes found on this page.")
    .setFooter({ text: `Page ${pageNumber(i)} · 10 entries per page` })]);
}

async function guildLink(i: GuildCommand) {
  const target = i.options.getUser("user", true);
  if (target.bot) throw new CommandError("Choose a human member to link.");
  const id = playerId(i.options.getString("openfront_id", true));
  await identityLocks.run(target.id, async () => {
    await member(i.guild, target.id);
    const profile = await openfrontApi.getPlayerProfile(id);
    if (!profile) throw new CommandError("That OpenFront profile was not found.");
    await requireClanAccess(i.guild, i.user.id);
    try { db.linkGuildUser(i.guildId, i.user.id, target.id, id, profile.username ?? null); }
    catch (error) { throw new CommandError(error instanceof Error ? error.message : "Could not create the server link."); }
    await i.editReply({ content: `Approved <@${target.id}> as ${profileLink(id, profile.username || id)} in this server. Role updates are queued. The member can verify a bot-wide identity with \`/link\`.` });
  });
}

async function guildUnlink(i: GuildCommand) {
  const target = i.options.getUser("user", true);
  await identityLocks.run(target.id, async () => {
    await requireClanAccess(i.guild, i.user.id);
    if (db.getUserByDiscordId(target.id)) throw new CommandError("This member has a verified bot-wide identity. Only they can remove it with `/unlink`.");
    const removed = db.unlinkGuildUser(i.guildId, i.user.id, target.id);
    await i.editReply({ content: removed ? `Removed <@${target.id}>'s approval in this server. Role cleanup is queued.` : "This member has no server-only link to remove." });
  });
}
