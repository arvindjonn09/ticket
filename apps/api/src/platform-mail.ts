import { randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import { createTransport, type SendMailOptions, type Transporter } from "nodemailer";
import type { Tx } from "./database.js";
import { reserveTenantBudget } from "./tenant-budgets.js";

export function createPlatformTransport() {
  return createTransport({
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
  const local = options.messageId?.match(/^<([^<>@\s]+)@[^<>@\s]+>$/)?.[1] ?? randomUUID();
  // Identity headers must agree with the structured options, including retry Message-IDs.
  const headers = Array.isArray(options.headers)
    ? options.headers.filter((header) => !/^(from|sender|message-id|reply-to)$/i.test(header.key))
    : Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(
          ([key]) => !/^(from|sender|message-id|reply-to)$/i.test(key),
        ),
      );
  return {
    ...options,
    headers,
    from: {
      name: `${tenant.brandName.replace(/\p{Cc}/gu, " ").trim()} Support`,
      address: `notifications@${domain}`,
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
) {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { brandName: true, slug: true },
  });
  const message = tenantMailOptions(tenant, options);
  await reserveTenantBudget(tx, tenantId, "outbound");
  let result;
  try {
    result = await mail.sendMail(message);
  } catch (error) {
    await tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status,last_error) VALUES(${tenantId}::uuid,'transactional','failed','SMTP delivery failed')`;
    throw error;
  }
  await tx.$executeRaw`INSERT INTO tenant_mail_deliveries(tenant_id,kind,status) VALUES(${tenantId}::uuid,'transactional','sent')`;
  return result;
}
