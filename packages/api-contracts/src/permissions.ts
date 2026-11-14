/**
 * Permission catalogue and default role grants — the single source of truth
 * shared by the API (enforcement, seeding) and web app (menus).
 * See documentation/requirements/permission-matrix.md (generated from this file).
 */
export interface PermissionDef { code: string; module: string; description: string; sensitive?: boolean }

export const PERMISSIONS = [
  { code: "dashboard.view", module: "dashboard", description: "View dashboard" },
  { code: "pos.sell", module: "pos", description: "Ring up sales at the POS" },
  { code: "pos.hold", module: "pos", description: "Hold and recall carts" },
  { code: "pos.discount", module: "pos", description: "Apply discounts within the policy limit" },
  { code: "pos.price_override", module: "pos", description: "Override price on fixed-price items (min-price breaches still need approval)", sensitive: true },
  { code: "pos.credit_sale", module: "pos", description: "Sell on customer credit" },
  { code: "pos.return", module: "pos", description: "Process customer returns and exchanges" },
  { code: "pos.confirm_payment", module: "pos", description: "Manually confirm electronic payments with a reference", sensitive: true },
  { code: "sessions.open", module: "sessions", description: "Open a cashier session" },
  { code: "sessions.close", module: "sessions", description: "Count and close own cashier session" },
  { code: "sessions.cash_drop", module: "sessions", description: "Record cash drops to the safe" },
  { code: "sessions.paid_out", module: "sessions", description: "Record paid-outs from the till", sensitive: true },
  { code: "sessions.view_all", module: "sessions", description: "View all cashier sessions" },
  { code: "products.view", module: "products", description: "View catalogue" },
  { code: "products.manage", module: "products", description: "Create and edit products" },
  { code: "products.view_cost", module: "products", description: "See cost prices and margins", sensitive: true },
  { code: "prices.manage", module: "products", description: "Manage price lists and branch prices", sensitive: true },
  { code: "inventory.view", module: "inventory", description: "View stock levels and movements" },
  { code: "inventory.adjust", module: "inventory", description: "Request stock adjustments and write-offs" },
  { code: "inventory.transfer", module: "inventory", description: "Create, dispatch and receive transfers" },
  { code: "inventory.count", module: "inventory", description: "Run physical counts" },
  { code: "inventory.opening", module: "inventory", description: "Post opening stock balances", sensitive: true },
  { code: "purchasing.view", module: "purchasing", description: "View purchase orders and receipts" },
  { code: "purchasing.manage", module: "purchasing", description: "Create and submit purchase orders" },
  { code: "purchasing.receive", module: "purchasing", description: "Receive goods" },
  { code: "suppliers.view", module: "purchasing", description: "View suppliers" },
  { code: "suppliers.manage", module: "purchasing", description: "Create and edit suppliers" },
  { code: "payables.manage", module: "purchasing", description: "Post supplier invoices and payments", sensitive: true },
  { code: "customers.view", module: "customers", description: "View customers" },
  { code: "customers.manage", module: "customers", description: "Create and edit customers" },
  { code: "customers.credit", module: "customers", description: "Set credit limits and receive account payments", sensitive: true },
  { code: "finance.view", module: "finance", description: "View financial accounts and sessions" },
  { code: "finance.manage", module: "finance", description: "Internal transfers, settlements, reconciliations", sensitive: true },
  { code: "expenses.manage", module: "finance", description: "Record expenses", sensitive: true },
  { code: "accounting.view", module: "accounting", description: "View chart of accounts and journals" },
  { code: "accounting.journal", module: "accounting", description: "Create manual journals (approval required)", sensitive: true },
  { code: "accounting.periods", module: "accounting", description: "Close fiscal periods", sensitive: true },
  { code: "reports.view", module: "reports", description: "Operational reports" },
  { code: "reports.financial", module: "reports", description: "Financial statements and margin reports", sensitive: true },
  { code: "approvals.view", module: "approvals", description: "View approval requests" },
  { code: "approve.discount", module: "approvals", description: "Approve excessive discounts", sensitive: true },
  { code: "approve.price_override", module: "approvals", description: "Approve below-minimum prices", sensitive: true },
  { code: "approve.refund", module: "approvals", description: "Approve refunds", sensitive: true },
  { code: "approve.stock_adjustment", module: "approvals", description: "Approve stock adjustments, write-offs and count variances", sensitive: true },
  { code: "approve.purchase", module: "approvals", description: "Approve high-value purchase orders", sensitive: true },
  { code: "approve.credit", module: "approvals", description: "Approve customer credit exceptions", sensitive: true },
  { code: "approve.journal", module: "approvals", description: "Approve manual journals", sensitive: true },
  { code: "approve.period_reopen", module: "approvals", description: "Approve reopening a closed period", sensitive: true },
  { code: "approve.cash_variance", module: "approvals", description: "Approve cashier closing variances and paid-outs", sensitive: true },
  { code: "admin.users", module: "admin", description: "Manage users and branch access" },
  { code: "admin.roles", module: "admin", description: "Manage roles and permissions" },
  { code: "admin.settings", module: "admin", description: "Business settings, branches, registers, taxes" },
  { code: "admin.audit", module: "admin", description: "View audit log" },
] as const satisfies readonly PermissionDef[];

export type PermissionCode = (typeof PERMISSIONS)[number]["code"];

const ALL = PERMISSIONS.map((p) => p.code) as PermissionCode[];
const VIEW_ONLY = ALL.filter((c) => c.endsWith(".view") || c.startsWith("reports.") || c === "admin.audit" || c === "products.view_cost");

export const DEFAULT_ROLES: Record<string, { name: string; description: string; permissions: PermissionCode[] }> = {
  OWNER: { name: "Owner", description: "Full business authority", permissions: ALL },
  STORE_MANAGER: {
    name: "Store Manager",
    description: "Runs a branch; approves operational exceptions",
    permissions: [
      "dashboard.view", "pos.sell", "pos.hold", "pos.discount", "pos.price_override", "pos.credit_sale", "pos.return", "pos.confirm_payment",
      "sessions.open", "sessions.close", "sessions.cash_drop", "sessions.paid_out", "sessions.view_all",
      "products.view", "products.manage", "products.view_cost", "prices.manage",
      "inventory.view", "inventory.adjust", "inventory.transfer", "inventory.count",
      "purchasing.view", "purchasing.manage", "purchasing.receive", "suppliers.view", "suppliers.manage",
      "customers.view", "customers.manage", "customers.credit", "finance.view", "expenses.manage",
      "reports.view", "reports.financial", "approvals.view",
      "approve.discount", "approve.price_override", "approve.refund", "approve.stock_adjustment", "approve.purchase",
      "approve.credit", "approve.cash_variance",
    ],
  },
  CASHIER: {
    name: "Cashier",
    description: "Operates the POS",
    permissions: ["dashboard.view", "pos.sell", "pos.hold", "pos.discount", "sessions.open", "sessions.close", "sessions.cash_drop", "products.view", "customers.view", "customers.manage"],
  },
  PURCHASING_OFFICER: {
    name: "Purchasing Officer",
    description: "Raises purchase orders and manages suppliers",
    permissions: ["dashboard.view", "purchasing.view", "purchasing.manage", "suppliers.view", "suppliers.manage", "payables.manage", "products.view", "products.view_cost", "inventory.view", "reports.view"],
  },
  STOREKEEPER: {
    name: "Storekeeper",
    description: "Receives, counts and moves stock",
    permissions: ["dashboard.view", "inventory.view", "inventory.adjust", "inventory.transfer", "inventory.count", "purchasing.view", "purchasing.receive", "products.view", "suppliers.view", "reports.view"],
  },
  ACCOUNTANT: {
    name: "Accountant",
    description: "Books, reconciles and reports",
    permissions: [
      "dashboard.view", "accounting.view", "accounting.journal", "accounting.periods", "finance.view", "finance.manage", "expenses.manage",
      "payables.manage", "suppliers.view", "customers.view", "customers.credit", "products.view", "products.view_cost", "inventory.view",
      "purchasing.view", "sessions.view_all", "reports.view", "reports.financial", "approvals.view", "approve.journal", "approve.period_reopen",
    ],
  },
  SYSTEM_ADMIN: {
    name: "System Administrator",
    description: "Technical administration — no financial approval authority",
    permissions: ["dashboard.view", "admin.users", "admin.roles", "admin.settings", "admin.audit", "products.view"],
  },
  AUDITOR: { name: "Read-only Auditor", description: "Read-only access to records and reports", permissions: VIEW_ONLY },
};

/** Approval request types and the permission each requires to decide. */
export const APPROVAL_TYPES = {
  DISCOUNT: "approve.discount",
  PRICE_OVERRIDE: "approve.price_override",
  REFUND: "approve.refund",
  STOCK_ADJUSTMENT: "approve.stock_adjustment",
  PURCHASE_ORDER: "approve.purchase",
  CUSTOMER_CREDIT: "approve.credit",
  MANUAL_JOURNAL: "approve.journal",
  PERIOD_REOPEN: "approve.period_reopen",
  CASH_VARIANCE: "approve.cash_variance",
  PAID_OUT: "approve.cash_variance",
} as const satisfies Record<string, PermissionCode>;
export type ApprovalType = keyof typeof APPROVAL_TYPES;
