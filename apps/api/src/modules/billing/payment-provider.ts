import { createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";

export type BillingEvent = {
  id: string;
  type: string;
  tenantId: string;
  planId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  transition: "activate" | "payment_failed" | "cancelled" | "noop";
};

export interface PaymentProvider {
  verifyWebhook(rawBody: Buffer, signature: string): string;
  checkout(input: {
    priceId: string;
    tenantId: string;
    planId: string;
    tenantUrl: string;
    email: string;
    customerId: string | null;
  }): Promise<string>;
  portal(customerId: string, returnUrl: string): Promise<string>;
  webhook(rawBody: Buffer, signature: string): Promise<BillingEvent>;
  cancel(subscriptionId: string, guard?: { tenantId: string; customerId: string }): Promise<void>;
  validatePrice(priceId: string, interval: "month" | "year"): Promise<void>;
  changePlan(input: {
    subscriptionId: string;
    customerId: string;
    tenantId: string;
    planId: string;
    priceId: string;
    interval: "month" | "year";
    prorationBehavior: "none" | "create_prorations";
    requestId: string;
  }): Promise<void>;
}

export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;

  constructor(
    private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "",
    secretKey = process.env.STRIPE_SECRET_KEY ?? "",
  ) {
    if (!secretKey || !webhookSecret) throw new Error("Stripe billing configuration is incomplete");
    this.stripe = new Stripe(secretKey, { timeout: 10000, maxNetworkRetries: 1 });
  }

  async checkout(input: Parameters<PaymentProvider["checkout"]>[0]) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: input.priceId, quantity: 1 }],
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
      client_reference_id: input.tenantId,
      metadata: { tenantId: input.tenantId, planId: input.planId },
      subscription_data: { metadata: { tenantId: input.tenantId, planId: input.planId } },
      success_url: `${input.tenantUrl}/billing?checkout=success`,
      cancel_url: `${input.tenantUrl}/billing?checkout=cancelled`,
    });
    if (!session.url) throw new Error("Stripe did not return a Checkout URL");
    return session.url;
  }

  async portal(customerId: string, returnUrl: string) {
    return (
      await this.stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      })
    ).url;
  }

  verifyWebhook(rawBody: Buffer, signature: string) {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    const object = event.data.object as
      Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice;
    const invoice = object as Stripe.Invoice;
    const tenantId =
      ("metadata" in object ? object.metadata?.tenantId : null) ??
      ("client_reference_id" in object ? object.client_reference_id : null) ??
      (invoice.parent?.type === "subscription_details"
        ? invoice.parent.subscription_details?.metadata?.tenantId
        : null);
    if (!tenantId) throw new Error("Billing event has no tenant reference");
    return tenantId;
  }

  async cancel(subscriptionId: string, guard?: { tenantId: string; customerId: string }) {
    try {
      if (guard) {
        const live = await this.stripe.subscriptions.retrieve(subscriptionId);
        const customer = typeof live.customer === "string" ? live.customer : live.customer.id;
        if (
          live.id !== subscriptionId ||
          live.metadata.tenantId !== guard.tenantId ||
          customer !== guard.customerId
        )
          throw new Error("Subscription identity does not match the organisation");
        if (["active", "trialing"].includes(live.status))
          throw new Error(
            "A live active subscription blocks automatic deletion; reconcile billing first",
          );
      }
      await this.stripe.subscriptions.cancel(subscriptionId);
    } catch (error) {
      // Idempotent retries: a missing or already-canceled subscription is already gone.
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        (error.code === "resource_missing" || /already been canceled/i.test(error.message))
      )
        return;
      throw error;
    }
  }

  async validatePrice(priceId: string, interval: "month" | "year") {
    const price = await this.stripe.prices.retrieve(priceId);
    if (
      price.id !== priceId ||
      !price.active ||
      price.type !== "recurring" ||
      price.recurring?.interval !== interval ||
      price.recurring.interval_count !== 1
    )
      throw new Error(
        "Choose an active recurring Stripe price with the configured billing interval",
      );
  }

  async changePlan(input: Parameters<PaymentProvider["changePlan"]>[0]) {
    const subscription = await this.stripe.subscriptions.retrieve(input.subscriptionId);
    const customer =
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    if (
      subscription.id !== input.subscriptionId ||
      customer !== input.customerId ||
      subscription.metadata.tenantId !== input.tenantId
    )
      throw new Error("Subscription identity does not match the organisation");
    const item = subscription.items.data[0];
    if (
      !["active", "trialing"].includes(subscription.status) ||
      subscription.items.data.length !== 1 ||
      !item ||
      item.quantity !== 1
    )
      throw new Error("An active single-price organisation subscription is required");
    await this.validatePrice(input.priceId, input.interval);
    await this.stripe.subscriptions.update(
      input.subscriptionId,
      {
        items: [{ id: item.id, price: input.priceId, quantity: 1 }],
        metadata: { tenantId: input.tenantId, planId: input.planId },
        proration_behavior: input.prorationBehavior,
        payment_behavior: "error_if_incomplete",
      },
      { idempotencyKey: `operator-plan:${input.requestId}` },
    );
  }

  async webhook(rawBody: Buffer, signature: string): Promise<BillingEvent> {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    const object = event.data.object as
      Stripe.Checkout.Session | Stripe.Subscription | Stripe.Invoice;
    const invoice = object as Stripe.Invoice;
    const invoiceSubscription =
      invoice.parent?.type === "subscription_details"
        ? invoice.parent.subscription_details?.subscription
        : null;
    const subscriptionId =
      "subscription" in object
        ? typeof object.subscription === "string"
          ? object.subscription
          : (object.subscription?.id ?? null)
        : object.object === "subscription"
          ? object.id
          : typeof invoiceSubscription === "string"
            ? invoiceSubscription
            : (invoiceSubscription?.id ?? null);
    const customerId =
      typeof object.customer === "string" ? object.customer : (object.customer?.id ?? null);
    const metadata = "metadata" in object ? object.metadata : null;
    const invoiceMetadata =
      invoice.parent?.type === "subscription_details"
        ? invoice.parent.subscription_details?.metadata
        : null;
    const tenantId =
      metadata?.tenantId ??
      ("client_reference_id" in object ? object.client_reference_id : null) ??
      invoiceMetadata?.tenantId;
    if (!tenantId) throw new Error("Billing event has no tenant reference");
    if (!subscriptionId) throw new Error("Billing event has no subscription reference");
    const live = await this.stripe.subscriptions.retrieve(subscriptionId);
    if (live.id !== subscriptionId)
      throw new Error("Stripe returned a different subscription than the event references");
    const liveCustomer = typeof live.customer === "string" ? live.customer : live.customer.id;
    if (customerId && liveCustomer !== customerId)
      throw new Error("Subscription customer does not match the event");
    if (live.metadata?.tenantId && live.metadata.tenantId !== tenantId)
      throw new Error("Subscription tenant does not match the event");
    const planId = live.metadata?.planId ?? metadata?.planId ?? invoiceMetadata?.planId ?? null;
    const active = live.status === "active" || live.status === "trialing";
    const dead =
      live.status === "canceled" || live.status === "incomplete_expired" ? "cancelled" : null;
    let transition: BillingEvent["transition"] = "noop";
    if (dead) transition = dead;
    else if (active) {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        const session = object as Stripe.Checkout.Session;
        const paid =
          session.payment_status === "paid" || session.payment_status === "no_payment_required";
        transition = paid ? "activate" : "noop";
      } else transition = "activate";
    } else if (live.status === "unpaid") transition = "payment_failed";
    else if (event.type === "invoice.payment_failed" && live.status === "past_due") {
      const invoice = object as Stripe.Invoice;
      transition = invoice.next_payment_attempt ? "noop" : "payment_failed";
    }
    return {
      id: event.id,
      type: event.type,
      tenantId,
      planId,
      customerId,
      subscriptionId,
      transition,
    };
  }
}

export class TestPaymentProvider implements PaymentProvider {
  async cancel(_subscriptionId: string) {}
  async validatePrice(_priceId: string, _interval: "month" | "year") {}
  async changePlan(_input: Parameters<PaymentProvider["changePlan"]>[0]) {}

  async checkout(input: Parameters<PaymentProvider["checkout"]>[0]) {
    return `${input.tenantUrl}/test-checkout?tenant=${encodeURIComponent(input.tenantId)}`;
  }

  async portal(_customerId: string, returnUrl: string) {
    return returnUrl;
  }

  verifyWebhook(rawBody: Buffer, signature: string) {
    return this.verifiedEvent(rawBody, signature).tenantId;
  }
  async webhook(rawBody: Buffer, signature: string): Promise<BillingEvent> {
    return this.verifiedEvent(rawBody, signature);
  }
  private verifiedEvent(rawBody: Buffer, signature: string): BillingEvent {
    const secret = process.env.TEST_PAYMENT_WEBHOOK_SECRET ?? "ci-payment-secret";
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const received = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
    if (expected.length !== received.length || !timingSafeEqual(expected, received))
      throw new Error("Invalid billing webhook signature");
    const event = JSON.parse(rawBody.toString("utf8")) as BillingEvent;
    if (
      !event.id ||
      !event.type ||
      !event.tenantId ||
      (event.planId !== null && typeof event.planId !== "string") ||
      !["activate", "payment_failed", "cancelled", "noop"].includes(event.transition)
    )
      throw new Error("Invalid billing event");
    return event;
  }
}

export function paymentProvider(): PaymentProvider {
  if (process.env.PAYMENT_PROVIDER === "test" && process.env.NODE_ENV !== "production")
    return new TestPaymentProvider();
  return new StripePaymentProvider();
}
