import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorState, ErrorText, Field, Input, Kpi, Modal, PageHeader, Select, Spinner, Status, Tabs, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { PrintButton, PrintSheet } from "../../components/print";
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
  const payments = useApi<any[]>(tab === "payments" ? `/customers/${id}/payments` : null);
  const [voidingPay, setVoidingPay] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-5">
      <PageHeader title={c.name} subtitle={`${c.code}${c.phone ? ` · ${c.phone}` : ""}`} actions={<>
        {can("customers.manage") && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}
        {can("customers.credit") && <Button onClick={() => setPaying(true)}>Receive payment</Button>}
        {can("customers.manage") && <Button variant="ghost" className="text-red-700" onClick={() => setDeleting(true)}>Delete</Button>}
      </>} />
      <ConfirmDialog open={deleting} danger title={`Delete ${c.name}?`} confirmLabel="Delete customer" message="Only customers who have never bought or paid anything can be deleted. Customers with history can be marked inactive instead (Edit)."
        onClose={() => setDeleting(false)} onConfirm={async () => { await api(`/customers/${c.id}`, { method: "DELETE" }); toast(`${c.name} deleted`); navigate("/customers"); }} />
      <ConfirmDialog open={!!voidingPay} danger requireReason title={`Void payment ${voidingPay?.number ?? ""}`} confirmLabel="Void payment"
        message={<>Reverses the <b>{voidingPay && money(voidingPay.amount)}</b> received: the credit sales it paid become outstanding again. The payment stays on record, marked voided. To correct it, void it and receive the payment again.</>}
        onClose={() => setVoidingPay(null)} onConfirm={async (reason) => { await api(`/customers/payments/${voidingPay.id}/void`, { body: { reason } }); payments.refetch(); refetch(); toast("Payment voided"); }} />
      <div className="grid gap-4 sm:grid-cols-4">
        <Kpi label="Receivable" value={money(c.receivable)} />
        <Kpi label="Deposits / store credit" value={money(c.deposits)} hint="Liability — not revenue" />
        <Kpi label="Credit limit" value={c.credit_status === "ACTIVE" ? money(c.credit_limit) : "No credit"} />
        <Kpi label="Available credit" value={c.credit_status === "ACTIVE" ? money(c.available_credit) : "—"} />
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "open", label: "Open invoices" }, { key: "statement", label: "Statement" }, { key: "sales", label: "Recent purchases" }, { key: "payments", label: "Payments received" }]} />
      {tab === "payments" && <Card padded={false}><DataTable rows={payments.data} loading={payments.isLoading} empty={<p className="p-6 text-center text-sm text-slate-500">No account payments yet.</p>} columns={[
        { key: "number", header: "Receipt", render: (p: any) => p.number ?? "—" },
        { key: "created_at", header: "Date", render: (p: any) => dateTime(p.created_at) },
        { key: "method", header: "Method", render: (p: any) => p.method.replace(/_/g, " ").toLowerCase() },
        { key: "ref", header: "Reference", render: (p: any) => p.provider_reference ?? "—" },
        { key: "amount", header: "Amount", align: "right", render: (p: any) => <span className={p.voided_at ? "text-slate-400 line-through" : ""}>{money(p.amount)}</span> },
        { key: "s", header: "", align: "right", render: (p: any) => p.voided_at ? <span title={p.void_reason ?? undefined}><Badge tone="red">Voided</Badge></span> : p.status !== "CONFIRMED" ? <Status value={p.status} /> : can("transactions.void") && <Button size="sm" variant="ghost" onClick={() => setVoidingPay(p)}>Void</Button> },
      ]} /></Card>}
      {tab === "open" && <Card padded={false}><DataTable rows={c.open_invoices} empty={<p className="p-6 text-center text-sm text-slate-500">No outstanding credit sales.</p>} columns={[
        { key: "number", header: "Sale", render: (s: any) => s.kind === "opening" ? <span className="font-medium">{s.number}</span> : <Link className="text-brand-700 hover:underline" to={`/sales/${s.id}`}>{s.number}</Link> },
        { key: "completed_at", header: "Date", render: (s: any) => dateTime(s.completed_at) }, { key: "due_date", header: "Due", render: (s: any) => date(s.due_date) },
        { key: "credit_amount", header: "On account", align: "right", render: (s: any) => money(s.credit_amount) }, { key: "outstanding", header: "Outstanding", align: "right", render: (s: any) => <strong>{money(s.outstanding)}</strong> },
      ]} /></Card>}
      {tab === "statement" && <div className="flex justify-end"><PrintButton target="statement-sheet" label="Print statement" size="sm" /></div>}
      {tab === "statement" && <PrintSheet id="statement-sheet" title={`Statement of account — ${c.name}`} subtitle={<>{c.code}{c.phone ? ` · ${c.phone}` : ""} · Receivable {money(c.receivable)} · Store credit {money(c.deposits)}</>}><Card padded={false}><DataTable rows={statement.data?.lines.map((l: any, i: number) => ({ ...l, id: i }))} loading={statement.isLoading} columns={[
        { key: "date", header: "Date", render: (l: any) => date(l.date) }, { key: "source_number", header: "Document" }, { key: "description", header: "Description" }, { key: "account", header: "Account" },
        { key: "debit", header: "Debit", align: "right", render: (l: any) => (Number(l.debit) ? money(l.debit) : "") }, { key: "credit", header: "Credit", align: "right", render: (l: any) => (Number(l.credit) ? money(l.credit) : "") },
        { key: "balance", header: "Balance", align: "right", render: (l: any) => money(l.balance) },
      ]} /></Card></PrintSheet>}
      {tab === "sales" && <Card padded={false}><DataTable rows={c.recent_sales} columns={[{ key: "number", header: "Sale", render: (s: any) => s.kind === "opening" ? <span className="font-medium">{s.number}</span> : <Link className="text-brand-700 hover:underline" to={`/sales/${s.id}`}>{s.number}</Link> }, { key: "completed_at", header: "Date", render: (s: any) => dateTime(s.completed_at) }, { key: "total", header: "Total", align: "right", render: (s: any) => money(s.total) }]} /></Card>}
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
    try { await api(`/customers/${customer.id}/payments`, { idempotent: true, body: { branch_id: branchId, financial_account_id: acc, amount, reference: ref || undefined, allocations: Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([id, v]) => (customer.open_invoices.find((i: any) => i.id === id)?.kind === "opening" ? { opening_item_id: id, amount: v } : { sale_id: id, amount: v })) } }); onDone(); }
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
