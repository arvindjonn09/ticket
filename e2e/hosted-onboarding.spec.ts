import { authenticatorCode } from "./totp";
import { test, expect } from "@playwright/test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

// Full SA-04 journey against the hosted harness (Caddy, real ALTCHA, Mailpit,
// real API and queue worker). Skipped unless HOSTED_E2E_SLUG is supplied.
test.skip(!process.env.HOSTED_E2E_SLUG, "requires the hosted E2E harness");
test.use({ ignoreHTTPSErrors: true, actionTimeout: 15000 });

const siteOrigin = process.env.PUBLIC_SITE_ORIGIN ?? "https://astrama.test:4315";
const baseDomain = process.env.APP_BASE_DOMAIN ?? "astrama.test";
const sitePort = new URL(siteOrigin).port;
const slug = process.env.HOSTED_E2E_SLUG!;
const tenantOrigin = `https://${slug}.${baseDomain}${sitePort ? `:${sitePort}` : ""}`;
const mailpit = process.env.MAILPIT_URL!;
const recipient = `hosted-${randomUUID()}@e2e.astrama.test`;
const password = "Hosted-onboarding-password-2026!";

const require = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = require("@prisma/client");
type Owner = InstanceType<typeof PrismaClient>;
let owner: Owner;
let tenantId: string;
let planId: string;

async function mailpitLink(subject: string, match: RegExp) {
  for (let attempt = 0; attempt < 45; attempt++) {
    const search = await fetch(
      `${mailpit}/api/v1/search?query=to:${encodeURIComponent(recipient)}`,
    );
    const { messages } = (await search.json()) as { messages: { ID: string }[] };
    for (const { ID } of messages) {
      const detail = (await (await fetch(`${mailpit}/api/v1/message/${ID}`)).json()) as {
        Subject: string;
        Text: string;
      };
      if (detail.Subject !== subject) continue;
      const link = detail.Text.match(match);
      if (link) return link[0];
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Mailpit never delivered "${subject}" to ${recipient}`);
}

test.beforeAll(async () => {
  owner = new PrismaClient({
    datasourceUrl:
      process.env.MIGRATION_DATABASE_URL ??
      "postgresql://astrama_owner:astrama-local-owner@localhost:5439/astrama",
  });
  // Disposable owner-side plan fixture (month/year are the only intervals).
  planId = `e2e-hosted-${randomUUID()}`;
  await owner.billingPlan.create({
    data: {
      id: planId,
      name: "E2E Hosted Test Plan",
      stripePriceId: `price_e2e_${randomUUID()}`,
      seatLimit: 25,
      billingInterval: "month",
      active: true,
    },
  });
});

test.afterAll(async () => {
  if (!owner) return;
  try {
    // The harness-mapped slug must be reusable across browser projects: remove
    // the guarded fixture tenant (real helper, cascades signup/provision rows),
    // then the remaining signup/outbox/rate-limit records for this run.
    if (!/^browser-[0-9a-f-]{36}$/.test(slug))
      throw new Error("Refusing cleanup of a non-fixture slug");
    const tenant = await owner?.tenant.findFirst({ where: { slug } });
    if (tenant) {
      const { cleanupFixture } = await import("./fixture-cleanup");
      await cleanupFixture(owner, tenant.id, slug);
    }
    // Deleting the tenant cascades signup_requests.provisioned_tenant_id and the
    // provision job; these deletes only clear leftovers from a failed run.
    await owner.$executeRaw`DELETE FROM public.signup_requests WHERE slug=${slug}`;
    await owner.$executeRaw`DELETE FROM public.public_mail_outbox WHERE recipient=${recipient}`;
    await owner.$executeRaw`DELETE FROM public.signup_rate_limits WHERE key_hash=${createHash("sha256").update(`email:${recipient}`).digest("hex")}`;
    const leftovers = await owner.$queryRaw<{ status: string }[]>`
      SELECT j.status FROM public.signup_requests r
      JOIN public.signup_provision_jobs j ON j.signup_id=r.id
      WHERE r.slug=${slug} AND j.status<>'complete'`;
    if (leftovers?.length) throw new Error("Active signup/provision row left for the fixture slug");
    await owner.billingPlan.deleteMany({ where: { id: planId } });
  } finally {
    await owner?.$disconnect();
  }
});

test("visitor signs up, verifies by email, activates on the subdomain and subscribes", async ({
  page,
}) => {
  test.setTimeout(300000);

  // 1. Public site: home and pricing.
  await page.goto(siteOrigin);
  await expect(page.getByRole("heading", { name: "Support work, under control." })).toBeVisible();
  await page.getByRole("link", { name: "View plans" }).click();
  await expect(page.getByRole("heading", { name: "Pricing that fits your team" })).toBeVisible();

  // 2. Signup form with a real ALTCHA solution computed in-page.
  await page.locator("main").getByRole("link", { name: "Start a free trial" }).click();
  await page.getByLabel("Organisation address").fill(slug);
  await expect(page.getByText("This address is available.", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await page.getByLabel("Company name").fill("Hosted E2E Company");
  await page.getByLabel("Your name").fill("Hosted Admin");
  await page.getByLabel("Work email").fill(recipient);
  await page.getByRole("checkbox", { name: /terms of service/ }).check();
  await page.getByRole("checkbox", { name: /privacy notice/ }).check();
  await expect(page.getByText("Abuse check complete.", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const submit = page.getByRole("button", { name: "Email verification link", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();

  // 3. Neutral verify-email screen.
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();

  // 4. Real verification email via Mailpit, then follow the link.
  await page.goto(
    await mailpitLink(
      "Verify your Astrama organisation",
      /https?:\/\/\S*\/signup\/verify\?token=\S+/,
    ),
  );
  await expect(page.getByRole("heading", { name: "Prepare your organisation" })).toBeVisible();
  await expect(
    page.getByText("Email verified. Your organisation is being prepared", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open organisation" })).toHaveAttribute(
    "href",
    tenantOrigin,
  );

  // 5. Real queued provisioning; the administrator invitation arrives by email.
  for (let attempt = 0; attempt < 60 && !tenantId; attempt++) {
    tenantId =
      (
        await owner.$queryRaw<{ id: string }[]>`
          SELECT id FROM public.tenants WHERE slug=${slug}`
      )[0]?.id ?? "";
    if (!tenantId) await new Promise((r) => setTimeout(r, 2000));
  }
  expect(tenantId, "provisioning never created the tenant").toBeTruthy();
  // Operator fixture setup: attach the disposable plan the checkout will use.
  await owner.tenant.update({ where: { id: tenantId }, data: { planId } });

  // 6. Activate the administrator on the tenant subdomain.
  await page.goto(
    await mailpitLink("Set up your service desk account", /https?:\/\/\S*\/#activate\?token=\S+/),
  );
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Activate your account", exact: true }).click();
  await expect(
    page.getByText("Your account is active. Sign in to continue.", { exact: true }),
  ).toBeVisible();

  // 7. Sign in and enrol in the mandatory MFA.
  await page.goto(tenantOrigin);
  await page.getByLabel("Email address", { exact: true }).fill(recipient);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Set up your authenticator", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Begin setup", exact: true }).click();
  await page.locator("details summary").click();
  const secret = await page.getByLabel("Setup secret", { exact: true }).inputValue();
  await page.getByLabel("Authenticator code", { exact: true }).fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Organisation setup", exact: true }),
  ).toBeVisible();

  // 8. First incident from the starter catalogue, persisted after reload.
  const title = `Hosted onboarding first incident ${randomUUID()}`;
  await page.getByRole("link", { name: "Report an issue", exact: true }).first().click();
  await page
    .getByLabel("What do you need help with?", { exact: false })
    .selectOption({ label: "Devices & workplace" });
  await page.getByLabel("Give your issue a short title", { exact: false }).fill(title);
  await page
    .getByLabel("Describe the issue", { exact: false })
    .fill("First incident raised by the hosted onboarding journey to check persistence.");
  await page.getByRole("button", { name: "Submit incident", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();

  // 9. Billing: initiate the TestPaymentProvider checkout with the fixture plan.
  await page.goto(`${tenantOrigin}/billing`);
  await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
  const checkoutResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/billing/checkout"),
  );
  const checkoutNavigation = page.waitForURL(
    `${tenantOrigin}/test-checkout?tenant=${encodeURIComponent(tenantId)}`,
    { waitUntil: "commit" },
  );
  await page.getByRole("button", { name: "Continue to secure checkout", exact: true }).click();
  expect((await checkoutResponse).ok()).toBe(true);
  await checkoutNavigation;

  // 10. Simulate the test provider's signed webhook (no Stripe, no card data).
  const event = {
    id: `evt_${randomUUID()}`,
    type: "checkout.session.completed",
    tenantId,
    planId,
    customerId: `cus_e2e_${randomUUID()}`,
    subscriptionId: `sub_e2e_${randomUUID()}`,
    transition: "activate",
  };
  const body = JSON.stringify(event);
  const signature = `sha256=${createHmac(
    "sha256",
    process.env.TEST_PAYMENT_WEBHOOK_SECRET ?? "ci-payment-secret",
  )
    .update(body)
    .digest("hex")}`;
  const hook = await page.request.post(`${siteOrigin}/api/billing/webhook`, {
    headers: { "x-test-signature": signature, "content-type": "application/json" },
    data: body,
  });
  expect(hook.ok()).toBeTruthy();
  expect(((await hook.json()) as { received?: boolean }).received).toBe(true);

  // 11. Billing reflects the activated subscription.
  await page.goto(`${tenantOrigin}/billing`);
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("E2E Hosted Test Plan", { exact: false })).toBeVisible();
});
