import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { totp } from "../src/mfa.js";
import { tokenHash } from "../src/modules/auth/auth.service.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const password = "Operator-integration-password-2026!";
type Identity = { cookie: string; csrf: string; id: string };

describe.skipIf(!enabled)(
  "operator authentication and explicit support grants — real PostgreSQL",
  () => {
    let app: NestFastifyApplication, owner: PrismaClient, runtime: PrismaClient;
    const previous = new Map<string, string | undefined>();
    const operatorOrigin = "https://ops.astrama.test";
    const fixture = randomUUID(),
      slug = `ops-access-${fixture}`;
    const tenantOrigin = `https://${slug}.astrama.test`;
    const email = `operator-${fixture}@test.invalid`;
    let tenantId: string, adminId: string, departmentId: string, otherDepartmentId: string;
    let publicTicketId: string, otherTicketId: string, sensitiveTicketId: string;
    let operatorId: string, operator: Identity, admin: Identity;
    let secret: string;
    const invoke = (
      method: "GET" | "POST",
      path: string,
      identity?: Identity,
      payload?: unknown,
      host = "ops.astrama.test",
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url: `/api${path}`,
        remoteAddress: "127.0.0.1",
        headers: {
          host,
          origin: host === "ops.astrama.test" ? operatorOrigin : tenantOrigin,
          ...(identity ? { cookie: identity.cookie, "x-csrf-token": identity.csrf } : {}),
          ...headers,
        },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    async function login(account = email): Promise<Identity> {
      const response = await invoke("POST", "/operator/auth/login", undefined, {
        email: account,
        password,
      });
      expect(response.statusCode, response.body).toBe(201);
      const cookies = response.headers["set-cookie"];
      const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(";", 1)[0]!;
      expect(String(cookies)).toContain("HttpOnly");
      expect(String(cookies).toLowerCase()).not.toContain("domain=");
      return { cookie, csrf: response.json().csrfToken, id: response.json().operator.id };
    }
    beforeAll(async () => {
      for (const [key, value] of Object.entries({
        NODE_ENV: "test",
        PLATFORM_MODE: "hosted",
        APP_BASE_DOMAIN: "astrama.test",
        PUBLIC_SITE_ORIGIN: "https://astrama.test",
        OPERATOR_ORIGIN: operatorOrigin,
        OPERATOR_IP_ALLOWLIST: "127.0.0.1,::1",
        TRUST_PROXY: "0",
      })) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
      runtime = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
      const { createOperator } = await import("../dist/operator-cli.js");
      const created = await createOperator(owner, {
        name: "Fixture operator",
        email,
        password,
        role: "support",
      });
      operatorId = created.id;
      await expect(
        createOperator(runtime, {
          name: "Denied runtime creation",
          email: `denied-${email}`,
          password,
          role: "owner",
        }),
      ).rejects.toThrow("owner");
      const tenant = await owner.tenant.create({
        data: { slug, name: "Support access fixture", brandName: "Fixture" },
      });
      tenantId = tenant.id;
      const user = await owner.user.create({
        data: {
          tenantId,
          name: "Granting administrator",
          email: `${fixture}@tenant.invalid`,
          role: "admin",
          passwordHash: "not-a-login-hash",
          mfaEnrolled: true,
          mfaSecret: "fixture-only",
        },
      });
      adminId = user.id;
      const token = randomBytes(32).toString("hex"),
        csrf = randomBytes(32).toString("hex");
      await owner.session.create({
        data: {
          tenantId,
          userId: adminId,
          tokenHash: tokenHash(token),
          csrfToken: csrf,
          mfaVerified: true,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      admin = { cookie: `astrama_session=${token}`, csrf, id: adminId };
      departmentId = (
        await owner.department.create({ data: { tenantId, name: "Granted group", isTriage: true } })
      ).id;
      otherDepartmentId = (
        await owner.department.create({ data: { tenantId, name: "Other group" } })
      ).id;
      await owner.membership.create({ data: { tenantId, userId: adminId, departmentId } });
      for (const [index, group, sensitive] of [
        [1, departmentId, false],
        [2, otherDepartmentId, false],
        [3, otherDepartmentId, true],
      ] as const) {
        const category = await owner.category.create({
          data: { tenantId, departmentId: group, name: `Category ${index}`, sensitive },
        });
        const ticket = await owner.ticket.create({
          data: {
            tenantId,
            type: "incident",
            sequence: index,
            number: `INC${index}`,
            summary: `Ticket ${index}`,
            description: sensitive ? "SENSITIVE-OTHER-GROUP" : "Permitted description",
            priority: "P3",
            severity: "S3",
            categoryId: category.id,
            departmentId: group,
            callerId: adminId,
            submittedById: adminId,
            sensitive,
          },
        });
        await owner.activity.create({
          data: {
            tenantId,
            ticketId: ticket.id,
            authorId: adminId,
            audience: "internal",
            body: `INTERNAL-GROUP-${index}`,
          },
        });
        if (index === 1) publicTicketId = ticket.id;
        else if (index === 2) otherTicketId = ticket.id;
        else sensitiveTicketId = ticket.id;
      }
      const { createApp } = await import("../dist/main.js");
      app = await createApp();
      await app.getHttpAdapter().getInstance().ready();
    }, 30000);
    afterAll(async () => {
      await app?.close();
      if (owner && tenantId) {
        for (const table of [
          "operator_support_grants",
          "config_audits",
          "activities",
          "tickets",
          "sessions",
          "memberships",
          "categories",
          "departments",
          "users",
          "tenants",
        ]) {
          await owner.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}"=$1::uuid`,
            tenantId,
          );
        }
        await owner.operatorSession.deleteMany({ where: { operatorId } });
        await owner.operator.update({ where: { id: operatorId }, data: { active: false } });
      }
      await owner?.$disconnect();
      await runtime?.$disconnect();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    it("requires host-bound MFA, binds setup to its session, persists failures and denies replay", async () => {
      operator = await login();
      expect(
        (await invoke("GET", `/operator/organisations/${tenantId}/tickets`, operator)).statusCode,
      ).toBe(403);
      const setup = await invoke("POST", "/operator/auth/mfa/setup", operator);
      expect(setup.statusCode, setup.body).toBe(201);
      secret = setup.json().secret;
      const second = await login();
      const code = totp(secret, Math.floor(Date.now() / 30000));
      expect((await invoke("POST", "/operator/auth/mfa/verify", second, { code })).statusCode).toBe(
        401,
      );
      expect(
        (await invoke("POST", "/operator/auth/mfa/verify", operator, { code: "invalid" }))
          .statusCode,
      ).toBe(401);
      expect(
        (await owner.operator.findUniqueOrThrow({ where: { id: operatorId } })).mfaFailures,
      ).toBe(1);
      const verified = await invoke("POST", "/operator/auth/mfa/verify", operator, { code });
      expect(verified.statusCode, verified.body).toBe(201);
      expect(verified.json()).toMatchObject({ mfaVerified: true, mfaEnrolled: true });
      expect(String(verified.headers["set-cookie"])).toContain("Max-Age=43200");
      expect((await invoke("POST", "/operator/auth/mfa/verify", second, { code })).statusCode).toBe(
        401,
      );
      const enrolled = await invoke("POST", "/operator/auth/mfa/verify", second, {
        code: totp(secret, Math.floor(Date.now() / 30000) + 1),
      });
      expect(enrolled.statusCode, enrolled.body).toBe(201);
      expect(enrolled.json()).toMatchObject({ mfaVerified: true, mfaEnrolled: true });
      expect(String(enrolled.headers["set-cookie"])).toContain("Max-Age=43200");
      expect((await invoke("GET", "/operator/auth/session", second)).json().mfaVerified).toBe(true);
      expect(
        (await invoke("GET", "/operator/auth/session", operator, undefined, `${slug}.astrama.test`))
          .statusCode,
      ).toBe(403);
      expect(
        (await invoke("GET", "/auth/session", operator, undefined, `${slug}.astrama.test`))
          .statusCode,
      ).toBe(401);
      expect((await invoke("GET", "/operator/auth/session", admin)).statusCode).toBe(401);
      expect(
        (
          await invoke("POST", "/operator/auth/logout", operator, {}, "ops.astrama.test", {
            "x-csrf-token": "wrong",
          })
        ).statusCode,
      ).toBe(403);
    });
    it("requires an explicit live grant, filters sensitive/internal content and logs every support view", async () => {
      const path = `/operator/organisations/${tenantId}/tickets`;
      expect((await invoke("GET", path, operator)).statusCode).toBe(403);
      const granted = await invoke(
        "POST",
        "/admin/operator-access",
        admin,
        {
          operatorEmail: email,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          reason: "Investigate customer-approved support issue",
        },
        `${slug}.astrama.test`,
      );
      expect(granted.statusCode, granted.body).toBe(201);
      const renewal = {
        operatorEmail: email,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        reason: "Renew explicit support permission",
        revision: 0,
      };
      const renewed = await Promise.all([
        invoke("POST", "/admin/operator-access", admin, renewal, `${slug}.astrama.test`),
        invoke("POST", "/admin/operator-access", admin, renewal, `${slug}.astrama.test`),
      ]);
      expect(renewed.map((result) => result.statusCode).sort()).toEqual([201, 409]);
      const list = await invoke("GET", path, operator);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().tickets.map((ticket: { id: string }) => ticket.id)).toEqual(
        expect.arrayContaining([publicTicketId, otherTicketId]),
      );
      expect(list.body).not.toContain(sensitiveTicketId);
      const detail = await invoke("GET", `${path}/${publicTicketId}`, operator);
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.body).toContain("INTERNAL-GROUP-1");
      const other = await invoke("GET", `${path}/${otherTicketId}`, operator);
      expect(other.statusCode, other.body).toBe(200);
      expect(other.body).not.toContain("INTERNAL-GROUP-2");
      expect((await invoke("GET", `${path}/${sensitiveTicketId}`, operator)).statusCode).toBe(404);
      expect(
        (await invoke("POST", `${path}/${publicTicketId}/messages`, operator, { body: "denied" }))
          .statusCode,
      ).toBe(403);
      const views = await invoke(
        "GET",
        "/admin/operator-access",
        admin,
        undefined,
        `${slug}.astrama.test`,
      );
      expect(views.statusCode, views.body).toBe(200);
      expect(views.json().views).toHaveLength(3);
      await owner.operatorAudit.createMany({
        data: Array.from({ length: 101 }, () => ({
          operatorId,
          tenantId,
          tenantSlug: slug,
          action: "support.tickets.viewed",
          reason: "History paging fixture",
        })),
      });
      const firstPage = await invoke(
        "GET",
        "/admin/operator-access",
        admin,
        undefined,
        `${slug}.astrama.test`,
      );
      expect(firstPage.json().views).toHaveLength(100);
      const older = await invoke(
        "GET",
        `/admin/operator-access?viewCursor=${firstPage.json().nextViewCursor}`,
        admin,
        undefined,
        `${slug}.astrama.test`,
      );
      expect(older.json().views).toHaveLength(4);
      const foreign = await owner.operatorAudit.create({
        data: {
          operatorId,
          tenantId: randomUUID(),
          action: "support.ticket.viewed",
          reason: "Foreign history fixture",
        },
      });
      expect(
        (
          await invoke(
            "GET",
            `/admin/operator-access?viewCursor=${foreign.id}`,
            admin,
            undefined,
            `${slug}.astrama.test`,
          )
        ).statusCode,
      ).toBe(404);
      await owner.tenant.update({
        where: { id: tenantId },
        data: {
          status: "read_only",
          readOnlyReason: "operator",
          readOnlySince: new Date(),
          deleteAfter: new Date(Date.now() + 86400000),
        },
      });
      const revoked = await invoke(
        "POST",
        "/admin/operator-access/revoke",
        admin,
        {
          grantId: granted.json().id,
          reason: "Support investigation is complete",
          revision: 1,
        },
        `${slug}.astrama.test`,
      );
      expect(revoked.statusCode, revoked.body).toBe(201);
      expect((await invoke("GET", path, operator)).statusCode).toBe(403);
      await owner.operatorSupportGrant.update({
        where: { id: granted.json().id },
        data: {
          revokedAt: null,
          createdAt: new Date(Date.now() - 7200000),
          expiresAt: new Date(Date.now() - 3600000),
        },
      });
      expect((await invoke("GET", path, operator)).statusCode).toBe(403);
    });
    it("returns tenant request limits without blocking security routes or accepting cross-origin reads", async () => {
      process.env.TENANT_REQUESTS_PER_MINUTE = "1";
      try {
        const foreign = await invoke("GET", "/tickets", admin, undefined, `${slug}.astrama.test`, {
          origin: "https://another.astrama.test",
        });
        expect(foreign.statusCode).toBe(403);
        expect(
          (await invoke("GET", "/tickets", admin, undefined, `${slug}.astrama.test`)).statusCode,
        ).toBe(200);
        const limited = await invoke("GET", "/tickets", admin, undefined, `${slug}.astrama.test`);
        expect(limited.statusCode, limited.body).toBe(429);
        expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
        expect(
          (await invoke("GET", "/auth/session", admin, undefined, `${slug}.astrama.test`))
            .statusCode,
        ).toBe(200);
      } finally {
        delete process.env.TENANT_REQUESTS_PER_MINUTE;
        await owner.$executeRaw`DELETE FROM tenant_budgets WHERE tenant_id=${tenantId}::uuid`;
      }
    });
    it("expires idle sessions and fails closed for invalid or forged IP allowlists", async () => {
      const { operatorIpAllowed } = await import("../dist/operator-auth.js");
      expect(operatorIpAllowed("::1", { OPERATOR_IP_ALLOWLIST: "::1" })).toBe(true);
      expect(operatorIpAllowed("::ffff:127.0.0.1", { OPERATOR_IP_ALLOWLIST: "127.0.0.0/8" })).toBe(
        true,
      );
      expect(operatorIpAllowed("127.0.0.1", { OPERATOR_IP_ALLOWLIST: "broken/8" })).toBe(false);
      process.env.OPERATOR_IP_ALLOWLIST = "192.0.2.1";
      expect(
        (
          await invoke("GET", "/operator/auth/session", operator, undefined, "ops.astrama.test", {
            "x-forwarded-for": "192.0.2.1",
          })
        ).statusCode,
      ).toBe(403);
      process.env.OPERATOR_IP_ALLOWLIST = "127.0.0.1,::1";
      await owner.operatorSession.updateMany({
        where: { operatorId },
        data: { lastSeenAt: new Date(Date.now() - 16 * 60000) },
      });
      expect((await invoke("GET", "/operator/auth/session", operator)).statusCode).toBe(401);
      await owner.operator.update({ where: { id: operatorId }, data: { active: false } });
      expect(
        (await invoke("POST", "/operator/auth/login", undefined, { email, password })).statusCode,
      ).toBe(401);
    });
  },
);
