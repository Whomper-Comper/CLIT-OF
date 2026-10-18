import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageFlags } from 'discord.js';
import { DatabaseSync } from 'node:sqlite';
import { communityFixture } from './helpers/community.mjs';
const { createAvailabilityCommand } = await import('../dist/commands/availability.js');
const { CommunitySessions } = await import('../dist/community/sessions.js');
const { CommunityStore } = await import('../dist/community/store.js');
const draft = (extra={}) => ({ guildId:'g', discordId:'u', timezone:'UTC', windows:[{id:'w',weekday:0,startMinute:600,endMinute:720}], ...extra });
function interaction(f, sub, values={}, user='u') {
  return { guild:f.guild,guildId:'g',channelId:'c',user:{id:user},
    options:{getSubcommand:()=>sub,getString:key=>values[key]??null,getInteger:key=>values[key]??null,getUser:key=>values[key]??null},
    async deferReply(p){this.deferred=p;}, async reply(p){this.output=p;return {id:'m'};},async editReply(p){this.output=p;return {id:'m'};} };
}

test('availability validates local rules, revisions and limits before persisting',async()=>{
  const f=communityFixture();try {
    const store=f.db.community.availability;
    for (const bad of [draft({timezone:'No/Zone'}),draft({windows:[{id:'w',weekday:7,startMinute:1,endMinute:31}]}),draft({windows:[{id:'w',weekday:1,startMinute:1,endMinute:1}]}),draft({windows:[{id:'w',weekday:1,startMinute:0,endMinute:721}]}),draft({windows:Array.from({length:15},(_,id)=>({id:String(id),weekday:1,startMinute:1,endMinute:31}))})]) assert.throws(()=>store.save(bad,0,f.now()), /timezone|window/i);
    const saved=store.save(draft(),0,f.now());assert.equal(saved.revision,1);assert.equal(saved.updatedAt,f.now());
    assert.throws(()=>store.save(draft(),0,f.now()),/changed|reopen/i);
    assert.deepEqual(store.get('other','u'),null);
    f.db.community.purgeIdentity('u');assert.equal(store.get('g','u').windows.length,1);
    f.db.community.purgeMember('g','u');assert.equal(store.get('g','u'),null);
    store.save(draft(),0,f.now());f.db.community.purgeGuild('g');assert.deepEqual(store.list('g'),[]);
  }finally{await f.close();}
});

test('set requires first timezone, replaces matching windows, and personal payloads stay private',async()=>{
  const f=communityFixture();try{
    const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    await assert.rejects(command.execute(interaction(f,'set',{day:0,start:'10:00',end:'12:00'})),/timezone/i);
    const first=interaction(f,'set',{day:0,start:'10:00',end:'12:00',timezone:'UTC'});await command.execute(first);
    assert.equal(first.output.flags,MessageFlags.Ephemeral);
    await command.execute(interaction(f,'set',{day:0,start:'10:00',end:'12:00'}));assert.equal(f.db.community.availability.get('g','u').windows.length,1);
    const id=f.db.community.availability.get('g','u').windows[0].id;
    await command.execute(interaction(f,'set',{day:1,start:'11:00',end:'13:00',window:id}));assert.equal(f.db.community.availability.get('g','u').windows.length,1);
    const view=interaction(f,'view');await command.execute(view);assert.equal(view.deferred.flags,MessageFlags.Ephemeral);assert.ok(view.output.components.length);
    await command.execute(interaction(f,'clear',{window:id}));assert.equal(f.db.community.availability.get('g','u').windows.length,0);
  }finally{await f.close();}
});

test('view denies other members without fresh officer authorization and permits mapped officers',async()=>{
  const f=communityFixture();try{
    f.addMember('u');f.addMember('other');f.db.community.availability.save(draft({discordId:'other'}),0,f.now());
    const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    await assert.rejects(command.execute(interaction(f,'view',{user:{id:'other'}})),/officer|manager/i);
    f.db.setManagerRole('g','manager');f.setRoles('u',['manager']);
    const view=interaction(f,'view',{user:{id:'other'}});await command.execute(view);assert.equal(view.deferred.flags,MessageFlags.Ephemeral);
    assert.ok(f.calls.memberFetches.every(request=>request.force));
  }finally{await f.close();}
});

test('public suggestions filter departed members once and contain counts without private ids or schedules',async()=>{
  const f=communityFixture();try{
    f.addMember('private-member');
    for(const discordId of ['private-member','departed-member']) f.db.community.availability.save(draft({discordId}),0,f.now());
    const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});const i=interaction(f,'suggest');await command.execute(i);
    assert.equal(i.deferred?.flags,undefined);const payload=JSON.stringify(i.output);assert.match(payload,/1 member/);assert.doesNotMatch(payload,/private-member|departed-member|startMinute|windows|memberIds/);
    assert.equal(f.calls.memberFetches.length,1);assert.deepEqual(i.output.allowedMentions,{parse:[]});
  }finally{await f.close();}
});

function control(f, customId, user='u', extra={}) {
  return {guild:f.guild,guildId:'g',channelId:'c',message:{id:'m'},user:{id:user},customId,
    isButton:()=>true,isStringSelectMenu:()=>false,isModalSubmit:()=>false,
    async update(payload){this.output=payload;},async showModal(modal){this.modal=modal;},async reply(payload){this.output=payload;},...extra};
}
const buttonId=(output,text)=>output.components.flatMap(row=>row.components).find(button=>button.data.label===text).data.custom_id;

test('private controls reject wrong owner, channel, message, expiry and changed revisions',async()=>{
  const f=communityFixture();try{
    const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    f.db.community.availability.save(draft(),0,f.now());const view=interaction(f,'view');await command.execute(view);
    const id=buttonId(view.output,'Delete window');
    for (const changes of [{user:{id:'intruder'}},{channelId:'elsewhere'},{message:{id:'different'}}]) await assert.rejects(command.handleInteraction(control(f,id,'u',changes)),/reopen/i);
    const current=f.db.community.availability.get('g','u');f.db.community.availability.save({...current,timezone:'America/Bahia'},current.revision,f.now());
    await assert.rejects(command.handleInteraction(control(f,id)),/changed|reopen/i);assert.equal(f.db.community.availability.get('g','u').windows.length,1);
    const fresh=interaction(f,'view');await command.execute(fresh);f.advance(600000);
    await assert.rejects(command.handleInteraction(control(f,buttonId(fresh.output,'Delete window'))),/expired|reopen/i);
  }finally{await f.close();}
});

test('modal editing keeps the chosen window fixed when the original menu selection changes',async()=>{
  const f=communityFixture();try{
    const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    f.db.community.availability.save(draft({windows:[{id:'first',weekday:0,startMinute:600,endMinute:720},{id:'second',weekday:1,startMinute:600,endMinute:720}]}),0,f.now());
    const view=interaction(f,'view');await command.execute(view);
    const edit=control(f,buttonId(view.output,'Edit window'));await command.handleInteraction(edit);
    const selectId=view.output.components[0].components[0].data.custom_id;
    await command.handleInteraction(control(f,selectId,'u',{isButton:()=>false,isStringSelectMenu:()=>true,values:['second']}));
    const submit=control(f,edit.modal.data.custom_id,'u',{isButton:()=>false,isModalSubmit:()=>true,
      fields:{getTextInputValue:key=>({day:'2',start:'14:00',end:'16:00',timezone:'UTC'})[key]}});
    await command.handleInteraction(submit);
    const saved=f.db.community.availability.get('g','u');
    assert.equal(saved.windows.find(window=>window.id==='first').weekday,2);
    assert.equal(saved.windows.find(window=>window.id==='second').weekday,1);
    assert.equal(submit.output.flags,MessageFlags.Ephemeral);
  }finally{await f.close();}
});

test('clear and recreation cannot revive a stale availability revision',async()=>{
  const f=communityFixture();try {
    const store=f.db.community.availability;const first=store.save(draft(),0,f.now());store.clear('g','u');
    const replacement=store.save(draft({timezone:'America/Bahia'}),0,f.now());
    assert.ok(replacement.revision>first.revision);assert.throws(()=>store.save(draft(),first.revision,f.now()),/changed/i);
  }finally{await f.close();}
});

test('latest availability evidence is bounded, survives age and unlink, and clears with schedules or departure',()=>{
  const sql=new DatabaseSync(':memory:');CommunityStore.initialize(sql);const community=new CommunityStore(sql);
  const evidence=()=>sql.prepare('SELECT guild_id,discord_id,changed_at,revision FROM community_availability_changes').all().map(row=>({...row}));
  try{
    const first=community.availability.save(draft(),0,1000);
    const saved=community.availability.save(draft({timezone:'America/Bahia'}),first.revision,2000);
    assert.deepEqual(evidence(),[{guild_id:'g',discord_id:'u',changed_at:2000,revision:saved.revision}]);
    community.prune(2000+120*86400000);community.purgeIdentity('u');community.purgeAccount('account');
    assert.equal(evidence().length,1);assert.equal(community.availability.get('g','u').timezone,'America/Bahia');
    community.availability.clear('g','u');assert.deepEqual(evidence(),[]);
    const cleared=sql.prepare('SELECT timezone,windows,updated_at FROM community_availability WHERE guild_id=? AND discord_id=?').get('g','u');
    assert.deepEqual({...cleared},{timezone:'',windows:null,updated_at:0});
    const fresh=community.availability.save(draft(),0,3000);community.availability.save(draft({windows:[]}),fresh.revision,4000);assert.deepEqual(evidence(),[]);
    community.availability.save(draft(),community.availability.get('g','u').revision,5000);community.purgeMember('g','u');assert.deepEqual(evidence(),[]);
    community.availability.save(draft(),0,6000);community.purgeGuild('g');assert.deepEqual(evidence(),[]);
  }finally{sql.close();}
});

test('fourteen-window view paginates and delete affects only the selected window',async()=>{
  const f=communityFixture();try{
    const windows=Array.from({length:14},(_,id)=>({id:`w${id}`,weekday:id%7,startMinute:id<7?600:800,endMinute:id<7?630:80}));
    // Two allowed windows per weekday; the second lasts exactly twelve hours.
    f.db.community.availability.save(draft({windows}),0,f.now());
    const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    const view=interaction(f,'view');await command.execute(view);
    assert.equal(view.output.components[0].components[0].options.length,7);
    const next=control(f,buttonId(view.output,'Next'));await command.handleInteraction(next);
    assert.match(next.output.embeds[0].data.footer.text,/Page 2\/2/);assert.equal(next.output.components[0].toJSON().components[0].options[0].value,'w7');
    const remove=control(f,buttonId(next.output,'Delete window'));await command.handleInteraction(remove);
    assert.equal(f.db.community.availability.get('g','u').windows.length,13);assert.equal(f.db.community.availability.get('g','u').windows.some(window=>window.id==='w7'),false);
  }finally{await f.close();}
});

test('mapped officer view controls recheck a role revoked after opening the private view',async()=>{
  const f=communityFixture();try{
    f.addMember('officer',['officer-role']);f.db.setGuildClanConfig({guild_id:'g',clan_tag:'TEST',member_role_id:'member-role',officer_role_id:'officer-role',leader_role_id:null,join_role_id:null,log_channel_id:null,sync_interval_mins:10,last_sync_at:null});
    f.db.community.availability.save(draft(),0,f.now());const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    const view=interaction(f,'view',{user:{id:'u'}},'officer');await command.execute(view);
    assert.ok(view.output.components.every(row=>row.components.every(component=>!['Edit window','Delete window'].includes(component.data.label))));
    f.setRoles('officer',[]);await assert.rejects(command.handleInteraction(control(f,buttonId(view.output,'Next'),'officer')),/officer|manager/i);
    assert.equal(f.calls.memberFetches.length,2);
  }finally{await f.close();}
});

test('invalid time and short window fail without replacing a valid schedule',async()=>{
  const f=communityFixture();try{
    const saved=f.db.community.availability.save(draft(),0,f.now());const command=createAvailabilityCommand({db:f.db,now:f.now,sessions:new CommunitySessions()});
    for (const values of [{start:'24:00',end:'02:00'},{start:'12:00',end:'12:29'},{start:'12:00',end:'12:00'}]) await assert.rejects(command.execute(interaction(f,'set',{day:1,...values})),/time|window/i);
    assert.deepEqual(f.db.community.availability.get('g','u'),saved);
    const direct={...saved,windows:[{id:'short',weekday:0,startMinute:0,endMinute:29}]};assert.throws(()=>f.db.community.availability.save(direct,saved.revision,f.now()),/window/i);
  }finally{await f.close();}
});
