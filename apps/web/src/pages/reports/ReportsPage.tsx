import { Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button, Card, cx, DataTable, ErrorState, Field, Input, PageHeader, Select, Spinner, useToast } from "../../components/ui";
import { downloadCsv, qs } from "../../lib/api";
import { date, dateTime, humanize, money, qty, today } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

type Col = { key: string; header: string; kind?: "money" | "qty" | "date" | "datetime"; link?: (r: any) => string | null };
interface ReportDef { key: string; title: string; path: string; rowsKey?: string; perm: any; range?: boolean; branch?: boolean; dims?: boolean; days?: boolean; definition: string; cols: Col[] }

const REPORTS: ReportDef[] = [
  { key: "daily", title: "Daily sales", path: "/reports/daily-sales", rowsKey: "sales", perm: "reports.view", range: true, branch: true, definition: "Completed sales by business-local completion date. Net sales are tax-exclusive and after discounts.", cols: [{ key: "day", header: "Day" }, { key: "transactions", header: "Transactions" }, { key: "gross_sales", header: "Gross", kind: "money" }, { key: "discounts", header: "Discounts", kind: "money" }, { key: "net_sales", header: "Net (excl. tax)", kind: "money" }, { key: "tax", header: "Tax", kind: "money" }, { key: "total", header: "Total", kind: "money" }] },
  { key: "collections", title: "Collections by method", path: "/reports/daily-sales", rowsKey: "collections", perm: "reports.view", range: true, branch: true, definition: "Confirmed payments by confirmation date. Cash is the amount retained (tendered minus change).", cols: [{ key: "day", header: "Day" }, { key: "method", header: "Method" }, { key: "count", header: "Count" }, { key: "amount", header: "Amount", kind: "money" }] },
  { key: "salesby", title: "Sales by product / category / branch / cashier", path: "/reports/sales-by", rowsKey: "rows", perm: "reports.view", range: true, branch: true, dims: true, definition: "Margin % = gross profit ÷ net sales. Cost is weighted-average cost at the time of sale (shown only with cost permission).", cols: [{ key: "label", header: "Item" }, { key: "qty", header: "Qty", kind: "qty" }, { key: "transactions", header: "Sales" }, { key: "gross_sales", header: "Gross", kind: "money" }, { key: "discounts", header: "Discounts", kind: "money" }, { key: "net_sales", header: "Net sales", kind: "money" }, { key: "cost", header: "Cost", kind: "money" }, { key: "gross_profit", header: "Gross profit", kind: "money" }, { key: "margin_percent", header: "Margin %" }] },
  { key: "gp", title: "Gross profit and margin", path: "/reports/gross-profit", perm: "reports.financial", range: true, branch: true, definition: "Net revenue = net sales − returns (tax-exclusive). Gross profit = net revenue − cost of sales (net of returned cost). Margin = GP ÷ net revenue; markup = GP ÷ cost.", cols: [{ key: "net_sales", header: "Net sales", kind: "money" }, { key: "returns", header: "Returns", kind: "money" }, { key: "net_revenue", header: "Net revenue", kind: "money" }, { key: "cost_of_sales", header: "Cost of sales", kind: "money" }, { key: "gross_profit", header: "Gross profit", kind: "money" }, { key: "gross_margin_percent", header: "Margin %" }, { key: "markup_percent", header: "Markup %" }] },
  { key: "discounts", title: "Discounts", path: "/reports/discounts-refunds", rowsKey: "discounts", perm: "reports.view", range: true, branch: true, definition: "Every discounted line with reason and approval reference.", cols: [{ key: "sale_number", header: "Sale", link: (r) => `/sales/${r.sale_id}` }, { key: "completed_at", header: "When", kind: "datetime" }, { key: "cashier", header: "Cashier" }, { key: "sku", header: "SKU" }, { key: "gross_amount", header: "Line", kind: "money" }, { key: "discount_amount", header: "Discount", kind: "money" }, { key: "discount_reason", header: "Reason" }, { key: "approval", header: "Approval" }] },
  { key: "refunds", title: "Refunds", path: "/reports/discounts-refunds", rowsKey: "refunds", perm: "reports.view", range: true, branch: true, definition: "Customer returns with refund method and reason.", cols: [{ key: "number", header: "Return" }, { key: "created_at", header: "When", kind: "datetime" }, { key: "sale_number", header: "Sale" }, { key: "refund_method", header: "Method" }, { key: "refund_total", header: "Refund", kind: "money" }, { key: "reason", header: "Reason" }, { key: "processed_by", header: "By" }] },
  { key: "valuation", title: "Inventory valuation", path: "/reports/inventory-valuation", rowsKey: "rows", perm: "reports.view", branch: true, definition: "Weighted-average cost pools per branch. Reconciles to the inventory control account (see Accounting → Reconciliation).", cols: [{ key: "branch", header: "Branch" }, { key: "sku", header: "SKU" }, { key: "name", header: "Name" }, { key: "category", header: "Category" }, { key: "quantity", header: "Qty", kind: "qty" }, { key: "average_cost", header: "Avg cost", kind: "money" }, { key: "value", header: "Value", kind: "money" }] },
  { key: "slow", title: "Slow-moving and ageing stock", path: "/reports/slow-moving", perm: "reports.view", branch: true, days: true, definition: "In-stock items with no sale in the selected number of days, with days since last receipt.", cols: [{ key: "sku", header: "SKU" }, { key: "name", header: "Name" }, { key: "on_hand", header: "On hand", kind: "qty" }, { key: "value", header: "Value", kind: "money" }, { key: "last_sale", header: "Last sale", kind: "datetime" }, { key: "days_since_receipt", header: "Days since receipt" }] },
  { key: "variances", title: "Stock count variances", path: "/reports/count-variances", perm: "reports.view", range: true, branch: true, definition: "Posted count lines with non-zero variance.", cols: [{ key: "number", header: "Count" }, { key: "posted_at", header: "Posted", kind: "datetime" }, { key: "location", header: "Location" }, { key: "sku", header: "SKU" }, { key: "system_qty", header: "System", kind: "qty" }, { key: "counted_qty", header: "Counted", kind: "qty" }, { key: "variance_qty", header: "Variance", kind: "qty" }, { key: "variance_value", header: "Value", kind: "money" }] },
  { key: "transit", title: "Transfers in transit", path: "/reports/transfers-in-transit", perm: "reports.view", definition: "Dispatched quantities not yet received or resolved.", cols: [{ key: "number", header: "Transfer" }, { key: "dispatched_at", header: "Dispatched", kind: "datetime" }, { key: "from_branch", header: "From" }, { key: "to_branch", header: "To" }, { key: "sku", header: "SKU" }, { key: "qty_in_transit", header: "Qty", kind: "qty" }, { key: "value_in_transit", header: "Value", kind: "money" }] },
  { key: "purchases", title: "Purchases by supplier", path: "/reports/purchases-by-supplier", perm: "reports.view", range: true, branch: true, definition: "Posted goods receipts at receipt value.", cols: [{ key: "code", header: "Code" }, { key: "name", header: "Supplier" }, { key: "receipts", header: "Receipts" }, { key: "received_value", header: "Value", kind: "money" }] },
  { key: "supplierageing", title: "Supplier ageing", path: "/reports/supplier-ageing", perm: "reports.financial", definition: "Open supplier invoices by due date (invoice date if none).", cols: [{ key: "name", header: "Supplier" }, { key: "current", header: "Current", kind: "money" }, { key: "d1_30", header: "1–30", kind: "money" }, { key: "d31_60", header: "31–60", kind: "money" }, { key: "d60_plus", header: "60+", kind: "money" }, { key: "total", header: "Total", kind: "money" }] },
  { key: "cashier", title: "Cashier variances", path: "/reports/cashier-variances", perm: "reports.view", range: true, branch: true, definition: "Closed sessions: expected vs counted cash.", cols: [{ key: "number", header: "Session", link: (r) => `/finance/sessions/${r.id}` }, { key: "cashier", header: "Cashier" }, { key: "register", header: "Register" }, { key: "closed_at", header: "Closed", kind: "datetime" }, { key: "expected_cash", header: "Expected", kind: "money" }, { key: "counted_cash", header: "Counted", kind: "money" }, { key: "variance", header: "Variance", kind: "money" }, { key: "variance_reason", header: "Reason" }, { key: "approval", header: "Approval" }] },
  { key: "expenses", title: "Expenses by category", path: "/reports/expenses", perm: "reports.financial", range: true, branch: true, definition: "Expense documents by expense date (excludes till paid-outs and cost of sales).", cols: [{ key: "category", header: "Category" }, { key: "account", header: "Account" }, { key: "documents", header: "Documents" }, { key: "amount", header: "Amount", kind: "money" }] },
  { key: "audit", title: "Audit activity", path: "/reports/audit", perm: "admin.audit", range: true, definition: "Security and business events (sensitive values redacted).", cols: [{ key: "created_at", header: "When", kind: "datetime" }, { key: "actor_name", header: "User" }, { key: "action", header: "Action" }, { key: "summary", header: "Summary" }, { key: "ip_address", header: "IP" }] },
];

export default function ReportsPage() {
  const { can, branchId, me } = useSession();
  const toast = useToast();
  const available = REPORTS.filter((r) => can(r.perm));
  const [key, setKey] = useState(available[0]?.key);
  const def = available.find((r) => r.key === key)!;
  const [from, setFrom] = useState(today()); const [to, setTo] = useState(today());
  const [branch, setBranch] = useState<string>(branchId ?? "");
  const [dimension, setDimension] = useState("variant"); const [days, setDays] = useState("60");
  const params = { from: def?.range ? from : undefined, to: def?.range ? to : undefined, branch_id: def?.branch ? branch || undefined : undefined, dimension: def?.dims ? dimension : undefined, days: def?.days ? days : undefined };
  const q = useApi<any>(def ? `${def.path}${qs(params)}` : null, [key, JSON.stringify(params)]);
  if (!def) return <Card><p className="text-sm">No reports available for your role.</p></Card>;
  const raw = q.data ? (def.rowsKey ? q.data[def.rowsKey] : q.data) : undefined;
  const rows = raw ? (Array.isArray(raw) ? raw : [raw]).map((r: any, i: number) => ({ ...r, __id: i })) : undefined;
  const cols = def.cols.filter((c) => !rows?.length || c.key in rows[0] || c.link);
  const render = (c: Col) => (r: any) => {
    const v = r[c.key];
    const text = c.kind === "money" ? money(v) : c.kind === "qty" ? qty(v) : c.kind === "date" ? date(v) : c.kind === "datetime" ? dateTime(v) : c.key === "method" || c.key === "refund_method" ? humanize(String(v ?? "")) : v ?? "—";
    const href = c.link?.(r);
    return href ? <Link className="text-brand-700 hover:underline" to={href}>{text}</Link> : text;
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
      <nav aria-label="Reports" className="space-y-0.5">
        <h1 className="mb-3 text-xl font-semibold">Reports</h1>
        {available.map((r) => <button key={r.key} onClick={() => setKey(r.key)} className={cx("block w-full rounded-md px-3 py-2 text-left text-sm", r.key === key ? "bg-brand-50 font-medium text-brand-800" : "text-slate-600 hover:bg-slate-100")}>{r.title}</button>)}
      </nav>
      <div className="min-w-0 space-y-4">
        <PageHeader title={def.title} subtitle={def.definition} actions={<Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(`${def.path}${qs({ ...params, format: "csv" })}`, `${def.key}-${from}.csv`).catch((e) => toast(e.message, "error"))}>Export CSV</Button>} />
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            {def.range && <><Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field><Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field></>}
            {def.branch && <Field label="Branch">{(id) => <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">All my branches</option>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</Select>}</Field>}
            {def.dims && <Field label="Group by">{(id) => <Select id={id} value={dimension} onChange={(e) => setDimension(e.target.value)}>{["variant", "product", "category", "branch", "cashier"].map((d) => <option key={d} value={d}>{humanize(d)}</option>)}</Select>}</Field>}
            {def.days && <Field label="No sale in (days)">{(id) => <Input id={id} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" />}</Field>}
          </div>
        </Card>
        <Card padded={false}>{q.error ? <div className="p-4"><ErrorState error={q.error} onRetry={q.refetch} /></div> : q.isLoading && !rows ? <Spinner /> : <DataTable rowKey="__id" rows={rows} columns={cols.map((c) => ({ key: c.key, header: c.header, align: c.kind === "money" || c.kind === "qty" ? "right" : undefined, render: render(c) }))} />}</Card>
      </div>
    </div>
  );
}
