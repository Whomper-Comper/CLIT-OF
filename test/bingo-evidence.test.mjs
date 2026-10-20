import test from 'node:test';
import assert from 'node:assert/strict';
import { communityFixture } from './helpers/community.mjs';
import { BingoStore, defaultBingoObjectives } from '../dist/community/bingo.js';
import { collectBingoEvidence } from '../dist/community/bingoEvidence.js';
const session = (at, gameId = 'game', extra = {}) => ({ public_id: 'p', discord_id: 'u', gameId, gameStart: new Date(at).toISOString(), gameEnd: new Date(at + 1000).toISOString(), gameType: 'Public', gameMode: 'Team', clanTag: 'MARS', hasWon: true, gameRankedType: 'Unranked', clientId: 'x', username: 'x', ...extra });
const identity = f => { const link = f.db.getEffectiveLink('g', 'u'); return { guildId: 'g', discordId: 'u', publicId: 'p', linkedAt: link.linked_at }; };
function setup(f) {
  f.db.linkUser('u', 'p', null, 'identity_token');
  f.db.setGuildClanConfig({ guild_id: 'g', clan_tag: 'MARS', member_role_id: 'member', officer_role_id: null,
    leader_role_id: null, join_role_id: null, log_channel_id: null, sync_interval_mins: 10, last_sync_at: null });
  const settings = f.db.history.getSettings('g');
  const { guild_id, revision, ...draft } = settings;
  f.db.history.saveSettings('g', { ...draft, collection_enabled: 1 }, revision);
  f.db.history.setMeta('deletions_last_success', new Date(f.now()).toISOString());
  const store = f.db.community.bingo;
  const board = store.createDraft('g', 'c', defaultBingoObjectives(), f.now() + 100_000, f.now());
  return { store, board: store.publish('g', board.id, board.revision, 'm') };
}
const saveAvailability = f => f.db.community.availability.save({ guildId: 'g', discordId: 'u', timezone: 'UTC', windows: [{ id: 'w', weekday: 1, startMinute: 60, endMinute: 120 }] }, 0, f.now());
function collect(f, board, matches, available = []) { return collectBingoEvidence(board, matches, available, new Map([['u', identity(f)]]), new Set(['MARS']), f.now() - 1000); }

test('collector excludes before creation, closure boundary, unfinished, FFA, private, wrong clan, stale identity and absent members', async () => {
  const f = communityFixture();
  try {
    const { board } = setup(f);
    const good = session(board.createdAt);
    const bad = [session(board.createdAt - 1), session(board.closesAt), session(board.createdAt, 'unfinished', { gameEnd: null }), session(board.createdAt, 'ffa', { gameMode: 'Free For All' }), session(board.createdAt, 'private', { gameType: 'Private' }), session(board.createdAt, 'wrong', { clanTag: 'OTHER' }), session(board.createdAt, 'stale', { public_id: 'old' }), session(board.createdAt, 'absent', { discord_id: 'absent' })];
    assert.equal(collect(f, board, [good, good, ...bad]).length, 1);
    assert.equal(collectBingoEvidence(board, [good], [], new Map(), new Set(['MARS']), 0).length, 0);
    assert.equal(collectBingoEvidence(board, [good], [], new Map([['u', identity(f)]]), new Set(['MARS']), board.createdAt + 1).length, 0);
    const availability = saveAvailability(f);
    assert.equal(collect(f, board, [], [availability, availability]).length, 1);
  } finally { await f.close(); }
});
test('canonical correction, history clear and availability clear recompute without removing manual approvals', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    const availability = saveAvailability(f);
    const evidence = collect(f, board, [match], [availability]);
    store.replaceEvidence('g', board.id, board.revision, evidence, undefined, f.now());
    store.setManualApproval('g', board.id, board.revision, 13, true, 'officer', 'Verified', f.now());
    assert.equal(store.refresh('g', board.id, f.now()).cells[3].progress, 1);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [{ ...match, hasWon: false }]);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [{ ...match, hasWon: false }], [availability]), undefined, f.now());
    assert.equal(store.refresh('g', board.id, f.now()).cells[3].progress, 0);
    f.db.history.clearGuildPlayerHistory('g');
    let current = store.get('g', board.id);
    assert.equal(current.cells[0].progress, 0);
    assert.equal(current.cells[11].progress, 1);
    assert.equal(current.cells[13].complete, true);
    f.db.community.availability.clear('g', 'u');
    current = store.get('g', board.id);
    assert.equal(current.cells[11].progress, 0);
    assert.equal(current.cells[13].complete, true);
    store.replaceEvidence('g', board.id, board.revision, evidence, undefined, f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(store.get('g', board.id).cells[11].progress, 0);
  } finally { await f.close(); }
});
test('captured refresh tokens reject privacy removal and retention boundaries; ordinary unlink preserves availability', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    const availability = saveAvailability(f);
    const evidence = collect(f, board, [match], [availability]);
    const token = store.evidenceSnapshot('g', board.id, f.now());
    store.replaceEvidence('g', board.id, board.revision, evidence, token, f.now());
    f.db.community.purgeIdentity('u');
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(store.get('g', board.id).cells[11].progress, 1);
    assert.throws(() => store.replaceEvidence('g', board.id, board.revision, evidence, token, f.now()));
    const later = store.evidenceSnapshot('g', board.id, f.now());
    assert.throws(() => store.replaceEvidence('g', board.id, board.revision, evidence, later, f.now() + 90 * 86_400_000 + 1));
    const departed = store.evidenceSnapshot('g', board.id, f.now());
    f.db.community.purgeMember('g', 'u');
    saveAvailability(f);
    assert.throws(() => store.replaceEvidence('g', board.id, board.revision, evidence, departed, f.now()));
  } finally { await f.close(); }
});
test('disabled collection and unhealthy deletion sync suppress game progress while manual objectives stay usable', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match]), undefined, f.now());
    f.db.history.setMeta('deletions_error', 'offline');
    assert.equal(store.refresh('g', board.id, f.now()).cells[0].progress, 0);
    assert.equal(store.gameEvidenceState('g', f.now()).status, 'unavailable');
    f.db.history.setMeta('deletions_error', '');
    const { guild_id, revision, ...draft } = f.db.history.getSettings('g');
    f.db.history.saveSettings('g', { ...draft, collection_enabled: 0 }, revision);
    assert.equal(store.gameEvidenceState('g', f.now()).status, 'disabled');
    store.setManualApproval('g', board.id, board.revision, 13, true, 'officer', 'Verified', f.now());
    assert.equal(store.get('g', board.id).cells[13].complete, true);
  } finally { await f.close(); }
});


test('unchanged evidence and refresh perform zero SQLite row writes; source pages are bounded and indexed', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const matches = Array.from({ length: 451 }, (_, i) => session(f.now() + i, String(i).padStart(4, '0')));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    const snapshot = store.evidenceSnapshot('g', board.id, f.now());
    let cursor = null;
    const observed = [];
    const sizes = [];
    do {
      const page = store.readGamePage(snapshot, cursor, 200, f.now());
      sizes.push(page.matches.length);
      observed.push(...page.matches);
      cursor = page.next;
    } while (cursor);
    assert.deepEqual(sizes, [200, 200, 51]);
    assert.equal(new Set(observed.map(m => m.gameId)).size, 451);
    const evidence = collect(f, board, observed);
    store.replaceEvidence('g', board.id, board.revision, evidence, snapshot, f.now());
    assert.equal(store.needsEvidenceRefresh('g', board.id, f.now()), false);
    const before = Number(f.db.db.prepare('SELECT total_changes() AS n').get().n);
    store.replaceEvidence('g', board.id, board.revision, evidence, snapshot, f.now());
    let historyPayloadReads = 0;
    const prepare = f.db.db.prepare.bind(f.db.db);
    f.db.db.prepare = sql => {
      if (sql.includes('payload FROM history_player_matches')) historyPayloadReads++;
      return prepare(sql);
    };
    store.refresh('g', board.id, f.now());
    assert.equal(historyPayloadReads, 0);
    f.db.db.prepare = prepare;
    const after = Number(f.db.db.prepare('SELECT total_changes() AS n').get().n);
    assert.equal(after - before, 0);
    const historyBefore = Number(f.db.db.prepare('SELECT total_changes() AS n').get().n);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    const historyAfter = Number(f.db.db.prepare('SELECT total_changes() AS n').get().n);
    assert.equal(historyAfter - historyBefore, 0);
    assert.equal(store.needsEvidenceRefresh('g', board.id, f.now()), false);
    const plan = f.db.db.prepare(`EXPLAIN QUERY PLAN SELECT public_id,discord_id,game_id,game_start,payload
      FROM history_player_matches WHERE guild_id=? AND game_start>=? AND game_start<?
      AND (game_start,public_id,game_id)>(?,?,?) ORDER BY game_start,public_id,game_id LIMIT ?`)
      .all('g', new Date(f.now()).toISOString(), new Date(board.closesAt).toISOString(), new Date(f.now()).toISOString(), 'p', '0000', 201);
    assert.ok(plan.some(row => row.detail.includes('history_bingo_page')));
    assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE') && !row.detail.startsWith('SCAN ')));
    const changed = { ...matches[0], hasWon: false };
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [changed]);
    assert.equal(store.needsEvidenceRefresh('g', board.id, f.now()), true);
    assert.throws(() => store.readGamePage(snapshot, null, 200, f.now()));
  } finally { await f.close(); }
});
test('retention expires observed appearances without SQL source mutation and then requires a new source scan', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match]), undefined, f.now());
    const later = f.now() + 90 * 86_400_000 + 1;
    f.db.history.setMeta('deletions_last_success', new Date(later).toISOString());
    assert.equal(store.needsEvidenceRefresh('g', board.id, later), true);
    assert.equal(store.refresh('g', board.id, later).cells[0].progress, 0);
    assert.equal(store.listEvidence('g', board.id).length, 0);
  } finally { await f.close(); }
});
test('account deletion removes games across guilds; guild removal and bounded archive retention erase their children', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match]), undefined, f.now());
    f.db.setGuildClanConfig({ ...f.db.getGuildConfigs('g')[0], guild_id: 'other' });
    const { guild_id: otherGuild, revision: otherRevision, ...otherSettings } = f.db.history.getSettings('other');
    f.db.history.saveSettings('other', { ...otherSettings, collection_enabled: 1 }, otherRevision);
    const otherDraft = store.createDraft('other', 'c2', defaultBingoObjectives(), null, f.now());
    const otherBoard = store.publish('other', otherDraft.id, otherDraft.revision, 'm2');
    f.db.history.upsertPlayerMatches('other', 'p', 'u', [match]);
    const otherEvidence = collectBingoEvidence(otherBoard, [match], [], new Map([['u', { ...identity(f), guildId: 'other' }]]), new Set(['MARS']), 0);
    store.replaceEvidence('other', otherBoard.id, otherBoard.revision, otherEvidence, undefined, f.now());
    assert.equal(store.get('other', otherBoard.id).cells[0].progress, 1);
    const token = store.evidenceSnapshot('g', board.id, f.now());
    f.db.history.purgePlayer('p');
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(store.get('other', otherBoard.id).cells[0].progress, 0);
    assert.throws(() => store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match]), token, f.now()));
    store.setManualApproval('g', board.id, board.revision, 13, true, 'officer', 'Verified', f.now());
    store.archive('g', board.id, board.revision, f.now());
    f.db.community.prune(f.now() + 90 * 86_400_000);
    assert.ok(store.get('g', board.id));
    f.db.community.prune(f.now() + 90 * 86_400_000 + 1);
    assert.equal(store.get('g', board.id), null);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_audit').get().n, 0);
    const other = store.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
    f.db.community.purgeGuild('g');
    assert.equal(store.get('g', other.id), null);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM community_bingo_sources WHERE guild_id='g'").get().n, 0);
    assert.ok(store.getActive('other'));
  } finally { await f.close(); }
});
test('unlinked current members can contribute availability, and old saved windows cannot predate board creation', async () => {
  const f = communityFixture();
  try {
    const { board } = setup(f);
    const available = saveAvailability(f);
    const members = new Set(['u']);
    assert.equal(collectBingoEvidence(board, [], [available], new Map(), new Set(), 0, members).length, 1);
    assert.equal(collectBingoEvidence(board, [], [{ ...available, updatedAt: board.createdAt - 1 }], new Map(), new Set(), 0, members).length, 0);
  } finally { await f.close(); }
});
test('canonical game evidence requires a configured clan tag even when a caller supplies a stale eligible snapshot', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now(), 'wrong', { clanTag: 'OTHER' });
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    const evidence = collectBingoEvidence(board, [match], [], new Map([['u', identity(f)]]), new Set(['OTHER']), 0);
    store.replaceEvidence('g', board.id, board.revision, evidence, undefined, f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
  } finally { await f.close(); }
});

test('history retention and collection disable immediately remove only game contributions', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    const available = saveAvailability(f);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match], [available]), undefined, f.now());
    f.db.history.retain('g', 14, f.now() + 15 * 86_400_000);
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(store.get('g', board.id).cells[11].progress, 1);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match], [available]), undefined, f.now());
    const { guild_id, revision, ...draft } = f.db.history.getSettings('g');
    f.db.history.saveSettings('g', { ...draft, collection_enabled: 0 }, revision);
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(store.get('g', board.id).cells[11].progress, 1);
  } finally { await f.close(); }
});

test('fresh member, effective-link and configured-clan inventories dirty sources only when they change', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    store.syncEvidenceEligibility('g', [identity(f)], ['u', 'unlinked'], ['MARS']);
    const first = store.evidenceSnapshot('g', board.id, f.now());
    store.replaceEvidence('g', board.id, board.revision, [], first, f.now());
    const before = Number(f.db.db.prepare('SELECT total_changes() AS n').get().n);
    store.syncEvidenceEligibility('g', [identity(f)], ['unlinked', 'u'], ['mars']);
    assert.equal(Number(f.db.db.prepare('SELECT total_changes() AS n').get().n) - before, 0);
    assert.equal(store.needsEvidenceRefresh('g', board.id, f.now()), false);
    store.syncEvidenceEligibility('g', [identity(f)], ['u'], ['MARS']);
    assert.throws(() => store.readGamePage(first, null, 200, f.now()));
    const second = store.evidenceSnapshot('g', board.id, f.now());
    store.syncEvidenceEligibility('g', [identity(f)], ['u'], ['OTHER']);
    assert.throws(() => store.readGamePage(second, null, 200, f.now()));
    const third = store.evidenceSnapshot('g', board.id, f.now());
    f.db.linkUser('u', 'p', null, 'identity_token');
    store.syncEvidenceEligibility('g', [identity(f)], ['u'], ['OTHER']);
    assert.throws(() => store.readGamePage(third, null, 200, f.now()));
  } finally { await f.close(); }
});

test('automatic win corrections and regain recompute a line without duplicate announcements', async () => {
  const f = communityFixture();
  try {
    const { store, board: original } = setup(f);
    store.archive('g', original.id, original.revision, f.now());
    const definitions = Array.from({ length: 24 }, (_, i) => ({ kind: 'manual', target: 1, label: String(i) }));
    definitions[4] = { kind: 'wins', target: 1, label: 'Win once' };
    const draft = store.createDraft('g', 'c', definitions, null, f.now());
    const board = store.publish('g', draft.id, draft.revision, 'm2');
    for (let index = 0; index < 4; index++) store.setManualApproval('g', board.id, board.revision, index, true, 'officer', 'Verified', f.now());
    const match = session(f.now());
    const apply = won => {
      f.db.history.upsertPlayerMatches('g', 'p', 'u', [{ ...match, hasWon: won }]);
      store.replaceEvidence('g', board.id, board.revision, collect(f, board, [{ ...match, hasWon: won }]), undefined, f.now());
    };
    apply(true);
    assert.deepEqual(store.getProgress('g', board.id).lines, ['row:0']);
    apply(false);
    assert.deepEqual(store.getProgress('g', board.id).lines, []);
    apply(true);
    assert.deepEqual(store.getProgress('g', board.id).lines, ['row:0']);
    f.db.community.purgeIdentity('u');
    assert.deepEqual(store.getProgress('g', board.id).lines, []);
    assert.equal(f.db.community.deliveries.list('g').filter(d => d.kind === 'bingo_complete' && d.subjectId === board.id).length, 1);
  } finally { await f.close(); }
});

test('archive pruning drains at most two hundred audit children per board per tick', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const insert = f.db.db.prepare(`INSERT INTO community_bingo_audit(board_id,cell_index,approved,actor_id,reason,at)
      VALUES(?,13,1,'officer','Verified',?)`);
    for (let i = 0; i < 451; i++) insert.run(board.id, f.now());
    store.archive('g', board.id, board.revision, f.now());
    const expired = f.now() + 90 * 86_400_000 + 1;
    const operations = [];
    const prepare = f.db.db.prepare.bind(f.db.db);
    f.db.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith('DELETE FROM community_deliveries') && sql.includes('subject_id=?')) {
        const run = statement.run.bind(statement);
        statement.run = (...args) => { operations.push({ sql, args }); return run(...args); };
      }
      return statement;
    };
    f.db.community.prune(expired);
    f.db.db.prepare = prepare;
    assert.equal(operations.length, 1);
    const plan = prepare(`EXPLAIN QUERY PLAN ${operations[0].sql}`).all(...operations[0].args);
    assert.ok(plan.some(row => row.detail.includes('community_delivery_subject')));
    assert.ok(plan.every(row => !row.detail.startsWith('SCAN community_deliveries')));
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_audit WHERE board_id=?').get(board.id).n, 251);
    assert.ok(store.get('g', board.id));
    f.db.community.prune(expired);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_audit WHERE board_id=?').get(board.id).n, 51);
    f.db.community.prune(expired);
    assert.equal(store.get('g', board.id), null);
  } finally { await f.close(); }
});

test('boards without a closing date page retained sessions correctly', async () => {
  const f = communityFixture();
  try {
    const { store, board: previous } = setup(f);
    store.archive('g', previous.id, previous.revision, f.now());
    const draft = store.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
    const board = store.publish('g', draft.id, draft.revision, 'open');
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [session(f.now())]);
    const snapshot = store.evidenceSnapshot('g', board.id, f.now());
    assert.equal(store.readGamePage(snapshot, null, 200, f.now()).matches.length, 1);
    assert.equal(snapshot.validUntil, f.now() + 90 * 86_400_000 + 1);
  } finally { await f.close(); }
});

test('manual approval refreshes unhealthy game observations before evaluating current lines', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match]), undefined, f.now());
    f.db.history.setMeta('deletions_error', 'offline');
    store.setManualApproval('g', board.id, board.revision, 13, true, 'officer', 'Verified', f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(store.get('g', board.id).cells[13].complete, true);
  } finally { await f.close(); }
});

test('guild purge removes sources after saved and tombstoned availability delete triggers', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    saveAvailability(f);
    f.db.community.availability.save({ guildId: 'g', discordId: 'cleared', timezone: 'UTC', windows: [] }, 0, f.now());
    f.db.community.availability.clear('g', 'cleared');
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    store.stageEvidencePage(stage, new Map(), new Set(), new Set(['u']), f.now());
    store.stageEvidencePage(stage, new Map(), new Set(), new Set(['u']), f.now());
    f.db.community.purgeGuild('g');
    assert.deepEqual(f.db.db.prepare("SELECT * FROM community_bingo_sources WHERE guild_id='g'").all(), []);
    assert.deepEqual(f.db.db.prepare("SELECT * FROM community_availability WHERE guild_id='g'").all(), []);
    for (const table of ['community_bingo_evidence', 'community_bingo_generations', 'community_bingo_groups', 'community_bingo_totals']) {
      assert.equal(f.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  } finally { await f.close(); }
});

test('trusted staged production finalization publishes complete generations with zero history payload reads', async () => {
  const f = communityFixture();
  const originalParse = JSON.parse;
  try {
    const { store, board } = setup(f);
    const matches = Array.from({ length: 451 }, (_, i) => session(f.now() + i, String(i).padStart(4, '0')));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    saveAvailability(f);
    const identities = new Map([['u', identity(f)]]);
    store.syncEvidenceEligibility('g', [...identities.values()], ['u'], ['MARS']);
    const stageId = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    let result;
    const processed = [];
    const parse = JSON.parse;
    let parsedGamePayloads = 0;
    JSON.parse = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('"gameId"') && args[0].includes('"gameStart"')) parsedGamePayloads++;
      return parse(...args);
    };
    do {
      result = store.stageEvidencePage(stageId, identities, new Set(['MARS']), new Set(['u']), f.now());
      assert.ok(result.processed <= 200);
      processed.push(result.processed);
      assert.equal(store.get('g', board.id).cells[0].progress, 0);
    } while (result.phase !== 'ready');
    JSON.parse = parse;
    assert.equal(parsedGamePayloads, 451);
    assert.deepEqual(processed, [200, 200, 51, 1]);
    const prepare = f.db.db.prepare.bind(f.db.db);
    let historyPayloadReads = 0;
    let evidenceRowsRead = 0;
    let finalGameParses = 0;
    JSON.parse = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('"gameId"') && args[0].includes('"gameStart"')) finalGameParses++;
      return parse(...args);
    };
    f.db.db.prepare = sql => {
      if (sql.includes('payload') && sql.includes('history_player_matches')) historyPayloadReads++;
      const statement = prepare(sql);
      if (sql.startsWith('SELECT * FROM community_bingo_evidence')) {
        const all = statement.all.bind(statement);
        statement.all = (...args) => { const rows = all(...args); evidenceRowsRead += rows.length; return rows; };
      }
      return statement;
    };
    store.finalizeEvidenceStage(stageId, f.now());
    JSON.parse = parse;
    assert.equal(historyPayloadReads, 0);
    assert.equal(evidenceRowsRead, 0);
    assert.equal(finalGameParses, 0);
    f.db.db.prepare = prepare;
    assert.equal(store.get('g', board.id).cells[0].progress, 451);
    assert.equal(store.get('g', board.id).cells[11].progress, 1);
    assert.equal(store.needsEvidenceRefresh('g', board.id, f.now()), false);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [{ ...matches[0], hasWon: false }]);
    const dirtyPrepare = f.db.db.prepare.bind(f.db.db);
    let dirtyReads = 0;
    f.db.db.prepare = sql => { if (sql.includes('payload FROM history_player_matches')) dirtyReads++; return dirtyPrepare(sql); };
    store.refresh('g', board.id, f.now());
    assert.ok(dirtyReads > 0 && dirtyReads <= 200);
    f.db.db.prepare = dirtyPrepare;
    store.refresh('g', board.id, f.now());
    store.refresh('g', board.id, f.now());
    assert.equal(store.get('g', board.id).cells[3].progress, 450);
  } finally {
    JSON.parse = originalParse;
    await f.close();
  }
});

test('partial, corrected, expired and privacy-invalidated stages never publish, and abandoned generations drain boundedly', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const matches = Array.from({ length: 451 }, (_, i) => session(f.now() + i, String(i).padStart(4, '0')));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    const identities = new Map([['u', identity(f)]]);
    store.syncEvidenceEligibility('g', [...identities.values()], ['u'], ['MARS']);
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u']), f.now());
    assert.throws(() => store.finalizeEvidenceStage(stage, f.now()));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [{ ...matches[0], hasWon: false }]);
    assert.throws(() => store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u']), f.now()));
    const replacement = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    let result;
    do { result = store.stageEvidencePage(replacement, identities, new Set(['MARS']), new Set(['u']), f.now()); } while (result.phase !== 'ready');
    assert.throws(() => store.finalizeEvidenceStage(replacement, f.now() + 90 * 86_400_000 + 1));
    f.db.community.purgeIdentity('u');
    assert.throws(() => store.finalizeEvidenceStage(replacement, f.now()));
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM community_bingo_generations WHERE board_id=? AND status='staging'").get(board.id).n, 0);
    f.db.community.prune(f.now());
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM community_bingo_generations WHERE board_id=? AND status='abandoned'").get(board.id).n, 0);
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
  } finally { await f.close(); }
});

test('replaced and abandoned generations drain two hundred evidence rows per prune tick', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const matches = Array.from({ length: 451 }, (_, i) => session(f.now() + i, String(i).padStart(4, '0')));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    const identities = new Map([['u', identity(f)]]);
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    for (let i = 0; i < 3; i++) store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u']), f.now());
    store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    const count = () => Number(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_evidence WHERE generation=?').get(stage).n);
    assert.equal(count(), 451);
    f.db.community.prune(f.now());
    assert.equal(count(), 251);
    f.db.community.prune(f.now());
    assert.equal(count(), 51);
    f.db.community.prune(f.now());
    assert.equal(count(), 0);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_generations WHERE id=?').get(stage).n, 0);
    const expiredStage = f.db.db.prepare("SELECT id FROM community_bingo_generations WHERE board_id=? AND status='staging'").get(board.id).id;
    f.db.community.prune(f.now() + 86_400_000 + 1);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_generations WHERE id=?').get(expiredStage).n, 0);
  } finally { await f.close(); }
});

test('persisted generation aggregates match distinct contributors and largest shared groups through privacy removal', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    f.db.linkUser('v', 'q', null, 'identity_token');
    const other = f.db.getEffectiveLink('g', 'v');
    const identities = new Map([['u', identity(f)], ['v', { guildId: 'g', discordId: 'v', publicId: 'q', linkedAt: other.linked_at }]]);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [session(f.now(), 'shared'), session(f.now(), 'solo', { hasWon: false })]);
    f.db.history.upsertPlayerMatches('g', 'q', 'v', [session(f.now(), 'shared', { public_id: 'q', discord_id: 'v' })]);
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    let result;
    do { result = store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u', 'v']), f.now()); } while (result.phase !== 'ready');
    store.finalizeEvidenceStage(stage, f.now());
    assert.deepEqual(store.get('g', board.id).cells.slice(0, 12).map(cell => cell.progress), [3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 0]);
    f.db.community.purgeIdentity('v');
    assert.deepEqual(store.get('g', board.id).cells.slice(0, 12).map(cell => cell.progress), [2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 0]);
    f.db.community.purgeIdentity('u');
    assert.deepEqual(store.get('g', board.id).cells.slice(0, 12).map(cell => cell.progress), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  } finally { await f.close(); }
});

test('routine retention removal is limited to two hundred evidence rows and refresh drains the rest', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const matches = Array.from({ length: 451 }, (_, i) => session(f.now() + i, String(i).padStart(4, '0')));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    const identities = new Map([['u', identity(f)]]);
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    let result;
    do { result = store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u']), f.now()); } while (result.phase !== 'ready');
    store.finalizeEvidenceStage(stage, f.now());
    f.db.history.retain('g', 14, f.now() + 15 * 86_400_000);
    assert.equal(store.get('g', board.id).cells[0].progress, 251);
    store.refresh('g', board.id, f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 51);
    store.refresh('g', board.id, f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
  } finally { await f.close(); }
});

test('legacy bingo evidence upgrades to generations without losing cells, approvals or aggregate corrections', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    const match = session(f.now());
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [match]);
    const available = saveAvailability(f);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, [match], [available]), undefined, f.now());
    store.setManualApproval('g', board.id, board.revision, 13, true, 'officer', 'Verified', f.now());
    // Recreate the reviewed pre-generation schema with its real persisted records.
    f.db.db.exec(`DROP TRIGGER bingo_evidence_insert; DROP TRIGGER bingo_evidence_delete; DROP TRIGGER bingo_evidence_update;
      ALTER TABLE community_bingo_evidence RENAME TO generation_evidence;
      CREATE TABLE community_bingo_evidence (board_id TEXT NOT NULL,guild_id TEXT NOT NULL,evidence_key TEXT NOT NULL,
        discord_id TEXT NOT NULL,public_id TEXT,kind TEXT NOT NULL,game_id TEXT,at INTEGER NOT NULL,won INTEGER NOT NULL,
        linked_at TEXT,PRIMARY KEY(board_id,evidence_key));
      INSERT INTO community_bingo_evidence SELECT board_id,guild_id,evidence_key,discord_id,public_id,kind,game_id,at,won,linked_at
        FROM generation_evidence;
      DROP TABLE generation_evidence;
      DROP TABLE community_bingo_totals; DROP TABLE community_bingo_groups; DROP TABLE community_bingo_generations;
      ALTER TABLE community_bingo_boards DROP COLUMN evidence_generation;
      ALTER TABLE community_bingo_boards DROP COLUMN refresh_cursor;
      ALTER TABLE community_bingo_boards DROP COLUMN refresh_version;`);
    BingoStore.initialize(f.db.db);
    assert.equal(store.get('g', board.id).cells[13].complete, true);
    assert.equal(store.listEvidence('g', board.id).length, 2);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [{ ...match, hasWon: false }]);
    store.refresh('g', board.id, f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 1);
    assert.equal(store.get('g', board.id).cells[3].progress, 0);
    assert.equal(store.get('g', board.id).cells[6].progress, 1);
    assert.equal(store.get('g', board.id).cells[11].progress, 1);
    assert.equal(store.get('g', board.id).cells[13].complete, true);
  } finally { await f.close(); }
});

test('partial dirty refresh cannot consume a mixed-line notification key before fresh completion', async () => {
  const f = communityFixture();
  try {
    const { store, board: original } = setup(f);
    store.archive('g', original.id, original.revision, f.now());
    const definitions = Array.from({ length: 24 }, (_, i) => ({ kind: 'manual', target: 1, label: String(i) }));
    definitions[4] = { kind: 'wins', target: 1, label: 'Observed win' };
    const draft = store.createDraft('g', 'c', definitions, null, f.now());
    const board = store.publish('g', draft.id, draft.revision, 'mixed');
    for (let index = 0; index < 3; index++) store.setManualApproval('g', board.id, board.revision, index, true, 'officer', 'Verified', f.now());
    const matches = Array.from({ length: 451 }, (_, i) => session(f.now() + i, String(i).padStart(4, '0')));
    f.db.history.upsertPlayerMatches('g', 'p', 'u', matches);
    store.replaceEvidence('g', board.id, board.revision, collect(f, board, matches), undefined, f.now());
    f.db.history.setMeta('deletions_error', 'offline');
    store.setManualApproval('g', board.id, board.revision, 3, true, 'officer', 'Verified', f.now());
    assert.equal(store.get('g', board.id).cells[4].progress, 251);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_notifications WHERE board_id=?').get(board.id).n, 0);
    f.db.history.setMeta('deletions_error', '');
    const identities = new Map([['u', identity(f)]]);
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    let result;
    do { result = store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u']), f.now()); } while (result.phase !== 'ready');
    store.finalizeEvidenceStage(stage, f.now());
    assert.equal(f.db.db.prepare("SELECT COUNT(*) AS n FROM community_bingo_notifications WHERE board_id=? AND line_key='row:0'").get(board.id).n, 1);
  } finally { await f.close(); }
});

test('a failed final publication rolls back generation pointers and can retry the complete stage', async () => {
  const f = communityFixture();
  try {
    const { store, board } = setup(f);
    f.db.history.upsertPlayerMatches('g', 'p', 'u', [session(f.now())]);
    const identities = new Map([['u', identity(f)]]);
    const stage = store.beginEvidenceStage(store.evidenceSnapshot('g', board.id, f.now()), f.now());
    let result;
    do { result = store.stageEvidencePage(stage, identities, new Set(['MARS']), new Set(['u']), f.now()); } while (result.phase !== 'ready');
    f.db.db.exec(`CREATE TRIGGER reject_bingo_publication BEFORE UPDATE OF evidence_generation ON community_bingo_boards
      BEGIN SELECT RAISE(ABORT,'test publication failure'); END;`);
    assert.throws(() => store.finalizeEvidenceStage(stage, f.now()), /test publication failure/);
    assert.equal(store.get('g', board.id).cells[0].progress, 0);
    assert.equal(f.db.db.prepare('SELECT status FROM community_bingo_generations WHERE id=?').get(stage).status, 'staging');
    assert.equal(f.db.db.prepare('SELECT status FROM community_bingo_generations WHERE id=?').get(board.id).status, 'current');
    f.db.db.exec('DROP TRIGGER reject_bingo_publication');
    store.finalizeEvidenceStage(stage, f.now());
    assert.equal(store.get('g', board.id).cells[0].progress, 1);
  } finally { await f.close(); }
});
