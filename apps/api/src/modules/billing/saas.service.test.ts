import { afterEach, describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { Database } from "../../database.js";
import { decryptSecret } from "../../mfa.js";
import { SaasService } from "./saas.service.js";

const keys = [
  "NODE_ENV",
  "PLATFORM_MODE",
  "APP_BASE_DOMAIN",
  "CAPTCHA_MODE",
  "PUBLIC_SITE_ORIGIN",
  "MFA_ENCRYPTION_KEY",
];

describe("SaaS signup", () => {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function setup(captcha = "test-valid") {
    process.env.NODE_ENV = "test";
    process.env.PLATFORM_MODE = "hosted";
    process.env.APP_BASE_DOMAIN = "astrama.test";
    process.env.CAPTCHA_MODE = "test";
    process.env.PUBLIC_SITE_ORIGIN = "https://astrama.test";
    process.env.MFA_ENCRYPTION_KEY = "a".repeat(64);
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { id: "a3ec06c0-034e-4de4-bc26-708f26bb33ab", slug: "acme-service-desk" },
        ]),
      publicMailOutbox: { create: vi.fn().mockResolvedValue({}) },
      signupProvisionJob: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ attempts: 1 }]),
      $transaction: vi.fn((callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
      billingPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as Database;
    return {
      service: new SaasService(db),
      db: db as unknown as { $transaction: ReturnType<typeof vi.fn> },
      tx,
      body: {
        slug: "acme-service-desk",
        companyName: "Acme Service Desk",
        adminName: "A. Admin",
        adminEmail: "Admin@acme.example",
        timezone: "Australia/Sydney",
        captcha,
      },
    };
  }

  it("requires a verified CAPTCHA before reserving a slug", async () => {
    const { service, db, body } = setup("not-solved");
    await expect(service.beginSignup(body, "192.0.2.2")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("commits the slug reservation and encrypted verification email together", async () => {
    const { service, db, tx, body } = setup();
    await expect(service.beginSignup(body, "192.0.2.3")).resolves.toMatchObject({ accepted: true });
    expect(db.$transaction).toHaveBeenCalledOnce();
    const mail = tx.publicMailOutbox.create.mock.calls[0]![0] as {
      data: { encryptedUrl: string; identity: string; recipient: string };
    };
    const url = decryptSecret(mail.data.encryptedUrl, mail.data.identity);
    expect(mail.data.recipient).toBe("admin@acme.example");
    expect(url).toMatch(/^https:\/\/astrama\.test\/signup\/verify\?token=/);
  });

  it("records email verification and its provisioning job in one transaction", async () => {
    const { service, db, tx } = setup();
    await expect(service.verifySignup({ token: "v".repeat(43) })).resolves.toMatchObject({
      accepted: true,
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.signupProvisionJob.upsert).toHaveBeenCalledOnce();
  });
});
