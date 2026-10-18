import type { Client, Message, MessageCreateOptions, MessageEditOptions, TextBasedChannel } from "discord.js";
import type { BotDatabase } from "../db.js";
import type { OpenFrontApi } from "../api.js";
import { deliveryMarker, deliveryNonce } from "./deliveries.js";
import type { CommunityDeliveryHandler, CommunityTick, DeliveryJob } from "./types.js";
import { CommunityBudgetExhaustedError } from "./types.js";
export type { CommunityDeliveryHandler, CommunityTick, PreparedDelivery } from "./types.js";

interface Options { now?: () => number; tickMs?: number; maxRequestsPerTick?: number; maxSendsPerTick?: number }
type DeliveryChannel = TextBasedChannel & { send(payload: MessageCreateOptions): Promise<Message> };
const bounded = (value: number | undefined, fallback: number, maximum: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(1,Math.min(maximum,Math.floor(value)));
class DeliveryPayloadError extends Error {}
function allowedMentions(payload: MessageCreateOptions): MessageCreateOptions['allowedMentions'] {
  const users = payload.allowedMentions?.users;
  if (!users) return { parse: [] };
  return { parse: [], users: [...new Set(users)].filter(id => /^\d{17,20}$/.test(id)).slice(0,100), roles: [], repliedUser: false };
}
function payloadFor(job: DeliveryJob, payload: MessageCreateOptions): MessageCreateOptions {
  const marker = deliveryMarker(job);
  const embeds = (payload.embeds ?? []).map(embed => "toJSON" in embed ? embed.toJSON() : { ...embed });
  let characters = 0;
  const check = (text: string | undefined | null, limit: number): number => {
    if ((text?.length ?? 0) > limit) throw new DeliveryPayloadError("Community message exceeds Discord text limits. Shorten the content or embed fields, then retry.");
    return text?.length ?? 0;
  };
  check(payload.content,2000);
  if (embeds.length > 10) throw new DeliveryPayloadError("Community message has too many embeds. Reduce it to ten embeds, then retry.");
  for (const embed of embeds) {
    characters += check(embed.title,256) + check(embed.description,4096) + check(embed.footer?.text,2048) + check(embed.author?.name,256);
    if ((embed.fields?.length ?? 0) > 25) throw new DeliveryPayloadError("Community embed has too many fields. Reduce it to twenty-five fields, then retry.");
    for (const field of embed.fields ?? []) characters += check(field.name,256) + check(field.value,1024);
  }
  if (characters > 6000) throw new DeliveryPayloadError("Community embeds exceed Discord's combined text limit. Shorten their text, then retry.");
  if (!embeds.length) embeds.push({});
  let content = payload.content;
  const index = embeds.findIndex(embed => {
    const footer = embed.footer?.text ?? "", addition = (footer ? " | " : "") + marker;
    return footer.length + addition.length <= 2048 && characters + addition.length <= 6000;
  });
  if (index >= 0) {
    const embed = embeds[index], footer = embed.footer?.text ?? "";
    embeds[index] = { ...embed, footer: { ...embed.footer, text: footer + (footer ? " | " : "") + marker } };
  } else {
    const addition = (content ? "\n" : "") + marker;
    if ((content?.length ?? 0) + addition.length > 2000) throw new DeliveryPayloadError("No space remains for the recovery marker. Shorten the message content or embed text, then retry.");
    content = (content ?? "") + addition;
  }
  return { ...payload, content, embeds, allowedMentions: allowedMentions(payload), nonce: deliveryNonce(job), enforceNonce: true };
}
/** Only fields valid for editing: never forward a create nonce, tts, reference, poll, etc. */
function editPayload(payload: MessageCreateOptions): MessageEditOptions {
  return { content: payload.content, embeds: payload.embeds, components: payload.components,
    files: payload.files, allowedMentions: allowedMentions(payload) };
}
function code(error: unknown): number {
  return Number(error && typeof error === "object" && "code" in error ? error.code : 0);
}
function permissionFailure(error: unknown): boolean { return [50001,50013,10003,10004,10008].includes(code(error)); }
function definiteFailure(error: unknown): boolean {
  const status = Number(error && typeof error === "object" && "status" in error ? error.status : 0);
  // A response explicitly rejecting a request is known not to have published it.
  return status >= 400 && status < 500 || code(error) >= 10000;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : "Community delivery failed.";

export class CommunityService {
  private readonly tasks = new Map<string, (tick: CommunityTick) => Promise<void>>();
  private readonly handlers = new Map<string, CommunityDeliveryHandler>();
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly requestLimit: number;
  private readonly sendLimit: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private taskOffset = 0;
  constructor(private readonly client: Client, private readonly db: BotDatabase, readonly api: OpenFrontApi, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.tickMs = bounded(options.tickMs,60_000,3_600_000);
    this.requestLimit = bounded(options.maxRequestsPerTick,8,50);
    this.sendLimit = bounded(options.maxSendsPerTick,4,20);
  }
  registerTask(key: string, task: (tick: CommunityTick) => Promise<void>): void { this.tasks.set(key,task); }
  registerDelivery(kind: string, handler: CommunityDeliveryHandler): void { this.handlers.set(kind,handler); }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.runOnce().catch(error => console.warn("[Community] Tick failed:",error)); },this.tickMs);
    this.timer.unref();
    void this.runOnce().catch(error => console.warn("[Community] Tick failed:",error));
  }
  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.stopped) return Promise.resolve();
    this.inFlight = this.tick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
  private async tick(): Promise<void> {
    const now = this.now(); let remaining = this.requestLimit;
    const reserved = Math.max(0,...[...this.handlers].map(([kind,handler]) =>
      handler.requestBudget && this.db.community.deliveries.hasDue(kind,now) ? Math.min(this.requestLimit,handler.requestBudget) : 0));
    const tick: CommunityTick = { now, currentTime: this.now, stopping: () => this.stopped,
      takeRequest: () => !this.stopped && remaining > 0 ? (remaining--, true) : false };
    const taskTick: CommunityTick = { ...tick,
      takeRequest: () => !this.stopped && remaining > reserved ? (remaining--,true) : false };
    this.db.community.prune(now);
    const tasks = [...this.tasks.values()];
    const offset = tasks.length ? this.taskOffset++ % tasks.length : 0;
    for (let n = 0; n < tasks.length && !this.stopped; n++) {
      try { await tasks[(offset+n)%tasks.length](taskTick); }
      catch (error) { console.warn("[Community] Task failed:",errorText(error)); }
    }
    // Claim only as much as this worker can handle now; avoid leasing unattended jobs.
    for (let n = 0; n < this.sendLimit && !this.stopped; n++) {
      const job = this.db.community.deliveries.claim(this.now(),1)[0];
      if (!job) break;
      await this.deliver(job,tick);
    }
  }
  private async reconcile(channel: DeliveryChannel, job: DeliveryJob): Promise<string | null> {
    const messages = await channel.messages.fetch({ limit: 100 });
    const marker = deliveryMarker(job);
    return messages.find(message => message.author.id === this.client.user?.id &&
      (message.content?.split("\n").includes(marker) ||
        message.embeds.some(embed => embed.footer?.text?.split(" | ").includes(marker))))?.id ?? null;
  }
  private complete(job: DeliveryJob, messageId: string, handler: CommunityDeliveryHandler): void {
    this.db.community.transaction(() => {
      if (!this.db.community.deliveries.finish(job.id,job.leaseId!,messageId,this.now())) throw new Error("Delivery lease changed before binding.");
      handler.delivered?.(job,messageId);
    });
  }
  private async deliver(job: DeliveryJob, tick: CommunityTick): Promise<void> {
    const store = this.db.community.deliveries, handler = this.handlers.get(job.kind);
    const fail = (outcome: "transient" | "paused" | "needs_review", error: unknown) => store.fail(job.id,job.leaseId!,outcome,errorText(error),this.now());
    let channel: DeliveryChannel | null = null;
    let attempted = false;
    let accepted = false;
    try {
      if (!handler) { fail("paused",new Error("No delivery handler is available for this kind of community work.")); return; }
      let prepared = await handler.prepare(job,this.now(),tick);
      if (!store.owns(job)) return;
      if (!prepared) { store.cancel(job.id,job.leaseId!,this.now()); return; }
      const fetched = await this.client.channels.fetch(job.channelId);
      if (!fetched || !("guildId" in fetched) || fetched.guildId !== job.guildId || !fetched.isTextBased() || !("send" in fetched)) {
        fail("paused",new Error("The saved community channel is unavailable or belongs to another server.")); return;
      }
      channel = fetched as DeliveryChannel;
      // A role/settings/revision change can happen during any awaited Discord lookup.
      prepared = await handler.prepare(job,this.now(),tick);
      if (!store.owns(job)) return;
      if (!prepared) { store.cancel(job.id,job.leaseId!,this.now()); return; }
      if (this.stopped) { fail("transient",new Error("Community service stopped before delivery.")); return; }
      if (job.leaseUntil! <= this.now()) return;
      if (job.reconcileRequired && !prepared.messageId) {
        const recovered = await this.reconcile(channel,job);
        if (!store.owns(job)) return;
        if (!recovered) { fail("needs_review",new Error("The prior send is uncertain. Recent messages could not prove its outcome; review before retrying.")); return; }
        if (!await handler.prepare(job,this.now(),tick)) { store.cancel(job.id,job.leaseId!,this.now()); return; }
        accepted = true; this.complete(job,recovered,handler); return;
      }
      const payload = payloadFor(job,prepared.payload);
      let message: Message;
      if (prepared.messageId) {
        const messageId = prepared.messageId;
        const existing = await channel.messages.fetch(messageId);
        prepared = await handler.prepare(job,this.now(),tick);
        if (!store.owns(job)) return;
        if (!prepared) { store.cancel(job.id,job.leaseId!,this.now()); return; }
        if (this.stopped) { fail("transient",new Error("Community service stopped before delivery.")); return; }
        if (job.leaseUntil! <= this.now()) return;
        if (prepared.messageId !== messageId) { fail("transient",new Error("The saved message binding changed during lookup. Retry the current revision.")); return; }
        if (existing.author.id !== this.client.user?.id) { fail("paused",new Error("The saved message is not owned by this bot.")); return; }
        attempted = true;
        message = await existing.edit(editPayload(payloadFor(job,prepared.payload)));
      } else {
        attempted = true; message = await channel.send(payload);
      }
      accepted = true;
      this.complete(job,message.id,handler);
    } catch (error) {
      if (error instanceof CommunityBudgetExhaustedError && !attempted) {
        store.defer(job.id,job.leaseId!,this.now()+this.tickMs,this.now());
        return;
      }
      if (accepted) { fail("needs_review",new Error(`Discord accepted the message but saving its binding failed: ${errorText(error)}`)); return; }
      if (error instanceof DeliveryPayloadError) { fail("paused",error); return; }
      if (permissionFailure(error)) { fail("paused",error); return; }
      if (!attempted || definiteFailure(error)) { fail("transient",error); return; }
      // A network failure after send may mean Discord accepted it. Never blindly repost.
      try {
        const recovered = channel ? await this.reconcile(channel,job) : null;
        if (recovered && handler && await handler.prepare(job,this.now(),tick)) {
          accepted = true; this.complete(job,recovered,handler); return;
        }
      } catch { /* unresolved reconciliation remains explicitly reviewable */ }
      fail("needs_review",new Error(accepted ? "Discord accepted the message but saving its binding failed. Review the existing message." : "Delivery outcome is uncertain. Reconcile recent bot messages before retrying."));
    }
  }
}
