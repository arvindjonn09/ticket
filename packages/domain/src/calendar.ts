export type BusinessCalendar = { timezone: string; workingWeekdays: number[]; holidays: string[] };
export type HourCalendar = BusinessCalendar & { workdayStart?: string; workdayEnd?: string };

const localFormatter = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

function localParts(date: Date, timezone: string) {
  const parts = Object.fromEntries(
    localFormatter(timezone)
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function wallClockInstant(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timezone: string,
): Date {
  const target = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const q = localParts(new Date(instant), timezone);
    const represented = Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute);
    instant += target - represented;
  }
  return new Date(instant);
}

function dayCursor(date: Date, timezone: string): Date {
  const p = localParts(date, timezone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
}

function dayInstant(day: Date, minute: number, timezone: string) {
  return wallClockInstant(
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    minute,
    timezone,
  );
}

function isWorkingDate(day: Date, calendar: HourCalendar): boolean {
  return (
    calendar.workingWeekdays.includes(day.getUTCDay()) &&
    !calendar.holidays.includes(day.toISOString().slice(0, 10))
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
  let total = 0;
  const day = dayCursor(start, calendar.timezone);
  const last = dayCursor(end, calendar.timezone);
  for (; day <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!isWorkingDate(day, calendar)) continue;
    const opens = dayInstant(day, openAt, calendar.timezone);
    const closes = dayInstant(day, closeAt, calendar.timezone);
    total += Math.max(
      0,
      Math.min(end.getTime(), closes.getTime()) - Math.max(start.getTime(), opens.getTime()),
    );
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
  let cursor = new Date(start),
    remaining = minutes;
  for (let attempts = 0; attempts < 36600; attempts++) {
    const day = dayCursor(cursor, calendar.timezone);
    if (isWorkingDate(day, calendar)) {
      const opens = dayInstant(day, openAt, calendar.timezone);
      const closes = dayInstant(day, closeAt, calendar.timezone);
      const availableFrom = Math.max(cursor.getTime(), opens.getTime());
      const available = Math.max(0, closes.getTime() - availableFrom) / 60000;
      if (remaining <= available) return new Date(availableFrom + remaining * 60000);
      remaining -= available;
    }
    const next = new Date(day.getTime());
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = dayInstant(next, openAt, calendar.timezone);
  }
  throw new Error("SLA deadline exceeds supported range");
}

// Count completed business dates at the original local wall-clock time, so DST
// changes never turn a business day into a fixed 24-hour interval.
export function elapsedBusinessDays(start: Date, end: Date, calendar: BusinessCalendar): number {
  if (end <= start) return 0;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: calendar.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const local = (date: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`,
    };
  };
  const from = local(start),
    to = local(end),
    holidays = new Set(calendar.holidays);
  const working = (date: Date) =>
    calendar.workingWeekdays.includes(date.getUTCDay()) &&
    !holidays.has(date.toISOString().slice(0, 10));
  let count = 0;
  for (
    const cursor = new Date(`${from.date}T00:00:00Z`);
    cursor.toISOString().slice(0, 10) < to.date;
  ) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (working(cursor)) count++;
  }
  if (to.time < from.time && working(new Date(`${to.date}T00:00:00Z`))) count--;
  return Math.max(0, count);
}
