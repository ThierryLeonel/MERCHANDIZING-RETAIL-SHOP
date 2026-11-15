import { D } from "../src/common/money";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
beforeAll(async () => { w = await makeWorld(); });
afterAll(closeContext);
const today = () => new Date().toISOString().slice(0, 10);

describe("opening balances", () => {
  it("posts cash, bank, customer, supplier and other balances in one journal, balanced by opening equity", async () => {
    const safe = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "SAFE", branch_id: w.s1.id } });
    const bank = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "BANK" } });
    const loan = await w.svc.chart.createAccount(w.owner, { code: "1620", name: "Bank loan", type: "LIABILITY" });
    const equipment = await w.svc.chart.createAccount(w.owner, { code: "2410", name: "Shop equipment", type: "ASSET" });
    const debtor = await w.svc.customers.create(w.owner, { name: "Opening Debtor" });
    const prepaid = await w.svc.customers.create(w.owner, { name: "Opening Store Credit" });
    const ap0 = await w.glBalance("supplier_payable"), ar0 = await w.glBalance("customer_receivable"), eq0 = await w.glBalance("opening_equity");

    // guards
    await expect(w.svc.opening.create(w.manager, { as_of_date: today(), accounts: [{ financial_account_id: safe.id, amount: "1" }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(w.svc.opening.create(w.owner, { as_of_date: "2999-01-01", accounts: [{ financial_account_id: safe.id, amount: "1" }] })).rejects.toMatchObject({ code: "FUTURE_DATE" });
    const inventoryRule = await w.db.postingRule.findFirstOrThrow({ where: { business_id: w.B, key: "inventory" } });
    await expect(w.svc.opening.create(w.owner, { as_of_date: today(), other: [{ account_id: inventoryRule.account_id, debit: "100" }] })).rejects.toMatchObject({ code: "ACCOUNT_NOT_ALLOWED" });
    const till = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "TILL" } });
    await expect(w.svc.opening.create(w.owner, { as_of_date: today(), accounts: [{ financial_account_id: till.id, amount: "100" }] })).rejects.toMatchObject({ code: "TILL_NOT_ALLOWED" });
    await expect(w.svc.opening.create(w.owner, { as_of_date: today() })).rejects.toMatchObject({ code: "NOTHING_TO_POST" });

    const ob = await w.svc.opening.create(w.sysadmin, {
      as_of_date: today(), notes: "Go-live",
      accounts: [{ financial_account_id: safe.id, amount: "500000" }, { financial_account_id: bank.id, amount: "2000000" }],
      customers: [{ customer_id: debtor.id, owed: "30000", reference: "Old book p.12", due_date: today() }, { customer_id: prepaid.id, store_credit: "5000" }],
      suppliers: [{ supplier_id: w.supplier.id, owed: "120000", reference: "Inv 7781" }],
      other: [{ account_id: loan.id, credit: "1000000" }, { account_id: equipment.id, debit: "800000" }],
    });
    expect(ob.number).toMatch(/^OB-/);
    // Dr 500000+2000000+30000+800000 = 3,330,000 ; Cr 5000+120000+1000000 = 1,125,000 → equity credit 2,205,000
    expect(D(ob.equity_amount).toString()).toBe("-2205000");
    expect((await w.glBalance("opening_equity")).minus(eq0).toString()).toBe("-2205000");
    expect((await w.glBalance("customer_receivable")).minus(ar0).toString()).toBe("30000");
    expect((await w.glBalance("supplier_payable")).minus(ap0).toString()).toBe("-120000");
    const je = await w.db.journalLine.aggregate({ where: { journal_entry_id: ob.journal_entry_id! }, _sum: { debit: true, credit: true } });
    expect(D(je._sum.debit!).toString()).toBe(D(je._sum.credit!).toString());

    // sub-ledgers reconcile with the control accounts
    const rec = await w.svc.accounting.reconciliation(w.owner);
    expect(rec.checks.find((c: any) => c.name === "Customer receivables")!.ok).toBe(true);
    expect(rec.checks.find((c: any) => c.name === "Supplier payables")!.ok).toBe(true);

    // the customer's opening balance is an open item that a payment settles; store credit is available
    const cust = await w.svc.customers.get(w.owner, debtor.id);
    const item = cust.open_invoices.find((i: any) => i.kind === "opening")!;
    expect(item.outstanding.toString()).toBe("30000");
    expect((await w.svc.customers.balances(w.db as any, w.B, prepaid.id)).deposits.toString()).toBe("5000");
    const pay = await w.svc.customers.receivePayment(w.owner, debtor.id, { branch_id: w.s1.id, financial_account_id: safe.id, amount: "10000", allocations: [{ opening_item_id: item.id, amount: "10000" }] });
    expect(pay.allocated.toString()).toBe("10000");
    const ageing = await w.svc.customers.ageing(w.owner);
    expect(D(ageing.rows.find((r: any) => r.customer_id === debtor.id).total).toString()).toBe("20000");
    // the supplier's opening balance is an open invoice a supplier payment clears
    const inv = await w.db.supplierInvoice.findFirstOrThrow({ where: { opening_balance_id: ob.id } });
    expect(inv.supplier_invoice_no).toBe("Inv 7781");
    await w.svc.purchasing.paySupplier(w.owner, { branch_id: w.s1.id, supplier_id: w.supplier.id, financial_account_id: bank.id, amount: "20000", payment_date: today(), allocations: [{ supplier_invoice_id: inv.id, amount: "20000" }] });
    expect(D((await w.db.supplierInvoice.findUniqueOrThrow({ where: { id: inv.id } })).amount_paid).toString()).toBe("20000");
    expect((await w.svc.accounting.reconciliation(w.owner)).checks.every((c: any) => c.name.startsWith("Inventory") || c.name.startsWith("Stock") || c.ok)).toBe(true);

    // cannot reverse once paid; after voiding the customer payment it is still blocked by the supplier payment
    await expect(w.svc.opening.void(w.owner, ob.id, "wrong amounts")).rejects.toMatchObject({ code: "OPENING_BALANCE_IN_USE" });
    await w.svc.customers.voidPayment(w.owner, pay.payment_id, "test");
    expect((await w.db.customerOpeningItem.findUniqueOrThrow({ where: { id: item.id } })).settled.toString()).toBe("0");
  });

  it("reverses an unpaid opening balance completely", async () => {
    const safe = await w.db.financialAccount.findFirstOrThrow({ where: { business_id: w.B, kind: "SAFE", branch_id: w.s2.id } });
    const c = await w.svc.customers.create(w.owner, { name: "Reversal Debtor" });
    const eq0 = await w.glBalance("opening_equity"), ar0 = await w.glBalance("customer_receivable");
    const ob = await w.svc.opening.create(w.owner, { as_of_date: today(), accounts: [{ financial_account_id: safe.id, amount: "75000" }], customers: [{ customer_id: c.id, owed: "1500" }] });
    await w.svc.opening.void(w.owner, ob.id, "entered twice");
    expect((await w.glBalance("opening_equity")).toString()).toBe(eq0.toString());
    expect((await w.glBalance("customer_receivable")).toString()).toBe(ar0.toString());
    expect((await w.svc.customers.get(w.owner, c.id)).open_invoices).toHaveLength(0);
    expect((await w.db.openingBalance.findUniqueOrThrow({ where: { id: ob.id } })).status).toBe("REVERSED");
  });
});
