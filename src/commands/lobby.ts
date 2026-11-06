import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from "discord.js";
import { db, type BotDatabase } from "../db.js";
import { requireConfigAccess } from "../access.js";
import { CommandError, privateReply } from "./support.js";
import { CATEGORIES, MAPS, MODES, lobbyFeed } from "../lobby/feed.js";
import { normalize } from "../lobby/model.js";
import { actionOption, commandAction, type CommandActions } from './actions.js';

const FILTERS = ['map', 'mode', 'category', 'min_players', 'max_players'] as const;
const ACTIONS = {
  watch: { required: ['name'], optional: FILTERS },
  list: { optional: ['page'] },
  remove: { required: ['id'] },
  resume: {}, stop: {},
  configure: { optional: ['enabled', 'channel'] },
} satisfies CommandActions;
export function createLobbyCommand(
  database: BotDatabase = db,
  options: { now?: () => number; feed?: { status: string } } = {},
) {
  const store = database.community.lobbies,
    now = options.now ?? Date.now,
    feed = options.feed ?? lobbyFeed;
  const maps = MAPS as string[];
  const canonical = (value: string | null, values: string[], name: string) => {
    if (value === null) return undefined;
    const found = values.find((v) => normalize(v) === normalize(value));
    if (!found)
      throw new CommandError(
        `Choose a supported ${name} from the command suggestions.`,
      );
    return found;
  };
  return {
    data: new SlashCommandBuilder().setName('lobby').setDescription('Get DMs when an OpenFront lobby matches your preferences')
      .setContexts(InteractionContextType.Guild)
      .addStringOption(actionOption(ACTIONS))
      .addStringOption(o => o.setName('name').setDescription('Watch: a name for this saved filter').setMaxLength(60))
      .addStringOption(o => o.setName('map').setDescription('Watch: exact OpenFront map').setAutocomplete(true).setMaxLength(100))
      .addStringOption(o => o.setName('mode').setDescription('Watch: game mode').addChoices(...MODES.map(value => ({ name: value, value }))))
      .addStringOption(o => o.setName('category').setDescription('Watch: public lobby category').addChoices(...CATEGORIES.map(value => ({ name: value, value }))))
      .addIntegerOption(o => o.setName('min_players').setDescription('Watch: minimum connected players (not lobby capacity)').setMinValue(0).setMaxValue(1000))
      .addIntegerOption(o => o.setName('max_players').setDescription('Watch: maximum connected players (not lobby capacity)').setMinValue(0).setMaxValue(1000))
      .addIntegerOption(o => o.setName('page').setDescription('List: page of saved filters (five per page)').setMinValue(1).setMaxValue(2))
      .addStringOption(o => o.setName('id').setDescription('Remove: rule ID from /lobby action:list').setMaxLength(64))
      .addBooleanOption(o => o.setName('enabled').setDescription('Configure: enable or disable lobby alerts for this server'))
      .addChannelOption(o => o.setName('channel').setDescription('Configure: fallback channel when a DM is blocked').addChannelTypes(ChannelType.GuildText)),
    async autocomplete(i: AutocompleteInteraction): Promise<void> {
      const focused = i.options.getFocused(true);
      const result =
        focused.name === "map"
          ? maps
              .filter((m) =>
                normalize(m).includes(normalize(String(focused.value))),
              )
              .slice(0, 25)
              .map((value) => ({ name: value, value }))
          : [];
      await i.respond(result);
    },
    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId)
        throw new CommandError("Use /lobby in a server.");
      const sub = commandAction(i.options, ACTIONS),
        guild = i.guildId,
        user = i.user.id;
      if (sub === 'watch' && FILTERS.every(name => i.options.get(name)?.value == null)) {
        throw new CommandError('Choose at least one lobby filter: map, mode, category or player count.');
      }
      const reply = (content: string) =>
        i.reply({ content, ...privateReply, allowedMentions: { parse: [] } });
      if (sub === "configure") {
        await i.deferReply(privateReply);
        await requireConfigAccess(i.guild, user, database);
        const enabled = i.options.getBoolean("enabled"),
          target = i.options.getChannel("channel"),
          current = store.settings(guild);
        if (enabled === null && !target) {
          const jobs = store.diagnostics(guild);
          await i.editReply({
            content:
              `Lobby alerts: **${current.enabled ? "enabled" : "disabled"}**\nFallback: ${current.channel ? `<#${current.channel}>` : "not configured"}\nFeed: ${feed.status}\n` +
              (jobs.length
                ? jobs
                    .map(
                      (n) =>
                        `Needs review \`${n.id}\`: ${n.error ?? "Delivery interrupted"}`,
                    )
                    .join("\n")
                : "No delivery diagnostics need review."),
            allowedMentions: { parse: [] },
          });
          return;
        }
        const channelId = target?.id ?? current.channel;
        if (channelId && enabled !== false) {
          const channel = await i.guild.channels.fetch(channelId);
          const me = i.guild.members.me ?? (await i.guild.members.fetchMe());
          const required = [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ];
          if (
            !channel ||
            channel.type !== ChannelType.GuildText ||
            !channel.permissionsFor(me)?.has(required)
          )
            throw new CommandError(
              "Choose a server text channel where the bot can View Channel, Send Messages, Embed Links and Read Message History.",
            );
        }
        await requireConfigAccess(i.guild, user, database);
        // Read the revision again after lookups: avoid replacing another manager's settings.
        if (store.settings(guild).revision !== current.revision)
          throw new CommandError(
            "Lobby settings changed. Reopen /lobby action:configure.",
          );
        const saved = store.configure(
          guild,
          enabled ?? current.enabled,
          channelId,
          now(),
        );
        await i.editReply({
          content: `Lobby alerts ${saved.enabled ? "enabled" : "disabled"}. Fallback channel: ${saved.channel ? `<#${saved.channel}>` : "not configured"}. Existing searches stopped; members can use /lobby action:resume.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      store.expire(now());
      if (sub === "watch") {
        const rule = store.watch(
          guild,
          user,
          {
            name: i.options.getString("name", true),
            map: canonical(i.options.getString("map"), maps, "map"),
            mode: canonical(i.options.getString("mode"), MODES, "mode"),
            category: canonical(
              i.options.getString("category"),
              CATEGORIES,
              "category",
            ),
            min: i.options.getInteger("min_players") ?? undefined,
            max: i.options.getInteger("max_players") ?? undefined,
          },
          now(),
        );
        await reply(
          `Saved **${escapeMarkdown(rule.name!)}** and started searching. I'll DM you first; blocked DMs cause a public fallback ping in the configured channel. Each alert gives you 3 minutes to click Continue searching, otherwise searching stops. Use /lobby action:list to see your filters.`,
        );
        return;
      }
      if (sub === "list") {
        const all = store.rules(guild, user),
          page = i.options.getInteger("page") ?? 1,
          search = store.search(guild, user);
        const pages = Math.max(1, Math.ceil(all.length / 5));
        if (!Number.isInteger(page) || page < 1 || page > pages)
          throw new CommandError(`Choose a page from 1 to ${pages}.`);
        const rules = all.slice((page - 1) * 5, page * 5);
        await reply(
          `Search: **${search?.state ?? "stopped"}**${search?.deadline ? ` · respond before <t:${Math.floor(search.deadline / 1000)}:R>` : ""}\nFeed: ${feed.status}\n\n` +
            (rules
              .map(
                (r) =>
                  `**${escapeMarkdown(r.name!)}** — ${[
                    r.map,
                    r.mode,
                    r.category,
                    r.min === undefined ? null : `at least ${r.min} players`,
                    r.max === undefined ? null : `at most ${r.max} players`,
                  ]
                    .filter(Boolean)
                    .map((x) => escapeMarkdown(String(x)))
                    .join(" · ")}\n\`${r.id}\``,
              )
              .join("\n\n") || "No saved filters. Use /lobby action:watch.") +
            `\n\nPage ${page}/${pages}. Counts mean currently connected players. /lobby action:resume restarts; /lobby action:stop stops.`,
        );
        return;
      }
      if (sub === "remove") {
        store.remove(guild, user, i.options.getString("id", true), now());
        await reply(
          "Filter removed. Your search keeps its current state. Use /lobby action:resume if you want to restart searching.",
        );
        return;
      }
      if (sub === "stop") {
        store.stop(guild, user, now());
        await reply(
          "Searching stopped. Your saved filters remain; use /lobby action:resume to restart.",
        );
        return;
      }
      if (sub === "resume") {
        store.resume(guild, user, now());
        await reply(
          "Searching resumed. Each alert requires Continue searching within 3 minutes. Blocked DMs cause a fallback server ping.",
        );
        return;
      }
      throw new CommandError(
        "Unknown lobby action. Refresh the command and try again.",
      );
    },
    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!("customId" in i) || !i.customId.startsWith("lobby:")) return false;
      if (!i.isButton())
        throw new CommandError(
          "This lobby alert control is invalid. Use /lobby action:resume in the server.",
        );
      const match = /^lobby:continue:([a-f0-9-]{36})$/.exec(i.customId);
      if (!match)
        throw new CommandError(
          "This lobby alert control is invalid. Use /lobby action:resume in the server.",
        );
      const n = store.notification(match[1]);
      if (!n || n.user !== i.user.id)
        throw new CommandError("This lobby alert does not belong to you.");
      if (
        (i.guildId !== null && i.guildId !== n.guild) ||
        i.channelId !== n.channel ||
        i.message.id !== n.message
      )
        throw new CommandError("This is not the delivered alert message.");
      await i.deferReply(privateReply);
      const guild = i.client.guilds.cache.get(n.guild);
      if (!guild)
        throw new CommandError("The alert server is no longer available.");
      try {
        await guild.members.fetch({ user: i.user.id, force: true });
      } catch {
        throw new CommandError(
          "Your current server membership could not be confirmed.",
        );
      }
      store.continue(n.id, i.user.id, i.channelId, i.message.id, now());
      await i.editReply({
        content:
          "Searching continues with your saved filters. The next alert will give you another 3-minute response window.",
        allowedMentions: { parse: [] },
      });
      // State checks, not the visual button, enforce single use across restarts.
      try {
        await i.message.edit({ components: [] });
      } catch {
        /* Durable state already invalidates the old button. */
      }
      return true;
    },
  };
}
export const lobbyCommand = createLobbyCommand();
