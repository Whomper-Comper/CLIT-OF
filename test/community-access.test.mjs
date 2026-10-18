import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { communityFixture } from './helpers/community.mjs';
const { db }=await import('../dist/db.js');
const { requireCommunityOfficer,assertCommunityBinding }=await import('../dist/community/access.js');
const { requireClanAccess,requireDebugAccess }=await import('../dist/access.js');
const { handleCommunityInteraction }=await import('../dist/community/interactions.js');
after(()=>db.close());
let sequence=0;
function setup(){ const f=communityFixture(); f.guild.id=`guild-${++sequence}`; db.setManagerRole(f.guild.id,'manager'); db.setDebugRole(f.guild.id,'debug');
  db.setGuildClanConfig({guild_id:f.guild.id,clan_tag:'TEST',member_role_id:'member',officer_role_id:'officer',leader_role_id:'leader',join_role_id:null,log_channel_id:null,sync_interval_mins:10,last_sync_at:null}); return f; }
test('community officers include configured manager/officer/leader roles without relaxing clan or debug access',async()=>{
  const f=setup();
  try { f.addMember('u',['officer']); await requireCommunityOfficer(f.guild,'u');
    await assert.rejects(requireClanAccess(f.guild,'u'),/config role/); await assert.rejects(requireDebugAccess(f.guild,'u'),/debug role/);
    for(const roles of [['leader'],['manager']]) { f.setRoles('u',roles); await requireCommunityOfficer(f.guild,'u'); }
    f.setRoles('u',['member']); await assert.rejects(requireCommunityOfficer(f.guild,'u'),/officer|manager/i);
    assert.ok(f.calls.memberFetches.every(call=>call.force===true));
  } finally {await f.close();}
});
test('community officer checks reread role mappings after a deferred member lookup',async()=>{
  const f=setup(); let release;
  try { const member=f.addMember('u',['officer']); f.guild.members.fetch=async()=>{await new Promise(resolve=>{release=resolve;});return member;};
    const pending=requireCommunityOfficer(f.guild,'u');
    db.setGuildClanConfig({...db.getGuildConfigs(f.guild.id)[0],officer_role_id:'new-officer'});
    release(); await assert.rejects(pending,/officer|manager/i);
  } finally {release?.();await f.close();}
});
test('revoking a member role while the fresh lookup is deferred denies community access',async()=>{
  const f=setup();let release;
  try {
    const member=f.addMember('u',['officer']);
    f.guild.members.fetch=async()=>{await new Promise(resolve=>{release=resolve;});return member;};
    const pending=requireCommunityOfficer(f.guild,'u');f.setRoles('u',[]);release();
    await assert.rejects(pending,/officer|manager/i);
  } finally {release?.();await f.close();}
});
test('unauthorized or mismatched components cannot change persisted state',async()=>{
  const f=setup();
  try { f.addMember('u',[]); const binding={guildId:f.guild.id,channelId:'c',messageId:'m'};
    const before=f.db.community.settings.get(f.guild.id);
    for(const overrides of [{guildId:'other'},{channelId:'other'},{message:{id:'other'}},{guildId:null}]) {
      assert.throws(()=>assertCommunityBinding(binding,{...binding,message:{id:'m'},...overrides}),/reopen|server|message|channel/i);
    }
    assertCommunityBinding(binding,{guildId:f.guild.id,channelId:'c',message:{id:'m'}});
    await assert.rejects(requireCommunityOfficer(f.guild,'u'));
    assert.equal(await handleCommunityInteraction({isMessageComponent:()=>true,customId:'unknown:abc'}),false);
    assert.deepEqual(f.db.community.settings.get(f.guild.id),before); assert.deepEqual(f.db.community.deliveries.list(f.guild.id),[]);
  } finally {await f.close();}
});
