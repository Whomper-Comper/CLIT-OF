import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { CommunitySessions } from '../dist/community/sessions.js';
import { ExpiringSessions } from '../dist/expiringSessions.js';

const binding = { guildId: 'g', channelId: 'c', messageId: 'm' };
const input = (extra = {}) => ({ ...binding, ownerId: 'u', kind: 'test', data: Buffer.alloc(100_000), ...extra });

test('community idle expiry releases retained payloads at exactly ten minutes without another interaction', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const sessions = new CommunitySessions();
  const first = sessions.create(input(), 0);
  t.mock.timers.tick(599_999);
  assert.equal(sessions.sessions.size, 1);
  t.mock.timers.tick(1);
  assert.equal(sessions.sessions.size, 0, 'expired payload must be released while idle');
  assert.throws(() => sessions.get(first.id, 'u', binding, 0), /expired|reopen/i, 'rollback cannot revive a released entry');
});

test('community explicit historical clock values retain staggered deadlines', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000_000 });
  const sessions = new CommunitySessions();
  const first = sessions.create(input(), 100);
  t.mock.timers.tick(100);
  const second = sessions.create(input(), 200);
  t.mock.timers.tick(599_900);
  assert.equal(sessions.sessions.size, 1);
  assert.equal(sessions.get(second.id, 'u', binding, 600_100), second);
  assert.throws(() => sessions.get(first.id, 'u', binding, 600_100), /expired|reopen/i);
  t.mock.timers.tick(100);
  assert.equal(sessions.sessions.size, 0);
});

function scheduler() {
  let now = 0;
  const pending = new Set();
  const clock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const timer = { callback, at: now + delay, referenced: true, unref() { this.referenced = false; } };
      pending.add(timer); return timer;
    },
    clearTimeout: timer => pending.delete(timer),
  };
  return { clock, pending, setNow: value => { now = value; },
    fire: () => { const timer = pending.values().next().value; pending.delete(timer); timer.callback(); } };
}

test('one unreferenced timer tracks the earliest deadline, never extending expiry on reads', () => {
  const f = scheduler(), sessions = new ExpiringSessions(3, value => value.expires, f.clock);
  sessions.set('later', { expires: 200 });
  sessions.set('first', { expires: 100 });
  sessions.set('last', { expires: 300 });
  assert.equal(f.pending.size, 1);
  assert.equal([...f.pending][0].referenced, false);
  f.setNow(99); assert.ok(sessions.get('first'));
  assert.equal([...f.pending][0].at, 100);
  f.setNow(100); f.fire();
  assert.equal(sessions.size, 2);
  assert.equal(sessions.get('first'), undefined);
  assert.equal([...f.pending][0].at, 200);
  f.setNow(300); f.fire();
  assert.equal(sessions.size, 0);
  assert.equal(f.pending.size, 0);
});

test('capacity evicts insertion order even after reads, replacement and rollback', () => {
  const f = scheduler(), sessions = new ExpiringSessions(2, value => value.expires, f.clock);
  sessions.set('oldest', { expires: 300 });
  sessions.set('second', { expires: 100 });
  sessions.get('oldest');
  sessions.set('oldest', { expires: 400 });
  f.setNow(-100);
  sessions.set('third', { expires: 200 });
  assert.equal(sessions.size, 2);
  assert.equal(sessions.get('oldest'), undefined);
  assert.deepEqual([...sessions.entries()].map(([id]) => id), ['second', 'third']);
  f.setNow(100); f.fire();
  assert.equal(sessions.get('second'), undefined);
  assert.equal(sessions.size, 1);
});

test('a timer firing after clock rollback rearms until the exact original deadline', () => {
  const f = scheduler(), sessions = new ExpiringSessions(2, value => value.expires, f.clock);
  sessions.set('one', { expires: 100 });
  f.setNow(-50); f.fire();
  assert.equal(sessions.size, 1);
  assert.equal(f.pending.size, 1);
  assert.equal([...f.pending][0].at, 100);
  f.setNow(100); f.fire();
  assert.equal(sessions.size, 0);
  f.setNow(0); assert.equal(sessions.get('one'), undefined);
});

test('deleting the earliest entry rearms and delete/clear cancel the final timer', () => {
  const f = scheduler(), sessions = new ExpiringSessions(2, value => value.expires, f.clock);
  sessions.set('first', { expires: 100 }); sessions.set('second', { expires: 200 });
  sessions.delete('first');
  assert.equal(f.pending.size, 1); assert.equal([...f.pending][0].at, 200);
  sessions.delete('second'); assert.equal(f.pending.size, 0);
  sessions.set('third', { expires: 300 }); sessions.clear();
  assert.equal(f.pending.size, 0); assert.equal(sessions.size, 0);
  sessions.set('fourth', { expires: 400 });
  assert.equal(f.pending.size, 1);
  f.setNow(400); f.fire(); assert.equal(sessions.size, 0);
});

test('community owner/binding checks and scoped purges cancel timers without reviving sessions', () => {
  const f = scheduler(), sessions = new CommunitySessions(f.clock);
  const first = sessions.create(input({ messageId: null }), 0);
  sessions.bind(first.id, 'm');
  assert.throws(() => sessions.bind(first.id, 'other'), /expired|reopen/i);
  for (const [owner, target] of [['other', binding], ['u', { ...binding, guildId: 'other' }],
    ['u', { ...binding, channelId: 'other' }], ['u', { ...binding, messageId: 'other' }]]) {
    assert.throws(() => sessions.get(first.id, owner, target, 0), /expired|reopen/i);
  }
  const otherMember = sessions.create(input({ ownerId: 'v' }), 0);
  const otherGuild = sessions.create(input({ guildId: 'other' }), 0);
  sessions.purgeMember('g', 'u');
  assert.throws(() => sessions.get(first.id, 'u', binding, 0), /expired|reopen/i);
  assert.equal(sessions.get(otherMember.id, 'v', binding, 0), otherMember);
  sessions.purgeGuild('g');
  assert.equal(sessions.sessions.size, 1);
  assert.equal(sessions.get(otherGuild.id, 'u', { ...binding, guildId: 'other' }, 0), otherGuild);
  sessions.delete(otherGuild.id);
  assert.equal(f.pending.size, 0);
});

test('community retains the shared 200-session insertion bound without extending the oldest on reads', () => {
  const f = scheduler(), sessions = new CommunitySessions(f.clock);
  const oldest = sessions.create(input(), 0);
  for (let i = 0; i < 199; i++) sessions.create(input(), 0);
  sessions.get(oldest.id, 'u', binding, 0);
  const latest = sessions.create(input(), 0);
  assert.equal(sessions.sessions.size, 200);
  assert.throws(() => sessions.get(oldest.id, 'u', binding, 0), /expired|reopen/i);
  assert.equal(sessions.get(latest.id, 'u', binding, 0), latest);
  f.setNow(600_000); f.fire();
  assert.equal(sessions.sessions.size, 0); assert.equal(f.pending.size, 0);
});

test('community explicit clock jumps rearm idle expiry in the supplied time domain', () => {
  const f = scheduler(), sessions = new CommunitySessions(f.clock);
  const first = sessions.create(input(), 0);
  sessions.get(first.id, 'u', binding, 599_999);
  assert.equal(f.pending.size, 1);
  assert.equal([...f.pending][0].at, 1, 'logical jump must leave only one millisecond until expiry');
  f.setNow(1); f.fire();
  assert.equal(sessions.sessions.size, 0);

  const second = sessions.create(input(), 1000);
  sessions.get(second.id, 'u', binding, 0);
  assert.equal([...f.pending][0].at, 601_001, 'rollback preserves the original logical deadline');
  f.setNow(601_001); f.fire();
  assert.equal(sessions.sessions.size, 0);
});

for (const operation of ['get', 'create']) test(`community explicit time remains authoritative throughout ${operation} at the pre-expiry boundary`, () => {
  const f = scheduler();
  let sampled = 0, advancing = false;
  const clock = { ...f.clock, now: () => advancing ? sampled++ : sampled };
  const sessions = new CommunitySessions(clock), first = sessions.create(input(), 0);
  advancing = true;
  if (operation === 'get') assert.equal(sessions.get(first.id, 'u', binding, 599_999), first);
  else {
    sessions.create(input(), 599_999);
    assert.equal(sessions.sessions.size, 2, 'creation must not sweep the still-live first entry');
  }
  assert.equal(sessions.get(first.id, 'u', binding, 599_999), first);
  assert.throws(() => sessions.get(first.id, 'u', binding, 600_000), /expired|reopen/i);
  assert.throws(() => sessions.get(first.id, 'u', binding, 0), /expired|reopen/i, 'rollback cannot revive the expired entry');
});

test('real session timers allow an otherwise idle process to exit', () => {
  const moduleUrl = new URL('../dist/expiringSessions.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { ExpiringSessions } = await import(${JSON.stringify(moduleUrl)});
    const sessions = new ExpiringSessions(200, value => value.expires);
    sessions.set('one', { expires: Date.now() + 600_000 });
    console.log(sessions.size);
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '1');
});
