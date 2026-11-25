import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { canConfigureOrganisation } from "@astrama/domain";
import {
  outgoingSmtpSchema,
  outgoingPlatformSchema,
  microsoft365ConnectSchema,
  microsoft365CompleteSchema,
  microsoft365ActivateSchema,
  operatorOutgoingResetSchema,
  type OutgoingMailSummary,
  type OutgoingMailView,
} from "@astrama/contracts";
import { Database, lockConfiguration, type Tx } from "./database.js";
import { encryptSecret, decryptSecret } from "./mfa.js";
import {
  SessionGuard,
  tokenHash,
  type AuthRequest,
  type AuthContext,
} from "./modules/auth/auth.service.js";
import { TicketsService } from "./modules/tickets/tickets.service.js";
import {
  OperatorGuard,
  type OperatorRequest,
  type OperatorSessionContext,
} from "./operator-auth.js";
import { withOperatorTenant, operatorAudit } from "./operator-access.js";
import { tenantOrigin } from "./platform.js";
import {
  closeTenantSmtp,
  outgoingSettings,
  safeSmtpTransport,
  type TenantSmtpSettings,
} from "./tenant-smtp.js";
import {
  microsoft365Config,
  microsoft365Client,
  microsoft365Access,
  outgoingError,
  outgoingErrorText,
  smtpScopes,
} from "./microsoft365-mail.js";
import { createPlatformTransport, sendTenantMail } from "./platform-mail.js";
import { reserveTenantBudget } from "./tenant-budgets.js";
import { brandedMailText } from "./branding.js";
import { currentMailDeadline, withMailDeadline } from "./mail-deadline.js";

export function outgoingSummary(
  settings: TenantSmtpSettings | null,
  tenantStatus: string,
): OutgoingMailSummary {
  const mode = settings?.mode ?? "platform",
    status = settings?.status ?? "working";
  return {
    revision: settings?.revision ?? 0,
    mode,
    status,
    effectiveMode: tenantStatus === "read_only" || status === "problem" ? "platform" : mode,
  };
}
@Injectable()
export class OutgoingEmailService {
  private readonly platformMail = createPlatformTransport(() => this.db);
  constructor(
    private readonly db: Database,
    private readonly tickets: TicketsService,
  ) {}
  private admin<T>(auth: AuthContext, work: (tx: Tx) => Promise<T>) {
    return this.tickets.scoped(
      auth,
      async (tx, actor) => {
        if (!canConfigureOrganisation({ ...actor, mfaVerified: auth.view.mfaVerified }))
          throw new ForbiddenException("MFA-verified administrator required");
        return withMailDeadline(tx, () => work(tx));
      },
      { lock: "exclusive" },
    );
  }
  private async viewIn(tx: Tx, auth: AuthContext): Promise<OutgoingMailView> {
    const [settings, tenant, pending] = await Promise.all([
      outgoingSettings(tx, auth.tenantId),
      tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId }, select: { status: true } }),
      tx.mailOAuthConnection.findFirst({
        where: {
          tenantId: auth.tenantId,
          adminId: auth.id,
          sessionId: auth.sessionId,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return {
      ...outgoingSummary(settings, tenant.status),
      smtp:
        settings?.mode && settings.mode !== "platform"
          ? {
              provider: settings.provider!,
              host: settings.host!,
              port: settings.port!,
              security: settings.security!,
              username: settings.username!,
              fromAddress: settings.from_address!,
              passwordSet: !!settings.encrypted_secret,
            }
          : null,
      lastError: outgoingErrorText(settings?.last_error_code ?? null),
      testedAt: settings?.tested_at?.toISOString() ?? null,
      microsoft365Available: !!microsoft365Config(),
      pendingMicrosoft365: pending
        ? {
            connectionId: pending.id,
            status: pending.status as "pending" | "ready" | "problem",
            mailboxAddress: pending.mailboxAddress,
            fromAddress: pending.fromAddress,
            error: outgoingErrorText(pending.errorCode),
            expiresAt: pending.expiresAt.toISOString(),
          }
        : null,
    };
  }
  view(auth: AuthContext) {
    return this.admin(auth, (tx) => this.viewIn(tx, auth));
  }
  private async expected(tx: Tx, tenantId: string, revision: number) {
    const current = await outgoingSettings(tx, tenantId, true);
    if ((current?.revision ?? 0) !== revision)
      throw new ConflictException("Outgoing email changed. Refresh before trying again.");
  }
  private async audit(tx: Tx, auth: AuthContext, action: string, revision: number) {
    await tx.configAudit.create({
      data: {
        tenantId: auth.tenantId,
        actorId: auth.id,
        entityId: auth.tenantId,
        action,
        detail: { revision },
      },
    });
  }
  private async testSmtp(
    tx: Tx,
    auth: AuthContext,
    settings: Pick<TenantSmtpSettings, "host" | "port" | "security" | "username">,
    fromAddress: string,
    password?: string,
    oauthToken?: string,
  ) {
    const mail = safeSmtpTransport(settings, password);
    try {
      await reserveTenantBudget(tx, auth.tenantId, "outbound");
      const admin = await tx.user.findUniqueOrThrow({
        where: { id: auth.id },
        select: { email: true },
      });
      await mail.sendMail({
        from: fromAddress,
        to: admin.email,
        subject: "Astrama outgoing email test",
        text: await brandedMailText(
          tx,
          auth.tenantId,
          "Your own outgoing email connection is working.",
        ),
        ...(oauthToken
          ? { auth: { type: "OAuth2", user: settings.username!, accessToken: oauthToken } }
          : {}),
      });
      await tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status) VALUES(${auth.tenantId}::uuid,'smtp-test','sent')`;
      return null;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const failed = outgoingError(error);
      await tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status,last_error) VALUES(${auth.tenantId}::uuid,'smtp-test','failed',${outgoingErrorText(failed.kind)})`;
      return failed;
    } finally {
      mail.close();
    }
  }
  async smtp(auth: AuthContext, body: unknown) {
    const input = outgoingSmtpSchema.parse(body);
    const result = await this.admin(auth, async (tx) => {
      await this.expected(tx, auth.tenantId, input.revision);
      const failed = await this.testSmtp(
        tx,
        auth,
        { host: input.host, port: input.port, security: input.security, username: input.username },
        input.fromAddress,
        input.password,
      );
      if (failed) return { error: outgoingErrorText(failed.kind)! };
      const data = {
        mode: "smtp",
        status: "working",
        provider: input.provider,
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        fromAddress: input.fromAddress,
        encryptedSecret: encryptSecret(input.password, `smtp:${auth.tenantId}`),
        accountId: null,
        configuredById: auth.id,
        consecutiveFailures: 0,
        lastErrorCode: null,
        testedAt: new Date(),
        noticePendingAt: null,
        noticeSentAt: null,
        noticeAttempts: 0,
      };
      await tx.tenantOutgoingMail.upsert({
        where: { tenantId: auth.tenantId },
        create: { tenantId: auth.tenantId, revision: 1, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      await tx.mailOAuthConnection.deleteMany({ where: { tenantId: auth.tenantId } });
      await this.audit(tx, auth, "outgoing_email.smtp_saved", input.revision + 1);
      return { view: await this.viewIn(tx, auth) };
    });
    if ("error" in result) throw new BadRequestException(result.error);
    closeTenantSmtp(auth.tenantId);
    return result.view;
  }
  private async resetIn(tx: Tx, tenantId: string, revision: number) {
    await this.expected(tx, tenantId, revision);
    const empty = {
      mode: "platform",
      status: "working",
      provider: null,
      host: null,
      port: null,
      security: null,
      username: null,
      fromAddress: null,
      encryptedSecret: null,
      accountId: null,
      configuredById: null,
      consecutiveFailures: 0,
      lastErrorCode: null,
      testedAt: null,
      noticePendingAt: null,
      noticeSentAt: null,
      noticeAttempts: 0,
    };
    await tx.tenantOutgoingMail.upsert({
      where: { tenantId },
      create: { tenantId, revision: 1, ...empty },
      update: { ...empty, revision: { increment: 1 } },
    });
    await tx.mailOAuthConnection.deleteMany({ where: { tenantId } });
  }
  async platform(auth: AuthContext, body: unknown) {
    const input = outgoingPlatformSchema.parse(body);
    const result = await this.admin(auth, async (tx) => {
      await this.resetIn(tx, auth.tenantId, input.revision);
      await this.audit(tx, auth, "outgoing_email.platform_selected", input.revision + 1);
      return this.viewIn(tx, auth);
    });
    closeTenantSmtp(auth.tenantId);
    return result;
  }
  async connect(auth: AuthContext, body: unknown) {
    if (!canConfigureOrganisation({ ...auth, mfaVerified: auth.view.mfaVerified }))
      throw new ForbiddenException("MFA-verified administrator required");
    const input = microsoft365ConnectSchema.parse(body);
    if (!microsoft365Config())
      throw new BadRequestException(
        "Microsoft 365 connection is not configured by the platform operator.",
      );
    const { client, redirectUri } = microsoft365Client();
    const state = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      id = randomUUID();
    const authorizationUrl = await withMailDeadline(undefined, (deadline) =>
      deadline.run(() =>
        client.getAuthCodeUrl({
          scopes: smtpScopes,
          redirectUri,
          state,
          codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
          codeChallengeMethod: "S256",
          prompt: "select_account",
        }),
      ),
    );
    await this.admin(auth, async (tx) => {
      await this.expected(tx, auth.tenantId, input.revision);
      await tx.mailOAuthConnection.deleteMany({
        where: { tenantId: auth.tenantId, adminId: auth.id },
      });
      await tx.mailOAuthConnection.create({
        data: {
          id,
          tenantId: auth.tenantId,
          adminId: auth.id,
          sessionId: auth.sessionId,
          revision: input.revision,
          mailboxAddress: input.mailboxAddress,
          fromAddress: input.fromAddress,
          stateHash: tokenHash(state),
          encryptedPkce: encryptSecret(verifier, `smtp-oauth-state:${auth.tenantId}:${id}`),
          expiresAt: new Date(Date.now() + 10 * 60000),
        },
      });
    });
    return { connectionId: id, authorizationUrl };
  }
  async callback(request: FastifyRequest, query: unknown, reply: FastifyReply) {
    const input = z
      .object({
        state: z.string().min(40).max(128),
        code: z.string().min(1).max(10000).optional(),
        error: z.string().max(120).optional(),
      })
      .passthrough()
      .parse(query);
    const config = microsoft365Config();
    if (!config)
      throw new BadRequestException(
        "Microsoft 365 connection is not configured by the platform operator.",
      );
    const { redirectUri } = config;
    if (request.headers.host?.toLowerCase() !== new URL(redirectUri).host.toLowerCase())
      throw new ForbiddenException("Invalid callback host");
    const [pending] = await this.db.$queryRaw<
      {
        id: string;
        tenant_id: string;
        admin_id: string;
        session_id: string;
        encrypted_pkce: string | null;
      }[]
    >`SELECT * FROM claim_mail_oauth_state(${tokenHash(input.state)})`;
    if (!pending?.encrypted_pkce)
      throw new BadRequestException("Microsoft 365 connection expired. Start again.");
    // The provider returns on the public host without the tenant cookie. Hold the code
    // until the SAME initiating tenant session presents this callback-only handoff.
    const handoff = randomBytes(32).toString("base64url");
    const hasGrant = !!input.code && !input.error;
    const encryptedCache = hasGrant
      ? encryptSecret(
          JSON.stringify({
            code: input.code,
            codeVerifier: decryptSecret(
              pending.encrypted_pkce,
              `smtp-oauth-state:${pending.tenant_id}:${pending.id}`,
            ),
          }),
          `smtp:${pending.tenant_id}`,
        )
      : null;
    const slug = await this.db.withTenant(pending.tenant_id, async (tx) => {
      await lockConfiguration(tx, pending.tenant_id);
      const session = await tx.session.findFirst({
        where: {
          id: pending.session_id,
          tenantId: pending.tenant_id,
          userId: pending.admin_id,
          mfaVerified: true,
          expiresAt: { gt: new Date() },
          user: { active: true, role: "admin", mfaEnrolled: true },
        },
      });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: pending.tenant_id } });
      if (!session || !["trial", "active"].includes(tenant.status))
        throw new ForbiddenException("Administrator session expired. Start again.");
      await tx.mailOAuthConnection.updateMany({
        where: { id: pending.id, tenantId: pending.tenant_id, expiresAt: { gt: new Date() } },
        data: {
          status: hasGrant ? "pending" : "problem",
          stateHash: tokenHash(handoff),
          encryptedCache,
          errorCode: hasGrant ? null : "consent",
        },
      });
      return tenant.slug;
    });
    return reply
      .code(302)
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .redirect(
        `${tenantOrigin(slug)}/organisation?section=email&mailConnect=${hasGrant ? `confirm#mailHandoff=${handoff}` : "problem"}`,
      );
  }
  async complete(auth: AuthContext, body: unknown) {
    const { handoff } = microsoft365CompleteSchema.parse(body);
    return this.admin(auth, async (tx) => {
      const [pending] = await tx.$queryRaw<
        { id: string; revision: number; encrypted_cache: string | null }[]
      >`SELECT id,revision,encrypted_cache FROM mail_oauth_connections WHERE tenant_id=${auth.tenantId}::uuid AND admin_id=${auth.id}::uuid AND session_id=${auth.sessionId}::uuid AND state_hash=${tokenHash(handoff)} AND status='pending' AND consumed_at IS NOT NULL AND expires_at>now() FOR UPDATE`;
      if (!pending?.encrypted_cache)
        throw new BadRequestException(
          "Microsoft 365 connection expired or belongs to another browser session. Start again.",
        );
      await this.expected(tx, auth.tenantId, pending.revision);
      // Change the nonce even when token exchange fails; a callback handoff is single-use.
      await tx.mailOAuthConnection.update({
        where: { id: pending.id },
        data: {
          stateHash: tokenHash(randomBytes(32).toString("hex")),
          encryptedCache: null,
          status: "problem",
          errorCode: "consent",
        },
      });
      try {
        const grant = z
          .object({ code: z.string(), codeVerifier: z.string() })
          .strict()
          .parse(JSON.parse(decryptSecret(pending.encrypted_cache, `smtp:${auth.tenantId}`)));
        const { client, redirectUri } = microsoft365Client();
        const token = await currentMailDeadline()!.run(() =>
          client.acquireTokenByCode({
            ...grant,
            redirectUri,
            scopes: smtpScopes,
          }),
        );
        currentMailDeadline()!.check();
        if (token?.account?.homeAccountId && token.accessToken)
          await tx.mailOAuthConnection.update({
            where: { id: pending.id },
            data: {
              status: "ready",
              encryptedCache: encryptSecret(
                client.getTokenCache().serialize(),
                `smtp:${auth.tenantId}`,
              ),
              accountId: token.account.homeAccountId,
              errorCode: null,
            },
          });
      } catch {
        /* A failed consent exchange requires a fresh connection, never a reusable code. */
      }
      return this.viewIn(tx, auth);
    });
  }
  async microsoft365(auth: AuthContext, body: unknown) {
    const input = microsoft365ActivateSchema.parse(body);
    const result = await this.admin(auth, async (tx) => {
      await this.expected(tx, auth.tenantId, input.revision);
      const pending = await tx.mailOAuthConnection.findFirst({
        where: {
          id: input.connectionId,
          tenantId: auth.tenantId,
          adminId: auth.id,
          sessionId: auth.sessionId,
          revision: input.revision,
          status: "ready",
          expiresAt: { gt: new Date() },
        },
      });
      if (!pending?.encryptedCache || !pending.accountId)
        throw new BadRequestException("Connect Microsoft 365 again before testing.");
      let token;
      try {
        token = await microsoft365Access({
          tenant_id: auth.tenantId,
          encrypted_secret: pending.encryptedCache,
          account_id: pending.accountId,
        });
      } catch (error) {
        return { error: outgoingErrorText(outgoingError(error).kind)! };
      }
      const settings = {
        host: "smtp.office365.com",
        port: 587 as const,
        security: "starttls" as const,
        username: pending.mailboxAddress,
      };
      const failed = await this.testSmtp(
        tx,
        auth,
        settings,
        pending.fromAddress,
        undefined,
        token.accessToken,
      );
      if (failed) return { error: outgoingErrorText(failed.kind)! };
      const data = {
        mode: "microsoft365",
        status: "working",
        provider: "microsoft365",
        ...settings,
        fromAddress: pending.fromAddress,
        encryptedSecret: token.encryptedCache,
        accountId: pending.accountId,
        configuredById: auth.id,
        consecutiveFailures: 0,
        lastErrorCode: null,
        testedAt: new Date(),
        noticePendingAt: null,
        noticeSentAt: null,
        noticeAttempts: 0,
      };
      await tx.tenantOutgoingMail.upsert({
        where: { tenantId: auth.tenantId },
        create: { tenantId: auth.tenantId, revision: 1, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      await tx.mailOAuthConnection.deleteMany({ where: { tenantId: auth.tenantId } });
      await this.audit(tx, auth, "outgoing_email.microsoft365_saved", input.revision + 1);
      return { view: await this.viewIn(tx, auth) };
    });
    if ("error" in result) throw new BadRequestException(result.error);
    closeTenantSmtp(auth.tenantId);
    return result.view;
  }
  operatorView(auth: OperatorSessionContext, id: string) {
    return withOperatorTenant(
      this.db,
      auth,
      id,
      false,
      async (tx, tenant) => {
        await operatorAudit(
          tx,
          auth.id,
          tenant,
          "outgoing_email.viewed",
          "Operator mail status view",
        );
        return outgoingSummary(await outgoingSettings(tx, id), tenant.status);
      },
      true,
    );
  }
  async operatorReset(auth: OperatorSessionContext, id: string, body: unknown) {
    const input = operatorOutgoingResetSchema.parse(body);
    const result = await withOperatorTenant(
      this.db,
      auth,
      id,
      true,
      async (tx, tenant, operator) => {
        if (operator.role !== "owner") throw new ForbiddenException("Owner operator required");
        await this.resetIn(tx, id, input.revision);
        await operatorAudit(tx, auth.id, tenant, "outgoing_email.reset", input.reason, {
          revision: input.revision + 1,
        });
        return outgoingSummary(await outgoingSettings(tx, id), tenant.status);
      },
      true,
    );
    closeTenantSmtp(id);
    return result;
  }
  async dispatchNotices() {
    await this.db.$executeRaw`SELECT delete_expired_mail_oauth_connections()`;
    const rows = await this.db.$queryRaw<
      { tenant_id: string }[]
    >`SELECT * FROM pending_outgoing_mail_notices()`;
    for (const row of rows)
      await this.db.withTenant(row.tenant_id, async (tx) => {
        await lockConfiguration(tx, row.tenant_id);
        const settings = await outgoingSettings(tx, row.tenant_id, true);
        if (
          !settings?.notice_pending_at ||
          settings.notice_sent_at ||
          settings.notice_next_attempt_at > new Date()
        )
          return;
        const admins = await tx.user.findMany({
          where: { tenantId: row.tenant_id, active: true, role: "admin" },
          select: { email: true },
        });
        try {
          if (admins.length)
            await sendTenantMail(
              this.platformMail,
              tx,
              row.tenant_id,
              {
                to: admins.map((admin) => admin.email),
                subject: "Your outgoing email connection needs attention",
                text: await brandedMailText(
                  tx,
                  row.tenant_id,
                  "Your organisation's own mail connection failed. Astrama is sending through its platform sender so notifications can continue. An administrator can reconnect it in Settings > Email.",
                ),
              },
              { forcePlatform: true },
            );
          await tx.$executeRaw`UPDATE tenant_outgoing_mail SET notice_sent_at=now(),notice_attempts=notice_attempts+1 WHERE tenant_id=${row.tenant_id}::uuid`;
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === 429) {
            await tx.$executeRaw`UPDATE tenant_outgoing_mail SET notice_next_attempt_at=now()+interval '5 minutes' WHERE tenant_id=${row.tenant_id}::uuid`;
            return;
          }
          await tx.$executeRaw`UPDATE tenant_outgoing_mail SET notice_attempts=notice_attempts+1,notice_next_attempt_at=now()+interval '5 minutes' WHERE tenant_id=${row.tenant_id}::uuid`;
        }
      });
  }
}

@Controller("admin/outgoing-email")
@UseGuards(SessionGuard)
export class OutgoingEmailController {
  constructor(private readonly service: OutgoingEmailService) {}
  @Get() view(@Req() req: AuthRequest) {
    return this.service.view(req.auth);
  }
  @Post("smtp/test-and-save") smtp(@Req() req: AuthRequest) {
    return this.service.smtp(req.auth, req.body);
  }
  @Post("platform") platform(@Req() req: AuthRequest) {
    return this.service.platform(req.auth, req.body);
  }
  @Post("microsoft365/connect") connect(@Req() req: AuthRequest) {
    return this.service.connect(req.auth, req.body);
  }
  @Post("microsoft365/complete") complete(@Req() req: AuthRequest) {
    return this.service.complete(req.auth, req.body);
  }
  @Post("microsoft365/test-and-save") microsoft365(@Req() req: AuthRequest) {
    return this.service.microsoft365(req.auth, req.body);
  }
}
@Controller("mail/microsoft365")
export class Microsoft365MailCallbackController {
  constructor(private readonly service: OutgoingEmailService) {}
  @Get("callback") callback(
    @Req() req: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    return this.service.callback(req, query, reply);
  }
}
@Controller("operator/organisations/:id/outgoing-email")
@UseGuards(OperatorGuard)
export class OperatorOutgoingEmailController {
  constructor(private readonly service: OutgoingEmailService) {}
  @Get() view(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.operatorView(req.operator, id);
  }
  @Post("reset") reset(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.operatorReset(req.operator, id, req.body);
  }
}
