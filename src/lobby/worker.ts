import type { Client, Message } from "discord.js";
import { matches, type Lobby, type LobbySnapshot } from "./model.js";
import { LobbyStore, type Notification } from "./store.js";
import { alertMessage } from "./messages.js";
interface Feed {
  snapshot(): LobbySnapshot | null;
}
class BudgetExhausted extends Error {}
const errorCode = (e: unknown) =>
  Number(e && typeof e === "object" && "code" in e ? e.code : 0);
const status = (e: unknown) =>
  Number(e && typeof e === "object" && "status" in e ? e.status : 0);
/** Independent durable DM/fallback lane: guild-only community deliveries never receive DM channels. */
export class LobbyWorker {
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;
  constructor(
    private readonly client: Client,
    private readonly store: LobbyStore,
    private readonly feed: Feed,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        console.warn("[Lobby] Worker failed; work remains persisted."),
      );
    }, 2000);
    this.timer.unref?.();
    void this.tick().catch(() =>
      console.warn("[Lobby] Worker failed; work remains persisted."),
    );
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  private current(n: Notification): Lobby | null {
    if (this.stopped || !this.store.valid(n)) return null;
    const snapshot = this.feed.snapshot();
    if (!snapshot || this.now() - snapshot.observedAt >= 30000) return null;
    const lobby = snapshot.lobbies.find(
      (l) => l.id === n.lobby.id && l.source === n.lobby.source,
    );
    return lobby &&
      this.store
        .rules(n.guild, n.user)
        .some((r) => matches(r, lobby, this.now()))
      ? lobby
      : null;
  }
  private async delivered(
    n: Notification,
    lobby: Lobby,
    message: Message,
    channel: string,
    fallback: boolean,
    request: () => void,
  ): Promise<void> {
    this.store.delivered(n.id, channel, message.id, message.createdTimestamp);
    // Stamp the deadline only once Discord supplies the actual creation time.
    // If this cosmetic edit fails, the original three-minute instruction remains accurate.
    if (
      typeof message.edit !== "function" ||
      this.store.search(n.guild, n.user)?.pending !== n.id
    )
      return;
    try {
      request();
      await message.edit({
        content: alertMessage(
          { ...n, lobby },
          message.createdTimestamp,
          fallback,
        ).content,
        allowedMentions: { parse: [] },
      });
    } catch {
      /* The persisted deadline and single-use control remain authoritative. */
    }
  }
  private async run(): Promise<void> {
    const now = this.now();
    this.store.expire(now);
    const snapshot = this.feed.snapshot();
    this.store.prune(now, snapshot?.lobbies ?? []);
    if (snapshot && now - snapshot.observedAt < 30000)
      for (const s of this.store.candidates(20, now)) {
        const rules = this.store.rules(s.guild, s.user);
        const matching = snapshot.lobbies.filter((l) =>
          rules.some((rule) => matches(rule, l, now)),
        );
        const handled = this.store.handledLobbies(s.guild, s.user, matching);
        for (const l of matching)
          if (
            !handled.has(JSON.stringify([l.source, l.id])) &&
            this.store.select(s.guild, s.user, l, now)
          )
            break;
      }
    let requests = 8,
      sends = 4;
    const request = () => {
      if (this.stopped || requests <= 0) throw new BudgetExhausted();
      requests--;
    };
    const send = () => {
      if (sends <= 0) throw new BudgetExhausted();
      request();
      sends--;
    };
    for (const n of this.store.due(this.now())) {
      if (this.stopped) break;
      if (n.status.startsWith("sending_")) {
        this.store.review(
          n.id,
          "Delivery was interrupted with an uncertain outcome. Search stopped to avoid duplicate alerts.",
          this.now(),
        );
        continue;
      }
      if (!this.current(n)) {
        this.store.obsolete(n.id, this.now());
        continue;
      }
      let attempted = false;
      let fallback = n.status === "pending_fallback";
      try {
        const guild = this.client.guilds.cache.get(n.guild);
        if (!guild) {
          this.store.stop(n.guild, n.user, this.now());
          this.store.obsolete(n.id, this.now());
          continue;
        }
        request();
        const member = await guild.members.fetch({ user: n.user, force: true });
        if (member.user.bot) {
          this.store.stop(n.guild, n.user, this.now());
          continue;
        }
        if (!this.current(n)) {
          this.store.obsolete(n.id, this.now());
          continue;
        }
        if (!fallback) {
          try {
            request();
            const dm = await member.createDM();
            request();
            await guild.members.fetch({ user: n.user, force: true });
            const lobby = this.current(n);
            if (!lobby) {
              this.store.obsolete(n.id, this.now());
              continue;
            }
            send();
            if (!this.store.begin(n.id, false, this.now())) continue;
            attempted = true;
            const message = await dm.send(
              alertMessage({ ...n, lobby }, null, false),
            );
            await this.delivered(n, lobby, message, dm.id, false, request);
            continue;
          } catch (e) {
            if (errorCode(e) !== 50007) throw e;
            attempted = false;
            this.store.rejected(n.id, this.now());
            fallback = true;
          }
        }
        if (!this.current(n)) {
          this.store.obsolete(n.id, this.now());
          continue;
        }
        const target = this.store.settings(n.guild).channel;
        if (!target) {
          this.store.review(
            n.id,
            "No fallback channel is configured.",
            this.now(),
          );
          continue;
        }
        request();
        const channel = await this.client.channels.fetch(target);
        if (
          !channel ||
          !("guildId" in channel) ||
          channel.guildId !== n.guild ||
          !channel.isTextBased() ||
          !("send" in channel)
        ) {
          this.store.review(
            n.id,
            "The fallback channel is unavailable. Configure lobby alerts again.",
            this.now(),
          );
          continue;
        }
        if (
          "permissionsFor" in channel &&
          typeof channel.permissionsFor === "function" &&
          !channel.permissionsFor(member)?.has("ViewChannel")
        ) {
          this.store.review(
            n.id,
            "The member cannot view the fallback channel.",
            this.now(),
          );
          continue;
        }
        // Force a final membership lookup after DM/channel awaits, then synchronously recheck state.
        request();
        const freshMember = await guild.members.fetch({ user: n.user, force: true });
        if (
          "permissionsFor" in channel &&
          typeof channel.permissionsFor === "function" &&
          !channel.permissionsFor(freshMember)?.has("ViewChannel")
        ) {
          this.store.review(
            n.id,
            "The member cannot view the fallback channel.",
            this.now(),
          );
          continue;
        }
        const lobby = this.current(n);
        if (!lobby) {
          this.store.obsolete(n.id, this.now());
          continue;
        }
        send();
        if (!this.store.begin(n.id, true, this.now())) continue;
        attempted = true;
        const message = await channel.send(
          alertMessage({ ...n, lobby }, null, true),
        );
        await this.delivered(n, lobby, message, channel.id, true, request);
      } catch (e) {
        if (e instanceof BudgetExhausted) continue;
        if (errorCode(e) === 10007) {
          this.store.stop(n.guild, n.user, this.now());
          this.store.obsolete(n.id, this.now());
          continue;
        }
        if (!attempted) {
          this.store.retry(
            n.id,
            "Discord lookup failed before delivery.",
            this.now(),
          );
          continue;
        }
        if (status(e) === 429) {
          this.store.retry(n.id, "Discord rate limited delivery.", this.now());
          continue;
        }
        // A 5xx or transport timeout may follow a successful POST: never retry/fallback automatically.
        this.store.review(
          n.id,
          status(e) >= 400 && status(e) < 500
            ? "Discord rejected delivery. Check member/channel permissions."
            : "Delivery outcome is uncertain. Search stopped to avoid duplicate alerts.",
          this.now(),
        );
      }
    }
  }
}
