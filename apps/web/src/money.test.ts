import { expect, test } from "vitest";
import { majorCost, minorCost, money } from "./money";
test("catalog prices preserve the currency's minor units", () => {
  for (const [currency, major, minor] of [
    ["AUD", 12.34, 1234],
    ["JPY", 1234, 1234],
    ["KWD", 12.345, 12345],
  ] as const) {
    expect(minorCost(major, currency)).toBe(minor);
    expect(majorCost(minor, currency)).toBe(major);
  }
  expect(money(1234, "AUD")).toBe("A$12.34");
});
