import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { OutgoingMailView, OutgoingMailSummary } from "@astrama/contracts";
import { Database } from "../src/database.js";
import { decryptSecret, encryptSecret } from "../src/mfa.js";
import { tokenHash } from "../src/modules/auth/auth.service.js";
import { createPlatformTransport, sendTenantMail } from "../src/platform-mail.js";
import { closeTenantSmtp } from "../src/tenant-smtp.js";
import { exportTables } from "../src/operator-data.js";

const mail = vi.hoisted(() => ({
  sent: [] as { host: string; options: Record<string, unknown> }[],
  failOwn: false,
  failPlatform: false,
  revoked: false,
  refreshes: 0,
  generation: 0,
  delayOwn: 0,
  verifiers: [] as string[],
}));
vi.mock("nodemailer", () => ({
  createTransport: (options: { host: string }) => ({
    options,
    close: vi.fn(),
    sendMail: vi.fn(async (message: Record<string, unknown>) => {
      const own = options.host !== "platform.example.test";
      if (own) {
        const { resolveSmtpTarget } = await import("../src/tenant-smtp.js");
        await resolveSmtpTarget(options.host);
        if (mail.delayOwn) {
          await new Promise((resolve) => setTimeout(resolve, mail.delayOwn));
          const { currentMailDeadline } = await import("../src/mail-deadline.js");
          currentMailDeadline()?.check();
        }
      }
      if ((own && mail.failOwn) || (!own && mail.failPlatform))
        throw Object.assign(new Error("535 secret credential provider reply"), {
          code: own ? "EAUTH" : "ECONNECTION",
        });
      mail.sent.push({ host: options.host, options: message });
      return { accepted: [message.to], messageId: message.messageId };
    }),
  }),
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [
    {
      address:
        host.endsWith("example.test") || host === "smtp.office365.com" ? "8.8.8.8" : "172.18.0.2",
      family: 4,
    },
  ]),
  resolveMx: vi.fn(async () => []),
  resolveTxt: vi.fn(async () => []),
}));
vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    private data = "";
    getTokenCache() {
      return {
        serialize: () =>
          this.data ||
          JSON.stringify({ refresh: "refresh-token-fixture", generation: mail.generation }),
        deserialize: (value: string) => {
          this.data = value;
        },
        getAccountByHomeId: async (id: string) => ({ homeAccountId: id }),
      };
    }
    async getAuthCodeUrl(options: { state: string; codeChallenge: string; redirectUri: string }) {
      return `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=${options.state}&code_challenge=${options.codeChallenge}&redirect_uri=${encodeURIComponent(options.redirectUri)}`;
    }
    async acquireTokenByCode(options: { codeVerifier: string }) {
      mail.verifiers.push(options.codeVerifier);
      return {
        accessToken: "access-token-fixture",
        account: { homeAccountId: "fixture-home-account" },
      };
    }
    async acquireTokenSilent() {
      mail.refreshes++;
      if (mail.revoked)
        throw { errorCode: "invalid_grant", message: "private token provider diagnostic" };
      mail.generation++;
      this.data = JSON.stringify({ refresh: "refresh-token-fixture", generation: mail.generation });
      return { accessToken: `access-token-${mail.generation}` };
    }
  },
}));

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)(
  "EM-03 tenant outgoing email — real PostgreSQL",
  () => {
    let owner: PrismaClient, db: Database, app: NestFastifyApplication;
    type Identity = {
      id: string;
      tenantId: string;
      slug: string;
      email: string;
      cookie: string;
      csrf: string;
      sessionId: string;
    };
    let admin: Identity, other: Identity, employee: Identity;
    const tenants: string[] = [],
      operators: string[] = [],
      fixture = randomUUID(),
      password = `smtp-fixture-${fixture}`;
    const input = (revision: number) => ({
      revision,
      provider: "smtp",
      host: "smtp.example.test",
      port: 587,
      security: "starttls",
      username: "support@customer.test",
      password,
      fromAddress: "support@customer.test",
    });
    const request = (identity: Identity, method: "GET" | "POST", path = "", payload?: unknown) =>
      app.inject({
        method,
        url: `/api/admin/outgoing-email${path}`,
        headers: {
          host: `${identity.slug}.astrama.test`,
          origin: `https://${identity.slug}.astrama.test`,
          cookie: identity.cookie,
          "x-csrf-token": identity.csrf,
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const view = async (identity = admin) =>
      (await request(identity, "GET")).json<OutgoingMailView>();
    const save = async () => {
      const response = await request(
        admin,
        "POST",
        "/smtp/test-and-save",
        input((await view()).revision),
      );
      expect(response.statusCode, response.body).toBe(201);
      return response.json<OutgoingMailView>();
    };
    async function identity(
      tenantId: string,
      slug: string,
      role: "admin" | "employee",
    ): Promise<Identity> {
      const id = randomUUID(),
        token = randomUUID(),
        csrf = randomUUID(),
        sessionId = randomUUID(),
        email = `${id}@user.test`;
      await owner.user.create({
        data: {
          id,
          tenantId,
          email,
          name: role,
          passwordHash: "fixture",
          role,
          mfaEnrolled: role === "admin",
          mfaSecret: role === "admin" ? "fixture-unused" : null,
        },
      });
      await owner.session.create({
        data: {
          id: sessionId,
          tenantId,
          userId: id,
          tokenHash: tokenHash(token),
          csrfToken: csrf,
          mfaVerified: role === "admin",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      return { id, tenantId, slug, email, cookie: `astrama_session=${token}`, csrf, sessionId };
    }
    beforeAll(async () => {
      for (const [key, value] of Object.entries({
        PLATFORM_MODE: "hosted",
        APP_BASE_DOMAIN: "astrama.test",
        PUBLIC_SITE_ORIGIN: "https://astrama.test",
        OPERATOR_ORIGIN: "https://ops.astrama.test",
        OPERATOR_IP_ALLOWLIST: "",
        SMTP_HOST: "platform.example.test",
        SMTP_FROM: "notifications@platform.test",
        PLATFORM_MAIL_DOMAIN: "platform.test",
        INBOUND_MAIL_DOMAIN: "in.astrama.test",
        SMTP_PORT: "587",
        M365_CLIENT_ID: randomUUID(),
        M365_CLIENT_SECRET: "deployment-client-secret-fixture",
        M365_CLIENT_SECRET_FILE: "",
        M365_REDIRECT_URI: "https://astrama.test/api/mail/microsoft365/callback",
      }))
        vi.stubEnv(key, value);
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
      db = new Database();
      for (let index = 0; index < 2; index++) {
        const tenant = await owner.tenant.create({
          data: {
            slug: `out-${index}-${fixture}`,
            name: "Outgoing fixture",
            brandName: `Brand ${index}`,
          },
        });
        tenants.push(tenant.id);
        const who = await identity(tenant.id, tenant.slug, "admin");
        if (index === 0) admin = who;
        else other = who;
      }
      employee = await identity(admin.tenantId, admin.slug, "employee");
      const { createApp } = await import("../dist/main.js");
      app = await createApp();
      await app.getHttpAdapter().getInstance().ready();
    }, 30000);
    afterAll(async () => {
      for (const id of tenants) closeTenantSmtp(id);
      await app?.close();
      await db?.$disconnect();
      if (owner) {
        if (tenants.length) {
          await owner.mailOAuthConnection.deleteMany({ where: { tenantId: { in: tenants } } });
          await owner.tenantOutgoingMail.deleteMany({ where: { tenantId: { in: tenants } } });
          await owner.configAudit.deleteMany({ where: { tenantId: { in: tenants } } });
          await owner.session.deleteMany({ where: { tenantId: { in: tenants } } });
          await owner.user.deleteMany({ where: { tenantId: { in: tenants } } });
          await owner.$executeRaw`DELETE FROM tenant_budgets WHERE tenant_id=ANY(${tenants}::uuid[])`;
          await owner.tenant.deleteMany({ where: { id: { in: tenants } } });
        }
        await owner.operatorSession.deleteMany({ where: { operatorId: { in: operators } } });
        await owner.operator.updateMany({
          where: { id: { in: operators } },
          data: { active: false },
        });
        await owner.$disconnect();
      }
      vi.unstubAllEnvs();
    });
    it("denies employees and cross-tenant SQL/API access to connection settings", async () => {
      expect((await request(employee, "GET")).statusCode).toBe(403);
      expect((await request(employee, "POST", "/smtp/test-and-save", input(0))).statusCode).toBe(
        403,
      );
      expect((await view(other)).smtp).toBeNull();
      const response = await app.inject({
        method: "GET",
        url: `/api/admin/outgoing-email?tenantId=${other.tenantId}`,
        headers: { host: `${admin.slug}.astrama.test`, cookie: admin.cookie },
      });
      expect(response.json().smtp).toBeNull();
      await expect(
        db.withTenant(
          admin.tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO tenant_outgoing_mail(tenant_id) VALUES(${other.tenantId}::uuid)`,
        ),
      ).rejects.toThrow();
    });
    it("refuses plaintext/private targets, leaves failed tests inactive and encrypts a successfully tested SMTP password", async () => {
      for (const host of [
        "127.0.0.1",
        "10.1.2.3",
        "169.254.169.254",
        "[::1]",
        "db",
        "storage",
        "scanner",
        "mailpit",
      ]) {
        const response = await request(admin, "POST", "/smtp/test-and-save", { ...input(0), host });
        expect(response.statusCode, response.body).toBe(400);
      }
      for (const change of [{ security: "plaintext" }, { port: 1025 }])
        expect(
          (await request(admin, "POST", "/smtp/test-and-save", { ...input(0), ...change }))
            .statusCode,
        ).toBe(400);
      mail.failOwn = true;
      const failed = await request(admin, "POST", "/smtp/test-and-save", input(0));
      mail.failOwn = false;
      expect(failed.statusCode).toBe(400);
      expect(failed.body).toContain("authentication failed");
      expect(failed.body).not.toContain("secret credential");
      expect((await view()).mode).toBe("platform");
      const saved = await save();
      expect(saved).toMatchObject({
        revision: 1,
        mode: "smtp",
        effectiveMode: "smtp",
        status: "working",
        smtp: { passwordSet: true },
      });
      expect(mail.sent.at(-1)!.options.to).toBe(admin.email);
      expect(JSON.stringify(saved)).not.toContain(password);
      const row = await owner.tenantOutgoingMail.findUniqueOrThrow({
        where: { tenantId: admin.tenantId },
      });
      expect(row.encryptedSecret).not.toContain(password);
      expect(decryptSecret(row.encryptedSecret!, `smtp:${admin.tenantId}`)).toBe(password);
      expect(exportTables as readonly string[]).not.toContain("tenant_outgoing_mail");
      expect(exportTables as readonly string[]).not.toContain("mail_oauth_connections");
      await db.withTenant(other.tenantId, async (tx) =>
        expect(await tx.tenantOutgoingMail.findMany()).toEqual([]),
      );
    });
    it("allows one concurrent settings update and returns a revision conflict for the other", async () => {
      const revision = (await view()).revision,
        before = mail.sent.length;
      const results = await Promise.all([
        request(admin, "POST", "/smtp/test-and-save", input(revision)),
        request(admin, "POST", "/smtp/test-and-save", input(revision)),
      ]);
      expect(results.map((result) => result.statusCode).sort()).toEqual([201, 409]);
      expect(mail.sent.length).toBe(before + 1);
      expect((await view()).revision).toBe(revision + 1);
    });
    it("uses the tenant's own identity and reply token without sharing transports or credentials across tenants", async () => {
      const transport = createPlatformTransport(db);
      await db.withTenant(admin.tenantId, (tx) =>
        sendTenantMail(transport, tx, admin.tenantId, {
          to: employee.email,
          text: "Fixture",
          replyTo: `${admin.slug}+t.reply-token@in.astrama.test`,
          messageId: "<stable@platform.test>",
        }),
      );
      expect(mail.sent.at(-1)).toMatchObject({
        host: "smtp.example.test",
        options: {
          from: { name: "Brand 0 Support", address: "support@customer.test" },
          replyTo: `${admin.slug}+t.reply-token@in.astrama.test`,
          messageId: "<stable@customer.test>",
        },
      });
      await db.withTenant(other.tenantId, (tx) =>
        sendTenantMail(transport, tx, other.tenantId, { to: other.email, text: "Other" }),
      );
      expect(mail.sent.at(-1)).toMatchObject({
        host: "platform.example.test",
        options: { from: { name: "Brand 1 Support", address: "notifications@platform.test" } },
      });
      transport.close();
    });
    it("resets failure counts on success then falls back on the fifth failure with an audited durable platform notice", async () => {
      const transport = createPlatformTransport(db);
      const send = () =>
        db.withTenant(admin.tenantId, async (tx) => {
          try {
            await sendTenantMail(transport, tx, admin.tenantId, {
              to: admin.email,
              text: "Failure check",
            });
            return true;
          } catch {
            return false;
          }
        });
      mail.failOwn = true;
      expect(await send()).toBe(false);
      expect(await send()).toBe(false);
      mail.failOwn = false;
      expect(await send()).toBe(true);
      expect(
        (await owner.tenantOutgoingMail.findUniqueOrThrow({ where: { tenantId: admin.tenantId } }))
          .consecutiveFailures,
      ).toBe(0);
      mail.failOwn = true;
      for (let index = 0; index < 4; index++) expect(await send()).toBe(false);
      expect(await send()).toBe(false);
      // The failing attempt commits fallback first; its durable retry uses platform.
      expect(await send()).toBe(true);
      mail.failOwn = false;
      const state = await view();
      expect(state).toMatchObject({ mode: "smtp", status: "problem", effectiveMode: "platform" });
      expect(mail.sent.at(-1)!.host).toBe("platform.example.test");
      expect(mail.sent.at(-1)!.options.from).toEqual({
        name: "Brand 0 Support",
        address: "notifications@platform.test",
      });
      expect(
        await owner.configAudit.count({
          where: { tenantId: admin.tenantId, action: "outgoing_email.fallback" },
        }),
      ).toBe(1);
      const { OutgoingEmailService } = await import("../dist/outgoing-email.js");
      vi.stubEnv("TENANT_OUTBOUND_PER_HOUR", "1");
      const window = new Date(Math.floor(Date.now() / 3600000) * 3600000);
      await owner.$executeRaw`INSERT INTO tenant_budgets(tenant_id,kind,window_start,used) VALUES(${admin.tenantId}::uuid,'outbound',${window},1) ON CONFLICT(tenant_id,kind,window_start) DO UPDATE SET used=1`;
      await app.get(OutgoingEmailService).dispatchNotices();
      const deferred = await owner.tenantOutgoingMail.findUniqueOrThrow({
        where: { tenantId: admin.tenantId },
      });
      expect(deferred.noticeAttempts).toBe(0);
      expect(deferred.noticeSentAt).toBeNull();
      vi.stubEnv("TENANT_OUTBOUND_PER_HOUR", "");
      await owner.tenantOutgoingMail.update({
        where: { tenantId: admin.tenantId },
        data: { noticeNextAttemptAt: new Date(0) },
      });
      mail.failPlatform = true;
      await app.get(OutgoingEmailService).dispatchNotices();
      mail.failPlatform = false;
      expect(
        (await owner.tenantOutgoingMail.findUniqueOrThrow({ where: { tenantId: admin.tenantId } }))
          .noticeSentAt,
      ).toBeNull();
      await owner.tenantOutgoingMail.update({
        where: { tenantId: admin.tenantId },
        data: { noticeNextAttemptAt: new Date(0), noticeAttempts: 10 },
      });
      await app.get(OutgoingEmailService).dispatchNotices();
      expect(mail.sent.at(-1)).toMatchObject({
        host: "platform.example.test",
        options: { to: [admin.email], subject: "Your outgoing email connection needs attention" },
      });
      expect(
        (await owner.tenantOutgoingMail.findUniqueOrThrow({ where: { tenantId: admin.tenantId } }))
          .noticeSentAt,
      ).not.toBeNull();
      transport.close();
    });
    it("reserves SQL commit time after waiting for a tenant SMTP row lock", async () => {
      await save();
      await owner.tenantOutgoingMail.update({
        where: { tenantId: admin.tenantId },
        data: { consecutiveFailures: 4 },
      });
      let release = () => {},
        locked = () => {};
      const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = owner.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT tenant_id FROM tenant_outgoing_mail WHERE tenant_id=${admin.tenantId}::uuid FOR UPDATE`;
          locked();
          await hold;
        },
        { timeout: 20000 },
      );
      await acquired;
      const transport = createPlatformTransport(db),
        sentBefore = mail.sent.length,
        start = performance.now();
      mail.delayOwn = 5000;
      try {
        const attempt = db.withTenant(admin.tenantId, async (tx) => {
          try {
            await sendTenantMail(transport, tx, admin.tenantId, {
              to: admin.email,
              text: "SQL margin fixture",
            });
            return true;
          } catch {
            return false;
          }
        });
        await new Promise((resolve) => setTimeout(resolve, 8000));
        release();
        await blocker;
        expect(await attempt).toBe(false);
        expect(performance.now() - start).toBeLessThan(14500);
        const state = await owner.tenantOutgoingMail.findUniqueOrThrow({
          where: { tenantId: admin.tenantId },
        });
        expect(state).toMatchObject({ consecutiveFailures: 5, status: "problem" });
        expect(state.noticePendingAt).not.toBeNull();
        await new Promise((resolve) => setTimeout(resolve, 650));
        expect(mail.sent).toHaveLength(sentBefore);
      } finally {
        release();
        await blocker;
        mail.delayOwn = 0;
        transport.close();
      }
      await save();
    }, 20000);
    it("rejects stale revisions and sends read-only mail only through platform to current administrators across every recipient field", async () => {
      const saved = await save();
      const stale = await request(admin, "POST", "/platform", { revision: saved.revision - 1 });
      expect(stale.statusCode).toBe(409);
      await owner.tenant.update({
        where: { id: admin.tenantId },
        data: {
          status: "read_only",
          readOnlyReason: "payment_failed",
          readOnlySince: new Date(),
          deleteAfter: new Date(Date.now() + 86400000),
        },
      });
      const transport = createPlatformTransport(db);
      for (const fields of [
        { to: employee.email },
        { to: admin.email, cc: employee.email },
        { to: admin.email, bcc: { name: "Hidden", address: employee.email } },
        { to: admin.email, envelope: { from: admin.email, to: [employee.email] } },
      ])
        await expect(
          db.withTenant(admin.tenantId, (tx) =>
            sendTenantMail(transport, tx, admin.tenantId, { ...fields, text: "Read only" }),
          ),
        ).rejects.toThrow("current administrators");
      await db.withTenant(admin.tenantId, (tx) =>
        sendTenantMail(transport, tx, admin.tenantId, { to: admin.email, text: "Admin read only" }),
      );
      expect(mail.sent.at(-1)!.host).toBe("platform.example.test");
      expect((await view()).effectiveMode).toBe("platform");
      expect(
        (await request(admin, "POST", "/platform", { revision: saved.revision })).statusCode,
      ).toBe(403);
      transport.close();
      await owner.tenant.update({
        where: { id: admin.tenantId },
        data: { status: "active", readOnlyReason: null, readOnlySince: null, deleteAfter: null },
      });
    });
    it("shows operators status only, denies support resets and clears credentials with an audited owner reset", async () => {
      const operator = async (role: "support" | "owner") => {
        const id = randomUUID(),
          token = randomUUID(),
          csrf = randomUUID();
        operators.push(id);
        await owner.operator.create({
          data: {
            id,
            email: `${id}@operator.test`,
            name: role,
            role,
            passwordHash: "fixture",
            mfaEnrolled: true,
            encryptedMfaSecret: encryptSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", `operator:${id}`),
          },
        });
        await owner.operatorSession.create({
          data: {
            operatorId: id,
            tokenHash: tokenHash(token),
            csrfToken: csrf,
            mfaVerified: true,
            expiresAt: new Date(Date.now() + 3600000),
          },
        });
        return { cookie: `astrama_operator_session=${token}`, csrf };
      };
      const support = await operator("support"),
        operatorOwner = await operator("owner");
      const op = (
        who: { cookie: string; csrf: string },
        method: "GET" | "POST",
        payload?: object,
      ) =>
        app.inject({
          method,
          url: `/api/operator/organisations/${admin.tenantId}/outgoing-email${method === "POST" ? "/reset" : ""}`,
          headers: {
            host: "ops.astrama.test",
            origin: "https://ops.astrama.test",
            cookie: who.cookie,
            "x-csrf-token": who.csrf,
          },
          ...(payload ? { payload } : {}),
        });
      const summary = (await op(support, "GET")).json<OutgoingMailSummary>();
      expect(Object.keys(summary).sort()).toEqual(["effectiveMode", "mode", "revision", "status"]);
      expect(JSON.stringify(summary)).not.toContain("customer.test");
      const change = {
        revision: summary.revision,
        reason: "Owner approved connection reset for fixture",
      };
      expect((await op(support, "POST", change)).statusCode).toBe(403);
      expect((await op(operatorOwner, "POST", change)).statusCode).toBe(201);
      const settings = await owner.tenantOutgoingMail.findUniqueOrThrow({
        where: { tenantId: admin.tenantId },
      });
      expect(settings.encryptedSecret).toBeNull();
      expect((await view()).mode).toBe("platform");
      expect(
        await owner.operatorAudit.count({
          where: {
            action: "outgoing_email.reset",
            tenantId: admin.tenantId,
            reason: change.reason,
          },
        }),
      ).toBe(1);
    });
    it("binds a Microsoft OAuth state and PKCE to the initiating administrator/session and rejects replay before activation", async () => {
      const revision = (await view()).revision;
      const begin = await request(admin, "POST", "/microsoft365/connect", {
        revision,
        mailboxAddress: "desk@customer.test",
        fromAddress: "desk@customer.test",
      });
      expect(begin.statusCode, begin.body).toBe(201);
      const data = begin.json<{ connectionId: string; authorizationUrl: string }>(),
        state = new URL(data.authorizationUrl).searchParams.get("state")!;
      const pending = await owner.mailOAuthConnection.findUniqueOrThrow({
        where: { id: data.connectionId },
      });
      expect(pending.stateHash).toBe(tokenHash(state));
      const verifier = decryptSecret(
        pending.encryptedPkce!,
        `smtp-oauth-state:${admin.tenantId}:${pending.id}`,
      );
      expect((await view(other)).pendingMicrosoft365).toBeNull();
      expect(
        (
          await request(other, "POST", "/microsoft365/test-and-save", {
            revision: 0,
            connectionId: pending.id,
          })
        ).statusCode,
      ).toBe(400);
      const callback = (host: string, oauthState = state) =>
        app.inject({
          method: "GET",
          url: `/api/mail/microsoft365/callback?state=${oauthState}&code=fixture-code`,
          headers: { host },
        });
      expect((await callback(`${admin.slug}.astrama.test`)).statusCode).toBe(403);
      expect((await callback("astrama.test", "x".repeat(43))).statusCode).toBe(400);
      const exchanges = mail.verifiers.length;
      const returned = await callback("astrama.test");
      expect(returned.statusCode, returned.body).toBe(302);
      const location = new URL(returned.headers.location!);
      expect(location.origin).toBe(`https://${admin.slug}.astrama.test`);
      expect(location.searchParams.get("mailConnect")).toBe("confirm");
      expect(location.searchParams.has("mailHandoff")).toBe(false);
      const handoff = new URLSearchParams(location.hash.slice(1)).get("mailHandoff")!;
      expect(mail.verifiers).toHaveLength(exchanges);
      expect((await callback("astrama.test")).statusCode).toBe(400);
      const held = await view();
      expect(held.pendingMicrosoft365?.status).toBe("pending");
      expect(JSON.stringify(held)).not.toContain(handoff);
      expect(
        (
          await request(admin, "POST", "/microsoft365/test-and-save", {
            revision,
            connectionId: data.connectionId,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await request(admin, "POST", "/microsoft365/complete", { handoff: state })).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/outgoing-email/microsoft365/complete",
            headers: {
              host: `${admin.slug}.astrama.test`,
              origin: `https://${admin.slug}.astrama.test`,
            },
            payload: { handoff },
          })
        ).statusCode,
      ).toBe(401);
      expect((await request(other, "POST", "/microsoft365/complete", { handoff })).statusCode).toBe(
        400,
      );
      const alternateToken = randomUUID(),
        alternateCsrf = randomUUID(),
        alternateSession = randomUUID();
      await owner.session.create({
        data: {
          id: alternateSession,
          tenantId: admin.tenantId,
          userId: admin.id,
          tokenHash: tokenHash(alternateToken),
          csrfToken: alternateCsrf,
          mfaVerified: true,
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      expect(
        (
          await request(
            {
              ...admin,
              sessionId: alternateSession,
              cookie: `astrama_session=${alternateToken}`,
              csrf: alternateCsrf,
            },
            "POST",
            "/microsoft365/complete",
            { handoff },
          )
        ).statusCode,
      ).toBe(400);
      const completed = await request(admin, "POST", "/microsoft365/complete", { handoff });
      expect(completed.statusCode, completed.body).toBe(201);
      expect(mail.verifiers.at(-1)).toBe(verifier);
      expect((await request(admin, "POST", "/microsoft365/complete", { handoff })).statusCode).toBe(
        400,
      );
      const ready = await view();
      expect(ready.mode).toBe("platform");
      expect(ready.pendingMicrosoft365?.status).toBe("ready");
      expect(JSON.stringify(ready)).not.toContain("refresh-token");
      const row = await owner.mailOAuthConnection.findUniqueOrThrow({
        where: { id: data.connectionId },
      });
      expect(row.encryptedPkce).toBeNull();
      expect(decryptSecret(row.encryptedCache!, `smtp:${admin.tenantId}`)).toContain(
        "refresh-token-fixture",
      );
      const activated = await request(admin, "POST", "/microsoft365/test-and-save", {
        revision,
        connectionId: data.connectionId,
      });
      expect(activated.statusCode, activated.body).toBe(201);
      expect(activated.json()).toMatchObject({
        mode: "microsoft365",
        status: "working",
        pendingMicrosoft365: null,
      });
      expect(mail.sent.at(-1)).toMatchObject({
        host: "smtp.office365.com",
        options: { to: admin.email, auth: { type: "OAuth2", user: "desk@customer.test" } },
      });
    });
    it("refreshes and persists encrypted Microsoft tokens, then flags revoked consent and sends through platform", async () => {
      const transport = createPlatformTransport(db);
      const send = () =>
        db.withTenant(admin.tenantId, async (tx) => {
          try {
            await sendTenantMail(transport, tx, admin.tenantId, {
              to: admin.email,
              text: "OAuth send",
            });
            return true;
          } catch {
            return false;
          }
        });
      const before = await owner.tenantOutgoingMail.findUniqueOrThrow({
        where: { tenantId: admin.tenantId },
      });
      const count = mail.refreshes;
      await send();
      await send();
      expect(mail.refreshes).toBe(count + 2);
      const after = await owner.tenantOutgoingMail.findUniqueOrThrow({
        where: { tenantId: admin.tenantId },
      });
      expect(after.encryptedSecret).not.toBe(before.encryptedSecret);
      expect(decryptSecret(after.encryptedSecret!, `smtp:${admin.tenantId}`)).toContain(
        "refresh-token-fixture",
      );
      mail.revoked = true;
      expect(await send()).toBe(false);
      mail.revoked = false;
      expect(await view()).toMatchObject({
        mode: "microsoft365",
        status: "problem",
        effectiveMode: "platform",
      });
      expect(await send()).toBe(true);
      expect(mail.sent.at(-1)!.host).toBe("platform.example.test");
      expect((await view()).lastError).toContain("Connect Microsoft 365 again");
      transport.close();
    });
    it("rejects OAuth completion after session revocation and removes pending credentials on platform reset", async () => {
      const begin = await request(other, "POST", "/microsoft365/connect", {
        revision: 0,
        mailboxAddress: "other@customer.test",
        fromAddress: "other@customer.test",
      });
      expect(begin.statusCode).toBe(201);
      const state = new URL(begin.json().authorizationUrl).searchParams.get("state")!;
      await owner.session.update({
        where: { id: other.sessionId },
        data: { expiresAt: new Date(0) },
      });
      const callback = await app.inject({
        method: "GET",
        url: `/api/mail/microsoft365/callback?state=${state}&code=fixture-code`,
        headers: { host: "astrama.test" },
      });
      expect(callback.statusCode).toBe(400);
      await owner.mailOAuthConnection.updateMany({
        where: { tenantId: other.tenantId },
        data: { expiresAt: new Date(0) },
      });
      const { OutgoingEmailService } = await import("../dist/outgoing-email.js");
      await app.get(OutgoingEmailService).dispatchNotices();
      expect(await owner.mailOAuthConnection.count({ where: { tenantId: other.tenantId } })).toBe(
        0,
      );
      const reset = await request(admin, "POST", "/platform", {
        revision: (await view()).revision,
      });
      expect(reset.statusCode).toBe(201);
      expect(
        (await owner.tenantOutgoingMail.findUniqueOrThrow({ where: { tenantId: admin.tenantId } }))
          .encryptedSecret,
      ).toBeNull();
      expect(await owner.mailOAuthConnection.count({ where: { tenantId: admin.tenantId } })).toBe(
        0,
      );
    });
  },
);
