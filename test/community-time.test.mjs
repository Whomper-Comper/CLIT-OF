import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/community.mjs';
const { possibleInstants, resolveEventStart, projectAvailability, suggestAvailability } = await import('../dist/community/time.js');
const window = (weekday, startMinute, endMinute, id = 'w') => ({ id, weekday, startMinute, endMinute });
const member = (timezone, windows, discordId = 'u') => ({ guildId: 'g', discordId, timezone, windows, revision: 1, updatedAt: 0 });
const instant = Date.parse;

test('event wall times reject gaps and disambiguate folds', () => {
  assert.deepEqual(possibleInstants('2026-03-08 02:30', 'America/New_York'), []);
  assert.throws(() => resolveEventStart('2026-11-01 01:30', 'America/New_York'), /offset/i);
  assert.equal(resolveEventStart('2026-11-01 01:30', 'America/New_York', '-05:00'), instant('2026-11-01T06:30:00Z'));
  assert.throws(() => resolveEventStart('2026-11-01 01:30', 'America/New_York', '-03:00'), /offset/i);
  assert.throws(() => resolveEventStart('2026-02-30 18:00', 'UTC'), /date/i);
  assert.throws(() => possibleInstants('2026-01-01 00:00', 'invalid/zone'), /timezone/i);
});

test('fold projection keeps two partial hours separate and gap projection clips missing time', () => {
  assert.deepEqual(projectAvailability(member('America/New_York', [window(6,60,90)]), instant('2026-11-01T00:00Z'), instant('2026-11-02T00:00Z')), [
    { start: instant('2026-11-01T05:00Z'), end: instant('2026-11-01T05:30Z') },
    { start: instant('2026-11-01T06:00Z'), end: instant('2026-11-01T06:30Z') },
  ]);
  assert.deepEqual(projectAvailability(member('America/New_York', [window(6,90,210)]), instant('2026-03-08T00:00Z'), instant('2026-03-09T00:00Z')), [
    { start: instant('2026-03-08T06:30Z'), end: instant('2026-03-08T07:30Z') },
  ]);
});

test('overnight windows include the previous local weekday after midnight', () => {
  assert.deepEqual(projectAvailability(member('America/Bahia', [window(4,1380,60)]), instant('2026-10-17T03:30Z'), instant('2026-10-17T05:00Z')), [
    { start: instant('2026-10-17T03:30Z'), end: instant('2026-10-17T04:00Z') },
  ]);
});

test('same recurring New York schedule follows the changed offset next week', () => {
  const intervals = projectAvailability(member('America/New_York', [window(0,1080,1200)]), instant('2026-10-26T00:00Z'), instant('2026-11-03T02:00Z'));
  assert.deepEqual(intervals, [
    { start: instant('2026-10-26T22:00Z'), end: instant('2026-10-27T00:00Z') },
    { start: instant('2026-11-02T23:00Z'), end: instant('2026-11-03T01:00Z') },
  ]);
});

test('suggestions merge adjacent windows, count members once and require full duration', () => {
  const now = instant('2026-10-19T09:07Z');
  const a = member('UTC', [window(0,570,630),window(0,630,750,'x'),window(0,570,630,'duplicate')], 'a');
  const b = member('Asia/Kathmandu', [window(0,915,1035)], 'b'); // 09:30-11:30 UTC
  const c = member('UTC', [window(0,570,600)], 'c');
  const suggestions = suggestAvailability([a,b,c], now, 120);
  assert.deepEqual(suggestions[0], { start: instant('2026-10-19T09:30Z'), end: instant('2026-10-19T11:30Z'), memberIds: ['a','b'] });
  assert.ok(suggestions.length <= 3);
  assert.ok(suggestions.every(s => s.start >= now && s.end <= now + 14*86400000 && s.start % 1800000 === 0));
  for (let i=1;i<suggestions.length;i++) assert.ok(suggestions[i-1].memberIds.length > suggestions[i].memberIds.length || (suggestions[i-1].memberIds.length === suggestions[i].memberIds.length && suggestions[i-1].start < suggestions[i].start));
  for (const [i,a] of suggestions.entries()) for (const b of suggestions.slice(i+1)) assert.ok(JSON.stringify(a.memberIds)!==JSON.stringify(b.memberIds) || a.end <= b.start || b.end <= a.start);
  for (const duration of [0,29,241,NaN]) assert.throws(() => suggestAvailability([a],now,duration), /duration/i);
});

test('suggestions exclude past starts and do not manufacture fold coverage', () => {
  const now = instant('2026-11-01T04:00Z');
  assert.deepEqual(suggestAvailability([member('America/New_York',[window(6,60,90)])],now,60), []);
  assert.equal(suggestAvailability([member('UTC',[window(0,540,600)])],instant('2026-10-19T09:01Z'),30)[0].start,instant('2026-10-19T09:30Z'));
});

test('half-hour daylight transitions split repeated Lord Howe local minutes',()=>{
  assert.deepEqual(possibleInstants('2026-04-05 01:40','Australia/Lord_Howe'),[instant('2026-04-04T14:40Z'),instant('2026-04-04T15:10Z')]);
  assert.deepEqual(projectAvailability(member('Australia/Lord_Howe',[window(6,100,130)]),instant('2026-04-04T13:00Z'),instant('2026-04-04T17:00Z')),[
    {start:instant('2026-04-04T14:40Z'),end:instant('2026-04-04T15:00Z')},
    {start:instant('2026-04-04T15:10Z'),end:instant('2026-04-04T15:40Z')},
  ]);
});

test('partial overlap never counts members lacking the full requested duration',()=>{
  const suggestions=suggestAvailability([member('UTC',[window(0,540,660)],'a'),member('UTC',[window(0,600,720)],'b')],instant('2026-10-19T09:00Z'),120);
  assert.deepEqual(suggestions.slice(0,2),[
    {start:instant('2026-10-19T09:00Z'),end:instant('2026-10-19T11:00Z'),memberIds:['a']},
    {start:instant('2026-10-19T10:00Z'),end:instant('2026-10-19T12:00Z'),memberIds:['b']},
  ]);
});

test('projection honors the requested date range beyond the suggestion horizon',()=>{
  const projected=projectAvailability(member('UTC',[window(0,600,720)]),instant('2026-10-19T00:00Z'),instant('2026-12-01T00:00Z'));
  assert.equal(projected.length,7);
  assert.deepEqual(projected[6],{start:instant('2026-11-30T10:00Z'),end:instant('2026-11-30T12:00Z')});
});
