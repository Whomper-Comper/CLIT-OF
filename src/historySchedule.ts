export interface WeeklySchedule { weekly_day: number; weekly_hour: number; timezone: string }

interface Civil { year: number; month: number; day: number; hour: number; minute: number; second: number }
function civil(date: Date, timezone: string): Civil {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(date);
  const number = (key: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === key)?.value);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute"), second: number("second") };
}
function serial(value: Civil): number { return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second); }
function utcCivil(ms: number): Civil {
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth()+1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}
/** Resolve a local wall time without inheriting the process timezone, including DST offsets. */
export function zonedTimestamp(local: Civil, timezone: string): number {
  const target = serial(local);
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const difference = target - serial(civil(new Date(guess), timezone));
    if (!difference) return guess;
    guess += difference;
  }
  // A skipped DST wall hour resolves to the first valid hour after the gap.
  return Math.max(guess, guess + target - serial(civil(new Date(guess), timezone)));
}
export interface WeeklyPeriod { scheduledAt: string; start: string; end: string }
/** The latest scheduled recap always covers the preceding complete Monday–Monday local week. */
export function weeklyPeriod(schedule: WeeklySchedule, now = Date.now()): WeeklyPeriod {
  const local = civil(new Date(now), schedule.timezone);
  const today = Date.UTC(local.year, local.month - 1, local.day);
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * 86_400_000;
  let scheduleCivil = monday + ((schedule.weekly_day + 6) % 7) * 86_400_000 + schedule.weekly_hour * 3_600_000;
  let scheduled = zonedTimestamp(utcCivil(scheduleCivil), schedule.timezone);
  if (scheduled > now) { scheduleCivil -= 7 * 86_400_000; scheduled = zonedTimestamp(utcCivil(scheduleCivil), schedule.timezone); }
  const scheduleDate = new Date(scheduleCivil);
  const endCivil = Date.UTC(scheduleDate.getUTCFullYear(), scheduleDate.getUTCMonth(), scheduleDate.getUTCDate()) -
    ((scheduleDate.getUTCDay() + 6) % 7) * 86_400_000;
  return { scheduledAt: new Date(scheduled).toISOString(),
    start: new Date(zonedTimestamp(utcCivil(endCivil - 7 * 86_400_000), schedule.timezone)).toISOString(),
    end: new Date(zonedTimestamp(utcCivil(endCivil), schedule.timezone)).toISOString() };
}
