import { Browser, expect, Page, test } from "@playwright/test";

async function signIn(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@mboa.demo");
  await page.getByLabel("Password").fill("Demo@12345");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#main")).toBeVisible();
  return page;
}

/** Text that sticks out of its card, or touches the card's edge (no padding). Content inside a sideways-scrolling table is fine. */
async function spills(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const card of Array.from(document.querySelectorAll<HTMLElement>("#main section"))) {
      const c = card.getBoundingClientRect();
      const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent?.trim();
        const el = n.parentElement;
        if (!text || !el || el.closest(".overflow-x-auto") || !el.offsetParent) continue;
        const r = document.createRange(); r.selectNodeContents(n);
        const b = r.getBoundingClientRect();
        if (!b.width) continue;
        if (b.left < c.left + 4 || b.right > c.right - 4) out.push(`${text.slice(0, 40)} (${Math.round(b.left - c.left)}..${Math.round(c.right - b.right)})`);
      }
      for (const scroller of Array.from(card.querySelectorAll<HTMLElement>(".overflow-x-auto"))) {
        // a table's own cells must keep their padding too
        for (const td of Array.from(scroller.querySelectorAll<HTMLElement>("td[colspan]"))) {
          const cs = getComputedStyle(td);
          if (parseFloat(cs.paddingLeft) < 4 && td.textContent?.trim()) out.push(`unpadded: ${td.textContent.trim().slice(0, 40)}`);
        }
      }
    }
    return out;
  });
}

for (const vp of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 375, height: 740 }]) {
  test(`text stays inside its box (${vp.name})`, async ({ browser }) => {
    const page = await signIn(browser, vp);
    const visits: [string, string | null][] = [["/", null], ["/admin", "Branches & registers"], ["/admin", "Business settings"], ["/products", null], ["/customers", null], ["/opening-balances", null], ["/import", null]];
    for (const [path, tab] of visits) {
      await page.goto(path);
      await expect(page.locator("#main section").first()).toBeVisible();
      if (tab) await page.getByRole("tab", { name: tab }).click();
      await page.waitForTimeout(300);
      expect(await spills(page), `${path}${tab ? " › " + tab : ""}`).toEqual([]);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, `${path} scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });
}
