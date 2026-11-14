import { describe, expect, it } from "vitest";
import { productionHostChecks } from "../src/operations.js";

describe("host monitoring thresholds", () => {
  it("alerts when disk reaches 80 percent or the certificate has under 14 days", () => {
    expect(productionHostChecks("80", "13")).toEqual({ disk: false, certificate: false });
    expect(productionHostChecks("79.9", "14")).toEqual({ disk: true, certificate: true });
  });

  it("fails closed when host measurements are absent or invalid", () => {
    expect(productionHostChecks("", "expired")).toEqual({ disk: false, certificate: false });
  });
});
