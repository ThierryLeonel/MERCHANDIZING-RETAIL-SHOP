import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, Select, Status, Tabs, useToast } from "../../components/ui";
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
  const toast = useToast();
  const q = useApi<any[]>("/financial-accounts");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const manage = can("finance.manage");
  return (
    <Card padded={false} title="Book balances" actions={manage && <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Internal transfer</Button><Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>Add account</Button></div>}>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} columns={[
        { key: "code", header: "Code" }, { key: "name", header: "Account", render: (a) => <span className={a.active ? "" : "text-slate-400 line-through"}>{a.name}</span> },
        { key: "kind", header: "Type", render: (a) => <div className="flex gap-1"><Badge>{humanize(a.kind)}</Badge>{!a.active && <Badge tone="red">Inactive</Badge>}</div> },
        { key: "balance", header: "Book balance", align: "right", render: (a) => <strong>{money(a.balance)}</strong> },
        { key: "e", header: "", align: "right", render: (a) => manage && <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button> },
      ]} />
      {open && <TransferForm accounts={(q.data ?? []).filter((a) => a.active)} onClose={() => setOpen(false)} onDone={() => { setOpen(false); q.refetch(); }} />}
      {editing && <FinancialAccountForm account={editing} onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); q.refetch(); toast(msg); }} />}
    </Card>
  );
}

const FA_KINDS: [string, string][] = [["SAFE", "Safe (cash)"], ["PETTY_CASH", "Petty cash"], ["BANK", "Bank account"], ["MOBILE_MONEY", "Mobile money wallet"], ["CLEARING", "Clearing account (card / provider)"]];

function FinancialAccountForm({ account, onClose, onSaved }: { account: any; onClose: () => void; onSaved: (msg: string) => void }) {
  const { me } = useSession();
  const isNew = !account.id;
  const [f, setF] = useState({ name: account.name ?? "", kind: account.kind ?? "BANK", code: account.code ?? "", branch_id: account.branch_id ?? "", provider: account.provider ?? "", active: account.active ?? true });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (isNew) await api("/financial-accounts", { body: { name: f.name, kind: f.kind, code: f.code || undefined, branch_id: f.branch_id || null, provider: f.provider || null } });
      else await api(`/financial-accounts/${account.id}`, { method: "PATCH", body: { name: f.name, ...(account.kind !== "TILL" ? { branch_id: f.branch_id || null } : {}), provider: f.provider || null, active: f.active } });
      onSaved(isNew ? `${f.name} added` : `${f.name} saved`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${account.name}? Only accounts that were never used can be deleted.`)) return;
    setBusy(true); setErr(null);
    try { await api(`/financial-accounts/${account.id}`, { method: "DELETE" }); onSaved(`${account.name} deleted`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={isNew ? "Add financial account" : `Edit ${account.name}`} footer={<>
      {!isNew && <Button variant="ghost" className="mr-auto text-red-700" disabled={busy} onClick={remove}>Delete</Button>}
      <Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={f.name.trim().length < 2} onClick={save}>{isNew ? "Add account" : "Save"}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">{(id) => <Input id={id} value={f.name} placeholder="e.g. Afriland First Bank — current account" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Type">{(id) => <Select id={id} value={f.kind} disabled={!isNew} onChange={(e) => setF({ ...f, kind: e.target.value })}>{(isNew ? FA_KINDS : [...FA_KINDS, ["TILL", "Till"] as [string, string]]).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Code" hint={isNew ? "Optional — generated from the name" : undefined}>{(id, d) => <Input id={id} aria-describedby={d} value={f.code} disabled={!isNew} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        <Field label="Branch" hint="Leave empty for business-wide accounts (bank, wallet)">{(id, d) => <Select id={id} aria-describedby={d} value={f.branch_id} disabled={account.kind === "TILL"} onChange={(e) => setF({ ...f, branch_id: e.target.value })}><option value="">— All branches —</option>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}</Select>}</Field>
        {(f.kind === "MOBILE_MONEY" || f.kind === "CLEARING" || f.kind === "BANK") && <Field label="Provider" hint="e.g. MTN MoMo, Orange Money, bank name">{(id, d) => <Input id={id} aria-describedby={d} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} />}</Field>}
        {!isNew && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (an account must be empty before it can be deactivated)</label>}
        {isNew && <p className="text-xs text-slate-500 sm:col-span-2">A ledger account is created for it automatically in the chart of accounts (under Banks, Mobile money wallets, Cash or Clearing). Tills are added with their cash register in Administration.</p>}
        <div className="sm:col-span-2"><ErrorText error={err} /></div>
      </div>
    </Modal>
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
        <Field label="Reference (optional)">{(id) => <Input id={id} value={f.reference} onChange={set("reference")} />}</Field>
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
  const [voiding, setVoiding] = useState<any>(null);
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
        { key: "desc", header: "Description", render: (e) => e.lines.map((l: any) => l.description).join("; ") }, { key: "total", header: "Amount", align: "right", render: (e) => <span className={e.status === "REVERSED" ? "text-slate-400 line-through" : ""}>{money(e.total)}</span> },
        { key: "status", header: "", render: (e) => e.status === "REVERSED" ? <span title={e.void_reason ?? undefined}><Badge tone="red">Voided</Badge></span> : can("transactions.void") && <Button size="sm" variant="ghost" onClick={() => setVoiding(e)}>Void</Button> },
      ]} />
      <ConfirmDialog open={!!voiding} danger requireReason title={`Void expense ${voiding?.number ?? ""}`} confirmLabel="Void expense"
        message={<>This posts a reversing entry for <b>{voiding && money(voiding.total)}</b> to {voiding?.payee}; the expense stays on record, marked voided. To correct it, void it and record it again.</>}
        onClose={() => setVoiding(null)} onConfirm={async (reason) => { await api(`/expenses/${voiding.id}/void`, { body: { reason } }); list.refetch(); toast("Expense voided"); }} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      <Modal open={open} onClose={() => setOpen(false)} title="Record expense" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={!f.payee || !f.category || !f.amount || !f.financial_account_id}>Post expense</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payee">{(id) => <Input id={id} value={f.payee} onChange={set("payee")} />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={f.expense_date} onChange={set("expense_date")} />}</Field>
          <Field label="Category">{(id) => <Select id={id} value={f.category} onChange={set("category")}><option value="">Select…</option>{cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="Paid from">{(id) => <Select id={id} value={f.financial_account_id} onChange={set("financial_account_id")}><option value="">Select…</option>{accounts.data?.filter((a) => a.kind !== "TILL").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          <Field label="Description" className="sm:col-span-2">{(id) => <Input id={id} value={f.description} onChange={set("description")} />}</Field>
          <Field label="Amount">{(id) => <Input id={id} value={f.amount} onChange={set("amount")} />}</Field>
          <Field label="Reference (optional)">{(id) => <Input id={id} value={f.reference} onChange={set("reference")} />}</Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">Till paid-outs are recorded from the POS session so the cash count stays correct.</p>
        <ErrorText error={err} />
      </Modal>
    </Card>
  );
}
