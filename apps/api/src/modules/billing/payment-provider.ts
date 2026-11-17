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
}

export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;

  constructor(
    private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? "",
    secretKey = process.env.STRIPE_SECRET_KEY ?? "",
  ) {
    if (!secretKey || !webhookSecret) throw new Error("Stripe billing configuration is incomplete");
    this.stripe = new Stripe(secretKey);
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
    const planId = metadata?.planId ?? invoiceMetadata?.planId ?? null;
    let transition: BillingEvent["transition"] = "noop";
    if (event.type === "checkout.session.completed") transition = "activate";
    if (event.type === "customer.subscription.updated") {
      const subscription = object as Stripe.Subscription;
      if (subscription.status === "active" || subscription.status === "trialing")
        transition = "activate";
      else if (subscription.status === "unpaid" || subscription.status === "canceled")
        transition = "payment_failed";
    }
    if (event.type === "customer.subscription.deleted") transition = "cancelled";
    if (event.type === "invoice.payment_failed") {
      const invoice = object as Stripe.Invoice;
      if (!invoice.next_payment_attempt) transition = "payment_failed";
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
  async checkout(input: Parameters<PaymentProvider["checkout"]>[0]) {
    return `${input.tenantUrl}/test-checkout?tenant=${encodeURIComponent(input.tenantId)}`;
  }

  async portal(_customerId: string, returnUrl: string) {
    return returnUrl;
  }

  async webhook(rawBody: Buffer, signature: string): Promise<BillingEvent> {
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
