import { commandAction } from './action.js';
import { randomUUID } from "node:crypto";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, InteractionContextType, ModalBuilder,
  SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { db as defaultDatabase, type BotDatabase } from "../db.js";
import { CommandError, label, privateReply, throttle } from "./support.js";
import { requireCommunityOfficer,hasCommunityOfficerRole } from "../community/access.js";
import { communitySessions, type CommunitySessions, type PrivateCommunitySession } from "../community/sessions.js";
import type { LocalWindow, MemberAvailability } from "../community/availability.js";
import { suggestAvailability } from "../community/time.js";
import { createEventDraft } from "./event.js";
import type { EventDraftInput } from "../community/events.js";

const DAYS=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const clock=(minute:number)=>`${String(Math.floor(minute/60)).padStart(2,"0")}:${String(minute%60).padStart(2,"0")}`;
function minute(value:string):number {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new CommandError("Enter a local time as HH:mm, from 00:00 to 23:59.");
  const [hour,min]=value.split(":").map(Number);return hour*60+min;
}
interface ViewData { targetId:string; revision:number; page:number; selected:string|null }
interface Dependencies {
  db?:BotDatabase;
  now?:()=>number;
  sessions?:CommunitySessions;
  createDraft?:(i:Interaction,seed:Partial<EventDraftInput>,assertSourceCurrent?:()=>void)=>Promise<void>;
}

export function createAvailabilityCommand(dependencies:Dependencies={}) {
  const database=dependencies.db??defaultDatabase, now=dependencies.now??Date.now,sessions=dependencies.sessions??communitySessions;
  function saveWindow(guildId:string,discordId:string,day:number,start:string,end:string,timezone:string|null,id:string|null,expected?:number) {
    const current=database.community.availability.get(guildId,discordId);
    if (!timezone && !current) throw new CommandError("Supply an IANA timezone on your first availability save.");
    if (id && !current?.windows.some(window=>window.id===id)) throw new CommandError("That window no longer exists. Reopen availability view.");
    const startMinute=minute(start),endMinute=minute(end);
    const existing=id??current?.windows.find(window=>window.weekday===day && window.startMinute===startMinute && window.endMinute===endMinute)?.id;
    const window:LocalWindow={id:existing??randomUUID(),weekday:day,startMinute,endMinute};
    const windows=existing?current!.windows.map(value=>value.id===existing?window:value):[...(current?.windows??[]),window];
    return database.community.availability.save({guildId,discordId,timezone:timezone??current!.timezone,windows},expected??current?.revision??0,now());
  }
  function menu(session:PrivateCommunitySession,member:MemberAvailability|null) {
    const data=session.data as ViewData, windows=member?.windows??[],pages=Math.max(1,Math.ceil(windows.length/7));
    data.page=Math.min(data.page,pages-1);
    const visible=windows.slice(data.page*7,data.page*7+7);
    if (!visible.some(window=>window.id===data.selected)) data.selected=visible[0]?.id??null;
    const description=visible.map(window=>`**${DAYS[window.weekday]}** ${clock(window.startMinute)}–${clock(window.endMinute)}${window.endMinute<window.startMinute?" (next day)":""}\nWindow: \`${window.id}\``).join("\n\n");
    const embed=new EmbedBuilder().setColor(0x5865f2).setTitle("Weekly availability")
      .setDescription(description||"No weekly windows saved. Use /availability action:set to add one.")
      .setFooter({text:`${member?label(member.timezone):"Timezone not set"} · Page ${data.page+1}/${pages} · Private menu expires in 10 minutes`});
    const components:(ActionRowBuilder<ButtonBuilder>|ActionRowBuilder<StringSelectMenuBuilder>)[]=[];
    const editable=data.targetId===session.ownerId;
    if (editable && visible.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`availability:${session.id}:select`).setPlaceholder("Choose a window to edit or delete")
      .addOptions(visible.map(window=>({label:`${DAYS[window.weekday]} ${clock(window.startMinute)}–${clock(window.endMinute)}`,value:window.id,default:window.id===data.selected})))));
    const buttons=new ActionRowBuilder<ButtonBuilder>();
    for (const [action,text,disabled] of [["previous","Previous",data.page===0],["next","Next",data.page>=pages-1],
      ...(editable?[["edit","Edit window",!data.selected],["delete","Delete window",!data.selected]]:[])] as [string,string,boolean][]) {
      buttons.addComponents(new ButtonBuilder().setCustomId(`availability:${session.id}:${action}`).setLabel(text)
        .setStyle(action==="delete"?ButtonStyle.Danger:ButtonStyle.Secondary).setDisabled(disabled));
    }
    components.push(buttons);
    return {embeds:[embed],components,allowedMentions:{parse:[] as never[]}};
  }
  return {
    data: new SlashCommandBuilder().setName('availability').setDescription('Save weekly playing times and find shared sessions')
      .setContexts(InteractionContextType.Guild)
      .addStringOption(o => o.setName('action').setDescription('Choose the availability action').setRequired(true)
        .addChoices(...['set', 'view', 'clear', 'suggest'].map(value => ({ name: value, value }))))
      .addIntegerOption(o => o.setName('day').setDescription('Set: local weekday').addChoices(...DAYS.map((name, value) => ({ name, value }))))
      .addStringOption(o => o.setName('start').setDescription('Set: local start, HH:mm').setMaxLength(5))
      .addStringOption(o => o.setName('end').setDescription('Set: local end, HH:mm (may cross midnight)').setMaxLength(5))
      .addStringOption(o => o.setName('timezone').setDescription('Set: IANA timezone (required on first save)').setMaxLength(100))
      .addStringOption(o => o.setName('window').setDescription('Set/clear: window ID, or omit to add/clear all').setMaxLength(64))
      .addUserOption(o => o.setName('user').setDescription('View: another member (officers only)'))
      .addIntegerOption(o => o.setName('page').setDescription('View: page number').setMinValue(1).setMaxValue(2))
      .addIntegerOption(o => o.setName('duration').setDescription('Suggest: session minutes (default 120)').setMinValue(30).setMaxValue(240)),

    async execute(i:ChatInputCommandInteraction):Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError("Use availability in a server.");
      const sub = commandAction(i.options, {
        set: { allowed: ['day', 'start', 'end', 'timezone', 'window'], required: ['day', 'start', 'end'] },
        view: { allowed: ['user', 'page'] }, clear: { allowed: ['window'] }, suggest: { allowed: ['duration'] },
      });
      if (sub==="set") {
        saveWindow(i.guildId,i.user.id,i.options.getInteger("day",true),i.options.getString("start",true),i.options.getString("end",true),i.options.getString("timezone"),i.options.getString("window"));
        await i.reply({content:"Weekly availability saved. Use /availability action:view to edit your windows.",...privateReply,allowedMentions:{parse:[]}});return;
      }
      if (sub==="clear") {
        const id=i.options.getString("window"),current=database.community.availability.get(i.guildId,i.user.id);
        if (id) {
          if (!current?.windows.some(window=>window.id===id)) throw new CommandError("That window no longer exists. Reopen availability view.");
          database.community.availability.save({...current,windows:current.windows.filter(window=>window.id!==id)},current.revision,now());
        } else database.community.availability.clear(i.guildId,i.user.id);
        await i.reply({content:id?"Availability window removed.":"All your weekly availability was cleared.",...privateReply,allowedMentions:{parse:[]}});return;
      }
      if (sub==="view") {
        await i.deferReply(privateReply);
        const targetId=i.options.getUser("user")?.id??i.user.id;
        if (targetId!==i.user.id) await requireCommunityOfficer(i.guild,i.user.id,database);
        const current=database.community.availability.get(i.guildId,targetId);
        const page=(i.options.getInteger("page")??1)-1;
        if (page<0 || page>=Math.max(1,Math.ceil((current?.windows.length??0)/7))) throw new CommandError("Choose an existing availability page.");
        const session=sessions.create({kind:"availability",ownerId:i.user.id,guildId:i.guildId,channelId:i.channelId,messageId:null,
          data:{targetId,revision:current?.revision??0,page,selected:null} satisfies ViewData},now());
        const message=await i.editReply(menu(session,current));sessions.bind(session.id,message.id);return;
      }
      if (sub!=="suggest") throw new CommandError("Choose a supported availability action.");
      throttle(`availability:suggest:${i.guildId}:${i.user.id}`);
      const duration=i.options.getInteger("duration")??120;
      if (!Number.isInteger(duration)||duration<30||duration>240) throw new CommandError("Choose a suggestion duration between 30 and 240 minutes.");
      await i.deferReply();
      // One forced roster refresh, reused for every saved schedule; never trust cached membership.
      const roster=await i.guild.members.fetch({withPresences:false});
      const members=database.community.availability.list(i.guildId).filter(member=>roster.has(member.discordId) && !roster.get(member.discordId)!.user.bot);
      const suggestions=suggestAvailability(members,now(),duration);
      const best=suggestions[0]?.memberIds.length??0;
      const intro=!suggestions.length?"No shared session covers the requested duration. Try a shorter duration or add more availability.":
        best<members.length?`No time fits all ${members.length} members with saved availability. Best partial overlap: ${best} of ${members.length}.`:"Best sessions for members with saved availability:";
      const embed=new EmbedBuilder().setColor(0x5865f2).setTitle("Suggested playing times").setDescription(intro)
        .addFields(...suggestions.map((suggestion,index)=>({name:`Session ${index+1} · ${suggestion.memberIds.length} member${suggestion.memberIds.length===1?"":"s"}`,
          value:`<t:${Math.floor(suggestion.start/1000)}:F> – <t:${Math.floor(suggestion.end/1000)}:t>`})))
        .setFooter({text:`${duration} minutes · Next 14 days · Suggestions do not create events or sign anyone up`});
      await i.editReply({embeds:[embed],allowedMentions:{parse:[]}});
      const author=roster.get(i.user.id);
      const session=suggestions.length&&author&&hasCommunityOfficerRole(i.guildId,author,database)?sessions.create({kind:'availability-suggest',ownerId:i.user.id,guildId:i.guildId,channelId:i.channelId,messageId:null,
        data:suggestions.map(s=>({startAt:s.start,durationMinutes:duration}))},now()):null;
      const components=session?[new ActionRowBuilder<ButtonBuilder>().addComponents(...suggestions.map((_,n)=>new ButtonBuilder()
        .setCustomId(`availability:${session.id}:draft${n}`).setLabel(`Draft session ${n+1}`).setStyle(ButtonStyle.Secondary)))]:[];
      if(session){const message=await i.followUp({content:'Create a private event draft from a suggested session. No members are signed up automatically.',components,...privateReply,allowedMentions:{parse:[]}});sessions.bind(session.id,message.id);}
    },
    async handleInteraction(i:Interaction):Promise<boolean> {
      if (!("customId" in i) || !i.customId.startsWith("availability:")) return false;
      if (!(i.isButton()||i.isStringSelectMenu()||i.isModalSubmit())) return false;
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError("Use availability in a server.");
      const [,id,action]=i.customId.split(":");
      const binding={guildId:i.guildId,channelId:i.channelId,messageId:i.message?.id??null};
      const recheckSession=()=>sessions.get(id,i.user.id,binding,now());
      const session=recheckSession();
      if(session.kind==='availability-suggest') {
        if(!/^draft[0-2]$/.test(action)||!i.isButton())throw new CommandError('Reopen availability suggestions.');
        const seed=(session.data as Partial<EventDraftInput>[])[Number(action.slice(-1))];if(!seed)throw new CommandError('Reopen availability suggestions.');
        // Draft creation performs fresh officer authorization and always opens privately.
        await (dependencies.createDraft??createEventDraft)(i,seed,recheckSession);
        return true;
      }
      if (session.kind!==(action==="save"?"availability-edit":"availability")) throw new CommandError("Reopen your availability menu.");
      const data=session.data as ViewData;
      if (data.targetId!==i.user.id) await requireCommunityOfficer(i.guild,i.user.id,database);
      const current=database.community.availability.get(i.guildId,data.targetId);
      if ((current?.revision??0)!==data.revision) throw new CommandError("Availability changed. Reopen the menu.");
      if (["edit","delete","save","select"].includes(action) && data.targetId!==i.user.id) throw new CommandError("You can edit only your own availability.");
      if (action==="save" && i.isModalSubmit()) {
        const day=i.fields.getTextInputValue("day");
        if (!/^[0-6]$/.test(day)) throw new CommandError("Choose weekday 0 (Monday) through 6 (Sunday).");
        saveWindow(i.guildId,i.user.id,+day,i.fields.getTextInputValue("start"),i.fields.getTextInputValue("end"),i.fields.getTextInputValue("timezone"),data.selected,data.revision);
        sessions.delete(id);
        await i.reply({content:"Weekly window updated. Reopen /availability action:view for fresh controls.",...privateReply,allowedMentions:{parse:[]}});return true;
      }
      if (i.isModalSubmit()) throw new CommandError("Reopen your availability menu.");
      if (action==="edit" && i.isButton()) {
        const window=current?.windows.find(value=>value.id===data.selected);
        if (!window) throw new CommandError("Choose a window first. Reopen the menu.");
        // A modal owns a snapshot: later selections in the parent menu cannot retarget its save.
        const editor=sessions.create({kind:"availability-edit",ownerId:i.user.id,guildId:i.guildId,channelId:i.channelId,
          messageId:session.messageId,data:{...data}},now());
        const modal=new ModalBuilder().setCustomId(`availability:${editor.id}:save`).setTitle("Edit weekly window");
        for (const [field,text,value,max] of [["day","Weekday: Monday=0 through Sunday=6",String(window.weekday),1],["start","Local start (HH:mm)",clock(window.startMinute),5],
          ["end","Local end (HH:mm)",clock(window.endMinute),5],["timezone","IANA timezone",current!.timezone,100]] as [string,string,string,number][]) {
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(field).setLabel(text).setValue(value).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true)));
        }
        await i.showModal(modal);return true;
      }
      if (action==="delete" && i.isButton()) {
        if (!current || !current.windows.some(window=>window.id===data.selected)) throw new CommandError("Choose a window first. Reopen the menu.");
        const saved=database.community.availability.save({...current,windows:current.windows.filter(window=>window.id!==data.selected)},data.revision,now());data.revision=saved.revision;
        await i.update(menu(session,saved));return true;
      }
      if (action==="select" && i.isStringSelectMenu()) {
        if (!current?.windows.some(window=>window.id===i.values[0])) throw new CommandError("Choose an existing window.");data.selected=i.values[0];
      } else if (action==="previous" && i.isButton()) data.page=Math.max(0,data.page-1);
      else if (action==="next" && i.isButton()) data.page++;
      else throw new CommandError("Reopen your availability menu.");
      await i.update(menu(session,current));return true;
    },
  };
}
export const availabilityCommand=createAvailabilityCommand();
