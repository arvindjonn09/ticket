import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const signedIn of [false, true]) {
  test(`BR-01 branding on the ${signedIn ? "employee portal" : "sign-in page"}`, async ({
    page,
  }) => {
    let hideBranding: boolean | undefined = undefined;
    const brandingUrl = "https://astrama.test/?ref=demo";
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/platform/host")
        return route.fulfill({
          json: { mode: "hosted", kind: "tenant", tenantSlug: "demo", hideBranding, brandingUrl },
        });
      if (path === "/api/auth/session")
        return route.fulfill(
          signedIn
            ? {
                json: {
                  user: {
                    id: "user",
                    name: "Demo User",
                    email: "user@demo.test",
                    role: "employee",
                    departmentIds: [],
                  },
                  tenant: {
                    id: "tenant",
                    name: "Demo",
                    slug: "demo",
                    brandName: "Demo",
                    hideBranding,
                    brandingUrl,
                  },
                  csrfToken: "csrf",
                },
              }
            : { status: 401, json: { message: "Sign in required" } },
        );
      if (path === "/api/catalog")
        return route.fulfill({ json: { categories: [], departments: [] } });
      if (path === "/api/tickets")
        return route.fulfill({ json: { tickets: [], nextCursor: null, limitReached: false } });
      await route.abort();
    });
    await page.goto("/tickets");
    const branding = page.getByRole("link", { name: "Powered by Astrama", exact: true });
    await expect(branding).toBeVisible();
    await expect(branding).toHaveAttribute("href", brandingUrl);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      const accessibility = await new AxeBuilder({ page })
        .include(".powered-by-astrama")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
    }
    await page.setViewportSize({ width: 360, height: 800 });
    await expect(branding).toBeVisible();
    hideBranding = true;
    await page.reload();
    await expect(page.locator(signedIn ? ".page-footer" : ".login-form-wrap")).toBeVisible();
    await expect(branding).toHaveCount(0);
  });
}
