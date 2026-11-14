import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { simpleParser } from "mailparser";

const filename = process.argv[2];
if (!filename || !process.env.INBOUND_WEBHOOK_URL || !process.env.INBOUND_WEBHOOK_SECRET) {
  throw new Error(
    "Usage: INBOUND_WEBHOOK_URL=... INBOUND_WEBHOOK_SECRET=... node scripts/send-test-email.mjs file.eml",
  );
}
const parsed = await simpleParser(await readFile(filename));
const sender = parsed.from?.value[0]?.address;
const recipient = parsed.to?.value[0]?.address;
if (!sender || !recipient || !parsed.messageId)
  throw new Error("Email must include From, To, and Message-ID headers");
const header = (name) => parsed.headers.get(name)?.text;
const message = {
  kind: "delivery",
  messageId: parsed.messageId,
  recipient: recipient.toLowerCase(),
  sender: sender.toLowerCase(),
  ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
  references: Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [],
  subject: parsed.subject ?? "",
  text: parsed.text ?? "",
  ...(parsed.html ? { html: String(parsed.html) } : {}),
  headers: {
    ...(header("auto-submitted") ? { autoSubmitted: header("auto-submitted") } : {}),
    ...(header("precedence") ? { precedence: header("precedence") } : {}),
  },
  authResults: {
    spf: process.env.INBOUND_SPF ?? "none",
    dkim: process.env.INBOUND_DKIM ?? "none",
    dmarc: process.env.INBOUND_DMARC ?? "none",
  },
  attachments: (parsed.attachments ?? []).map((attachment) => ({
    filename: attachment.filename ?? "attachment.bin",
    contentType: attachment.contentType ?? "application/octet-stream",
    contentBase64: attachment.content.toString("base64"),
  })),
};
const timestamp = String(Math.floor(Date.now() / 1000));
const canonical = JSON.stringify(message);
const signature = createHmac("sha256", process.env.INBOUND_WEBHOOK_SECRET)
  .update(`${timestamp}.${canonical}`)
  .digest("hex");
const response = await fetch(process.env.INBOUND_WEBHOOK_URL, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-astrama-timestamp": timestamp,
    "x-astrama-signature": signature,
  },
  body: canonical,
});
if (!response.ok) throw new Error(`Inbound webhook returned HTTP ${response.status}`);
console.log("Test email accepted");
