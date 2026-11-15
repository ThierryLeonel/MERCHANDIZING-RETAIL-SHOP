import { expect, test } from "@playwright/test";

test("owner creates, renames and deletes a cash register", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@mboa.demo");
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Administration" }).click();
  await page.getByRole("tab", { name: "Branches & registers" }).click();

  await page.getByRole("button", { name: "New register" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Branch").selectOption({ index: 1 });
  await dlg.getByLabel("Code").fill("E2E");
  await dlg.getByLabel("Name").fill("Express till");
  await page.getByRole("button", { name: "Create" }).click();
  const row = page.locator("tr", { hasText: "Express till" });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Express lane");
  await page.getByRole("button", { name: "Save" }).click();
  const renamed = page.locator("tr", { hasText: "Express lane" });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("button", { name: "Edit" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("tr", { hasText: "Express lane" })).toHaveCount(0);
});
