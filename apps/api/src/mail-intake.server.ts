import { SMTPServer } from "smtp-server";
import { z } from "zod";
import {
  MailIntakeFormatError,
  normalizeSmtpMessage,
  type MailIntakeTestOptions,
} from "./mail-intake.adapter.js";
import type { InboundMessageInput } from "./modules/inbound-mail/inbound-mail.adapter.js";

export interface MailIntakeOptions {
  resolveRecipient: (fullEnvelopeRecipient: string) => Promise<boolean>;
  accept: (message: InboundMessageInput) => Promise<unknown>;
  name?: string;
  key?: Buffer;
  cert?: Buffer;
  maxMessageBytes?: number;
  maxClients?: number;
  maxConnectionsPerIp?: number;
  maxConnectionsPerSender?: number;
  messagesPerIpPerMinute?: number;
  messagesPerSenderPerMinute?: number;
  maxTrackedKeys?: number;
  trustedTestOptions?: MailIntakeTestOptions;
  onRejected?: () => void;
}

export function createMailIntakeServer(options: MailIntakeOptions): SMTPServer {
  function smtpError(responseCode: number, message: string) {
    try {
      options.onRejected?.();
    } catch {
      /* Metrics never alter SMTP handling. */
    }
    return Object.assign(new Error(message), { responseCode });
  }
  const maxMessageBytes = options.maxMessageBytes ?? 8 * 1024 * 1024;
  const maxClients = options.maxClients ?? 100;
  const maxTrackedKeys = options.maxTrackedKeys ?? 10_000;
  const connections = new Map<string, string>();
  const senders = new Map<string, string>();
  const rates = new Map<string, { count: number; expires: number }>();
  const limits = {
    maxMessageBytes,
    maxClients,
    maxTrackedKeys,
    connectionsPerIp: options.maxConnectionsPerIp ?? 5,
    connectionsPerSender: options.maxConnectionsPerSender ?? 5,
    messagesPerIp: options.messagesPerIpPerMinute ?? 60,
    messagesPerSender: options.messagesPerSenderPerMinute ?? 30,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid mail intake limit");
  }
  if (!!options.key !== !!options.cert)
    throw new Error("Both SMTP TLS key and certificate required");

  function rateAllowed(key: string, limit: number) {
    const now = Date.now();
    const prior = rates.get(key);
    if (prior && prior.expires > now) return ++prior.count <= limit;
    if (rates.size >= maxTrackedKeys) {
      for (const [entry, value] of rates) if (value.expires <= now) rates.delete(entry);
    }
    // Fail closed at capacity; evicting live limits lets rotating senders bypass them.
    if (!rates.has(key) && rates.size >= maxTrackedKeys) return false;
    rates.set(key, { count: 1, expires: now + 60_000 });
    return true;
  }

  const mailbox = z.string().max(254).email();
  return new SMTPServer({
    name: options.name,
    size: maxMessageBytes,
    maxClients,
    logger: false,
    authOptional: true,
    disabledCommands: options.key ? ["AUTH"] : ["AUTH", "STARTTLS"],
    ...(options.key ? { key: options.key, cert: options.cert, minVersion: "TLSv1.2" } : {}),
    disableReverseLookup: true,
    socketTimeout: 60_000,
    closeTimeout: 5_000,
    onConnect(session, callback) {
      const count = [...connections.values()].filter((ip) => ip === session.remoteAddress).length;
      if (connections.size >= maxClients || count >= limits.connectionsPerIp) {
        return callback(smtpError(421, "Too many connections; retry later"));
      }
      connections.set(session.id, session.remoteAddress);
      callback();
    },
    onClose(session) {
      connections.delete(session.id);
      senders.delete(session.id);
    },
    onMailFrom(address, session, callback) {
      senders.delete(session.id);
      const sender = address.address.toLowerCase();
      if (sender && !mailbox.safeParse(sender).success) {
        return callback(smtpError(553, "Invalid sender address"));
      }
      const count = [...senders.values()].filter((value) => value === sender).length;
      if (
        count >= limits.connectionsPerSender ||
        !rateAllowed(`ip:${session.remoteAddress}`, limits.messagesPerIp) ||
        !rateAllowed(`sender:${sender}`, limits.messagesPerSender)
      ) {
        return callback(smtpError(451, "Mail rate limit reached; retry later"));
      }
      senders.set(session.id, sender);
      callback();
    },
    onRcptTo(address, session, callback) {
      if (!mailbox.safeParse(address.address).success) {
        return callback(smtpError(550, "Recipient unavailable"));
      }
      if (session.envelope.rcptTo.length >= 100) {
        return callback(smtpError(452, "Too many recipients"));
      }
      void Promise.resolve()
        .then(() => options.resolveRecipient(address.address))
        .then(
          (known) => callback(known ? undefined : smtpError(550, "Recipient unavailable")),
          () => callback(smtpError(451, "Recipient lookup unavailable; retry later")),
        );
    },
    onData(stream, session, callback) {
      let chunks: Buffer[] = [];
      let bytes = 0;
      let completed = false;
      const finish = (error?: Error) => {
        if (completed) return;
        completed = true;
        chunks = [];
        callback(error, error ? undefined : "Message accepted");
      };
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxMessageBytes) chunks = [];
        else chunks.push(chunk);
      });
      stream.once("error", () => finish(smtpError(451, "Message transfer failed; retry later")));
      stream.once("end", () => {
        if (completed) return;
        if (bytes > maxMessageBytes || stream.sizeExceeded) {
          return finish(smtpError(552, "Message exceeds size limit"));
        }
        const raw = Buffer.concat(chunks);
        chunks = [];
        const recipients = [
          ...new Set(session.envelope.rcptTo.map((address) => address.address.toLowerCase())),
        ];
        void (async () => {
          let message: InboundMessageInput;
          try {
            message = await normalizeSmtpMessage(
              raw,
              {
                recipient: recipients[0]!,
                sender: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
                ip: session.remoteAddress,
                helo: session.hostNameAppearsAs,
              },
              options.trustedTestOptions,
            );
          } catch (error) {
            return finish(
              error instanceof z.ZodError || error instanceof MailIntakeFormatError
                ? smtpError(554, "Message format is invalid or exceeds field limits")
                : smtpError(451, "Message verification unavailable; retry later"),
            );
          }
          try {
            // Existing tenant/message-id deduplication makes partial delivery retries safe.
            for (const recipient of recipients) await options.accept({ ...message, recipient });
            finish();
          } catch {
            finish(smtpError(451, "Message intake unavailable; retry later"));
          }
        })();
      });
    },
  });
}
