import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type MessageCreateOptions,
} from "discord.js";
import { createHash } from "node:crypto";
import type { Notification } from "./store.js";
export function alertMessage(
  n: Notification,
  now: number | null,
  fallback: boolean,
): MessageCreateOptions {
  const l = n.lobby,
    deadline = now === null ? null : Math.floor((now + 180000) / 1000);
  const details = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Matching OpenFront lobby")
    .setDescription(
      `**${escapeMarkdown(l.map ?? "Unknown map")}** · ${escapeMarkdown(l.mode ?? "Unknown mode")}\n${l.players}/${l.capacity ?? "?"} current players · ${l.category}\n[Join lobby](https://openfront.io/game/${encodeURIComponent(l.id)})`,
    )
    .setFooter({ text: `Lobby alert ${n.id}` });
  if (l.startsAt)
    details.addFields({
      name: "Starts",
      value: `<t:${Math.floor(l.startsAt / 1000)}:R>`,
    });
  const content =
    (fallback
      ? `<@${n.user}>, a matching OpenFront lobby is available. I couldn't DM you. Enable direct messages from server members in this server's Privacy Settings to receive future lobby alerts privately.\n\n`
      : "") +
    `Want me to keep searching? Click **Continue searching** within **3 minutes**, otherwise I'll stop.${deadline === null ? "" : ` Deadline: <t:${deadline}:R>.`}\nUse /lobby action:resume in the server to restart later.`;
  return {
    content,
    embeds: [details],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`lobby:continue:${n.id}`)
          .setLabel("Continue searching")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
    allowedMentions: {
      parse: [],
      users: fallback ? [n.user] : [],
      roles: [],
      repliedUser: false,
    },
    nonce: BigInt(
      `0x${createHash("sha256")
        .update(n.id + (fallback ? ":fallback" : ":dm"))
        .digest("hex")
        .slice(0, 16)}`,
    ).toString(),
    enforceNonce: true,
  };
}
