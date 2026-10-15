import { setTimeout as delay } from "node:timers/promises";

/** One shared lane for role writes, in addition to discord.js's HTTP bucket handling. */
export class PacedQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private nextAt = 0;
  constructor(private spacingMs = 1000, private sleep = delay, private now = Date.now) {}
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      try { return await task(); }
      finally { this.nextAt = this.now() + this.spacingMs; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

export class MemberLocks {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
    this.tails.set(key, result);
    void result.finally(() => { if (this.tails.get(key) === result) this.tails.delete(key); }).catch(() => {});
    return result;
  }
}

/** Reject bursts before expensive API work; idle entries are discarded. */
export class CommandLimits {
  private until = new Map<string, number>();
  take(key: string, milliseconds: number, now = Date.now()): boolean {
    for (const [id, expiry] of this.until) if (expiry <= now) this.until.delete(id);
    if ((this.until.get(key) ?? 0) > now) return false;
    this.until.set(key, now + milliseconds);
    return true;
  }
}
