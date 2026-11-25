import { expect, test } from "@playwright/test";

// Playwright 1.65.x Firefox crashes when ARIA reflection crosses JS worlds.
// Keep this regression when updating the matched package and Docker image.
// https://github.com/microsoft/playwright/issues/44135
test("accessible labels survive page-side ARIA reflection", async ({ page }) => {
  await page.setContent(
    '<section aria-labelledby="heading"><h1 id="heading">Mail setup</h1><label for="password">Password</label><input id="password"></section>',
  );
  await page.evaluate(() => {
    void document.querySelector("section")!.ariaLabelledByElements;
  });
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(1);
});
