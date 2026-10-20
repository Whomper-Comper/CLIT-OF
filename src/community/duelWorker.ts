import type { Client } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { renderClosedDuel, renderDuel } from '../commands/duelViews.js';
import type { CommunityService } from './service.js';
import type { DeliveryJob } from './types.js';

export function registerDuelWork(service: CommunityService, _client: Client, db: BotDatabase): void {
  service.registerTask('duel-expiry', async tick => { db.community.duels.expire(tick.now); });
  for (const kind of ['duel_publish', 'duel_update']) {
    const prepare = (job: DeliveryJob, now: number, activate = false) => {
      let duel = db.community.duels.expireInvitation(job.guildId, job.subjectId, now);
      if (duel) {
        if (duel.channelId !== job.channelId) return null;
        if (kind === 'duel_update' && (duel.revision !== job.revision || !duel.messageId)) return null;
        // Keep uncertain publications recoverable after expiry. Only the final request
        // boundary rejects a fresh send; ordinary prepare must still permit marker binding.
        if (activate && kind === 'duel_publish' && !duel.messageId && duel.status !== 'pending') return null;
        if (activate && kind === 'duel_update' && duel.messageId && duel.status === 'pending') {
          duel = db.community.duels.activate(duel.guildId, duel.id, duel.channelId, duel.messageId, now);
          if (!duel || duel.revision !== job.revision) return null;
        }
        return { payload: renderDuel(duel), messageId: duel.messageId ?? undefined };
      }
      const closure = db.community.duels.closure(job.guildId, job.subjectId);
      if (!closure || closure.channelId !== job.channelId) return null;
      // An accepted-but-unbound post can outlive its participant consent. Reconciliation
      // may bind its generic closure, but an unbound closure can never be freshly posted.
      if (!closure.messageId && (kind !== 'duel_publish' || activate)) return null;
      if (kind === 'duel_update' && closure.revision !== job.revision) return null;
      return { payload: renderClosedDuel(), messageId: closure.messageId ?? undefined };
    };
    service.registerDelivery(kind, {
      async prepare(job, now = Date.now()) { return prepare(job, now); },
      beforeDeliver(job, now) { return prepare(job, now, true); },
      delivered(job, messageId) {
        if (kind !== 'duel_publish') return;
        // Departure can race an already-started public send. Bind only its generic closure.
        db.community.duels.bindPublication(job.guildId, job.subjectId, job.channelId, messageId, job.dueAt);
      },
    });
  }
}
