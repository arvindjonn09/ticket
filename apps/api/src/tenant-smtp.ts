import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import { domainToASCII } from "node:url";
import { createTransport, type Transporter, type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { transactionRemainingMs, type Tx } from "./database.js";
import { decryptSecret } from "./mfa.js";
import { microsoft365Token, OutgoingMailError } from "./microsoft365-mail.js";
import { MailDeadline, currentMailDeadline, withMailDeadline } from "./mail-deadline.js";

export type TenantSmtpSettings = {
  tenant_id: string;
  revision: number;
  mode: "platform" | "smtp" | "microsoft365";
  status: "working" | "problem";
  provider: "smtp" | "google" | "microsoft365" | null;
  host: string | null;
  port: 465 | 587 | 25 | 2525 | null;
  security: "tls" | "starttls" | null;
  username: string | null;
  from_address: string | null;
  encrypted_secret: string | null;
  account_id: string | null;
  configured_by_id: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  tested_at: Date | null;
  notice_pending_at: Date | null;
  notice_sent_at: Date | null;
  notice_attempts: number;
  notice_next_attempt_at: Date;
};
const denied = new BlockList(),
  globalV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(network, prefix, "ipv4");
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  denied.addSubnet(network, prefix, "ipv6");
export function publicSmtpIp(ip: string) {
  const family = isIP(ip);
  return family === 4
    ? !denied.check(ip, "ipv4")
    : family === 6 && globalV6.check(ip, "ipv6") && !denied.check(ip, "ipv6");
}
function serviceHosts() {
  const network = [process.env.CLAMAV_HOST];
  for (const input of [
    process.env.DATABASE_URL,
    process.env.MIGRATION_DATABASE_URL,
    process.env.S3_ENDPOINT,
  ]) {
    try {
      if (input) network.push(new URL(input).hostname.replace(/^\[|\]$/g, ""));
    } catch {
      /* Invalid service URLs never become SMTP input. */
    }
  }
  const denied = [...network];
  for (const input of [
    process.env.PUBLIC_SITE_ORIGIN,
    process.env.OPERATOR_ORIGIN,
    process.env.APP_ORIGIN,
  ]) {
    try {
      if (input) denied.push(new URL(input).hostname.replace(/^\[|\]$/g, ""));
    } catch {
      /* Origin validation belongs to platform startup. */
    }
  }
  const normalized = (hosts: (string | undefined)[]) => [
    ...new Set(hosts.filter((host): host is string => !!host).map((host) => host.toLowerCase())),
  ];
  return { denied: normalized(denied), network: normalized(network) };
}
export async function resolveSmtpTarget(input: string, resolver: typeof lookup = lookup) {
  const stripped = input.trim().replace(/^\[|\]$/g, "");
  const host = (isIP(stripped) ? stripped : domainToASCII(stripped))
    .toLowerCase()
    .replace(/\.$/, "");
  const ownHosts = serviceHosts();
  if (
    !host ||
    ownHosts.denied.includes(host) ||
    (!isIP(host) && (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)))
  )
    throw new OutgoingMailError("address");
  let timer: NodeJS.Timeout | undefined;
  try {
    const resolve = async (name: string) =>
      isIP(name)
        ? [{ address: name, family: isIP(name) }]
        : resolver(name, { all: true, verbatim: true });
    const [addresses, services] = await Promise.race([
      Promise.all([
        resolve(host),
        Promise.all(ownHosts.network.map(resolve)).then((groups) => groups.flat()),
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OutgoingMailError("connection")), 5000);
        timer.unref();
      }),
    ]);
    const serviceIps = new Set(services.map((item) => item.address));
    if (
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some((item) => !publicSmtpIp(item.address) || serviceIps.has(item.address))
    )
      throw new OutgoingMailError("address");
    return { host, address: addresses[0]!.address };
  } catch (error) {
    if (error instanceof OutgoingMailError) throw error;
    throw new OutgoingMailError("connection");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function safeSmtpTransport(
  settings: Pick<TenantSmtpSettings, "host" | "port" | "security" | "username">,
  password?: string,
) {
  const host = settings.host!,
    port = settings.port!;
  const mail: Transporter = createTransport({
    host,
    port,
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    tls: { servername: host, minVersion: "TLSv1.2", rejectUnauthorized: true },
    ...(password !== undefined ? { auth: { user: settings.username!, pass: password } } : {}),
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
    getSocket(
      _options: unknown,
      callback: (error: Error | null, value?: { connection: Socket; secured: boolean }) => void,
    ) {
      const inherited = currentMailDeadline();
      const deadline = inherited ?? new MailDeadline();
      let socket: Socket | undefined,
        returned = false;
      const cleanup = () => {
        deadline.signal.removeEventListener("abort", abort);
        if (!inherited) deadline.close();
      };
      const finish = (error: Error | null) => {
        if (returned) return;
        returned = true;
        if (error) {
          socket?.destroy();
          cleanup();
        }
        callback(
          error,
          error ? undefined : { connection: socket!, secured: settings.security === "tls" },
        );
      };
      const abort = () => {
        const error = new OutgoingMailError("connection");
        socket?.destroy(error);
        finish(error);
      };
      deadline.signal.addEventListener("abort", abort, { once: true });
      void deadline
        .run(() => resolveSmtpTarget(host))
        .then(
          ({ host: servername, address }) => {
            try {
              // A timed-out DNS lookup must never open a socket when it finally returns.
              deadline.check();
              socket =
                settings.security === "tls"
                  ? connectTls({
                      host: address,
                      port,
                      servername,
                      minVersion: "TLSv1.2",
                      rejectUnauthorized: true,
                    })
                  : connect({ host: address, port });
              const failed = () =>
                finish(new OutgoingMailError(settings.security === "tls" ? "tls" : "connection"));
              socket.setTimeout(5000, failed);
              socket.once("error", failed);
              socket.once("close", cleanup);
              socket.once(settings.security === "tls" ? "secureConnect" : "connect", () => {
                socket!.setTimeout(0);
                finish(null);
              });
            } catch (error) {
              finish(error instanceof Error ? error : new OutgoingMailError("connection"));
            }
          },
          (error: unknown) =>
            finish(error instanceof Error ? error : new OutgoingMailError("connection")),
        );
    },
  } as SMTPTransport.Options);
  const send = mail.sendMail.bind(mail);
  mail.sendMail = (async (options: SendMailOptions) =>
    withMailDeadline(undefined, (deadline) =>
      deadline.run(() => send(options)),
    )) as Transporter["sendMail"];
  return mail;
}
type Entry = {
  revision: number;
  mail: Transporter;
  timer?: NodeJS.Timeout;
  inFlight: number;
  retired: boolean;
};
const transports = new Map<string, Entry>();
export function closeTenantSmtp(tenantId: string) {
  const entry = transports.get(tenantId);
  if (!entry) return;
  transports.delete(tenantId);
  entry.retired = true;
  if (entry.timer) clearTimeout(entry.timer);
  if (!entry.inFlight) entry.mail.close();
}
export async function sendOwnSmtp(tx: Tx, settings: TenantSmtpSettings, message: SendMailOptions) {
  return withMailDeadline(tx, async (deadline) => {
    let entry = transports.get(settings.tenant_id);
    if (entry?.revision !== settings.revision) {
      closeTenantSmtp(settings.tenant_id);
      entry = undefined;
    }
    if (!entry) {
      if (transports.size >= 100) closeTenantSmtp(transports.keys().next().value!);
      const password =
        settings.mode === "smtp"
          ? decryptSecret(settings.encrypted_secret!, `smtp:${settings.tenant_id}`)
          : undefined;
      entry = {
        revision: settings.revision,
        mail: safeSmtpTransport(settings, password),
        inFlight: 0,
        retired: false,
      };
      transports.set(settings.tenant_id, entry);
    }
    const selected = entry;
    if (selected.timer) clearTimeout(selected.timer);
    selected.inFlight++;
    try {
      const auth =
        settings.mode === "microsoft365"
          ? {
              type: "OAuth2" as const,
              user: settings.username!,
              accessToken: await microsoft365Token(tx, settings),
            }
          : undefined;
      deadline.check();
      return await deadline.run(() =>
        selected.mail.sendMail({ ...message, ...(auth ? { auth } : {}) }),
      );
    } finally {
      selected.inFlight--;
      if (selected.retired && !selected.inFlight) selected.mail.close();
      if (!selected.retired && !selected.inFlight) {
        selected.timer = setTimeout(() => closeTenantSmtp(settings.tenant_id), 60000);
        selected.timer.unref();
      }
    }
  });
}

export async function outgoingSettings(tx: Tx, tenantId: string, lock = false) {
  if (lock && Number.isFinite(transactionRemainingMs(tx))) {
    const wait = `${Math.max(1, Math.floor(transactionRemainingMs(tx) - 2500))}ms`;
    await tx.$executeRaw`SELECT set_config('lock_timeout',${wait},true)`;
  }
  const rows = lock
    ? await tx.$queryRaw<
        TenantSmtpSettings[]
      >`SELECT * FROM tenant_outgoing_mail WHERE tenant_id=${tenantId}::uuid FOR UPDATE`
    : await tx.$queryRaw<
        TenantSmtpSettings[]
      >`SELECT * FROM tenant_outgoing_mail WHERE tenant_id=${tenantId}::uuid`;
  return rows[0] ?? null;
}
