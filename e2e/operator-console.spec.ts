import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { cleanupFixture } from "./fixture-cleanup";
import { authenticatorCode } from "./totp";
import jsQR from "jsqr";

test.skip(!process.env.OPERATOR_E2E_SLUG, "requires the disposable hosted operator harness");
test.use({ ignoreHTTPSErrors: true, timezoneId: "UTC", actionTimeout: 15000 });
test.setTimeout(180000);
const slug = process.env.OPERATOR_E2E_SLUG!;
const operatorOrigin = process.env.OPERATOR_ORIGIN ?? "https://ops.astrama.test";
const port = new URL(process.env.PUBLIC_SITE_ORIGIN ?? operatorOrigin).port;
const tenantOrigin = `https://${slug}.${process.env.APP_BASE_DOMAIN ?? "astrama.test"}${port ? `:${port}` : ""}`;
const fixture = randomUUID(),
  password = "Browser-operator-password-2026!";
const operatorEmail = `operator-${fixture}@e2e.invalid`,
  adminEmail = `admin-${fixture}@e2e.invalid`;
const planId = `browser-plan-${fixture}`;
const require = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = require("@prisma/client");
let owner: InstanceType<typeof PrismaClient>, tenantId: string, operatorId: string;

test.beforeAll(async () => {
  if (!/^browser-[0-9a-f-]{36}$/.test(slug))
    throw new Error("A random disposable fixture slug is required");
  owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
  const { provisionOrganisation } = await import("../apps/api/dist/provision.js");
  const { createOperator } = await import("../apps/api/dist/operator-cli.js");
  await provisionOrganisation(
    {
      slug,
      name: "Operator browser organisation",
      brandName: "Operator browser organisation",
      admin: { name: "Browser administrator", email: adminEmail },
    },
    { status: "trial" },
  );
  const tenant = await owner.tenant.findUniqueOrThrow({
    where: { slug },
    include: { users: true, departments: true },
  });
  tenantId = tenant.id;
  const { hash, argon2id } = require("argon2");
  const admin = tenant.users[0];
  await owner.user.update({
    where: { id: admin.id },
    data: { active: true, passwordHash: await hash(password, { type: argon2id }) },
  });
  operatorId = (
    await createOperator(owner, {
      name: "Browser operator",
      email: operatorEmail,
      password,
      role: "owner",
    })
  ).id;
  const group = tenant.departments.find((row: { isTriage: boolean }) => row.isTriage)!;
  const category = await owner.category.create({
    data: { tenantId, name: "Operator fixture category", departmentId: group.id },
  });
  const ticket = await owner.ticket.create({
    data: {
      tenantId,
      type: "incident",
      sequence: 1,
      number: "INC0001",
      summary: "Operator fixture incident",
      description: "A persisted incident for the operator support view.",
      priority: "P3",
      severity: "S3",
      categoryId: category.id,
      departmentId: group.id,
      callerId: admin.id,
      submittedById: admin.id,
    },
  });
  await owner.activity.create({
    data: {
      tenantId,
      ticketId: ticket.id,
      authorId: admin.id,
      audience: "internal",
      body: "Grouped internal note for operator support",
    },
  });
});
test.afterAll(async () => {
  if (!owner) return;
  try {
    if (tenantId) await cleanupFixture(owner, tenantId, slug);
    await owner.billingPlan.deleteMany({ where: { id: planId } });
    if (operatorId) {
      await owner.operatorSession.deleteMany({ where: { operatorId } });
      await owner.operator.update({ where: { id: operatorId }, data: { active: false } });
    }
  } finally {
    await owner.$disconnect();
  }
});

async function enrol(page: Page, operator: boolean) {
  const externalOrigins: string[] = [];
  if (operator)
    page.on("request", (request) => {
      const origin = new URL(request.url()).origin;
      if (origin !== operatorOrigin) externalOrigins.push(origin);
    });
  await page.getByRole("button", { name: "Begin setup", exact: true }).click();
  let scannedSecret: string | null = null;
  if (operator) {
    const qr = page.getByRole("img", { name: "Authenticator setup QR code", exact: true });
    await expect(qr).toBeVisible();
    const decode = async () => {
      const pixels = await qr.evaluate((element: HTMLCanvasElement) => ({
        width: element.width,
        height: element.height,
        data: Array.from(
          element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data,
        ),
      }));
      return jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data;
    };
    const uri = await decode();
    expect(externalOrigins).toEqual([]);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    scannedSecret = new URL(uri!).searchParams.get("secret");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await decode()).toBe(uri);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.getByText("Can’t scan? Enter the setup key manually", { exact: true }).click();
    await expect(page.getByLabel("Authenticator URI", { exact: false })).toHaveValue(uri!);
    await page.setViewportSize({ width: 1440, height: 1000 });
  } else {
    await page.locator("details summary").click();
  }
  const secret = await page.getByLabel("Setup secret", { exact: true }).inputValue();
  if (operator) expect(secret).toBe(scannedSecret);
  await page.getByLabel("Authenticator code", { exact: true }).fill(authenticatorCode(secret));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: operator ? "Organisations" : "Organisation setup",
      exact: true,
    }),
  ).toBeVisible();
}

test("operator enrols MFA, configures a plan and uses only tenant-granted audited support access", async ({
  page,
  context,
}) => {
  await page.goto(operatorOrigin);
  await page.getByLabel("Email address", { exact: true }).fill(operatorEmail);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Set up your authenticator", exact: true }),
  ).toBeVisible();
  await enrol(page, true);
  await page.getByRole("button", { name: "Billing plans", exact: true }).click();
  await page.getByLabel("Plan ID", { exact: true }).fill(planId);
  await page.getByLabel("Name", { exact: true }).fill("Browser operator plan");
  await page
    .getByLabel("Stripe price ID", { exact: true })
    .fill(`price_browser${fixture.replaceAll("-", "")}`);
  await page.getByLabel("Seat limit", { exact: true }).fill("7");
  await page.getByRole("combobox", { name: /^Billing interval/ }).selectOption("month");
  await page.getByLabel("Available for new checkout", { exact: true }).check();
  await page
    .getByLabel("Reason (at least 10 characters)", { exact: true })
    .fill("Customer-approved browser test plan configuration");
  await page.getByRole("button", { name: "Save plan", exact: true }).click();
  await expect(page.getByText("Plan saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Organisations", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Operator browser organisation", exact: true })
    .click();
  await page.getByRole("button", { name: "Open support tickets", exact: true }).click();
  await expect(
    page.getByText(
      "A tenant administrator must grant this named operator temporary access in organisation settings.",
      { exact: true },
    ),
  ).toBeVisible();

  const adminPage = await context.newPage();
  await adminPage.goto(tenantOrigin);
  await adminPage.getByLabel("Email address", { exact: true }).fill(adminEmail);
  await adminPage.getByLabel("Password", { exact: true }).fill(password);
  await adminPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await enrol(adminPage, false);
  await adminPage
    .getByRole("combobox", { name: /^Manage section/ })
    .selectOption("operator-access");
  await adminPage.getByLabel("Operator email address", { exact: true }).fill(operatorEmail);
  await adminPage.getByRole("button", { name: "Find operator", exact: true }).click();
  await adminPage
    .getByLabel("Expires (within 24 hours, in your local time zone)", { exact: true })
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  await adminPage
    .getByLabel("Reason (at least 10 characters)", { exact: true })
    .fill("Allow a named operator to investigate this browser fixture");
  await adminPage.getByRole("button", { name: "Grant temporary access", exact: true }).click();
  await expect(adminPage.getByText("Support access granted.", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open support tickets", exact: true }).click();
  await page
    .getByRole("button", { name: "INC0001: Operator fixture incident", exact: true })
    .click();
  await expect(
    page.getByText("Grouped internal note for operator support", { exact: true }),
  ).toBeVisible();
  await adminPage.getByRole("button", { name: "Refresh access and history", exact: true }).click();
  await expect(adminPage.getByText(/Ticket viewed/).first()).toBeVisible();

  await page.getByRole("combobox", { name: /^Action/ }).selectOption("set-plan");
  await page.getByRole("combobox", { name: /^Plan/ }).selectOption(planId);
  await page.getByLabel("Seat limit", { exact: true }).fill("7");
  await page.getByRole("combobox", { name: /^Proration choice/ }).selectOption("none");
  await page
    .getByLabel("Reason (at least 10 characters)", { exact: true })
    .fill("Apply the agreed browser fixture plan and seat limit");
  await page.getByRole("button", { name: "Submit action", exact: true }).click();
  await expect(page.getByText(/The action is queued/)).toBeVisible();
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect(page.getByText(planId, { exact: true })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 90000, intervals: [2000, 5000] });
  await expect(page.getByText("Change plan or seats · Complete", { exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  expect(
    (
      await new AxeBuilder({ page: adminPage })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

  await adminPage
    .getByLabel("Revocation reason for Browser operator", { exact: true })
    .fill("The investigation is complete; end this support grant");
  await adminPage
    .getByRole("button", { name: "Revoke access for Browser operator", exact: true })
    .click();
  await expect(adminPage.getByText("Support access revoked.", { exact: true })).toBeVisible();
  await page
    .getByRole("heading", { name: "Read-only support view", exact: true })
    .locator("..")
    .getByRole("button", { name: "Refresh", exact: true })
    .click();
  await expect(
    page.getByText("Grouped internal note for operator support", { exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByText(
      "A tenant administrator must grant this named operator temporary access in organisation settings.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await page.request.get(`${tenantOrigin}/api/operator/auth/session`)).status()).toBe(403);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});
