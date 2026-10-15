import { ChatInputCommandInteraction, EmbedBuilder, escapeMarkdown, MessageFlags } from "discord.js";
import { CommandLimits, MemberLocks } from "../queues.js";
import { resolveOpenFrontId, extractDiscordId } from "../utils.js";

export class CommandError extends Error {}
export const privateReply = { flags: MessageFlags.Ephemeral } as const;
export const identityLocks = new MemberLocks();
const limits = new CommandLimits();

export function throttle(key: string, milliseconds = 10_000) {
  if (!limits.take(key, milliseconds)) throw new CommandError("Please wait a few seconds before trying that command again.");
}

export function playerId(input: string): string {
  const id = resolveOpenFrontId(input);
  if (!id || extractDiscordId(id)) throw new CommandError("Enter an OpenFront public ID or player profile URL, such as `HabCsQYR` or `https://openfront.io/player/HabCsQYR`.");
  return id;
}

export const shortText = (value: string, length = 100) => value.length > length ? value.slice(0, length - 1) + "…" : value;
export const label = (value: string) => escapeMarkdown(shortText(value, 80)).replace(/[\r\n]/g, " ");
export const profileLink = (id: string, name = id) => `[${label(name)}](https://openfront.io/player/${encodeURIComponent(id)})`;

export function pageOf<T>(items: T[], page: number, size: number): { items: T[]; footer: string } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new CommandError(`Choose a page from 1 to ${pages}.`);
  return { items: items.slice((page - 1) * size, page * size), footer: `Page ${page}/${pages}` };
}

export async function sendEmbeds(interaction: ChatInputCommandInteraction, embeds: EmbedBuilder[]) {
  await interaction.editReply({ embeds, allowedMentions: { parse: [] } });
}
