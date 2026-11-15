import { Browser, expect, Page, test } from "@playwright/test";

const PASSWORD = "Demo@12345";
async function as(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  // capture what would be printed instead of opening the print dialog
  await page.addInitScript(() => { (window as any).__printed = []; window.print = () => { (window as any).__printed.push({ cls: document.getElementById("print-root")?.className, html: document.getElementById("print-root")?.innerText ?? "" }); }; });
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  return page;
}
const printed = (page: Page) => page.evaluate(() => (window as any).__printed as { cls: string; html: string }[]);

test.describe.serial("accounts setup, samples and printing", () => {
  test("owner adds and edits a GL account and a bank account", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/accounting");
    await page.getByRole("tab", { name: "Chart of accounts" }).click();
    await page.getByRole("button", { name: "Add account" }).click();
    await page.getByLabel("Code").fill("6058");
    await page.getByLabel("Type").selectOption("EXPENSE");
    await page.getByLabel("Name").fill("Generator fuel");
    await page.getByRole("dialog").getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("cell", { name: "Generator fuel" })).toBeVisible();
    await page.locator("tr", { hasText: "Generator fuel" }).getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Generator fuel and oil");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("cell", { name: "Generator fuel and oil" })).toBeVisible();

    await page.goto("/finance");
    await page.getByRole("button", { name: "Add account" }).click();
    await page.getByLabel("Name").fill("UBA current account");
    await page.getByLabel("Type").selectOption("BANK");
    await page.getByRole("dialog").getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("cell", { name: "UBA current account" })).toBeVisible();
    await page.locator("tr", { hasText: "UBA current account" }).getByRole("button", { name: "Edit" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("cell", { name: "UBA current account" })).toHaveCount(0);
  });

  test("owner loads sample customers and suppliers, then edits and deletes one", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/import?type=suppliers");
    await page.getByRole("button", { name: "Use the sample suppliers" }).click();
    await page.getByRole("button", { name: /^Import \d+ suppliers$/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible();
    await page.goto("/import?type=customers");
    await page.getByRole("button", { name: "Use the sample customers" }).click();
    await page.getByRole("button", { name: /^Import \d+ customers$/ }).click();
    await expect(page.getByText("Import complete")).toBeVisible();

    await page.goto("/purchasing?tab=suppliers");
    await page.locator("tr", { hasText: "Beverage distributor (sample)" }).getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Name").fill("Brasseries depot Bassa");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("cell", { name: "Brasseries depot Bassa" })).toBeVisible();
    await page.locator("tr", { hasText: "Household goods trader (sample)" }).getByRole("button", { name: "Edit" }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("cell", { name: "Household goods trader (sample)" })).toHaveCount(0);
  });

  test("reports, statements, session reports and receipts print with a proper header", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/reports");
    await page.getByRole("button", { name: "Print" }).click();
    let p = (await printed(page)).at(-1)!;
    expect(p.cls).toBe("print-report");
    expect(p.html).toContain("Mboa Home & Style");
    expect(p.html).toMatch(/Printed .*by /);

    await page.goto("/accounting");
    await page.getByRole("tab", { name: "Profit & loss" }).click();
    await page.getByRole("button", { name: "Print" }).first().click();
    p = (await printed(page)).at(-1)!;
    expect(p.html).toContain("Profit and loss");
    expect(p.html).toContain("Gross profit");

    await page.goto("/sales");
    await page.locator("tbody tr").first().getByRole("link").click();
    await page.getByRole("button", { name: "Reprint receipt" }).click();
    p = (await printed(page)).at(-1)!;
    expect(p.cls).toBe("print-receipt");
    expect(p.html).toMatch(/Receipt\s*S-/);
  });

  test("owner sees the audit retention panel; nothing in the demo data is old enough to delete", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/admin");
    await page.getByRole("tab", { name: "Audit log" }).click();
    await expect(page.getByText("Clear old audit entries")).toBeVisible();
    await expect(page.getByText(/^0\s*entries before/)).toBeVisible();
    await page.getByLabel("Your password").fill("Demo@12345");
    await expect(page.getByRole("button", { name: /Delete .*old entries/ })).toBeDisabled();
  });

  test("owner downloads a backup", async ({ browser }) => {
    const page = await as(browser, "owner@mboa.demo");
    await page.goto("/admin");
    await page.getByRole("tab", { name: "Backup & reset" }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download backup" }).click()]);
    expect(download.suggestedFilename()).toMatch(/backup-.*\.sql\.gz$/);
  });
});
