let preferences: { locale?: string; timezone?: string } = {};
export function configureDates(value: { locale?: string; timezone?: string }) {
  preferences = value;
}
export function displayDate(value: string, full = true) {
  return new Intl.DateTimeFormat(preferences.locale || "en", {
    timeZone: preferences.timezone || "UTC",
    ...(full
      ? ({ dateStyle: "medium", timeStyle: "short" } as const)
      : ({ month: "short", day: "numeric" } as const)),
  }).format(new Date(value));
}
