import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const password = process.env.DEMO_PASSWORD ?? "Astrama-demo-2026!";
async function login(page: Page, role: "employee" | "agent", organisation = "harbour") {
  await page.goto("/");
  await page.getByLabel("Organisation", { exact: true }).fill(organisation);
  await page.getByLabel("Email address", { exact: true }).fill(`${role}@demo.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^(My tickets|Tickets)$/, exact: true }),
  ).toBeVisible();
}

test("employee and agent complete an incident without leaking internal notes across users or tenants", async ({
  browser,
}) => {
  const employee = await browser.newContext();
  const agent = await browser.newContext();
  const outsider = await browser.newContext();
  const employeePage = await employee.newPage();
  const agentPage = await agent.newPage();
  const otherPage = await outsider.newPage();
  const title = `E2E laptop connection ${Date.now()}`;
  await login(employeePage, "employee");
  await employeePage.getByRole("link", { name: "Report an issue", exact: true }).first().click();
  await employeePage
    .getByLabel("What do you need help with?", { exact: false })
    .selectOption({ label: "Devices & workplace" });
  await employeePage.getByLabel("Give your issue a short title", { exact: false }).fill(title);
  await employeePage
    .getByLabel("Describe the issue", { exact: false })
    .fill("The laptop cannot connect to the docking station after restarting.");
  await employeePage.getByRole("button", { name: "Submit incident", exact: true }).click();
  await expect(employeePage.getByRole("heading", { name: title })).toBeVisible();
  const ticketUrl = employeePage.url();
  await expect(employeePage.getByText("IT Support", { exact: true })).toBeVisible();

  await login(agentPage, "agent");
  await agentPage.goto(ticketUrl);
  await agentPage.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect(agentPage.getByRole("button", { name: "Assign to me", exact: true })).toHaveCount(0);
  if (await agentPage.getByRole("button", { name: "Start work", exact: true }).isVisible()) {
    await agentPage.getByRole("button", { name: "Start work", exact: true }).click();
  }
  await agentPage
    .getByLabel("Message", { exact: true })
    .fill("I am checking the docking station connection.");
  await agentPage.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    agentPage.getByText("I am checking the docking station connection.", { exact: true }),
  ).toBeVisible();
  await agentPage.getByRole("button", { name: "Internal work note", exact: true }).click();
  await agentPage
    .getByLabel("Message", { exact: true })
    .fill("Private diagnostic marker: internal-only-7392.");
  await agentPage.getByRole("button", { name: "Add internal note", exact: true }).click();
  await expect(
    agentPage.getByText("Private diagnostic marker: internal-only-7392.", { exact: true }),
  ).toBeVisible();

  await employeePage.reload();
  await expect(
    employeePage.getByText("I am checking the docking station connection.", { exact: true }),
  ).toBeVisible();
  await expect(
    employeePage.getByText("Private diagnostic marker: internal-only-7392.", { exact: true }),
  ).toHaveCount(0);
  const employeeResponse = await employeePage.request.get(
    `/api/tickets/${ticketUrl.split("/").at(-1)}`,
  );
  expect(await employeeResponse.text()).not.toContain("internal-only-7392");

  await agentPage.getByRole("button", { name: "Resolve incident", exact: true }).click();
  await agentPage
    .getByLabel("Internal resolution", { exact: false })
    .fill("Internal fix marker: replaced faulty docking cable.");
  await agentPage
    .getByLabel("Resolution for the requester", { exact: false })
    .fill("The docking cable has been replaced. Please check your connection.");
  await agentPage.getByRole("button", { name: "Mark as resolved", exact: true }).click();
  await expect(
    agentPage.getByRole("button", { name: "Mark as resolved", exact: true }),
  ).toHaveCount(0);
  await employeePage.reload();
  await expect(
    employeePage.getByRole("heading", { name: "Has this issue been fixed?" }),
  ).toBeVisible();
  await expect(
    employeePage.getByText("Internal fix marker: replaced faulty docking cable."),
  ).toHaveCount(0);
  await employeePage.getByRole("button", { name: "Yes, it’s fixed", exact: true }).click();
  await expect(
    employeePage.getByText("This ticket is closed. No further messages can be added."),
  ).toBeVisible();

  await login(otherPage, "employee", "northstar");
  const denied = await otherPage.request.get(`/api/tickets/${ticketUrl.split("/").at(-1)}`);
  expect(denied.status()).toBe(404);
  await otherPage.goto(ticketUrl);
  await expect(otherPage.getByRole("heading", { name: title })).toHaveCount(0);
  await employeePage.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    employeePage.getByRole("heading", { name: "Welcome back", exact: true }),
  ).toBeVisible();
  await login(employeePage, "employee", "northstar");
  await employeePage.goto(ticketUrl);
  await expect(employeePage.getByRole("heading", { name: title })).toHaveCount(0);
  await employee.close();
  await agent.close();
  await outsider.close();
});

test("light/dark views are accessible and the mobile form fits the viewport", async ({ page }) => {
  await login(page, "employee");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: "test-results/astrama-light.png", fullPage: true });
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: "test-results/astrama-dark.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Report an issue", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Tell us what’s happening" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "test-results/astrama-mobile.png", fullPage: true });
});
