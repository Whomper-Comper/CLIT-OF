import type { Client, Guild } from 'discord.js';
import type { BotDatabase } from '../db.js';
import { CommandError } from '../commandError.js';
import type { BingoBoard } from './bingo.js';
import { bingoLineCells, renderBingoBoard, type BingoViewState } from '../commands/bingoViews.js';
import type { CommunityService } from './service.js';
import { CommunityBudgetExhaustedError, type CommunityTick, type DeliveryJob, type IdentityBinding, type PreparedDelivery } from './types.js';

/** The only asynchronous boundary: refresh the complete human roster, then reread local eligibility. */
export async function syncBingoInventory(guild: Guild, db: BotDatabase, tick?: CommunityTick) {
  if (tick && !tick.takeRequest()) throw new CommunityBudgetExhaustedError('Bingo membership validation waits for the next tick.');
  const roster = await guild.members.fetch({ withPresences: false });
  if (tick?.stopping()) throw new CommunityBudgetExhaustedError('Bingo service is stopping.');
  const members = new Set([...roster.values()].filter(member => !member.user.bot).map(member => member.id));
  const identities = new Map<string, IdentityBinding>();
  for (const link of db.getEffectiveLinks(guild.id)) {
    if (members.has(link.discord_id) && !db.history.isDeleted(link.openfront_id)) {
      identities.set(link.discord_id, { guildId: guild.id, discordId: link.discord_id, publicId: link.openfront_id, linkedAt: link.linked_at });
    }
  }
  const tags = new Set(db.getGuildConfigs(guild.id).map(config => config.clan_tag.trim().toUpperCase()));
  db.community.bingo.syncEvidenceEligibility(guild.id, [...identities.values()], members, tags);
  return { roster, members, identities, tags };
}
export function bingoViewState(db: BotDatabase, board: BingoBoard, now: number): BingoViewState {
  const store = db.community.bingo;
  const state = store.gameEvidenceState(board.guildId, now);
  const ready = !store.needsEvidenceRefresh(board.guildId, board.id, now);
  let label = state.status === 'disabled' ? 'Game collection disabled · Manual claims available' : state.status === 'unavailable'
    ? 'Game verification unavailable · Manual claims available' : 'Observed retained games · Coverage may be incomplete';
  if (state.status === 'observed') {
    const start = new Date(Math.max(board.createdAt, state.retentionStart)).toISOString();
    const end = new Date(Math.min(board.closesAt ?? now, now)).toISOString();
    const links = db.getEffectiveLinks(board.guildId);
    // Coverage diagnostics are conservative and bounded even in a very large guild.
    const complete = links.length > 0 && links.length <= 20 && links.every(link =>
      db.history.getPlayerCoverage(board.guildId, link.openfront_id, start, end).complete);
    label = complete ? 'Observed retained games · Covered collection window' : 'Observed retained games · Incomplete coverage';
  }
  if (!ready) label += ' · Refreshing automatic progress';
  label += ` · ${state.retentionDays}-day retention`;
  return { ready, label, pending: store.pendingCells(board.guildId, board.id) };
}
export function queueBingoUpdate(db: BotDatabase, board: BingoBoard, now: number, view?: BingoViewState): void {
  const payload = renderBingoBoard(board, view ?? bingoViewState(db, board, now));
  db.community.bingo.queueUpdate(board.guildId, board.id, JSON.stringify(payload), now);
}
export async function prepareBingoDelivery(job: DeliveryJob, guild: Guild, db: BotDatabase, now: number, tick?: CommunityTick): Promise<PreparedDelivery | null> {
  const store = db.community.bingo;
  const clock = () => tick?.currentTime?.() ?? now;
  const current = () => {
    const board = store.get(job.guildId, job.subjectId);
    return board && board.status !== 'archived' && board.guildId === guild.id && board.channelId === job.channelId && board.revision === job.revision ? board : null;
  };
  if (!current()) return null;
  // Capture before the await. Only fresh local state is used afterward; never finalize this snapshot.
  const captured = current()!;
  let membershipUnavailable = false;
  try { await syncBingoInventory(guild, db, tick); }
  catch (error) {
    if (error instanceof CommunityBudgetExhaustedError) throw error;
    membershipUnavailable = true;
  }
  const board = current();
  if (!board || board.messageId !== captured.messageId || board.status !== captured.status) return null;
  const state = membershipUnavailable
    ? { ready: false, label: `Current membership unavailable · Manual claims available · ${store.gameEvidenceState(board.guildId, clock()).retentionDays}-day retention`, pending: store.pendingCells(board.guildId, board.id) }
    : bingoViewState(db, board, clock());
  if (job.kind === 'bingo_complete') {
    if (board.status !== 'active' || !board.messageId) return null;
    const cells = bingoLineCells(job.part);
    if (!cells.length) return null;
    if (!state.ready && cells.some(index => board.cells[index].objective && board.cells[index].objective!.kind !== 'manual')) {
      if (membershipUnavailable) throw new CommunityBudgetExhaustedError('Bingo membership is unavailable. Completion waits for fresh validation.');
      throw new CommunityBudgetExhaustedError('Bingo line awaits a complete fresh evidence generation.');
    }
    if (!cells.every(index => board.cells[index].complete)) return null;
    return { payload: { content: job.part === 12 ? '🎉 Shared bingo board complete!' : '🎉 A shared bingo line is complete!',
      embeds: renderBingoBoard(board, state).embeds, allowedMentions: { parse: [] } } };
  }
  if (job.kind === 'bingo_publish') {
    if (board.status !== 'draft' || board.messageId || store.getActive(board.guildId)) return null;
    return { payload: { ...renderBingoBoard(board, state), allowedMentions: { parse: [] } } };
  }
  if (job.kind !== 'bingo_update' || board.status !== 'active' || !board.messageId) return null;
  return { messageId: board.messageId, payload: { ...renderBingoBoard(board, state), allowedMentions: { parse: [] } } };
}
export function registerBingoWork(service: CommunityService, client: Client, db: BotDatabase): void {
  const stages = new Map<string, { id: string; guildId: string }>();
  service.registerStopHandler('bingo', () => stages.clear());
  const store = db.community.bingo;
  for (const kind of ['bingo_publish', 'bingo_update', 'bingo_complete']) {
    service.registerDelivery(kind, {
      requestBudget: 3,
      async prepare(job, now = Date.now(), tick) {
        const guild = client.guilds.cache.get(job.guildId);
        return guild ? prepareBingoDelivery(job, guild, db, now, tick) : null;
      },
      delivered(job, messageId) {
        if (job.kind === 'bingo_publish') store.publish(job.guildId, job.subjectId, job.revision, messageId);
      },
    });
  }
  let after = '';
  service.registerTask('bingo', async tick => {
    const clock = () => tick.currentTime?.() ?? tick.now;
    const check: [string, { id: string; guildId: string }][] = [];
    for (const entry of stages) {
      check.push(entry);
      if (check.length === 4) break;
    }
    // Bounded rotating cleanup also drops continuations for archived/removed boards.
    for (const [id, stage] of check) {
      stages.delete(id);
      if (store.get(stage.guildId, id)?.status === 'active') stages.set(id, stage);
    }
    // Four boards maximum, one <=200-row persisted page each. Advance only after visiting a board.
    let boards = store.activeBoards(after, 4);
    if (!boards.length) boards = store.activeBoards('', 4);
    for (const expected of boards) {
      if (tick.stopping()) { stages.clear(); return; }
      const guild = client.guilds.cache.get(expected.guildId);
      if (!guild) { after = expected.id; stages.delete(expected.id); continue; }
      // Capture source before membership await; a changed inventory requires a new snapshot below.
      const snapshot = store.evidenceSnapshot(expected.guildId, expected.id, clock());
      let inventory: Awaited<ReturnType<typeof syncBingoInventory>>;
      try { inventory = await syncBingoInventory(guild, db, tick); }
      catch (error) {
        if (error instanceof CommunityBudgetExhaustedError) {
          if (tick.stopping()) stages.clear();
          return;
        }
        after = expected.id;
        const current = store.get(expected.guildId, expected.id);
        if (current?.status === 'active') queueBingoUpdate(db, current, clock(), { ready: false,
          label: `Current membership unavailable · Manual claims available · ${store.gameEvidenceState(current.guildId, clock()).retentionDays}-day retention`,
          pending: store.pendingCells(current.guildId, current.id) });
        continue;
      }
      after = expected.id;
      const board = store.get(expected.guildId, expected.id);
      if (!board || board.status !== 'active' || board.revision !== expected.revision || board.messageId !== expected.messageId) {
        stages.delete(expected.id);
        continue;
      }
      if (store.needsEvidenceRefresh(board.guildId, board.id, clock())) {
        try {
          let stage = stages.get(board.id)?.id;
          if (!stage) {
            const fresh = store.evidenceSnapshot(board.guildId, board.id, clock());
            stage = store.beginEvidenceStage(fresh.version === snapshot.version ? snapshot : fresh, clock());
            stages.set(board.id, { id: stage, guildId: board.guildId });
          }
          const page = store.stageEvidencePage(stage, inventory.identities, inventory.tags, inventory.members, clock());
          if (page.phase === 'ready') {
            store.finalizeEvidenceStage(stage, clock());
            stages.delete(board.id);
          }
        } catch (error) {
          stages.delete(board.id);
          if (!(error instanceof CommandError)) throw error;
        }
      } else stages.delete(board.id);
      queueBingoUpdate(db, store.get(board.guildId, board.id)!, clock());
    }
  });
}
