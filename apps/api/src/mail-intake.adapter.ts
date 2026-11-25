import { authenticate, type DNSResolver } from "mailauth";
import { simpleParser } from "mailparser";
import {
  inboundMessageSchema,
  type InboundMessageInput,
} from "./modules/inbound-mail/inbound-mail.adapter.js";

export interface MailIntakeEnvelope {
  recipient: string;
  sender: string;
  ip: string;
  helo: string;
}

/** Trusted process configuration only; never populate this from message headers. */
export interface MailIntakeTestOptions {
  resolver?: DNSResolver;
}

export class MailIntakeFormatError extends Error {}

function authStatus(value: string | undefined): "pass" | "fail" | "none" {
  if (value === "pass") return "pass";
  return !value || value === "none" ? "none" : "fail";
}

export async function normalizeSmtpMessage(
  raw: Buffer,
  envelope: MailIntakeEnvelope,
  trustedTestOptions: MailIntakeTestOptions = {},
): Promise<InboundMessageInput> {
  const parsed = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    maxHtmlLengthToParse: 100_000,
  });
  // Multiple author fields/mailboxes are ambiguous even when they share a domain.
  if (
    parsed.headerLines.filter((header) => header.key === "from").length !== 1 ||
    parsed.from?.value.length !== 1 ||
    !parsed.from.value[0]?.address
  ) {
    throw new MailIntakeFormatError("A single author mailbox is required");
  }

  // The untouched DATA bytes and actual SMTP connection define authentication.
  // Authentication-Results, Received and Return-Path supplied by senders confer no trust.
  const auth = await authenticate(raw, {
    ip: envelope.ip,
    helo: envelope.helo,
    sender: envelope.sender,
    trustReceived: false,
    disableBimi: true,
    disableArc: true,
    strict: true,
    maxElapsedTime: 10_000,
    resolver: trustedTestOptions.resolver,
  });
  const dkimResults = auth.dkim.results;
  const references = parsed.references;
  const header = (name: string) => {
    const value = parsed.headers.get(name);
    return typeof value === "string" ? value : undefined;
  };
  return inboundMessageSchema.parse({
    kind: "delivery",
    messageId: parsed.messageId,
    recipient: envelope.recipient,
    sender: parsed.from.value[0].address,
    inReplyTo: parsed.inReplyTo,
    references: typeof references === "string" ? [references] : references,
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    ...(parsed.html === false ? {} : { html: parsed.html }),
    headers: { autoSubmitted: header("auto-submitted"), precedence: header("precedence") },
    authResults: {
      spf: authStatus(auth.spf ? auth.spf.status.result : undefined),
      dkim: dkimResults.some((result) => result.status.result === "pass")
        ? "pass"
        : dkimResults.some((result) => result.status.result !== "none")
          ? "fail"
          : "none",
      dmarc: authStatus(auth.dmarc ? auth.dmarc.status.result : undefined),
    },
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename || "attachment",
      contentType: attachment.contentType,
      contentBase64: attachment.content.toString("base64"),
    })),
  });
}
