import { D } from "../src/common/money";
import { computeLine } from "../src/modules/catalogue/pricing.service";
import { toCsv } from "../src/modules/reports/reports.service";
import { redact } from "../src/common/redact";
import { businessDayRange } from "../src/common/settings.service";

describe("line arithmetic and rounding", () => {
  it("tax-exclusive: rounds tax HALF-UP at currency precision (XAF, 0 dp)", () => {
    const r = computeLine({ unitPrice: D("1999"), quantity: D("3"), discount: D("0"), taxPercent: D("19.25"), pricesIncludeTax: false, decimals: 0 });
    expect(r.gross.toString()).toBe("5997");
    expect(r.net.toString()).toBe("5997");
    expect(r.tax.toString()).toBe("1154"); // 1154.4225 → 1154
    expect(r.total.toString()).toBe("7151");
  });
  it("tax-inclusive: extracts tax from the total so net + tax = total exactly", () => {
    const r = computeLine({ unitPrice: D("1150"), quantity: D("1"), discount: D("50"), taxPercent: D("10"), pricesIncludeTax: true, decimals: 0 });
    expect(r.total.toString()).toBe("1100");
    expect(r.tax.toString()).toBe("100");
    expect(r.net.plus(r.tax).equals(r.total)).toBe(true);
  });
  it("uses exact decimals (no binary floating point drift)", () => {
    const r = computeLine({ unitPrice: D("0.1"), quantity: D("3"), discount: D("0"), taxPercent: D("0"), pricesIncludeTax: false, decimals: 2 });
    expect(r.gross.toString()).toBe("0.3");
  });
  it("half-up at .5 boundary", () => {
    const r = computeLine({ unitPrice: D("5"), quantity: D("1"), discount: D("0"), taxPercent: D("10"), pricesIncludeTax: false, decimals: 0 });
    expect(r.tax.toString()).toBe("1"); // 0.5 → 1
  });
});

describe("utilities", () => {
  it("CSV export neutralises formula injection and escapes quotes", () => {
    const csv = toCsv([{ name: '=HYPERLINK("x")', note: 'say "hi"', amount: "-1200" }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"say ""hi"""`);
    expect(csv).toContain("-1200");
  });
  it("redacts sensitive keys in logs and audit data", () => {
    expect(redact({ password: "x", nested: { refresh_token: "y", ok: 1 } })).toEqual({ password: "[REDACTED]", nested: { refresh_token: "[REDACTED]", ok: 1 } });
  });
  it("business day range uses the business timezone (Africa/Douala = UTC+1)", () => {
    const r = businessDayRange("2026-11-11", "2026-11-11", "Africa/Douala");
    expect(r.gte.toISOString()).toBe("2026-11-10T23:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2026-11-11T23:00:00.000Z");
  });
});
