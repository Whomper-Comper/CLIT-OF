import { setTimeout as delay } from "node:timers/promises";

/** One shared lane for role writes, in addition to discord.js's HTTP bucket handling. */
export class PacedQueue {
  private pending: { task: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; priority: number; guild: string }[] = [];
  private running = false;
  private lastGuild = new Map<number, string>();
  private nextAt = 0;
  constructor(private spacingMs = 1000, private sleep = delay, private now = Date.now) {}
  run<T>(task: () => Promise<T>, options: { priority?: number; guildId?: string } = {}): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.pending.push({ task, resolve: (value) => resolve(value as T), reject,
        priority: options.priority ?? 0, guild: options.guildId ?? "" });
    });
    if (!this.running) {
      this.running = true;
      // Let work submitted together compete by priority before the first write.
      void Promise.resolve().then(() => this.drain());
    }
    return result;
  }
  private async drain() {
    while (this.pending.length) {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      // Choose after waiting so a newly queued unlink can overtake ordinary sync.
      const priority = Math.max(...this.pending.map((entry) => entry.priority));
      const guilds = [...new Set(this.pending.filter((entry) => entry.priority === priority).map((entry) => entry.guild))].sort();
      const previous = this.lastGuild.get(priority);
      const guild = guilds.find((candidate) => previous === undefined || candidate > previous) ?? guilds[0];
      const index = this.pending.findIndex((entry) => entry.priority === priority && entry.guild === guild);
      const [entry] = this.pending.splice(index, 1);
      this.lastGuild.set(priority, guild);
      try { entry.resolve(await entry.task()); }
      catch (error) { entry.reject(error); }
      finally { this.nextAt = this.now() + this.spacingMs; }
    }
    this.running = false;
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
  constructor(private readonly maximumEntries = Infinity) {}
  take(key: string, milliseconds: number, now = Date.now()): boolean {
    for (const [id, expiry] of this.until) if (expiry <= now) this.until.delete(id);
    if ((this.until.get(key) ?? 0) > now) return false;
    if (this.until.size >= this.maximumEntries) return false;
    this.until.set(key, now + milliseconds);
    return true;
  }
}
