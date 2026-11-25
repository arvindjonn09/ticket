import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StripePaymentProvider, TestPaymentProvider } from "./payment-provider.js";

const secretKey = ["sk", "test", "placeholder"].join("_");
const webhookSecret = "whsec_test";
const tenantId = "9ee2d631-6229-4c27-9d10-0c4ca658e211";

describe("operator Stripe plan changes", () => {
  afterEach(() => vi.restoreAllMocks());
  const input = {
    subscriptionId: "sub_123",
    customerId: "cus_123",
    tenantId,
    planId: "new-plan",
    priceId: "price_new",
    interval: "month" as const,
    prorationBehavior: "none" as const,
    requestId: "fixture-job-identity",
  };
  function fixture() {
    const provider = new StripePaymentProvider(webhookSecret, secretKey);
    const stripe = (provider as unknown as { stripe: Stripe }).stripe;
    const subscription = liveSubscription({
      items: { data: [{ id: "si_123", quantity: 1 }] } as Stripe.Subscription["items"],
    });
    const retrieve = vi
      .spyOn(stripe.subscriptions, "retrieve")
      .mockResolvedValue(subscription as Stripe.Response<Stripe.Subscription>);
    const price = vi.spyOn(stripe.prices, "retrieve").mockResolvedValue({
      id: "price_new",
      active: true,
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
    } as Stripe.Response<Stripe.Price>);
    const update = vi
      .spyOn(stripe.subscriptions, "update")
      .mockResolvedValue(subscription as Stripe.Response<Stripe.Subscription>);
    return { provider, retrieve, price, update, subscription };
  }
  it("binds subscription/customer/tenant and an active single-price subscription before any update", async () => {
    const { provider, retrieve, update, subscription } = fixture();
    for (const change of [
      { customer: "cus_other" },
      { metadata: { tenantId: "another-tenant" } },
      { metadata: {} },
      { status: "canceled" },
      { items: { data: [{ id: "si_123", quantity: 2 }] } },
      {
        items: {
          data: [
            { id: "si_123", quantity: 1 },
            { id: "si_extra", quantity: 1 },
          ],
        },
      },
    ]) {
      retrieve.mockResolvedValue({
        ...subscription,
        ...change,
      } as Stripe.Response<Stripe.Subscription>);
      await expect(provider.changePlan(input)).rejects.toThrow();
    }
    expect(update).not.toHaveBeenCalled();
  });
  it("requires the configured recurring interval and rejects inactive or multi-interval prices", async () => {
    const { provider, price, update } = fixture();
    for (const change of [
      { active: false, type: "recurring", recurring: { interval: "month", interval_count: 1 } },
      { active: true, type: "one_time", recurring: null },
      { active: true, type: "recurring", recurring: { interval: "year", interval_count: 1 } },
      { active: true, type: "recurring", recurring: { interval: "month", interval_count: 3 } },
    ]) {
      price.mockResolvedValue({ id: "price_new", ...change } as Stripe.Response<Stripe.Price>);
      await expect(provider.changePlan(input)).rejects.toThrow();
    }
    expect(update).not.toHaveBeenCalled();
  });
  it("uses the explicit proration choice, fail-on-incomplete payment and stable job idempotency", async () => {
    const { provider, update } = fixture();
    await provider.changePlan(input);
    expect(update).toHaveBeenCalledWith(
      "sub_123",
      {
        items: [{ id: "si_123", price: "price_new", quantity: 1 }],
        metadata: { tenantId, planId: "new-plan" },
        proration_behavior: "none",
        payment_behavior: "error_if_incomplete",
      },
      { idempotencyKey: "operator-plan:fixture-job-identity" },
    );
    update.mockRejectedValueOnce(new Error("Fixture network error"));
    await expect(provider.changePlan(input)).rejects.toThrow("Fixture network error");
  });
  it("blocks automatic deletion of a live active or mismatched subscription", async () => {
    const { provider, retrieve, subscription } = fixture();
    const cancel = vi
      .spyOn((provider as unknown as { stripe: Stripe }).stripe.subscriptions, "cancel")
      .mockResolvedValue(subscription as Stripe.Response<Stripe.Subscription>);
    await expect(provider.cancel("sub_123", { tenantId, customerId: "cus_123" })).rejects.toThrow(
      "blocks automatic deletion",
    );
    retrieve.mockResolvedValue({
      ...subscription,
      status: "unpaid",
      customer: "cus_other",
    } as Stripe.Response<Stripe.Subscription>);
    await expect(provider.cancel("sub_123", { tenantId, customerId: "cus_123" })).rejects.toThrow(
      "identity",
    );
    expect(cancel).not.toHaveBeenCalled();
    retrieve.mockResolvedValue({
      ...subscription,
      status: "unpaid",
    } as Stripe.Response<Stripe.Subscription>);
    await provider.cancel("sub_123", { tenantId, customerId: "cus_123" });
    expect(cancel).toHaveBeenCalledWith("sub_123");
  });
});

const testEvent = {
  id: "evt_123",
  type: "invoice.payment_failed",
  tenantId,
  planId: "starter-monthly",
  customerId: "cus_123",
  subscriptionId: "sub_123",
  transition: "payment_failed",
};

type RetrieveStub = (id: string) => Promise<Stripe.Subscription>;
type CancelStub = (id: string) => Promise<Stripe.Subscription>;

function signedStripeEnvelope(
  timestamp: number,
  type: string,
  data: unknown,
): { raw: Buffer; signature: string } {
  const raw = Buffer.from(
    JSON.stringify({
      id: "evt_stripe",
      object: "event",
      api_version: "2025-10-29.clover",
      created: timestamp,
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type,
      data: { object: data },
    }),
  );
  const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex");
  return { raw, signature: `t=${timestamp},v1=${signature}` };
}

function stubRetrieve(provider: StripePaymentProvider, retrieve: RetrieveStub): void {
  (
    provider as unknown as {
      stripe: { subscriptions: { retrieve: RetrieveStub } };
    }
  ).stripe.subscriptions.retrieve = retrieve;
}

function stubCancel(provider: StripePaymentProvider, cancel: CancelStub): void {
  (
    provider as unknown as {
      stripe: { subscriptions: { cancel: CancelStub } };
    }
  ).stripe.subscriptions.cancel = cancel;
}

function liveSubscription(overrides: Partial<Stripe.Subscription>): Stripe.Subscription {
  return {
    id: "sub_123",
    status: "active",
    customer: "cus_123",
    metadata: { tenantId },
    ...overrides,
  } as Stripe.Subscription;
}

describe("payment providers", () => {
  afterEach(() => {
    delete process.env.TEST_PAYMENT_WEBHOOK_SECRET;
  });

  it("authenticates test webhooks and validates their event shape", async () => {
    process.env.TEST_PAYMENT_WEBHOOK_SECRET = "test-secret";
    const raw = Buffer.from(JSON.stringify(testEvent));
    const signature = createHmac("sha256", "test-secret").update(raw).digest("hex");
    await expect(new TestPaymentProvider().webhook(raw, `sha256=${signature}`)).resolves.toEqual(
      testEvent,
    );
    await expect(new TestPaymentProvider().webhook(raw, "sha256=bad")).rejects.toThrow();
    const malformed = Buffer.from(JSON.stringify({ ...testEvent, tenantId: "" }));
    const malformedSignature = createHmac("sha256", "test-secret").update(malformed).digest("hex");
    await expect(
      new TestPaymentProvider().webhook(malformed, `sha256=${malformedSignature}`),
    ).rejects.toThrow("Invalid billing event");
  });

  it("rejects a signed event without a subscription reference", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const { raw, signature } = signedStripeEnvelope(timestamp, "checkout.session.completed", {
      id: "cs_123",
      object: "checkout.session",
      customer: "cus_123",
      subscription: null,
      payment_status: "paid",
      metadata: { tenantId, planId: "starter-monthly" },
    });
    const provider = new StripePaymentProvider(webhookSecret, secretKey);
    stubRetrieve(provider, vi.fn<RetrieveStub>().mockResolvedValue(liveSubscription({})));
    await expect(provider.webhook(raw, signature)).rejects.toThrow("subscription reference");
  });

  it("propagates subscription retrieval errors", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const { raw, signature } = signedStripeEnvelope(timestamp, "customer.subscription.updated", {
      id: "sub_123",
      object: "subscription",
      customer: "cus_123",
      status: "canceled",
      metadata: { tenantId, planId: "starter-monthly" },
    });
    const provider = new StripePaymentProvider(webhookSecret, secretKey);
    stubRetrieve(provider, vi.fn<RetrieveStub>().mockRejectedValue(new Error("Stripe outage")));
    await expect(provider.webhook(raw, signature)).rejects.toThrow("Stripe outage");
  });

  it("rejects identity mismatches between the event and the retrieved subscription", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const object = {
      id: "sub_123",
      object: "subscription",
      customer: "cus_123",
      status: "active",
      metadata: { tenantId, planId: "starter-monthly" },
    };
    const { raw, signature } = signedStripeEnvelope(
      timestamp,
      "customer.subscription.updated",
      object,
    );
    const cases: Array<{ live: Stripe.Subscription; error: string }> = [
      {
        live: liveSubscription({ id: "sub_other" }),
        error: "different subscription",
      },
      {
        live: liveSubscription({ customer: "cus_other" }),
        error: "customer does not match",
      },
      {
        live: liveSubscription({ metadata: { tenantId: "other-tenant" } }),
        error: "tenant does not match",
      },
    ];
    for (const { live, error } of cases) {
      const provider = new StripePaymentProvider(webhookSecret, secretKey);
      stubRetrieve(provider, vi.fn<RetrieveStub>().mockResolvedValue(live));
      await expect(provider.webhook(raw, signature)).rejects.toThrow(error);
    }
  });

  describe("BL-01: transitions derive from the retrieved live subscription status", () => {
    interface StripeCase {
      name: string;
      type: string;
      object: Record<string, unknown>;
      live: Partial<Stripe.Subscription>;
      transition: string;
    }

    const subscriptionObject = {
      id: "sub_123",
      object: "subscription",
      customer: "cus_123",
      status: "active",
      metadata: { tenantId, planId: "starter-monthly" },
    };

    const invoiceObject = (nextPaymentAttempt: number | null) => ({
      id: "in_123",
      object: "invoice",
      customer: "cus_123",
      next_payment_attempt: nextPaymentAttempt,
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: "sub_123",
          metadata: { tenantId, planId: "starter-monthly" },
        },
      },
    });

    const checkoutObject = (paymentStatus: string) => ({
      id: "cs_123",
      object: "checkout.session",
      customer: "cus_123",
      subscription: "sub_123",
      payment_status: paymentStatus,
      metadata: { tenantId, planId: "starter-monthly" },
    });

    const cases: StripeCase[] = [
      {
        name: "stale subscription.updated(active) after deletion stays cancelled",
        type: "customer.subscription.updated",
        object: subscriptionObject,
        live: { status: "canceled" },
        transition: "cancelled",
      },
      {
        name: "stale subscription.deleted cannot lock an active subscriber",
        type: "customer.subscription.deleted",
        object: subscriptionObject,
        live: { status: "active" },
        transition: "activate",
      },
      {
        name: "live unpaid subscription becomes payment_failed from any subscription event",
        type: "customer.subscription.updated",
        object: subscriptionObject,
        live: { status: "unpaid" },
        transition: "payment_failed",
      },
      {
        name: "live trialing subscription activates",
        type: "customer.subscription.updated",
        object: subscriptionObject,
        live: { status: "trialing" },
        transition: "activate",
      },
      {
        name: "retrying past_due invoice stays noop even when live past_due",
        type: "invoice.payment_failed",
        object: invoiceObject(1780000000),
        live: { status: "past_due" },
        transition: "noop",
      },
      {
        name: "final-retry invoice fails a live past_due subscription",
        type: "invoice.payment_failed",
        object: invoiceObject(null),
        live: { status: "past_due" },
        transition: "payment_failed",
      },
      {
        name: "final-retry invoice fails a live unpaid subscription",
        type: "invoice.payment_failed",
        object: invoiceObject(null),
        live: { status: "unpaid" },
        transition: "payment_failed",
      },
      {
        name: "stale final-retry failure reconciles to active instead of failing the tenant",
        type: "invoice.payment_failed",
        object: invoiceObject(null),
        live: { status: "active" },
        transition: "activate",
      },
      {
        name: "stale paid checkout cannot ignore a live canceled subscription",
        type: "checkout.session.completed",
        object: checkoutObject("paid"),
        live: { status: "canceled" },
        transition: "cancelled",
      },
      {
        name: "stale paid checkout cannot ignore a live unpaid subscription",
        type: "checkout.session.completed",
        object: checkoutObject("paid"),
        live: { status: "unpaid" },
        transition: "payment_failed",
      },
      {
        name: "unpaid checkout does not activate even when live active",
        type: "checkout.session.completed",
        object: checkoutObject("unpaid"),
        live: { status: "active" },
        transition: "noop",
      },
    ];

    for (const { name, type, object, live, transition } of cases) {
      it(name, async () => {
        const timestamp = Math.floor(Date.now() / 1000);
        const { raw, signature } = signedStripeEnvelope(timestamp, type, { ...object, type });
        const provider = new StripePaymentProvider(webhookSecret, secretKey);
        stubRetrieve(
          provider,
          vi.fn<RetrieveStub>().mockResolvedValue(liveSubscription({ status: live.status })),
        );
        await expect(provider.webhook(raw, signature)).resolves.toMatchObject({
          type,
          tenantId,
          planId: "starter-monthly",
          customerId: "cus_123",
          subscriptionId: "sub_123",
          transition,
        });
      });
    }

    it("a stale event cannot restore an older plan when live metadata names the current plan", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const { raw, signature } = signedStripeEnvelope(
        timestamp,
        "customer.subscription.updated",
        subscriptionObject,
      );
      const provider = new StripePaymentProvider(webhookSecret, secretKey);
      stubRetrieve(
        provider,
        vi.fn<RetrieveStub>().mockResolvedValue(
          liveSubscription({
            status: "active",
            metadata: { tenantId, planId: "growth-monthly" },
          }),
        ),
      );
      await expect(provider.webhook(raw, signature)).resolves.toMatchObject({
        tenantId,
        planId: "growth-monthly",
        transition: "activate",
      });
    });

    it("a signed event falls back to the signed plan when live metadata has no planId", async () => {
      const timestamp = Math.floor(Date.now() / 1000);
      const { raw, signature } = signedStripeEnvelope(
        timestamp,
        "customer.subscription.updated",
        subscriptionObject,
      );
      const provider = new StripePaymentProvider(webhookSecret, secretKey);
      stubRetrieve(
        provider,
        vi.fn<RetrieveStub>().mockResolvedValue(liveSubscription({ metadata: { tenantId } })),
      );
      await expect(provider.webhook(raw, signature)).resolves.toMatchObject({
        planId: "starter-monthly",
        transition: "activate",
      });
    });
  });

  describe("BL-02: checkout completion only activates with money in hand", () => {
    interface CheckoutCase {
      name: string;
      type: string;
      paymentStatus: string;
      live: string;
      transition: string;
    }

    const cases: CheckoutCase[] = [
      {
        name: "unpaid completion does not activate even when live active",
        type: "checkout.session.completed",
        paymentStatus: "unpaid",
        live: "active",
        transition: "noop",
      },
      {
        name: "paid completion activates a live active subscription",
        type: "checkout.session.completed",
        paymentStatus: "paid",
        live: "active",
        transition: "activate",
      },
      {
        name: "no_payment_required completion activates a live active subscription",
        type: "checkout.session.completed",
        paymentStatus: "no_payment_required",
        live: "active",
        transition: "activate",
      },
      {
        name: "paid completion stays noop while live subscription is not yet active",
        type: "checkout.session.completed",
        paymentStatus: "paid",
        live: "incomplete",
        transition: "noop",
      },
      {
        name: "async payment success activates a live active subscription",
        type: "checkout.session.async_payment_succeeded",
        paymentStatus: "paid",
        live: "active",
        transition: "activate",
      },
    ];

    for (const { name, type, paymentStatus, live, transition } of cases) {
      it(name, async () => {
        const timestamp = Math.floor(Date.now() / 1000);
        const { raw, signature } = signedStripeEnvelope(timestamp, type, {
          id: "cs_123",
          object: "checkout.session",
          customer: "cus_123",
          subscription: "sub_123",
          payment_status: paymentStatus,
          metadata: { tenantId, planId: "starter-monthly" },
        });
        const provider = new StripePaymentProvider(webhookSecret, secretKey);
        stubRetrieve(
          provider,
          vi.fn<RetrieveStub>().mockResolvedValue(liveSubscription({ status: live })),
        );
        await expect(provider.webhook(raw, signature)).resolves.toMatchObject({
          type,
          tenantId,
          planId: "starter-monthly",
          customerId: "cus_123",
          subscriptionId: "sub_123",
          transition,
        });
      });
    }
  });

  describe("BL-03: idempotent subscription cancellation before tenant deletion", () => {
    it("cancels a live subscription", async () => {
      const provider = new StripePaymentProvider(webhookSecret, secretKey);
      const cancel = vi
        .fn<CancelStub>()
        .mockResolvedValue(liveSubscription({ status: "canceled" }));
      stubCancel(provider, cancel);
      await expect(provider.cancel("sub_123")).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledWith("sub_123");
    });

    it("treats already-canceled and missing subscriptions as safely done", async () => {
      const provider = new StripePaymentProvider(webhookSecret, secretKey);
      stubCancel(
        provider,
        vi.fn<CancelStub>().mockRejectedValue(
          new Stripe.errors.StripeInvalidRequestError({
            message: "This subscription has already been canceled.",
          }),
        ),
      );
      await expect(provider.cancel("sub_123")).resolves.toBeUndefined();
      stubCancel(
        provider,
        vi.fn<CancelStub>().mockRejectedValue(
          new Stripe.errors.StripeInvalidRequestError({
            message: "No such subscription: sub_123",
            code: "resource_missing",
          }),
        ),
      );
      await expect(provider.cancel("sub_missing")).resolves.toBeUndefined();
    });

    it("propagates provider, network and auth errors so deletion blocks", async () => {
      const provider = new StripePaymentProvider(webhookSecret, secretKey);
      stubCancel(provider, vi.fn<CancelStub>().mockRejectedValue(new Error("Stripe outage")));
      await expect(provider.cancel("sub_123")).rejects.toThrow("Stripe outage");
      stubCancel(
        provider,
        vi.fn<CancelStub>().mockRejectedValue(
          new Stripe.errors.StripeInvalidRequestError({
            message: "Expired API key provided",
          }),
        ),
      );
      await expect(provider.cancel("sub_123")).rejects.toThrow("Expired API key");
    });

    it("test provider cancellation is a safe no-op", async () => {
      await expect(new TestPaymentProvider().cancel("sub_123")).resolves.toBeUndefined();
    });
  });
});
