import type { Guild } from "discord.js";
import { openfrontApi } from "../api.js";
import type { ClanSyncService } from "../clanSync.js";
import { db } from "../db.js";
import { CommandError } from "./support.js";

const activeGuilds = new Set<string>();
const maxClans = 10;

function parseTags(input: string): string[] {
  const tags = [...new Set(input.toUpperCase().split(/[,\s]+/).filter(Boolean))];
  if (tags.some(tag => !/^[A-Z0-9]{2,5}$/.test(tag))) {
    throw new CommandError("Use clan tags of 2–5 letters or digits, separated by commas or spaces.");
  }
  return tags;
}

export async function runClanAutosync(guild: Guild, include: string, exclude: string, sync: ClanSyncService, authorize: () => Promise<void>): Promise<string> {
  const saved = new Map(db.getGuildConfigs(guild.id).map(config => [config.clan_tag, config]));
  const omitted = new Set(parseTags(exclude));
  const tags = (include.trim() ? parseTags(include) : [...saved.keys()]).filter(tag => !omitted.has(tag));
  if (!tags.length) throw new CommandError("Select at least one clan. Enter new clan tags explicitly.");
  if (tags.length > maxClans) throw new CommandError("Auto sync can run for up to 10 clans at once. Narrow the include list.");
  if (activeGuilds.has(guild.id)) throw new CommandError("Auto sync is already running in this server.");
  activeGuilds.add(guild.id);
  try {
    await authorize();
    for (const tag of tags) {
      if (!saved.has(tag) && !await openfrontApi.clanExists(tag)) {
        throw new CommandError(`OpenFront could not find [${tag}]. Check the tag and try again.`);
      }
    }
    const configs = [];
    for (const tag of tags) {
      configs.push(saved.get(tag) ?? await sync.createClanMemberMapping(guild, tag, authorize));
    }
    const results = await sync.syncGuildClans(guild, configs, authorize);
    return ["Auto sync finished. Only current server members with a bot link were checked.",
      ...results.map(({ config, results, error }) => {
        const added = results.reduce((sum, entry) => sum + entry.rolesAdded.length, 0);
        const removed = results.reduce((sum, entry) => sum + entry.rolesRemoved.length, 0);
        const failures = results.filter(entry => entry.error).length + Number(!!error);
        return `[${config.clan_tag}]: ${added} roles added, ${removed} removed, ${failures} failed checks.`;
      })].join("\n");
  } finally {
    activeGuilds.delete(guild.id);
  }
}
