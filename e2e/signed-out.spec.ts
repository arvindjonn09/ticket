import { expect, test } from "@playwright/test";

test("shows the sign-in page when there is no active session", async ({ page }) => {
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"message":"Unauthenticated"}',
    }),
  );

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "A little help. A clear way forward." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
