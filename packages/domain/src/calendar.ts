import { DateTime } from "luxon";

export type BusinessCalendar = { timezone: string; workingWeekdays: number[]; holidays: string[] };
export type HourCalendar = BusinessCalendar & { workdayStart?: string; workdayEnd?: string };

function inZone(date: Date, timezone: string) {
  const value = DateTime.fromJSDate(date, { zone: timezone });
  if (!value.isValid) throw new RangeError(value.invalidExplanation ?? "Invalid calendar timezone");
  return value;
}

function localTime(day: DateTime, minute: number) {
  return DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour: Math.floor(minute / 60),
      minute: minute % 60,
    },
    { zone: day.zone },
  );
}

function isWorkingDate(day: DateTime, calendar: BusinessCalendar): boolean {
  return (
    calendar.workingWeekdays.includes(day.weekday % 7) &&
    !calendar.holidays.includes(day.toISODate() ?? "")
  );
}

function workMinutes(calendar: HourCalendar) {
  const parse = (value: string | undefined, fallback: number) => {
    if (!value) return fallback;
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
      throw new Error("Invalid business-hours boundary");
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = parse(calendar.workdayStart, 9 * 60);
  const end = parse(calendar.workdayEnd, 17 * 60);
  if (end <= start) throw new Error("Business-hours end must follow its start");
  return { start, end };
}

/** Count elapsed minutes inside configured local business hours. */
export function elapsedBusinessMinutes(start: Date, end: Date, calendar: HourCalendar): number {
  if (end <= start) return 0;
  const { start: openAt, end: closeAt } = workMinutes(calendar);
  const from = inZone(start, calendar.timezone);
  const until = inZone(end, calendar.timezone);
  let total = 0;
  for (let day = from.startOf("day"); day <= until.startOf("day"); day = day.plus({ days: 1 })) {
    if (!isWorkingDate(day, calendar)) continue;
    const opens = localTime(day, openAt).toMillis();
    const closes = localTime(day, closeAt).toMillis();
    total += Math.max(0, Math.min(end.getTime(), closes) - Math.max(start.getTime(), opens));
  }
  return total / 60000;
}

/** Add target minutes using either wall-clock time or the tenant's business calendar. */
export function addTargetMinutes(
  start: Date,
  minutes: number,
  calendar: HourCalendar,
  mode: "business" | "24x7",
): Date {
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error("Invalid SLA duration");
  if (mode === "24x7") return new Date(start.getTime() + minutes * 60000);
  const { start: openAt, end: closeAt } = workMinutes(calendar);
  let cursor: DateTime = inZone(start, calendar.timezone);
  let remaining = minutes;
  for (let attempts = 0; attempts < 36600; attempts++) {
    const day = cursor.startOf("day");
    if (isWorkingDate(day, calendar)) {
      const opens = localTime(day, openAt).toMillis();
      const closes = localTime(day, closeAt).toMillis();
      const availableFrom = Math.max(cursor.toMillis(), opens);
      const available = Math.max(0, closes - availableFrom) / 60000;
      if (remaining <= available) return new Date(availableFrom + remaining * 60000);
      remaining -= available;
    }
    cursor = localTime(day.plus({ days: 1 }), openAt);
  }
  throw new Error("SLA deadline exceeds supported range");
}

/** Count working local dates crossed at the original local wall-clock time. */
export function elapsedBusinessDays(start: Date, end: Date, calendar: BusinessCalendar): number {
  if (end <= start) return 0;
  const from = inZone(start, calendar.timezone);
  const to = inZone(end, calendar.timezone);
  const startTime = from.toFormat("HH:mm:ss.SSS");
  const endTime = to.toFormat("HH:mm:ss.SSS");
  let count = 0;
  for (
    let day = from.startOf("day").plus({ days: 1 });
    day <= to.startOf("day");
    day = day.plus({ days: 1 })
  ) {
    if (day.hasSame(to, "day") && endTime < startTime) continue;
    if (isWorkingDate(day, calendar)) count++;
  }
  return count;
}
