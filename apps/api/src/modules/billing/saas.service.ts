import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Post,
  Query,
  UseGuards,
  Body,
  Headers,
  Req,
} from "@nestjs/common";
import { hash, argon2id } from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createTransport } from "nodemailer";
import { createChallenge, verifySolution } from "altcha-lib/v1";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { SessionGuard, type AuthRequest } from "../auth/auth.service.js";
import { Database } from "../../database.js";
import { encryptSecret, decryptSecret } from "../../mfa.js";
import { paymentProvider, type BillingEvent } from "./payment-provider.js";
import { platformMode, tenantOrigin, validTenantSlug } from "../../platform.js";

const signupSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
      .refine(validTenantSlug),
    companyName: z.string().trim().min(1).max(120),
    adminName: z.string().trim().min(1).max(120),
    adminEmail: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    timezone: z.string().trim().min(1).max(100),
    planId: z.string().trim().min(1).max(80).optional(),
    captcha: z.string().min(1).max(12000),
  })
  .strict();
const tokenSchema = z.object({ token: z.string().min(32).max(256) }).strict();

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; meta?: { code?: unknown } };
  return value.code === "23505" || value.meta?.code === "23505" || value.code === "P2002";
}

@Injectable()
export class SaasService {
  private readonly mail = createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.NODE_ENV === "production" && process.env.SMTP_SECURE !== "true",
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
      : {}),
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 5000,
  });

  constructor(private readonly db: Database) {}

  private captchaTestMode() {
    return process.env.CAPTCHA_MODE === "test" && process.env.NODE_ENV !== "production";
  }

  async captchaChallenge() {
    if (this.captchaTestMode()) return { mode: "test", token: "test-valid" };
    const secret = process.env.CAPTCHA_HMAC_SECRET;
    if (!secret) throw new HttpException("Signup is temporarily unavailable", 503);
    return createChallenge({ hmacKey: secret, maxNumber: 100_000, saltLength: 16 });
  }

  private async verifyCaptcha(payload: string) {
    if (this.captchaTestMode()) {
      if (payload === "test-valid") return;
      throw new BadRequestException("Complete the CAPTCHA challenge to continue.");
    }
    const secret = process.env.CAPTCHA_HMAC_SECRET;
    if (!secret) throw new HttpException("Signup is temporarily unavailable", 503);
    let verified = false;
    try {
      verified = await verifySolution(payload, secret);
    } catch {
      verified = false;
    }
    if (!verified) throw new BadRequestException("Complete the CAPTCHA challenge to continue.");
  }

  async signupPlans() {
    return this.db.billingPlan.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, billingInterval: true },
    });
  }

  async slugAvailable(slug: string) {
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(slug) || !validTenantSlug(slug)) return false;
    const [result] = await this.db.$queryRaw<{ available: boolean }[]>`
      SELECT public.public_signup_slug_available(${slug}) AS available`;
    return result?.available === true;
  }

  private async limitSignup(ip: string, email: string) {
    const keys = ["ip", "email"].map((kind) =>
      createHash("sha256")
        .update(`${kind}:${kind === "ip" ? ip : email}`)
        .digest("hex"),
    );
    for (const key of keys) {
      const [row] = await this.db.$queryRaw<{ attempts: number }[]>`
        INSERT INTO public.signup_rate_limits(key_hash,attempts,window_started_at)
        VALUES(${key},1,now())
        ON CONFLICT(key_hash) DO UPDATE SET
          attempts=CASE WHEN signup_rate_limits.window_started_at < now()-interval '1 hour' THEN 1 ELSE signup_rate_limits.attempts+1 END,
          window_started_at=CASE WHEN signup_rate_limits.window_started_at < now()-interval '1 hour' THEN now() ELSE signup_rate_limits.window_started_at END
        RETURNING attempts`;
      if ((row?.attempts ?? 99) > 5)
        throw new HttpException("Signup temporarily limited. Try again later.", 429);
    }
  }

  private publicSiteOrigin() {
    const origin = process.env.PUBLIC_SITE_ORIGIN;
    if (!origin) throw new HttpException("Signup is temporarily unavailable", 503);
    return origin;
  }

  async beginSignup(body: unknown, ip: string) {
    if (platformMode() !== "hosted") throw new HttpException("Signup is unavailable", 404);
    const input = signupSchema.parse(body);
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      throw new BadRequestException("timezone must be a valid IANA time zone");
    }
    await this.limitSignup(ip, input.adminEmail);
    const domain = input.adminEmail.split("@")[1]!.toLowerCase(),
      blocked = new Set(
        (process.env.DISPOSABLE_EMAIL_DOMAINS ?? "")
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      );
    if (blocked.has(domain))
      throw new BadRequestException("Use a business email address to sign up.");
    await this.verifyCaptcha(input.captcha);
    if (
      input.planId &&
      !(await this.db.billingPlan.findFirst({
        where: { id: input.planId, active: true },
        select: { id: true },
      }))
    )
      throw new BadRequestException("Choose an available plan.");
    const token = randomBytes(32).toString("base64url"),
      tokenHash = createHash("sha256").update(token).digest("hex"),
      expiresAt = new Date(Date.now() + 24 * 3600000);
    try {
      await this.db.$transaction(async (tx) => {
        const [created] = await tx.$queryRaw<{ id: string }[]>`
          SELECT public.begin_public_signup(
            ${input.slug},${input.companyName},${input.adminName},${input.adminEmail},${input.timezone},
            ${input.planId ?? null},${tokenHash},${expiresAt}::timestamptz
          ) AS id`;
        const id = created?.id;
        if (!id) throw new Error("Signup request was not recorded");
        const verificationUrl = `${this.publicSiteOrigin()}/signup/verify?token=${encodeURIComponent(token)}`,
          identity = `signup-verification:${id}`;
        await tx.publicMailOutbox.create({
          data: {
            recipient: input.adminEmail,
            subject: "Verify your Astrama organisation",
            encryptedUrl: encryptSecret(verificationUrl, identity),
            identity,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("That subdomain is unavailable.");
      throw error;
    }
    return { accepted: true, message: "Check your email to verify your organisation." };
  }

  async resendVerification(body: unknown, ip: string) {
    const input = z
      .object({
        email: z
          .string()
          .email()
          .max(254)
          .transform((value) => value.toLowerCase()),
        captcha: z.string().min(1).max(12000),
      })
      .strict()
      .parse(body);
    await this.limitSignup(ip, input.email);
    await this.verifyCaptcha(input.captcha);
    const request = await this.db.signupRequest.findFirst({
      where: { adminEmail: input.email, verifiedAt: null, verificationExpires: { gt: new Date() } },
    });
    if (request) {
      const token = randomBytes(32).toString("base64url"),
        expiresAt = new Date(Date.now() + 24 * 3600000);
      const identity = `signup-verification:${request.id}`;
      await this.db.$transaction(async (tx) => {
        await tx.signupRequest.update({
          where: { id: request.id },
          data: {
            verificationHash: createHash("sha256").update(token).digest("hex"),
            verificationExpires: expiresAt,
          },
        });
        await tx.publicMailOutbox.updateMany({
          where: { identity, sentAt: null },
          data: { encryptedUrl: null, sentAt: new Date() },
        });
        await tx.publicMailOutbox.create({
          data: {
            recipient: input.email,
            subject: "Verify your Astrama organisation",
            encryptedUrl: encryptSecret(
              `${this.publicSiteOrigin()}/signup/verify?token=${encodeURIComponent(token)}`,
              identity,
            ),
            identity,
          },
        });
      });
    }
    return {
      accepted: true,
      message: "If a pending signup matches, a verification email will be sent.",
    };
  }

  async verifySignup(body: unknown) {
    const { token } = tokenSchema.parse(body),
      verificationHash = createHash("sha256").update(token).digest("hex");
    const [request] = await this.db.$transaction(async (tx) => {
      const [verified] = await tx.$queryRaw<{ id: string; slug: string }[]>`
        UPDATE public.signup_requests SET verified_at=COALESCE(verified_at,now())
        WHERE verification_hash=${verificationHash} AND verification_expires>now()
        RETURNING id,slug`;
      if (!verified) throw new BadRequestException("This verification link is invalid or expired.");
      await tx.signupProvisionJob.upsert({
        where: { signupId: verified.id },
        create: { signupId: verified.id },
        update: {},
      });
      return [verified];
    });
    if (!request) throw new BadRequestException("This verification link is invalid or expired.");
    return {
      accepted: true,
      tenantUrl: tenantOrigin(request.slug),
      message:
        "Email verified. Your organisation is being prepared; the administrator invite will arrive by email.",
    };
  }

  async enqueueProvisioning(enqueue: (signupId: string, attempt: number) => Promise<unknown>) {
    const jobs = await this.db.$queryRaw<{ id: string; signup_id: string; attempts: number }[]>`
      WITH picked AS (
        SELECT id FROM public.signup_provision_jobs
        WHERE (status='queued' OR status IN ('enqueued','processing')) AND next_attempt<=now()
        ORDER BY next_attempt FOR UPDATE SKIP LOCKED LIMIT 10
      )
      UPDATE public.signup_provision_jobs j SET status='enqueued',attempts=attempts+1,
        next_attempt=now()+interval '5 minutes'
      FROM picked WHERE j.id=picked.id RETURNING j.id,j.signup_id,j.attempts`;
    for (const job of jobs) {
      try {
        await enqueue(job.signup_id, job.attempts);
      } catch (error) {
        await this.db.signupProvisionJob.updateMany({
          where: { id: job.id, status: "enqueued" },
          data: { status: "queued", nextAttempt: new Date() },
        });
        throw error;
      }
    }
  }

  async provisionSignup(signupId: string) {
    const [job] = await this.db.$queryRaw<{ id: string; signup_id: string }[]>`
      UPDATE public.signup_provision_jobs SET status='processing',
        next_attempt=now()+interval '5 minutes'
      WHERE signup_id=${signupId}::uuid AND status IN ('queued','enqueued')
        AND (status='enqueued' OR next_attempt<=now())
      RETURNING id,signup_id`;
    if (!job) return;
    try {
      const signup = await this.db.signupRequest.findUniqueOrThrow({
        where: { id: job.signup_id },
      });
      if (!signup.verifiedAt) throw new Error("signup is not verified");
      if (!signup.provisionedTenantId) {
        const template = JSON.parse(
          await readFile(new URL("../../../prisma/starter-v1.json", import.meta.url), "utf8"),
        ) as Record<string, unknown>;
        const tenantId = randomUUID(),
          adminId = randomUUID(),
          invitationToken = randomBytes(32).toString("base64url"),
          invitationHash = createHash("sha256").update(invitationToken).digest("hex"),
          invitationExpires = new Date(Date.now() + 48 * 3600000),
          invitationUrl = `${tenantOrigin(signup.slug)}/#activate?token=${encodeURIComponent(invitationToken)}&organisation=${encodeURIComponent(signup.slug)}`,
          encryptedInvitation = encryptSecret(invitationUrl, `invitation:${tenantId}:${adminId}`),
          passwordHash = await hash(randomBytes(32), { type: argon2id });
        await this.db.$queryRaw`
          SELECT * FROM public.provision_verified_signup(
            ${signup.id}::uuid,${tenantId}::uuid,${adminId}::uuid,${passwordHash},${invitationHash},
            ${encryptedInvitation},${invitationExpires}::timestamptz,15,
            ${Number(process.env.DEFAULT_TRIAL_SEAT_LIMIT ?? 25)},${JSON.stringify(template)}::jsonb
          )`;
      }
      await this.db.signupProvisionJob.update({
        where: { id: job.id },
        data: { status: "complete", completedAt: new Date(), lastError: null },
      });
    } catch (error) {
      await this.db.signupProvisionJob.update({
        where: { id: job.id },
        data: {
          status: "queued",
          nextAttempt: new Date(Date.now() + 30000),
          lastError: "Provisioning attempt failed",
        },
      });
      throw error;
    }
  }

  async dispatchPublicMail() {
    const rows = await this.db.$queryRaw<
      { id: string; recipient: string; subject: string; encrypted_url: string; identity: string }[]
    >`
      WITH picked AS (
        SELECT id FROM public.public_mail_outbox
        WHERE sent_at IS NULL AND attempts<10 AND next_attempt_at<=now()
          AND (locked_until IS NULL OR locked_until<=now())
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10
      )
      UPDATE public.public_mail_outbox m SET locked_until=now()+interval '5 minutes'
      FROM picked WHERE m.id=picked.id RETURNING m.id,m.recipient,m.subject,m.encrypted_url,m.identity`;
    for (const item of rows) {
      try {
        if (!process.env.SMTP_HOST || !process.env.SMTP_FROM)
          throw new Error("mail configuration missing");
        const url = decryptSecret(item.encrypted_url, item.identity);
        await this.mail.sendMail({
          from: process.env.SMTP_FROM,
          to: item.recipient,
          subject: item.subject,
          text: `Use this single-use link to continue:
${url}

If you did not request this email, you can ignore it.`,
          messageId: `<public-${item.id}@${new URL(this.publicSiteOrigin()).hostname}>`,
        });
        await this.db.publicMailOutbox.update({
          where: { id: item.id },
          data: {
            sentAt: new Date(),
            encryptedUrl: null,
            lockedUntil: null,
            attempts: { increment: 1 },
          },
        });
      } catch {
        await this.db.publicMailOutbox.update({
          where: { id: item.id },
          data: {
            attempts: { increment: 1 },
            lockedUntil: null,
            nextAttemptAt: new Date(Date.now() + 30000),
          },
        });
      }
    }
  }

  async billingOverview(req: AuthRequest) {
    this.requireAdmin(req);
    return this.db.withTenant(req.auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: req.auth.tenantId },
        include: { billingPlan: true, _count: { select: { users: true } } },
      });
      const [seats] = await tx.$queryRaw<{ used: number }[]>`
        SELECT count(*)::integer AS used FROM public.users
        WHERE tenant_id=${req.auth.tenantId}::uuid AND active AND role<>'system'`;
      return {
        status: tenant.status,
        readOnlyReason: tenant.readOnlyReason,
        trialEndsAt: tenant.trialEndsAt,
        deleteAfter: tenant.deleteAfter,
        plan: tenant.billingPlan
          ? {
              id: tenant.billingPlan.id,
              name: tenant.billingPlan.name,
              interval: tenant.billingPlan.billingInterval,
            }
          : null,
        seatsUsed: seats?.used ?? 0,
        seatLimit: tenant.seatLimit,
        hasSubscription: Boolean(tenant.stripeSubscriptionId),
        hasCustomer: Boolean(tenant.stripeCustomerId),
        canManage: true,
      };
    });
  }

  async billingPlans(req: AuthRequest) {
    this.requireAdmin(req);
    return this.db.billingPlan.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, billingInterval: true, seatLimit: true },
    });
  }

  async checkout(req: AuthRequest, body: unknown) {
    this.requireAdmin(req);
    const { planId } = z
      .object({ planId: z.string().trim().min(1).max(80).optional() })
      .strict()
      .parse(body);
    const details = await this.db.withTenant(req.auth.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({
        where: { id: req.auth.tenantId },
        include: { billingPlan: true },
      });
      const plan = planId
        ? await tx.billingPlan.findFirst({ where: { id: planId, active: true } })
        : tenant.billingPlan?.active
          ? tenant.billingPlan
          : null;
      if (!plan) throw new BadRequestException("Choose an available billing plan.");
      const admin = await tx.user.findFirst({
        where: { tenantId: tenant.id, role: "admin", active: true },
        orderBy: { createdAt: "asc" },
      });
      if (!admin) throw new BadRequestException("An active administrator is required for billing.");
      return {
        tenantId: tenant.id,
        slug: tenant.slug,
        planId: plan.id,
        priceId: plan.stripePriceId,
        email: admin.email,
        customerId: tenant.stripeCustomerId,
      };
    });
    return {
      url: await paymentProvider().checkout({ ...details, tenantUrl: tenantOrigin(details.slug) }),
    };
  }

  async customerPortal(req: AuthRequest) {
    this.requireAdmin(req);
    const tenant = await this.db.withTenant(req.auth.tenantId, (tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: req.auth.tenantId },
        select: { slug: true, stripeCustomerId: true },
      }),
    );
    if (!tenant.stripeCustomerId)
      throw new BadRequestException("A billing account has not been created yet.");
    return {
      url: await paymentProvider().portal(
        tenant.stripeCustomerId,
        `${tenantOrigin(tenant.slug)}/billing`,
      ),
    };
  }

  async applyWebhook(rawBody: Buffer | undefined, signature: string) {
    if (!rawBody?.length || !signature) throw new BadRequestException("Invalid billing webhook.");
    let event: BillingEvent;
    try {
      event = await paymentProvider().webhook(rawBody, signature);
    } catch {
      throw new BadRequestException("Invalid billing webhook signature.");
    }
    const [result] = await this.db.$queryRaw<{ applied: boolean }[]>`
      SELECT public.apply_billing_event(${event.id},${event.type},${event.tenantId}::uuid,${event.planId},
        ${event.customerId},${event.subscriptionId},${event.transition}) AS applied`;
    return { received: true, duplicate: result?.applied === false };
  }

  private requireAdmin(req: AuthRequest) {
    if (req.auth.role !== "admin")
      throw new ForbiddenException("Only organisation administrators can manage billing.");
  }
}

@Controller()
export class SignupController {
  constructor(private readonly saas: SaasService) {}
  @Get("signup/plans") plans() {
    return this.saas.signupPlans();
  }
  @Get("signup/slug-availability") async availability(@Query("slug") slug = "") {
    return { available: await this.saas.slugAvailable(slug) };
  }
  @Get("signup/captcha") challenge() {
    return this.saas.captchaChallenge();
  }
  @Post("signup") signup(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.saas.beginSignup(body, req.ip);
  }
  @Post("signup/verify") verify(@Body() body: unknown) {
    return this.saas.verifySignup(body);
  }
  @Post("signup/resend-verification") resend(@Body() body: unknown, @Req() req: FastifyRequest) {
    return this.saas.resendVerification(body, req.ip);
  }
  @Post("billing/webhook") webhook(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers("stripe-signature") stripeSignature = "",
    @Headers("x-test-signature") testSignature = "",
  ) {
    return this.saas.applyWebhook(req.rawBody, stripeSignature || testSignature);
  }
}

@Controller("billing")
@UseGuards(SessionGuard)
export class BillingController {
  constructor(private readonly saas: SaasService) {}
  @Get() overview(@Req() req: AuthRequest) {
    return this.saas.billingOverview(req);
  }
  @Get("plans") plans(@Req() req: AuthRequest) {
    return this.saas.billingPlans(req);
  }
  @Post("checkout") checkout(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.saas.checkout(req, body);
  }
  @Post("portal") portal(@Req() req: AuthRequest) {
    return this.saas.customerPortal(req);
  }
}
