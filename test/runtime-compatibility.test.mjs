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

test('runtime preflight reports independent capabilities even when SQLite and crypto imports fail', () => {
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier === 'node:sqlite' || specifier === 'node:crypto') return {
      url: 'data:text/javascript,' + encodeURIComponent('throw new TypeError("private-runtime-error-do-not-print")'), shortCircuit: true,
    };
    return next(specifier, context);
  }`;
  const preload = `import { register } from 'node:module';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'tools/check-runtime.mjs'], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, DISCORD_TOKEN: '', CLIENT_ID: '', DB_PATH: 'never-open-this-production-database.db' },
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.compatible, false);
  assert.equal(report.checks.find(check => check.name === 'sqlite')?.ok, false);
  assert.equal(report.checks.find(check => check.name === 'crypto')?.ok, false);
  assert.equal(report.checks.find(check => check.name === 'intl')?.ok, true);
  assert.equal(report.checks.find(check => check.name === 'data')?.ok, true);
  assert.doesNotMatch(result.stdout + result.stderr, /private-runtime-error-do-not-print|never-open-this-production-database/);
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
  assert.deepEqual(report.checks.find(check => check.name === 'sqlite'), { name: 'sqlite', ok: false, error: 'TypeError' });
  for (const name of ['crypto', 'networking', 'intl', 'discord', 'data']) {
    assert.equal(report.checks.find(check => check.name === name)?.ok, true, name);
  }
  assert.equal(result.stdout.includes('never-open-this-production-database'), false);
});
