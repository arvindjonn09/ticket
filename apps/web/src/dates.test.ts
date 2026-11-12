import { expect, test } from "vitest";
import { configureDates, displayDate } from "./dates";
test("ticket dates use the organisation timezone", () => {
  configureDates({ locale: "en-AU", timezone: "Australia/Sydney" });
  expect(displayDate("2026-11-10T20:00:00Z", false)).toContain("11 Nov");
  configureDates({ locale: "en-US", timezone: "UTC" });
  expect(displayDate("2026-11-10T20:00:00Z", false)).toContain("Nov 10");
});
