import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hash, argon2id } from "argon2";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const password = "Hosted-test-password-2026!";

describe.skipIf(!enabled)("hosted tenant routing", () => {
  let owner: PrismaClient;
  let app: NestFastifyApplication;
  const previous = new Map<string, string | undefined>();
  const tenants: { id: string; slug: string }[] = [];
  let inactiveSlug = "";
  const env = {
    NODE_ENV: "test",
    PLATFORM_MODE: "hosted",
    APP_BASE_DOMAIN: "astrama.test",
    PUBLIC_SITE_ORIGIN: "https://astrama.test",
    OPERATOR_ORIGIN: "https://ops.astrama.test",
  };
  const setEnv = () => {
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
  };

  beforeAll(async () => {
    setEnv();
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const passwordHash = await hash(password, { type: argon2id });
    for (let i = 0; i < 2; i++) {
      const slug = `host-${randomUUID()}`;
      const tenant = await owner.tenant.create({ data: { slug, name: slug, brandName: slug } });
      await owner.user.create({
        data: {
          tenantId: tenant.id,
          name: "Hosted test",
          email: `host-${i}@test.invalid`,
          role: "employee",
          passwordHash,
        },
      });
      tenants.push({ id: tenant.id, slug });
    }
    inactiveSlug = `inactive-${randomUUID()}`;
    await owner.tenant.create({
      data: { slug: inactiveSlug, name: inactiveSlug, brandName: inactiveSlug, active: false },
    });
    const { createApp } = await import("../dist/main.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
  }, 120000);

  afterAll(async () => {
    await app?.close();
    if (owner) {
      for (const tenant of tenants) {
        await owner.session.deleteMany({ where: { tenantId: tenant.id } });
        await owner.user.deleteMany({ where: { tenantId: tenant.id } });
        await owner.tenant.delete({ where: { id: tenant.id } });
      }
      if (inactiveSlug) await owner.tenant.deleteMany({ where: { slug: inactiveSlug } });
      await owner.$disconnect();
    }
    for (const [key, value] of previous)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }, 120000);

  it("binds login, session, neutral unknown-host behavior, and TLS permission to the host", async () => {
    const first = tenants[0]!;
    const second = tenants[1]!;
    const firstHost = `${first.slug}.astrama.test`;
    const secondHost = `${second.slug}.astrama.test`;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: firstHost, origin: `https://${firstHost}` },
      payload: { organisation: first.slug, email: "host-0@test.invalid", password },
    });
    expect(login.statusCode, login.body).toBe(201);
    const cookieHeader = login.headers["set-cookie"];
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)!.split(";")[0]!;
    expect(cookieHeader?.toString().toLowerCase()).not.toContain("domain=");

    const mismatched = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: firstHost, origin: `https://${firstHost}` },
      payload: { organisation: second.slug, email: "host-0@test.invalid", password },
    });
    expect(mismatched.statusCode).toBe(401);

    const crossed = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { host: secondHost, origin: `https://${secondHost}`, cookie },
    });
    expect(crossed.statusCode).toBe(401);

    const unknown = await app.inject({
      method: "GET",
      url: "/api/platform/host",
      headers: { host: "missing.astrama.test" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).toContain("Organisation not found");
    const inactive = await app.inject({
      method: "GET",
      url: "/api/platform/host",
      headers: { host: `${inactiveSlug}.astrama.test` },
    });
    expect(inactive.statusCode).toBe(unknown.statusCode);
    expect(inactive.body).toBe(unknown.body);

    for (const domain of [firstHost, "astrama.test", "ops.astrama.test"])
      expect(
        (await app.inject({ url: `/api/internal/tls-allowed?domain=${domain}` })).statusCode,
      ).toBe(200);
    expect(
      (await app.inject({ url: "/api/internal/tls-allowed?domain=missing.astrama.test" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/api/internal/tls-allowed?domain=${inactiveSlug}.astrama.test` }))
        .statusCode,
    ).toBe(404);
  }, 120000);
});
