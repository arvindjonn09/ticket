import { test, expect, type Page } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { cleanupFixture } from "./fixture-cleanup";

const require = createRequire(resolve("apps/api/package.json"));
const { PrismaClient } = require("@prisma/client");
const { hash } = require("argon2");
const password = "Complete-browser-password-2026!",
  slug = `complete-${randomUUID()}`;
test.use({ actionTimeout: 10000 });
let owner: InstanceType<typeof PrismaClient>, tenantId: string;
function code(secret: string) {
  const bits = [...secret]
    .map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", key).update(counter).digest(),
    offset = digest.at(-1)! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function signIn(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Organisation", { exact: true }).fill(slug);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (email.startsWith("agent@")) {
    await expect(
      page.getByRole("heading", { name: "Set up your authenticator", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Begin setup", exact: true }).click();
    await page.locator("details summary").click();
    const secret = await page.getByLabel("Setup secret", { exact: true }).inputValue();
    await page.getByLabel("Authenticator code", { exact: true }).fill(code(secret));
    await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  }
  if (!email.startsWith("admin@"))
    await expect(
      page.getByRole("heading", { name: /^(My tickets|Tickets)$/, exact: true }),
    ).toBeVisible();
}
async function verifyAdminPanel(page: Page, panel: string) {
  const browser = test.info().project.name || "chromium";
  for (const view of ["light", "dark", "mobile"] as const) {
    await page.setViewportSize(
      view === "mobile" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    if (view !== "mobile")
      await page
        .getByRole("button", { name: view === "light" ? "Light" : "Dark", exact: true })
        .click();
    await page.evaluate(() => window.scrollTo(0, 0));
    if (view === "mobile")
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    expect(
      (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: `test-results/new-panels/${panel}-${browser}-${view}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Light", exact: true }).click();
}
test.beforeAll(async () => {
  owner = new PrismaClient({
    datasourceUrl:
      process.env.MIGRATION_DATABASE_URL ??
      "postgresql://astrama_owner:astrama-local-owner@localhost:5439/astrama",
  });
  const tenant = await owner.tenant.create({
    data: { slug, name: "Complete workflow test", brandName: "Astrama" },
  });
  tenantId = tenant.id;
  const passwordHash = await hash(password),
    ids: Record<string, string> = {};
  for (const role of ["admin", "manager", "vp", "agent", "employee"]) {
    const user = await owner.user.create({
      data: {
        tenantId,
        name: `Test ${role}`,
        email: `${role}@complete.test`,
        role: ["manager", "vp"].includes(role) ? "employee" : role,
        approverEligible: ["manager", "vp"].includes(role),
        isVp: role === "vp",
        passwordHash,
      },
    });
    ids[role] = user.id;
  }
  await owner.user.update({ where: { id: ids.employee }, data: { managerId: ids.manager } });
  const group = await owner.department.create({
    data: { tenantId, name: "Service team", isTriage: true, queueOwnerId: ids.agent },
  });
  await owner.membership.create({ data: { tenantId, departmentId: group.id, userId: ids.agent } });
  await owner.category.create({ data: { tenantId, name: "Applications", departmentId: group.id } });
});
test.afterAll(async () => {
  try {
    if (owner && tenantId) await cleanupFixture(owner, tenantId, slug);
  } finally {
    await owner?.$disconnect();
  }
});

test("administrator invites a user and configures a service; manager and VP approve before fulfilment", async ({
  page,
  browser,
}) => {
  test.setTimeout(150000);
  await signIn(page, "admin@complete.test");
  await page.getByRole("button", { name: "Begin setup", exact: true }).click();
  await page.getByText("Can’t scan? Enter the setup key manually", { exact: true }).click();
  const secret = await page.getByLabel("Setup secret", { exact: true }).inputValue();
  await page.getByLabel("Authenticator code", { exact: true }).fill(code(secret));
  await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Organisation setup" })).toBeVisible();
  const menu = page.getByLabel("Manage section", { exact: false });
  await menu.selectOption({ label: "Workflow automation" });
  await page.getByLabel("Approval reminder after business days", { exact: true }).fill("3");
  await page.getByRole("button", { name: "Save automation settings", exact: true }).click();
  await expect(page.getByText("Automation settings saved.", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/admin/automation")).ok()).toBe(true);
  await verifyAdminPanel(page, "automation");
  await menu.selectOption({ label: "Files and retention" });
  await page.getByLabel("Allowed filename extensions", { exact: false }).fill("txt, pdf");
  await page.getByRole("button", { name: "Save data policy", exact: true }).click();
  await expect(page.getByText("Data policy saved", { exact: true })).toBeVisible();
  await verifyAdminPanel(page, "files-retention");
  await menu.selectOption({ label: "Service health" });
  await expect(page.getByRole("heading", { name: "Service health", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh status", exact: true })).toBeVisible();
  await verifyAdminPanel(page, "service-health");
  await menu.selectOption({ label: "Request catalog & approval policies" });
  const item = page
    .locator("form")
    .filter({ has: page.getByRole("heading", { name: "Create request item" }) });
  const itemForm = (await item.count())
    ? item
    : page
        .locator("form")
        .filter({ has: page.getByLabel("Item name", { exact: true }) })
        .first();
  await itemForm.getByLabel("Item name", { exact: true }).fill("Design software");
  await itemForm.getByLabel("Category", { exact: false }).selectOption({ label: "Applications" });
  await itemForm.getByLabel("Unit price", { exact: true }).fill("250");
  await itemForm.getByLabel("Currency", { exact: true }).fill("AUD");
  await itemForm.getByLabel("Require manager approval", { exact: true }).check();
  await itemForm.getByLabel("Always require VP approval", { exact: true }).check();
  await itemForm.getByLabel("VP approver", { exact: false }).selectOption({ label: "Test vp" });
  await itemForm.getByRole("button", { name: "Create request item", exact: true }).click();
  await expect(page.locator("summary").filter({ hasText: "Design software" })).toBeVisible();
  await menu.selectOption({ label: "Users" });
  const invite = page
    .locator("form")
    .filter({ has: page.getByLabel("Full name", { exact: true }) })
    .first();
  await invite.getByLabel("Full name", { exact: true }).fill("Invited employee");
  await invite.getByLabel("Email address", { exact: true }).fill("invited@complete.test");
  await invite.getByRole("button", { name: "Invite user", exact: true }).click();
  const invitation = page.locator("input[readonly]").filter({ visible: true }).first();
  await expect(invitation).toBeVisible();
  const invitationUrl = await invitation.inputValue();
  const invited = await (await browser.newContext()).newPage();
  await invited.goto(invitationUrl!);
  await invited.getByLabel("New password", { exact: true }).fill(password);
  await invited.getByLabel("Confirm password", { exact: true }).fill(password);
  await invited.getByRole("button", { name: "Activate your account", exact: true }).click();
  await expect(
    invited.getByText("Your account is active. Sign in to continue.", { exact: true }),
  ).toBeVisible();
  await signIn(invited, "invited@complete.test");
  await expect(
    invited.getByRole("heading", { name: /^(My tickets|Tickets)$/, exact: true }),
  ).toBeVisible();
  const employee = await (await browser.newContext()).newPage();
  await signIn(employee, "employee@complete.test");
  await employee.getByRole("link", { name: "Request a service", exact: true }).first().click();
  await employee
    .getByLabel("Request item", { exact: false })
    .selectOption({ label: "Design software" });
  await employee
    .getByLabel("Request summary", { exact: true })
    .fill("Software for customer design");
  await employee
    .getByLabel("Request details", { exact: true })
    .fill("Please provide the configured software for a customer design project.");
  await employee
    .getByLabel("Business justification", { exact: true })
    .fill("Required for the next customer project.");
  await employee.getByRole("button", { name: "Submit request", exact: true }).click();
  await expect(
    employee.getByRole("heading", { name: "Software for customer design", exact: true }),
  ).toBeVisible();
  const ticketUrl = employee.url();
  await employee.evaluate(() => window.scrollTo(0, 0));
  await employee.screenshot({ path: "test-results/request-pending.png", fullPage: true });
  const agent = await (await browser.newContext()).newPage();
  await signIn(agent, "agent@complete.test");
  await agent.goto(ticketUrl);
  await expect(agent.getByRole("button", { name: "Start work", exact: true })).toHaveCount(0);
  for (const role of ["manager", "vp"]) {
    const approver = await (await browser.newContext()).newPage();
    await signIn(approver, `${role}@complete.test`);
    await approver.getByRole("link", { name: "My approvals", exact: true }).click();
    await expect(approver.getByText("Software for customer design", { exact: true })).toBeVisible();
    await approver.getByRole("button", { name: "Record a decision", exact: true }).click();
    await approver.getByLabel("Decision comment", { exact: true }).fill(`Approved by ${role}`);
    await approver.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(
      approver.getByText("You have no approvals waiting for a decision.", { exact: true }),
    ).toBeVisible();
    await approver.close();
  }
  await agent.reload();
  await agent.getByRole("button", { name: "Assign to me", exact: true }).click();
  await agent.getByRole("button", { name: "Start work", exact: true }).click();
  await agent.getByRole("button", { name: "Fulfil service request", exact: true }).click();
  await agent
    .getByLabel("Internal resolution", { exact: false })
    .fill("Private licence deployment record");
  await agent
    .getByLabel("Resolution for the requester", { exact: false })
    .fill("Your software is ready to use.");
  await agent.getByRole("button", { name: "Complete request", exact: true }).click();
  await expect(agent.getByRole("button", { name: "Complete request", exact: true })).toHaveCount(0);
  await employee.reload();
  await expect(employee.getByText("Your software is ready to use.", { exact: true })).toBeVisible();
  await expect(
    employee.getByText("Private licence deployment record", { exact: true }),
  ).toHaveCount(0);
  for (const theme of ["Light", "Dark"]) {
    await employee.getByRole("button", { name: theme, exact: true }).click();
    expect(
      (
        await new AxeBuilder({ page: employee })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  }
  await employee.setViewportSize({ width: 390, height: 844 });
  expect(await employee.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await employee.evaluate(() => window.scrollTo(0, 0));
  await employee.screenshot({ path: "test-results/request-mobile.png", fullPage: true });
  await agent.getByRole("link", { name: "Reports", exact: true }).click();
  await expect(agent.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(agent.getByRole("link", { name: "Download permitted tickets (CSV)" })).toBeVisible();
  await employee.close();
  await agent.close();
  await invited.close();
});
