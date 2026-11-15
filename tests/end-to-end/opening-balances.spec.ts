import { expect, test } from "@playwright/test";

test("the system administrator posts opening balances (cash, customer, supplier, loan)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@mboa.demo");
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await page.getByRole("link", { name: "Opening balances" }).click();
  await expect(page.getByRole("heading", { name: "Opening balances", level: 1 })).toBeVisible();

  await page.getByLabel("Opening balance for Safe — Akwa Store").fill("250000");
  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByLabel("Customer", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Owes you").fill("15000");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await page.getByLabel("Supplier", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("You owe").fill("40000");
  await page.getByLabel("Supplier invoice number").fill("E2E-OPEN-1");
  await page.getByRole("button", { name: "Add line" }).click();
  await page.getByLabel("Account", { exact: true }).selectOption({ label: "1010 — Owner's capital" });
  await page.getByLabel("Credit", { exact: true }).fill("100000");

  // debits 265,000 ; credits 140,000 → 125,000 credit to opening equity
  await expect(page.getByText("125,000 FCFA credit")).toBeVisible();
  await page.getByRole("button", { name: "Post opening balances" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Post" }).click();
  await expect(page.getByText(/Opening balances OB-\d+ posted/)).toBeVisible();
  const row = page.locator("tr", { hasText: "OB-0001" });
  await expect(row.getByText("Posted")).toBeVisible();
  await row.getByRole("button", { name: "OB-0001" }).click();
  await expect(page.getByRole("dialog").getByText("Opening balance equity").first()).toBeVisible();
});
