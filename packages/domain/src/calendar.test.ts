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

import { addTargetMinutes, elapsedBusinessMinutes } from "./calendar.js";

describe("business-hour SLA calendar", () => {
  const calendar = {
    timezone: "Australia/Sydney",
    workingWeekdays: [1, 2, 3, 4, 5],
    holidays: ["2026-11-13"],
    workdayStart: "09:00",
    workdayEnd: "17:00",
  };

  it("counts only open business time across a weekend and holiday", () => {
    expect(
      elapsedBusinessMinutes(
        new Date("2026-11-12T00:00:00.000Z"), // Thursday 11:00 local
        new Date("2026-11-16T02:00:00.000Z"), // Monday 13:00 local
        calendar,
      ),
    ).toBe(10 * 60);
  });

  it("adds business minutes using the tenant timezone across DST", () => {
    const due = addTargetMinutes(
      new Date("2026-10-02T22:00:00.000Z"), // Saturday 08:00 local before DST
      9 * 60,
      calendar,
      "business",
    );
    expect(due.toISOString()).toBe("2026-10-05T23:00:00.000Z");
  });

  it("uses continuous elapsed time for 24x7 targets", () => {
    expect(
      addTargetMinutes(new Date("2026-11-14T00:00:00.000Z"), 60, calendar, "24x7").toISOString(),
    ).toBe("2026-11-14T01:00:00.000Z");
  });
});
