import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { resolveMx, resolveTxt } from "node:dns/promises";
import { createTransport } from "nodemailer";
import { z } from "zod";
import {
  platformMailActivateSchema,
  platformMailProfileSchema,
  platformMailSwitchSchema,
  type PlatformMailDnsView,
  type PlatformMailProfile,
  type PlatformMailView,
} from "@astrama/contracts";
import { Database } from "./database.js";
import { decryptSecret, encryptSecret } from "./mfa.js";
import {
  OperatorAuthService,
  OperatorGuard,
  type OperatorRequest,
  type OperatorSessionContext,
} from "./operator-auth.js";
import { tokenHash } from "./modules/auth/auth.service.js";
import {
  createPlatformTransport,
  platformInboundAddress,
  profileTransportOptions,
} from "./platform-mail.js";

export type StoredPlatformMailProfile = Omit<
  PlatformMailProfile,
  "passwordSet" | "testedAt" | "active"
> & { encryptedPassword: string };

export async function platformMailOperation<T>(
  db: Pick<Database, "$queryRaw">,
  auth: OperatorSessionContext,
  action: string,
  input: unknown = {},
): Promise<T> {
  if (auth.role !== "owner") throw new ForbiddenException("Owner role required");
  try {
    const [row] = await db.$queryRaw<
      { value: T }[]
    >`SELECT operator_platform_mail(${auth.sessionId}::uuid,${action},${JSON.stringify(input)}::jsonb) AS value`;
    return row!.value;
  } catch (error) {
    const code = (error as { meta?: { code?: string } }).meta?.code;
    if (code === "40001")
      throw new ConflictException("Platform email changed. Refresh before trying again.");
    if (code === "42501")
      throw new ForbiddenException("Active MFA-verified owner session required");
    if (code === "P0002") throw new NotFoundException("Mail profile not found");
    if (code === "23514")
      throw new BadRequestException(
        "Test the profile before activation, or select a valid previous profile or intake address.",
      );
    throw error;
  }
}

async function txt(name: string) {
  try {
    return (await resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}
export async function inboundMx(domain: string | null) {
  if (!domain) return [];
  try {
    return (await resolveMx(domain)).map((record) => `${record.priority} ${record.exchange}`);
  } catch {
    return [];
  }
}

@Injectable()
export class PlatformMailSettingsService {
  constructor(
    private readonly db: Database,
    private readonly operatorAuth: OperatorAuthService,
  ) {}

  async view(auth: OperatorSessionContext): Promise<PlatformMailView> {
    const result = await platformMailOperation<PlatformMailView>(this.db, auth, "view");
    const domain = platformInboundAddress("probe")?.split("@")[1] ?? null;
    return {
      ...result,
      receiving: { ...result.receiving, domain, mxOk: (await inboundMx(domain)).length > 0 },
    };
  }

  save(auth: OperatorSessionContext, body: unknown) {
    if (auth.role !== "owner") throw new ForbiddenException("Owner role required");
    const { password, ...settings } = platformMailProfileSchema.parse(body);
    return platformMailOperation<PlatformMailProfile>(this.db, auth, "save", {
      id: randomUUID(),
      settings,
      encryptedPassword: encryptSecret(password, "platform-smtp"),
    });
  }

  async test(auth: OperatorSessionContext, id: string, body: unknown) {
    z.object({}).strict().parse(body);
    const profile = await platformMailOperation<StoredPlatformMailProfile>(
      this.db,
      auth,
      "test-profile",
      { id: z.string().uuid().parse(id) },
    );
    const mail = createTransport(
      profileTransportOptions(profile, decryptSecret(profile.encryptedPassword, "platform-smtp")),
    );
    try {
      await mail.sendMail({
        from: profile.fromAddress,
        to: auth.email,
        subject: "Astrama platform email test",
        text: "Your platform sending profile is working.",
        messageId: `<platform-test-${randomUUID()}@${profile.fromDomain}>`,
      });
    } catch {
      await this.recordPlatformAttempt("failed");
      throw new BadRequestException(
        "SMTP test failed. Check authentication, host and TLS settings.",
      );
    } finally {
      mail.close();
    }
    await this.recordPlatformAttempt("sent");
    return platformMailOperation<{ ok: true }>(this.db, auth, "tested", { id });
  }

  async dns(auth: OperatorSessionContext, id: string, body: unknown): Promise<PlatformMailDnsView> {
    z.object({}).strict().parse(body);
    const profile = await platformMailOperation<PlatformMailProfile>(this.db, auth, "dns-profile", {
      id: z.string().uuid().parse(id),
    });
    const domain = profile.fromDomain,
      selector = profile.dkimSelector || "default";
    const inbound = platformInboundAddress("probe")?.split("@")[1] ?? null;
    const [spf, dkim, dmarc, mx] = await Promise.all([
      txt(domain),
      txt(`${selector}._domainkey.${domain}`),
      txt(`_dmarc.${domain}`),
      inboundMx(inbound),
    ]);
    const spfExpected =
      profile.spfRecord ||
      (profile.provider === "ses"
        ? "v=spf1 include:amazonses.com -all"
        : profile.provider === "postmark"
          ? "v=spf1 include:spf.mtasv.net -all"
          : profile.provider === "mailgun"
            ? "v=spf1 include:mailgun.org -all"
            : `v=spf1 mx -all`);
    return {
      records: [
        {
          type: "TXT",
          name: domain,
          expected: spfExpected,
          actual: spf,
          ok: spf.some((value) => value === spfExpected),
        },
        {
          type: "TXT",
          name: `${selector}._domainkey.${domain}`,
          expected:
            profile.dkimRecord || "Copy the DKIM public-key TXT value from your SMTP provider",
          actual: dkim,
          ok: dkim.some((value) =>
            profile.dkimRecord
              ? value === profile.dkimRecord
              : /^v=DKIM1\s*;.*\bp=\s*[^;\s]+/i.test(value),
          ),
        },
        {
          type: "TXT",
          name: `_dmarc.${domain}`,
          expected: "v=DMARC1; p=quarantine",
          actual: dmarc,
          ok: dmarc.some(
            (value) =>
              /^v=DMARC1\s*;/i.test(value) &&
              /(?:^|;)\s*p=(quarantine|reject)\s*(?:;|$)/i.test(value),
          ),
        },
        {
          type: "MX",
          name: inbound ?? "Configure INBOUND_MAIL_DOMAIN",
          expected: inbound
            ? `10 ${process.env.INBOUND_MX_HOST || inbound}`
            : "Configure the inbound domain first",
          actual: mx,
          ok: mx.some(
            (value) =>
              value.split(" ")[1]?.replace(/\.$/, "") === (process.env.INBOUND_MX_HOST || inbound),
          ),
        },
      ],
    };
  }

  async switch(auth: OperatorSessionContext, body: unknown, rollback = false) {
    if (auth.role !== "owner") throw new ForbiddenException("Owner role required");
    const input = (rollback ? platformMailSwitchSchema : platformMailActivateSchema).parse(body);
    // MFA failures and replay counters commit even if the later settings change conflicts.
    await this.operatorAuth.verifyMfa(auth, { code: input.totpCode }, true);
    const { totpCode: _code, ...change } = input;
    return platformMailOperation<{ revision: number }>(
      this.db,
      auth,
      rollback ? "rollback" : "activate",
      change,
    );
  }

  async sendToIntake(auth: OperatorSessionContext, body: unknown) {
    if (auth.role !== "owner") throw new ForbiddenException("Owner role required");
    const { address } = z
      .object({ address: z.string().trim().toLowerCase().email().max(254) })
      .strict()
      .parse(body);
    const domain = platformInboundAddress("probe")?.split("@")[1];
    if (!domain || address.split("@")[1] !== domain)
      throw new BadRequestException("Choose a known address on the platform inbound domain");
    const code = randomBytes(32).toString("hex");
    const result = await platformMailOperation<{ status: "pending" }>(this.db, auth, "probe", {
      address,
      hash: tokenHash(code),
    });
    const mail = createPlatformTransport(this.db);
    try {
      await mail.sendMail({
        to: address,
        subject: `Astrama platform intake check ${code}`,
        text: "Synthetic operator intake check.",
        headers: { "Auto-Submitted": "auto-generated" },
      });
    } catch {
      throw new BadRequestException(
        "Intake test could not be sent. Check the active sending profile.",
      );
    } finally {
      mail.close();
    }
    return result;
  }

  private recordPlatformAttempt(status: "sent" | "failed") {
    return this.db
      .$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status,last_error) VALUES(NULL,'platform-test',${status},${status === "failed" ? "SMTP delivery failed" : null})`;
  }
}

@Controller("operator/platform-email")
@UseGuards(OperatorGuard)
export class PlatformMailSettingsController {
  constructor(private readonly service: PlatformMailSettingsService) {}
  @Get() view(@Req() req: OperatorRequest) {
    return this.service.view(req.operator);
  }
  @Post("profiles") save(@Req() req: OperatorRequest) {
    return this.service.save(req.operator, req.body);
  }
  @Post("profiles/:id/test") test(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.test(req.operator, id, req.body);
  }
  @Post("profiles/:id/dns-check") dns(@Req() req: OperatorRequest, @Param("id") id: string) {
    return this.service.dns(req.operator, id, req.body);
  }
  @Post("activate") activate(@Req() req: OperatorRequest) {
    return this.service.switch(req.operator, req.body);
  }
  @Post("rollback") rollback(@Req() req: OperatorRequest) {
    return this.service.switch(req.operator, req.body, true);
  }
  @Post("receiving/test") receiving(@Req() req: OperatorRequest) {
    return this.service.sendToIntake(req.operator, req.body);
  }
}
