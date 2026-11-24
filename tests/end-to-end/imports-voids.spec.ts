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

test.describe.serial("built-in catalogue, imports and voids", () => {
  test("built-in catalogue: owner adds it, enters starting stock with prices, and a deactivated category disappears from the till", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/products/setup");
    await expect(page.getByText("Built-in catalogue")).toBeVisible();
    await page.getByRole("button", { name: /^Re-add 599 missing$/ }).click(); // the demo business starts without it
    await expect(page.getByText(/599 built-in products re-added, 13 categories/)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("tr", { hasText: "Babies & Mother Care" })).toBeVisible();

    // starting stock: the counted quantity is pre-filled; enter buying and selling prices
    await page.getByRole("button", { name: "Starting stock" }).click();
    await page.getByPlaceholder("Search products").fill("Hand Fans");
    await expect(page.getByLabel("Quantity of Hand Fans")).toHaveValue("9");
    await page.getByLabel("Buying price of Hand Fans").click();
    await page.keyboard.type("1500", { delay: 30 });
    await page.getByLabel("Selling price of Hand Fans").fill("2500");
    await expect(page.getByLabel("Buying price of Hand Fans")).toHaveValue("1500");
    await page.getByRole("button", { name: "Save starting stock" }).click();
    await expect(page.getByText(/1 products stocked \(OPN-/)).toBeVisible();
    await expect(page.getByLabel("Quantity of Hand Fans")).toHaveCount(0);

    // sold at the till while its category is active…
    const cashier = await as(browser, "cashier2.akwa@mboa.demo");
    await cashier.getByRole("link", { name: "Point of Sale" }).click();
    await cashier.getByLabel("Search products").fill("Hand Fans");
    await expect(cashier.getByRole("button", { name: /Hand Fans/ }).first()).toBeVisible();

    // …hidden once the category is deactivated, back when reactivated
    await page.goto("/products/setup");
    await page.getByRole("button", { name: "Deactivate Household / Home" }).click();
    await expect(page.getByText("“Household / Home” deactivated")).toBeVisible();
    await cashier.getByLabel("Search products").fill("");
    await cashier.getByLabel("Search products").fill("Hand Fans");
    await expect(cashier.getByText("No products match “Hand Fans”.")).toBeVisible();
    await page.getByRole("button", { name: "Activate Household / Home" }).click();
    await expect(page.getByText("“Household / Home” is active again")).toBeVisible();
  });

  test("products show a picture; the owner uploads photos in bulk, matched by file name", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/products?category_id=");
    await page.getByPlaceholder(/Search/).first().fill("Hand Fans");
    await expect(page.getByRole("img", { name: "Hand Fans (illustration)" })).toBeVisible();
    // a 2×2 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");
    await page.getByRole("button", { name: "Upload photos" }).click();
    const dlg = page.getByRole("dialog", { name: "Upload product photos" });
    await expect(dlg.getByLabel("Choose photos")).toBeEnabled();
    await dlg.getByLabel("Choose photos").setInputFiles([{ name: "HOME-001.png", mimeType: "image/png", buffer: png }, { name: "IMG_0001.png", mimeType: "image/png", buffer: png }]);
    await expect(dlg.getByLabel("Product for HOME-001.png")).toHaveValue(/.+/);
    await expect(dlg.getByLabel("Product for IMG_0001.png")).toHaveValue("");
    await dlg.getByRole("button", { name: "Upload 1 photo" }).click();
    await expect(dlg.getByText("Uploaded", { exact: true })).toBeVisible();
    await dlg.getByRole("button", { name: "Close" }).first().click();
    await expect(page.getByRole("img", { name: "Hand Fans", exact: true })).toBeVisible();
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
