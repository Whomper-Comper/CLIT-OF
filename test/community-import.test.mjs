import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('community stores import before the database singleton and preserve CommandError identity', () => {
  const result = spawnSync(process.execPath, ['--input-type=module','-e', `
    import assert from 'node:assert/strict';
    await import('./dist/community/store.js');
    const direct = await import('./dist/commandError.js');
    const support = await import('./dist/commands/support.js');
    assert.equal(direct.CommandError,support.CommandError);
    assert.ok(new direct.CommandError('x') instanceof support.CommandError);
  `], { encoding:'utf8',env:{...process.env,DB_PATH:':memory:',DISCORD_TOKEN:'test',CLIENT_ID:'test'} });
  assert.equal(result.status,0,result.stderr);
});
