import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communityFixture } from './helpers/community.mjs';
const { CommunityStore } = await import('../dist/community/store.js');
const draft=(now,extra={})=>({guildId:'g',channelId:'c',creatorId:'officer',title:'Team night',description:'Play together',startAt:now+3600000,durationMinutes:120,capacity:2,squads:[],reminderMinutes:0,...extra});
function published(f,extra={}) { const e=f.db.community.events.createDraft(draft(f.now(),extra),f.now());return f.db.community.events.publish('g',e.id,e.revision,'public'); }

test('atomic joins preserve FIFO sequence and promote only present reserves after idempotent withdrawal',async()=>{
 const f=communityFixture();try {const s=f.db.community.events,e=published(f);for(const id of ['a','b','c','d'])s.join('g',e.id,id,null,f.now());
 assert.deepEqual(s.signups('g',e.id).map(x=>x.state),['confirmed','confirmed','reserve','reserve']);
 assert.equal(s.join('g',e.id,'c',null,f.now()).sequence,3);
 s.withdraw('g',e.id,'a',new Set(['b','c','d']),f.now());s.withdraw('g',e.id,'a',new Set(['b','c','d']),f.now());
 assert.deepEqual(s.signups('g',e.id).map(x=>[x.discordId,x.state]),[['b','confirmed'],['c','confirmed'],['d','reserve']]);
 }finally{await f.close();}
});
test('squad moves and departed reserve removal are atomic and compose with rollback',async()=>{
 const f=communityFixture();try{const s=f.db.community.events,e=published(f,{squads:[{id:'red',name:'Red',capacity:1},{id:'blue',name:'Blue',capacity:1}]});
 for(const [id,squad] of [['a','red'],['b','blue'],['gone','red'],['c','red']])s.join('g',e.id,id,squad,f.now());
 const eligible=new Set(['a','b','c']);s.move('g',e.id,'a','blue',eligible,f.now());
 assert.deepEqual(s.signups('g',e.id).map(x=>[x.discordId,x.squadId,x.state]),[['a','blue','reserve'],['b','blue','confirmed'],['c','red','confirmed']]);
 const before=s.signups('g',e.id);assert.throws(()=>f.db.community.transaction(()=>{s.withdraw('g',e.id,'b',eligible,f.now());throw Error('rollback');}),/rollback/);assert.deepEqual(s.signups('g',e.id),before);
 }finally{await f.close();}
});
test('edits validate occupancy and revisions without changes and start instant closes signup/promotion',async()=>{
 const f=communityFixture();try{const s=f.db.community.events,e=published(f);s.join('g',e.id,'a',null,f.now());s.join('g',e.id,'b',null,f.now());
 assert.throws(()=>s.edit('g',e.id,e.revision,{capacity:1},f.now()),/capacity|occupied/i);assert.deepEqual(s.get('g',e.id),e);
 assert.throws(()=>s.edit('g',e.id,0,{title:'stale'},f.now()),/changed|revision/i);
 f.advance(3600000);assert.throws(()=>s.join('g',e.id,'c',null,f.now()),/closed|start/i);assert.throws(()=>s.promote('g',e.id,new Set(['a','b']),f.now()),/closed|start/i);
 }finally{await f.close();}
});
test('occupied squads cannot disappear, defaults and validation reject malformed domain inputs',async()=>{
 const f=communityFixture();try{const s=f.db.community.events,e=published(f,{squads:[{id:'red',name:'Red',capacity:2}]});s.join('g',e.id,'a','red',f.now());
 assert.throws(()=>s.edit('g',e.id,1,{squads:[]},f.now()),/occupied|squad/i);
 for(const extra of [{capacity:0},{capacity:101},{durationMinutes:14},{durationMinutes:721},{startAt:f.now()},{startAt:f.now()+366*86400000},{squads:Array.from({length:21},(_,n)=>({id:String(n),name:'s',capacity:1}))},{squads:[{id:'x',name:'x',capacity:1}]}])assert.throws(()=>s.createDraft(draft(f.now(),extra),f.now()));
 }finally{await f.close();}
});
test('departure removes active signups, marks promotion due and guild removal clears event records',async()=>{
 const f=communityFixture();try{const s=f.db.community.events,e=published(f);s.join('g',e.id,'a',null,f.now());f.db.community.purgeIdentity('a','g');assert.equal(s.signups('g',e.id).length,1);
 f.db.community.purgeMember('g','a');assert.deepEqual(s.signups('g',e.id),[]);assert.equal(s.promotionDue('g',10).length,1);f.db.community.purgeGuild('g');assert.deepEqual(s.list('g'),[]);
 }finally{await f.close();}
});
test('restart retains ordered signups and monotonically increasing sequence after deletions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'community-events-')),path=join(dir,'state.sqlite');let sql;
 try{sql=new DatabaseSync(path);CommunityStore.initialize(sql);let c=new CommunityStore(sql),e=c.events.createDraft(draft(1000),1000);c.events.publish('g',e.id,1,'m');c.events.join('g',e.id,'a',null,1000);c.events.join('g',e.id,'b',null,1000);c.events.withdraw('g',e.id,'b',new Set(['a']),1000);sql.close();
 sql=new DatabaseSync(path);c=new CommunityStore(sql);assert.equal(c.events.join('g',e.id,'c',null,1000).sequence,3);assert.deepEqual(c.events.signups('g',e.id).map(x=>x.discordId),['a','c']);
 }finally{sql?.close();rmSync(dir,{recursive:true,force:true});}
});
test('new arrivals cannot leapfrog existing reserves after capacity grows',async()=>{const f=communityFixture();try{
 const s=f.db.community.events,e=published(f,{capacity:1});s.join('g',e.id,'first',null,f.now());s.join('g',e.id,'waiting',null,f.now());s.edit('g',e.id,1,{capacity:2},f.now());
 assert.equal(s.join('g',e.id,'new',null,f.now()).state,'reserve');s.promote('g',e.id,new Set(['first','waiting','new']),f.now());assert.deepEqual(s.signups('g',e.id).map(s=>s.state),['confirmed','confirmed','reserve']);
 }finally{await f.close();}});
test('event management diagnostics select only that event and return at most five unresolved jobs',async()=>{const f=communityFixture();try{
 const s=f.db.community.events,e=published(f);for(let n=0;n<12;n++)for(const subjectId of [e.id,'other'])f.db.community.deliveries.enqueue({key:`job:${subjectId}:${n}`,guildId:'g',channelId:'c',kind:'event_update',subjectId,revision:1,dueAt:f.now()+n,part:0});
 const jobs=s.deliveryJobs('g',e.id);assert.equal(jobs.length,5);assert.ok(jobs.every(j=>j.subjectId===e.id));assert.equal(s.deliveryJobs('other',e.id).length,0);
 }finally{await f.close();}});
test('a single squad-capacity edit changes total capacity with the matching squad limits and preserves occupancy',async()=>{
 const f=communityFixture();try{const s=f.db.community.events,e=published(f,{squads:[{id:'red',name:'Red',capacity:1},{id:'blue',name:'Blue',capacity:1}]});s.join('g',e.id,'a','red',f.now());s.join('g',e.id,'b','blue',f.now());const before=s.signups('g',e.id);
  const grown=s.edit('g',e.id,1,{capacity:3,squads:[{id:'red',name:'Red',capacity:2},{id:'blue',name:'Blue',capacity:1}]},f.now());assert.equal(grown.capacity,3);assert.equal(grown.squads[0].capacity,2);assert.deepEqual(s.signups('g',e.id),before);
  const shrunk=s.edit('g',e.id,grown.revision,{capacity:2,squads:[{id:'red',name:'Red',capacity:1},{id:'blue',name:'Blue',capacity:1}]},f.now());assert.equal(shrunk.capacity,2);assert.deepEqual(s.signups('g',e.id),before);
  assert.throws(()=>s.edit('g',e.id,shrunk.revision,{capacity:1,squads:[{id:'red',name:'Red',capacity:1}]},f.now()),/capacity|occupancy|occupied/i);assert.deepEqual(s.get('g',e.id),shrunk);assert.deepEqual(s.signups('g',e.id),before);
 }finally{await f.close();}
});
