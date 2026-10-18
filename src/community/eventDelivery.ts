import type { Client,Guild } from "discord.js";
import type { BotDatabase } from "../db.js";
import type { DeliveryJob,PreparedDelivery } from "./types.js";
import type { CommunityService } from "./service.js";
import { renderEvent } from "../commands/event.js";

export async function prepareEventDelivery(job:DeliveryJob,guild:Guild,db:BotDatabase,now:number):Promise<PreparedDelivery|null> {
  const event=db.community.events.get(job.guildId,job.subjectId);
  if(!event||guild.id!==event.guildId||event.channelId!==job.channelId||event.revision!==job.revision)return null;
  if(job.kind==='event_publish') {
    if(event.status!=='draft'||event.messageId||event.startAt<=now)return null;
    return {payload:renderEvent({...event,status:'scheduled'},db.community.events.signups(job.guildId,event.id),1,now)};
  }
  if(job.kind!=='event_update'||!event.messageId)return null;
  return {messageId:event.messageId,payload:renderEvent(event,db.community.events.signups(job.guildId,event.id),1,now)};
}
export function registerEventWork(service:CommunityService,client:Client,db:BotDatabase):void {
  for(const kind of ['event_publish','event_update'])service.registerDelivery(kind,{
    async prepare(job,now=Date.now()){const guild=client.guilds.cache.get(job.guildId);if(!guild)return null;return prepareEventDelivery(job,guild,db,now);},
    delivered(job,messageId){if(job.kind==='event_publish')db.community.events.publish(job.guildId,job.subjectId,job.revision,messageId);},
  });
}
