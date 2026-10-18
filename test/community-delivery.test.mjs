import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communityFixture } from './helpers/community.mjs';
const { CommunityService } = await import('../dist/community/service.js');
const { deliveryMarker } = await import('../dist/community/deliveries.js');
const jobInput = (f, extra = {}) => ({ key: 'one', guildId: 'g', channelId: 'c', kind: 'test', subjectId: 's', revision: 1, dueAt: f.now(), part: 0, ...extra });
function service(f, handler = { prepare: async () => ({ payload: { embeds: [{ title: 'Community', footer: { text: 'Saved footer' } }] } }) }, options = {}) {
  const s = new CommunityService(f.client,f.db,f.api,{ now: f.now, ...options });
  s.registerDelivery('test', handler); f.services.push(s); return s;
}
test('worker bounds requests to eight and sends to four, with suppressed mentions and stable delivery markers', async () => {
  const f = communityFixture();
  try {
    const s = service(f);
    s.registerTask('profiles',async tick => { for (let n=0;n<20 && tick.takeRequest();n++) await f.api.getPlayer('a'); });
    for (let n=0;n<9;n++) f.db.community.deliveries.enqueue(jobInput(f,{key:`job-${n}`,subjectId:`s-${n}`}));
    await s.runOnce();
    assert.equal(f.calls.requests.length,8); assert.equal(f.calls.sends.length,4);
    assert.deepEqual(f.calls.sends[0].allowedMentions,{parse:[]});
    assert.equal(f.calls.sends[0].enforceNonce,true);
    assert.match(f.calls.sends[0].nonce,/^\d{1,25}$/);
    const sent = f.db.community.deliveries.list('g').find(j => j.status==='sent');
    assert.ok(f.calls.sends.some(p => p.embeds[0].footer.text.includes(deliveryMarker(sent))));
    assert.ok(f.calls.sends[0].embeds[0].footer.text.startsWith('Saved footer'));
    for(const payload of f.calls.sends) {
      assert.ok(payload.embeds.length<=10);
      let characters=0;
      for(const embed of payload.embeds) {
        assert.ok((embed.footer?.text.length??0)<=2048);
        characters+=(embed.title?.length??0)+(embed.description?.length??0)+(embed.footer?.text.length??0)+(embed.author?.name.length??0);
        for(const field of embed.fields??[]) characters+=field.name.length+field.value.length;
      }
      assert.ok(characters<=6000);
    }
  } finally { await f.close(); }
});
test('busy guild delivery rotates across ticks and task request budgets rotate too', async () => {
  const f = communityFixture();
  try {
    const s = service(f,undefined,{maxSendsPerTick:1}), requests=[];
    s.registerTask('a',async tick => { while(tick.takeRequest()) requests.push('a'); });
    s.registerTask('b',async tick => { while(tick.takeRequest()) requests.push('b'); });
    for (const guildId of ['a','b']) for(let n=0;n<5;n++) f.db.community.deliveries.enqueue(jobInput(f,{guildId,key:`${guildId}-${n}`}));
    f.client.channels.fetch = async () => ({ ...f.channel, guildId: f.db.community.deliveries.list('a').some(j=>j.status==='sending') ? 'a' : 'b' });
    await s.runOnce(); await s.runOnce();
    assert.equal(f.db.community.deliveries.list('a').filter(j=>j.status==='sent').length,1);
    assert.equal(f.db.community.deliveries.list('b').filter(j=>j.status==='sent').length,1);
    assert.deepEqual(requests,['a','a','a','a','a','a','a','a','b','b','b','b','b','b','b','b']);
  } finally { await f.close(); }
});
test('concurrent ticks share one promise and stopping drains in-flight work without sending afterward', async () => {
  const f = communityFixture(); let release, entered;
  const waiting = new Promise(resolve=>{entered=resolve;});
  try {
    const s = service(f);
    s.registerTask('deferred', async () => { entered(); await new Promise(resolve=>{release=resolve;}); });
    f.db.community.deliveries.enqueue(jobInput(f));
    const first=s.runOnce(),second=s.runOnce(); assert.equal(first,second);
    await waiting; let stopped=false; const stop=s.stop().then(()=>{stopped=true;});
    await Promise.resolve(); assert.equal(stopped,false); release(); await stop;
    assert.equal(f.calls.sends.length,0); await s.runOnce(); assert.equal(f.calls.sends.length,0);
  } finally { release?.(); await f.close(); }
});
test('permission failures pause immediately while definite transient failures back off and pause after ten failures', async () => {
  const f = communityFixture();
  try {
    const s=service(f); f.db.community.deliveries.enqueue(jobInput(f));
    f.channel.send=async()=>{throw Object.assign(new Error('Missing Permissions'),{code:50013});};
    await s.runOnce(); assert.equal(f.db.community.deliveries.list('g')[0].status,'paused');
    const d=f.db.community.deliveries; d.retry('g',d.list('g')[0].id,1,f.now());
    f.channel.send=async()=>{throw Object.assign(new Error('Rate limited'),{status:429});};
    for(const minutes of [1,2,4,8,16,30,30,30,30]) {
      await s.runOnce(); const job=d.list('g')[0]; assert.equal(job.status,'pending'); assert.equal(job.nextAttempt,f.now()+minutes*60000); f.advance(minutes*60000);
    }
    await s.runOnce(); assert.equal(d.list('g')[0].status,'paused');
  } finally { await f.close(); }
});
test('ambiguous sends require review when reconciliation cannot establish a result', async () => {
  const f=communityFixture();
  try {
    const s=service(f); f.db.community.deliveries.enqueue(jobInput(f));
    f.channel.send=async()=>{f.calls.sends.push('attempt'); throw new Error('socket closed');};
    await s.runOnce(); assert.equal(f.db.community.deliveries.list('g')[0].status,'needs_review');
    f.advance(600000); await s.runOnce(); assert.equal(f.calls.sends.length,1);
  } finally { await f.close(); }
});
test('accepted sends recovered from a timeout finish and bind without another post', async () => {
  const f=communityFixture(), bound=[];
  try {
    const s=service(f,{prepare:async()=>({payload:{embeds:[{title:'Card'}]}}),delivered:(job,id)=>bound.push([job.key,id])});
    const send=f.channel.send; f.channel.send=async payload=>{await send(payload);throw new Error('timeout after accept');};
    f.db.community.deliveries.enqueue(jobInput(f)); await s.runOnce();
    assert.equal(f.db.community.deliveries.list('g')[0].status,'sent');
    assert.deepEqual(bound,[['one','message-1']]); assert.equal(f.calls.sends.length,1);
  } finally { await f.close(); }
});
test('expired sending leases reconcile only bot-authored markers and never automatically repost', async () => {
  const f=communityFixture();
  try {
    const s=service(f),d=f.db.community.deliveries; const job=d.enqueue(jobInput(f)); d.claim(f.now(),1);
    f.messages.set('imposter',{id:'imposter',author:{id:'user'},embeds:[{footer:{text:deliveryMarker(job)}}]});
    f.advance(300000); await s.runOnce();
    assert.equal(d.list('g')[0].status,'needs_review'); assert.equal(f.calls.sends.length,0);
    d.retry('g',job.id,1,f.now());
    f.messages.set('recovered',{id:'recovered',author:{id:'bot'},embeds:[{footer:{text:deliveryMarker(job)}}]});
    await s.runOnce(); assert.equal(d.list('g')[0].messageId,'recovered'); assert.equal(f.calls.sends.length,0);
  } finally { await f.close(); }
});
test('known messages are edited without create-only fields and obsolete jobs are cancelled', async () => {
  const f=communityFixture();
  try {
    const original=await f.channel.send({embeds:[]}); f.calls.sends.length=0;
    const s=service(f,{prepare:async()=>({messageId:original.id,payload:{content:'Updated',nonce:'123',enforceNonce:true,tts:true,embeds:[{title:'Changed'}]}})});
    f.db.community.deliveries.enqueue(jobInput(f)); await s.runOnce();
    assert.equal(f.calls.edits.length,1); assert.equal(f.calls.sends.length,0);
    for(const key of ['nonce','enforceNonce','tts']) assert.equal(key in f.calls.edits[0],false);
    s.registerDelivery('test',{prepare:async()=>null});
    f.db.community.deliveries.enqueue(jobInput(f,{key:'obsolete'})); await s.runOnce();
    assert.equal(f.db.community.deliveries.list('g').find(j=>j.key==='obsolete').status,'cancelled');
  } finally { await f.close(); }
});
test('post-send binding failure rolls back finish and requires review instead of reposting', async () => {
  const f=communityFixture();
  try {
    const s=service(f,{prepare:async()=>({payload:{embeds:[{title:'Saved'}]}}),delivered:()=>{f.db.community.settings.save('g',f.db.community.settings.get('g'),0);throw new Error('binding conflict');}});
    f.db.community.deliveries.enqueue(jobInput(f)); await s.runOnce();
    assert.equal(f.db.community.deliveries.list('g')[0].status,'needs_review');
    assert.equal(f.db.community.settings.get('g').revision,0);
    f.advance(300000); await s.runOnce(); assert.equal(f.calls.sends.length,1);
  } finally { await f.close(); }
});
test('cancelled work after a Discord lookup never posts and one broken task does not starve other work', async () => {
  const f=communityFixture();
  try {
    const s=service(f),d=f.db.community.deliveries;
    s.registerTask('bad',async()=>{throw new Error('upstream failed');});
    s.registerTask('good',async()=>{d.enqueue(jobInput(f));});
    f.client.channels.fetch=async()=>{d.cancelSubject('g','test','s');return f.channel;};
    await s.runOnce(); assert.equal(f.calls.sends.length,0); assert.equal(d.list('g')[0].status,'cancelled');
  } finally { await f.close(); }
});

test('a lookup that outlives its lease cannot publish before reconciliation',async()=>{
  const f=communityFixture();
  try {
    const s=service(f);f.db.community.deliveries.enqueue(jobInput(f));
    f.client.channels.fetch=async()=>{f.advance(300001);return f.channel;};
    await s.runOnce();assert.equal(f.calls.sends.length,0);
  } finally {await f.close();}
});

test('an unknown message during edit preparation pauses with no automatic replacement',async()=>{
  const f=communityFixture();
  try {
    const s=service(f,{prepare:async()=>({messageId:'gone',payload:{embeds:[{title:'Card'}]}})});
    f.channel.messages.fetch=async()=>{throw Object.assign(new Error('Unknown Message'),{code:10008});};
    f.db.community.deliveries.enqueue(jobInput(f));await s.runOnce();
    assert.equal(f.db.community.deliveries.list('g')[0].status,'paused');assert.equal(f.calls.sends.length,0);
  } finally {await f.close();}
});

test('replacement message bindings discovered during an awaited lookup never edit the old message',async()=>{
  const f=communityFixture();let reads=0;
  try {
    const original=await f.channel.send({embeds:[]});f.calls.sends.length=0;
    const s=service(f,{prepare:async()=>({messageId:++reads<3?original.id:'replacement',payload:{embeds:[{title:'Card'}]}})});
    f.db.community.deliveries.enqueue(jobInput(f));await s.runOnce();
    assert.equal(f.calls.edits.length,0);
  } finally {await f.close();}
});

test('starting registers one minute timer and immediate work, while stopping clears that timer',async(t)=>{
  const f=communityFixture();let callback,delay,scheduled=0,cleared=0,runs=0;
  const timer={unref(){return this;}};
  t.mock.method(globalThis,'setInterval',(fn,ms)=>{callback=fn;delay=ms;scheduled++;return timer;});
  t.mock.method(globalThis,'clearInterval',value=>{assert.equal(value,timer);cleared++;});
  try {
    const s=service(f);s.registerTask('count',async()=>{runs++;});
    s.start();s.start();await s.runOnce();
    assert.equal(scheduled,1);assert.equal(delay,60000);assert.equal(runs,1);
    callback();await s.runOnce();assert.equal(runs,2);
    await s.stop();assert.equal(cleared,1);await s.runOnce();assert.equal(runs,2);
  } finally {await f.close();}
});
