import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags } from 'discord.js';
import { communityFixture } from './helpers/community.mjs';
const events=await import('../dist/commands/event.js').catch(()=>({}));
const { CommunitySessions }=await import('../dist/community/sessions.js');
const { CommunityService }=await import('../dist/community/service.js');
const delivery=await import('../dist/community/eventDelivery.js').catch(()=>({}));
const input=(f,extra={})=>({guildId:'g',channelId:'c',creatorId:'u',title:'Team night',description:'Play',startAt:f.now()+3600000,durationMinutes:120,capacity:2,squads:[],reminderMinutes:0,...extra});
function interaction(f,sub,values={}){return {guild:f.guild,guildId:'g',channelId:'c',user:{id:'u'},options:{getSubcommand:()=>sub,getString:k=>values[k]??null,getInteger:k=>values[k]??null},async deferReply(p){this.deferred=p;},async editReply(p){this.output=p;return{id:'private'};},async reply(p){this.output=p;return{id:'private'};},async fetchReply(){return{id:'private'};}};}
function control(f,id,extra={}){return {...interaction(f,''),customId:id,message:{id:'private'},isButton:()=>true,isStringSelectMenu:()=>false,isModalSubmit:()=>false,async update(p){this.output=p;},async deferUpdate(){this.deferred=true;},async showModal(p){this.modal=p;},...extra};}
const button=(payload,text)=>payload.components.flatMap(x=>x.components).find(x=>x.data.label===text).data.custom_id;
function setup(f){f.addMember('u',['manager']);f.db.setManagerRole('g','manager');return events.createEventCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});}

test('officer creation previews interpreted date/offset privately before explicit shared-worker publication',async()=>{const f=communityFixture();try{
 assert.equal(typeof events.createEventCommand,'function');const command=setup(f),i=interaction(f,'create',{title:'Team night',start:'2026-10-18 10:00',timezone:'America/Bahia'});await command.execute(i);
 assert.equal(i.deferred.flags,MessageFlags.Ephemeral);assert.match(JSON.stringify(i.output),/2026-10-18 10:00|UTC-03:00/);assert.equal(f.calls.sends.length,0);
 const draft=f.db.community.events.list('g')[0];assert.equal(draft.status,'draft');await command.handleInteraction(control(f,button(i.output,'Publish')));
 const service=new CommunityService(f.client,f.db,f.api,{now:f.now});f.services.push(service);delivery.registerEventWork(service,f.client,f.db);await service.runOnce();
 assert.equal(f.calls.sends.length,1);const saved=f.db.community.events.get('g',draft.id);assert.equal(saved.status,'scheduled');assert.equal(saved.messageId,'message-1');assert.match(JSON.stringify(f.calls.sends[0]),/Join|Withdraw|Reminder/);
 }finally{await f.close();}});
test('private management rejects another owner, removed officer and stale revision',async()=>{const f=communityFixture();try{const c=setup(f),i=interaction(f,'create',{title:'Team',start:'2026-10-18 13:00',timezone:'UTC'});await c.execute(i);const id=button(i.output,'Publish');
 await assert.rejects(c.handleInteraction(control(f,id,{user:{id:'intruder'}})),/reopen/i);f.setRoles('u',[]);await assert.rejects(c.handleInteraction(control(f,id)),/officer|manager/i);f.setRoles('u',['manager']);const e=f.db.community.events.list('g')[0];f.db.community.events.edit('g',e.id,1,{title:'Changed'},f.now());await assert.rejects(c.handleInteraction(control(f,id)),/changed|reopen/i);
 }finally{await f.close();}});
test('public binding and malformed ids reject, squad picker owns private binding and joins correct public event',async()=>{const f=communityFixture();try{const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f,{capacity:20,squads:Array.from({length:20},(_,n)=>({id:`s${n}`,name:`Squad ${n}`,capacity:1}))}),f.now());s.publish('g',e.id,1,'public');
 await assert.rejects(c.handleInteraction(control(f,`event:${e.id}:join:1`)),/message|original/i);await assert.rejects(c.handleInteraction(control(f,'event:malformed')),/reopen|invalid/i);
 const picker=control(f,`event:${e.id}:squad:1`,{message:{id:'public'}});await c.handleInteraction(picker);assert.equal(picker.output.components[0].components[0].options.length,20);
 const id=picker.output.components[0].components[0].data.custom_id;await assert.rejects(c.handleInteraction(control(f,id,{user:{id:'intruder'},isButton:()=>false,isStringSelectMenu:()=>true,values:['s0']})),/reopen/i);
 await c.handleInteraction(control(f,id,{isButton:()=>false,isStringSelectMenu:()=>true,values:['s0']}));assert.equal(s.signups('g',e.id)[0].squadId,'s0');
 }finally{await f.close();}});
test('100 members paginate without losing reserves and cards disable controls at event start',async()=>{const f=communityFixture();try{const e=input(f,{id:'event-id',revision:1,messageId:'m',status:'scheduled',createdAt:f.now()});const list=Array.from({length:100},(_,n)=>({discordId:String(100000000000000000n+BigInt(n)),squadId:null,state:n<2?'confirmed':'reserve',sequence:n+1,reminder:false}));
 const first=events.renderEvent(e,list,1),last=events.renderEvent(e,list,5);assert.match(JSON.stringify(first),/100000000000000000/);assert.doesNotMatch(JSON.stringify(first),/100000000000000099/);assert.match(JSON.stringify(last),/100000000000000099/);assert.ok(JSON.stringify(first).length<6000);
 const closed=events.renderEvent({...e,startAt:f.now()},list,1,f.now());assert.ok(closed.components[0].components.every(b=>b.data.disabled));
 }finally{await f.close();}});
test('noncanonical view/list link to signup card and carry no persistent public controls',async()=>{const f=communityFixture();try{const c=setup(f),e=f.db.community.events.createDraft(input(f),f.now());f.db.community.events.publish('g',e.id,1,'public');const view=interaction(f,'view',{id:e.id});await c.execute(view);assert.deepEqual(view.output.components,[]);assert.match(view.output.content,/channels\/g\/c\/public/);assert.equal(f.db.community.events.get('g',e.id).messageId,'public');
 const list=interaction(f,'list');await c.execute(list);assert.equal(list.output.components,undefined);
 }finally{await f.close();}});
test('event updates edit canonical card, obsolete revisions do not post, and failed initial publication remains draft',async()=>{const f=communityFixture();try{setup(f);const s=f.db.community.events,e=s.createDraft(input(f),f.now());s.requestPublish('g',e.id,1,f.now());const service=new CommunityService(f.client,f.db,f.api,{now:f.now});f.services.push(service);delivery.registerEventWork(service,f.client,f.db);await service.runOnce();s.join('g',e.id,'u',null,f.now());await service.runOnce();assert.equal(f.calls.sends.length,1);assert.equal(f.calls.edits.length,1);assert.match(JSON.stringify(f.calls.edits[0]),/1\/2 confirmed/);
 const current=s.get('g',e.id);s.edit('g',e.id,current.revision,{title:'New time'},f.now());s.cancel('g',e.id,current.revision+1,f.now());await service.runOnce();assert.equal(f.calls.sends.length,1);assert.match(JSON.stringify(f.calls.edits.at(-1)),/cancelled/);
 const failed=s.createDraft(input(f),f.now());s.requestPublish('g',failed.id,1,f.now());f.channel.send=async()=>{throw Object.assign(Error('No permission'),{code:50013});};await service.runOnce();assert.equal(s.get('g',failed.id).status,'draft');assert.equal(f.db.community.deliveries.list('g').at(-1).status,'paused');
 }finally{await f.close();}});
test('maximum text and twenty squads render within all embed field and combined text limits',()=>{
 const e={guildId:'g',channelId:'c',creatorId:'u',id:'id',revision:1,messageId:'m',status:'scheduled',createdAt:0,title:'*'.repeat(100),description:'*'.repeat(1000),settingsText:'*'.repeat(500),startAt:Date.now()+3600000,durationMinutes:120,capacity:20,reminderMinutes:0,squads:Array.from({length:20},(_,n)=>({id:String(n),name:'*'.repeat(60),capacity:1}))};
 const card=events.renderEvent(e,Array.from({length:100},(_,n)=>({discordId:'100000000000000001',squadId:String(n%20),state:'reserve',sequence:n+1,reminder:false}))).embeds[0].toJSON();
 assert.ok(card.fields.every(f=>f.value.length<=1024));assert.ok([card.title,card.description,card.footer.text,...card.fields.flatMap(f=>[f.name,f.value])].join('').length<=5800);
});
test('public join withdrawal and reminder actions use fresh memberships and update canonical signup state',async()=>{const f=communityFixture();try{const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f,{capacity:1,reminderMinutes:15}),f.now());s.publish('g',e.id,1,'public');f.addMember('reserve');
 const id=action=>`event:${e.id}:${action}:1`,click=control(f,id('join'),{message:{id:'public'}});await c.handleInteraction(click);assert.equal(s.signup('g',e.id,'u').state,'confirmed');await c.handleInteraction(control(f,id('reminder'),{message:{id:'public'}}));assert.equal(s.signup('g',e.id,'u').reminder,true);
 await c.handleInteraction(control(f,id('join'),{user:{id:'reserve'},message:{id:'public'}}));const before=f.calls.memberFetches.length;await c.handleInteraction(control(f,id('withdraw'),{message:{id:'public'}}));assert.equal(f.calls.memberFetches.length-before,1);assert.equal(s.signup('g',e.id,'reserve').state,'confirmed');assert.equal(s.signup('g',e.id,'u'),null);
 }finally{await f.close();}});
test('a revision changed during member lookup rejects a stale public join',async()=>{const f=communityFixture();try{const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f),f.now());s.publish('g',e.id,1,'public');const fetch=f.guild.members.fetch;f.guild.members.fetch=async args=>{const result=await fetch(args);s.edit('g',e.id,1,{title:'Changed during lookup'},f.now());return result;};
 await assert.rejects(c.handleInteraction(control(f,`event:${e.id}:join:1`,{message:{id:'public'}})),/changed|refresh/i);assert.deepEqual(s.signups('g',e.id),[]);
 }finally{await f.close();}});
test('a successful publication whose binding fails remains reviewable without an automatic duplicate post',async()=>{const f=communityFixture();try{setup(f);const s=f.db.community.events,e=s.createDraft(input(f),f.now());s.requestPublish('g',e.id,1,f.now());const publish=s.publish.bind(s);s.publish=()=>{throw Error('Binding failed');};const service=new CommunityService(f.client,f.db,f.api,{now:f.now});f.services.push(service);delivery.registerEventWork(service,f.client,f.db);await service.runOnce();assert.equal(f.calls.sends.length,1);assert.equal(s.get('g',e.id).status,'draft');assert.equal(f.db.community.deliveries.list('g')[0].status,'needs_review');await service.runOnce();assert.equal(f.calls.sends.length,1);s.publish=publish;
 }finally{await f.close();}});
test('officer modal edits save checked fields and squads, and another owner cannot submit the modal',async()=>{const f=communityFixture();try{const c=setup(f),i=interaction(f,'create',{title:'Team',start:'2026-10-18 13:00',timezone:'UTC',capacity:2});await c.execute(i);let e=f.db.community.events.list('g')[0];
 const details=control(f,button(i.output,'Edit details'));await c.handleInteraction(details);const values={title:'Updated',description:'New description',schedule:'2026-10-19 14:00 | America/Bahia | -03:00',limits:'2, 60, 30',settings:'Team settings'};
 const save=control(f,details.modal.data.custom_id,{isButton:()=>false,isModalSubmit:()=>true,fields:{getTextInputValue:k=>values[k]}});
 await assert.rejects(c.handleInteraction({...save,user:{id:'other'}}),/reopen/i);await c.handleInteraction(save);e=f.db.community.events.get('g',e.id);assert.equal(e.title,'Updated');assert.equal(e.startAt,Date.UTC(2026,9,19,17));assert.equal(e.reminderMinutes,30);
 const edit=interaction(f,'edit',{id:e.id});await c.execute(edit);const squads=control(f,button(edit.output,'Edit squads'));await c.handleInteraction(squads);await c.handleInteraction(control(f,squads.modal.data.custom_id,{isButton:()=>false,isModalSubmit:()=>true,fields:{getTextInputValue:id=>({capacity:'2',squads:'red | Red team | 1\nblue | Blue team | 1'})[id]}}));assert.equal(f.db.community.events.get('g',e.id).squads.length,2);
 }finally{await f.close();}});
test('create rejects ambiguous or nonexistent local dates before persisting a draft',async()=>{const f=communityFixture();try{const c=setup(f);for(const start of ['2026-11-01 01:30','2027-03-14 02:30'])await assert.rejects(c.execute(interaction(f,'create',{title:'Team',start,timezone:'America/New_York'})),/repeats|offset|gap/i);assert.deepEqual(f.db.community.events.list('g'),[]);
 }finally{await f.close();}});
test('forged squad action rejects an event without squads and rapid changes coalesce to one current card update',async()=>{const f=communityFixture();try{const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f),f.now());s.publish('g',e.id,1,'public');await assert.rejects(c.handleInteraction(control(f,`event:${e.id}:squad:1`,{message:{id:'public'}})),/no squads/i);
 for(let n=0;n<10;n++)s.join('g',e.id,`member-${n}`,null,f.now());const pending=f.db.community.deliveries.list('g').filter(j=>j.status==='pending');assert.equal(pending.length,1);assert.equal(pending[0].kind,'event_update');
 }finally{await f.close();}});
test('squad management atomically grows and shrinks total capacity while preserving occupied seats',async()=>{
 const f=communityFixture();try{
  const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f,{squads:[{id:'red',name:'Red',capacity:1},{id:'blue',name:'Blue',capacity:1}]}),f.now());
  s.publish('g',e.id,1,'public');s.join('g',e.id,'red-member','red',f.now());s.join('g',e.id,'blue-member','blue',f.now());const original=s.signups('g',e.id);
  async function resize(capacity,text){
   const view=interaction(f,'edit',{id:e.id});await c.execute(view);const editor=control(f,button(view.output,'Edit squads'));await c.handleInteraction(editor);
   await c.handleInteraction(control(f,editor.modal.data.custom_id,{isButton:()=>false,isModalSubmit:()=>true,fields:{getTextInputValue:id=>({capacity:String(capacity),squads:text})[id]}}));
   assert.ok(editor.modal.components.some(row=>row.components.some(field=>field.data.custom_id==='capacity')),'The officer must be able to enter the matching total capacity');
  }
  await resize(3,'red | Red | 2\nblue | Blue | 1');assert.equal(s.get('g',e.id).capacity,3);assert.deepEqual(s.signups('g',e.id),original);
  s.join('g',e.id,'another-red','red',f.now());const occupied=s.get('g',e.id),three=s.signups('g',e.id);
  await assert.rejects(resize(3,'red | Red | 1\nblue | Blue | 2'),/capacity|occupancy/i);assert.deepEqual(s.get('g',e.id),occupied);assert.deepEqual(s.signups('g',e.id),three);
  await assert.rejects(resize(2,'red | Red | 1\nblue | Blue | 1'),/capacity|occupancy/i);assert.deepEqual(s.get('g',e.id),occupied);assert.deepEqual(s.signups('g',e.id),three);
  s.withdraw('g',e.id,'another-red',new Set(['red-member','blue-member']),f.now());await resize(2,'red | Red | 1\nblue | Blue | 1');assert.equal(s.get('g',e.id).capacity,2);assert.deepEqual(s.signups('g',e.id),original);
 }finally{await f.close();}
});

test('officer management exposes reminder failures and fresh authorization guards deliberate retry', async () => {
 const f=communityFixture();try {
  const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f,{reminderMinutes:30}),f.now());
  const service=new CommunityService(f.client,f.db,f.api,{now:f.now});f.services.push(service);delivery.registerEventWork(service,f.client,f.db);
  s.requestPublish('g',e.id,1,f.now());await service.runOnce();
  const user='100000000000000001';f.addMember(user);s.join('g',e.id,user,null,f.now());s.setReminder('g',e.id,user,true,f.now());
  const send=f.channel.send;f.channel.send=async()=>{throw Object.assign(Error('Missing Permissions'),{code:50013});};
  f.advance(1800000);await service.runOnce();
  const job=f.db.community.deliveries.list('g').find(j=>j.kind==='event_reminder');assert.equal(job.status,'paused');
  const i=interaction(f,'edit',{id:e.id});await c.execute(i);assert.match(JSON.stringify(i.output),/event_reminder: paused/);
  const retry=control(f,button(i.output,'Retry / reconcile'));f.setRoles('u',[]);
  await assert.rejects(c.handleInteraction(retry),/officer|manager/i);assert.equal(f.db.community.deliveries.get(job.id).status,'paused');
  f.setRoles('u',['manager']);await c.handleInteraction(retry);assert.equal(f.db.community.deliveries.get(job.id).status,'pending');
  f.channel.send=send;await service.runOnce();assert.equal(f.db.community.deliveries.get(job.id).status,'sent');
  assert.equal(f.calls.sends.length,2);assert.deepEqual(f.calls.sends[1].allowedMentions.users,[user]);
 }finally{await f.close();}
});

test('command and delivery rendering never request an unbounded signup list', async () => {
 const f=communityFixture();try {
  const c=setup(f),s=f.db.community.events,e=s.createDraft(input(f),f.now());
  s.signups=()=>{throw Error('Unbounded public read');};
  const service=new CommunityService(f.client,f.db,f.api,{now:f.now});f.services.push(service);delivery.registerEventWork(service,f.client,f.db);
  s.requestPublish('g',e.id,1,f.now());await service.runOnce();assert.equal(f.calls.sends.length,1);
  const view=interaction(f,'view',{id:e.id});await c.execute(view);assert.match(JSON.stringify(view.output),/0\/2 confirmed/);
  const e2=s.get('g',e.id);const refresh=control(f,`event:${e.id}:refresh:${e2.revision}:1`,{message:{id:e2.messageId}});
  await c.handleInteraction(refresh);assert.match(JSON.stringify(refresh.output),/Participants|0\/2 confirmed/);
  s.join('g',e.id,'u',null,f.now());await service.runOnce();assert.equal(f.calls.edits.length,1);
 }finally{await f.close();}
});
