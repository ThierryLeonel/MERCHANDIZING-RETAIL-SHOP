import { AlertTriangle, Bell, CheckSquare, Truck } from "lucide-react";
import { Link } from "react-router";
import { Card, ErrorState, Kpi, Money, PageHeader, Spinner } from "../components/ui";
import { money, humanize, qty } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";

export default function Dashboard() {
  const { me, branchId, can } = useSession();
  const { data, isLoading, error, refetch } = useApi<any>(`/reports/dashboard?branch_id=${branchId ?? ""}`, [branchId]);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const trend: { day: string; total: string; transactions: number }[] = data.sales_trend ?? [];
  const max = Math.max(1, ...trend.map((d) => Number(d.total)));
  const branch = me?.branches.find((b) => b.id === branchId);
  return (
    <div className="space-y-5">
      <PageHeader title={`Good day, ${me?.user.full_name.split(" ")[0]}`} subtitle={`${branch ? `${branch.name} · ` : ""}${data.today} · all figures from live records`} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {data.sales_today && <Kpi label={can("reports.view") ? "Sales today" : "My sales today"} value={money(data.sales_today.total)} hint={`${data.sales_today.transactions} transactions · avg ${money(data.sales_today.avg_basket)}`} />}
        {data.gross_profit_today && <Kpi label="Gross profit today" value={money(data.gross_profit_today.gross_profit)} hint={`Net sales ${money(data.gross_profit_today.net_sales)} (tax-exclusive)`} />}
        {data.inventory_value !== undefined && <Kpi label="Inventory value (at cost)" value={money(data.inventory_value)} />}
        {data.low_stock_count !== undefined && <Kpi label="Low-stock SKUs" value={data.low_stock_count} tone={data.low_stock_count > 0 ? "warn" : undefined} hint={<Link className="text-brand-700 hover:underline" to="/inventory?low=1">View reorder list</Link>} />}
        {data.pending_approvals !== undefined && <Kpi label="Pending approvals" value={data.pending_approvals} tone={data.pending_approvals > 0 ? "warn" : undefined} hint={<Link className="text-brand-700 hover:underline" to="/approvals">Open approvals</Link>} />}
        {data.open_purchase_orders !== undefined && <Kpi label="Open purchase orders" value={data.open_purchase_orders} />}
        {data.transfers_in_transit !== undefined && <Kpi label="Transfers in transit" value={data.transfers_in_transit} />}
        {data.open_sessions !== undefined && <Kpi label="Open cashier sessions" value={data.open_sessions} />}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {data.sales_trend && (
          <Card title="Sales — last 7 days" className="lg:col-span-2">
            {trend.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">No completed sales in the last 7 days.</p> : (
              <div className="flex h-48 items-end gap-3" role="img" aria-label="Daily sales bar chart">
                {trend.map((d) => (
                  <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                    <div className="num text-[11px] text-slate-600">{money(d.total, { symbol: false })}</div>
                    <div className="w-full rounded-t bg-brand-600" style={{ height: `${(Number(d.total) / max) * 140}px` }} title={`${d.day}: ${money(d.total)} (${d.transactions})`} />
                    <div className="text-[11px] text-slate-500">{d.day.slice(5)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
        {data.collections_today && (
          <Card title="Collections today">
            {data.collections_today.length === 0 ? <p className="text-sm text-slate-500">No collections yet today.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {data.collections_today.map((c: any) => <li key={c.method} className="flex justify-between py-2"><span>{humanize(c.method)}</span><Money value={c.amount} /></li>)}
              </ul>
            )}
          </Card>
        )}
      </div>
      {data.notifications?.length > 0 && (
        <Card title={<span className="flex items-center gap-2"><Bell className="h-4 w-4" /> Alerts</span>}>
          <ul className="divide-y divide-slate-100 text-sm">
            {data.notifications.map((n: any) => (
              <li key={n.id} className="flex items-start gap-2 py-2"><AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" /><div><div className="font-medium">{n.title}</div><div className="text-slate-500">{n.body}</div></div></li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
