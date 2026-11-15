import { Browser, expect, Page, test } from "@playwright/test";

const PASSWORD = "Demo@12345";
async function as(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  return page;
}

test.describe.serial("imports, starter catalogue and voids", () => {
  test("owner loads the starter catalogue; products without a price are flagged", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.getByRole("link", { name: "Import & export" }).click();
    await page.getByRole("button", { name: "Use the starter catalogue" }).click();
    await expect(page.getByText("3. Review and import")).toBeVisible();
    const importBtn = page.getByRole("button", { name: /^Import \d+ products$/ });
    await expect(importBtn).toBeEnabled();
    await importBtn.click();
    await expect(page.getByText("Import complete")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Go to Products" }).click();
    await page.getByPlaceholder("Search name, code, SKU or barcode").fill("Rice, perfumed");
    await expect(page.locator("tr", { hasText: "Rice, perfumed 5 kg" }).getByText("Price not set")).toBeVisible();
  });

  test("owner imports customers from a CSV file (semicolon-separated, French headers)", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/import?type=customers");
    const csv = "Nom;Téléphone;Adresse\nE2E Client Un;677 12 34 56;Akwa\nE2E Client Deux;699 65 43 21;Bonapriso\n";
    await page.getByLabel("Spreadsheet file").setInputFiles({ name: "clients.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });
    await expect(page.getByText("2 new")).toBeVisible();
    await page.getByRole("button", { name: "Import 2 customers" }).click();
    await expect(page.getByText("Import complete")).toBeVisible();
    await page.goto("/customers");
    await expect(page.getByText("E2E Client Deux")).toBeVisible();
  });

  test("owner voids a sale from Sales history; the sale stays on record as voided", async ({ browser }) => {
    const cashier = await as(browser, "cashier2.akwa@mboa.demo");
    await cashier.getByRole("link", { name: "Point of Sale" }).click();
    await cashier.getByLabel("Search products").fill("T-shirt");
    await cashier.getByRole("button", { name: /Second-hand T-shirt/ }).first().click();
    await expect(cashier.getByRole("button", { name: /^Pay / })).toBeEnabled();
    await cashier.getByRole("button", { name: /^Pay / }).click();
    await cashier.getByRole("button", { name: "Complete sale" }).click();
    const done = cashier.getByText(/Sale (S-[\w-]+) completed/);
    await expect(done).toBeVisible();
    const number = (await done.innerText()).match(/S-[\w-]+/)![0];

    const page = await as(browser, "owner@mboa.demo");
    await page.getByRole("link", { name: "Sales history" }).click();
    await page.getByPlaceholder("Sale number").fill(number);
    await page.getByRole("link", { name: number }).click();
    await page.getByRole("button", { name: "Void sale" }).click();
    await page.getByLabel("Reason").fill("Customer changed their mind before leaving");
    await page.getByLabel("Refund the money").selectOption("CASH_ACCOUNT");
    await page.getByLabel("Paid from account").selectOption({ index: 1 });
    await page.getByRole("dialog").getByRole("button", { name: "Void sale" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Voided" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Void sale" })).toHaveCount(0);

    await page.getByRole("link", { name: "Sales history" }).click();
    await page.getByPlaceholder("Sale number").fill(number);
    await expect(page.locator("tr", { hasText: number }).getByText("Voided")).toBeVisible();
  });
});
