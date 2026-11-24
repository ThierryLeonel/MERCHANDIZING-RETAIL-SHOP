import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, SearchInput, Select, Status, Tabs, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { date, dateTime, humanize, money, qty, today } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function PurchasingPage() {
  const { can } = useSession();
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get("tab") ?? (can("purchasing.view") ? "orders" : "suppliers"));
  return (
    <div>
      <PageHeader title="Purchasing" subtitle="Order → approve → receive (accepted / damaged / rejected) → match supplier invoice → pay" actions={can("purchasing.manage") && <Link to="/purchasing/orders/new"><Button icon={<Plus className="h-4 w-4" />}>New purchase order</Button></Link>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: "orders", label: "Purchase orders", hidden: !can("purchasing.view") }, { key: "receipts", label: "Goods receipts", hidden: !can("purchasing.view") },
        { key: "invoices", label: "Supplier invoices", hidden: !can("purchasing.view") }, { key: "payments", label: "Supplier payments", hidden: !can("purchasing.view") }, { key: "suppliers", label: "Suppliers" },
      ]} />
      {tab === "orders" && <Orders />}
      {tab === "receipts" && <Receipts />}
      {tab === "invoices" && <Invoices />}
      {tab === "payments" && <SupplierPayments />}
      {tab === "suppliers" && <Suppliers />}
    </div>
  );
}

function Orders() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const list = useList<any>("/purchase-orders", { status }, { sort: "created_at" });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
        <SearchInput value={list.search} onChange={list.setSearch} placeholder="PO number" />
        <Select aria-label="Status" className="w-52" value={status} onChange={(e) => { setStatus(e.target.value); list.setPage(1); }}><option value="">All statuses</option>{["DRAFT", "SUBMITTED", "APPROVED", "PARTIALLY_RECEIVED", "FULLY_RECEIVED", "CLOSED", "CANCELLED"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
      </div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} sort={list.sort} onSort={list.onSort} onRowClick={(p) => nav(`/purchasing/orders/${p.id}`)} columns={[
        { key: "number", header: "PO", sortable: true, render: (p) => <span className="font-medium">{p.number}</span> },
        { key: "order_date", header: "Date", sortable: true, render: (p) => date(p.order_date) },
        { key: "supplier", header: "Supplier", render: (p) => p.supplier_name },
        { key: "total", header: "Total", align: "right", sortable: true, render: (p) => money(p.total) },
        { key: "status", header: "Status", render: (p) => <Status value={p.status} /> },
        { key: "receipt", header: "Receipt / invoice", render: (p) => <div className="flex gap-1"><Badge tone={p.receipt_status === "FULLY_RECEIVED" ? "green" : p.receipt_status === "PARTIALLY_RECEIVED" ? "amber" : "slate"}>{humanize(p.receipt_status)}</Badge><Badge tone={p.invoice_status === "FULLY_INVOICED" ? "green" : p.invoice_status === "PARTIALLY_INVOICED" ? "amber" : "slate"}>{humanize(p.invoice_status)}</Badge></div> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
    </Card>
  );
}

function Receipts() {
  const list = useList<any>("/goods-receipts");
  return (
    <Card padded={false}>
      <div className="border-b border-slate-200 p-3"><SearchInput value={list.search} onChange={list.setSearch} placeholder="Receipt number" /></div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} columns={[
        { key: "number", header: "Receipt", render: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-slate-500">{dateTime(r.received_at)}</div></div> },
        { key: "supplier_name", header: "Supplier" },
        { key: "lines", header: "Lines", render: (r) => <div className="text-xs">{r.lines.map((l: any) => <div key={l.id}>{l.sku}: {qty(l.accepted_base)} ok{Number(l.damaged_base) > 0 && `, ${qty(l.damaged_base)} damaged`}{Number(l.rejected_base) > 0 && `, ${qty(l.rejected_base)} rejected`} · {qty(l.uninvoiced_base)} uninvoiced</div>)}</div> },
        { key: "total_value", header: "Value", align: "right", render: (r) => money(r.total_value) },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
    </Card>
  );
}

function Invoices() {
  const { can } = useSession();
  const list = useList<any>("/supplier-invoices");
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<any>(null);
  return (
    <Card padded={false} title="Supplier invoices" actions={can("payables.manage") && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>Record invoice</Button>}>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} columns={[
        { key: "number", header: "Invoice", render: (i) => <div><div className="font-medium">{i.supplier_invoice_no}</div><div className="text-xs text-slate-500">{i.number} · {date(i.invoice_date)}</div></div> },
        { key: "supplier_name", header: "Supplier" },
        { key: "due_date", header: "Due", render: (i) => date(i.due_date) },
        { key: "total", header: "Total", align: "right", render: (i) => money(i.total) },
        { key: "outstanding", header: "Outstanding", align: "right", render: (i) => <span className={Number(i.outstanding) > 0 ? "font-medium text-amber-700" : ""}>{money(i.outstanding)}</span> },
        { key: "a", header: "", align: "right", render: (i) => can("payables.manage") && Number(i.outstanding) > 0 && <Button size="sm" variant="secondary" onClick={() => setPaying(i)}>Pay</Button> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      {creating && <InvoiceForm onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.refetch(); }} />}
      {paying && <PayForm invoice={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); list.refetch(); }} />}
    </Card>
  );
}

function InvoiceForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { branchId } = useSession();
  const toast = useToast();
  const ref = useApi<any>("/catalogue/reference");
  const [supplier, setSupplier] = useState("");
  const receipts = useApi<any>(supplier ? `/goods-receipts?supplier_id=${supplier}&pageSize=50` : null, [supplier]);
  const [no, setNo] = useState(""); const [invDate, setInvDate] = useState(today()); const [due, setDue] = useState("");
  const [sel, setSel] = useState<Record<string, { qty: string; cost: string }>>({});
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const openLines = (receipts.data?.items ?? []).flatMap((r: any) => r.lines.filter((l: any) => Number(l.uninvoiced_base) > 0).map((l: any) => ({ ...l, receipt: r.number })));
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api("/supplier-invoices", { idempotent: true, body: { branch_id: branchId, supplier_id: supplier, supplier_invoice_no: no, invoice_date: invDate, due_date: due || undefined, lines: Object.entries(sel).map(([id, v]) => ({ goods_receipt_line_id: id, quantity_base: v.qty, base_unit_cost: v.cost })) } });
      toast("Supplier invoice posted"); onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Record supplier invoice (matched to receipts)" size="xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!supplier || !no || !Object.keys(sel).length} onClick={submit}>Post invoice</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Supplier">{(id) => <Select id={id} value={supplier} onChange={(e) => { setSupplier(e.target.value); setSel({}); }}><option value="">Select…</option>{ref.data?.suppliers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          <Field label="Supplier invoice no.">{(id) => <Input id={id} value={no} onChange={(e) => setNo(e.target.value)} />}</Field>
          <Field label="Invoice date">{(id) => <Input id={id} type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} />}</Field>
          <Field label="Due date">{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        </div>
        <p className="text-xs text-slate-500">Select the received lines this invoice covers. Inventory was already recognised at receipt; the invoice clears “Goods received not invoiced”. Price differences post to purchase price variance.</p>
        <DataTable rows={openLines} loading={receipts.isLoading && !!supplier} empty={<p className="p-6 text-center text-sm text-slate-500">{supplier ? "No uninvoiced receipt lines for this supplier." : "Choose a supplier."}</p>} columns={[
          { key: "sel", header: "", render: (l: any) => <input type="checkbox" aria-label={`Include ${l.sku}`} checked={!!sel[l.id]} onChange={(e) => { const n = { ...sel }; if (e.target.checked) n[l.id] = { qty: String(l.uninvoiced_base), cost: String(l.base_unit_cost) }; else delete n[l.id]; setSel(n); }} /> },
          { key: "receipt", header: "Receipt" }, { key: "sku", header: "SKU" },
          { key: "u", header: "Uninvoiced qty", align: "right", render: (l: any) => qty(l.uninvoiced_base) },
          { key: "rc", header: "Receipt cost", align: "right", render: (l: any) => money(l.base_unit_cost) },
          { key: "q", header: "Invoice qty", render: (l: any) => sel[l.id] && <Input aria-label="Invoice quantity" className="h-8 w-24" value={sel[l.id].qty} onChange={(e) => setSel({ ...sel, [l.id]: { ...sel[l.id], qty: e.target.value } })} /> },
          { key: "c", header: "Invoice unit cost", render: (l: any) => sel[l.id] && <Input aria-label="Invoice unit cost" className="h-8 w-28" value={sel[l.id].cost} onChange={(e) => setSel({ ...sel, [l.id]: { ...sel[l.id], cost: e.target.value } })} /> },
        ]} />
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function PayForm({ invoice, onClose, onDone }: { invoice: any; onClose: () => void; onDone: () => void }) {
  const { branchId } = useSession();
  const toast = useToast();
  const accounts = useApi<any[]>("/financial-accounts/options");
  const [amount, setAmount] = useState(String(invoice.outstanding)); const [acc, setAcc] = useState(""); const [ref, setRef] = useState(""); const [d, setD] = useState(today());
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api("/supplier-payments", { idempotent: true, body: { branch_id: branchId, supplier_id: invoice.supplier_id, financial_account_id: acc, amount, payment_date: d, reference: ref || undefined, allocations: [{ supplier_invoice_id: invoice.id, amount: Number(amount) > Number(invoice.outstanding) ? String(invoice.outstanding) : amount }] } }); toast("Payment posted"); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Pay ${invoice.supplier_name} — ${invoice.supplier_invoice_no}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!acc || !amount} onClick={submit}>Post payment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" hint={`Outstanding ${money(invoice.outstanding)}; any excess is recorded as a supplier advance`}>{(id, h) => <Input id={id} aria-describedby={h} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Paid from">{(id) => <Select id={id} value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">Select…</option>{accounts.data?.filter((a) => a.kind !== "TILL").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label="Payment date">{(id) => <Input id={id} type="date" value={d} onChange={(e) => setD(e.target.value)} />}</Field>
        <Field label="Reference (optional)">{(id) => <Input id={id} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
      </div>
      <ErrorText error={err} />
    </Modal>
  );
}

function Suppliers() {
  const { can } = useSession();
  const toast = useToast();
  const list = useList<any>("/suppliers", {}, { sort: "name", order: "asc" });
  const [editing, setEditing] = useState<any>(null);
  return (
    <Card padded={false} title="Suppliers" actions={<div className="flex gap-2">
      {can("data.import") && <Link to="/import?type=suppliers"><Button size="sm" variant="secondary">Import / export</Button></Link>}
      {can("suppliers.manage") && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>New supplier</Button>}
    </div>}>
      <div className="border-b border-slate-200 p-3"><SearchInput value={list.search} onChange={list.setSearch} /></div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} sort={list.sort} onSort={list.onSort} columns={[
        { key: "code", header: "Code", sortable: true }, { key: "name", header: "Name", sortable: true, render: (s) => <span className={s.active === false ? "text-slate-400 line-through" : ""}>{s.name}</span> },
        { key: "contact_name", header: "Contact", render: (s) => s.contact_name ?? "—" }, { key: "phone", header: "Phone", render: (s) => s.phone ?? "—" },
        { key: "payment_terms_days", header: "Terms", render: (s) => (s.payment_terms_days ? `${s.payment_terms_days} days` : "Cash") },
        { key: "e", header: "", align: "right", render: (s) => can("suppliers.manage") && <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      {editing && <SupplierForm supplier={editing} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); list.refetch(); toast(m); }} />}
    </Card>
  );
}

function SupplierForm({ supplier, onClose, onSaved }: { supplier: any; onClose: () => void; onSaved: (msg: string) => void }) {
  const isNew = !supplier.id;
  const [f, setF] = useState({ code: supplier.code ?? "", name: supplier.name ?? "", contact_name: supplier.contact_name ?? "", phone: supplier.phone ?? "", email: supplier.email ?? "", address: supplier.address ?? "", tax_id: supplier.tax_id ?? "", payment_terms_days: String(supplier.payment_terms_days ?? 0), active: supplier.active ?? true });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { name: f.name, contact_name: opt(f.contact_name), phone: opt(f.phone), email: opt(f.email), address: opt(f.address), tax_id: opt(f.tax_id), payment_terms_days: Number(f.payment_terms_days) || 0 };
      if (isNew) await api("/suppliers", { body: { ...body, code: f.code } }); else await api(`/suppliers/${supplier.id}`, { method: "PATCH", body: { ...body, active: f.active } });
      onSaved(isNew ? `${f.name} added` : `${f.name} saved`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${supplier.name}? Only suppliers never ordered from, invoiced or paid can be deleted.`)) return;
    setBusy(true); setErr(null);
    try { await api(`/suppliers/${supplier.id}`, { method: "DELETE" }); onSaved(`${supplier.name} deleted`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const field = (k: keyof typeof f, label: string, extra: { required?: boolean; disabled?: boolean } = {}) => (
    <Field label={label} required={extra.required}>{(id) => <Input id={id} value={String(f[k])} disabled={extra.disabled} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>
  );
  return (
    <Modal open onClose={onClose} title={isNew ? "New supplier" : `Edit ${supplier.name}`} footer={<>
      {!isNew && <Button variant="ghost" className="mr-auto text-red-700" disabled={busy} onClick={remove}>Delete</Button>}
      <Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.name || (isNew && f.code.length < 2)} onClick={save}>Save</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("code", "Code", { required: true, disabled: !isNew })}{field("name", "Name", { required: true })}
        {field("contact_name", "Contact person")}{field("phone", "Phone")}
        {field("email", "Email")}{field("tax_id", "Tax ID (NIU)")}
        <div className="sm:col-span-2">{field("address", "Address")}</div>
        {field("payment_terms_days", "Payment terms (days)")}
        {!isNew && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
        <div className="sm:col-span-2"><ErrorText error={err} /></div>
      </div>
    </Modal>
  );
}

function SupplierPayments() {
  const { can } = useSession();
  const toast = useToast();
  const list = useList<any>("/supplier-payments");
  const [voiding, setVoiding] = useState<any>(null);
  return (
    <Card padded={false} title="Supplier payments">
      <div className="border-b border-slate-100 p-3"><SearchInput value={list.search} onChange={list.setSearch} placeholder="Payment number or reference" className="max-w-sm" /></div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} empty="No supplier payments yet." columns={[
        { key: "number", header: "Number" }, { key: "payment_date", header: "Date", render: (p) => date(p.payment_date) }, { key: "supplier_name", header: "Supplier" },
        { key: "reference", header: "Reference", render: (p) => p.reference ?? "—" },
        { key: "amount", header: "Amount", align: "right", render: (p) => <span className={p.status === "REVERSED" ? "text-slate-400 line-through" : ""}>{money(p.amount)}</span> },
        { key: "unallocated", header: "Advance", align: "right", render: (p) => (Number(p.unallocated) ? money(p.unallocated) : "—") },
        { key: "s", header: "", align: "right", render: (p) => p.status === "REVERSED" ? <span title={p.void_reason ?? undefined}><Badge tone="red">Voided</Badge></span> : can("transactions.void") && <Button size="sm" variant="ghost" onClick={() => setVoiding(p)}>Void</Button> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      <ConfirmDialog open={!!voiding} danger requireReason title={`Void supplier payment ${voiding?.number ?? ""}`} confirmLabel="Void payment"
        message={<>Reverses the <b>{voiding && money(voiding.amount)}</b> paid to {voiding?.supplier_name}: the invoices it paid become outstanding again. The payment stays on record, marked voided.</>}
        onClose={() => setVoiding(null)} onConfirm={async (reason) => { await api(`/supplier-payments/${voiding.id}/void`, { body: { reason } }); list.refetch(); toast("Supplier payment voided"); }} />
    </Card>
  );
}
