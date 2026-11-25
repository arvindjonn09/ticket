import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import { createTransport, type SendMailOptions, type Transporter } from "nodemailer";
import type { Tx } from "./database.js";
import { reserveTenantBudget } from "./tenant-budgets.js";
import { decryptSecret } from "./mfa.js";
import { ForbiddenException } from "@nestjs/common";
import addressparser from "nodemailer/lib/addressparser";
import { closeTenantSmtp, outgoingSettings, sendOwnSmtp } from "./tenant-smtp.js";
import { outgoingError, outgoingErrorText } from "./microsoft365-mail.js";

export type PlatformSmtpProfile = {
  revision: number;
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  encryptedPassword: string;
  fromAddress: string;
  fromDomain: string;
};
export function profileTransportOptions(
  profile: Omit<PlatformSmtpProfile, "revision" | "encryptedPassword">,
  password: string,
) {
  return {
    host: profile.host,
    port: profile.port,
    secure: profile.security === "tls",
    requireTLS: profile.security === "starttls",
    auth: { user: profile.username, pass: password },
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  };
}
const profileSources = new WeakSet<Transporter>();
export async function activePlatformMailProfile(db: Pick<Tx, "$queryRaw">) {
  if (process.env.PLATFORM_MODE !== "hosted") return null;
  const [row] = await db.$queryRaw<
    { profile: PlatformSmtpProfile | null }[]
  >`SELECT active_platform_mail_profile() AS profile`;
  return row?.profile ?? null;
}

async function mailEnvironment(mail: Transporter, tx: Tx) {
  const profile = profileSources.has(mail) ? await activePlatformMailProfile(tx) : null;
  return profile
    ? {
        ...process.env,
        PLATFORM_MAIL_DOMAIN: profile.fromDomain,
        PLATFORM_PROFILE_FROM: profile.fromAddress,
      }
    : process.env;
}

export function createPlatformTransport(
  db?: Pick<Tx, "$queryRaw"> | (() => Pick<Tx, "$queryRaw">),
) {
  const fallback: Transporter = createTransport({
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
  if (!db) return fallback;
  const fallbackSend = fallback.sendMail.bind(fallback),
    fallbackClose = fallback.close.bind(fallback);
  let current:
    { revision: number; mail: Transporter; inFlight: number; retired: boolean } | undefined;
  let idle: NodeJS.Timeout | undefined;
  const retire = () => {
    if (current) {
      current.retired = true;
      if (!current.inFlight) current.mail.close();
      current = undefined;
    }
    if (idle) clearTimeout(idle);
  };
  // Every send checks the revision; there is no process-lifetime SMTP configuration snapshot.
  fallback.sendMail = (async (options: SendMailOptions) => {
    const profile = await activePlatformMailProfile(typeof db === "function" ? db() : db);
    if (!profile) {
      retire();
      return fallbackSend({
        ...options,
        from: options.from ?? process.env.SMTP_FROM,
        messageId: `<${options.messageId?.match(/^<([^<>@\s]+)@[^<>@\s]+>$/)?.[1] || randomUUID()}@${platformMailDomain()}>`,
      });
    }
    if (current?.revision !== profile.revision) {
      retire();
      current = {
        revision: profile.revision,
        mail: createTransport(
          profileTransportOptions(
            profile,
            decryptSecret(profile.encryptedPassword, "platform-smtp"),
          ),
        ),
        inFlight: 0,
        retired: false,
      };
    }
    const selected = current!;
    if (idle) clearTimeout(idle);
    selected.inFlight++;
    const message = {
      ...options,
      from:
        typeof options.from === "object"
          ? { ...options.from, address: profile.fromAddress }
          : profile.fromAddress,
      messageId: `<${options.messageId?.match(/^<([^<>@\s]+)@[^<>@\s]+>$/)?.[1] || randomUUID()}@${profile.fromDomain}>`,
    };
    try {
      return await selected.mail.sendMail(message);
    } finally {
      selected.inFlight--;
      if (selected.retired && !selected.inFlight) selected.mail.close();
      if (current === selected && !selected.inFlight) {
        idle = setTimeout(retire, 60000);
        idle.unref();
      }
    }
  }) as Transporter["sendMail"];
  fallback.close = () => {
    retire();
    fallbackClose();
  };
  profileSources.add(fallback);
  return fallback;
}

function mailDomain(value: string) {
  if (/[\s@<>:/\\]/.test(value)) throw new Error("Invalid platform mail domain");
  const domain = domainToASCII(value).toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("Invalid platform mail domain");
  return domain;
}

export function platformMailDomain(env: NodeJS.ProcessEnv = process.env) {
  const fromDomain = env.SMTP_FROM?.trim().match(/(?:^|<)[^<>@\s]+@([^<>@\s]+)>?$/)?.[1];
  return mailDomain(env.PLATFORM_MAIL_DOMAIN?.trim() || fromDomain || "");
}

export function platformInboundAddress(slug: string, env: NodeJS.ProcessEnv = process.env) {
  const domain =
    env.INBOUND_MAIL_DOMAIN?.trim() ||
    (env.PLATFORM_MODE === "hosted" && env.APP_BASE_DOMAIN
      ? `in.${env.APP_BASE_DOMAIN}`
      : undefined);
  if (!domain) return undefined;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug))
    throw new Error("Invalid tenant mail address");
  return `${slug}@${mailDomain(domain)}`;
}

export function tenantMailOptions(
  tenant: { brandName: string; slug: string },
  options: SendMailOptions,
  env: NodeJS.ProcessEnv = process.env,
): SendMailOptions {
  const domain = platformMailDomain(env);
  const fromAddress = env.PLATFORM_PROFILE_FROM || `notifications@${domain}`;
  const local = options.messageId?.match(/^<([^<>@\s]+)@[^<>@\s]+>$/)?.[1] ?? randomUUID();
  // Identity headers must agree with the structured options, including retry Message-IDs.
  const headers = Array.isArray(options.headers)
    ? options.headers.filter(
        (header) => !/^(from|sender|message-id|reply-to|auto-submitted)$/i.test(header.key),
      )
    : Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(
          ([key]) => !/^(from|sender|message-id|reply-to|auto-submitted)$/i.test(key),
        ),
      );
  // Forwarded copies must remain recognisable when an own sender changes the Message-ID domain.
  if (Array.isArray(headers)) headers.push({ key: "Auto-Submitted", value: "auto-generated" });
  else headers["Auto-Submitted"] = "auto-generated";
  return {
    ...options,
    headers,
    sender: undefined,
    ...(options.envelope ? { envelope: { ...options.envelope, from: fromAddress } } : {}),
    from: {
      name: `${tenant.brandName.replace(/\p{Cc}/gu, " ").trim()} Support`,
      address: fromAddress,
    },
    replyTo: options.replyTo ?? platformInboundAddress(tenant.slug, env),
    messageId: `<${local}@${domain}>`,
  };
}

/** Callers commit failed-attempt evidence before retrying their durable outbox. */
export async function sendTenantMail(
  mail: Transporter,
  tx: Tx,
  tenantId: string,
  options: SendMailOptions,
  policy: { forcePlatform?: boolean } = {},
) {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { brandName: true, slug: true, status: true },
  });
  if (tenant.status === "read_only") {
    const recipients = [
      ...mailRecipients(options.to),
      ...mailRecipients(options.cc),
      ...mailRecipients(options.bcc),
      ...mailRecipients(options.envelope?.to),
    ];
    const admins = await tx.user.findMany({
      where: { tenantId, active: true, role: "admin" },
      select: { email: true },
    });
    const allowed = new Set(admins.map((admin) => admin.email.toLowerCase()));
    if (!recipients.length || recipients.some((email) => !allowed.has(email)))
      throw new ForbiddenException("Read-only organisations send only to current administrators");
  }
  // ponytail: serialize each tenant's SMTP send to keep failure counters and rotating OAuth cache consistent; split locks if throughput requires it.
  const settings =
    !policy.forcePlatform && tenant.status !== "read_only"
      ? await outgoingSettings(tx, tenantId, true)
      : null;
  const useOwn = settings && settings.mode !== "platform" && settings.status === "working";
  const message = tenantMailOptions(
    tenant,
    options,
    useOwn
      ? {
          ...process.env,
          PLATFORM_MAIL_DOMAIN: settings.from_address!.split("@")[1],
          PLATFORM_PROFILE_FROM: settings.from_address!,
        }
      : await mailEnvironment(mail, tx),
  );
  await reserveTenantBudget(tx, tenantId, "outbound");
  let result;
  try {
    result = useOwn ? await sendOwnSmtp(tx, settings, message) : await mail.sendMail(message);
    if (useOwn)
      await tx.$executeRaw`UPDATE tenant_outgoing_mail SET consecutive_failures=0,last_error_code=NULL WHERE tenant_id=${tenantId}::uuid AND revision=${settings.revision}`;
  } catch (error) {
    await tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status,last_error) VALUES(${tenantId}::uuid,'transactional','failed','SMTP delivery failed')`;
    const failed = outgoingError(error);
    if (!useOwn) throw failed;
    const failures = [
      "authentication",
      "connection",
      "tls",
      "consent",
      "address",
      "oauth_unavailable",
    ].includes(failed.kind)
      ? settings.consecutive_failures + 1
      : 0;
    const problem = failures >= 5 || failed.kind === "consent" || failed.kind === "address";
    const changed =
      await tx.$executeRaw`UPDATE tenant_outgoing_mail SET consecutive_failures=${failures},last_error_code=${failed.kind},status=${problem ? "problem" : "working"},revision=revision+${problem ? 1 : 0},notice_pending_at=CASE WHEN ${problem} THEN now() ELSE notice_pending_at END,notice_sent_at=CASE WHEN ${problem} THEN NULL ELSE notice_sent_at END,notice_attempts=CASE WHEN ${problem} THEN 0 ELSE notice_attempts END,notice_next_attempt_at=CASE WHEN ${problem} THEN now() ELSE notice_next_attempt_at END WHERE tenant_id=${tenantId}::uuid AND revision=${settings.revision} AND status='working'`;
    if (!problem || changed !== 1) throw failed;
    closeTenantSmtp(tenantId);
    if (settings.configured_by_id)
      await tx.configAudit.create({
        data: {
          tenantId,
          actorId: settings.configured_by_id,
          entityId: tenantId,
          action: "outgoing_email.fallback",
          detail: {
            automatic: true,
            error: outgoingErrorText(failed.kind),
            revision: settings.revision + 1,
          },
        },
      });
    // Commit Problem and its notice before the durable mailer retries through platform.
    // A second SMTP exchange here could consume the SQL time needed to commit fallback.
    throw failed;
  }
  await tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status) VALUES(${tenantId}::uuid,'transactional','sent')`;
  return result;
}

function mailRecipients(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(mailRecipients);
  if (typeof value === "string")
    return addressparser(value, { flatten: true }).flatMap(mailRecipients);
  if (typeof value === "object" && "address" in value && typeof value.address === "string")
    return [value.address.trim().toLowerCase()];
  throw new ForbiddenException("Invalid mail recipient");
}
