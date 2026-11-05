import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('runtime preflight verifies required APIs without loading bot configuration or contacting services', () => {
  const result = spawnSync(process.execPath, ['tools/check-runtime.mjs'], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, DISCORD_TOKEN: '', CLIENT_ID: '', DB_PATH: 'never-open-this-production-database.db' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, true);
  for (const name of ['sqlite', 'crypto', 'networking', 'intl', 'discord', 'data']) {
    assert.equal(report.checks.find(check => check.name === name)?.ok, true, name);
  }
  assert.equal(result.stdout.includes('never-open-this-production-database'), false);
  assert.equal(result.stdout.includes('DISCORD_TOKEN'), false);
});

test('runtime preflight rejects SQLite without the ordered iterator required by weekly readers', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent(
    "import { StatementSync } from 'node:sqlite'; StatementSync.prototype.iterate = undefined;",
  );
  const result = spawnSync(process.execPath, ['--import', preload, 'tools/check-runtime.mjs'], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, DISCORD_TOKEN: '', CLIENT_ID: '', DB_PATH: 'never-open-this-production-database.db' },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, false);
  assert.deepEqual(report.checks, [{ name: 'sqlite', ok: false, error: 'TypeError' }]);
  assert.equal(result.stdout.includes('never-open-this-production-database'), false);
});
