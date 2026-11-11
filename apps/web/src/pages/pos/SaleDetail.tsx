import { Printer } from "lucide-react";
import { Link, useParams } from "react-router";
import { Button, Card, DataTable, ErrorState, Money, PageHeader, Spinner, Status } from "../../components/ui";
import { dateTime, humanize, money, qty } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Receipt } from "./Receipt";

export default function SaleDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { data: s, isLoading, error, refetch } = useApi<any>(`/sales/${id}`);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-5">
      <PageHeader title={`Sale ${s.number}`} subtitle={<>{dateTime(s.completed_at ?? s.created_at)} · {s.branch?.name} · cashier {s.cashier_name} · <Status value={s.status} /></>} actions={<>
        {s.journal_entry_id && can("accounting.view") && <Link to={`/accounting/journals/${s.journal_entry_id}`}><Button variant="secondary">View journal</Button></Link>}
        <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Reprint receipt</Button>
      </>} />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card title="Lines" padded={false}>
            <DataTable rows={s.lines} columns={[
              { key: "d", header: "Item", render: (l: any) => <div><div className="font-medium">{l.description}</div><div className="text-xs text-slate-500">{l.sku} · {l.price_source.replace(/_/g, " ").toLowerCase()}{l.discount_reason && ` · discount: ${l.discount_reason}`}</div></div> },
              { key: "q", header: "Qty", align: "right", render: (l: any) => `${qty(l.quantity)} ${l.unit_code}` },
              { key: "p", header: "Unit price", align: "right", render: (l: any) => money(l.unit_price) },
              { key: "disc", header: "Discount", align: "right", render: (l: any) => (Number(l.discount_amount) ? money(l.discount_amount) : "—") },
              { key: "tax", header: "Tax", align: "right", render: (l: any) => money(l.tax_amount) },
              { key: "t", header: "Total", align: "right", render: (l: any) => <strong>{money(l.line_total)}</strong> },
              ...(can("products.view_cost") ? [{ key: "c", header: "Cost", align: "right" as const, render: (l: any) => money(l.cost_amount) }] : []),
              { key: "r", header: "Returned", align: "right", render: (l: any) => qty(l.qty_returned_base) },
            ]} />
          </Card>
          <Card title="Payments" padded={false}>
            <DataTable rows={s.payments} columns={[
              { key: "m", header: "Method", render: (p: any) => humanize(p.method) },
              { key: "a", header: "Amount retained", align: "right", render: (p: any) => money(p.amount) },
              { key: "t", header: "Tendered / change", align: "right", render: (p: any) => (p.amount_tendered ? `${money(p.amount_tendered)} / ${money(p.change_given)}` : "—") },
              { key: "s", header: "Status", render: (p: any) => <Status value={p.status} /> },
              { key: "r", header: "Reference / confirmation", render: (p: any) => <span className="text-xs">{p.provider_reference ?? "—"} {p.confirmation_mode && `(${p.confirmation_mode.toLowerCase()})`}</span> },
            ]} />
          </Card>
          {s.returns.length > 0 && <Card title="Returns">{s.returns.map((r: any) => <div key={r.id} className="flex justify-between text-sm"><span>{r.number} · {dateTime(r.created_at)}</span><Money value={r.refund_total} /></div>)}</Card>}
        </div>
        <Card title="Receipt"><Receipt sale={s} /></Card>
      </div>
    </div>
  );
}
