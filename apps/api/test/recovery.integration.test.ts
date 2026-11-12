import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { hash, verify } from "argon2";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../src/database.js";
import type { RecoveryService } from "../src/recovery.js";

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)(
  "account recovery — real PostgreSQL",
  () => {
    let owner: PrismaClient, db: Database, db2: Database, recovery: RecoveryService;
    let tenantId: string,
      foreignId: string,
      slug: string,
      foreignSlug: string,
      passwordHash: string;
    const key = process.env.MFA_ENCRYPTION_KEY;
    const ip = `recovery-${randomUUID()}`;
    const request = (body: unknown, source = ip) =>
      ({ body, ip: source, headers: { origin: process.env.APP_ORIGIN } }) as FastifyRequest;
    const fixtures: string[] = [];
    const queueFixtures = new Set<string>();
    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.APP_ORIGIN = "http://localhost:4310";
      process.env.MFA_ENCRYPTION_KEY = "ac".repeat(32);
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
      const { Database } = await import("../dist/database.js");
      const { RecoveryService } = await import("../dist/recovery.js");
      db = new Database();
      db2 = new Database();
      recovery = new RecoveryService(db);
      passwordHash = await hash("Recovery-fixture-password!");
      const tenant = await owner.tenant.create({
        data: { slug: `recovery-${randomUUID()}`, name: "Recovery fixture", brandName: "Fixture" },
      });
      tenantId = tenant.id;
      slug = tenant.slug;
      const foreign = await owner.tenant.create({
        data: { slug: `recovery-${randomUUID()}`, name: "Foreign fixture", brandName: "Fixture" },
      });
      foreignId = foreign.id;
      foreignSlug = foreign.slug;
    });
    afterAll(async () => {
      await db?.$disconnect();
      await db2?.$disconnect();
      if (owner) {
        for (const id of queueFixtures)
          await owner.$executeRaw`DELETE FROM password_recovery_requests WHERE id=${id}::uuid`;
        const requests = await owner.$queryRaw<
          { id: string; encrypted_request: string }[]
        >`SELECT id,encrypted_request FROM password_recovery_requests WHERE encrypted_request IS NOT NULL`;
        const { decryptSecret } = await import("../dist/mfa.js");
        for (const row of requests) {
          try {
            const body = JSON.parse(
              decryptSecret(row.encrypted_request, `recovery-request:${row.id}`),
            );
            if ([slug, foreignSlug].includes(body.organisation))
              await owner.$executeRaw`DELETE FROM password_recovery_requests WHERE id=${row.id}::uuid`;
          } catch {
            /* Other isolated fixtures use independent keys. */
          }
        }
        for (const id of [tenantId, foreignId].filter(Boolean)) {
          await owner.configAudit.deleteMany({ where: { tenantId: id } });
          await owner.session.deleteMany({ where: { tenantId: id } });
          await owner.user.deleteMany({ where: { tenantId: id } });
          await owner.tenant.delete({ where: { id } });
        }
        const { tokenHash } = await import("../dist/auth.js");
        for (const entry of [...fixtures, `forgot:ip:${ip}`, `reset:ip:${ip}`])
          await owner.$executeRaw`DELETE FROM auth_rate_limits WHERE key=${tokenHash(entry)}`;
        await owner.$disconnect();
      }
      if (key === undefined) delete process.env.MFA_ENCRYPTION_KEY;
      else process.env.MFA_ENCRYPTION_KEY = key;
    });
    async function account(extra: Record<string, unknown> = {}) {
      const { encryptSecret } = await import("../dist/mfa.js");
      const id = randomUUID();
      const user = await owner.user.create({
        data: {
          id,
          tenantId,
          name: "Recovery user",
          email: `${id}@test.invalid`,
          role: "admin",
          passwordHash,
          mfaEnrolled: true,
          mfaSecret: encryptSecret("JBSWY3DPEHPK3PXP", `${tenantId}:${id}`),
          ...extra,
        },
      });
      fixtures.push(`forgot:${slug}:${user.email}`);
      return user;
    }
    async function issue(user: Awaited<ReturnType<typeof account>>) {
      await recovery.forgot(request({ organisation: slug, email: user.email }));
      const queued = await queuedRequest(user.email);
      expect(await recovery.processRequest(queued.id)).toBe(true);
      const [row] = await owner.$queryRaw<
        {
          id: string;
          token_hash: string;
          encrypted_url: string;
          status: string;
          attempts: number;
        }[]
      >`SELECT * FROM password_recoveries WHERE tenant_id=${tenantId}::uuid AND user_id=${user.id}::uuid ORDER BY created_at DESC LIMIT 1`;
      const { decryptSecret } = await import("../dist/mfa.js");
      const url = decryptSecret(row!.encrypted_url, `recovery:${tenantId}:${user.id}:${row!.id}`);
      const token = new URLSearchParams(new URL(url).hash.split("?")[1]).get("token")!;
      return { ...row!, token };
    }
    async function queuedRequest(email: string) {
      const rows = await owner.$queryRaw<
        { id: string; encrypted_request: string }[]
      >`SELECT id,encrypted_request FROM password_recovery_requests WHERE status='pending' AND encrypted_request IS NOT NULL`;
      const { decryptSecret } = await import("../dist/mfa.js");
      const found = rows.find((row) => {
        try {
          const body = JSON.parse(
            decryptSecret(row.encrypted_request, `recovery-request:${row.id}`),
          );
          return body.organisation === slug && body.email === email;
        } catch {
          return false;
        }
      });
      if (!found) throw new Error("Missing fixture request");
      queueFixtures.add(found.id);
      return found;
    }
    it("acknowledges unknown/inactive accounts generically and persists only hashed/encrypted recovery tokens", async () => {
      const inactive = await account({ active: false });
      const active = await account();
      const unknown = `${randomUUID()}@test.invalid`;
      fixtures.push(`forgot:${slug}:${unknown}`);
      expect(await recovery.forgot(request({ organisation: slug, email: unknown }))).toEqual({
        ok: true,
      });
      expect(await recovery.forgot(request({ organisation: slug, email: inactive.email }))).toEqual(
        { ok: true },
      );
      for (const email of [unknown, inactive.email]) {
        const queued = await queuedRequest(email);
        expect(queued.encrypted_request).not.toContain(email);
        expect(await recovery.processRequest(queued.id)).toBe(true);
      }
      await expect(db.$queryRaw`SELECT * FROM password_recovery_requests`).rejects.toThrow();
      expect(
        await owner.$queryRaw`SELECT id FROM password_recoveries WHERE user_id=${inactive.id}::uuid`,
      ).toEqual([]);
      const item = await issue(active);
      const { tokenHash } = await import("../dist/auth.js");
      expect(item.token).toHaveLength(43);
      expect(item.token_hash).toBe(tokenHash(item.token));
      expect(item.encrypted_url).not.toContain(item.token);
      await expect(db.$queryRaw`SELECT * FROM password_recoveries`).resolves.toEqual([]);
      await expect(
        db.withTenant(
          foreignId,
          (tx) => tx.$queryRaw`SELECT * FROM password_recoveries WHERE user_id=${active.id}::uuid`,
        ),
      ).resolves.toEqual([]);
      await expect(
        db.withTenant(
          foreignId,
          (tx) =>
            tx.$executeRaw`INSERT INTO password_recoveries(id,tenant_id,user_id,token_hash,password_hash,email,expires_at) VALUES(${randomUUID()}::uuid,${foreignId}::uuid,${active.id}::uuid,${randomUUID()},'!','x@test.invalid',now())`,
        ),
      ).rejects.toThrow();
    });
    it("rejects wrong-tenant, superseded, expired and account-changed links without changing credentials", async () => {
      const user = await account();
      const first = await issue(user);
      const second = await issue(user);
      for (const body of [
        { organisation: foreignSlug, token: second.token },
        { organisation: slug, token: first.token },
      ])
        await expect(
          recovery.reset(request({ ...body, password: "Changed-fixture-password!" })),
        ).rejects.toThrow("invalid or expired");
      await owner.$executeRaw`UPDATE password_recoveries SET expires_at=now()-interval '1 second' WHERE id=${second.id}::uuid`;
      await expect(
        recovery.reset(
          request({
            organisation: slug,
            token: second.token,
            password: "Changed-fixture-password!",
          }),
        ),
      ).rejects.toThrow("invalid or expired");
      const changed = await account();
      const link = await issue(changed);
      await owner.user.update({
        where: { id: changed.id },
        data: { email: `changed-${changed.email}` },
      });
      await expect(
        recovery.reset(
          request({ organisation: slug, token: link.token, password: "Changed-fixture-password!" }),
        ),
      ).rejects.toThrow("invalid or expired");
      expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(
        passwordHash,
      );
    });
    it("acknowledges known/unknown requests without acquiring the tenant lock and processes committed requests once across workers", async () => {
      const user = await account(),
        unknown = `queued-${randomUUID()}@test.invalid`;
      fixtures.push(`forgot:${slug}:${unknown}`);
      const { lockConfiguration } = await import("../dist/database.js");
      await owner.$transaction(
        async (tx) => {
          await lockConfiguration(tx, tenantId);
          expect(await recovery.forgot(request({ organisation: slug, email: user.email }))).toEqual(
            { ok: true },
          );
          expect(await recovery.forgot(request({ organisation: slug, email: unknown }))).toEqual({
            ok: true,
          });
          expect(
            await tx.$queryRaw`SELECT id FROM password_recoveries WHERE user_id=${user.id}::uuid`,
          ).toEqual([]);
        },
        { timeout: 5000 },
      );
      const known = await queuedRequest(user.email),
        absent = await queuedRequest(unknown);
      const { RecoveryService } = await import("../dist/recovery.js");
      expect(
        await Promise.all([
          recovery.processRequest(known.id),
          new RecoveryService(db2).processRequest(known.id),
        ]),
      ).toEqual([true, true]);
      expect(
        await owner.$queryRaw<
          { id: string }[]
        >`SELECT id FROM password_recoveries WHERE user_id=${user.id}::uuid`,
      ).toHaveLength(1);
      expect(await recovery.processRequest(absent.id)).toBe(true);
      const rows = await owner.$queryRaw<
        { encrypted_request: string | null; status: string }[]
      >`SELECT encrypted_request,status FROM password_recovery_requests WHERE id IN (${known.id}::uuid,${absent.id}::uuid)`;
      expect(
        rows.every((row) => row.encrypted_request === null && row.status === "completed"),
      ).toBe(true);
    });
    it("persists request processing failures for bounded retry and expires queued ciphertext", async () => {
      const user = await account();
      await recovery.forgot(request({ organisation: slug, email: user.email }));
      const queued = await queuedRequest(user.email);
      await owner.$executeRaw`UPDATE password_recovery_requests SET encrypted_request='corrupt-fixture' WHERE id=${queued.id}::uuid`;
      expect(await recovery.processRequest(queued.id)).toBe(false);
      const [failed] = await owner.$queryRaw<
        { attempts: number; status: string }[]
      >`SELECT * FROM password_recovery_requests WHERE id=${queued.id}::uuid`;
      expect(failed!.attempts).toBe(1);
      expect(failed!.status).toBe("pending");
      await owner.$executeRaw`UPDATE password_recovery_requests SET encrypted_request=${queued.encrypted_request},next_attempt_at=now() WHERE id=${queued.id}::uuid`;
      const { RecoveryService } = await import("../dist/recovery.js");
      expect(await new RecoveryService(db2).processRequest(queued.id)).toBe(true);
      expect(
        await owner.$queryRaw<
          { id: string }[]
        >`SELECT id FROM password_recoveries WHERE user_id=${user.id}::uuid`,
      ).toHaveLength(1);
      const expired = randomUUID();
      queueFixtures.add(expired);
      await db.$executeRaw`SELECT enqueue_password_recovery(${expired}::uuid,'fixture-expired-ciphertext')`;
      await owner.$executeRaw`UPDATE password_recovery_requests SET expires_at=now()-interval '1 second' WHERE id=${expired}::uuid`;
      expect(await recovery.processRequest(expired)).toBe(true);
      await db.$executeRaw`SELECT purge_expired_recovery_requests()`;
      expect(
        await owner.$queryRaw`SELECT id FROM password_recovery_requests WHERE id=${expired}::uuid`,
      ).toEqual([]);
    });
    it("consumes exactly once across instances, revokes sessions and preserves enrolled MFA", async () => {
      const user = await account();
      const link = await issue(user);
      await owner.session.create({
        data: {
          tenantId,
          userId: user.id,
          tokenHash: randomUUID(),
          csrfToken: randomUUID(),
          mfaVerified: true,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const { RecoveryService } = await import("../dist/recovery.js");
      const other = new RecoveryService(db2);
      const body = { organisation: slug, token: link.token, password: "Changed-fixture-password!" };
      const results = await Promise.allSettled([
        recovery.reset(request(body)),
        other.reset(request(body)),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      await expect(recovery.reset(request(body))).rejects.toThrow("invalid or expired");
      const changed = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(await verify(changed.passwordHash, body.password)).toBe(true);
      expect(changed.mfaSecret).toBe(user.mfaSecret);
      expect(changed.mfaEnrolled).toBe(true);
      expect(await owner.session.count({ where: { userId: user.id } })).toBe(0);
      const [stored] = await owner.$queryRaw<
        { encrypted_url: string | null; used_at: Date | null }[]
      >`SELECT * FROM password_recoveries WHERE id=${link.id}::uuid`;
      expect(stored!.encrypted_url).toBeNull();
      expect(stored!.used_at).not.toBeNull();
      const audits = await owner.configAudit.findMany({ where: { tenantId, entityId: user.id } });
      expect(audits.some((row) => row.action === "user.password_recovered")).toBe(true);
      expect(JSON.stringify(audits)).not.toContain(link.token);
      expect(JSON.stringify(audits)).not.toContain(body.password);
    });
    it("retries a durable mail failure after a new mailer instance and serializes duplicate delivery", async () => {
      const user = await account();
      const link = await issue(user);
      const saved = {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        from: process.env.SMTP_FROM,
      };
      const { RecoveryMailer } = await import("../dist/recovery-mail.js");
      let delivered = 0;
      const server = createServer((socket) => {
        socket.write("220 fixture ESMTP\r\n");
        let buffer = "",
          data = false;
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          let newline: number;
          while ((newline = buffer.indexOf("\r\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 2);
            if (data) {
              if (line === ".") {
                data = false;
                delivered++;
                socket.write("250 queued\r\n");
              }
            } else if (line.startsWith("EHLO") || line.startsWith("HELO"))
              socket.write("250 fixture\r\n");
            else if (line === "DATA") {
              data = true;
              socket.write("354 continue\r\n");
            } else if (line === "QUIT") {
              socket.end("221 bye\r\n");
            } else socket.write("250 OK\r\n");
          }
        });
      });
      try {
        process.env.SMTP_HOST = "127.0.0.1";
        process.env.SMTP_PORT = "1";
        process.env.SMTP_FROM = "desk@test.invalid";
        await new RecoveryMailer(db).deliver(tenantId, link.id);
        const [failed] = await owner.$queryRaw<
          { status: string; attempts: number; encrypted_url: string | null }[]
        >`SELECT * FROM password_recoveries WHERE id=${link.id}::uuid`;
        expect(failed!.status).toBe("pending");
        expect(failed!.attempts).toBe(1);
        expect(failed!.encrypted_url).not.toBeNull();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("SMTP fixture missing");
        process.env.SMTP_PORT = String(address.port);
        await owner.$executeRaw`UPDATE password_recoveries SET next_attempt_at=now() WHERE id=${link.id}::uuid`;
        await Promise.all([
          new RecoveryMailer(db).deliver(tenantId, link.id),
          new RecoveryMailer(db2).deliver(tenantId, link.id),
        ]);
        expect(delivered).toBe(1);
        const [sent] = await owner.$queryRaw<
          { status: string; attempts: number; encrypted_url: string | null }[]
        >`SELECT * FROM password_recoveries WHERE id=${link.id}::uuid`;
        expect(sent!.status).toBe("sent");
        expect(sent!.attempts).toBe(2);
        expect(sent!.encrypted_url).toBeNull();
      } finally {
        for (const [name, value] of Object.entries({
          SMTP_HOST: saved.host,
          SMTP_PORT: saved.port,
          SMTP_FROM: saved.from,
        }))
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      }
    });
    it.skipIf(!process.env.SMTP_HOST || !process.env.MAILPIT_URL)(
      "delivers a queued recovery through Docker SMTP and erases its encrypted URL",
      async () => {
        const user = await account(),
          link = await issue(user);
        const { RecoveryMailer } = await import("../dist/recovery-mail.js");
        await new RecoveryMailer(db).deliver(tenantId, link.id);
        const [stored] = await owner.$queryRaw<
          { status: string; encrypted_url: string | null }[]
        >`SELECT status,encrypted_url FROM password_recoveries WHERE id=${link.id}::uuid`;
        expect(stored!.status).toBe("sent");
        expect(stored!.encrypted_url).toBeNull();
        const mailbox = (await fetch(
          `${process.env.MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${user.email}`)}`,
        ).then((response) => response.json())) as { messages: { ID: string }[] };
        expect(mailbox.messages).toHaveLength(1);
        const message = (await fetch(
          `${process.env.MAILPIT_URL}/api/v1/message/${mailbox.messages[0]!.ID}`,
        ).then((response) => response.json())) as { Text: string };
        expect(message.Text.includes(link.token)).toBe(true);
        expect(message.Text).toContain("Your authenticator remains required");
      },
    );
    it("enforces shared atomic limits and rejects direct infrastructure access", async () => {
      const { reserveAuthAttempt, tokenHash } = await import("../dist/auth.js");
      const key = `fixture:${randomUUID()}`;
      fixtures.push(key);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => reserveAuthAttempt(i % 2 ? db : db2, key, 5)),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
      await expect(db.$queryRaw`SELECT * FROM auth_rate_limits`).rejects.toThrow();
      await expect(db.$queryRaw`SELECT auth_reserve_attempt('not-a-digest',5)`).rejects.toThrow();
      await owner.$executeRaw`UPDATE auth_rate_limits SET expires_at=now()-interval '1 second' WHERE key=${tokenHash(key)}`;
      await expect(reserveAuthAttempt(db2, key, 5)).resolves.toBeUndefined();
    });
    it("throttles concurrent password-login failures across two AuthService instances before credential work", async () => {
      const { AuthService } = await import("../dist/auth.js");
      const a = new AuthService(db),
        b = new AuthService(db2);
      const organisation = `missing-${randomUUID()}`,
        source = `login-${randomUUID()}`,
        email = "unknown@test.invalid";
      fixtures.push(`login:${organisation}:${email}`, `login:ip:${source}`);
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          (i % 2 ? a : b).login(
            request({ organisation, email, password: "incorrect-password" }, source),
            {} as FastifyReply,
          ),
        ),
      );
      const statuses = results.map((result) =>
        result.status === "rejected" ? result.reason.getStatus() : 0,
      );
      expect(statuses.filter((status) => status === 401)).toHaveLength(5);
      expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    });
    it("rejects a blocked source IP before allocating a random account limiter key", async () => {
      const { AuthService, tokenHash } = await import("../dist/auth.js");
      const source = `blocked-${randomUUID()}`,
        organisation = `absent-${randomUUID()}`,
        email = "absent@test.invalid";
      const ipKey = `login:ip:${source}`,
        accountKey = `login:${organisation}:${email}`;
      fixtures.push(ipKey, accountKey);
      await owner.$executeRaw`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES(${tokenHash(ipKey)},30,now()+interval '15 minutes')`;
      await expect(
        new AuthService(db).login(
          request({ organisation, email, password: "incorrect-password" }, source),
          {} as FastifyReply,
        ),
      ).rejects.toThrow("temporarily limited");
      expect(
        await owner.$queryRaw`SELECT key FROM auth_rate_limits WHERE key=${tokenHash(accountKey)}`,
      ).toEqual([]);
    });
    it("rejects an old-email sign-in whose lookup raced an administrator email change", async () => {
      const { AuthService } = await import("../dist/auth.js");
      const { Database, lockConfiguration } = await import("../dist/database.js");
      const user = await account({ role: "employee", mfaEnrolled: false, mfaSecret: null }),
        lockName = `configuration:${tenantId}`;
      const isolated = new Database();
      const auth = new AuthService(isolated),
        source = `login-race-${randomUUID()}`;
      fixtures.push(`login:${slug}:${user.email}`, `login:ip:${source}`);
      let attempt: Promise<{ getStatus: () => number }> | undefined;
      try {
        await owner.$transaction(
          async (tx) => {
            await lockConfiguration(tx, tenantId);
            attempt = auth
              .login(
                request(
                  { organisation: slug, email: user.email, password: "Recovery-fixture-password!" },
                  source,
                ),
                { setCookie: () => undefined } as unknown as FastifyReply,
              )
              .then(
                () => ({ getStatus: () => 201 }),
                (error) => error,
              );
            const deadline = Date.now() + 5000;
            let waiting = false;
            while (Date.now() < deadline) {
              const [state] = await owner.$queryRaw<
                { waiting: boolean }[]
              >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=((hashtextextended(${lockName},0)>>32)&4294967295)::oid AND objid=(hashtextextended(${lockName},0)&4294967295)::oid) AS waiting`;
              if (state?.waiting) {
                waiting = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            expect(waiting).toBe(true);
            await tx.user.update({
              where: { id: user.id },
              data: { email: `changed-${user.email}` },
            });
          },
          { timeout: 10000 },
        );
        expect((await attempt!).getStatus()).toBe(401);
        expect(await owner.session.count({ where: { userId: user.id } })).toBe(0);
      } finally {
        await attempt;
        await isolated.$disconnect();
      }
    }, 15000);
    it("requires same-origin public requests and validates password reset inputs through HTTP", async () => {
      const { createApp } = await import("../dist/main.js");
      const app = await createApp();
      try {
        await app.getHttpAdapter().getInstance().ready();
        const body = { organisation: slug, email: `missing-${randomUUID()}@test.invalid` },
          source = `127.3.${Math.floor(Math.random() * 200) + 1}.2`;
        fixtures.push(`forgot:${slug}:${body.email}`, `forgot:ip:${source}`);
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/auth/forgot-password",
              payload: body,
              headers: { origin: "https://foreign.invalid" },
              remoteAddress: source,
            })
          ).statusCode,
        ).toBe(403);
        const generic = await app.inject({
          method: "POST",
          url: "/api/auth/forgot-password",
          payload: body,
          headers: { origin: process.env.APP_ORIGIN! },
          remoteAddress: source,
        });
        expect(generic.statusCode).toBe(201);
        expect(generic.json()).toEqual({ ok: true });
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/auth/reset-password",
              payload: { organisation: slug, token: "invalid", password: "short" },
              headers: { origin: process.env.APP_ORIGIN! },
              remoteAddress: source,
            })
          ).statusCode,
        ).toBe(400);
      } finally {
        await app.close();
      }
    });
    it("requires verified explicit operator input and owner access, audits MFA recovery, and defaults to dry-run", async () => {
      const { recoverLostMfa } = await import("../dist/recovery.js");
      const user = await account();
      const input = {
        organisation: slug,
        userId: user.id,
        operator: "fixture operator",
        reason: "Fixture lost authenticator rehearsal",
        verificationEvidence: "Restricted fixture case REF-123, verified independently",
      };
      await expect(recoverLostMfa(db, input, true)).rejects.toThrow("owner");
      await expect(
        recoverLostMfa(owner, { ...input, verificationEvidence: "" }, true),
      ).rejects.toThrow();
      await expect(
        recoverLostMfa(owner, { ...input, organisation: foreignSlug }, true),
      ).rejects.toThrow("not found");
      expect((await recoverLostMfa(owner, input)).applied).toBe(false);
      expect((await owner.user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnrolled).toBe(
        true,
      );
      await owner.session.create({
        data: {
          tenantId,
          userId: user.id,
          tokenHash: randomUUID(),
          csrfToken: randomUUID(),
          mfaVerified: true,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await recoverLostMfa(owner, input, true);
      const changed = await owner.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(changed.mfaEnrolled).toBe(false);
      expect(changed.mfaSecret).toBeNull();
      expect(changed.passwordHash).toBe(user.passwordHash);
      expect(await owner.session.count({ where: { userId: user.id } })).toBe(0);
      const audit = await owner.configAudit.findFirstOrThrow({
        where: { tenantId, entityId: user.id, action: "mfa.operator_recovery" },
      });
      expect(audit.detail).toEqual({
        operator: input.operator,
        reason: input.reason,
        verificationEvidence: input.verificationEvidence,
      });
    });
  },
);
