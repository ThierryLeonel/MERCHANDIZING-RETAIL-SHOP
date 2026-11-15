import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorText, Field, Input, Modal, PageHeader, Select, Spinner, Status, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { date, money } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

interface Options {
  today: string;
  financial_accounts: { id: string; code: string; name: string; kind: string; current_balance: string }[];
  customers: { id: string; code: string; name: string }[];
  suppliers: { id: string; code: string; name: string }[];
  accounts: { id: string; code: string; name: string; type: string }[];
  inventory_value: string;
  documents: any[];
}
type CustRow = { customer_id: string; owed: string; store_credit: string; reference: string; due_date: string };
type SupRow = { supplier_id: string; owed: string; reference: string; due_date: string };
type OtherRow = { account_id: string; debit: string; credit: string; memo: string };

const n = (v: string) => { const x = Number(String(v).replace(/[\s,]/g, "")); return Number.isFinite(x) ? x : 0; };
const clean = (v: string) => String(v).replace(/[\s,]/g, "");

/**
 * Opening balances: what the business had and owed on the day it starts using
 * the system. Everything is posted as one journal; the difference goes to
 * Opening balance equity.
 */
export default function OpeningBalancesPage() {
  const { can } = useSession();
  const toast = useToast();
  const opts = useApi<Options>("/opening-balances/options");
  const [asOf, setAsOf] = useState("");
  const [notes, setNotes] = useState("");
  const [cash, setCash] = useState<Record<string, string>>({});
  const [customers, setCustomers] = useState<CustRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupRow[]>([]);
  const [other, setOther] = useState<OtherRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<any>(null);

  const totals = useMemo(() => {
    let dr = 0, cr = 0;
    for (const v of Object.values(cash)) { const x = n(v); if (x > 0) dr += x; else cr -= x; }
    for (const c of customers) { dr += n(c.owed); cr += n(c.store_credit); }
    for (const s of suppliers) cr += n(s.owed);
    for (const o of other) { dr += n(o.debit); cr += n(o.credit); }
    return { dr, cr, equity: dr - cr };
  }, [cash, customers, suppliers, other]);

  if (opts.isLoading) return <Spinner />;
  if (!opts.data) return <ErrorText error={opts.error} />;
  const o = opts.data;
  const date0 = asOf || o.today;
  const posted = o.documents.filter((d) => d.status === "POSTED");

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = {
        as_of_date: date0, notes: notes || undefined,
        accounts: Object.entries(cash).filter(([, v]) => n(v) !== 0).map(([financial_account_id, v]) => ({ financial_account_id, amount: clean(v) })),
        customers: customers.filter((c) => c.customer_id && (n(c.owed) || n(c.store_credit))).map((c) => ({ customer_id: c.customer_id, ...(n(c.owed) ? { owed: clean(c.owed) } : {}), ...(n(c.store_credit) ? { store_credit: clean(c.store_credit) } : {}), reference: c.reference || undefined, due_date: c.due_date || undefined })),
        suppliers: suppliers.filter((s) => s.supplier_id && n(s.owed)).map((s) => ({ supplier_id: s.supplier_id, owed: clean(s.owed), reference: s.reference || undefined, due_date: s.due_date || undefined })),
        other: other.filter((x) => x.account_id && (n(x.debit) || n(x.credit))).map((x) => ({ account_id: x.account_id, ...(n(x.debit) ? { debit: clean(x.debit) } : {}), ...(n(x.credit) ? { credit: clean(x.credit) } : {}), memo: x.memo || undefined })),
      };
      const r = await api<any>("/opening-balances", { body });
      toast(`Opening balances ${r.number} posted`);
      setCash({}); setCustomers([]); setSuppliers([]); setOther([]); setNotes(""); setConfirm(false);
      opts.refetch();
    } catch (e) { setErr(e); setConfirm(false); } finally { setBusy(false); }
  };
  const del = <T,>(set: (f: (r: T[]) => T[]) => void, i: number) => set((r) => r.filter((_, k) => k !== i));
  const upd = <T,>(set: (f: (r: T[]) => T[]) => void, i: number, patch: Partial<T>) => set((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-4">
      <PageHeader title="Opening balances" subtitle="Start the system with what the business already has and owes: cash, bank and mobile-money balances, customer debts, supplier debts, loans, equipment and capital." />

      {posted.length > 0 && <p role="status" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Opening balances have already been posted ({posted.map((d) => d.number).join(", ")}). Anything you enter now is added to them — use it only for balances that were left out.</p>}

      <Card title="1. Date">
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Balances as of" hint="Usually the day before you start selling with the system">{(id, d) => <Input id={id} aria-describedby={d} type="date" max={o.today} value={date0} onChange={(e) => setAsOf(e.target.value)} />}</Field>
          <Field label="Notes" className="min-w-[280px] flex-1">{(id) => <Input id={id} value={notes} placeholder="e.g. Figures from the 31 October stock count and bank statement" onChange={(e) => setNotes(e.target.value)} />}</Field>
        </div>
      </Card>

      <Card title="2. Cash, bank and mobile money" padded={false}>
        <p className="px-4 pt-3 text-sm text-slate-600">Money counted in each safe and shown on each bank or wallet statement. Enter a negative amount for a bank overdraft. Tills start empty — floats are issued from the safe.</p>
        <DataTable rows={o.financial_accounts} columns={[
          { key: "name", header: "Account", render: (a) => <span><span className="font-medium">{a.name}</span> <span className="text-xs text-slate-500">{a.code}</span></span> },
          { key: "kind", header: "Type", render: (a) => <Badge>{a.kind.replace(/_/g, " ").toLowerCase()}</Badge> },
          { key: "current", header: "Current book balance", align: "right", render: (a) => money(a.current_balance) },
          { key: "amount", header: "Opening balance", align: "right", render: (a) => <Input aria-label={`Opening balance for ${a.name}`} inputMode="decimal" className="ml-auto h-9 w-40 text-right" value={cash[a.id] ?? ""} onChange={(e) => setCash({ ...cash, [a.id]: e.target.value })} /> },
        ]} />
        <p className="px-4 pb-3 text-xs text-slate-500">Missing an account? <Link className="text-brand-700 hover:underline" to="/finance">Add it in Finance → Financial accounts</Link>.</p>
      </Card>

      <Card title="3. Customers who owe you (or hold store credit)" actions={<Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setCustomers((r) => [...r, { customer_id: "", owed: "", store_credit: "", reference: "", due_date: "" }])}>Add customer</Button>}>
        {!customers.length && <p className="text-sm text-slate-500">None. Amounts customers owe become open items they pay off like credit sales.</p>}
        {customers.map((c, i) => (
          <div key={i} className="mb-2 grid items-end gap-2 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
            <Field label={i === 0 ? "Customer" : ""}>{(id) => <Select id={id} aria-label="Customer" value={c.customer_id} onChange={(e) => upd(setCustomers, i, { customer_id: e.target.value })}><option value="">Choose…</option>{o.customers.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</Select>}</Field>
            <Field label={i === 0 ? "Owes you" : ""}>{(id) => <Input id={id} aria-label="Owes you" inputMode="decimal" value={c.owed} onChange={(e) => upd(setCustomers, i, { owed: e.target.value })} />}</Field>
            <Field label={i === 0 ? "Store credit" : ""}>{(id) => <Input id={id} aria-label="Store credit" inputMode="decimal" value={c.store_credit} onChange={(e) => upd(setCustomers, i, { store_credit: e.target.value })} />}</Field>
            <Field label={i === 0 ? "Reference" : ""}>{(id) => <Input id={id} aria-label="Customer reference" value={c.reference} placeholder="e.g. credit book p.4" onChange={(e) => upd(setCustomers, i, { reference: e.target.value })} />}</Field>
            <Field label={i === 0 ? "Due date" : ""}>{(id) => <Input id={id} aria-label="Due date" type="date" value={c.due_date} onChange={(e) => upd(setCustomers, i, { due_date: e.target.value })} />}</Field>
            <Button variant="ghost" aria-label="Remove customer line" onClick={() => del(setCustomers, i)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <p className="mt-1 text-xs text-slate-500">Customer not listed? <Link className="text-brand-700 hover:underline" to="/customers">Add customers</Link> or <Link className="text-brand-700 hover:underline" to="/import?type=customers">import them</Link> first.</p>
      </Card>

      <Card title="4. Suppliers you owe" actions={<Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setSuppliers((r) => [...r, { supplier_id: "", owed: "", reference: "", due_date: "" }])}>Add supplier</Button>}>
        {!suppliers.length && <p className="text-sm text-slate-500">None. Each amount becomes an open supplier invoice you pay from Purchasing.</p>}
        {suppliers.map((s, i) => (
          <div key={i} className="mb-2 grid items-end gap-2 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <Field label={i === 0 ? "Supplier" : ""}>{(id) => <Select id={id} aria-label="Supplier" value={s.supplier_id} onChange={(e) => upd(setSuppliers, i, { supplier_id: e.target.value })}><option value="">Choose…</option>{o.suppliers.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</Select>}</Field>
            <Field label={i === 0 ? "You owe" : ""}>{(id) => <Input id={id} aria-label="You owe" inputMode="decimal" value={s.owed} onChange={(e) => upd(setSuppliers, i, { owed: e.target.value })} />}</Field>
            <Field label={i === 0 ? "Their invoice no." : ""}>{(id) => <Input id={id} aria-label="Supplier invoice number" value={s.reference} onChange={(e) => upd(setSuppliers, i, { reference: e.target.value })} />}</Field>
            <Field label={i === 0 ? "Due date" : ""}>{(id) => <Input id={id} aria-label="Supplier due date" type="date" value={s.due_date} onChange={(e) => upd(setSuppliers, i, { due_date: e.target.value })} />}</Field>
            <Button variant="ghost" aria-label="Remove supplier line" onClick={() => del(setSuppliers, i)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
      </Card>

      <Card title="5. Other balances (loans, equipment, capital…)" actions={<Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setOther((r) => [...r, { account_id: "", debit: "", credit: "", memo: "" }])}>Add line</Button>}>
        {!other.length && <p className="text-sm text-slate-500">Optional. Debit what the business owns (equipment, other receivables), credit what it owes (loans) or the owner's capital.</p>}
        {other.map((x, i) => (
          <div key={i} className="mb-2 grid items-end gap-2 md:grid-cols-[2fr_1fr_1fr_1.5fr_auto]">
            <Field label={i === 0 ? "Account" : ""}>{(id) => <Select id={id} aria-label="Account" value={x.account_id} onChange={(e) => upd(setOther, i, { account_id: e.target.value })}><option value="">Choose…</option>{o.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</Select>}</Field>
            <Field label={i === 0 ? "Debit" : ""}>{(id) => <Input id={id} aria-label="Debit" inputMode="decimal" value={x.debit} onChange={(e) => upd(setOther, i, { debit: e.target.value, credit: e.target.value ? "" : x.credit })} />}</Field>
            <Field label={i === 0 ? "Credit" : ""}>{(id) => <Input id={id} aria-label="Credit" inputMode="decimal" value={x.credit} onChange={(e) => upd(setOther, i, { credit: e.target.value, debit: e.target.value ? "" : x.debit })} />}</Field>
            <Field label={i === 0 ? "Description" : ""}>{(id) => <Input id={id} aria-label="Description" value={x.memo} onChange={(e) => upd(setOther, i, { memo: e.target.value })} />}</Field>
            <Button variant="ghost" aria-label="Remove line" onClick={() => del(setOther, i)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        <p className="mt-1 text-xs text-slate-500">Need an account that is not listed (e.g. "Bank loan")? <Link className="text-brand-700 hover:underline" to="/accounting">Add it in Accounting → Chart of accounts</Link>.</p>
      </Card>

      <Card title="6. Stock on the shelves">
        <p className="text-sm text-slate-600">Stock is entered per product with its quantity and cost, so it is loaded separately: <Link className="text-brand-700 hover:underline" to="/import?type=stock">Import → Opening stock</Link> (or with the products import). It also posts against Opening balance equity. Stock value already in the system: <b>{money(o.inventory_value)}</b>.</p>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <div>Total debits <div className="num text-lg font-semibold">{money(totals.dr)}</div></div>
          <div>Total credits <div className="num text-lg font-semibold">{money(totals.cr)}</div></div>
          <div>To Opening balance equity <div className="num text-lg font-semibold">{totals.equity >= 0 ? `${money(totals.equity)} credit` : `${money(-totals.equity)} debit`}</div></div>
          <div className="ml-auto"><Button disabled={(!totals.dr && !totals.cr) || busy} onClick={() => setConfirm(true)}>Post opening balances</Button></div>
        </div>
        <p className="mt-2 text-xs text-slate-500">The difference between what the business owns and owes is its opening equity (the owner's net investment). Review the figures with your accountant.</p>
        <ErrorText error={err} />
      </Card>

      <Card padded={false} title="Posted opening balances">
        <DataTable rows={o.documents} empty="None yet." columns={[
          { key: "number", header: "Number", render: (d) => <button className="text-brand-700 hover:underline" onClick={() => setViewing(d.id)}>{d.number}</button> },
          { key: "as_of_date", header: "As of", render: (d) => date(d.as_of_date) },
          { key: "equity", header: "Opening equity", align: "right", render: (d) => money(-Number(d.equity_amount)) },
          { key: "notes", header: "Notes", render: (d) => d.notes ?? "" },
          { key: "status", header: "Status", render: (d) => <Status value={d.status} /> },
          { key: "a", header: "", align: "right", render: (d) => d.status === "POSTED" && can("accounting.opening_balances") && <Button size="sm" variant="ghost" onClick={() => setVoiding(d)}>Reverse</Button> },
        ]} />
      </Card>

      <ConfirmDialog open={confirm} title="Post opening balances?" confirmLabel="Post" onClose={() => setConfirm(false)} onConfirm={submit}
        message={<>This posts one journal dated <b>{date(date0)}</b>: debits {money(totals.dr)}, credits {money(totals.cr)}, and {money(Math.abs(totals.equity))} to Opening balance equity. It can be reversed later only while none of its customer or supplier amounts has been paid.</>} />
      <ConfirmDialog open={!!voiding} danger requireReason title={`Reverse ${voiding?.number ?? ""}`} confirmLabel="Reverse"
        message="Posts a mirror-image journal and removes its customer open items and opening supplier invoices. Refused if any of them has been paid."
        onClose={() => setVoiding(null)} onConfirm={async (reason) => { await api(`/opening-balances/${voiding.id}/void`, { body: { reason } }); toast(`${voiding.number} reversed`); opts.refetch(); }} />
      {viewing && <OpeningBalanceDetail id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function OpeningBalanceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useApi<any>(`/opening-balances/${id}`);
  return (
    <Modal open onClose={onClose} title={q.data ? `${q.data.number} — as of ${date(q.data.as_of_date)}` : "Opening balances"} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      {q.isLoading ? <Spinner /> : q.data && (
        <>
          {q.data.notes && <p className="mb-2 text-sm text-slate-600">{q.data.notes}</p>}
          <DataTable rows={q.data.lines} columns={[
            { key: "account", header: "Account", render: (l: any) => <span className="font-mono text-xs">{l.account?.code}</span> },
            { key: "name", header: "", render: (l: any) => <span>{l.account?.name}{l.customer_name && ` — ${l.customer_name}`}{l.supplier_name && ` — ${l.supplier_name}`}</span> },
            { key: "memo", header: "Description", render: (l: any) => <span className="text-xs text-slate-500">{l.memo}</span> },
            { key: "debit", header: "Debit", align: "right", render: (l: any) => (Number(l.debit) ? money(l.debit) : "") },
            { key: "credit", header: "Credit", align: "right", render: (l: any) => (Number(l.credit) ? money(l.credit) : "") },
          ]} />
        </>
      )}
    </Modal>
  );
}
