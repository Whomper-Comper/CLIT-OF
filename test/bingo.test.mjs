import test from 'node:test';
import assert from 'node:assert/strict';
import { communityFixture } from './helpers/community.mjs';
import { defaultBingoObjectives, evaluateBingo } from '../dist/community/bingo.js';
const cells = () => Array.from({ length: 25 }, (_, index) => ({ index, objective: index === 12 ? null : { kind: 'manual', target: 1, label: String(index) }, complete: false, progress: 0 }));

test('defaults freeze the approved twelve automatic targets and twelve named manual challenges', () => {
  const definitions = defaultBingoObjectives();
  assert.deepEqual(definitions.filter(o => o.kind !== 'manual').map(o => [o.kind, o.target]), [
    ['appearances', 5], ['appearances', 15], ['appearances', 30], ['wins', 1], ['wins', 5], ['wins', 10],
    ['contributors', 2], ['contributors', 5], ['contributors', 8], ['shared_game', 2], ['shared_game', 3], ['availability', 3],
  ]);
  assert.deepEqual(definitions.filter(o => o.kind === 'manual').map(o => o.label), ['Win on Europe', 'Win on World', 'Win on Black Sea',
    'Win without nukes', 'Win a naval-focused match', 'Make a comeback win', 'Teach a newcomer', 'Hold a training session',
    'Finish a full-squad session', 'Share a clan group screenshot', 'Play three different maps', 'Finish a clan night']);
});
test('free center, stable top row and all twelve lines are pure', () => {
  const input = cells();
  assert.deepEqual(evaluateBingo(input, [], new Set([0, 1, 2, 3, 4])).lines, ['row:0']);
  const result = evaluateBingo(input, [], new Set(Array.from({ length: 25 }, (_, i) => i)));
  assert.deepEqual(result.lines, ['row:0', 'row:1', 'row:2', 'row:3', 'row:4', 'column:0', 'column:1', 'column:2', 'column:3', 'column:4', 'diagonal:0', 'diagonal:1']);
  assert.equal(result.complete, true);
  assert.equal(result.cells[12].complete, true);
  assert.equal(input[12].complete, false);
});
test('deduplicate account/game pairs, contributors, largest shared group and distinct availability members', () => {
  const input = cells();
  for (const [index, kind, target] of [[0, 'appearances', 5], [1, 'wins', 2], [2, 'contributors', 2], [3, 'shared_game', 3], [4, 'availability', 3]]) input[index].objective = { kind, target, label: kind };
  const game = (publicId, gameId, won) => ({ key: `${publicId}:${gameId}`, boardId: 'b', discordId: publicId, publicId, kind: 'game', gameId, at: 1, won });
  const available = id => ({ key: id, boardId: 'b', discordId: id, publicId: null, kind: 'availability', gameId: null, at: 1, won: false });
  const evidence = [game('a', '1', true), game('a', '1', true), game('a', '2', false), game('b', '1', false), game('c', '1', true), available('a'), available('a'), available('b'), available('c')];
  const result = evaluateBingo(input, evidence, new Set([0]));
  assert.deepEqual(result.cells.slice(0, 5).map(c => c.progress), [4, 2, 3, 3, 3]);
  assert.equal(result.cells[0].complete, false);
});
test('draft validation, immutable publication, unique active board and explicit archive', async () => {
  const f = communityFixture();
  try {
    const store = f.db.community.bingo;
    assert.throws(() => store.createDraft('g', 'c', [], null, f.now()));
    assert.throws(() => store.createDraft('g', 'c', defaultBingoObjectives(), f.now(), f.now()));
    const draft = store.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
    assert.equal(draft.cells.length, 25);
    assert.equal(draft.cells[12].objective, null);
    const active = store.publish('g', draft.id, draft.revision, 'm');
    assert.equal(store.publish('g', active.id, active.revision, 'm').id, active.id);
    const next = store.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
    assert.throws(() => store.publish('g', next.id, next.revision, 'n'));
    assert.throws(() => store.archive('g', active.id, 99, f.now()));
    store.archive('g', active.id, active.revision, f.now());
    assert.equal(store.getActive('g'), null);
    assert.equal(store.publish('g', next.id, next.revision, 'n').status, 'active');
    assert.throws(() => store.publish('g', active.id, active.revision, 'm'));
  } finally { await f.close(); }
});
test('current lines can be corrected, notification namespace survives loss and resets with new board', async () => {
  const f = communityFixture();
  try {
    const store = f.db.community.bingo;
    const definitions = Array.from({ length: 24 }, (_, i) => ({ kind: 'manual', target: 1, label: String(i) }));
    const start = () => { const b = store.createDraft('g', 'c', definitions, null, f.now()); return store.publish('g', b.id, b.revision, 'm'); };
    let board = start();
    for (let index = 0; index < 5; index++) store.setManualApproval('g', board.id, board.revision, index, true, 'officer', 'Verified', f.now());
    assert.deepEqual(store.getProgress('g', board.id).lines, ['row:0']);
    assert.equal(f.db.community.deliveries.list('g').filter(d => d.kind === 'bingo_complete').length, 1);
    store.setManualApproval('g', board.id, board.revision, 0, false, 'officer', 'Correction', f.now());
    assert.deepEqual(store.getProgress('g', board.id).lines, []);
    store.setManualApproval('g', board.id, board.revision, 0, true, 'officer', 'Verified again', f.now());
    assert.equal(f.db.community.deliveries.list('g').filter(d => d.kind === 'bingo_complete').length, 1);
    assert.throws(() => store.setManualApproval('g', board.id, board.revision, 12, true, 'officer', 'Verified', f.now()));
    store.archive('g', board.id, board.revision, f.now());
    board = start();
    for (let index = 0; index < 5; index++) store.setManualApproval('g', board.id, board.revision, index, true, 'officer', 'Verified', f.now());
    assert.equal(f.db.community.deliveries.list('g').filter(d => d.kind === 'bingo_complete').length, 2);
  } finally { await f.close(); }
});

test('draft and its initial evidence generation are created atomically', async () => {
  const f = communityFixture();
  try {
    f.db.db.exec(`CREATE TRIGGER reject_initial_generation BEFORE INSERT ON community_bingo_generations
      BEGIN SELECT RAISE(ABORT,'test generation failure'); END;`);
    assert.throws(() => f.db.community.bingo.createDraft('g', 'c', defaultBingoObjectives(), null, f.now()), /test generation failure/);
    assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM community_bingo_boards').get().n, 0);
  } finally { await f.close(); }
});
