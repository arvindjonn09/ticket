import { describe, expect, it } from "vitest";
import { elapsedBusinessDays } from "./calendar.js";

describe("tenant business calendar", () => {
  const calendar = {
    timezone: "Australia/Sydney",
    workingWeekdays: [1, 2, 3, 4, 5],
    holidays: ["2026-10-05"],
  };
  it("counts local working dates across a DST weekend and a holiday at the original local time", () => {
    const start = new Date("2026-10-02T00:00:00Z"); // Friday 10am AEST
    expect(elapsedBusinessDays(start, new Date("2026-10-05T23:00:00Z"), calendar)).toBe(1); // Tuesday 10am AEDT
    expect(elapsedBusinessDays(start, new Date("2026-10-05T22:59:59Z"), calendar)).toBe(0);
    expect(elapsedBusinessDays(start, new Date("2026-10-07T23:00:00Z"), calendar)).toBe(3);
    expect(elapsedBusinessDays(start, start, calendar)).toBe(0);
  });
  it("supports a nonstandard weekend and the reverse DST transition", () => {
    const start = new Date("2026-04-02T23:00:00Z"); // Friday 10am AEDT
    expect(
      elapsedBusinessDays(start, new Date("2026-04-06T00:00:00Z"), { ...calendar, holidays: [] }),
    ).toBe(1);
    expect(
      elapsedBusinessDays(start, new Date("2026-04-06T00:00:00Z"), {
        ...calendar,
        workingWeekdays: [0, 6],
        holidays: [],
      }),
    ).toBe(2);
  });
});
