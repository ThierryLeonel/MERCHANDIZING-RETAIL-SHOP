import { Browser, expect, Page, test } from "@playwright/test";

async function signIn(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@mboa.demo");
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#main")).toBeVisible();
  return page;
}

test.describe.serial("branches and registers", () => {
  test("owner creates, renames and deletes a cash register — typing keeps focus in each field", async ({ browser }) => {
    const page = await signIn(browser);
    await page.getByRole("link", { name: "Administration" }).click();
    await page.getByRole("tab", { name: "Branches & registers" }).click();

    await page.getByRole("button", { name: "New register" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Branch").selectOption({ index: 1 });
    // type key by key, like a person: the cursor must stay in the field being typed into
    await dlg.getByLabel("Code").click();
    await page.keyboard.type("E2E", { delay: 40 });
    await dlg.getByLabel("Name").click();
    await page.keyboard.type("Express till", { delay: 40 });
    await expect(dlg.getByLabel("Code")).toHaveValue("E2E");
    await expect(dlg.getByLabel("Name")).toHaveValue("Express till");
    await expect(dlg.getByLabel("Name")).toBeFocused();
    await dlg.getByRole("button", { name: "Create" }).click();
    const row = page.locator("tr", { hasText: "Express till" });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Edit register" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Express lane");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    const renamed = page.locator("tr", { hasText: "Express lane" });
    await expect(renamed).toBeVisible();

    await renamed.getByRole("button", { name: "Delete register" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("tr", { hasText: "Express lane" })).toHaveCount(0);
  });

  test("owner creates, edits and deletes a branch; a branch with sales cannot be deleted", async ({ browser }) => {
    const page = await signIn(browser);
    await page.getByRole("link", { name: "Administration" }).click();
    await page.getByRole("tab", { name: "Branches & registers" }).click();

    await page.getByRole("button", { name: "New branch" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Code").fill("POPUP");
    await dlg.getByLabel("Name").fill("Pop-up stand");
    await dlg.getByRole("button", { name: "Create" }).click();
    const row = page.locator("tr", { hasText: "Pop-up stand" });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Edit branch" }).click();
    await page.getByRole("dialog").getByLabel("Name").fill("Pop-up kiosk");
    await page.getByRole("dialog").getByLabel("Phone").fill("699 00 00 00");
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    const renamed = page.locator("tr", { hasText: "Pop-up kiosk" });
    await expect(renamed).toBeVisible();

    await renamed.getByRole("button", { name: "Delete branch" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.locator("tr", { hasText: "Pop-up kiosk" })).toHaveCount(0);

    // the demo's first branch has sales history
    await page.locator("tbody").first().locator("tr").first().getByRole("button", { name: "Delete branch" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("deactivate it instead");
  });

  test("on a phone the menu is a drawer and pages do not scroll sideways", async ({ browser }) => {
    const page = await signIn(browser, { width: 375, height: 740 });
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav).toBeHidden();
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "Administration" }).click();
    await expect(nav).toBeHidden(); // closes after navigating
    await page.getByRole("tab", { name: "Branches & registers" }).click();
    await expect(page.getByRole("button", { name: "New branch" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // dialogs fit the screen and typing stays put
    await page.getByRole("button", { name: "New register" }).click();
    const dlg = page.getByRole("dialog");
    const box = await dlg.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    await dlg.getByLabel("Name").click();
    await page.keyboard.type("Phone till", { delay: 30 });
    await expect(dlg.getByLabel("Name")).toHaveValue("Phone till");
    await expect(dlg.getByLabel("Name")).toBeFocused();
  });
});
