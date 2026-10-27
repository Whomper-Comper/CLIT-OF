import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LobbyStore } from "../dist/lobby/store.js";
import { LobbyWorker } from "../dist/lobby/worker.js";
function fixture() {
  const sql = new DatabaseSync(":memory:");
  LobbyStore.initialize(sql);
  const s = new LobbyStore(sql);
  let time = 1800000000000;
  const lobby = {
    source: "https://blue.openfront.io",
    id: "a1234567",
    map: "World",
    mode: "Team",
    category: "team",
    players: 12,
    capacity: 100,
    startsAt: time + 600000,
    restricted: false,
  };
  let lobbies = [lobby];
  let dmError = null;
  let beforeDm = null;
  let beforeMember = null;
  let sendDelay = 0;
  const calls = { dm: [], fallback: [], edits: [] };
  const channel = {
    id: "c",
    guildId: "g",
    isTextBased: () => true,
    send: async (p) => {
      calls.fallback.push(p);
      return { id: "fallback", channelId: "c", createdTimestamp: time };
    },
  };
  const member = {
    id: "u",
    user: { bot: false },
    createDM: async () => {
      if (beforeDm) await beforeDm();
      return {
        id: "dm",
        send: async (p) => {
          calls.dm.push(p);
          if (dmError) throw dmError;
          time += sendDelay;
          return {
            id: "message",
            channelId: "dm",
            createdTimestamp: time,
            edit: async (payload) => {
              calls.edits.push(payload);
            },
          };
        },
      };
    },
  };
  const guild = {
    id: "g",
    members: {
      fetch: async () => {
        if (beforeMember) {
          const result = await beforeMember();
          if (result?.user) return result;
        }
        return member;
      },
    },
  };
  const client = {
    guilds: { cache: new Map([["g", guild]]) },
    channels: { fetch: async () => channel },
  };
  s.configure("g", true, "c", time);
  s.watch("g", "u", { name: "World", map: "World" }, time);
  const feed = { snapshot: () => ({ observedAt: time, lobbies }) };
  const worker = new LobbyWorker(client, s, feed, { now: () => time });
  return {
    s,
    sql,
    worker,
    calls,
    lobby,
    channel,
    member,
    now: () => time,
    advance: (ms) => (time += ms),
    setError: (e) => (dmError = e),
    setDmHook: (fn) => (beforeDm = fn),
    setMemberHook: (fn) => (beforeMember = fn),
    setLobbies: (ls) => (lobbies = ls),
    setSendDelay: (ms) => {
      sendDelay = ms;
    },
  };
}
test("successful DM waits for a response, then times out without deleting filters", async () => {
  const f = fixture();
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 1);
  assert.equal(f.calls.fallback.length, 0);
  assert.equal(f.s.search("g", "u").state, "waiting");
  assert.equal(f.s.search("g", "u").deadline, f.now() + 180000);
  assert.match(f.calls.dm[0].content, /3 minutes/);
  assert.equal(
    f.calls.dm[0].components[0].components[0].data.label,
    "Continue searching",
  );
  f.advance(180000);
  await f.worker.tick();
  assert.equal(f.s.search("g", "u").state, "stopped");
  assert.equal(f.s.rules("g", "u").length, 1);
  f.sql.close();
});
test("confirmed blocked DM produces exactly one fallback ping with DM enablement guidance", async () => {
  const f = fixture();
  f.setError(Object.assign(new Error("blocked"), { code: 50007, status: 403 }));
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 1);
  assert.equal(f.calls.fallback.length, 1);
  const p = f.calls.fallback[0];
  assert.match(p.content, /<@u>/);
  assert.match(p.content, /Enable direct messages/);
  assert.deepEqual(p.allowedMentions, {
    parse: [],
    users: ["u"],
    roles: [],
    repliedUser: false,
  });
  assert.equal(f.s.search("g", "u").state, "waiting");
  await f.worker.tick();
  assert.equal(f.calls.fallback.length, 1);
  f.sql.close();
});
test("fallback rechecks channel visibility using the final fresh membership", async () => {
  const f = fixture();
  f.setError(Object.assign(new Error("blocked"), { code: 50007, status: 403 }));
  f.channel.permissionsFor = (member) => ({ has: () => member.canView !== false });
  let checks = 0;
  f.setMemberHook(() => ++checks === 3 ? { ...f.member, canView: false } : f.member);
  await f.worker.tick();
  assert.equal(f.calls.fallback.length, 0);
  assert.equal(f.s.search("g", "u").state, "stopped");
  assert.match(f.s.diagnostics("g")[0].error, /cannot view/i);
  f.sql.close();
});
test("uncertain DM outcome stops searching for review instead of publicly pinging or retrying", async () => {
  const f = fixture();
  f.setError(new Error("socket timeout"));
  await f.worker.tick();
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 1);
  assert.equal(f.calls.fallback.length, 0);
  assert.equal(f.s.search("g", "u").state, "stopped");
  assert.equal(f.s.diagnostics("g").length, 1);
  f.sql.close();
});
test("settings revoked while opening DM prevent send", async () => {
  const f = fixture();
  f.setDmHook(() => f.s.configure("g", false, "c", f.now()));
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 0);
  assert.equal(f.calls.fallback.length, 0);
  f.sql.close();
});
test("a lobby that disappears during membership lookup does not send or leave a search stuck", async () => {
  const f = fixture();
  f.setMemberHook(() => f.setLobbies([]));
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 0);
  assert.equal(f.s.search("g", "u").state, "searching");
  f.sql.close();
});
test("persisted sending state after interruption is held for review without a duplicate", async () => {
  const f = fixture();
  const n = f.s.select("g", "u", f.lobby, f.now());
  f.s.begin(n.id, false, f.now());
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 0);
  assert.equal(f.s.notification(n.id).status, "review");
  assert.equal(f.s.search("g", "u").state, "stopped");
  f.sql.close();
});
test("blocked DM creation also triggers fallback, rather than endlessly retrying DM creation", async () => {
  const f = fixture();
  f.setDmHook(() => {
    throw Object.assign(new Error("blocked"), { code: 50007, status: 403 });
  });
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 0);
  assert.equal(f.calls.fallback.length, 1);
  assert.equal(f.s.search("g", "u").state, "waiting");
  f.sql.close();
});
test("membership removal during DM creation prevents delivery", async () => {
  const f = fixture();
  let checks = 0;
  f.setMemberHook(() => {
    if (++checks > 1) throw Object.assign(new Error("gone"), { code: 10007 });
  });
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 0);
  assert.equal(f.s.search("g", "u").state, "stopped");
  f.sql.close();
});
for (const staleResult of ["unknown member", "bot member"]) {
  test(`a stale ${staleResult} lookup cannot stop a resumed search`, async () => {
    const f = fixture();
    let entered, release;
    const waiting = new Promise((resolve) => { entered = resolve; });
    const resumed = new Promise((resolve) => { release = resolve; });
    f.setMemberHook(async () => {
      entered();
      await resumed;
      if (staleResult === "unknown member") throw Object.assign(new Error("gone"), { code: 10007 });
      return { ...f.member, user: { bot: true } };
    });
    const tick = f.worker.tick();
    await waiting;
    f.s.resume("g", "u", f.now());
    const generation = f.s.search("g", "u").generation;
    release();
    await tick;
    assert.equal(f.s.search("g", "u").generation, generation);
    assert.equal(f.s.search("g", "u").state, "searching");
    assert.equal(f.calls.dm.length, 0);
    f.sql.close();
  });
}
test("stop drains an in-flight DM without allowing another candidate to send", async () => {
  const f = fixture();
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const wait = new Promise((r) => (release = r));
  f.setDmHook(async () => {
    entered();
    await wait;
  });
  const running = f.worker.tick();
  await ready;
  const stopping = f.worker.stop();
  release();
  await Promise.all([running, stopping]);
  assert.equal(f.calls.dm.length, 0);
  f.sql.close();
});
test("definite rate rejection retries while valid, but only one member alert is active", async () => {
  const f = fixture();
  f.setError(Object.assign(new Error("rate limit"), { status: 429 }));
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 1);
  assert.equal(f.s.search("g", "u").state, "delivering");
  f.advance(5000);
  f.setError(null);
  await f.worker.tick();
  assert.equal(f.calls.dm.length, 2);
  assert.equal(f.s.search("g", "u").state, "waiting");
  f.sql.close();
});

test("alerts link to the official game route", async () => {
  const f = fixture();
  await f.worker.tick();
  assert.match(
    f.calls.dm[0].embeds[0].data.description,
    /https:\/\/openfront\.io\/game\/a1234567/,
  );
  f.sql.close();
});

test("a delayed accepted send displays the actual delivery-based deadline without repinging", async () => {
  const f = fixture();
  f.setSendDelay(65000);
  await f.worker.tick();
  assert.equal(f.s.search("g", "u").deadline, f.now() + 180000);
  assert.doesNotMatch(f.calls.dm[0].content, /Deadline:/);
  assert.match(
    f.calls.edits[0].content,
    new RegExp(`<t:${Math.floor((f.now() + 180000) / 1000)}:R>`),
  );
  assert.deepEqual(f.calls.edits[0].allowedMentions, { parse: [] });
  f.sql.close();
});
