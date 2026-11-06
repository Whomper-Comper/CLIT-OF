// Isolated capability check: never import config.ts, db.ts, or the bot entry point.
// Run with the selected Node interpreter: node tools/check-runtime.mjs.
const checks = [];
class MissingCapability extends Error {
  constructor(capability) { super('Required capability is unavailable'); this.capability = capability; }
}
async function check(name, verify) {
  try {
    await verify();
    checks.push({ name, ok: true });
    return true;
  } catch (error) {
    // Raw errors can contain paths or request data. Emit only the capability and name.
    checks.push({ name, ok: false, error: error?.name === 'TypeError' ? 'TypeError' : 'CapabilityError',
      ...(error instanceof MissingCapability ? { capability: error.capability } : {}) });
    return false;
  }
}
function requireValue(value, capability = 'required-api') {
  if (!value) throw new MissingCapability(capability);
}

// SQLite remains required, but its failure must not hide independent blockers.
const sqlite = await check('sqlite', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT); SAVEPOINT probe_write');
    database.prepare('INSERT INTO probe VALUES (?, ?)').run(1, 'isolated');
    database.exec('ROLLBACK TO probe_write; RELEASE probe_write');
    requireValue(database.prepare('SELECT count(*) AS count FROM probe').get().count === 0);
    requireValue(database.prepare("SELECT json_extract(?, '$.value') AS value").get('{"value":"ok"}').value === 'ok');
    const inserted = database.prepare('INSERT INTO probe(value) VALUES (?) RETURNING id,value').get('bound');
    requireValue(inserted.id === 1 && inserted.value === 'bound', 'sqlite.returning');
    requireValue([...database.prepare('SELECT value FROM probe ORDER BY id').iterate()][0].value === 'bound', 'sqlite.iterate');
    requireValue(database.prepare('UPDATE probe SET value=? WHERE id=?').run('changed', 1).changes === 1, 'sqlite.changes');
    requireValue(database.prepare('SELECT value FROM json_each(?) ORDER BY value').all('[2,1]').map(row => row.value).join(',') === '1,2', 'sqlite.json_each');
    database.exec('DELETE FROM probe');
    database.prepare('INSERT INTO probe VALUES (?, ?)').run(2, 'second');
    database.prepare('INSERT INTO probe VALUES (?, ?)').run(1, 'first');
    const ordered = [];
    for (const row of database.prepare('SELECT id, value FROM probe ORDER BY id').iterate()) {
      ordered.push([row.id, row.value]);
    }
    requireValue(JSON.stringify(ordered) === '[[1,"first"],[2,"second"]]', 'sqlite.iterate-order');
  } finally { database.close(); }
});
await check('crypto', async () => {
  const { createHash, randomInt, randomUUID, webcrypto } = await import('node:crypto');
  requireValue(typeof randomInt === 'function', 'crypto.randomInt');
  requireValue(createHash('sha256').update('probe').digest('hex').length === 64);
  requireValue(randomUUID().length === 36 && randomInt(1, 2) === 1);
  requireValue((await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('probe'))).byteLength === 32);
  requireValue(typeof (await import('jose')).decodeJwt === 'function');
});
await check('networking', async () => {
  const tls = await import('node:tls');
  const https = await import('node:https');
  requireValue(typeof tls.connect === 'function' && typeof https.request === 'function');
  requireValue(typeof fetch === 'function' && typeof WebSocket === 'function' && typeof AbortSignal.timeout === 'function');
});
await check('intl', () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Bahia', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date('2026-01-01T03:00:00Z'));
  requireValue(parts.find(part => part.type === 'hour')?.value === '00', 'intl.timezone-options');
  const ny = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
  requireValue(ny.format(new Date('2026-01-01T00:00:00Z')) === '19', 'intl.timezone-winter');
  requireValue(ny.format(new Date('2026-07-01T00:00:00Z')) === '20', 'intl.timezone-dst');
});
await check('discord', async () => {
  const { Client, SlashCommandBuilder, ChannelSelectMenuBuilder } = await import('discord.js');
  requireValue(typeof Client.prototype.login === 'function');
  requireValue(new SlashCommandBuilder().setName('probe').setDescription('Runtime probe').toJSON().name === 'probe');
  const channel = new ChannelSelectMenuBuilder().setCustomId('probe').setMinValues(0).setMaxValues(1)
    .setDefaultChannels('123456789012345678').toJSON();
  requireValue(channel.default_values[0].type === 'channel');
});
await check('data', async () => {
  const { Buffer } = await import('node:buffer');
  const { deflateSync, inflateSync } = await import('node:zlib');
  const original = { count: 9007199254740993n, bytes: new Uint8Array([1, 2, 3]) };
  const copy = structuredClone(original);
  copy.bytes[0] = 9;
  requireValue(copy.count === original.count && original.bytes[0] === 1);
  requireValue(inflateSync(deflateSync(Buffer.from('probe'))).toString() === 'probe');
});
const compatible = sqlite && checks.every(result => result.ok);
console.log(JSON.stringify({ compatible, platform: process.platform, arch: process.arch, checks }));
process.exitCode = compatible ? 0 : 1;
