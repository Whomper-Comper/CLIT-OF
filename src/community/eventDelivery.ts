import type { Client, Guild } from "discord.js";
import type { BotDatabase } from "../db.js";
import type { CommunityTick, DeliveryJob, PreparedDelivery } from "./types.js";
import { CommunityBudgetExhaustedError } from "./types.js";
import type { CommunityService } from "./service.js";
import { renderEvent, safe } from "../commands/eventViews.js";
export async function prepareEventDelivery(job: DeliveryJob, guild: Guild, db: BotDatabase, now: number, tick?: CommunityTick): Promise<PreparedDelivery | null> {
  const store = db.community.events;
  const current = () => {
    const event = store.get(job.guildId, job.subjectId);
    if (!event || guild.id !== event.guildId || event.channelId !== job.channelId || event.revision !== job.revision) {
      return null;
    }
    return event;
  };
  let event = current();
  if (!event) {
    return null;
  }
  if (job.kind === 'event_reminder') {
    if (event.status !== 'scheduled' || !event.messageId || !event.reminderMinutes || event.startAt <= now) {
      return null;
    }
    const candidates = store.reminderRecipients(job).filter(id => /^\d{17,20}$/.test(id));
    if (!candidates.length) {
      return null;
    }
    if (tick && !tick.takeRequest()) {
      throw new CommunityBudgetExhaustedError('Event membership budget exhausted.');
    }
    // An array requests these members from Discord, bypassing single-member cache reads.
    const members = await guild.members.fetch({ user: candidates, withPresences: false });
    event = current();
    const checkedAt = tick?.currentTime?.() ?? now;
    if (!event || event.status !== 'scheduled' || event.startAt <= checkedAt) {
      return null;
    }
    const users = store.reminderRecipients(job).filter(id => members.has(id) && !members.get(id)!.user.bot);
    if (!users.length) {
      return null;
    }
    return {
      payload: {
        content: `**${safe(event.title)}** starts <t:${Math.floor(event.startAt / 1000)}:R>.\n${users.map(id => `<@${id}>`).join(' ')}`,
        allowedMentions: {
          parse: [],
          users,
          roles: [],
          repliedUser: false
        },
      }
    };
  }
  if (job.kind === 'event_publish') {
    if (event.status !== 'draft' || event.messageId || event.startAt <= now) {
      return null;
    }
    return { payload: renderEvent({ ...event, status: 'scheduled' }, store.participants(job.guildId, event.id), 1, now) };
  }
  if (job.kind !== 'event_update' || !event.messageId) {
    return null;
  }
  return { messageId: event.messageId, payload: renderEvent(event, store.participants(job.guildId, event.id), 1, now) };
}
export function registerEventWork(service: CommunityService, client: Client, db: BotDatabase): void {
  for (const kind of ['event_publish', 'event_update', 'event_reminder']) {
    service.registerDelivery(kind, {
      requestBudget: kind === 'event_reminder' ? 3 : 0,

      async prepare(job, now = Date.now(), tick) {
        const guild = client.guilds.cache.get(job.guildId);
        if (!guild) {
          return null;
        }
        return prepareEventDelivery(job, guild, db, now, tick);
      },

      delivered(job, messageId) {
        if (job.kind === 'event_publish') {
          db.community.events.publish(job.guildId, job.subjectId, job.revision, messageId);
        }
      },
    });
  }
  let guildOffset = 0;
  service.registerTask('events', async (tick) => {
    const guilds = [...client.guilds.cache.values()];
    if (!guilds.length) {
      return;
    }
    const offset = guildOffset % guilds.length;
    const count = Math.min(8, guilds.length);
    guildOffset = (offset + count) % guilds.length;
    for (let n = 0; n < count && !tick.stopping();n++) {
      const guild = guilds[(offset + n) % guilds.length];
      const store = db.community.events;
      const clock = () => tick.currentTime?.() ?? tick.now;
      store.maintain(guild.id, clock());
      const due = store.promotionDue(guild.id, 20).filter(e => e.startAt > clock());
      if (due.length && tick.takeRequest()) {
        try {
          const roster = await guild.members.fetch({ withPresences: false });
          const members = new Set([...roster.values()].filter(m => !m.user.bot).map(m => m.id));
          for (const old of due) {
            const event = store.get(guild.id, old.id);
            if (tick.stopping()) {
              return;
            }
            if (!event || event.revision !== old.revision || event.status !== 'scheduled' || event.startAt <= clock()) {
              continue;
            }
            store.promote(guild.id, event.id, members, clock());
          }
        } catch (error) {
          console.warn('[Community] Event promotion deferred:', error instanceof Error ? error.message : 'Membership lookup failed.');
        }
      }
      for (const event of store.reminderDue(guild.id, clock())) {
        store.queueReminders(guild.id, event.id, event.revision, clock());
      }
    }
  });
}
