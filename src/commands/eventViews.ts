import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { EventParticipants, EventRecord, EventSignup } from "../community/events.js";

export const safe = (value: string) => escapeMarkdown(value).replace(/@/g, '＠');
export const button = (id: string, label: string, disabled = false, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);

/** Compatibility for callers that already need a full signup list. Store-backed views pass a bounded page. */
function participantPage(signups: EventSignup[], requestedPage: number): EventParticipants {
  const page = Math.max(1, Math.min(Math.ceil(signups.length / 20) || 1, Math.floor(requestedPage) || 1));
  let confirmed = 0;
  const squadConfirmed: Record<string, number> = Object.create(null);
  for (const signup of signups) {
    if (signup.state !== 'confirmed') continue;
    confirmed++;
    if (signup.squadId !== null) squadConfirmed[signup.squadId] = (squadConfirmed[signup.squadId] ?? 0) + 1;
  }
  return { entries: signups.slice((page - 1) * 20, page * 20), total: signups.length, confirmed, squadConfirmed, page };
}

export function renderEvent(
  event: EventRecord, participants: EventSignup[] | EventParticipants, page = 1, now = Date.now(),
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  const data = Array.isArray(participants) ? participantPage(participants, page) : participants;
  const pages = Math.max(1, Math.ceil(data.total / 20));
  page = data.page;
  const closed = event.status !== 'scheduled' || event.startAt <= now;
  const embed = new EmbedBuilder()
    .setColor(event.status === 'cancelled' ? 0xed4245 : 0x5865f2)
    .setTitle(safe(event.title))
    .setDescription(safe(event.description) || 'Gather your team and join below.')
    .addFields(
      { name: 'When', value: `<t:${Math.floor(event.startAt / 1000)}:F> · <t:${Math.floor(event.startAt / 1000)}:R>\n${event.durationMinutes} minutes` },
      { name: 'Seats', value: `${data.confirmed}/${event.capacity} confirmed · ${data.total - data.confirmed} reserve · ${event.status}` },
    );
  if (event.squads.length) {
    embed.addFields({
      name: 'Squads',
      value: event.squads.map(squad =>
        `${safe(squad.name).slice(0, 30)} · ${data.squadConfirmed[squad.id] ?? 0}/${squad.capacity}`,
      ).join('\n'),
    });
  }
  if (event.settingsText) {
    embed.addFields({ name: 'Game settings', value: safe(event.settingsText).slice(0, 500) });
  }
  const squadNames = new Map(event.squads.map(squad => [squad.id, squad.name]));
  const visible = data.entries.map(signup => {
    const name = /^\d{17,20}$/.test(signup.discordId) ? `<@${signup.discordId}>` : safe(signup.discordId).slice(0, 30);
    const squad = signup.squadId ? ` · ${safe(squadNames.get(signup.squadId) ?? signup.squadId).slice(0, 30)}` : '';
    return `${signup.state === 'reserve' ? 'Reserve' : 'Confirmed'} · ${name}${squad}`;
  });
  // Separate fields keep each below Discord's 1024 character limit, even with long squad names.
  for (let n = 0; n < visible.length; n += 5) {
    embed.addFields({ name: n === 0 ? 'Participants' : 'Participants (continued)', value: visible.slice(n, n + 5).join('\n') });
  }
  const reminder = event.reminderMinutes ? ` (${event.reminderMinutes}m before)` : ' (off)';
  embed.setFooter({ text: `Event ${event.id} · Revision ${event.revision} · Page ${page}/${pages} · Reminders opt-in${reminder}` });
  const id = (action: string) => `event:${event.id}:${action}:${event.revision}:${page}`;
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(id('join'), 'Join', closed),
        button(id('withdraw'), 'Withdraw', closed),
        button(id('squad'), 'Choose squad', closed || !event.squads.length),
        button(id('reminder'), 'Reminder', closed || !event.reminderMinutes),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(id('previous'), 'Previous', page === 1),
        button(id('next'), 'Next', page === pages),
        button(id('refresh'), 'Refresh'),
      ),
    ],
  };
}
