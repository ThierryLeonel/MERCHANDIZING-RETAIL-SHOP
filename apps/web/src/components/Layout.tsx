import { BarChart3, BookOpen, Boxes, CheckSquare, ChevronsLeft, ChevronsRight, LayoutDashboard, LogOut, Package, Settings, ShoppingCart, Truck, Users, Wallet } from "lucide-react";
import { ReactNode, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import type { PermissionCode } from "@retail/api-contracts";
import { t } from "../i18n";
import type { MessageKey } from "../i18n/en";
import { useSession } from "../lib/session";
import { cx, Select } from "./ui";

export const NAV: { to: string; label: MessageKey; icon: typeof LayoutDashboard; any: PermissionCode[] }[] = [
  { to: "/", label: "nav.dashboard", icon: LayoutDashboard, any: ["dashboard.view"] },
  { to: "/pos", label: "nav.pos", icon: ShoppingCart, any: ["pos.sell"] },
  { to: "/products", label: "nav.products", icon: Package, any: ["products.view"] },
  { to: "/inventory", label: "nav.inventory", icon: Boxes, any: ["inventory.view"] },
  { to: "/purchasing", label: "nav.purchasing", icon: Truck, any: ["purchasing.view", "suppliers.view"] },
  { to: "/customers", label: "nav.customers", icon: Users, any: ["customers.view"] },
  { to: "/finance", label: "nav.finance", icon: Wallet, any: ["finance.view", "sessions.open"] },
  { to: "/accounting", label: "nav.accounting", icon: BookOpen, any: ["accounting.view", "reports.financial"] },
  { to: "/reports", label: "nav.reports", icon: BarChart3, any: ["reports.view"] },
  { to: "/approvals", label: "nav.approvals", icon: CheckSquare, any: ["approvals.view"] },
  { to: "/admin", label: "nav.admin", icon: Settings, any: ["admin.users", "admin.settings", "admin.audit"] },
];

export function Layout({ children }: { children: ReactNode }) {
  const { me, can, branchId, setBranchId, logout } = useSession();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("nav.collapsed") === "1");
  const navigate = useNavigate();
  const toggle = () => { localStorage.setItem("nav.collapsed", collapsed ? "0" : "1"); setCollapsed(!collapsed); };
  const items = NAV.filter((n) => n.any.some((p) => can(p)));
  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <aside className={cx("no-print flex shrink-0 flex-col border-r border-slate-200 bg-white transition-[width]", collapsed ? "w-16" : "w-60")}>
        <div className="flex h-14 items-center gap-2 border-b border-slate-200 px-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-700 text-sm font-bold text-white">RS</div>
          {!collapsed && <div className="min-w-0"><div className="truncate text-sm font-semibold">{me?.business.name}</div><div className="text-xs text-slate-500">Retail Suite</div></div>}
        </div>
        <nav aria-label="Main navigation" className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} title={collapsed ? t(n.label) : undefined}
              className={({ isActive }) => cx("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium", isActive ? "bg-brand-50 text-brand-800" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")}>
              <n.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />{!collapsed && t(n.label)}
            </NavLink>
          ))}
        </nav>
        <button onClick={toggle} className="flex items-center gap-2 border-t border-slate-200 px-5 py-3 text-xs text-slate-500 hover:text-slate-800" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
        </button>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {me?.business.is_demo && <div className="no-print bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900">{t("demo.banner")}</div>}
        <header className="no-print flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4">
          <div className="flex items-center gap-2">
            <label htmlFor="branch" className="text-xs font-medium text-slate-500">Branch</label>
            <Select id="branch" className="h-9 w-56" value={branchId ?? ""} onChange={(e) => setBranchId(e.target.value)}>
              {me?.branches.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
            </Select>
          </div>
          <div className="flex items-center gap-3">
            <button className="text-right" onClick={() => navigate("/account")}>
              <div className="text-sm font-medium leading-tight">{me?.user.full_name}</div>
              <div className="text-xs text-slate-500">{me?.user.roles.map((r) => r.replace(/_/g, " ").toLowerCase()).join(", ")}</div>
            </button>
            <button onClick={() => logout().then(() => navigate("/login"))} className="rounded-md p-2 text-slate-500 hover:bg-slate-100" aria-label={t("auth.signout")} title={t("auth.signout")}><LogOut className="h-5 w-5" /></button>
          </div>
        </header>
        <main id="main" className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
