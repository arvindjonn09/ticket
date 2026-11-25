import { PrismaClient } from "@prisma/client";
import { createOperator } from "./operator-cli.js";
import { assertDatabaseOwner } from "./recovery.js";
import { createHmac, randomUUID } from "node:crypto";

// Fictional fixtures only. Existing MFA and passwords are deliberately preserved.
if (
  process.env.NODE_ENV !== "development" ||
  process.env.PLATFORM_MODE !== "hosted" ||
  process.env.APP_BASE_DOMAIN !== "astrama.localhost" ||
  process.env.PAYMENT_PROVIDER !== "test" ||
  !process.env.MIGRATION_DATABASE_URL
)
  throw new Error("Local hosted demo configuration required");
const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
try {
  await assertDatabaseOwner(db);
  const [action = "seed", slug, transition = "activate", extra] = process.argv.slice(2);
  if (action === "billing") {
    if (!slug || extra || !["activate", "payment_failed", "cancelled"].includes(transition))
      throw new Error(
        "Usage: local-demo.js billing tenant-slug [activate|payment_failed|cancelled]",
      );
    const tenant = await db.tenant.findUniqueOrThrow({ where: { slug } });
    if (!tenant.active || tenant.status === "deleted" || tenant.readOnlyReason === "operator")
      throw new Error(
        "Refusing billing simulation for an unavailable or manually held organisation",
      );
    const event = JSON.stringify({
      id: `evt_local_${randomUUID()}`,
      type: "local.billing.simulated",
      tenantId: tenant.id,
      planId: tenant.planId ?? "local-monthly",
      customerId: `cus_local_${tenant.id}`,
      subscriptionId: `sub_local_${tenant.id}`,
      transition,
    });
    const secret = process.env.TEST_PAYMENT_WEBHOOK_SECRET;
    if (!secret || !process.env.PUBLIC_SITE_ORIGIN)
      throw new Error("Local test webhook configuration required");
    const response = await fetch("http://api:4311/api/billing/webhook", {
      method: "POST",
      headers: {
        host: new URL(process.env.PUBLIC_SITE_ORIGIN).host,
        "content-type": "application/json",
        "x-test-signature": `sha256=${createHmac("sha256", secret).update(event).digest("hex")}`,
      },
      body: event,
    });
    if (!response.ok) throw new Error(`Local billing webhook failed (${response.status})`);
    console.info(
      `Local ${transition} billing simulation accepted for ${slug}; no Stripe call or charge.`,
    );
  } else {
    if (action !== "seed" || slug) throw new Error("Unknown local demo command");
    if (!(await db.operator.findUnique({ where: { email: "owner@demo.test" } })))
      await createOperator(db, {
        name: "Local demo operator",
        email: "owner@demo.test",
        password: "Astrama-demo-2026!",
        role: "owner",
      });
    await db.billingPlan.upsert({
      where: { id: "local-monthly" },
      update: {},
      create: {
        id: "local-monthly",
        name: "Local monthly sandbox",
        stripePriceId: "price_local_monthly",
        seatLimit: 25,
        billingInterval: "month",
        active: true,
      },
    });
    console.info(
      "Local hosted operator and test plan ready; existing credentials and MFA preserved.",
    );
  }
} finally {
  await db.$disconnect();
}
