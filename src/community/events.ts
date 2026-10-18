import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CommandError } from "../commandError.js";
import { withCommunityTransaction } from "./transactions.js";
import { DeliveryStore } from "./deliveries.js";
import type { DeliveryJob } from "./types.js";

export interface EventDraftInput {
  guildId:string; channelId:string; creatorId:string; title:string; description:string; startAt:number;
  durationMinutes:number; capacity:number; squads:{id:string;name:string;capacity:number}[];
  reminderMinutes:0|15|30|60; settingsText?:string;
}
export interface EventRecord extends EventDraftInput {
  id:string; messageId:string|null; status:'draft'|'scheduled'|'cancelled'|'finished'; revision:number; createdAt:number;
}
export interface EventSignup { discordId:string; squadId:string|null; state:'confirmed'|'reserve'; sequence:number; reminder:boolean }
const changed=()=>new CommandError("This event changed or is unavailable. Reopen /event view or edit.");
const decode=(row:Record<string,unknown>):EventRecord=>({...JSON.parse(String(row.data)),id:String(row.id),messageId:row.message_id as string|null,
  status:row.status,revision:Number(row.revision),createdAt:Number(row.created_at)});
export function initializeEvents(sql:DatabaseSync):void {
  sql.exec(`CREATE TABLE IF NOT EXISTS community_events (
    id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,
    start_at INTEGER NOT NULL,created_at INTEGER NOT NULL,revision INTEGER NOT NULL,message_id TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,card_version INTEGER NOT NULL DEFAULT 0,promotion_due INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS community_event_guild_start ON community_events(guild_id,start_at,id);
    CREATE INDEX IF NOT EXISTS community_event_due ON community_events(status,promotion_due,start_at);
    CREATE TABLE IF NOT EXISTS community_event_signups (
    guild_id TEXT NOT NULL,event_id TEXT NOT NULL,discord_id TEXT NOT NULL,squad_id TEXT,state TEXT NOT NULL,
    sequence INTEGER NOT NULL,reminder INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,discord_id),UNIQUE(event_id,sequence));
    CREATE INDEX IF NOT EXISTS community_signup_capacity ON community_event_signups(event_id,squad_id,state,sequence);
    CREATE INDEX IF NOT EXISTS community_signup_member ON community_event_signups(guild_id,discord_id,event_id);`);
}
function validate(input:EventDraftInput,now:number,checkTime=true):EventDraftInput {
  const value={...input,durationMinutes:input.durationMinutes??120,capacity:input.capacity??20,reminderMinutes:input.reminderMinutes??0,squads:input.squads??[]};
  for(const [text,max,empty] of [[value.title,100,false],[value.description,1000,true],[value.settingsText??'',500,true]] as [string,number,boolean][])
    if(typeof text!=='string'||text.length>max||(!empty&&!text.trim()))throw new CommandError("Use a title of 1–100 characters, description up to 1000 and settings up to 500.");
  if([value.guildId,value.channelId,value.creatorId].some(v=>typeof v!=='string'||!v))throw new CommandError("Invalid event destination or creator.");
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(value.startAt)||(checkTime&&(value.startAt<=now||value.startAt>now+365*86400000)))throw new CommandError("Choose an event start in the next 365 days.");
  if(!Number.isInteger(value.durationMinutes)||value.durationMinutes<15||value.durationMinutes>720)throw new CommandError("Duration must be 15–720 minutes.");
  if(!Number.isInteger(value.capacity)||value.capacity<1||value.capacity>100)throw new CommandError("Capacity must be 1–100 members.");
  if(![0,15,30,60].includes(value.reminderMinutes))throw new CommandError("Reminder lead must be off, 15, 30 or 60 minutes.");
  if(!Array.isArray(value.squads)||value.squads.length>20||new Set(value.squads.map(s=>s.id)).size!==value.squads.length||value.squads.some(s=>!s||typeof s.id!=='string'||!/^[-\w]{1,32}$/.test(s.id)||typeof s.name!=='string'||!s.name.trim()||s.name.length>60||!Number.isInteger(s.capacity)||s.capacity<1||s.capacity>100)||
    (value.squads.length&&value.squads.reduce((n,s)=>n+s.capacity,0)!==value.capacity))throw new CommandError("Define at most 20 unique squads, with capacities adding up to event capacity.");
  return value;
}
export class EventStore {
  private readonly deliveries:DeliveryStore;
  constructor(private readonly sql:DatabaseSync){this.deliveries=new DeliveryStore(sql);}
  createDraft(input:EventDraftInput,now:number):EventRecord {
    const data=validate(input,now),id=randomUUID();this.sql.prepare(`INSERT INTO community_events(id,guild_id,channel_id,data,status,start_at,created_at,revision) VALUES(?,?,?,?,'draft',?,?,1)`)
      .run(id,data.guildId,data.channelId,JSON.stringify(data),data.startAt,now);return this.get(data.guildId,id)!;
  }
  get(guildId:string,eventId:string):EventRecord|null {const row=this.sql.prepare("SELECT * FROM community_events WHERE guild_id=? AND id=?").get(guildId,eventId);return row?decode(row):null;}
  list(guildId:string):EventRecord[]{return this.sql.prepare("SELECT * FROM community_events WHERE guild_id=? ORDER BY start_at DESC,id LIMIT 100").all(guildId).map(decode);}
  deliveryJobs(guildId:string,eventId:string):DeliveryJob[] {
    const rows=this.sql.prepare(`SELECT id FROM community_deliveries WHERE guild_id=? AND kind IN ('event_publish','event_update')
      AND subject_id=? AND status NOT IN ('sent','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 5`).all(guildId,eventId);
    return rows.map(row=>this.deliveries.get(String(row.id))!);
  }
  signups(guildId:string,eventId:string):EventSignup[]{return this.sql.prepare("SELECT * FROM community_event_signups WHERE event_id=? AND guild_id=? ORDER BY sequence").all(eventId,guildId)
    .map(r=>({discordId:String(r.discord_id),squadId:r.squad_id as string|null,state:r.state as EventSignup['state'],sequence:Number(r.sequence),reminder:!!r.reminder}));}
  private require(guildId:string,id:string,revision?:number):EventRecord {const e=this.get(guildId,id);if(!e||(revision!==undefined&&e.revision!==revision))throw changed();return e;}
  private open(guildId:string,id:string,now:number):EventRecord {const e=this.require(guildId,id);if(e.status!=='scheduled'||now>=e.startAt)throw new CommandError("Event signups are closed at the start instant or while unpublished/cancelled.");return e;}
  private publicationLocked(e:EventRecord):boolean {return !!this.sql.prepare("SELECT 1 FROM community_deliveries WHERE guild_id=? AND kind='event_publish' AND subject_id=? AND status NOT IN ('cancelled','sent') LIMIT 1").get(e.guildId,e.id);}
  publish(guildId:string,id:string,revision:number,messageId:string):EventRecord {return withCommunityTransaction(this.sql,()=>{
    const e=this.require(guildId,id,revision);if(e.status==='scheduled'&&e.messageId===messageId)return e;if(e.status!=='draft'||!messageId)throw changed();
    this.sql.prepare("UPDATE community_events SET status='scheduled',message_id=? WHERE id=?").run(messageId,id);return this.require(guildId,id);
  });}
  requestPublish(guildId:string,id:string,revision:number,now:number):void {withCommunityTransaction(this.sql,()=>{
    const e=this.require(guildId,id,revision);if(e.status!=='draft'||e.startAt<=now)throw changed();
    this.deliveries.enqueue({key:`event_publish:${id}:${revision}`,guildId,channelId:e.channelId,kind:'event_publish',subjectId:id,revision,dueAt:now,part:0});
  });}
  edit(guildId:string,id:string,revision:number,changes:Partial<EventDraftInput>,now:number):EventRecord {return withCommunityTransaction(this.sql,()=>{
    const e=this.require(guildId,id,revision);if(!['draft','scheduled'].includes(e.status)||e.startAt<=now||this.publicationLocked(e))throw new CommandError("Event closed or publication pending. Reopen management and resolve delivery first.");
    if((changes.guildId&&changes.guildId!==e.guildId)||(changes.creatorId&&changes.creatorId!==e.creatorId)||(changes.channelId&&changes.channelId!==e.channelId))throw new CommandError("Event creator and destination cannot change.");
    const data=validate({...e,...changes},now);const signups=this.signups(guildId,id);
    if(signups.filter(s=>s.state==='confirmed').length>data.capacity)throw new CommandError("Capacity is below confirmed occupancy.");
    for(const s of signups){if(s.squadId!==null&&!data.squads.some(t=>t.id===s.squadId))throw new CommandError("An occupied squad cannot be removed.");if(s.squadId===null&&data.squads.length)throw new CommandError("Move existing members before introducing squads.");}
    for(const squad of data.squads)if(signups.filter(s=>s.state==='confirmed'&&s.squadId===squad.id).length>squad.capacity)throw new CommandError("Squad capacity is below confirmed occupancy.");
    this.sql.prepare("UPDATE community_events SET data=?,start_at=?,revision=revision+1,promotion_due=1 WHERE id=?").run(JSON.stringify(data),data.startAt,id);
    this.deliveries.cancelSubject(guildId,'event_reminder',id,now);this.deliveries.cancelSubject(guildId,'event_update',id,now);this.queueUpdate(guildId,id,now);return this.require(guildId,id);
  });}
  cancel(guildId:string,id:string,revision:number,now:number):EventRecord {return withCommunityTransaction(this.sql,()=>{
    const e=this.require(guildId,id,revision);if(e.status==='cancelled')return e;if(this.publicationLocked(e))throw new CommandError("Resolve pending publication in event management before cancellation.");
    this.sql.prepare("UPDATE community_events SET status='cancelled',revision=revision+1,promotion_due=0 WHERE id=?").run(id);
    this.deliveries.cancelSubject(guildId,'event_reminder',id,now);this.deliveries.cancelSubject(guildId,'event_update',id,now);this.queueUpdate(guildId,id,now);return this.require(guildId,id);
  });}
  private capacity(e:EventRecord,squadId:string|null):number {if(!e.squads.length){if(squadId!==null)throw new CommandError("This event has no squads.");return e.capacity;}const squad=e.squads.find(s=>s.id===squadId);if(!squad)throw new CommandError("Choose an existing squad before joining.");return squad.capacity;}
  private confirmed(id:string,squadId:string|null):number {return Number(this.sql.prepare("SELECT COUNT(*) AS n FROM community_event_signups WHERE event_id=? AND squad_id IS ? AND state='confirmed'").get(id,squadId)!.n);}
  private hasReserve(id:string,squadId:string|null):boolean {return !!this.sql.prepare("SELECT 1 FROM community_event_signups WHERE event_id=? AND squad_id IS ? AND state='reserve' LIMIT 1").get(id,squadId);}
  join(guildId:string,id:string,userId:string,squadId:string|null,now:number):EventSignup {return withCommunityTransaction(this.sql,()=>{
    const e=this.open(guildId,id,now),capacity=this.capacity(e,squadId),existing=this.signup(guildId,id,userId);if(existing)return existing;
    if(!userId)throw new CommandError("Invalid member.");
    const sequence=Number(this.sql.prepare("UPDATE community_events SET next_sequence=next_sequence+1 WHERE id=? RETURNING next_sequence-1 AS n").get(id)!.n);
    this.sql.prepare("INSERT INTO community_event_signups(guild_id,event_id,discord_id,squad_id,state,sequence) VALUES(?,?,?,?,?,?)").run(guildId,id,userId,squadId,this.confirmed(id,squadId)<capacity&&!this.hasReserve(id,squadId)?'confirmed':'reserve',sequence);
    this.queueUpdate(guildId,id,now);return this.signup(guildId,id,userId)!;
  });}
  withdraw(guildId:string,id:string,userId:string,eligibleMembers:Set<string>,now:number):void {withCommunityTransaction(this.sql,()=>{
    this.open(guildId,id,now);this.sql.prepare("DELETE FROM community_event_signups WHERE event_id=? AND discord_id=?").run(id,userId);this.promote(guildId,id,eligibleMembers,now);
  });}
  move(guildId:string,id:string,userId:string,squadId:string,eligibleMembers:Set<string>,now:number):EventSignup {return withCommunityTransaction(this.sql,()=>{
    const e=this.open(guildId,id,now),capacity=this.capacity(e,squadId),existing=this.signup(guildId,id,userId);if(!existing)throw new CommandError("Member must join before moving squads.");if(!eligibleMembers.has(userId))throw new CommandError("Member is no longer in this server.");if(existing.squadId===squadId)return existing;
    this.sql.prepare("UPDATE community_event_signups SET squad_id=?,state=?,reminder=0 WHERE event_id=? AND discord_id=?").run(squadId,this.confirmed(id,squadId)<capacity&&!this.hasReserve(id,squadId)?'confirmed':'reserve',id,userId);
    this.promote(guildId,id,eligibleMembers,now);return this.signups(guildId,id).find(s=>s.discordId===userId)!;
  });}
  signup(guildId:string,id:string,userId:string):EventSignup|null {
    const r=this.sql.prepare("SELECT * FROM community_event_signups WHERE event_id=? AND discord_id=? AND guild_id=?").get(id,userId,guildId);
    return r?{discordId:String(r.discord_id),squadId:r.squad_id as string|null,state:r.state as EventSignup['state'],sequence:Number(r.sequence),reminder:!!r.reminder}:null;
  }
  setReminder(guildId:string,id:string,userId:string,enabled:boolean,now:number):void {withCommunityTransaction(this.sql,()=>{const e=this.open(guildId,id,now);if(!e.reminderMinutes&&enabled)throw new CommandError("This event has no reminder lead time configured.");if(!this.sql.prepare("UPDATE community_event_signups SET reminder=? WHERE event_id=? AND discord_id=?").run(enabled?1:0,id,userId).changes)throw new CommandError("Join this event before choosing reminders.");});}
  promote(guildId:string,id:string,eligibleMembers:Set<string>,now:number):void {withCommunityTransaction(this.sql,()=>{
    const e=this.open(guildId,id,now),signups=this.signups(guildId,id);for(const s of signups)if(!eligibleMembers.has(s.discordId))this.sql.prepare("DELETE FROM community_event_signups WHERE event_id=? AND discord_id=?").run(id,s.discordId);
    for(const squad of e.squads.length?e.squads:[{id:null,capacity:e.capacity}]){let seats=squad.capacity-this.confirmed(id,squad.id);if(seats<=0)continue;
      for(const s of this.sql.prepare("SELECT discord_id FROM community_event_signups WHERE event_id=? AND squad_id IS ? AND state='reserve' ORDER BY sequence LIMIT ?").all(id,squad.id,seats))this.sql.prepare("UPDATE community_event_signups SET state='confirmed' WHERE event_id=? AND discord_id=?").run(id,s.discord_id!);}
    this.sql.prepare("UPDATE community_events SET promotion_due=0 WHERE id=?").run(id);this.queueUpdate(guildId,id,now);
  });}
  promotionDue(guildId:string,limit=50):EventRecord[]{return this.sql.prepare("SELECT * FROM community_events WHERE status='scheduled' AND promotion_due=1 AND guild_id=? ORDER BY start_at LIMIT ?").all(guildId,Math.max(1,Math.min(100,limit))).map(decode);}
  queueUpdate(guildId:string,id:string,now:number):void {const e=this.require(guildId,id);if(!e.messageId)return;
    const version=Number(this.sql.prepare("UPDATE community_events SET card_version=card_version+1 WHERE id=? RETURNING card_version").get(id)!.card_version);
    // Coalesce pending cards; never cancel a send already in flight or awaiting reconciliation.
    this.sql.prepare("UPDATE community_deliveries SET status='cancelled',updated_at=? WHERE guild_id=? AND kind='event_update' AND subject_id=? AND status='pending'").run(now,guildId,id);
    this.deliveries.enqueue({key:`event_update:${id}:${e.revision}:${version}`,guildId,channelId:e.channelId,kind:'event_update',subjectId:id,revision:e.revision,dueAt:now,part:0});
  }
}
