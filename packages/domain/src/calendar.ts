export type BusinessCalendar = { timezone: string; workingWeekdays: number[]; holidays: string[] };

// Count completed business dates at the original local wall-clock time, so DST
// changes never turn a business day into a fixed 24-hour interval.
export function elapsedBusinessDays(start: Date, end: Date, calendar: BusinessCalendar): number {
  if (end <= start) return 0;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: calendar.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const local = (date: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, '0')}` };
  };
  const from = local(start), to = local(end), holidays = new Set(calendar.holidays);
  const working = (date: Date) => calendar.workingWeekdays.includes(date.getUTCDay()) && !holidays.has(date.toISOString().slice(0, 10));
  let count = 0;
  for (const cursor = new Date(`${from.date}T00:00:00Z`); cursor.toISOString().slice(0, 10) < to.date;) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (working(cursor)) count++;
  }
  if (to.time < from.time && working(new Date(`${to.date}T00:00:00Z`))) count--;
  return Math.max(0, count);
}
