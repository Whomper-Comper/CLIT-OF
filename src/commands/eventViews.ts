import { ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,escapeMarkdown } from "discord.js";
import type { EventRecord,EventSignup } from "../community/events.js";
export const safe=(v:string)=>escapeMarkdown(v).replace(/@/g,'＠');
export const button=(id:string,label:string,disabled=false,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
export function renderEvent(event:EventRecord,signups:EventSignup[],page=1,now=Date.now()):{embeds:EmbedBuilder[];components:ActionRowBuilder<ButtonBuilder>[]} {
  const pages=Math.max(1,Math.ceil(signups.length/20));page=Math.max(1,Math.min(pages,Math.floor(page)||1));
  const closed=event.status!=='scheduled'||event.startAt<=now;
  const confirmed=signups.filter(s=>s.state==='confirmed').length;
  const embed=new EmbedBuilder().setColor(event.status==='cancelled'?0xed4245:0x5865f2).setTitle(safe(event.title)).setDescription(safe(event.description)||'Gather your team and join below.')
    .addFields({name:'When',value:`<t:${Math.floor(event.startAt/1000)}:F> · <t:${Math.floor(event.startAt/1000)}:R>\n${event.durationMinutes} minutes`},
      {name:'Seats',value:`${confirmed}/${event.capacity} confirmed · ${signups.length-confirmed} reserve · ${event.status}`});
  if(event.squads.length)embed.addFields({name:'Squads',value:event.squads.map(s=>`${safe(s.name).slice(0,30)} · ${signups.filter(x=>x.squadId===s.id&&x.state==='confirmed').length}/${s.capacity}`).join('\n')});
  if(event.settingsText)embed.addFields({name:'Game settings',value:safe(event.settingsText).slice(0,500)});
  const visible=signups.slice((page-1)*20,page*20).map(s=>`${s.state==='reserve'?'Reserve':'Confirmed'} · ${/^\d{17,20}$/.test(s.discordId)?`<@${s.discordId}>`:safe(s.discordId).slice(0,30)}${s.squadId?` · ${safe(event.squads.find(q=>q.id===s.squadId)?.name??s.squadId).slice(0,30)}`:''}`);
  // Separate fields keep each below Discord's 1024 character limit, even with long squad names.
  for(let n=0;n<visible.length;n+=5)embed.addFields({name:n===0?'Participants':'Participants (continued)',value:visible.slice(n,n+5).join('\n')});
  embed.setFooter({text:`Event ${event.id} · Revision ${event.revision} · Page ${page}/${pages} · Reminders opt-in${event.reminderMinutes?` (${event.reminderMinutes}m before)`:' (off)'}`});
  const id=(action:string)=>`event:${event.id}:${action}:${event.revision}:${page}`;
  return {embeds:[embed],components:[new ActionRowBuilder<ButtonBuilder>().addComponents(button(id('join'),'Join',closed),button(id('withdraw'),'Withdraw',closed),button(id('squad'),'Choose squad',closed||!event.squads.length),button(id('reminder'),'Reminder',closed||!event.reminderMinutes)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(button(id('previous'),'Previous',page===1),button(id('next'),'Next',page===pages),button(id('refresh'),'Refresh'))]};
}
