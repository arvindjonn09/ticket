import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const siteOrigin = process.env.PUBLIC_SITE_ORIGIN ?? "http://localhost:4320";

test("visitor can review plans and submit the accessible signup form", async ({ page }) => {
  await page.route("**/api/signup/captcha", (route) =>
    route.fulfill({ json: { mode: "test", token: "test-valid" } }),
  );
  await page.route("**/api/signup/slug-availability**", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  await page.route("**/api/signup", (route) =>
    route.fulfill({
      json: { accepted: true, message: "Check your email to verify your organisation." },
    }),
  );

  await page.goto(new URL("/", siteOrigin).toString());
  await expect(page.getByRole("heading", { name: "Support work, under control." })).toBeVisible();
  await page.getByRole("link", { name: "View plans" }).click();
  await expect(page.getByRole("heading", { name: "Pricing that fits your team" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByText(/\$\s?\d/)).toHaveCount(0);
  await page.locator("main").getByRole("link", { name: "Start a free trial" }).click();
  await page.getByLabel("Organisation address").fill("astrama-trial");
  await page.getByLabel("Company name").fill("Astrama Trial");
  await page.getByLabel("Your name").fill("Trial Admin");
  await page.getByLabel("Work email").fill("trial@example.test");
  await page.getByLabel("Time zone").fill("Australia/Sydney");
  await page.getByRole("checkbox", { name: /terms of service/ }).check();
  await page.getByRole("checkbox", { name: /privacy notice/ }).check();
  await expect(page.getByRole("button", { name: "Email verification link" })).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Email verification link" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
});

test("organisation lookup gives the same neutral response for an email", async ({ page }) => {
  await page.route("**/api/signup/captcha", (route) =>
    route.fulfill({ json: { mode: "test", token: "test-valid" } }),
  );
  await page.route("**/api/signup/find-organisation", (route) =>
    route.fulfill({
      json: {
        accepted: true,
        message: "If an active organisation matches, its sign-in link will be sent by email.",
      },
    }),
  );
  await page.goto(new URL("/find-organisation", siteOrigin).toString());
  await page.getByLabel("Email address").fill("person@example.test");
  await page.getByRole("button", { name: "Email my links" }).click();
  await expect(
    page.getByText("If an active organisation matches, its sign-in link will be sent by email."),
  ).toBeVisible();
});
