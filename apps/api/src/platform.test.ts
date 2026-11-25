import { expect, it } from "vitest";
import {
  classifyHost,
  expectedRequestOrigin,
  platformConfigError,
  tenantOrigin,
  validTenantSlug,
} from "./platform.js";

const hosted = {
  PLATFORM_MODE: "hosted",
  NODE_ENV: "test",
  APP_BASE_DOMAIN: "astrama.test",
  PUBLIC_SITE_ORIGIN: "https://astrama.test",
  OPERATOR_ORIGIN: "https://ops.astrama.test",
} as NodeJS.ProcessEnv;

it("resolves only a single valid, non-reserved customer label under the configured base domain", () => {
  expect(classifyHost("Harbour.astrama.test:443", hosted)).toEqual({
    kind: "tenant",
    slug: "harbour",
  });
  for (const host of [
    "www.astrama.test",
    "api.astrama.test",
    "two.labels.astrama.test",
    "other.example.test",
    "-invalid.astrama.test",
    "harbour.astrama.test.evil.test",
    "harbour.astrama.test,evil.test",
  ])
    expect(classifyHost(host, hosted)).toEqual({ kind: "unknown" });
});

it("recognizes only configured public and operator hosts", () => {
  expect(classifyHost("astrama.test", hosted)).toEqual({ kind: "public" });
  expect(classifyHost("ops.astrama.test", hosted)).toEqual({ kind: "operator" });
  const status = { ...hosted, STATUS_PAGE_ORIGIN: "https://health.astrama.test" };
  expect(validTenantSlug("health", status)).toBe(false);
  expect(classifyHost("health.astrama.test", status)).toEqual({ kind: "unknown" });
  expect(platformConfigError({ ...hosted, STATUS_PAGE_ORIGIN: hosted.OPERATOR_ORIGIN })).toContain(
    "distinct",
  );
  expect(classifyHost("fake-ops.astrama.test", hosted)).toEqual({
    kind: "tenant",
    slug: "fake-ops",
  });
  expect(
    validTenantSlug("control", { ...hosted, OPERATOR_ORIGIN: "https://control.astrama.test" }),
  ).toBe(false);
  expect(platformConfigError({ ...hosted, OPERATOR_ORIGIN: hosted.PUBLIC_SITE_ORIGIN })).toContain(
    "different hostnames",
  );
});

it("keeps the single-company origin and derives hosted links without choosing a production domain", () => {
  const single = {
    PLATFORM_MODE: "single",
    APP_ORIGIN: "http://localhost:4310",
  } as NodeJS.ProcessEnv;
  expect(platformConfigError(single)).toBeNull();
  expect(expectedRequestOrigin("anything", single)).toBe("http://localhost:4310");
  expect(tenantOrigin("harbour", single)).toBe("http://localhost:4310");
  expect(platformConfigError(hosted)).toBeNull();
  expect(expectedRequestOrigin("harbour.astrama.test", hosted)).toBe(
    "https://harbour.astrama.test",
  );
  expect(tenantOrigin("harbour", hosted)).toBe("https://harbour.astrama.test");
  expect(
    tenantOrigin("harbour", { ...hosted, PUBLIC_SITE_ORIGIN: "https://astrama.test:8443" }),
  ).toBe("https://harbour.astrama.test:8443");
});

it("rejects missing hosted origins and never derives tenant origins from an untrusted host", () => {
  expect(platformConfigError({ ...hosted, PUBLIC_SITE_ORIGIN: "" })).toBe(
    "PUBLIC_SITE_ORIGIN and OPERATOR_ORIGIN must be exact origins",
  );
  expect(expectedRequestOrigin("harbour.astrama.test.evil.test", hosted)).toBeNull();
  expect(validTenantSlug("customer", { ...hosted, RESERVED_SLUGS: "customer, reserved" })).toBe(
    false,
  );
});
