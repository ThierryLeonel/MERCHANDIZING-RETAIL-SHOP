import { expect, test } from "@playwright/test";

// Runs last (file name): clearing removes the demo transactions the other tests rely on.
test("owner clears all transactions after confirming name and password", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@mboa.demo");
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("tab", { name: "Backup & reset" }).click();
  const button = page.getByRole("button", { name: "Clear all transactions" });
  await expect(button).toBeDisabled();
  await page.getByLabel(/Type the business name/).fill("Mboa Home & Style (DEMO)");
  await page.getByLabel("Your password").fill("wrong password");
  page.on("dialog", (d) => d.accept());
  await button.click();
  await expect(page.getByRole("alert")).toContainText("password");
  await page.getByLabel("Your password").fill("Demo@12345");
  await button.click();
  await expect(page.getByRole("status").filter({ hasText: "All transactions were deleted" })).toBeVisible();
  await page.goto("/sales");
  await expect(page.getByText("No sales match these filters.")).toBeVisible();
  await page.goto("/products");
  await expect(page.locator("tbody tr").first()).toBeVisible();
});
