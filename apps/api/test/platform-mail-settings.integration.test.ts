import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaClient } from "@prisma/client";
import { Database } from "../src/database.js";
import { decryptSecret, encryptSecret, totp } from "../src/mfa.js";
import { tokenHash } from "../src/modules/auth/auth.service.js";
import { createPlatformTransport, sendTenantMail } from "../src/platform-mail.js";
import type { PlatformMailProfile, PlatformMailView } from "@astrama/contracts";

const smtp = vi.hoisted(() => ({
  sent: [] as { host: string; options: Record<string, unknown> }[],
  closed: [] as string[],
  fail: false,
}));
vi.mock("nodemailer", () => ({
  createTransport: (options: { host: string }) => ({
    options,
    sendMail: vi.fn(async (message: Record<string, unknown>) => {
      if (smtp.fail) throw new Error("AUTH secret-password must never reach response");
      smtp.sent.push({ host: options.host, options: message });
      return { accepted: [message.to], messageId: message.messageId };
    }),
    close: () => smtp.closed.push(options.host),
  }),
}));
vi.mock("node:dns/promises", () => ({
  resolveMx: vi.fn(async () => [{ priority: 10, exchange: "in.astrama.test" }]),
  resolveTxt: vi.fn(async (name: string) => [
    [
      name.startsWith("_dmarc.")
        ? "v=DMARC1; p=quarantine"
        : name.includes("._domainkey.")
          ? "v=DKIM1; p=fixture"
          : "v=spf1 mx -all",
    ],
  ]),
}));

describe.skipIf(
  process.env.RUN_PLATFORM_MAIL_TESTS !== "true" ||
    !process.env.DATABASE_URL ||
    !process.env.MIGRATION_DATABASE_URL,
)("MS-01 owner platform mail — real PostgreSQL", () => {
  let owner: PrismaClient, db: Database, app: NestFastifyApplication;
  type Identity = { id: string; sessionId: string; cookie: string; csrf: string };
  let primary: Identity, second: Identity, support: Identity;
  let tenantId: string, tenantCookie: string;
  let ownsSettings = false,
    initialRevision = 0,
    addedRejections = 0;
  const totpFixtureSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    fixture = randomUUID(),
    password = `smtp-test-${fixture}`;
  const profiles: string[] = [],
    identities: string[] = [],
    publicMailIds: string[] = [];
  const reason = "Owner approved platform mail switch for integration check";
  const profile = (host = "mox") => ({
    name: `Profile ${host}`,
    provider: "mox",
    host,
    port: 587,
    security: "starttls",
    username: "smtp-fixture",
    password,
    fromAddress: "desk@mail.astrama.test",
    fromDomain: "mail.astrama.test",
  });
  const request = (identity: Identity, method: "GET" | "POST", path = "", payload?: unknown) =>
    app.inject({
      method,
      url: `/api/operator/platform-email${path}`,
      headers: {
        host: "ops.astrama.test",
        origin: "https://ops.astrama.test",
        cookie: identity.cookie,
        "x-csrf-token": identity.csrf,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const fresh = async (identity: Identity) => {
    await owner.operator.update({ where: { id: identity.id }, data: { mfaLastStep: -1 } });
    return totp(totpFixtureSeed, Math.floor(Date.now() / 30000));
  };
  async function identity(role: "owner" | "support"): Promise<Identity> {
    const id = randomUUID(),
      sessionId = randomUUID(),
      token = randomUUID(),
      csrf = randomUUID();
    identities.push(id);
    await owner.operator.create({
      data: {
        id,
        email: `${id}@operator.test`,
        name: role,
        role,
        passwordHash: "fixture",
        mfaEnrolled: true,
        encryptedMfaSecret: encryptSecret(totpFixtureSeed, `operator:${id}`),
      },
    });
    await owner.operatorSession.create({
      data: {
        id: sessionId,
        operatorId: id,
        tokenHash: tokenHash(token),
        csrfToken: csrf,
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    return { id, sessionId, csrf, cookie: `astrama_operator_session=${token}` };
  }
  const view = async () => (await request(primary, "GET")).json<PlatformMailView>();
  async function draft(host = "mox") {
    const response = await request(primary, "POST", "/profiles", profile(host));
    expect(response.statusCode, response.body).toBe(201);
    const saved = response.json<PlatformMailProfile>();
    profiles.push(saved.id);
    return saved;
  }
  beforeAll(async () => {
    vi.stubEnv("PLATFORM_MODE", "hosted");
    vi.stubEnv("APP_BASE_DOMAIN", "astrama.test");
    vi.stubEnv("PUBLIC_SITE_ORIGIN", "https://astrama.test");
    vi.stubEnv("OPERATOR_ORIGIN", "https://ops.astrama.test");
    vi.stubEnv("INBOUND_MAIL_DOMAIN", "in.astrama.test");
    vi.stubEnv("PLATFORM_MAIL_DOMAIN", "fallback.astrama.test");
    vi.stubEnv("OPERATOR_IP_ALLOWLIST", "");
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    db = new Database();
    const [initial] = await owner.$queryRaw<
      {
        revision: number;
        active_profile_id: string | null;
        previous_profile_id: string | null;
        probe_hash: string | null;
        profile_count: bigint;
      }[]
    >`
        SELECT s.revision,s.active_profile_id,s.previous_profile_id,s.probe_hash,(SELECT count(*) FROM platform_mail_profiles) AS profile_count FROM platform_mail_settings s WHERE id=true`;
    expect(
      initial?.active_profile_id,
      "Use a disposable database without platform mail profiles",
    ).toBeNull();
    expect(initial?.previous_profile_id).toBeNull();
    expect(initial?.probe_hash).toBeNull();
    expect(initial?.profile_count).toBe(0n);
    initialRevision = initial!.revision;
    ownsSettings = true;
    primary = await identity("owner");
    second = await identity("owner");
    support = await identity("support");
    const tenant = await owner.tenant.create({
      data: { slug: `mail-${fixture}`, name: "Mail settings fixture", brandName: "Fixture" },
    });
    tenantId = tenant.id;
    const user = await owner.user.create({
      data: {
        tenantId,
        name: "Admin",
        email: `${fixture}@admin.test`,
        role: "admin",
        passwordHash: "fixture",
        mfaEnrolled: true,
        mfaSecret: "fixture-not-used-for-login",
      },
    });
    const token = randomUUID();
    tenantCookie = `astrama_session=${token}`;
    await owner.session.create({
      data: {
        tenantId,
        userId: user.id,
        tokenHash: tokenHash(token),
        csrfToken: "tenant-csrf",
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const department = await owner.department.create({
      data: { tenantId, name: "Triage", isTriage: true },
    });
    const category = await owner.category.create({
      data: { tenantId, name: "Email", departmentId: department.id },
    });
    await owner.inboundMailSettings.create({
      data: {
        tenantId,
        triageDepartmentId: department.id,
        triageCategoryId: category.id,
        allowUnverifiedSenders: true,
      },
    });
    await owner.inboundMailAddress.create({
      data: {
        tenantId,
        address: `${tenant.slug}@in.astrama.test`,
        departmentId: department.id,
        categoryId: category.id,
        isGeneral: true,
      },
    });
    const { createApp } = await import("../dist/main.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (owner) {
      if (!ownsSettings) {
        await owner.$disconnect();
        vi.unstubAllEnvs();
        return;
      }
      await owner.$executeRaw`UPDATE platform_mail_settings SET active_profile_id=NULL,previous_profile_id=NULL,probe_hash=NULL,probe_address=NULL,probe_started_at=NULL,probe_received_at=NULL,revision=${initialRevision},intake_rejected=intake_rejected-${addedRejections}::bigint WHERE id=true`;
      await owner.$executeRaw`DELETE FROM platform_mail_profiles WHERE id=ANY(${profiles}::uuid[])`;
      await owner.publicMailOutbox.deleteMany({ where: { id: { in: publicMailIds } } });
      await owner.$executeRaw`DELETE FROM tenant_mail_deliveries WHERE kind=${`ms01-health-${fixture}`}`;
      if (tenantId) {
        await owner.session.deleteMany({ where: { tenantId } });
        await owner.user.deleteMany({ where: { tenantId } });
        await owner.inboundMailAddress.deleteMany({ where: { tenantId } });
        await owner.inboundMailSettings.deleteMany({ where: { tenantId } });
        await owner.category.deleteMany({ where: { tenantId } });
        await owner.department.deleteMany({ where: { tenantId } });
        await owner.$executeRaw`DELETE FROM tenant_budgets WHERE tenant_id=${tenantId}::uuid`;
        await owner.tenant.delete({ where: { id: tenantId } });
      }
      // Operator audit history is append-only, so retain inactive fixture identities as other operator integration tests do.
      await owner.operatorSession.deleteMany({ where: { operatorId: { in: identities } } });
      await owner.operator.updateMany({
        where: { id: { in: identities } },
        data: { active: false },
      });
      await owner.$disconnect();
    }
    vi.unstubAllEnvs();
  });
  it("denies support and tenant administrators all platform settings operations and raw global tables", async () => {
    for (const [method, path, body] of [
      ["GET", "", undefined],
      ["POST", "/profiles", profile()],
      ["POST", "/activate", {}],
      ["POST", "/rollback", {}],
      ["POST", `/profiles/${randomUUID()}/test`, {}],
      ["POST", `/profiles/${randomUUID()}/dns-check`, {}],
      ["POST", "/receiving/test", { address: "unknown@in.astrama.test" }],
    ] as const)
      expect((await request(support, method, path, body)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/operator/platform-email",
          headers: { host: `mail-${fixture}.astrama.test`, cookie: tenantCookie },
        })
      ).statusCode,
    ).toBe(403);
    await expect(
      db.$queryRaw`SELECT encrypted_password FROM platform_mail_profiles`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE platform_mail_settings SET revision=999 WHERE id=true`,
    ).rejects.toThrow();
    await expect(
      db.$queryRaw`SELECT operator_platform_mail(${support.sessionId}::uuid,'view','{}'::jsonb)`,
    ).rejects.toThrow();
  });
  it("stores encrypted immutable profiles, sanitises failed SMTP tests, and gates activation on a successful test", async () => {
    const saved = await draft();
    expect(JSON.stringify(saved)).not.toContain(password);
    expect(saved.passwordSet).toBe(true);
    expect(saved.testedAt).toBeNull();
    const [stored] = await owner.$queryRaw<
      { settings: unknown; encrypted_password: string }[]
    >`SELECT settings,encrypted_password FROM platform_mail_profiles WHERE id=${saved.id}::uuid`;
    expect(JSON.stringify(stored)).not.toContain(password);
    expect(decryptSecret(stored!.encrypted_password, "platform-smtp")).toBe(password);
    const blocked = await request(primary, "POST", "/activate", {
      profileId: saved.id,
      revision: (await view()).revision,
      totpCode: await fresh(primary),
      reason,
    });
    expect(blocked.statusCode).toBe(400);
    smtp.fail = true;
    const failed = await request(primary, "POST", `/profiles/${saved.id}/test`, {});
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain("secret-password");
    expect((await view()).profiles.find((p) => p.id === saved.id)!.testedAt).toBeNull();
    smtp.fail = false;
    const tested = await request(primary, "POST", `/profiles/${saved.id}/test`, {});
    expect(tested.statusCode).toBe(201);
    expect(smtp.sent.at(-1)!.options.to).toBe(`${primary.id}@operator.test`);
    expect((await view()).profiles.find((p) => p.id === saved.id)!.testedAt).not.toBeNull();
    const dns = await request(primary, "POST", `/profiles/${saved.id}/dns-check`, {});
    expect(dns.json().records).toHaveLength(4);
    expect(dns.json().records.every((r: { ok: boolean }) => r.ok)).toBe(true);
    for (const changes of [{ security: "plaintext" }, { port: 1025 }, { fromDomain: "other.test" }])
      expect(
        (await request(primary, "POST", "/profiles", { ...profile(), ...changes })).statusCode,
      ).toBe(400);
  });
  it("switches live transports, preserves tenant headers, audits changes and rolls back with fresh MFA", async () => {
    const first = (await view()).profiles.find((p) => p.testedAt)!;
    const mail = createPlatformTransport(db);
    const activate = async (id: string) =>
      request(primary, "POST", "/activate", {
        profileId: id,
        revision: (await view()).revision,
        totpCode: await fresh(primary),
        reason,
      });
    expect((await activate(first.id)).statusCode).toBe(201);
    await db.withTenant(tenantId, (tx) =>
      sendTenantMail(mail, tx, tenantId, {
        to: "recipient@test.invalid",
        text: "Fixture",
        replyTo: `mail-${fixture}+t.token@in.astrama.test`,
        messageId: "<stable@old.invalid>",
      }),
    );
    expect(smtp.sent.at(-1)).toMatchObject({
      host: "mox",
      options: {
        from: { name: "Fixture Support", address: "desk@mail.astrama.test" },
        messageId: "<stable@mail.astrama.test>",
        replyTo: `mail-${fixture}+t.token@in.astrama.test`,
      },
    });
    const next = await draft("replacement");
    await request(primary, "POST", `/profiles/${next.id}/test`, {});
    expect((await activate(next.id)).statusCode).toBe(201);
    await mail.sendMail({
      to: "public@test.invalid",
      text: "Public fixture",
      from: "old@old.invalid",
    });
    expect(smtp.sent.at(-1)!.host).toBe("replacement");
    expect(smtp.closed).toContain("mox");
    const badMfa = await request(primary, "POST", "/rollback", {
      revision: (await view()).revision,
      totpCode: "000000",
      reason,
    });
    expect(badMfa.statusCode).toBe(401);
    const rollback = await request(primary, "POST", "/rollback", {
      revision: (await view()).revision,
      totpCode: await fresh(primary),
      reason,
    });
    expect(rollback.statusCode).toBe(201);
    await mail.sendMail({ to: "public@test.invalid", text: "Public fixture" });
    expect(smtp.sent.at(-1)!.host).toBe("mox");
    const replay = await request(primary, "POST", "/activate", {
      profileId: next.id,
      revision: (await view()).revision,
      totpCode: totp(totpFixtureSeed, Math.floor(Date.now() / 30000)),
      reason,
    });
    expect(replay.statusCode).toBe(401);
    expect(
      (
        await owner.operatorAudit.findMany({
          where: { operatorId: primary.id, action: { startsWith: "platform_email." } },
        })
      ).some((event) => event.action === "platform_email.rollback" && event.reason === reason),
    ).toBe(true);
    expect(JSON.stringify(await view())).not.toContain(password);
    mail.close();
  });
  it("serialises competing owner activations with a revision conflict", async () => {
    const a = await draft("concurrent-a"),
      b = await draft("concurrent-b");
    await request(primary, "POST", `/profiles/${a.id}/test`, {});
    await request(primary, "POST", `/profiles/${b.id}/test`, {});
    const revision = (await view()).revision;
    const results = await Promise.all([
      request(primary, "POST", "/activate", {
        profileId: a.id,
        revision,
        totpCode: await fresh(primary),
        reason,
      }),
      request(second, "POST", "/activate", {
        profileId: b.id,
        revision,
        totpCode: await fresh(second),
        reason,
      }),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });
  it("allows only explicitly chosen known intake aliases and consumes its hashed probe before ticket persistence", async () => {
    expect(
      (await request(primary, "POST", "/receiving/test", { address: "unknown@in.astrama.test" }))
        .statusCode,
    ).toBe(400);
    const address = `mail-${fixture}@in.astrama.test`;
    const sent = await request(primary, "POST", "/receiving/test", { address });
    expect(sent.statusCode).toBe(201);
    expect((await view()).receiving.testStatus).toBe("pending");
    const message = smtp.sent.at(-1)!.options;
    const { InboundMailService } =
      await import("../dist/modules/inbound-mail/inbound-mail.service.js");
    await app.get(InboundMailService).acceptSmtp({
      messageId: `<${randomUUID()}@test.invalid>`,
      recipient: address,
      sender: "probe@mail.astrama.test",
      subject: message.subject as string,
      text: "test",
      kind: "delivery",
      references: [],
      headers: {},
      attachments: [],
      authResults: { spf: "none", dkim: "none", dmarc: "none" },
    });
    expect((await view()).receiving.testStatus).toBe("working");
    expect(await owner.inboundMessage.count({ where: { tenantId } })).toBe(0);
    const [settings] = await owner.$queryRaw<
      { probe_hash: string }[]
    >`SELECT probe_hash FROM platform_mail_settings WHERE id=true`;
    expect(message.subject as string).not.toContain(settings!.probe_hash);
    expect((await view()).receiving.lastReceivedAt).not.toBeNull();
  });

  it("includes public signup sends and sanitised failures in global health and isolates their metadata from tenants", async () => {
    const { SaasService } = await import("../dist/modules/billing/saas.service.js");
    const enqueue = async () => {
      const id = randomUUID();
      publicMailIds.push(id);
      await owner.publicMailOutbox.create({
        data: {
          id,
          recipient: `${fixture}@signup.test`,
          subject: "Verify your email",
          identity: "ms01-public-fixture",
          encryptedUrl: encryptSecret(
            "https://astrama.test/signup/verify?token=fixture",
            "ms01-public-fixture",
          ),
        },
      });
    };
    const before = await view();
    await enqueue();
    await app.get(SaasService).dispatchPublicMail();
    expect(smtp.sent.at(-1)).toMatchObject({
      options: { from: "desk@mail.astrama.test", to: `${fixture}@signup.test` },
    });
    expect(smtp.sent.at(-1)!.options.messageId).toMatch(/@mail\.astrama\.test>$/);
    await enqueue();
    smtp.fail = true;
    await app.get(SaasService).dispatchPublicMail();
    smtp.fail = false;
    const after = await view();
    expect(after.health.sent).toBe(before.health.sent + 1);
    expect(after.health.failed).toBe(before.health.failed + 1);
    expect(typeof after.health.bounceRate).toBe("number");
    expect(after.health.junkRisk).toBe(after.health.bounceRate! > 0.05);
    await db.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status) VALUES(NULL,${`ms01-health-${fixture}`},'sent')`;
    const [visible] = await db.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) AS count FROM tenant_mail_deliveries WHERE tenant_id IS NULL`;
    expect(visible!.count).toBe(0n);
    const [metadata] = await owner.$queryRaw<
      { last_error: string }[]
    >`SELECT last_error FROM tenant_mail_deliveries WHERE tenant_id IS NULL AND kind='public' AND status='failed' ORDER BY created_at DESC LIMIT 1`;
    expect(metadata!.last_error).toBe("SMTP delivery failed");
  });

  it("accepts anonymous batched SMTP refusal counts through its narrow worker function", async () => {
    const before = (await view()).receiving.rejected;
    await db.$executeRaw`SELECT record_platform_mail_rejection(3::bigint)`;
    addedRejections += 3;
    expect((await view()).receiving.rejected).toBe(before + 3);
    await expect(
      db.$executeRaw`SELECT record_platform_mail_rejection(-1::bigint)`,
    ).rejects.toThrow();
    expect((await view()).receiving.rejected).toBe(before + 3);
  });

  it("closes idle profile transports and retains the environment transport in single-company mode", async () => {
    const mail = createPlatformTransport(db);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await mail.sendMail({ to: "idle@test.invalid", text: "Idle transport check" });
      const host = smtp.sent.at(-1)!.host;
      const closedBefore = smtp.closed.filter((value) => value === host).length;
      vi.advanceTimersByTime(60001);
      expect(smtp.closed.filter((value) => value === host)).toHaveLength(closedBefore + 1);
    } finally {
      vi.useRealTimers();
    }
    vi.stubEnv("PLATFORM_MODE", "single");
    try {
      await mail.sendMail({
        to: "single@test.invalid",
        text: "Bootstrap check",
        from: "bootstrap@fallback.astrama.test",
      });
      expect(smtp.sent.at(-1)).toMatchObject({
        host: process.env.SMTP_HOST,
        options: { from: "bootstrap@fallback.astrama.test" },
      });
    } finally {
      vi.stubEnv("PLATFORM_MODE", "hosted");
      mail.close();
    }
  });
  it("sends a tenant admin test only to the current administrator and denies employees and arbitrary recipients", async () => {
    const send = (payload: object) =>
      app.inject({
        method: "POST",
        url: "/api/admin/operations/email/test",
        headers: {
          host: `mail-${fixture}.astrama.test`,
          origin: `https://mail-${fixture}.astrama.test`,
          cookie: tenantCookie,
          "x-csrf-token": "tenant-csrf",
        },
        payload,
      });
    expect((await send({ to: "arbitrary@test.invalid" })).statusCode).toBe(400);
    const result = await send({});
    expect(result.statusCode, result.body).toBe(201);
    expect(smtp.sent.at(-1)!.options.to).toBe(`${fixture}@admin.test`);
    expect(String(smtp.sent.at(-1)!.options.text)).toContain("Astrama");
    await owner.user.updateMany({ where: { tenantId }, data: { role: "employee" } });
    expect((await send({})).statusCode).toBe(403);
  });
});
