import { APPROVAL_TYPES, DEFAULT_ROLES, PERMISSIONS } from "@retail/api-contracts";
import type { PrismaClient, Tx } from "@retail/db";
import { D } from "../common/money";
import { hashPassword } from "../modules/auth/auth.service";

/**
 * Chart of accounts. Numbering is inspired by SYSCOHADA classes for
 * familiarity in Cameroon, but this is NOT a certified SYSCOHADA chart and the
 * system uses perpetual inventory. Have your accountant review the mapping.
 * [code, name, type, subtype, allow_manual, is_postable]
 */
export const CHART: [string, string, "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE", string | null, boolean, boolean][] = [
  ["1010", "Owner's capital", "EQUITY", "capital", true, true],
  ["1190", "Opening balance equity", "EQUITY", "opening", true, true],
  ["1200", "Retained earnings", "EQUITY", "retained", true, true],
  ["3110", "Merchandise inventory", "ASSET", "inventory", false, true],
  ["3810", "Inventory in transit", "ASSET", "inventory", false, true],
  ["4010", "Suppliers — payables", "LIABILITY", "payable", false, true],
  ["4081", "Goods received not invoiced", "LIABILITY", "grni", false, true],
  ["4091", "Supplier advances", "ASSET", "advance", false, true],
  ["4110", "Customers — receivables", "ASSET", "receivable", false, true],
  ["4191", "Customer deposits and unapplied receipts", "LIABILITY", "deposit", false, true],
  ["4431", "Output tax payable", "LIABILITY", "tax", false, true],
  ["4452", "Recoverable input tax", "ASSET", "tax", true, true],
  ["5200", "Banks", "ASSET", "bank", false, false],
  ["5500", "Mobile money wallets", "ASSET", "mobile_money", false, false],
  ["5700", "Cash", "ASSET", "cash", false, false],
  ["5710", "Tills", "ASSET", "cash", false, false],
  ["5850", "Card clearing", "ASSET", "clearing", false, true],
  ["6010", "Cost of goods sold", "EXPENSE", "cost_of_sales", false, true],
  ["6019", "Purchase price variance", "EXPENSE", "cost_of_sales", false, true],
  ["6580", "Inventory shrinkage and losses", "EXPENSE", "cost_of_sales", false, true],
  ["6581", "Damaged and expired stock write-offs", "EXPENSE", "cost_of_sales", false, true],
  ["6040", "Store supplies and packaging", "EXPENSE", "operating", true, true],
  ["6050", "Electricity and water", "EXPENSE", "operating", true, true],
  ["6180", "Transport and delivery", "EXPENSE", "operating", true, true],
  ["6220", "Rent", "EXPENSE", "operating", true, true],
  ["6270", "Advertising and marketing", "EXPENSE", "operating", true, true],
  ["6280", "Telephone and internet", "EXPENSE", "operating", true, true],
  ["6310", "Bank and mobile money fees", "EXPENSE", "operating", true, true],
  ["6380", "Security services", "EXPENSE", "operating", true, true],
  ["6582", "Cash shortages", "EXPENSE", "operating", false, true],
  ["6590", "Miscellaneous expenses", "EXPENSE", "operating", true, true],
  ["6610", "Salaries and wages", "EXPENSE", "operating", true, true],
  ["7010", "Sales of merchandise", "REVENUE", "sales", false, true],
  ["7019", "Sales returns and allowances", "REVENUE", "sales_returns", false, true],
  ["7580", "Inventory gains", "REVENUE", "other_income", false, true],
  ["7581", "Cash overages", "REVENUE", "other_income", false, true],
];

export const POSTING_MAP: Record<string, [string, string]> = {
  inventory: ["3110", "Inventory control (weighted-average cost)"],
  inventory_in_transit: ["3810", "Stock dispatched between branches, not yet received"],
  grni: ["4081", "Goods received not invoiced (cleared by supplier invoice)"],
  supplier_payable: ["4010", "Supplier payables control"],
  supplier_advance: ["4091", "Unallocated supplier payments / advances"],
  input_tax: ["4452", "Recoverable input tax (if configured)"],
  customer_receivable: ["4110", "Customer receivables control"],
  customer_deposit: ["4191", "Customer deposits / unapplied receipts (not revenue)"],
  output_tax: ["4431", "Output tax payable (default when tax rate has no account)"],
  sales_revenue: ["7010", "Sales revenue, tax-exclusive"],
  sales_returns: ["7019", "Sales returns (contra revenue)"],
  cost_of_sales: ["6010", "Cost of goods sold"],
  purchase_price_variance: ["6019", "Invoice vs receipt price differences"],
  inventory_gain: ["7580", "Count surpluses / found stock"],
  inventory_loss: ["6580", "Count shortages, losses, transfer shortages"],
  inventory_writeoff: ["6581", "Damaged / expired / non-restockable stock"],
  cash_over: ["7581", "Till overages at session close"],
  cash_short: ["6582", "Till shortages at session close"],
  payment_fees: ["6310", "Bank / mobile money / card fees"],
  opening_equity: ["1190", "Counterpart for opening balances"],
  retained_earnings: ["1200", "Retained earnings"],
  rounding: ["6590", "Rounding differences"],
};

export const DEFAULT_POLICIES: Record<string, { amount?: string; percent?: string; description: string }> = {
  DISCOUNT: { percent: "10", description: "Line discounts above this % of the line amount" },
  PRICE_OVERRIDE: { description: "Any sale below the minimum price" },
  REFUND: { amount: "25000", description: "Refunds above this amount, or outside the return window" },
  STOCK_ADJUSTMENT: { amount: "10000", description: "Adjustments/write-offs/count variances above this value" },
  PURCHASE_ORDER: { amount: "500000", description: "Purchase orders above this total" },
  CUSTOMER_CREDIT: { description: "Credit sales that exceed the customer's limit" },
  MANUAL_JOURNAL: { description: "All manual journals" },
  PERIOD_REOPEN: { description: "Reopening a closed fiscal period" },
  CASH_VARIANCE: { amount: "1000", description: "Cashier closing variances above this amount" },
  PAID_OUT: { amount: "10000", description: "Till paid-outs above this amount" },
};

export const EXPENSE_CATEGORIES: [string, string][] = [
  ["Rent", "6220"], ["Electricity and water", "6050"], ["Salaries and wages", "6610"], ["Transport and delivery", "6180"],
  ["Advertising", "6270"], ["Telephone and internet", "6280"], ["Security", "6380"], ["Store supplies", "6040"], ["Bank fees", "6310"], ["Miscellaneous", "6590"],
];

export async function upsertPermissions(db: PrismaClient | Tx) {
  for (const p of PERMISSIONS) {
    await db.permission.upsert({ where: { code: p.code }, create: { code: p.code, module: p.module, description: p.description, sensitive: !!(p as any).sensitive }, update: { module: p.module, description: p.description, sensitive: !!(p as any).sensitive } });
  }
}

/** Creates a business with roles, chart of accounts, posting rules, approval policies and reference data. No transactions. */
export async function setupBusiness(db: PrismaClient, input: { name: string; legalName?: string; phone?: string; address?: string; isDemo: boolean }) {
  await upsertPermissions(db);
  return db.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: { name: input.name, legal_name: input.legalName ?? null, phone: input.phone ?? null, address: input.address ?? null, is_demo: input.isDemo, receipt_footer: "Thank you for shopping with us. Keep your receipt for returns." },
    });
    const perms = await tx.permission.findMany();
    for (const [code, def] of Object.entries(DEFAULT_ROLES)) {
      await tx.role.create({ data: { business_id: business.id, code, name: def.name, description: def.description, is_system: true, permissions: { create: def.permissions.map((p) => ({ permission_id: perms.find((x) => x.code === p)!.id })) } } });
    }
    const ids: Record<string, string> = {};
    for (const [code, name, type, subtype, manual, postable] of CHART) {
      ids[code] = (await tx.account.create({ data: { business_id: business.id, code, name, type, subtype, allow_manual: manual, is_postable: postable, is_control: !manual && postable } })).id;
    }
    for (const [key, [code, description]] of Object.entries(POSTING_MAP)) {
      await tx.postingRule.create({ data: { business_id: business.id, key, account_id: ids[code], description } });
    }
    for (const [type, p] of Object.entries(DEFAULT_POLICIES)) {
      await tx.approvalPolicy.create({ data: { business_id: business.id, request_type: type, threshold_amount: p.amount ? D(p.amount) : null, threshold_percent: p.percent ? D(p.percent) : null, approver_permission: (APPROVAL_TYPES as any)[type], description: p.description } });
    }
    for (const [name, code] of EXPENSE_CATEGORIES) await tx.expenseCategory.create({ data: { business_id: business.id, name, account_id: ids[code] } });
    for (const [code, name] of [["PCS", "Piece"], ["CTN", "Carton"], ["PK", "Pack"], ["BOX", "Box"], ["DZ", "Dozen"], ["PR", "Pair"], ["SET", "Set"], ["KG", "Kilogram"], ["L", "Litre"], ["M", "Metre"], ["BAG", "Bag"], ["BALE", "Bale"], ["HEAP", "Heap"]]) {
      await tx.unit.create({ data: { business_id: business.id, code, name } });
    }
    await tx.taxRate.create({ data: { business_id: business.id, code: "NONE", name: "No tax / exempt", rate_percent: D(0) } });
    await tx.priceList.create({ data: { business_id: business.id, code: "RETAIL", name: "Standard retail", kind: "RETAIL" } });
    await tx.priceList.create({ data: { business_id: business.id, code: "WHOLESALE", name: "Wholesale", kind: "WHOLESALE" } });
    // Business-level collection accounts
    await addFinancialAccount(tx, business.id, null, { code: "BANK-MAIN", name: "Main bank account", kind: "BANK", glCode: "5210", glParent: "5200" });
    await addFinancialAccount(tx, business.id, null, { code: "MOMO-WALLET", name: "Mobile money wallet", kind: "MOBILE_MONEY", glCode: "5510", glParent: "5500", provider: "SIMULATOR" });
    await tx.financialAccount.create({ data: { business_id: business.id, code: "CARD-CLEARING", name: "Card payments clearing", kind: "CLEARING", gl_account_id: ids["5850"], provider: "CARD" } });
    return business;
  });
}

export async function addFinancialAccount(tx: Tx, businessId: string, branchId: string | null, a: { code: string; name: string; kind: any; glCode: string; glParent: string; provider?: string }) {
  const parent = await tx.account.findFirst({ where: { business_id: businessId, code: a.glParent } });
  const gl = await tx.account.create({ data: { business_id: businessId, code: a.glCode, name: a.name, type: "ASSET", subtype: a.kind.toLowerCase(), parent_id: parent?.id ?? null, allow_manual: false } });
  return tx.financialAccount.create({ data: { business_id: businessId, branch_id: branchId, code: a.code, name: a.name, kind: a.kind, gl_account_id: gl.id, provider: a.provider ?? null } });
}

/** Branch with standard locations and a safe account. */
export async function createBranchWithDefaults(tx: Tx, businessId: string, input: { code: string; name: string; kind: "STORE" | "WAREHOUSE"; address?: string; phone?: string }) {
  const br = await tx.branch.create({ data: { business_id: businessId, code: input.code, name: input.name, kind: input.kind, address: input.address ?? null, phone: input.phone ?? null } });
  const defs: [string, string, any, boolean, boolean][] = input.kind === "WAREHOUSE"
    ? [["STORE", "Main store", "STOREROOM", true, true], ["QUAR", "Quarantine", "QUARANTINE", false, false], ["DMG", "Damaged", "DAMAGED", false, false]]
    : [["FLOOR", "Sales floor", "SALES_FLOOR", true, true], ["BACK", "Back store", "STOREROOM", true, false], ["QUAR", "Quarantine", "QUARANTINE", false, false], ["DMG", "Damaged", "DAMAGED", false, false]];
  for (const [code, name, kind, sellable, def] of defs) await tx.location.create({ data: { business_id: businessId, branch_id: br.id, code, name, kind, is_sellable: sellable, is_default: def } });
  const safeCount = await tx.account.count({ where: { business_id: businessId, code: { startsWith: "573" } } });
  await addFinancialAccount(tx, businessId, br.id, { code: `SAFE-${input.code}`, name: `Safe — ${input.name}`, kind: "SAFE", glCode: `573${safeCount + 1}`, glParent: "5700" });
  return br;
}

export async function createRegister(tx: Tx, businessId: string, branchId: string, code: string, name: string) {
  const br = await tx.branch.findUniqueOrThrow({ where: { id: branchId } });
  const loc = await tx.location.findFirstOrThrow({ where: { branch_id: branchId, is_default: true } });
  const n = await tx.account.count({ where: { business_id: businessId, code: { startsWith: "571" }, is_postable: true } });
  const fa = await addFinancialAccount(tx, businessId, branchId, { code: `TILL-${br.code}-${code}`, name: `Till ${br.code} ${name}`, kind: "TILL", glCode: `571${String(n + 1).padStart(2, "0")}`, glParent: "5710" });
  return tx.cashRegister.create({ data: { business_id: businessId, branch_id: branchId, location_id: loc.id, code, name, till_account_id: fa.id } });
}

export async function createUser(tx: Tx, businessId: string, u: { email: string; name: string; password: string; roles: string[]; branchIds: string[]; allBranches?: boolean; mustChange?: boolean }) {
  const roles = await tx.role.findMany({ where: { business_id: businessId, code: { in: u.roles } } });
  return tx.user.create({
    data: {
      business_id: businessId, email: u.email.toLowerCase(), full_name: u.name, password_hash: await hashPassword(u.password), all_branches: !!u.allBranches,
      default_branch_id: u.branchIds[0] ?? null, must_change_password: !!u.mustChange,
      roles: { create: roles.map((r) => ({ role_id: r.id })) }, branch_access: { create: u.branchIds.map((b) => ({ branch_id: b })) },
    },
  });
}
