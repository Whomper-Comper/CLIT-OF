import type { DatabaseSync } from "node:sqlite";
import { CommandError } from "../commandError.js";
import { validateTimezone } from "./time.js";
import { withCommunityTransaction } from "./transactions.js";

export interface LocalWindow { id: string; weekday: number; startMinute: number; endMinute: number }
export interface MemberAvailability {
  guildId: string; discordId: string; timezone: string; windows: LocalWindow[]; revision: number; updatedAt: number;
}
function validate(input: Omit<MemberAvailability,"revision"|"updatedAt">): void {
  validateTimezone(input.timezone);
  if (!input.guildId || !input.discordId || !Array.isArray(input.windows) || input.windows.length>14) throw new CommandError("Save at most 14 weekly windows.");
  const ids=new Set<string>();
  for (const window of input.windows) {
    const duration=(window.endMinute-window.startMinute+1440)%1440;
    if (typeof window.id!=="string" || !/^[\w-]{1,64}$/.test(window.id) || ids.has(window.id) ||
      !Number.isInteger(window.weekday) || window.weekday<0 || window.weekday>6 ||
      !Number.isInteger(window.startMinute) || window.startMinute<0 || window.startMinute>=1440 ||
      !Number.isInteger(window.endMinute) || window.endMinute<0 || window.endMinute>=1440 || duration<30 || duration>720) {
      throw new CommandError("Each window needs a unique ID, weekday, and local times lasting 30–720 minutes; zero-length windows are invalid.");
    }
    ids.add(window.id);
  }
}
function decode(row: Record<string, unknown>): MemberAvailability {
  return {guildId:String(row.guild_id),discordId:String(row.discord_id),timezone:String(row.timezone),
    windows:JSON.parse(String(row.windows)),revision:Number(row.revision),updatedAt:Number(row.updated_at)};
}
export class AvailabilityStore {
  constructor(private readonly sql: DatabaseSync) {}
  get(guildId:string,discordId:string): MemberAvailability|null {
    const row=this.sql.prepare("SELECT * FROM community_availability WHERE guild_id=? AND discord_id=? AND windows IS NOT NULL").get(guildId,discordId);
    return row?decode(row):null;
  }
  list(guildId:string):MemberAvailability[] {
    return this.sql.prepare("SELECT * FROM community_availability WHERE guild_id=? AND windows IS NOT NULL ORDER BY discord_id").all(guildId).map(decode);
  }
  save(input:Omit<MemberAvailability,"revision"|"updatedAt">,expectedRevision:number,now:number):MemberAvailability {
    validate(input);
    if (!Number.isSafeInteger(now)) throw new CommandError("Choose a valid availability update time.");
    return withCommunityTransaction(this.sql,()=>{
      const current=this.get(input.guildId,input.discordId);
      if ((current?.revision??0)!==expectedRevision) throw new CommandError("Availability changed in another session. Reopen the menu.");
      if (current && current.timezone===input.timezone && JSON.stringify(current.windows)===JSON.stringify(input.windows)) return current;
      this.sql.prepare(`INSERT INTO community_availability(guild_id,discord_id,timezone,windows,revision,updated_at)
        VALUES(?,?,?,?,1,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET timezone=excluded.timezone,windows=excluded.windows,
        revision=community_availability.revision+1,updated_at=excluded.updated_at`)
        .run(input.guildId,input.discordId,input.timezone,JSON.stringify(input.windows),now);
      const saved=this.get(input.guildId,input.discordId)!;
      if (saved.windows.length) {
        this.sql.prepare(`INSERT INTO community_availability_changes(guild_id,discord_id,changed_at,revision) VALUES(?,?,?,?)
          ON CONFLICT(guild_id,discord_id) DO UPDATE SET changed_at=excluded.changed_at,revision=excluded.revision`)
          .run(input.guildId,input.discordId,now,saved.revision);
      } else this.sql.prepare("DELETE FROM community_availability_changes WHERE guild_id=? AND discord_id=?").run(input.guildId,input.discordId);
      return saved;
    });
  }
  clear(guildId:string,discordId:string):void {
    // Keep a revision tombstone to prevent an old editor becoming valid after clear/recreate.
    withCommunityTransaction(this.sql,()=>{
      this.sql.prepare("UPDATE community_availability SET windows=NULL,timezone='',updated_at=0,revision=revision+1 WHERE guild_id=? AND discord_id=? AND windows IS NOT NULL").run(guildId,discordId);
      this.sql.prepare("DELETE FROM community_availability_changes WHERE guild_id=? AND discord_id=?").run(guildId,discordId);
    });
  }
}
