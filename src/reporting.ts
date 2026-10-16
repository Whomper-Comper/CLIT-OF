import { ChannelType, EmbedBuilder, Guild, PermissionFlagsBits } from "discord.js";
import { db, GuildClanConfig } from "./db.js";
import { openfrontApi, OpenFrontPlayerProfile } from "./api.js";
import { clanDraft, draftErrors } from "./setupConfig.js";
import { toEpochSeconds } from "./utils.js";
import { CommandError, label, pageOf, shortText } from "./commands/support.js";

const percentage = (part: number, total: number) => total ? `${(part / total * 100).toFixed(1)}%` : "—";
const countLabel = (part: number, total: number) => `${part.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} (${percentage(part, total)})`;

export interface QueueHealth {
  pending: number; retrying: number; oldestAvailableAt: number | null; lastError: string | null;
}
export interface DoctorOptions {
  page?: number; accessRoleId?: string | null; jobs?: QueueHealth;
}

/** Counts are scoped to people in this server. A full clan roster requires OpenFront account authentication. */
export async function buildCoverageEmbeds(guild: Guild, configs: GuildClanConfig[], page = 1): Promise<EmbedBuilder[]> {
  const selected = pageOf(configs, page, 10);
  let members;
  try { members = await guild.members.fetch(); }
  catch { throw new CommandError("Could not load all server members to calculate link coverage. Please try again."); }
  const humans = [...members.values()].filter((member) => !member.user.bot);
  const links = db.getEffectiveLinks(guild.id).filter((link) => members.get(link.discord_id) && !members.get(link.discord_id)!.user.bot);
  const profiles: OpenFrontPlayerProfile[] = [];
  let unavailable = 0, checked = 0, next = 0;
  const deadline = Date.now() + 90_000;
  // A large guild must not create thousands of concurrent requests or exceed Discord's interaction lifetime.
  const work = links.slice(0, 250);
  await Promise.all(Array.from({ length: Math.min(5, work.length) }, async () => {
    while (Date.now() < deadline) {
      const index = next++;
      if (index >= work.length) return;
      checked++;
      try {
        const profile = await openfrontApi.getPlayerProfile(work[index].openfront_id);
        if (profile && Array.isArray(profile.clans)) profiles.push(profile);
        else unavailable++;
      } catch { unavailable++; }
    }
  }));
  const unexamined = links.length - checked;
  const partial = unavailable > 0 || unexamined > 0;
  const embed = new EmbedBuilder().setTitle("OpenFront link coverage").setColor(partial ? 0xf59e0b : 0x3b82f6)
    .setDescription("Counts use current human members of this Discord server. Bots are excluded.\nClan figures count confirmed current clan members linked here; people outside this Discord server are not checked.")
    .addFields({ name: "Discord Members Linked", value: countLabel(links.length, humans.length), inline: true },
      { name: "Discord Members Unlinked", value: (humans.length - links.length).toLocaleString("en-US"), inline: true },
      { name: "Current Clan Membership Checks", value: `${profiles.length} profiles checked successfully out of ${links.length} linked Discord members.${partial ? ` ${unavailable} unavailable; ${unexamined} not checked. Clan counts are partial.` : ""}` });
  if (!selected.items.length) embed.addFields({ name: "Clans", value: "No OpenFront clans are configured in this server." });
  for (const config of selected.items) {
    const linked = profiles.filter((profile) => profile.clans!.some((clan) => clan.tag.toUpperCase() === config.clan_tag.toUpperCase())).length;
    let total: number | null = null;
    let detail: string;
    try {
      const clan = await openfrontApi.getClanInfo(config.clan_tag);
      if (clan && Number.isSafeInteger(clan.memberCount) && clan.memberCount! >= 0) total = clan.memberCount!;
      detail = clan ? "OpenFront does not expose a public member list, so this is the minimum linked fraction of the full clan."
        : "The configured clan was not found on OpenFront.";
    } catch { detail = "OpenFront's total clan size is temporarily unavailable."; }
    const figures = total === null ? `${linked} confirmed linked here / total size unavailable`
      : linked > total ? `${linked} confirmed linked here / reported clan size ${total} (membership changed during the check)`
        : `At least ${countLabel(linked, total)} linked here`;
    embed.addFields({ name: `[${label(config.clan_tag)}] Clan Members Linked`, value: `${figures}\n${detail}` });
  }
  embed.setFooter({ text: `${selected.footer} · Public API results may be cached for up to 15 seconds.` });
  return [embed];
}

/** Read-only checks against refreshed Discord state and uncached OpenFront clan details. */
export async function buildDoctorEmbeds(guild: Guild, configs: GuildClanConfig[], options: DoctorOptions = {}): Promise<EmbedBuilder[]> {
  const selected = pageOf(configs, options.page ?? 1, 5);
  let roles, bot;
  try { [roles, bot] = await Promise.all([guild.roles.fetch(), guild.members.fetchMe()]); }
  catch { throw new CommandError("Could not refresh this server's roles and bot permissions. Please try again."); }
  const general: string[] = [];
  let problems = 0;
  const hasRolePermission = bot.permissions.has(PermissionFlagsBits.ManageRoles);
  general.push(hasRolePermission ? "✓ Bot has Manage Roles permission." : "✗ Bot is missing Manage Roles permission.");
  if (!hasRolePermission) problems++;
  if (!options.accessRoleId) { general.push("✗ Choose the role allowed to use clan commands in `/config` (Manage Server required)."); problems++; }
  else if (!roles.has(options.accessRoleId)) { general.push("✗ The config role was deleted. Someone with Manage Server can choose another in `/config`."); problems++; }
  else general.push(`✓ Clan command role: <@&${options.accessRoleId}>.`);
  if (options.jobs) {
    const jobs = options.jobs;
    general.push(`Role queue: ${jobs.pending} pending; ${jobs.retrying} retrying.`);
    if (jobs.retrying) problems++;
    if (jobs.oldestAvailableAt !== null && jobs.pending) {
      const stalled = jobs.oldestAvailableAt > 0 && Date.now() - jobs.oldestAvailableAt > 15 * 60_000;
      if (stalled) { general.push("⚠ A role job has been eligible for over 15 minutes. Check bot logs and role permissions."); problems++; }
    }
    if (jobs.lastError) general.push(`Latest queue error: ${label(shortText(jobs.lastError, 240))}`);
  }
  const embed = new EmbedBuilder().setTitle("Clan configuration health").setDescription(general.join("\n"));
  for (const config of selected.items) {
    const checks: string[] = [];
    const errors = draftErrors(clanDraft(config));
    for (const error of errors) checks.push(`✗ ${error}`);
    problems += errors.length;
    const mappings = [["Member", config.member_role_id], ["Officer", config.officer_role_id], ["Leader", config.leader_role_id], ["Approval", config.join_role_id]] as const;
    for (const [name, id] of mappings) {
      if (!id) continue;
      const role = roles.get(id);
      if (!role) { checks.push(`✗ ${name} role was deleted.`); problems++; }
      else if (id === guild.id || role.managed) { checks.push(`✗ ${name} role is an integration role or @everyone.`); problems++; }
      else if (name !== "Approval" && bot.roles.highest.comparePositionTo(role) <= 0) {
        checks.push(`✗ Move the bot's highest role above the ${name.toLowerCase()} role.`); problems++;
      } else checks.push(`✓ ${name} role is available.`);
    }
    if (config.log_channel_id) {
      try {
        const channel = await guild.channels.fetch(config.log_channel_id);
        if (!channel || channel.type !== ChannelType.GuildText) { checks.push("✗ The log channel was deleted or is not a server text channel."); problems++; }
        else if (!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
          checks.push("✗ The log channel needs View Channel, Send Messages and Embed Links permission."); problems++;
        } else checks.push("✓ Log channel is available and writable.");
      } catch { checks.push("✗ Could not check the log channel; check the bot's channel access."); problems++; }
    } else checks.push("ℹ No log channel is configured.");
    try {
      const clan = await openfrontApi.getClanInfo(config.clan_tag, { fresh: true });
      if (clan) checks.push("✓ OpenFront API is reachable and this clan exists.");
      else { checks.push("✗ This clan no longer exists on OpenFront."); problems++; }
    } catch { checks.push("✗ OpenFront API is temporarily unavailable or returned invalid clan information."); problems++; }
    const epoch = toEpochSeconds(config.last_sync_at);
    checks.push(epoch === null ? "ℹ No completed scheduled sync has been recorded." : `Last scheduled sync: <t:${epoch}:R>.`);
    if (epoch !== null && Date.now() - epoch * 1000 > Math.max(15, config.sync_interval_mins * 3) * 60_000) {
      checks.push("⚠ Scheduled sync is overdue. Check bot logs and OpenFront availability."); problems++;
    }
    embed.addFields({ name: `[${label(config.clan_tag)}]`, value: shortText(checks.join("\n"), 1024) });
  }
  if (!selected.items.length) embed.addFields({ name: "Clans", value: "No clans are configured. Open `/clan config` to add one; API availability cannot be checked until a clan is selected." });
  embed.setColor(problems ? 0xf59e0b : 0x22c55e).setFooter({ text: `${selected.footer} · ${problems} issue(s) found on this page. Checks do not change settings or roles.` });
  return [embed];
}
