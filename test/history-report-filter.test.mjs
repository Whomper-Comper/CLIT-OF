import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HistoryStore } from '../dist/historyStore.js';

const start = '2026-10-12T00:00:00.000Z', end = '2026-10-19T00:00:00.000Z';
const session = (gameId, gameStart = start, hasWon = true) => ({ gameId, gameStart, gameEnd: end,
  gameType: 'Public', gameMode: 'Team', gameRankedType: 'unranked', clientId: 'ephemeral',
  username: 'Player', clanTag: 'MARS', hasWon });

test('player report inventory filters exact identity pairs in SQL before decoding with indexed time bounds', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    HistoryStore.initialize(sql);
    const seed = new HistoryStore(sql), publicId = 'account"[,]☃', discordId = 'owner"[,]☃';
    seed.upsertPlayerMatches('g', publicId, discordId, [session('b'), session('a'), session('end', end),
      session('before', '2026-10-11T23:59:59.999Z')]);
    seed.upsertPlayerMatches('g', publicId, discordId, [session('a', start, false)]);
    seed.upsertPlayerMatches('other', publicId, discordId, [session('other-guild')]);
    // Even malformed payloads for ineligible accounts must never reach the decoder.
    const insert = sql.prepare('INSERT INTO history_player_matches VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < 100; i++) insert.run('g', `unlinked-${i}`, discordId, `excluded-${i}`, start, 'invalid-json');
    insert.run('g', publicId, 'another-owner', 'wrong-owner', start, 'invalid-json');
    insert.run('g', 'another-account', discordId, 'wrong-account', start, 'invalid-json');
    let rows = 0;
    const plans = [];
    const history = new HistoryStore({ prepare(query) {
      const statement = sql.prepare(query);
      return { *iterate(...parameters) {
        plans.push(...sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters));
        for (const row of statement.iterate(...parameters)) { rows++; yield row; }
      } };
    } });
    const inventory = [{ publicId, discordId }, { publicId, discordId },
      { publicId: 'another-account', discordId: 'another-owner' }];
    const actual = [...history.iteratePlayerMatches('g', start, end, inventory)];
    assert.deepEqual(actual.map(row => [row.gameId, row.hasWon, row.public_id, row.discord_id]), [
      ['a', false, publicId, discordId], ['b', true, publicId, discordId],
    ]);
    assert.equal(rows, 2);
    assert.ok(plans.some(row => /SEARCH history_player_matches USING INDEX/.test(row.detail) &&
      /guild_id=\? AND game_start>\? AND game_start<\?/.test(row.detail)), JSON.stringify(plans));
    assert.ok(!plans.some(row => /SCAN history_player_matches/.test(row.detail)), JSON.stringify(plans));
  } finally { sql.close(); }
});

test('empty player report inventory reads no payloads while omitted inventory preserves the unfiltered API', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    HistoryStore.initialize(sql);
    const seed = new HistoryStore(sql);
    seed.upsertPlayerMatches('g', 'account', 'owner', [session('a')]);
    let queries = 0;
    const history = new HistoryStore({ prepare(query) { queries++; return sql.prepare(query); } });
    assert.deepEqual([...history.iteratePlayerMatches('g', start, end, [])], []);
    assert.equal(queries, 0);
    assert.deepEqual(history.getPlayerMatches('g', start, end).map(row => row.gameId), ['a']);
    assert.equal(queries, 1);
  } finally { sql.close(); }
});
