import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSmtpMessage } from "../src/mail-intake.adapter.js";
import { createMailIntakeServer, type MailIntakeOptions } from "../src/mail-intake.server.js";
import {
  recipientAddress,
  type InboundMessageInput,
} from "../src/modules/inbound-mail/inbound-mail.adapter.js";

const domain = "sender.example.com";
const from = `author@${domain}`;
const recipient = "acme@in.example.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function resolver(spf = "v=spf1 ip4:127.0.0.1 -all") {
  return async (name: string, type: string): Promise<string[][] | string[]> => {
    if (type === "TXT") {
      if (name === domain) return [[spf]];
      if (name === `_dmarc.${domain}`) return [["v=DMARC1; p=reject"]];
      if (name === `test._domainkey.${domain}`) return [[`v=DKIM1; k=rsa; p=${publicDer}`]];
    }
    throw Object.assign(new Error("DNS record absent"), { code: "ENODATA" });
  };
}

function rawMessage(extraHeaders = "", body = "Please help") {
  return Buffer.from(
    `From: Author <${from}>\r\nTo: other-tenant@in.example.com\r\n` +
      "Message-ID: <fixture@sender.example.com>\r\nSubject: Help\r\n" +
      `${extraHeaders}\r\n${body}\r\n`,
  );
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(overrides: Partial<MailIntakeOptions> = {}) {
  const accept = vi.fn(async (_message: InboundMessageInput) => undefined);
  const resolveRecipient = vi.fn(async (address: string) => address === recipient);
  const server = createMailIntakeServer({
    accept,
    resolveRecipient,
    trustedTestOptions: { resolver: resolver() },
    ...overrides,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(resolve)));
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener port");
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: address.port,
    ignoreTLS: true,
  });
  cleanups.push(async () => transport.close());
  const send = (raw = rawMessage(), to: string | string[] = recipient, sender = from) =>
    transport.sendMail({ envelope: { from: sender, to }, raw });
  return { server, port: address.port, send, accept, resolveRecipient };
}

describe("EM-01 real SMTP intake", () => {
  it("refuses an unknown envelope recipient with 550 during RCPT, without relaying", async () => {
    const { send, accept } = await listen();
    await expect(send(rawMessage(), "unknown@example.com")).rejects.toMatchObject({
      responseCode: 550,
      command: "RCPT TO",
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("refuses an actual oversize DATA transfer with 552 before persistence", async () => {
    const { send, accept } = await listen({ maxMessageBytes: 1024 });
    await expect(send(rawMessage("", "x".repeat(4096)))).rejects.toMatchObject({
      responseCode: 552,
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("verifies a generated RSA DKIM fixture using DNS and preserves the MIME sender", async () => {
    const signed = await nodemailer
      .createTransport({
        streamTransport: true,
        buffer: true,
        dkim: { domainName: domain, keySelector: "test", privateKey: privatePem },
      })
      .sendMail({ from, to: "untrusted-header@example.com", subject: "Signed", text: "Help" });
    const { send, accept } = await listen();
    await send(signed.message as Buffer);
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: from,
        recipient,
        authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
      }),
    );
  });

  it("normalizes forwarded SPF failure with original DKIM and DMARC success as verified", async () => {
    const signed = await nodemailer
      .createTransport({
        streamTransport: true,
        buffer: true,
        dkim: { domainName: domain, keySelector: "test", privateKey: privatePem },
      })
      .sendMail({ from, to: recipient, subject: "Forwarded", text: "Help" });
    const { send, accept } = await listen({
      trustedTestOptions: { resolver: resolver("v=spf1 ip4:192.0.2.1 -all") },
    });
    await send(signed.message as Buffer);
    expect(accept.mock.calls[0]?.[0].authResults).toEqual({
      spf: "fail",
      dkim: "pass",
      dmarc: "pass",
    });
  });

  it("ignores forged Authentication-Results and Received headers; spoofed From fails DMARC", async () => {
    const { send, accept } = await listen({
      trustedTestOptions: { resolver: resolver("v=spf1 ip4:192.0.2.1 -all") },
    });
    await send(
      rawMessage(
        "Authentication-Results: trusted.example; spf=pass; dkim=pass; dmarc=pass\r\n" +
          "Return-Path: trusted@sender.example.com\r\n" +
          "Received: from trusted.example (trusted.example [192.0.2.1]) by intake.example; Tue, 24 Nov 2026 00:00:00 +0000\r\n",
      ),
    );
    expect(accept.mock.calls[0]?.[0].authResults).toEqual({
      spf: "fail",
      dkim: "none",
      dmarc: "fail",
    });
  });

  it("routes each known envelope RCPT, preserving department and reply-token separators", async () => {
    const department = "acme+it@in.example.com";
    const reply = `acme+it+t.${"a".repeat(64)}@in.example.com`;
    const seen: string[] = [];
    const { send, accept } = await listen({
      resolveRecipient: async (address) => {
        seen.push(address);
        return [recipient, department].includes(recipientAddress(address).address);
      },
    });
    await send(rawMessage(), [recipient, department, reply]);
    expect(seen).toEqual([recipient, department, reply]);
    expect(accept.mock.calls.map((call) => call[0].recipient)).toEqual([
      recipient,
      department,
      reply,
    ]);
  });

  it("returns a sanitized 451 when persistence or recipient lookup fails", async () => {
    const { send } = await listen({
      accept: async () => {
        throw new Error("secret password and message body");
      },
    });
    await expect(send()).rejects.toMatchObject({
      responseCode: 451,
      response: expect.not.stringContaining("secret"),
    });
    const other = await listen({
      resolveRecipient: async () => {
        throw new Error("secret database credentials");
      },
    });
    await expect(other.send()).rejects.toMatchObject({
      responseCode: 451,
      response: expect.not.stringContaining("secret"),
    });
  });

  it("enforces the per-sender message rate across separate SMTP connections", async () => {
    const { send, accept } = await listen({ messagesPerSenderPerMinute: 1 });
    await send();
    await expect(send()).rejects.toMatchObject({ responseCode: 451 });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it("enforces per-IP message rates and refuses new keys when the bounded tracker is full", async () => {
    const limited = await listen({ messagesPerIpPerMinute: 1 });
    await limited.send();
    await expect(
      limited.send(rawMessage(), recipient, "other@sender.example.com"),
    ).rejects.toMatchObject({ responseCode: 451 });
    const bounded = await listen({ maxTrackedKeys: 2 });
    await bounded.send();
    await expect(
      bounded.send(rawMessage(), recipient, "other@sender.example.com"),
    ).rejects.toMatchObject({ responseCode: 451 });
  });

  it("limits concurrent connections from one IP and does not advertise SMTP AUTH", async () => {
    const { port, send } = await listen({ maxConnectionsPerIp: 1 });
    const socket = createConnection({ host: "127.0.0.1", port });
    cleanups.push(async () => socket.destroy());
    await once(socket, "data");
    socket.write("EHLO fixture.example\r\n");
    const [response] = await once(socket, "data");
    expect(response.toString()).not.toContain("AUTH");
    expect(response.toString()).not.toContain("STARTTLS");
    await expect(send()).rejects.toMatchObject({ responseCode: 421 });
  });

  it("limits concurrent MAIL FROM sessions for the same sender", async () => {
    const { port, send } = await listen({ maxConnectionsPerSender: 1 });
    const socket = createConnection({ host: "127.0.0.1", port });
    cleanups.push(async () => socket.destroy());
    await once(socket, "data");
    socket.write("EHLO fixture.example\r\n");
    await once(socket, "data");
    socket.write(`MAIL FROM:<${from}>\r\n`);
    const [response] = await once(socket, "data");
    expect(response.toString()).toMatch(/^250/);
    await expect(send()).rejects.toMatchObject({ responseCode: 451 });
  });

  it("refuses malformed normalized messages with 554 without persisting", async () => {
    const { send, accept } = await listen();
    await expect(
      send(Buffer.from(`From: ${from}\r\n\r\nMissing message ID`)),
    ).rejects.toMatchObject({ responseCode: 554 });
    expect(accept).not.toHaveBeenCalled();
  });
});

describe("SMTP MIME bounds", () => {
  const envelope = { recipient, sender: from, ip: "127.0.0.1", helo: "sender.example.com" };

  it("parses MIME attachments, References and automatic-message headers", async () => {
    const message = await nodemailer
      .createTransport({ streamTransport: true, buffer: true })
      .sendMail({
        from,
        to: recipient,
        messageId: "<mime@sender.example.com>",
        inReplyTo: "<prior@sender.example.com>",
        references: ["<first@sender.example.com>", "<prior@sender.example.com>"],
        headers: { "Auto-Submitted": "auto-replied", Precedence: "bulk" },
        subject: "MIME",
        text: "Text",
        html: "<p>Text</p>",
        attachments: [{ filename: "proof.txt", content: "evidence", contentType: "text/plain" }],
      });
    const normalized = await normalizeSmtpMessage(message.message as Buffer, envelope, {
      resolver: resolver(),
    });
    expect(normalized).toMatchObject({
      inReplyTo: "<prior@sender.example.com>",
      references: ["<first@sender.example.com>", "<prior@sender.example.com>"],
      headers: { autoSubmitted: "auto-replied", precedence: "bulk" },
      attachments: [
        {
          filename: "proof.txt",
          contentType: "text/plain",
          contentBase64: Buffer.from("evidence").toString("base64"),
        },
      ],
    });
  });

  it("rejects missing IDs, multiple From mailboxes and text beyond the shared schema limit", async () => {
    for (const raw of [
      Buffer.from(`From: ${from}\r\n\r\nNo message ID`),
      Buffer.from(
        `From: ${from}, second@sender.example.com\r\nMessage-ID: <bad@example.com>\r\n\r\nAmbiguous`,
      ),
      rawMessage(`From: second@sender.example.com\r\n`),
      rawMessage("", "x".repeat(50_001)),
    ]) {
      await expect(normalizeSmtpMessage(raw, envelope, { resolver: resolver() })).rejects.toThrow();
    }
  });
});
