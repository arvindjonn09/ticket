import {
  CanActivate,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify, argon2id } from "argon2";
import { loginSchema, mfaVerifySchema, type SessionView } from "@astrama/contracts";
import type { Actor } from "@astrama/domain";
import { Database, lockConfiguration, type Tx } from "../../database.js";
import { base32, decryptSecret, encryptSecret, verifyTotp } from "../../mfa.js";
export type AuthContext = Actor & { sessionId: string; view: SessionView };
export type AuthRequest = FastifyRequest & { auth: AuthContext };
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function reserveAuthAttempt(db: Database, key: string, maximum: number) {
  const [result] = await db.$queryRaw<
    { accepted: boolean }[]
  >`SELECT auth_reserve_attempt(${tokenHash(key)},${maximum}::integer) AS accepted`;
  if (!result?.accepted)
    throw new HttpException("Sign-in temporarily limited. Try again shortly.", 429);
}
type AuthRow = {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  role: "employee" | "agent" | "admin";
  tenant_name: string;
  slug: string;
  brand_name: string;
  password_hash?: string;
  session_id?: string;
  csrf_token?: string;
  department_ids: string[];
  mfa_verified?: boolean;
};
const cookieName = "astrama_session";
@Injectable()
export class AuthService {
  private readonly dummy = hash(randomBytes(32), { type: argon2id });
  constructor(private readonly db: Database) {}
  checkOrigin(request: FastifyRequest) {
    if (request.headers.origin !== process.env.APP_ORIGIN)
      throw new ForbiddenException("Invalid request origin");
  }
  async login(request: FastifyRequest, reply: FastifyReply) {
    this.checkOrigin(request);
    const input = loginSchema.parse(request.body);
    const account = `login:${input.organisation.toLowerCase()}:${input.email.toLowerCase()}`;
    const ip = `login:ip:${request.ip}`;
    // Reserve attempts before Argon2/SQL so concurrent bursts cannot bypass limits.
    await reserveAuthAttempt(this.db, ip, 30);
    await reserveAuthAttempt(this.db, account, 5);
    const [row] = await this.db.$queryRaw<
      AuthRow[]
    >`SELECT * FROM auth_login_lookup(${input.organisation.toLowerCase()}, ${input.email.toLowerCase()})`;
    const valid = await verify(row?.password_hash ?? (await this.dummy), input.password);
    if (!row || !valid) throw new UnauthorizedException("Invalid organisation or credentials");
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const result = await this.db.withTenant(row.tenant_id, async (tx) => {
      await lockConfiguration(tx, row.tenant_id);
      await this.lockMfa(tx, row.id);
      const user = await tx.user.findUniqueOrThrow({ where: { id: row.id } });
      const tenant = await tx.tenant.findFirst({ where: { id: row.tenant_id, active: true } });
      if (
        !tenant ||
        !user.active ||
        user.email !== row.email ||
        user.passwordHash !== row.password_hash ||
        user.role !== row.role
      )
        throw new UnauthorizedException("Invalid organisation or credentials");
      let verified = false;
      if (row.role === "admin" && user.mfaEnrolled) {
        const status = await this.consumeMfa(tx, user, input.totpCode ?? "");
        if (status !== true) return status;
        verified = true;
      }
      await tx.session.create({
        data: {
          tenantId: row.tenant_id,
          userId: row.id,
          tokenHash: tokenHash(token),
          csrfToken: csrf,
          mfaVerified: verified,
          expiresAt: new Date(Date.now() + 12 * 3600000),
        },
      });
      return verified;
    });
    if (typeof result === "string")
      throw result === "locked"
        ? new HttpException("MFA temporarily limited. Try again shortly.", 429)
        : new UnauthorizedException("Valid authenticator code required");
    await this.db
      .$executeRaw`SELECT auth_release_attempt(${tokenHash(account)},true),auth_release_attempt(${tokenHash(ip)},false)`;
    reply.setCookie(cookieName, token, {
      path: "/api",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 12 * 3600,
    });
    return this.view(
      { ...row, mfa_verified: result },
      csrf,
      await this.tenantSettings(row.tenant_id),
    );
  }
  private tenantSettings(tenantId: string) {
    return this.db.withTenant(tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { timezone: true, locale: true, primaryColour: true },
      }),
    );
  }
  private view(
    row: AuthRow,
    csrf: string,
    settings: { timezone: string; locale: string; primaryColour: string },
  ): SessionView {
    return {
      user: {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        departmentIds: row.department_ids,
      },
      tenant: {
        id: row.tenant_id,
        name: row.tenant_name,
        slug: row.slug,
        brandName: row.brand_name,
        ...settings,
      },
      csrfToken: csrf,
      mfaVerified: row.mfa_verified === true,
    };
  }
  async authenticate(request: FastifyRequest): Promise<AuthContext> {
    const token = request.cookies[cookieName];
    if (!token || token.length > 128) throw new UnauthorizedException("Sign in required");
    const [row] = await this.db.$queryRaw<
      AuthRow[]
    >`SELECT * FROM auth_session_lookup(${tokenHash(token)})`;
    if (!row?.session_id || !row.csrf_token)
      throw new UnauthorizedException("Session expired. Sign in again.");
    const changed = await this.db.withTenant(row.tenant_id, (tx) =>
      tx.session.updateMany({
        where: {
          id: row.session_id!,
          tokenHash: tokenHash(token),
          expiresAt: { gt: new Date() },
          user: { active: true },
        },
        data: { lastSeenAt: new Date() },
      }),
    );
    if (changed.count !== 1) throw new UnauthorizedException("Session expired. Sign in again.");
    return {
      id: row.id,
      tenantId: row.tenant_id,
      role: row.role,
      departmentIds: row.department_ids,
      sessionId: row.session_id,
      view: this.view(row, row.csrf_token, await this.tenantSettings(row.tenant_id)),
    };
  }
  async logout(auth: AuthContext, reply: FastifyReply) {
    await this.db.withTenant(auth.tenantId, (tx) =>
      tx.session.deleteMany({ where: { id: auth.sessionId } }),
    );
    reply.clearCookie(cookieName, { path: "/api" });
    return { ok: true };
  }
  private async lockMfa(tx: Tx, id: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mfa:${id}`}, 0))`;
  }
  private async consumeMfa(
    tx: Tx,
    user: Awaited<ReturnType<Tx["user"]["findUniqueOrThrow"]>>,
    code: string,
  ): Promise<true | "locked" | "invalid"> {
    if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > Date.now()) return "locked";
    const step = user.mfaSecret
      ? verifyTotp(
          decryptSecret(user.mfaSecret, `${user.tenantId}:${user.id}`),
          code,
          user.mfaLastStep,
        )
      : null;
    if (step === null) {
      const failures = user.mfaFailures + 1;
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaFailures: failures,
          mfaLockedUntil:
            failures >= 5
              ? new Date(Date.now() + Math.min(900000, 30000 * 2 ** Math.min(failures - 5, 5)))
              : null,
        },
      });
      return "invalid";
    }
    await tx.user.update({
      where: { id: user.id },
      data: { mfaLastStep: step, mfaFailures: 0, mfaLockedUntil: null },
    });
    return true;
  }
  async setupMfa(auth: AuthContext) {
    if (auth.role !== "admin") throw new ForbiddenException("Administrator required");
    return this.db.withTenant(auth.tenantId, async (tx) => {
      await this.lockMfa(tx, auth.id);
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.id } });
      if (user.mfaEnrolled) throw new ConflictException("MFA is already enrolled");
      if (user.mfaLockedUntil && user.mfaLockedUntil.getTime() > Date.now())
        throw new HttpException("MFA temporarily limited. Try again shortly.", 429);
      const secret = base32(randomBytes(20));
      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaSecret: encryptSecret(secret, `${auth.tenantId}:${auth.id}`),
          mfaPendingSessionId: auth.sessionId,
          mfaPendingExpiresAt: new Date(Date.now() + 600000),
        },
      });
      const issuer = `${auth.view.tenant.brandName} (${auth.view.tenant.slug})`;
      return {
        secret,
        uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
      };
    });
  }
  async verifyMfa(auth: AuthContext, body: unknown) {
    if (auth.role !== "admin") throw new ForbiddenException("Administrator required");
    const input = mfaVerifySchema.parse(body);
    const result = await this.db.withTenant(auth.tenantId, async (tx) => {
      await this.lockMfa(tx, auth.id);
      const user = await tx.user.findUniqueOrThrow({ where: { id: auth.id } });
      if (
        !user.mfaEnrolled &&
        (user.mfaPendingSessionId !== auth.sessionId ||
          !user.mfaPendingExpiresAt ||
          user.mfaPendingExpiresAt.getTime() < Date.now())
      )
        return "invalid";
      const status = await this.consumeMfa(tx, user, input.code);
      if (status !== true) return status;
      await tx.user.update({
        where: { id: auth.id },
        data: { mfaEnrolled: true, mfaPendingSessionId: null, mfaPendingExpiresAt: null },
      });
      await tx.session.update({ where: { id: auth.sessionId }, data: { mfaVerified: true } });
      if (!user.mfaEnrolled)
        await tx.configAudit.create({
          data: {
            tenantId: auth.tenantId,
            actorId: auth.id,
            entityId: auth.id,
            action: "mfa.enrolled",
            detail: {},
          },
        });
      return true;
    });
    if (result !== true)
      throw result === "locked"
        ? new HttpException("MFA temporarily limited. Try again shortly.", 429)
        : new UnauthorizedException("Invalid or already used authenticator code");
    return { ...auth.view, mfaVerified: true };
  }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.auth = await this.auth.authenticate(request);
    if (
      request.auth.role === "admin" &&
      !request.auth.view.mfaVerified &&
      ![
        "/api/auth/session",
        "/api/auth/logout",
        "/api/auth/mfa/setup",
        "/api/auth/mfa/verify",
      ].includes(request.url.split("?")[0]!)
    )
      throw new ForbiddenException("Verify administrator MFA first");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      this.auth.checkOrigin(request);
      const supplied = request.headers["x-csrf-token"];
      const expected = request.auth.view.csrfToken;
      if (
        typeof supplied !== "string" ||
        Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      )
        throw new ForbiddenException("Invalid CSRF token");
    }
    return true;
  }
}
