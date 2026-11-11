import { useState } from "react";
import { Link, useParams } from "react-router";
import { Button, Card, DataTable, ErrorState, ErrorText, Field, Input, Kpi, Modal, PageHeader, Select, Spinner, Tabs, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { date, dateTime, money } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { CustomerForm } from "./CustomersPage";

export default function CustomerDetail() {
  const { id } = useParams();
  const { can, branchId } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState("open");
  const { data: c, isLoading, error, refetch } = useApi<any>(`/customers/${id}`);
  const statement = useApi<any>(tab === "statement" ? `/customers/${id}/statement` : null);
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(false);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-5">
      <PageHeader title={c.name} subtitle={`${c.code}${c.phone ? ` · ${c.phone}` : ""}`} actions={<>
        {can("customers.manage") && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
        {can("customers.credit") && <Button onClick={() => setPaying(true)}>Receive payment</Button>}
      </>} />
      <div className="grid gap-4 sm:grid-cols-4">
        <Kpi label="Receivable" value={money(c.receivable)} />
        <Kpi label="Deposits / store credit" value={money(c.deposits)} hint="Liability — not revenue" />
        <Kpi label="Credit limit" value={c.credit_status === "ACTIVE" ? money(c.credit_limit) : "No credit"} />
        <Kpi label="Available credit" value={c.credit_status === "ACTIVE" ? money(c.available_credit) : "—"} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "open", label: "Open invoices" }, { key: "statement", label: "Statement" }, { key: "sales", label: "Recent purchases" }]} />
      {tab === "open" && <Card padded={false}><DataTable rows={c.open_invoices} empty={<p className="p-6 text-center text-sm text-slate-500">No outstanding credit sales.</p>} columns={[
        { key: "number", header: "Sale", render: (s: any) => <Link className="text-brand-700 hover:underline" to={`/sales/${s.id}`}>{s.number}</Link> },
        { key: "completed_at", header: "Date", render: (s: any) => dateTime(s.completed_at) }, { key: "due_date", header: "Due", render: (s: any) => date(s.due_date) },
        { key: "credit_amount", header: "On account", align: "right", render: (s: any) => money(s.credit_amount) }, { key: "outstanding", header: "Outstanding", align: "right", render: (s: any) => <strong>{money(s.outstanding)}</strong> },
      ]} /></Card>}
      {tab === "statement" && <Card padded={false}><DataTable rows={statement.data?.lines.map((l: any, i: number) => ({ ...l, id: i }))} loading={statement.isLoading} columns={[
        { key: "date", header: "Date", render: (l: any) => date(l.date) }, { key: "source_number", header: "Document" }, { key: "description", header: "Description" }, { key: "account", header: "Account" },
        { key: "debit", header: "Debit", align: "right", render: (l: any) => (Number(l.debit) ? money(l.debit) : "") }, { key: "credit", header: "Credit", align: "right", render: (l: any) => (Number(l.credit) ? money(l.credit) : "") },
        { key: "balance", header: "Balance", align: "right", render: (l: any) => money(l.balance) },
      ]} /></Card>}
      {tab === "sales" && <Card padded={false}><DataTable rows={c.recent_sales} columns={[{ key: "number", header: "Sale", render: (s: any) => <Link className="text-brand-700 hover:underline" to={`/sales/${s.id}`}>{s.number}</Link> }, { key: "completed_at", header: "Date", render: (s: any) => dateTime(s.completed_at) }, { key: "total", header: "Total", align: "right", render: (s: any) => money(s.total) }]} /></Card>}
      {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} onDone={() => { setEditing(false); refetch(); }} />}
      {paying && <PaymentForm customer={c} branchId={branchId!} onClose={() => setPaying(false)} onDone={() => { setPaying(false); refetch(); toast("Payment recorded"); }} />}
    </div>
  );
}

function PaymentForm({ customer, branchId, onClose, onDone }: { customer: any; branchId: string; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<any[]>("/financial-accounts/options");
  const [amount, setAmount] = useState(""); const [acc, setAcc] = useState(""); const [ref, setRef] = useState("");
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const autoAllocate = (amt: string) => {
    let left = Number(amt || 0); const a: Record<string, string> = {};
    for (const inv of customer.open_invoices) { if (left <= 0) break; const take = Math.min(left, Number(inv.outstanding)); a[inv.id] = String(take); left -= take; }
    setAlloc(a);
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api(`/customers/${customer.id}/payments`, { idempotent: true, body: { branch_id: branchId, financial_account_id: acc, amount, reference: ref || undefined, allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([sale_id, v]) => ({ sale_id, amount: v })) } }); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Receive payment — ${customer.name}`} size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!amount || !acc} onClick={submit}>Record payment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Amount">{(id) => <Input id={id} value={amount} onChange={(e) => { setAmount(e.target.value); autoAllocate(e.target.value); }} />}</Field>
        <Field label="Received into">{(id) => <Select id={id} value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">Select…</option>{accounts.data?.filter((a) => a.kind !== "TILL").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label="Reference">{(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
      </div>
      <h3 className="mb-2 mt-4 text-sm font-semibold">Allocate to open invoices</h3>
      {customer.open_invoices.map((inv: any) => <div key={inv.id} className="mb-1 flex items-center gap-3 text-sm"><span className="w-40">{inv.number}</span><span className="w-32 text-slate-500">due {money(inv.outstanding)}</span><Input aria-label={`Allocate to ${inv.number}`} className="h-8 w-32" value={alloc[inv.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [inv.id]: e.target.value })} /></div>)}
      <p className="mt-2 text-xs text-slate-500">Any unallocated amount is held as a customer deposit (a liability), not revenue.</p>
      <ErrorText error={err} />
    </Modal>
  );
}
