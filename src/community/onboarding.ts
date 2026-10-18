import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Guild, GuildMember } from 'discord.js';
import type { BotDatabase } from '../db.js';
import type { OpenFrontApi, OpenFrontPlayerProfile } from '../api.js';
import { CommandError } from '../commandError.js';

export interface OnboardingEnrollment { discordId:string; clanTag:string; enrolledAt:number; completedAt:number|null }
const decode=(r:Record<string,unknown>):OnboardingEnrollment=>({discordId:String(r.discord_id),clanTag:String(r.clan_tag),enrolledAt:Number(r.enrolled_at),completedAt:r.completed_at===null?null:Number(r.completed_at)});
export class OnboardingStore {
  constructor(private readonly sql:DatabaseSync) {}
  enroll(guildId:string,discordId:string,clanTag:string,now:number):void {
    if(!guildId||!discordId||!clanTag.trim()||!Number.isSafeInteger(now))throw new CommandError('Choose a valid server, member and clan.');
    this.sql.prepare(`INSERT INTO community_onboarding(guild_id,discord_id,clan_tag,enrolled_at,token) VALUES(?,?,?,?,?)
      ON CONFLICT(guild_id,discord_id) DO UPDATE SET clan_tag=excluded.clan_tag,enrolled_at=excluded.enrolled_at,
      completed_at=NULL,public_id=NULL,token=excluded.token WHERE community_onboarding.clan_tag<>excluded.clan_tag`)
      .run(guildId,discordId,clanTag.trim().toUpperCase(),now,randomUUID());
  }
  list(guildId:string):OnboardingEnrollment[] {
    return this.sql.prepare('SELECT * FROM community_onboarding WHERE guild_id=? ORDER BY enrolled_at,discord_id').all(guildId).map(decode);
  }
  /** Current membership is supplied by one fresh Discord roster, not a per-enrollee API request. */
  page(guildId:string,memberIds:string[],page:number):{entries:OnboardingEnrollment[];pages:number} {
    const members=JSON.stringify(memberIds),where='guild_id=? AND discord_id IN (SELECT value FROM json_each(?))';
    const total=Number(this.sql.prepare(`SELECT count(*) AS n FROM community_onboarding WHERE ${where}`).get(guildId,members)!.n);
    const pages=Math.max(1,Math.ceil(total/10));
    if(!Number.isInteger(page)||page<0||page>=pages)throw new CommandError(`Choose an onboarding queue page from 1 to ${pages}.`);
    const entries=this.sql.prepare(`SELECT * FROM community_onboarding WHERE ${where} ORDER BY enrolled_at,discord_id LIMIT 10 OFFSET ?`).all(guildId,members,page*10).map(decode);
    return{entries,pages};
  }
  binding(guildId:string,discordId:string):string|null {
    const r=this.sql.prepare('SELECT token FROM community_onboarding WHERE guild_id=? AND discord_id=?').get(guildId,discordId);
    return r?String(r.token):null;
  }
  markCompletion(guildId:string,discordId:string,completed:boolean,now:number,observation?:{publicId:string|null;clanTag:string}):void {
    this.sql.prepare(`UPDATE community_onboarding SET public_id=?,completed_at=CASE WHEN ? THEN coalesce(completed_at,?) ELSE NULL END
      WHERE guild_id=? AND discord_id=? AND (? IS NULL OR clan_tag=?)`)
      .run(observation?.publicId??null,Number(completed),now,guildId,discordId,observation?.clanTag??null,observation?.clanTag??null);
  }
}
export interface OnboardingStep {key:'link'|'clan'|'availability'|'event';state:'complete'|'incomplete'|'waiting'|'unknown';detail:string}
export interface OnboardingStatus { steps:OnboardingStep[]; nextStep:string|null }
const changed=()=>new CommandError('Onboarding identity, membership or enrollment changed. Reopen /onboarding status.');
/** Resolve remote data first; the returned synchronous finalizer uses the final fresh member and current local facts.
 * Queue callers share a final bounded member lookup and release no stale earlier row. */
export async function prepareOnboardingStatus(guildId:string,discordId:string,clanTag:string,db:BotDatabase,api:OpenFrontApi,now:number):Promise<(member:GuildMember|undefined)=>OnboardingStatus> {
  const tag=clanTag.trim().toUpperCase();
  const link=db.getEffectiveLink(guildId,discordId),binding=db.community.onboarding.binding(guildId,discordId);
  let profile:OpenFrontPlayerProfile|null=null;
  if(link&&!db.history.isDeleted(link.openfront_id)) {
    try{profile=await api.getPlayerProfile(link.openfront_id,{fresh:true});}catch{/* Missing upstream evidence is Unknown. */}
  }
  return member=>{
    const current=db.getEffectiveLink(guildId,discordId);
    if(!member||member.user.bot||member.id!==discordId||current?.openfront_id!==link?.openfront_id||current?.linked_at!==link?.linked_at||
      db.community.onboarding.binding(guildId,discordId)!==binding|| (link&&db.history.isDeleted(link.openfront_id)))throw changed();
    const config=db.getGuildClanConfig(guildId,tag);
    const steps:OnboardingStep[]=[{key:'link',state:link?'complete':'incomplete',detail:link?
      link.verified_method==='admin_manual'?'Linked with a server-only approval; ownership is not verified bot-wide.':'OpenFront account ownership verified.':'Use /link to connect your OpenFront account.'}];
    let clan:OnboardingStep;
    if(!config)clan={key:'clan',state:'unknown',detail:'This clan is no longer configured. Reopen /onboarding status and choose a configured clan.'};
    else if(!link)clan={key:'clan',state:'incomplete',detail:'Link your account, then join the selected clan in OpenFront.'};
    else if(!profile||!Array.isArray(profile.clans))clan={key:'clan',state:'unknown',detail:'Clan membership is Unknown. Use Refresh to retry when OpenFront is available.'};
    else if(profile.clans.some(c=>c.tag.toUpperCase()===tag))clan={key:'clan',state:'complete',detail:'Current OpenFront profile confirms selected clan membership.'};
    else if(config.join_role_id&&member.roles.cache.has(config.join_role_id))clan={key:'clan',state:'waiting',detail:'Waiting for a clan invitation; server approval is not clan membership. Contact an officer.'};
    else clan={key:'clan',state:'incomplete',detail:'Join the selected clan in OpenFront; contact an officer for an invitation.'};
    steps.push(clan);
    const available=!!db.community.availability.get(guildId,discordId)?.windows.length;
    steps.push({key:'availability',state:available?'complete':'incomplete',detail:available?'Weekly playing availability saved.':'Use /availability set to save at least one weekly playing window.'});
    const signed=db.community.events.hasConfirmedSignup(guildId,discordId,now);
    steps.push({key:'event',state:signed?'complete':'incomplete',detail:signed?'Confirmed event signup recorded; this is not proof of attendance.':'Use /event list, open an event and Join. A reserve place does not complete this step.'});
    const complete=steps.every(s=>s.state==='complete');
    db.community.onboarding.markCompletion(guildId,discordId,complete,now,{publicId:link?.openfront_id??null,clanTag:tag});
    return{steps,nextStep:steps.find(s=>s.state!=='complete')?.detail??null};
  };
}
export async function buildOnboardingStatus(guild:Guild,discordId:string,clanTag:string,db:BotDatabase,api:OpenFrontApi,now:number):Promise<OnboardingStatus> {
  const finish=await prepareOnboardingStatus(guild.id,discordId,clanTag,db,api,now);
  const member=await guild.members.fetch({user:discordId,force:true});
  return finish(member);
}
