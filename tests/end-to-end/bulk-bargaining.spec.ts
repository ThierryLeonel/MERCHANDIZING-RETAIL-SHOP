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

test.describe.serial("stock categories, bulk goods and bargaining", () => {
  test("owner adds a sub-category; duplicates are refused", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/products");
    await page.getByRole("button", { name: "Categories & units" }).click();
    await expect(page.locator("td", { hasText: "Bulk & loose goods" })).toBeVisible();
    await page.getByLabel("Name").fill("Rice & grains (loose)");
    await expect(page.getByLabel("Name")).toHaveValue("Rice & grains (loose)");
    await page.getByLabel("Inside category").selectOption({ label: "Bulk & loose goods" });
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.locator("td", { hasText: "Rice & grains (loose)" })).toBeVisible();
    await page.getByLabel("Name").fill("RICE & grains (loose)");
    await page.getByLabel("Inside category").selectOption({ label: "Bulk & loose goods" });
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("alert")).toContainText("already exists");
  });

  test("cashier bargains a bulk item: below the minimum is refused, an agreed total is accepted", async ({ browser }) => {
    const page = await as(browser, "cashier2.akwa@mboa.demo"); // has an open session on Akwa till 2 (demo data)
    await page.getByRole("link", { name: "Point of Sale" }).click();
    await page.getByLabel("Search products").fill("wax");
    await page.getByRole("button", { name: /Wax print fabric, per metre/ }).click();
    await page.getByLabel("Quantity for Wax print fabric, per metre").fill("2.5");
    await page.getByRole("button", { name: "Bargain", exact: true }).click();
    await page.getByLabel(/Agreed price per M/).fill("1900");
    await expect(page.getByRole("alert")).toContainText("cannot be accepted");
    await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
    await page.getByRole("button", { name: /Total for 2.5 M/ }).click();
    await page.getByLabel(/Agreed total for 2.5 M/).fill("5500");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("agreed")).toBeVisible();
    await page.getByRole("button", { name: /^Pay/ }).click();
    await page.getByRole("button", { name: "Complete sale" }).click();
    await expect(page.getByText(/Sale S-.* completed/)).toBeVisible();
    await expect(page.getByText("2.5 M × 2,200")).toBeVisible();
  });
});
