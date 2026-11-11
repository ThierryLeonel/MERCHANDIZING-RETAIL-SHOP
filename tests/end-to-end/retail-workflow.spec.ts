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

test.describe.serial("purchase → receipt → sale → return → cashier close", () => {
  let poUrl = "";
  let saleNumber = "";

  test("buyer raises a purchase order (auto-approved below threshold)", async ({ browser }) => {
    const page = await as(browser, "buyer@mboa.demo");
    await page.getByRole("link", { name: "Purchasing" }).click();
    await page.getByRole("button", { name: "New purchase order" }).click();
    await page.getByLabel("Supplier").selectOption({ label: "Douala Home Distributors (demo)" });
    await page.getByLabel("Add product").fill("Wooden spoon");
    await page.getByRole("button", { name: /SPN-SET/ }).click();
    await page.getByLabel("Quantity").fill("10");
    await page.getByLabel("Unit cost").fill("1200");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("heading", { name: /Purchase order PO-/ })).toBeVisible();
    poUrl = page.url();
    await page.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("Submitted and auto-approved")).toBeVisible();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  });

  test("storekeeper receives the goods into stock", async ({ browser }) => {
    const page = await as(browser, "storekeeper@mboa.demo");
    await page.goto(poUrl);
    await page.getByRole("button", { name: "Receive goods" }).click();
    await page.getByPlaceholder("Supplier delivery note no.").fill("DN-E2E-1");
    await page.getByRole("button", { name: "Post receipt" }).click();
    await expect(page.getByText("Goods received and posted")).toBeVisible();
    await expect(page.getByText("Fully received").first()).toBeVisible();
  });

  test("cashier sells the item for cash and gets a receipt", async ({ browser }) => {
    const page = await as(browser, "cashier2.akwa@mboa.demo");
    await page.getByRole("link", { name: "Point of Sale" }).click();
    await page.getByLabel("Search products").fill("Wooden spoon");
    await page.getByRole("button", { name: /Wooden spoon set/ }).first().click();
    await page.getByRole("button", { name: "Increase" }).click();
    await expect(page.getByRole("button", { name: /Pay 5,500/ })).toBeEnabled();
    await page.getByRole("button", { name: /Pay 5,500/ }).click();
    await page.getByLabel("Cash tendered").fill("10000");
    await expect(page.getByText("4,500 FCFA").last()).toBeVisible(); // change due
    await page.getByRole("button", { name: "Complete sale" }).click();
    const title = page.getByRole("heading", { name: /Sale S-DLA1-\d+ completed/ });
    await expect(title).toBeVisible();
    saleNumber = (await title.textContent())!.match(/S-DLA1-\d+/)![0];
    await expect(page.getByText("Change due:")).toBeVisible();
    await expect(page.locator(".print-area")).toContainText(saleNumber);
    await page.getByRole("button", { name: "New sale" }).click();
  });

  test("manager processes a partial return against the original sale", async ({ browser }) => {
    const page = await as(browser, "manager.akwa@mboa.demo");
    await page.goto("/pos/returns");
    await page.getByLabel("Receipt number").fill(saleNumber);
    await page.getByRole("button", { name: "Find sale" }).click();
    await page.getByLabel(/Return quantity for Wooden spoon/).fill("1");
    await page.getByLabel("Return reason").fill("Customer bought one too many");
    await page.getByLabel("Refund method").selectOption("BANK_TRANSFER");
    await page.getByLabel("Paid from").selectOption({ label: "Main bank account" });
    await page.getByLabel("Refund reference").fill("RF-E2E-1");
    await page.getByRole("button", { name: "Process return" }).click();
    await expect(page.getByText(/Return RET-\d+ recorded — refund 2,750 FCFA/)).toBeVisible();
    // the same line cannot be over-returned
    await page.getByLabel("Receipt number").fill(saleNumber);
    await page.getByRole("button", { name: "Find sale" }).click();
    await expect(page.getByText("returnable 1")).toBeVisible();
  });

  test("cashier counts the drawer and closes the session", async ({ browser }) => {
    const page = await as(browser, "cashier2.akwa@mboa.demo");
    await page.getByRole("link", { name: "Point of Sale" }).click();
    await page.getByRole("button", { name: "Cash & close" }).click();
    const expected = await page.locator("text=Expected in drawer").locator("xpath=following-sibling::*[1]").textContent();
    const amount = expected!.replace(/[^\d]/g, "");
    await page.getByLabel("Counted cash in drawer").fill(amount);
    await expect(page.getByText("Variance:")).toContainText("0 FCFA");
    await page.getByRole("button", { name: "Close session" }).click();
    await expect(page.getByRole("heading", { name: "Open a cashier session" })).toBeVisible();
  });

  test("owner sees the ledger reconcile and the cashier cannot open accounting", async ({ browser }) => {
    const owner = await as(browser, "owner@mboa.demo");
    await owner.goto("/accounting");
    await owner.getByRole("tab", { name: "Reconciliation" }).click();
    await expect(owner.getByLabel("Reconciled")).toHaveCount(7);
    await owner.getByRole("tab", { name: "Trial balance" }).click();
    await expect(owner.getByText("Balanced", { exact: true })).toBeVisible();
    const cashier = await as(browser, "cashier.akwa@mboa.demo");
    await expect(cashier.getByRole("link", { name: "Accounting" })).toHaveCount(0);
    const res = await cashier.request.get("http://127.0.0.1:3100/api/v1/accounting/trial-balance");
    expect(res.status()).toBe(401); // no bearer token outside the app → server refuses
  });
});
