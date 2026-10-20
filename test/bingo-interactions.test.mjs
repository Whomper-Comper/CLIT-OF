import test from 'node:test';
import assert from 'node:assert/strict';
import { communityFixture } from './helpers/community.mjs';
import { defaultBingoObjectives } from '../dist/community/bingo.js';
import { CommunitySessions } from '../dist/community/sessions.js';
const bingo = await import('../dist/commands/bingo.js').catch(() => ({}));
export function interaction(f, sub, values = {}) {
  return { guild: f.guild, guildId: 'g', channelId: 'c', user: { id: 'u' },
    options: { getSubcommand: () => sub, getString: k => values[k] ?? null, getInteger: k => values[k] ?? null },
    async deferReply(p) { this.deferred = p; }, async editReply(p) { this.output = p; return { id: 'private' }; },
    async reply(p) { this.output = p; }, async fetchReply() { return { id: 'private' }; } };
}
export function control(f, id, extra = {}) {
  return { ...interaction(f, ''), customId: id, message: { id: 'private' }, isButton: () => true,
    isStringSelectMenu: () => false, isModalSubmit: () => false,
    async update(p) { this.output = p; }, async showModal(p) { this.modal = p; }, ...extra };
}
const button = (p, label) => p.components.flatMap(r => r.components).find(b => b.data.label === label).data.custom_id;
function setup(f) {
  f.addMember('u', ['manager']); f.db.setManagerRole('g', 'manager');
  return bingo.createBingoCommand({ db: f.db, now: f.now, sessions: new CommunitySessions() });
}
const active = f => {
  const s = f.db.community.bingo;
  const b = s.createDraft('g', 'c', defaultBingoObjectives(), null, f.now());
  return s.publish('g', b.id, b.revision, 'public');
};
test('claims deduplicate pending, reject automatic/free cells and validate HTTPS without fetching', async () => {
  const f = communityFixture();
  try {
    const b = active(f), s = f.db.community.bingo;
    const claim = s.claim('g', b.id, 13, 'u', 'A training victory', 'https://example.com/proof', f.now());
    assert.equal(s.claim('g', b.id, 13, 'u', 'again', null, f.now()).id, claim.id);
    for (const index of [0, 12, 25]) assert.throws(() => s.claim('g', b.id, index, 'u', 'proof', null, f.now()));
    assert.throws(() => s.claim('g', b.id, 14, 'u', 'proof', 'http://example.com', f.now()));
    assert.equal(s.claims('g', b.id)[0].evidenceUrl, 'https://example.com/proof');
    assert.deepEqual(f.calls.requests, []);
    s.review('g', claim.id, 'officer', true, 'Verified', 1, f.now());
    assert.equal(s.get('g', b.id).cells[13].complete, true);
    assert.throws(() => s.review('g', claim.id, 'officer', false, 'Oops', 1, f.now()));
    s.review('g', claim.id, 'officer', false, 'Correction', 2, f.now());
    assert.equal(s.get('g', b.id).cells[13].complete, false);
    assert.equal(s.claims('other', b.id).length, 0);
  } finally { await f.close(); }
});
test('officer draft edits all 24 definitions, publication is explicit and stale access/reset controls reject', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), i = interaction(f, 'create'); await c.execute(i);
    assert.ok(i.deferred); assert.equal(f.calls.sends.length, 0);
    const edit = control(f, button(i.output, 'Edit challenges')); await c.handleInteraction(edit);
    const text = Array.from({ length: 24 }, (_, n) => `manual | 1 | Custom ${n + 1}`).join('\n');
    await c.handleInteraction(control(f, edit.modal.data.custom_id, { isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: k => k === 'challenges' ? text : '-' } }));
    const view = interaction(f, 'create'); await c.execute(view);
    assert.match(JSON.stringify(view.output), /Custom 24/);
    const publish = control(f, button(view.output, 'Publish board'));
    f.setRoles('u', []); await assert.rejects(c.handleInteraction(publish), /officer|manager/i);
    f.setRoles('u', ['manager']); await c.handleInteraction(publish);
    assert.equal(f.db.community.deliveries.list('g')[0].kind, 'bingo_publish');
    const s = f.db.community.bingo, draft = s.draft('g'); s.publish('g', draft.id, draft.revision, 'public');
    const reset = interaction(f, 'reset'); await c.execute(reset);
    assert.equal(s.getActive('g').id, draft.id);
    const confirm = control(f, button(reset.output, 'Confirm reset'));
    f.setRoles('u', []); await assert.rejects(c.handleInteraction(confirm), /officer|manager/i);
    f.setRoles('u', ['manager']); await c.handleInteraction(confirm);
    assert.equal(s.get('g', draft.id).status, 'archived');
    await assert.rejects(c.handleInteraction(confirm), /changed|reopen|expired/i);
  } finally { await f.close(); }
});
test('worst-case labels are escaped, bounded and stale public bindings reject; legacy controls stay untouched', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), s = f.db.community.bingo;
    const b = s.createDraft('g', 'c', defaultBingoObjectives().map(o => ({ ...o, label: '*@everyone'.repeat(16) })), null, f.now());
    s.publish('g', b.id, 1, 'public');
    const payload = bingo.renderBingoBoard(b), embed = payload.embeds[0].toJSON();
    assert.ok(embed.fields.every(x => x.value.length <= 1024));
    assert.ok([embed.title, embed.description, embed.footer.text, ...embed.fields.flatMap(x => [x.name, x.value])].join('').length <= 5800);
    assert.doesNotMatch(JSON.stringify(payload), /@everyone/);
    await assert.rejects(c.handleInteraction(control(f, `bingo:${b.id}:claim:1`, { message: { id: 'wrong' } })), /match|message|bound/i);
    assert.equal(await c.handleInteraction({ customId: 'legacy:button' }), false);
    await assert.rejects(c.execute({ ...interaction(f, 'view'), guild: null, guildId: null }), /server/i);
  } finally { await f.close(); }
});
test('public claim modal retains its canonical message binding and private review rechecks role after roster await', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), b = active(f), s = f.db.community.bingo;
    const click = control(f, `bingo:${b.id}:claim:1`, { message: { id: 'public' } });
    await c.handleInteraction(click);
    assert.equal(click.modal.toJSON().components.length, 3);
    const save = control(f, click.modal.data.custom_id, { message: { id: 'public' }, isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: k => ({ cell: '14', explanation: 'A victory', evidence: 'https://example.com/proof' })[k] } });
    await c.handleInteraction(save);
    assert.equal(s.claims('g', b.id).length, 1);
    const review = interaction(f, 'review'); await c.execute(review);
    const select = review.output.components[0].components[0];
    const choose = control(f, select.data.custom_id, { isButton: () => false, isStringSelectMenu: () => true, values: [select.options[0].data.value] });
    await c.handleInteraction(choose);
    assert.equal(choose.modal.toJSON().components.length, 4);
    const decision = control(f, choose.modal.data.custom_id, { isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: k => k === 'decision' ? 'approve' : 'Reviewed' } });
    const fetch = f.guild.members.fetch;
    f.guild.members.fetch = async options => { const result = await fetch(options); if (!('user' in options)) f.setRoles('u', []); return result; };
    await assert.rejects(c.handleInteraction(decision), /officer|manager/i);
    assert.equal(s.get('g', b.id).cells[13].complete, false);
    f.guild.members.fetch = fetch; f.setRoles('u', ['manager']); await c.handleInteraction(decision);
    assert.equal(s.get('g', b.id).cells[13].complete, true);
    assert.ok(decision.output.flags);
  } finally { await f.close(); }
});
test('drafts belong to their officer; invalid edits roll back and board replacement invalidates pending review', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), s = f.db.community.bingo;
    const first = interaction(f, 'create'); await c.execute(first);
    f.addMember('other', ['manager']);
    const other = { ...interaction(f, 'create'), user: { id: 'other' } }; await c.execute(other);
    assert.notEqual(s.draft('g', 'u').id, s.draft('g', 'other').id);
    const d = s.draft('g', 'u');
    assert.throws(() => s.editDraft('g', d.id, d.revision, [], null, f.now()));
    assert.equal(s.get('g', d.id).revision, d.revision);
    const b = active(f), claim = s.claim('g', b.id, 13, 'u', 'Done', null, f.now());
    const review = interaction(f, 'review'); await c.execute(review);
    const select = review.output.components[0].components[0];
    const choose = control(f, select.data.custom_id, { isButton: () => false, isStringSelectMenu: () => true, values: [select.options[0].data.value] });
    await c.handleInteraction(choose);
    s.archive('g', b.id, 1, f.now()); active(f);
    await assert.rejects(c.handleInteraction(control(f, choose.modal.data.custom_id, { isButton: () => false, isModalSubmit: () => true,
      fields: { getTextInputValue: k => k === 'decision' ? 'approve' : 'Done' } })), /changed|reopen/i);
    assert.equal(s.findClaim('g', b.id, claim.id).status, 'pending');
    f.db.community.purgeMember('g', 'u'); assert.equal(s.findClaim('g', b.id, claim.id), null);
  } finally { await f.close(); }
});
test('private customization rejects calendar rollover dates and delivery diagnostics permit fresh authorized retry', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), s = f.db.community.bingo, i = interaction(f, 'create'); await c.execute(i);
    const edit = control(f, button(i.output, 'Edit challenges')); await c.handleInteraction(edit);
    const text = defaultBingoObjectives().map(o => `${o.kind} | ${o.target} | ${o.label}`).join('\n');
    const fields = { challenges: text, remaining: '-', closing: '2027-02-31T00:00:00Z' };
    const save = control(f, edit.modal.data.custom_id, { isButton: () => false, isModalSubmit: () => true, fields: { getTextInputValue: k => fields[k] } });
    await assert.rejects(c.handleInteraction(save), /valid|closing|date/i);
    fields.closing = '2027-02-28T00:00:00Z'; await c.handleInteraction(save);
    const b = s.draft('g', 'u'); s.publish('g', b.id, b.revision, 'public');
    f.db.community.deliveries.enqueue({ key: 'failed-update', guildId: 'g', channelId: 'c', subjectId: b.id, kind: 'bingo_update', revision: b.revision, dueAt: f.now(), part: 0 });
    const job = f.db.community.deliveries.claim(f.now(), 1)[0]; f.db.community.deliveries.fail(job.id, job.leaseId, 'paused', 'Missing permissions', f.now());
    const review = interaction(f, 'review'); await c.execute(review); assert.match(JSON.stringify(review.output), /paused/);
    const retry = control(f, button(review.output, 'Retry / reconcile')); f.setRoles('u', []);
    await assert.rejects(c.handleInteraction(retry), /officer|manager/i); f.setRoles('u', ['manager']); await c.handleInteraction(retry);
    assert.equal(f.db.community.deliveries.get(job.id).status, 'pending');
  } finally { await f.close(); }
});
test('451 pending claims keep card checks fixed to 12 indexed probes and review pages bounded to ten', async () => {
  const f = communityFixture();
  try {
    const b = active(f), s = f.db.community.bingo;
    for (let n = 0; n < 451; n++) s.claim('g', b.id, 13, `member-${n}`, 'Done', null, f.now());
    const prepare = f.db.db.prepare.bind(f.db.db); let probes = 0;
    f.db.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT 1 FROM community_bingo_claims')) {
        const get = statement.get.bind(statement); statement.get = (...args) => { probes++; return get(...args); };
        statement.all = () => { throw Error('Unbounded pending read'); };
      }
      return statement;
    };
    try { assert.deepEqual([...s.pendingCells('g', b.id)], [13]); assert.equal(probes, 12); }
    finally { f.db.db.prepare = prepare; }
    assert.equal(s.claims('g', b.id).length, 10); assert.equal(s.claims('g', b.id, 2).length, 10);
    const plan = prepare("EXPLAIN QUERY PLAN SELECT 1 FROM community_bingo_claims WHERE board_id=? AND cell_index=? AND guild_id=? AND status='pending' LIMIT 1").all(b.id, 13, 'g');
    assert.ok(plan.some(row => row.detail.includes('community_bingo_claim_pending')));
    assert.ok(plan.every(row => !row.detail.startsWith('SCAN ')));
    s.archive('g', b.id, 1, f.now());
    f.db.community.prune(f.now() + 90 * 86400000 + 1);
    assert.equal(prepare('SELECT count(*) AS n FROM community_bingo_claims WHERE board_id=?').get(b.id).n, 251);
    const cleanup = prepare('EXPLAIN QUERY PLAN SELECT rowid FROM community_bingo_claims WHERE board_id=? LIMIT 200').all(b.id);
    assert.ok(cleanup.some(row => row.detail.includes('community_bingo_claim_archive')));
    assert.ok(cleanup.every(row => !row.detail.startsWith('SCAN ')));
  } finally { await f.close(); }
});
test('private controls expire/bind owners and cross-server reviews/resets never alter the other board', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), s = f.db.community.bingo;
    const draft = interaction(f, 'create'); await c.execute(draft);
    const publish = control(f, button(draft.output, 'Publish board'));
    f.addMember('other-officer', ['manager']);
    await assert.rejects(c.handleInteraction({ ...publish, user: { id: 'other-officer' } }), /reopen|own/i);
    f.advance(600000); await assert.rejects(c.handleInteraction(publish), /expired|reopen/i);
    const a = active(f), other = s.createDraft('other', 'other-channel', defaultBingoObjectives(), null, f.now()); s.publish('other', other.id, 1, 'other-message');
    const claim = s.claim('other', other.id, 13, 'member', 'Done', null, f.now());
    assert.throws(() => s.review('g', claim.id, 'u', true, 'No cross-server writes', 1, f.now()));
    assert.throws(() => s.requestPublish('g', s.draft('g', 'u').id, 1, { id: other.id, revision: 1 }, f.now()));
    assert.equal(s.get('other', other.id).cells[13].complete, false); assert.equal(s.getActive('other').id, other.id); assert.equal(s.getActive('g').id, a.id);
  } finally { await f.close(); }
});
test('a private draft control expiring during officer lookup cannot queue publication', async () => {
  const f = communityFixture();
  try {
    const c = setup(f), i = interaction(f, 'create'); await c.execute(i);
    const fetch = f.guild.members.fetch;
    f.guild.members.fetch = async options => { const result = await fetch(options); f.advance(600000); return result; };
    await assert.rejects(c.handleInteraction(control(f, button(i.output, 'Publish board'))), /expired|reopen/i);
    assert.equal(f.db.community.deliveries.list('g').length, 0);
  } finally { await f.close(); }
});
