import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { StripePaymentProvider, TestPaymentProvider } from "./payment-provider.js";

const event = {
  id: "evt_123",
  type: "invoice.payment_failed",
  tenantId: "9ee2d631-6229-4c27-9d10-0c4ca658e211",
  planId: "starter-monthly",
  customerId: "cus_123",
  subscriptionId: "sub_123",
  transition: "payment_failed",
};

describe("payment providers", () => {
  afterEach(() => {
    delete process.env.TEST_PAYMENT_WEBHOOK_SECRET;
  });

  it("authenticates test webhooks and validates their event shape", async () => {
    process.env.TEST_PAYMENT_WEBHOOK_SECRET = "test-secret";
    const raw = Buffer.from(JSON.stringify(event));
    const signature = createHmac("sha256", "test-secret").update(raw).digest("hex");
    await expect(new TestPaymentProvider().webhook(raw, `sha256=${signature}`)).resolves.toEqual(
      event,
    );
    await expect(new TestPaymentProvider().webhook(raw, "sha256=bad")).rejects.toThrow();
    const malformed = Buffer.from(JSON.stringify({ ...event, tenantId: "" }));
    const malformedSignature = createHmac("sha256", "test-secret").update(malformed).digest("hex");
    await expect(
      new TestPaymentProvider().webhook(malformed, `sha256=${malformedSignature}`),
    ).rejects.toThrow("Invalid billing event");
  });

  it("maps retries from the signed subscription metadata on Stripe invoices", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const raw = Buffer.from(
      JSON.stringify({
        id: "evt_invoice_failure",
        object: "event",
        api_version: "2025-10-29.clover",
        created: timestamp,
        livemode: false,
        pending_webhooks: 1,
        request: null,
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_123",
            object: "invoice",
            customer: "cus_123",
            next_payment_attempt: null,
            parent: {
              type: "subscription_details",
              subscription_details: {
                subscription: "sub_123",
                metadata: { tenantId: event.tenantId, planId: event.planId },
              },
            },
          },
        },
      }),
    );
    const secret = "whsec_test";
    const secretKey = ["sk", "test", "placeholder"].join("_");
    const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
    const provider = new StripePaymentProvider(secret, secretKey);
    await expect(provider.webhook(raw, `t=${timestamp},v1=${signature}`)).resolves.toMatchObject({
      type: "invoice.payment_failed",
      tenantId: event.tenantId,
      planId: event.planId,
      customerId: "cus_123",
      subscriptionId: "sub_123",
      transition: "payment_failed",
    });
  });
});
