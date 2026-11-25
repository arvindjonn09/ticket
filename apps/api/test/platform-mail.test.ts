import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformTransport,
  platformInboundAddress,
  platformMailDomain,
  tenantMailOptions,
} from "../src/platform-mail.js";
import {
  isLoopMessage,
  type InboundMessageInput,
} from "../src/modules/inbound-mail/inbound-mail.adapter.js";

afterEach(() => vi.unstubAllEnvs());

describe("platform mail identity", () => {
  const env = {
    PLATFORM_MAIL_DOMAIN: "mail.example.test",
    PLATFORM_MODE: "hosted",
    APP_BASE_DOMAIN: "example.test",
  };

  it("uses the tenant brand, platform domain and delivery Reply-To without conflicting headers", () => {
    const options = tenantMailOptions(
      { brandName: 'Acme, "Help"\r\nBcc: fake@example.test', slug: "acme" },
      {
        from: "other@customer.test",
        to: "user@example.test",
        replyTo: "acme+it+t.secret@in.example.test",
        messageId: "<delivery-id@tenant.example.test>",
        headers: {
          From: "other@customer.test",
          "Message-ID": "<wrong@tenant.test>",
          "Reply-To": "wrong@tenant.test",
          References: "<original@customer.test>",
        },
      },
      env,
    );
    expect(options.from).toEqual({
      name: 'Acme, "Help"  Bcc: fake@example.test Support',
      address: "notifications@mail.example.test",
    });
    expect(options.replyTo).toBe("acme+it+t.secret@in.example.test");
    expect(options.messageId).toBe("<delivery-id@mail.example.test>");
    expect(options.headers).toEqual({
      References: "<original@customer.test>",
      "Auto-Submitted": "auto-generated",
    });
  });

  it("marks own-domain notifications as automatic so a forwarded copy cannot create another ticket", () => {
    for (const headers of [{ "auto-submitted": "no" }, [{ key: "Auto-Submitted", value: "no" }]]) {
      const message = tenantMailOptions(
        { brandName: "Acme", slug: "acme" },
        { headers },
        {
          ...env,
          PLATFORM_MAIL_DOMAIN: "customer.test",
          PLATFORM_PROFILE_FROM: "support@customer.test",
        },
      );
      const automatic = Array.isArray(message.headers)
        ? message.headers.find((header) => header.key === "Auto-Submitted")?.value
        : message.headers?.["Auto-Submitted"];
      expect(automatic).toBe("auto-generated");
      expect(
        isLoopMessage(
          {
            messageId: message.messageId!,
            sender: "support@customer.test",
            headers: { autoSubmitted: automatic as string },
          } as InboundMessageInput,
          ["acme@in.example.test"],
          "app.example.test",
        ),
      ).toBe(true);
    }
  });

  it("uses each tenant's inbound alias for mail without ticket correlation", () => {
    for (const slug of ["acme", "other"]) {
      const message = tenantMailOptions({ brandName: slug, slug }, {}, env);
      expect(message.replyTo).toBe(`${slug}@in.example.test`);
      expect(message.messageId).toMatch(/^<[a-f0-9-]+@mail\.example\.test>$/);
    }
    expect(
      platformInboundAddress("acme", { ...env, INBOUND_MAIL_DOMAIN: "replies.example.test" }),
    ).toBe("acme@replies.example.test");
    expect(platformInboundAddress("acme", { APP_BASE_DOMAIN: "example.test" })).toBeUndefined();
  });

  it("derives the configured sender domain and refuses invalid mail domains or tenant aliases", () => {
    expect(platformMailDomain({ SMTP_FROM: '"Astrama" <desk@example.test>' })).toBe("example.test");
    expect(platformMailDomain({ PLATFORM_MAIL_DOMAIN: "", SMTP_FROM: "desk@example.test" })).toBe(
      "example.test",
    );
    expect(platformInboundAddress("acme", { ...env, INBOUND_MAIL_DOMAIN: "" })).toBe(
      "acme@in.example.test",
    );
    for (const domain of [
      "",
      "evil.test/path",
      "bad@evil.test",
      "bad..test",
      "evil.test\r\nBcc: x",
    ]) {
      expect(() => platformMailDomain({ PLATFORM_MAIL_DOMAIN: domain })).toThrow(
        "Invalid platform mail domain",
      );
    }
    expect(() => platformInboundAddress("bad+tenant", env)).toThrow("Invalid tenant mail address");
  });
});

it("shares authenticated TLS transport settings and keeps local Mailpit plaintext available", () => {
  vi.stubEnv("SMTP_HOST", "smtp.example.test");
  vi.stubEnv("SMTP_PORT", "587");
  vi.stubEnv("SMTP_USER", "smtp-user");
  vi.stubEnv("SMTP_PASSWORD", "smtp-password");
  vi.stubEnv("SMTP_SECURE", "false");
  vi.stubEnv("NODE_ENV", "production");
  const starttls = createPlatformTransport();
  expect(starttls.options).toMatchObject({
    host: "smtp.example.test",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: "smtp-user", pass: "smtp-password" },
  });
  starttls.close();
  vi.stubEnv("SMTP_SECURE", "true");
  const tls = createPlatformTransport();
  expect(tls.options).toMatchObject({ secure: true, requireTLS: false });
  tls.close();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SMTP_SECURE", "false");
  const local = createPlatformTransport();
  expect(local.options).toMatchObject({ secure: false, requireTLS: false });
  local.close();
});
