/** English UI strings. Add fr.ts with the same keys for French; components read via t(). */
export const en = {
  "nav.dashboard": "Dashboard", "nav.pos": "Point of Sale", "nav.products": "Products", "nav.inventory": "Inventory", "nav.purchasing": "Purchasing",
  "nav.customers": "Customers", "nav.finance": "Finance", "nav.accounting": "Accounting", "nav.reports": "Reports", "nav.approvals": "Approvals", "nav.admin": "Administration",
  "common.save": "Save", "common.cancel": "Cancel", "common.search": "Search", "common.loading": "Loading…", "common.empty": "Nothing here yet",
  "common.error": "Something went wrong", "common.retry": "Retry", "common.close": "Close", "common.confirm": "Confirm", "common.export": "Export CSV",
  "auth.signin": "Sign in", "auth.email": "Email", "auth.password": "Password", "auth.signout": "Sign out",
  "demo.banner": "Demonstration data — fictional business. Do not use for real trading.",
} as const;
export type MessageKey = keyof typeof en;
