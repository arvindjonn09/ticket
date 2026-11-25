import {
  CanActivate,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { generateSecret } from "otplib";
import { argon2id, hash, verify } from "argon2";
import { z } from "zod";
import { Database, type Tx } from "./database.js";
import { decryptSecret, encryptSecret, verifyTotp } from "./mfa.js";
import { classifyHost, platformMode } from "./platform.js";
import { reserveAuthAttempt, tokenHash } from "./modules/auth/auth.service.js";

const cookieName = "astrama_operator_session";
const idleMillis = 15 * 60000;
const pendingMillis = 10 * 60000;
const absoluteMillis = 12 * 3600000;
const mfaExemptRoutes = [
  "/api/operator/auth/session",
  "/api/operator/auth/logout",
  "/api/operator/auth/mfa/setup",
  "/api/operator/auth/mfa/verify",
];
const loginSchema = z
  .object({
    email: z.string().trim().max(254).email(),
    password: z.string().min(1).max(256),
  })
  .strict();
const mfaVerifySchema = z.object({ code: z.string().min(6).max(8) }).strict();

export type OperatorSessionContext = {
  id: string;
  name: string;
  email: string;
  role: "support" | "owner";
  sessionId: string;
  csrfToken: string;
  mfaVerified: boolean;
  mfaEnrolled: boolean;
};
export type OperatorRequest = FastifyRequest & { operator: OperatorSessionContext };
type OperatorRow = {
  id: string;
  name: string;
  email: string;
  role: "support" | "owner";
  active: boolean;
  password_hash: string;
  encrypted_mfa_secret: string | null;
  mfa_enrolled: boolean;
  mfa_last_step: number;
  mfa_failures: number;
  mfa_locked_until: Date | null;
  mfa_pending_session_id: string | null;
  mfa_pending_expires_at: Date | null;
};

export function operatorOrigin(env: NodeJS.ProcessEnv = process.env) {
  return env.OPERATOR_ORIGIN ?? null;
}
let allowlistCache: { raw: string; value: BlockList | null | false } | undefined;
/** Invalid allowlist configuration denies every address (fail closed). */
export function operatorIpAllowed(ip: string, env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPERATOR_IP_ALLOWLIST ?? "";
  if (!raw.trim()) return true;
  if (allowlistCache?.raw !== raw) {
    const list = new BlockList();
    try {
      for (const entry of raw.split(",")) {
        const value = entry.trim();
        if (!value) continue;
        const slash = value.indexOf("/");
        if (slash < 0) {
          const kind = isIP(value);
          if (!kind) throw new Error("invalid address");
          list.addAddress(value, kind === 6 ? "ipv6" : "ipv4");
        } else {
          const prefix = value.slice(0, slash);
          const bits = value.slice(slash + 1);
          const kind = isIP(prefix);
          if (!kind || !/^\d{1,3}$/.test(bits)) throw new Error("invalid subnet");
          list.addSubnet(prefix, Number(bits), kind === 6 ? "ipv6" : "ipv4");
        }
      }
      allowlistCache = { raw, value: list };
    } catch {
      allowlistCache = { raw, value: false };
    }
  }
  const value = allowlistCache.value;
  if (value === false) return false;
  const normalized = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  return value === null || value.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4");
}

@Injectable()
export class OperatorAuthService {
  private readonly dummy = hash(randomBytes(32), { type: argon2id });
  constructor(private readonly db: Database) {}
  checkHost(request: FastifyRequest) {
    if (platformMode() !== "hosted" || classifyHost(request.headers.host).kind !== "operator")
      throw new ForbiddenException("Operator console required");
  }
  checkOrigin(request: FastifyRequest) {
    const expected = operatorOrigin();
    if (!expected || request.headers.origin !== expected)
      throw new ForbiddenException("Invalid request origin");
  }
  private view(auth: OperatorSessionContext) {
    return {
      operator: { id: auth.id, name: auth.name, email: auth.email, role: auth.role },
      csrfToken: auth.csrfToken,
      mfaVerified: auth.mfaVerified,
      mfaEnrolled: auth.mfaEnrolled,
    };
  }
  private audit(
    tx: Pick<Database, "$executeRaw">,
    operatorId: string,
    action: string,
    tenantId: string | null = null,
  ) {
    return tx.$executeRaw`INSERT INTO operator_audits(id,operator_id,tenant_id,action,reason,detail)
      VALUES(${randomUUID()}::uuid,${operatorId}::uuid,${tenantId}::uuid,${action},'Authentication','{}'::jsonb)`;
  }
  async login(request: FastifyRequest, reply: FastifyReply) {
    this.checkHost(request);
    this.checkOrigin(request);
    const input = loginSchema.parse(request.body);
    if (!operatorIpAllowed(request.ip))
      throw new ForbiddenException("Operator source address not allowed");
    const email = input.email.toLowerCase();
    await reserveAuthAttempt(this.db, `operator:login:ip:${request.ip}`, 30);
    await reserveAuthAttempt(this.db, `operator:login:${email}`, 5);
    const [row] = await this.db.$queryRaw<
      { id: string; email: string; role: "support" | "owner"; password_hash: string }[]
    >`SELECT id,email,role,password_hash FROM operators WHERE email=${email}`;
    const valid = await verify(row?.password_hash ?? (await this.dummy), input.password);
    if (!row || !valid) throw new UnauthorizedException("Invalid credentials");
    const result = await this.db.$transaction(async (tx) => {
      // Row lock serializes login/MFA per operator; recheck after the Argon2 race.
      const [op] = await tx.$queryRaw<
        OperatorRow[]
      >`SELECT * FROM operators WHERE id=${row.id}::uuid FOR UPDATE`;
      if (
        !op ||
        !op.active ||
        op.email !== row.email ||
        op.password_hash !== row.password_hash ||
        op.role !== row.role
      )
        return null;
      const token = randomBytes(32).toString("base64url");
      const csrf = randomBytes(32).toString("base64url");
      await tx.$executeRaw`INSERT INTO operator_sessions(id,operator_id,token_hash,csrf_token,mfa_verified,expires_at)
        VALUES(${randomUUID()}::uuid,${op.id}::uuid,${tokenHash(token)},${csrf},false,${new Date(Date.now() + pendingMillis)})`;
      await this.audit(tx, op.id, "auth.login");
      return { op, token, csrf };
    });
    if (!result) throw new UnauthorizedException("Invalid credentials");
    await this.db
      .$executeRaw`SELECT auth_release_attempt(${tokenHash(`operator:login:${email}`)},true),auth_release_attempt(${tokenHash(`operator:login:ip:${request.ip}`)},false)`;
    const origin = operatorOrigin()!;
    reply.setCookie(cookieName, result.token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: origin.startsWith("https:"),
      maxAge: pendingMillis / 1000,
    });
    return this.view({
      id: result.op.id,
      name: result.op.name,
      email: result.op.email,
      role: result.op.role,
      sessionId: "",
      csrfToken: result.csrf,
      mfaVerified: false,
      mfaEnrolled: result.op.mfa_enrolled,
    });
  }
  async authenticate(request: FastifyRequest): Promise<OperatorSessionContext> {
    this.checkHost(request);
    if (!operatorIpAllowed(request.ip))
      throw new ForbiddenException("Operator source address not allowed");
    const token = request.cookies?.[cookieName];
    if (!token || token.length > 128) throw new UnauthorizedException("Operator sign in required");
    // Atomic revalidation: an expired, idle-expired or deactivated session cannot be revived.
    const [row] = await this.db.$queryRaw<
      {
        session_id: string;
        csrf_token: string;
        mfa_verified: boolean;
        id: string;
        name: string;
        email: string;
        role: "support" | "owner";
        mfa_enrolled: boolean;
      }[]
    >`UPDATE operator_sessions s SET last_seen_at=clock_timestamp()
      FROM operators o
      WHERE s.token_hash=${tokenHash(token)} AND o.id=s.operator_id AND o.active
        AND s.expires_at>clock_timestamp() AND s.last_seen_at>clock_timestamp()-${`${idleMillis / 1000} seconds`}::interval
      RETURNING s.id AS session_id,s.csrf_token,s.mfa_verified,o.id,o.name,o.email,o.role,o.mfa_enrolled`;
    if (!row) throw new UnauthorizedException("Operator session expired. Sign in again.");
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      sessionId: row.session_id,
      csrfToken: row.csrf_token,
      mfaVerified: row.mfa_verified,
      mfaEnrolled: row.mfa_enrolled,
    };
  }
  session(request: OperatorRequest) {
    return this.view(request.operator);
  }
  private async lockOperator(tx: Tx, auth: OperatorSessionContext) {
    const [operator] = await tx.$queryRaw<
      OperatorRow[]
    >`SELECT * FROM operators WHERE id=${auth.id}::uuid FOR UPDATE`;
    const [session] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM operator_sessions WHERE id=${auth.sessionId}::uuid AND operator_id=${auth.id}::uuid
        AND expires_at>now() AND last_seen_at>now()-interval '15 minutes' FOR UPDATE`;
    return operator?.active && session ? operator : null;
  }
  async logout(request: OperatorRequest, reply: FastifyReply) {
    const auth = request.operator;
    await this.db.$executeRaw`DELETE FROM operator_sessions WHERE id=${auth.sessionId}::uuid`;
    await this.audit(this.db, auth.id, "auth.logout");
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  }
  async setupMfa(auth: OperatorSessionContext) {
    const secret = await this.db.$transaction(async (tx) => {
      const op = await this.lockOperator(tx, auth);
      if (!op || !op.active)
        throw new UnauthorizedException("Operator session expired. Sign in again.");
      if (op.mfa_enrolled) throw new ConflictException("MFA is already enrolled");
      if (op.mfa_locked_until && op.mfa_locked_until.getTime() > Date.now())
        throw new HttpException("MFA temporarily limited. Try again shortly.", 429);
      const value = generateSecret();
      await tx.$executeRaw`UPDATE operators SET encrypted_mfa_secret=${encryptSecret(value, `operator:${op.id}`)},mfa_pending_session_id=${auth.sessionId}::uuid,mfa_pending_expires_at=${new Date(Date.now() + pendingMillis)} WHERE id=${op.id}::uuid`;
      return value;
    });
    return {
      secret,
      uri: `otpauth://totp/${encodeURIComponent(`Astrama Operator:${auth.email}`)}?secret=${secret}&issuer=${encodeURIComponent("Astrama Operator")}&algorithm=SHA1&digits=6&period=30`,
    };
  }
  async verifyMfa(auth: OperatorSessionContext, body: unknown) {
    const input = mfaVerifySchema.parse(body);
    const result = await this.db.$transaction(async (tx) => {
      const op = await this.lockOperator(tx, auth);
      if (!op || !op.active) return "invalid";
      if (
        !op.mfa_enrolled &&
        (op.mfa_pending_session_id !== auth.sessionId ||
          !op.mfa_pending_expires_at ||
          op.mfa_pending_expires_at.getTime() <= Date.now())
      )
        return "invalid";
      if (op.mfa_locked_until && op.mfa_locked_until.getTime() > Date.now()) return "locked";
      const step = op.encrypted_mfa_secret
        ? verifyTotp(
            decryptSecret(op.encrypted_mfa_secret, `operator:${op.id}`),
            input.code,
            op.mfa_last_step,
          )
        : null;
      if (step === null) {
        // Counters/lockout are committed even though the request reports failure.
        const failures = op.mfa_failures + 1;
        await tx.$executeRaw`UPDATE operators SET mfa_failures=${failures},mfa_locked_until=${failures >= 5 ? new Date(Date.now() + Math.min(900000, 30000 * 2 ** Math.min(failures - 5, 5))) : null} WHERE id=${op.id}::uuid`;
        return "invalid";
      }
      await tx.$executeRaw`UPDATE operators SET mfa_last_step=${step},mfa_failures=0,mfa_locked_until=NULL,
        mfa_enrolled=true,mfa_pending_session_id=NULL,mfa_pending_expires_at=NULL WHERE id=${op.id}::uuid`;
      await tx.$executeRaw`UPDATE operator_sessions SET mfa_verified=true,
        expires_at=created_at+interval '12 hours' WHERE id=${auth.sessionId}::uuid`;
      await this.audit(tx, op.id, op.mfa_enrolled ? "auth.mfa_verified" : "auth.mfa_enrolled");
      return true;
    });
    if (typeof result === "string")
      throw result === "locked"
        ? new HttpException("MFA temporarily limited. Try again shortly.", 429)
        : new UnauthorizedException("Invalid or already used authenticator code");
    return this.view({ ...auth, mfaVerified: true, mfaEnrolled: true });
  }
}

@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly auth: OperatorAuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const route = request.url.split("?")[0]!;
    this.auth.checkHost(request);
    if (route === "/api/operator/auth/login") return true;
    const operator = await this.auth.authenticate(request);
    (request as OperatorRequest).operator = operator;
    if (!operator.mfaVerified && !mfaExemptRoutes.includes(route))
      throw new ForbiddenException("Verify your authenticator first");
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      this.auth.checkOrigin(request);
      const supplied = request.headers["x-csrf-token"];
      const expected = operator.csrfToken;
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

@Controller("operator/auth")
@UseGuards(OperatorGuard)
export class OperatorAuthController {
  constructor(private readonly auth: OperatorAuthService) {}
  @Post("login")
  login(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.login(request, reply);
  }
  @Get("session")
  session(@Req() request: OperatorRequest) {
    return this.auth.session(request);
  }
  @Post("logout")
  logout(@Req() request: OperatorRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.auth.logout(request, reply);
  }
  @Post("mfa/setup")
  setup(@Req() request: OperatorRequest) {
    return this.auth.setupMfa(request.operator);
  }
  @Post("mfa/verify")
  async verify(@Req() request: OperatorRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const view = await this.auth.verifyMfa(request.operator, request.body);
    reply.setCookie(cookieName, request.cookies[cookieName]!, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: operatorOrigin()!.startsWith("https:"),
      maxAge: absoluteMillis / 1000,
    });
    return view;
  }
}
