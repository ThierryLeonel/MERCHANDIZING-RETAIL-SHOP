import { useState } from "react";
import { Link } from "react-router";
import { Badge, Card, DataTable, Field, Input, PageHeader, Pagination, SearchInput, Select, Status } from "../../components/ui";
import { dateTime, money } from "../../lib/format";
import { useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

/** All sales (branch-scoped), to find a sale to reprint, return, void or correct. */
export default function SalesPage() {
  const { branchId, can } = useSession();
  const [status, setStatus] = useState("COMPLETED");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const list = useList<any>("/sales", { branch_id: branchId ?? undefined, status: status || undefined, from: from || undefined, to: to ? new Date(new Date(to).getTime() + 86_400_000).toISOString().slice(0, 10) : undefined });
  return (
    <div>
      <PageHeader title="Sales history" subtitle={can("transactions.void") ? "Open a sale to reprint it, process a return, or void it (and re-enter it correctly)." : "Open a sale to reprint it or process a return."} />
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-3">
          <SearchInput value={list.search} onChange={list.setSearch} placeholder="Sale number" className="w-56" />
          <Field label="Status">{(id) => <Select id={id} value={status} onChange={(e) => { setStatus(e.target.value); list.setPage(1); }}><option value="">All</option><option value="COMPLETED">Completed</option><option value="PENDING_PAYMENT">Pending payment</option><option value="CANCELLED">Cancelled</option></Select>}</Field>
          <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => { setFrom(e.target.value); list.setPage(1); }} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => { setTo(e.target.value); list.setPage(1); }} />}</Field>
        </div>
        <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRetry={list.refetch} empty="No sales match these filters." columns={[
          { key: "number", header: "Sale", render: (s) => <Link className="font-medium text-brand-700 hover:underline" to={`/sales/${s.id}`}>{s.number}</Link> },
          { key: "when", header: "Date", render: (s) => dateTime(s.completed_at ?? s.created_at) },
          { key: "customer", header: "Customer", render: (s) => s.customer_name ?? <span className="text-slate-400">Walk-in</span> },
          { key: "cashier", header: "Cashier", render: (s) => s.cashier_name },
          { key: "total", header: "Total", align: "right", render: (s) => <span className={s.voided_at ? "text-slate-400 line-through" : ""}>{money(s.total)}</span> },
          { key: "status", header: "Status", render: (s) => s.voided_at ? <Badge tone="red">Voided</Badge> : <Status value={s.status} /> },
        ]} />
        {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
