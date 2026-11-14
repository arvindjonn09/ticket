import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const attachmentSchema = z
  .object({
    filename: z.string().trim().min(1).max(180),
    contentType: z.string().max(120).default("application/octet-stream"),
    contentBase64: z.string().max(7_100_000),
  })
  .strict();

export const inboundMessageSchema = z
  .object({
    kind: z.enum(["delivery", "bounce"]).default("delivery"),
    messageId: z.string().trim().min(1).max(255),
    recipient: email,
    sender: email,
    inReplyTo: z.string().trim().max(255).optional(),
    references: z.array(z.string().trim().min(1).max(255)).max(20).default([]),
    bounceFor: z.string().trim().max(255).optional(),
    subject: z.string().max(998).default(""),
    text: z.string().max(50000).default(""),
    html: z.string().max(100000).optional(),
    headers: z
      .object({
        autoSubmitted: z.string().max(120).optional(),
        precedence: z.string().max(120).optional(),
      })
      .strict()
      .default({}),
    authResults: z
      .object({
        spf: z.enum(["pass", "fail", "none"]),
        dkim: z.enum(["pass", "fail", "none"]),
        dmarc: z.enum(["pass", "fail", "none"]),
      })
      .strict(),
    attachments: z.array(attachmentSchema).max(10).default([]),
  })
  .strict();

export type InboundMessageInput = z.infer<typeof inboundMessageSchema>;

export class TestInboundAdapter {
  static normalize(input: unknown): InboundMessageInput {
    return inboundMessageSchema.parse(input);
  }
}

export function recipientAddress(recipient: string) {
  const at = recipient.lastIndexOf("@");
  const local = recipient.slice(0, at);
  const token = local.match(/\+t\.([A-Za-z0-9_-]{32,64})$/i)?.[1];
  return {
    address: token
      ? `${local.slice(0, local.lastIndexOf("+t."))}@${recipient.slice(at + 1)}`
      : recipient,
    token,
  };
}

export function senderHash(sender: string) {
  return createHash("sha256").update(sender.trim().toLowerCase()).digest("hex");
}

export function webhookSignature(timestamp: string, input: unknown, secret: string) {
  const message = TestInboundAdapter.normalize(input);
  return createHmac("sha256", secret)
    .update(`${timestamp}.${JSON.stringify(message)}`)
    .digest("hex");
}

export function validWebhookSignature(
  timestamp: string,
  input: InboundMessageInput,
  signature: string,
  secret: string,
  now = Date.now(),
) {
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const received = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
  const expected = Buffer.from(webhookSignature(timestamp, input, secret), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function replyTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function notificationDeliveryId(messageId: string) {
  const id = messageId.trim().replace(/^</, "").replace(/>$/, "").split("@", 1)[0];
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export function isLoopMessage(
  message: InboundMessageInput,
  ownAddresses: readonly string[],
  appHost: string,
) {
  const autoSubmitted = message.headers.autoSubmitted?.trim().toLowerCase() ?? "";
  const precedence = message.headers.precedence?.trim().toLowerCase() ?? "";
  const id = message.messageId.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
  return (
    autoSubmitted.startsWith("auto-") ||
    /^(bulk|junk|list|auto_reply)$/.test(precedence) ||
    ownAddresses.includes(message.sender) ||
    id.endsWith("@astrama.local") ||
    (!!appHost && id.endsWith(`@${appHost.toLowerCase()}`))
  );
}
