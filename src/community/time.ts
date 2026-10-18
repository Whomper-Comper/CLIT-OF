import { CommandError } from "../commandError.js";
import type { MemberAvailability } from "./availability.js";

const MINUTE = 60_000, DAY = 86_400_000, HALF_HOUR = 30 * MINUTE;
export interface Interval { start: number; end: number }
interface OffsetInterval extends Interval { offset: number }
const formatters = new Map<string, Intl.DateTimeFormat>();
const projections = new Map<string, OffsetInterval[]>();

function remember<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  if (cache.size >= limit) cache.delete(cache.keys().next().value!);
  cache.set(key,value); return value;
}
function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone); if (cached) return cached;
  if (typeof timezone !== "string" || !timezone || timezone.length > 100 || /^[+-]/.test(timezone)) throw new CommandError("Choose a valid IANA timezone, such as America/Bahia.");
  try {
    return remember(formatters,timezone,new Intl.DateTimeFormat("en-CA", { timeZone: timezone,
      year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23" }),64);
  } catch { throw new CommandError("Choose a valid IANA timezone, such as America/Bahia."); }
}
export function validateTimezone(timezone: string): void { formatter(timezone); }
function offsetAt(instant: number, timezone: string): number {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(instant).map(part => [part.type,part.value]));
  return Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second) - Math.floor(instant/1000)*1000;
}

/** Shared per-zone/date-range work: members never scan transitions themselves. */
function offsetIntervals(timezone: string, start: number, end: number): OffsetInterval[] {
  validateTimezone(timezone);
  const lower = Math.floor(start/DAY)*DAY, upper = Math.ceil(end/DAY)*DAY;
  const key = `${timezone}:${lower}:${upper}`, cached = projections.get(key); if (cached) return cached;
  const intervals: OffsetInterval[] = [];
  let from = lower, offset = offsetAt(lower,timezone);
  // IANA transitions are separated by more than one hour. Locate any change to the second.
  for (let probe = lower+3_600_000; probe <= upper; probe += 3_600_000) {
    const next = offsetAt(probe,timezone);
    if (next === offset) continue;
    let lo = probe-3_600_000, hi = probe;
    while (hi-lo > 1000) { const mid = Math.floor((lo+hi)/2000)*1000; if (offsetAt(mid,timezone)===offset) lo=mid; else hi=mid; }
    intervals.push({start:from,end:hi,offset}); from=hi; offset=next;
  }
  intervals.push({start:from,end:upper,offset});
  return remember(projections,key,intervals,128);
}
function parseLocal(local: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new CommandError("Enter a valid local date as YYYY-MM-DD HH:mm.");
  const [,y,m,d,h,min] = match, value = Date.UTC(+y,+m-1,+d,+h,+min);
  if (+y<1000 || new Date(value).toISOString().slice(0,16).replace("T"," ") !== local) throw new CommandError("Enter a valid local date as YYYY-MM-DD HH:mm.");
  return value;
}
export function possibleInstants(local: string, timezone: string): number[] {
  const wall = parseLocal(local);
  return [...new Set(offsetIntervals(timezone,wall-2*DAY,wall+2*DAY)
    .map(segment => ({segment,value:wall-segment.offset}))
    .filter(({segment,value})=>value>=segment.start && value<segment.end).map(({value})=>value))].sort((a,b)=>a-b);
}
export function resolveEventStart(local: string, timezone: string, offset?: string): number {
  const matches = possibleInstants(local,timezone);
  if (!matches.length) throw new CommandError("This local time falls in a timezone gap. Choose another time.");
  if (offset !== undefined) {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
    if (!match || +match[2]>23 || +match[3]>59) throw new CommandError("Choose a matching UTC offset in +/-HH:mm format.");
    const wanted = (match[1]==="-"?-1:1)*(+match[2]*60 + +match[3])*MINUTE;
    const found = matches.find(value=>offsetAt(value,timezone)===wanted);
    if (found===undefined) throw new CommandError("The UTC offset does not match that local time."); return found;
  }
  if (matches.length>1) throw new CommandError("This local time repeats. Supply a matching UTC offset (+/-HH:mm).");
  return matches[0];
}
function merge(intervals: Interval[]): Interval[] {
  const result: Interval[]=[];
  for (const interval of intervals.sort((a,b)=>a.start-b.start)) {
    const previous = result.at(-1);
    if (previous && interval.start<=previous.end) previous.end=Math.max(previous.end,interval.end);
    else result.push({...interval});
  }
  return result;
}
export function projectAvailability(member: MemberAvailability, start: number, end: number): Interval[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end<=start) throw new CommandError("Choose a valid availability projection range.");
  const result: Interval[]=[];
  for (const segment of offsetIntervals(member.timezone,start,end)) {
    const lower=Math.max(start,segment.start), upper=Math.min(end,segment.end);
    if (lower>=upper) continue;
    for (let day=Math.floor((lower+segment.offset)/DAY)*DAY-DAY; day<upper+segment.offset; day+=DAY) {
      const weekday=(new Date(day).getUTCDay()+6)%7;
      for (const window of member.windows) {
        if (window.weekday!==weekday) continue;
        const from=day+window.startMinute*MINUTE-segment.offset;
        const to=day+(window.endMinute+(window.endMinute<window.startMinute?1440:0))*MINUTE-segment.offset;
        const clipped={start:Math.max(lower,from),end:Math.min(upper,to)};
        if (clipped.start<clipped.end) result.push(clipped);
      }
    }
  }
  return merge(result);
}
export interface AvailabilitySuggestion extends Interval { memberIds: string[] }
export function suggestAvailability(members: MemberAvailability[], now: number, durationMinutes=120): AvailabilitySuggestion[] {
  if (!Number.isInteger(durationMinutes) || durationMinutes<30 || durationMinutes>240) throw new CommandError("Choose a suggestion duration between 30 and 240 minutes.");
  if (!Number.isFinite(now)) throw new CommandError("Choose a valid current time.");
  const end=now+14*DAY,duration=durationMinutes*MINUTE;
  const byMember=new Map<string,Interval[]>();
  for (const member of members) byMember.set(member.discordId,merge([...(byMember.get(member.discordId)??[]),...projectAvailability(member,now,end)]));
  const candidates: AvailabilitySuggestion[]=[];
  const pointers=new Map<string,number>();
  for (let start=Math.ceil(now/HALF_HOUR)*HALF_HOUR;start+duration<=end;start+=HALF_HOUR) {
    const memberIds:string[]=[];
    for (const [id,intervals] of byMember) {
      let index=pointers.get(id)??0;
      while (index<intervals.length && intervals[index].end<=start) index++;
      pointers.set(id,index);
      if (intervals[index] && intervals[index].start<=start && intervals[index].end>=start+duration) memberIds.push(id);
    }
    if (memberIds.length) candidates.push({start,end:start+duration,memberIds:memberIds.sort()});
  }
  candidates.sort((a,b)=>b.memberIds.length-a.memberIds.length || a.start-b.start);
  const result:AvailabilitySuggestion[]=[];
  for (const candidate of candidates) {
    if (result.some(other=>other.start<candidate.end && candidate.start<other.end && other.memberIds.join("\0")===candidate.memberIds.join("\0"))) continue;
    result.push(candidate); if (result.length===3) break;
  }
  return result;
}
