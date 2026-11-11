import { Link, useParams } from "react-router";
import { Card, DataTable, ErrorState, Money, PageHeader, Spinner, Status } from "../../components/ui";
import { dateTime, humanize, money } from "../../lib/format";
import { useApi } from "../../lib/hooks";

export default function SessionDetail() {
  const { id } = useParams();
  const { data, isLoading, error, refetch } = useApi<any>(`/cashier-sessions/${id}`);
  const sales = useApi<any>(`/sales?session_id=${id}&pageSize=100`);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const s = data.session;
  return (
    <div className="space-y-5">
      <PageHeader title={`Cashier session ${s.number}`} subtitle={<>{dateTime(s.opened_at)} → {s.closed_at ? dateTime(s.closed_at) : "open"} · <Status value={s.status} /></>} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Cash reconciliation">
          <dl className="space-y-1 text-sm">
            {[["Opening float", data.opening_float], ["Cash sales (retained)", data.cash_sales], ["  Cash tendered", data.cash_tendered], ["  Change given", data.change_given], ["Cash refunds", data.cash_refunds], ["Cash in", data.cash_in], ["Cash drops", data.cash_drops], ["Paid-outs", data.paid_outs]].map(([l, v]) => <div key={l} className="flex justify-between"><dt className="whitespace-pre text-slate-600">{l}</dt><dd><Money value={v} /></dd></div>)}
            <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><dt>Expected cash</dt><dd><Money value={s.expected_cash ?? data.expected_cash} /></dd></div>
            {s.counted_cash != null && <><div className="flex justify-between"><dt>Counted</dt><dd><Money value={s.counted_cash} /></dd></div><div className="flex justify-between font-semibold"><dt>Variance</dt><dd className={Number(s.variance) ? "text-amber-700" : "text-emerald-700"}><Money value={s.variance} /></dd></div>{s.variance_reason && <p className="text-xs text-slate-500">Reason: {s.variance_reason}</p>}</>}
          </dl>
        </Card>
        <Card title="Collections by method">
          {data.collections_by_method.map((c: any) => <div key={c.method} className="flex justify-between text-sm"><span>{humanize(c.method)} ({c.count})</span><Money value={c.amount} /></div>)}
          <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-sm font-semibold"><span>{data.sales_count} sales</span><Money value={data.sales_total} /></div>
        </Card>
      </div>
      <Card title="Cash movements" padded={false}><DataTable rows={data.movements} columns={[{ key: "created_at", header: "When", render: (m: any) => dateTime(m.created_at) }, { key: "kind", header: "Type", render: (m: any) => humanize(m.kind) }, { key: "reason", header: "Reason" }, { key: "amount", header: "Amount", align: "right", render: (m: any) => money(m.amount) }]} /></Card>
      <Card title="Sales" padded={false}><DataTable rows={sales.data?.items} columns={[{ key: "number", header: "Sale", render: (x: any) => <Link className="text-brand-700 hover:underline" to={`/sales/${x.id}`}>{x.number}</Link> }, { key: "created_at", header: "When", render: (x: any) => dateTime(x.created_at) }, { key: "status", header: "Status", render: (x: any) => <Status value={x.status} /> }, { key: "total", header: "Total", align: "right", render: (x: any) => money(x.total) }]} /></Card>
    </div>
  );
}
