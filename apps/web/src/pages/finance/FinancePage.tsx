import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, Select, Status, Tabs, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { date, dateTime, humanize, money, today } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function FinancePage() {
  const { can } = useSession();
  const [tab, setTab] = useState(can("finance.view") ? "accounts" : "sessions");
  return (
    <div>
      <PageHeader title="Finance" subtitle="Tills, safes, bank and mobile-money accounts. Internal transfers are not expenses." />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "accounts", label: "Financial accounts", hidden: !can("finance.view") }, { key: "sessions", label: "Cashier sessions" }, { key: "expenses", label: "Expenses", hidden: !can("finance.view") }]} />
      {tab === "accounts" && <Accounts />}
      {tab === "sessions" && <Sessions />}
      {tab === "expenses" && <Expenses />}
    </div>
  );
}

function Accounts() {
  const { can } = useSession();
  const q = useApi<any[]>("/financial-accounts");
  const [open, setOpen] = useState(false);
  return (
    <Card padded={false} title="Book balances" actions={can("finance.manage") && <Button size="sm" onClick={() => setOpen(true)}>Internal transfer</Button>}>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} columns={[
        { key: "code", header: "Code" }, { key: "name", header: "Account" }, { key: "kind", header: "Type", render: (a) => <Badge>{humanize(a.kind)}</Badge> },
        { key: "balance", header: "Book balance", align: "right", render: (a) => <strong>{money(a.balance)}</strong> },
      ]} />
      {open && <TransferForm accounts={q.data ?? []} onClose={() => setOpen(false)} onDone={() => { setOpen(false); q.refetch(); }} />}
    </Card>
  );
}

function TransferForm({ accounts, onClose, onDone }: { accounts: any[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ from_account_id: "", to_account_id: "", amount: "", fee_amount: "", transfer_date: today(), reference: "" });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const opts = accounts.filter((a) => a.kind !== "TILL");
  const save = async () => { setBusy(true); setErr(null); try { await api("/funds-transfers", { idempotent: true, body: { ...f, fee_amount: f.fee_amount || undefined, reference: f.reference || undefined } }); onDone(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title="Internal transfer (e.g. safe → bank, wallet settlement)" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Post transfer</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From">{(id) => <Select id={id} value={f.from_account_id} onChange={set("from_account_id")}><option value="">Select…</option>{opts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label="To">{(id) => <Select id={id} value={f.to_account_id} onChange={set("to_account_id")}><option value="">Select…</option>{opts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
        <Field label="Amount (gross)">{(id) => <Input id={id} value={f.amount} onChange={set("amount")} />}</Field>
        <Field label="Fee deducted" hint="Expensed to bank/mobile money fees">{(id, d) => <Input id={id} aria-describedby={d} value={f.fee_amount} onChange={set("fee_amount")} />}</Field>
        <Field label="Date">{(id) => <Input id={id} type="date" value={f.transfer_date} onChange={set("transfer_date")} />}</Field>
        <Field label="Reference">{(id) => <Input id={id} value={f.reference} onChange={set("reference")} />}</Field>
      </div>
      <ErrorText error={err} />
    </Modal>
  );
}

function Sessions() {
  const nav = useNavigate();
  const [status, setStatus] = useState("");
  const list = useList<any>("/cashier-sessions", { status });
  return (
    <Card padded={false}>
      <div className="border-b border-slate-200 p-3"><Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option></Select></div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRowClick={(s) => nav(`/finance/sessions/${s.id}`)} columns={[
        { key: "number", header: "Session" }, { key: "cashier_name", header: "Cashier" }, { key: "register_name", header: "Register" },
        { key: "opened_at", header: "Opened", render: (s) => dateTime(s.opened_at) }, { key: "closed_at", header: "Closed", render: (s) => dateTime(s.closed_at) },
        { key: "expected_cash", header: "Expected", align: "right", render: (s) => money(s.expected_cash) }, { key: "counted_cash", header: "Counted", align: "right", render: (s) => money(s.counted_cash) },
        { key: "variance", header: "Variance", align: "right", render: (s) => s.variance == null ? "—" : <span className={Number(s.variance) === 0 ? "text-emerald-700" : "text-amber-700"}>{money(s.variance)}</span> },
        { key: "status", header: "Status", render: (s) => <Status value={s.status} /> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
    </Card>
  );
}

function Expenses() {
  const { can, branchId } = useSession();
  const toast = useToast();
  const list = useList<any>("/expenses");
  const cats = useApi<any[]>(can("expenses.manage") ? "/expense-categories" : null);
  const accounts = useApi<any[]>("/financial-accounts/options");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ payee: "", expense_date: today(), financial_account_id: "", reference: "", category: "", description: "", amount: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try { await api("/expenses", { idempotent: true, body: { branch_id: branchId, payee: f.payee, expense_date: f.expense_date, financial_account_id: f.financial_account_id, reference: f.reference || undefined, lines: [{ expense_category_id: f.category, description: f.description, amount: f.amount }] } }); setOpen(false); list.refetch(); toast("Expense posted"); }
    catch (e) { setErr(e); }
  };
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Card padded={false} title="Expenses" actions={can("expenses.manage") && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Record expense</Button>}>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} columns={[
        { key: "number", header: "Number" }, { key: "expense_date", header: "Date", render: (e) => date(e.expense_date) }, { key: "payee", header: "Payee" },
        { key: "desc", header: "Description", render: (e) => e.lines.map((l: any) => l.description).join("; ") }, { key: "total", header: "Amount", align: "right", render: (e) => money(e.total) },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      <Modal open={open} onClose={() => setOpen(false)} title="Record expense" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={!f.payee || !f.category || !f.amount || !f.financial_account_id}>Post expense</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payee">{(id) => <Input id={id} value={f.payee} onChange={set("payee")} />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={f.expense_date} onChange={set("expense_date")} />}</Field>
          <Field label="Category">{(id) => <Select id={id} value={f.category} onChange={set("category")}><option value="">Select…</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Paid from">{(id) => <Select id={id} value={f.financial_account_id} onChange={set("financial_account_id")}><option value="">Select…</option>{accounts.data?.filter((a) => a.kind !== "TILL").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          <Field label="Description" className="sm:col-span-2">{(id) => <Input id={id} value={f.description} onChange={set("description")} />}</Field>
          <Field label="Amount">{(id) => <Input id={id} value={f.amount} onChange={set("amount")} />}</Field>
          <Field label="Reference">{(id) => <Input id={id} value={f.reference} onChange={set("reference")} />}</Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Till paid-outs are recorded from the POS session so the cash count stays correct.</p>
        <ErrorText error={err} />
      </Modal>
    </Card>
  );
}
