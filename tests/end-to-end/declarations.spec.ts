import { Browser, expect, Page, test } from "@playwright/test";

async function as(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  return page;
}

test.describe.serial("daily balance declarations", () => {
  test("a cashier must declare opening balances before using the app, and closes the day before signing out", async ({ browser }) => {
    const page = await as(browser, "cashier.bonapriso@mboa.demo");
    const sheet = page.getByRole("dialog", { name: /Start of day/ });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Not now" })).toHaveCount(0); // cannot be skipped
    await expect(sheet.getByRole("button", { name: "Declare and start" })).toBeDisabled();
    await expect(sheet.getByText("Orange Money wallet")).toBeVisible();
    await sheet.getByLabel(/Opening balance of Till/).first().click();
    await page.keyboard.type("25000", { delay: 20 });
    await sheet.getByRole("button", { name: "Declare and start" }).click();
    await expect(sheet).toHaveCount(0);

    // signing out asks for the closing balances first
    await page.getByRole("button", { name: "Sign out" }).click();
    const closing = page.getByRole("dialog", { name: /End of day/ });
    await expect(closing).toBeVisible();
    await closing.getByLabel(/Closing balance of Till/).first().fill("25000");
    await closing.getByLabel(/Closing balance of Orange Money wallet/).fill("0");
    await closing.getByRole("button", { name: "Declare and sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
  });

  test("the owner sees who declared, with differences, and who did not", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.getByRole("link", { name: "Daily declarations" }).click();
    const joel = page.locator("tr", { hasText: "Joel Cashier (Bonapriso)" });
    await expect(joel).toBeVisible();
    await expect(joel.getByText("Not declared")).toHaveCount(0);
    await page.getByRole("button", { name: "Details for Joel Cashier (Bonapriso)" }).click();
    await expect(page.getByText("Orange Money wallet").first()).toBeVisible();
    // the e2e setup declared for everyone else; Sandrine (Bonapriso manager) was declared too, so check the counters render
    await expect(page.getByText("Missing opening")).toBeVisible();
    // which roles must declare is set in Administration
    await page.getByRole("link", { name: "Administration" }).click();
    await expect(page.getByText("Daily balance declarations")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Cashier" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Sales Person" })).toBeChecked();
  });
});
