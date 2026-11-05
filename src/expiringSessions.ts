/** A bounded private-session registry; reads never renew a session's deadline. */
export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export const sessionClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
};

export class ExpiringSessions<T> {
  private readonly values = new Map<string, T>();
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = Infinity;
  constructor(private readonly capacity: number, private readonly expiresAt: (value: T) => number,
    private readonly clock: SessionClock = sessionClock) {}

  get size(): number { return this.values.size; }
  entries(): IterableIterator<[string, T]> { return this.values.entries(); }
  get(id: string): T | undefined {
    const value = this.values.get(id);
    if (value && this.expiresAt(value) <= this.clock.now()) { this.delete(id); return undefined; }
    return value;
  }
  set(id: string, value: T): void {
    this.sweep();
    if (!this.values.has(id)) while (this.values.size >= this.capacity) this.values.delete(this.values.keys().next().value!);
    this.values.set(id, value);
    this.schedule();
  }
  delete(id: string): void { if (this.values.delete(id)) this.schedule(); }
  clear(): void { this.values.clear(); this.schedule(); }
  sweep(): void {
    const now = this.clock.now();
    if (this.timer === undefined || now >= this.deadline) {
      for (const [id, value] of this.values) if (this.expiresAt(value) <= now) this.values.delete(id);
    }
    // Explicit sweeps may follow a caller-clock jump. Rearm against that clock
    // even when the earliest logical deadline itself has not changed.
    this.schedule(true);
  }
  private schedule(rearm = false): void {
    let next = Infinity;
    for (const value of this.values.values()) next = Math.min(next, this.expiresAt(value));
    if (!rearm && this.timer !== undefined && next === this.deadline) return;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = next;
    if (next === Infinity) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.sweep();
    }, Math.max(0, next - this.clock.now()));
    this.timer.unref?.();
  }
}
