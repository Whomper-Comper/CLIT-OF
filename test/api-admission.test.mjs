import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { OpenFrontApi, OpenFrontApiError } = await import("../dist/api.js");
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const profile = () => ({ username: "Player", clans: [{ tag: "TEST", name: "Test", role: "member" }], stats: { nested: [1] } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const busy = (error) => error instanceof OpenFrontApiError && error.reason === "busy";
const queueTimeout = (error) => error instanceof OpenFrontApiError && error.reason === "queue_timeout";

test("private loader ownership keeps exactly one defensive clone per initial, shared and cached caller", async (t) => {
  let calls = 0, clones = 0;
  const gate = deferred(), clone = globalThis.structuredClone;
  t.mock.method(globalThis, "fetch", async () => { calls++; await gate.promise; return response(profile()); });
  t.mock.method(globalThis, "structuredClone", (value) => { clones++; return clone(value); });
  const api = new OpenFrontApi("https://example.invalid");
  const first = api.getPlayerProfile("player"), second = api.getPlayerProfile("player");
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(clones, 2);
  a.stats.nested[0] = 9; a.clans[0].tag = "MUTATED";
  assert.equal(b.stats.nested[0], 1); assert.equal(b.clans[0].tag, "TEST");
  b.stats.nested.push(2); b.clans.length = 0;
  const cached = await api.getPlayerProfile("player");
  assert.deepEqual(cached, profile());
  assert.equal(clones, 3); assert.equal(calls, 1);
  const uncached = new OpenFrontApi("https://example.invalid", { maxCacheEntries: 0 });
  await uncached.getPlayerProfile("player");
  assert.equal(clones, 4);
  assert.equal(uncached.cache.size, 0);
});

test("200 distinct requests admit eight, queue 64, reject excess, and drain in FIFO order", async (t) => {
  const gates = [], started = [];
  let active = 0, peak = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    started.push(url.split("/").at(-1)); active++; peak = Math.max(peak, active);
    const gate = deferred(); gates.push(gate);
    return { ok: true, status: 200, json: async () => { await gate.promise; active--; return profile(); } };
  });
  const api = new OpenFrontApi("https://example.invalid");
  const reads = Array.from({ length: 200 }, (_, i) => api.getPlayerProfile(`player-${i}`).then(() => "ok", (error) => { assert.ok(busy(error)); return "busy"; }));
  await flush();
  assert.equal(started.length, 8); assert.equal(api.pending.size, 72);
  for (let i = 0; i < 72; i++) { gates[i].resolve(); await flush(); }
  const results = await Promise.all(reads);
  assert.equal(results.filter((value) => value === "ok").length, 72);
  assert.equal(results.filter((value) => value === "busy").length, 128);
  assert.equal(peak, 8);
  assert.deepEqual(started, Array.from({ length: 72 }, (_, i) => `player-${i}`));
  assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
  const retry = api.getPlayerProfile("player-199");
  gates[72].resolve(); await retry;
});

test("queue overflow and exact absolute deadline never fetch, clear timers and allow retry", async (t) => {
  let now = 0, calls = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  const gate = deferred();
  t.mock.method(globalThis, "fetch", async () => { calls++; await gate.promise; return response(profile()); });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1, maxQueuedRequests: 1, queueTimeoutMs: 20 });
  const first = api.getPlayerProfile("first");
  const queued = api.getPlayerProfile("queued");
  const expired = assert.rejects(queued, queueTimeout);
  await assert.rejects(api.getPlayerProfile("overflow"), busy);
  assert.equal(calls, 1);
  now = 20;
  // Releasing at the boundary must reject even when the timer callback has not run.
  gate.resolve(); await first; await expired;
  assert.equal(calls, 1);
  assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
  await api.getPlayerProfile("queued");
  assert.equal(calls, 2);
  t.mock.timers.tick(100);
});

test("waiting requests expire and remove their pending keys while the active body is blocked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return { ok: true, status: 200, json: async () => { await gate.promise; return profile(); } }; });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1, queueTimeoutMs: 10 });
  const first = api.getPlayerProfile("first"), second = api.getPlayerProfile("second");
  const expired = assert.rejects(second, queueTimeout);
  t.mock.timers.tick(10); await expired;
  assert.equal(calls, 1); assert.equal(api.pending.size, 1); assert.equal(api.generations.size, 1);
  gate.resolve(); await first;
});

test("ordinary readers share admission while fresh reads stay distinct and latest invocation owns cache", async (t) => {
  const gates = [], started = [];
  t.mock.method(globalThis, "fetch", async (url) => { const gate = deferred(); gates.push(gate); started.push(url); return gate.promise; });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 2, maxQueuedRequests: 10 });
  const old = api.getPlayerProfile("same"), shared = api.getPlayerProfile("same");
  const newer = api.getPlayerProfile("same", { fresh: true });
  const newest = api.getPlayerProfile("same", { fresh: true });
  assert.equal(started.length, 2);
  gates[1].resolve(response({ username: "newer" })); await newer; await flush();
  assert.equal(started.length, 3);
  gates[2].resolve(response({ username: "newest" })); await newest;
  gates[0].resolve(response({ username: "old" })); await Promise.all([old, shared]);
  assert.equal((await api.getPlayerProfile("same")).username, "newest");
  assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
});

test("200 ordinary same-key readers share one slot even when no wait queue is allowed", async (t) => {
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; await gate.promise; return response(profile()); });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1, maxQueuedRequests: 0 });
  const reads = Array.from({ length: 200 }, () => api.getPlayerProfile("same"));
  assert.equal(calls, 1); gate.resolve();
  const results = await Promise.all(reads);
  results[0].stats.nested[0] = 9;
  assert.equal(results[199].stats.nested[0], 1);
  assert.equal(calls, 1); assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
});

test("constructor rejects invalid admission bounds", () => {
  for (const options of [{ maxActiveRequests: 0 }, { maxActiveRequests: NaN }, { maxActiveRequests: 1.5 },
    { maxQueuedRequests: -1 }, { maxQueuedRequests: Infinity }, { queueTimeoutMs: 0 }, { queueTimeoutMs: NaN },
    { queueTimeoutMs: 2_147_483_648 }]) {
    assert.throws(() => new OpenFrontApi("https://example.invalid", options), RangeError);
  }
});

test("disabled caches still clone every coalesced caller and preserve nested mutation isolation", async (t) => {
  const clone = globalThis.structuredClone;
  for (const options of [{ maxCacheEntries: 0 }, { cacheTtlMs: 0 }]) {
    let calls = 0, clones = 0; const gate = deferred();
    t.mock.method(globalThis, "fetch", async () => { calls++; await gate.promise; return response(profile()); });
    t.mock.method(globalThis, "structuredClone", value => { clones++; return clone(value); });
    const api = new OpenFrontApi("https://example.invalid", options);
    const first = api.getPlayerProfile("same"), second = api.getPlayerProfile("same");
    gate.resolve(); const [a, b] = await Promise.all([first, second]);
    assert.equal(clones, 2); assert.equal(calls, 1); assert.equal(api.cache.size, 0);
    a.stats.nested.length = 0; a.clans[0].name = "mutated";
    assert.deepEqual(b, profile());
    b.stats.nested[0] = 2;
    assert.deepEqual(await api.getPlayerProfile("same"), profile());
    assert.equal(clones, 3); assert.equal(calls, 2);
  }
});

test("history callers own nested copies while null results retain caching and clone counts", async (t) => {
  const game = { gameId: "game", start: "2026-10-15T03:00:00+03:00", durationSeconds: 10, map: "World", mode: "Team",
    type: "Public", playerTeams: null, rankedType: "unranked", result: "victory", totalPlayers: 4, username: "Player", clanTag: "TEST" };
  let clones = 0, calls = 0; const gate = deferred(), clone = globalThis.structuredClone;
  t.mock.method(globalThis, "structuredClone", value => { clones++; return clone(value); });
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++; await gate.promise;
    return url.includes("/games") ? response({ results: [game], nextCursor: null }) : response({}, 404);
  });
  const api = new OpenFrontApi("https://example.invalid");
  const first = api.getPlayerGames("player"), second = api.getPlayerGames("player");
  gate.resolve(); const [a, b] = await Promise.all([first, second]);
  assert.equal(clones, 2); a.results[0].username = "mutated";
  assert.equal(b.results[0].username, "Player"); assert.equal(b.results[0].start, "2026-10-15T00:00:00.000Z");
  b.results.length = 0;
  assert.equal((await api.getPlayerGames("player")).results.length, 1);
  assert.equal(clones, 3); assert.equal(calls, 1);
  assert.equal(await api.getPlayerProfile("missing"), null);
  assert.equal(await api.getPlayerProfile("missing"), null);
  assert.equal(clones, 5); assert.equal(calls, 2);
});

test("a zero-capacity wait queue rejects immediately and default deadline expires at 2000ms", async (t) => {
  const gate = deferred(); let calls = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async () => { calls++; await gate.promise; return response(profile()); });
  const immediate = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1, maxQueuedRequests: 0 });
  const first = immediate.getPlayerProfile("first");
  await assert.rejects(immediate.getPlayerProfile("overflow"), busy);
  assert.equal(immediate.pending.size, 1); assert.equal(immediate.generations.size, 1);
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1 });
  const active = api.getPlayerProfile("active");
  let settled = false;
  const waiting = assert.rejects(api.getPlayerProfile("waiting"), queueTimeout).then(() => { settled = true; });
  t.mock.timers.tick(1999); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); await waiting; assert.equal(calls, 2);
  gate.resolve(); await Promise.all([first, active]);
});

test("HTTP errors and 404s retain admission until their discarded bodies finish", async (t) => {
  for (const status of [503, 404]) {
    let calls = 0; const gate = deferred();
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) return { ok: false, status, body: { cancel: () => gate.promise } };
      return response(profile());
    });
    const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1 });
    const first = api.getPlayerProfile("first");
    const checked = status === 503 ? assert.rejects(first, (error) => error.reason === "http" && error.status === 503) : first;
    const second = api.getPlayerProfile("second");
    await flush(); assert.equal(calls, 1);
    gate.resolve(); await checked;
    if (status === 404) assert.equal(await first, null);
    assert.equal((await second).username, "Player");
    assert.equal(calls, 2);
  }
});

test("fetch, body, JSON, validation and normalization failures release queued work and permit retry", async (t) => {
  const failures = [
    { reason: "network", fetch: () => { throw new Error("offline"); } },
    { reason: "timeout", fetch: () => { throw new DOMException("aborted", "TimeoutError"); } },
    { reason: "timeout", body: () => { throw new DOMException("aborted", "AbortError"); } },
    { reason: "invalid_response", body: () => { throw new SyntaxError("JSON"); } },
    { reason: "invalid_response", body: () => [] },
  ];
  for (const failure of failures) {
    let calls = 0; const gate = deferred();
    t.mock.method(globalThis, "fetch", async () => {
      if (++calls !== 1) return response(profile());
      await gate.promise;
      if (failure.fetch) return failure.fetch();
      return { ok: true, status: 200, json: failure.body };
    });
    const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1 });
    const first = api.getPlayerProfile("first");
    const checked = assert.rejects(first, (error) => error instanceof OpenFrontApiError && error.reason === failure.reason);
    const second = api.getPlayerProfile("second");
    assert.equal(calls, 1); gate.resolve(); await checked;
    assert.equal((await second).username, "Player");
    assert.equal((await api.getPlayerProfile("first")).username, "Player");
    assert.equal(calls, 3); assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
  }
  const gate = deferred(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls !== 1) return response(profile());
    await gate.promise;
    return { ok: true, status: 200, json: async () => [{ publicId: "deleted", deletedAt: "2026-10-16T00:00:00Z" }] };
  });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1 });
  const original = Date.prototype.toISOString;
  t.mock.method(Date.prototype, "toISOString", function () { throw new RangeError("normalize"); });
  const first = api.getRecentlyDeletedPlayers(), second = api.getPlayerProfile("second");
  const checked = assert.rejects(first, /normalize/);
  gate.resolve(); await checked;
  Date.prototype.toISOString = original;
  assert.equal((await second).username, "Player");
  assert.equal(calls, 2); assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
});

test("mixed endpoint work drains FIFO while token audience retries retain one bounded slot", async (t) => {
  const started = [], gates = [];
  let tokenCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const gate = deferred(); gates.push(gate);
    if (url.includes("identity_token")) {
      started.push(JSON.parse(options.body).audience);
      if (++tokenCalls < 3) return { ok: false, status: 401, body: { cancel: () => gate.promise } };
      return { ok: true, status: 200, json: async () => { await gate.promise; return { publicId: "verified" }; } };
    }
    started.push(url.replace("https://example.invalid", ""));
    return { ok: true, status: 200, json: async () => {
      await gate.promise;
      if (url.includes("recently-deleted")) return [];
      if (url.includes("leaderboard")) return { "1v1": [] };
      if (url.includes("/games")) return { results: [], nextCursor: null };
      if (url.includes("/clan/")) return { tag: "TEST", name: "Test", description: "" };
      return profile();
    } };
  });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1, maxQueuedRequests: 5 });
  const token = `e30.${Buffer.from(JSON.stringify({ aud: "custom" })).toString("base64url")}.signature`;
  const reads = [api.verifyIdentityToken(token), api.getPlayerProfile("interactive"), api.getClanInfo("test"),
    api.getPlayerGames("coverage"), api.getRecentlyDeletedPlayers(), api.getRankedLeaderboardPage()];
  assert.equal(started.length, 1);
  for (let i = 0; i < 8; i++) { await flush(); assert.equal(started.length, i + 1); gates[i].resolve(); }
  const results = await Promise.all(reads);
  assert.equal(results[0], "verified");
  assert.deepEqual(started, ["custom", "ofstats.io", "trackerfront.io", "/public/player/interactive", "/public/clan/TEST",
    "/public/player/coverage/games", "/public/players/recently-deleted", "/leaderboard/ranked?page=1"]);
  assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
});

test("fresh same-key burst stays distinct and admission rejection cannot revive stale cache", async (t) => {
  const gates = []; let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; const gate = deferred(); gates.push(gate); return gate.promise; });
  const api = new OpenFrontApi("https://example.invalid");
  const reads = Array.from({ length: 200 }, () => api.getPlayerProfile("same", { fresh: true }).then(value => value, error => { assert.ok(busy(error)); return null; }));
  await flush(); assert.equal(calls, 8);
  for (let i = 0; i < 72; i++) { gates[i].resolve(response({ username: `generation-${i}` })); await flush(); }
  const results = await Promise.all(reads);
  assert.equal(results.filter(Boolean).length, 72); assert.equal(calls, 72);
  assert.equal(api.cache.size, 0, "the newest rejected invocation still invalidates older generations");
  assert.equal(api.pending.size, 0); assert.equal(api.generations.size, 0);
  const retry = api.getPlayerProfile("same"); gates[72].resolve(response({ username: "retry" }));
  assert.equal((await retry).username, "retry");
  assert.equal((await api.getPlayerProfile("same")).username, "retry");
});

test("queue timers are unreferenced and cancelled after successful admission", async (t) => {
  const timers = [], cleared = [], gate = deferred();
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { const timer = schedule(callback, delay); timers.push({ timer, delay }); return timer; });
  t.mock.method(globalThis, "clearTimeout", (timer) => { cleared.push(timer); return cancel(timer); });
  t.mock.method(globalThis, "fetch", async () => { await gate.promise; return response(profile()); });
  const api = new OpenFrontApi("https://example.invalid", { maxActiveRequests: 1 });
  const first = api.getPlayerProfile("first"), second = api.getPlayerProfile("second");
  assert.equal(timers.length, 1); assert.equal(timers[0].delay, 2000);
  assert.equal(timers[0].timer.hasRef(), false);
  gate.resolve(); await Promise.all([first, second]);
  assert.ok(cleared.includes(timers[0].timer));
});

test("maximum-size deletion feed uses one clone on miss and retains isolated cache results", async (t) => {
  const rows = Array.from({ length: 100_000 }, (_, i) => ({ publicId: `synthetic-${i}`, deletedAt: "2026-11-01T00:00:00.000Z" }));
  let clones = 0, calls = 0; const clone = globalThis.structuredClone;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(rows); });
  t.mock.method(globalThis, "structuredClone", (value) => { clones++; return clone(value); });
  const api = new OpenFrontApi("https://example.invalid");
  const deleted = await api.getRecentlyDeletedPlayers();
  assert.equal(clones, 1); assert.equal(deleted.length, 100_000);
  deleted[0].publicId = "mutated";
  const cached = await api.getRecentlyDeletedPlayers();
  assert.equal(cached[0].publicId, "synthetic-0"); assert.equal(clones, 2); assert.equal(calls, 1);
  t.diagnostic(`${process.version} ${process.platform}/${process.arch}: ${rows.length} deletion rows, ${Buffer.byteLength(JSON.stringify(rows))} JSON bytes; miss=1 clone, cache hit=1 clone.`);
});
