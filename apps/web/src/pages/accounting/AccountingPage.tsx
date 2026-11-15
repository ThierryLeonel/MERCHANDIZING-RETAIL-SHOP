import { CheckCircle2, Plus, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, ConfirmDialog, cx, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, SearchInput, Select, Status, Tabs, useToast } from "../../components/ui";
import { api, qs } from "../../lib/api";
import { PrintButton, PrintSheet } from "../../components/print";
import { date, dateTime, humanize, money, sumStrings, today } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function AccountingPage() {
  const { can } = useSession();
  const fin = can("reports.financial");
  const [tab, setTab] = useState(fin ? "pl" : "journals");
  return (
    <div>
      <PageHeader title="Accounting" subtitle="Double-entry ledger fed automatically by every transaction. Posted entries are corrected by reversal, never edited." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: "pl", label: "Profit & loss", hidden: !fin }, { key: "bs", label: "Balance sheet", hidden: !fin }, { key: "tb", label: "Trial balance", hidden: !fin },
        { key: "recon", label: "Reconciliation", hidden: !fin }, { key: "journals", label: "Journals", hidden: !can("accounting.view") }, { key: "chart", label: "Chart of accounts", hidden: !can("accounting.view") },
        { key: "periods", label: "Fiscal periods", hidden: !can("accounting.view") },
      ]} />
      {tab === "pl" && <ProfitLoss />}
      {tab === "bs" && <BalanceSheet />}
      {tab === "tb" && <TrialBalance />}
      {tab === "recon" && <Reconciliation />}
      {tab === "journals" && <Journals />}
      {tab === "chart" && <Chart />}
      {tab === "periods" && <Periods />}
    </div>
  );
}

function Section({ title, rows, total, label }: { title: string; rows: any[]; total?: string; label?: string }) {
  return (
    <div className="mb-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {rows.map((r) => <div key={r.id} className="flex justify-between py-0.5 text-sm"><span>{r.code} {r.name}</span><span className="num">{money(r.amount)}</span></div>)}
      {total !== undefined && <div className="flex justify-between border-t border-slate-200 pt-1 text-sm font-semibold"><span>{label ?? `Total ${title.toLowerCase()}`}</span><span className="num">{money(total)}</span></div>}
    </div>
  );
}

function ProfitLoss() {
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`); const [to, setTo] = useState(today());
  const q = useApi<any>(`/accounting/profit-and-loss${qs({ from, to })}`, [from, to]);
  const d = q.data;
  return (
    <PrintSheet id="pl-sheet" title={"Profit and loss"} subtitle={`${date(from)} – ${date(to)}`}>
    <Card title="Profit and loss" actions={<div className="flex gap-2"><PrintButton target="pl-sheet" size="sm" /><Input aria-label="From" type="date" className="h-8" value={from} onChange={(e) => setFrom(e.target.value)} /><Input aria-label="To" type="date" className="h-8" value={to} onChange={(e) => setTo(e.target.value)} /></div>}>
      {!d ? <ErrorText error={q.error} /> : (
        <div className="max-w-2xl">
          <Section title="Revenue (tax-exclusive, net of returns)" rows={d.revenue} total={d.net_revenue} label="Net revenue" />
          <Section title="Cost of sales" rows={d.cost_of_sales} total={d.total_cost_of_sales} />
          <div className="mb-3 flex justify-between rounded bg-slate-50 px-2 py-1.5 font-semibold"><span>Gross profit {d.gross_margin_percent && <span className="font-normal text-slate-500">({d.gross_margin_percent}% margin)</span>}</span><span className="num">{money(d.gross_profit)}</span></div>
          {d.other_income.length > 0 && <Section title="Other income" rows={d.other_income} />}
          <Section title="Operating expenses" rows={d.operating_expenses} total={d.total_operating_expenses} />
          <div className="flex justify-between rounded bg-brand-50 px-2 py-1.5 font-semibold text-brand-800"><span>Operating profit</span><span className="num">{money(d.operating_profit)}</span></div>
          <p className="mt-3 text-xs text-slate-500">By journal entry date in the business timezone. Gross profit = net revenue − cost of sales (weighted-average cost at time of sale, shrinkage and write-offs). Operating profit is not available cash.</p>
        </div>
      )}
    </Card>
    </PrintSheet>
  );
}

function BalanceSheet() {
  const [asOf, setAsOf] = useState(today());
  const q = useApi<any>(`/accounting/balance-sheet?as_of=${asOf}`, [asOf]);
  const d = q.data;
  return (
    <PrintSheet id="bs-sheet" title={"Balance sheet"} subtitle={`As of ${date(asOf)}`}>
    <Card title="Balance sheet" actions={<div className="flex gap-2"><PrintButton target="bs-sheet" size="sm" /><Input aria-label="As of" type="date" className="h-8" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>}>
      {!d ? <ErrorText error={q.error} /> : (
        <div className="grid max-w-4xl gap-8 md:grid-cols-2">
          <div><Section title="Assets" rows={d.assets} total={d.total_assets} /></div>
          <div>
            <Section title="Liabilities" rows={d.liabilities} total={d.total_liabilities} />
            <Section title="Equity" rows={[...d.equity, { id: "ce", code: "", name: "Current earnings (unclosed)", amount: d.current_earnings }]} total={d.total_equity} />
            <div className="mt-2 flex items-center gap-2 text-sm">{d.balanced ? <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Assets = Liabilities + Equity</> : <><XCircle className="h-4 w-4 text-red-600" /> Out of balance</>}</div>
          </div>
        </div>
      )}
    </Card>
    </PrintSheet>
  );
}

function TrialBalance() {
  const [asOf, setAsOf] = useState(today());
  const q = useApi<any>(`/accounting/trial-balance?as_of=${asOf}`, [asOf]);
  return (
    <PrintSheet id="tb-sheet" title={"Trial balance"} subtitle={`As of ${date(asOf)}`}>
    <Card padded={false} title={<>Trial balance {q.data && (q.data.balanced ? <Badge tone="green">Balanced</Badge> : <Badge tone="red">Unbalanced</Badge>)}</>} actions={<div className="flex gap-2"><PrintButton target="tb-sheet" size="sm" /><Input aria-label="As of" type="date" className="h-8" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>}>
      <DataTable rowKey="account_id" rows={q.data?.lines} loading={q.isLoading} error={q.error} columns={[
        { key: "code", header: "Code" }, { key: "name", header: "Account" }, { key: "type", header: "Type", render: (r) => humanize(r.type) },
        { key: "debit", header: "Debit", align: "right", render: (r) => (Number(r.debit) ? money(r.debit) : "") }, { key: "credit", header: "Credit", align: "right", render: (r) => (Number(r.credit) ? money(r.credit) : "") },
      ]} footer={q.data && <tfoot className="border-t-2 border-slate-300 font-semibold"><tr><td className="px-4 py-2" colSpan={3}>Totals</td><td className="num px-4 py-2 text-right">{money(q.data.total_debit)}</td><td className="num px-4 py-2 text-right">{money(q.data.total_credit)}</td></tr></tfoot>} />
    </Card>
    </PrintSheet>
  );
}

function Reconciliation() {
  const q = useApi<any>("/accounting/reconciliation");
  return (
    <PrintSheet id="recon-sheet" title={"Sub-ledger to control-account reconciliation"} subtitle={`As of ${date(new Date().toISOString())}`}>
    <Card padded={false} title="Sub-ledger to control-account reconciliation" actions={<div className="flex gap-2"><PrintButton target="recon-sheet" size="sm" /><Button size="sm" variant="secondary" onClick={() => q.refetch()}>Re-run</Button></div>}>
      <DataTable rowKey="name" rows={q.data?.checks} loading={q.isLoading} error={q.error} columns={[
        { key: "ok", header: "", render: (c) => (c.ok ? <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-label="Reconciled" /> : <XCircle className="h-5 w-5 text-red-600" aria-label="Difference" />) },
        { key: "name", header: "Check", render: (c) => <div><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.note}</div></div> },
        { key: "subledger", header: "Sub-ledger", align: "right", render: (c) => money(c.subledger) }, { key: "ledger", header: "General ledger", align: "right", render: (c) => money(c.ledger) },
        { key: "difference", header: "Difference", align: "right", render: (c) => <span className={c.ok ? "" : "font-semibold text-red-600"}>{money(c.difference)}</span> },
      ]} />
      {q.data && <p className="p-3 text-xs text-slate-500">Tills: {q.data.tills.open_sessions} open session(s); till GL balance {money(q.data.tills.till_gl_balance)}. {q.data.tills.note}.</p>}
    </Card>
    </PrintSheet>
  );
}

function Journals() {
  const nav = useNavigate();
  const { can } = useSession();
  const [source, setSource] = useState("");
  const list = useList<any>("/accounting/journals", { source_type: source }, { pageSize: 50 });
  const [open, setOpen] = useState(false);
  return (
    <Card padded={false} title="Journal entries" actions={can("accounting.journal") && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Manual journal</Button>}>
      <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
        <SearchInput value={list.search} onChange={list.setSearch} placeholder="Number, document or description" />
        <Select aria-label="Source" className="w-56" value={source} onChange={(e) => setSource(e.target.value)}><option value="">All sources</option>{["sale", "sales_return", "goods_receipt", "supplier_invoice", "supplier_payment", "customer_payment", "expense", "stock_adjustment", "stock_count", "stock_transfer_dispatch", "stock_transfer_receipt", "cashier_session", "cashier_session_close", "cash_movement", "funds_transfer", "opening_balance", "manual_journal", "REVERSAL"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
      </div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRowClick={(j) => nav(`/accounting/journals/${j.id}`)} columns={[
        { key: "number", header: "Entry" }, { key: "entry_date", header: "Date", render: (j) => date(j.entry_date) }, { key: "source", header: "Source", render: (j) => <div><Badge>{humanize(j.source_type)}</Badge> <span className="text-xs text-slate-500">{j.source_number}</span></div> },
        { key: "description", header: "Description" }, { key: "total_debit", header: "Amount", align: "right", render: (j) => money(j.total_debit) }, { key: "status", header: "Status", render: (j) => <Status value={j.status} /> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      {open && <ManualJournal onClose={() => setOpen(false)} />}
    </Card>
  );
}

function ManualJournal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const accounts = useApi<any[]>("/accounting/accounts");
  const [d, setD] = useState(today()); const [desc, setDesc] = useState("");
  const [lines, setLines] = useState([{ account_id: "", debit: "", credit: "" }, { account_id: "", debit: "", credit: "" }]);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const dr = sumStrings(lines.map((l) => l.debit)), cr = sumStrings(lines.map((l) => l.credit));
  const submit = async () => {
    setBusy(true); setErr(null);
    try { const r = await api("/accounting/journals/manual", { body: { entry_date: d, description: desc, lines: lines.filter((l) => l.account_id).map((l) => ({ account_id: l.account_id, debit: l.debit || undefined, credit: l.credit || undefined })) } }); toast(`Submitted for approval as ${r.number}`); onClose(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const manualAccounts = accounts.data?.filter((a) => a.allow_manual && a.is_postable) ?? [];
  return (
    <Modal open onClose={onClose} title="Manual journal (requires approval)" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={dr !== cr || dr === "0" || desc.length < 5} onClick={submit}>Submit for approval</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Date">{(id) => <Input id={id} type="date" value={d} onChange={(e) => setD(e.target.value)} />}</Field><Field label="Description" className="sm:col-span-2">{(id) => <Input id={id} value={desc} onChange={(e) => setDesc(e.target.value)} />}</Field></div>
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_140px_140px]">
            <Select aria-label="Account" value={l.account_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, account_id: e.target.value } : x)))}><option value="">Account…</option>{manualAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select>
            <Input aria-label="Debit" placeholder="Debit" value={l.debit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? "" : x.credit } : x)))} />
            <Input aria-label="Credit" placeholder="Credit" value={l.credit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? "" : x.debit } : x)))} />
          </div>
        ))}
        <div className="flex items-center justify-between text-sm"><Button size="sm" variant="ghost" onClick={() => setLines([...lines, { account_id: "", debit: "", credit: "" }])}>Add line</Button><span className={dr === cr ? "text-emerald-700" : "text-red-600"}>Debits {money(dr)} · Credits {money(cr)}</span></div>
        <p className="text-xs text-slate-500">Control accounts (inventory, receivables, payables, GRNI, tax, tills) are posted only by their source documents and are excluded here. The journal posts when another authorised user approves it.</p>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function Chart() {
  const { can } = useSession();
  const toast = useToast();
  const q = useApi<any[]>("/accounting/accounts");
  const [editing, setEditing] = useState<any>(null);
  const canEdit = can("accounting.periods");
  return (
    <Card padded={false} title="Chart of accounts" actions={<div className="flex items-center gap-3"><span className="hidden text-xs text-slate-500 lg:inline">SYSCOHADA-inspired numbering; review with your accountant. Not a certified chart.</span>{canEdit && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>Add account</Button>}</div>}>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} columns={[
        { key: "code", header: "Code", render: (a) => <span className="font-mono">{a.code}</span> },
        { key: "name", header: "Name", render: (a) => <span className={cx(a.is_postable ? "" : "font-semibold", !a.active && "text-slate-400 line-through")} style={{ paddingLeft: a.parent_id ? 16 : 0 }}>{a.name}</span> },
        { key: "type", header: "Type", render: (a) => humanize(a.type) },
        { key: "flags", header: "", render: (a) => <div className="flex gap-1">{!a.allow_manual && a.is_postable && <Badge tone="violet">System</Badge>}{!a.is_postable && <Badge>Header</Badge>}{!a.active && <Badge tone="red">Inactive</Badge>}</div> },
        { key: "balance", header: "Balance", align: "right", render: (a) => (Number(a.balance) ? money(a.balance) : "") },
        { key: "e", header: "", align: "right", render: (a) => canEdit && <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>Edit</Button> },
      ]} />
      {editing && <AccountForm account={editing} accounts={q.data ?? []} onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); q.refetch(); toast(msg); }} />}
    </Card>
  );
}

function AccountForm({ account, accounts, onClose, onSaved }: { account: any; accounts: any[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const isNew = !account.id;
  const used = Number(account.debit ?? 0) !== 0 || Number(account.credit ?? 0) !== 0;
  const [f, setF] = useState({ code: account.code ?? "", name: account.name ?? "", type: account.type ?? "EXPENSE", parent_id: account.parent_id ?? "", allow_manual: account.allow_manual ?? true, is_postable: account.is_postable ?? true, active: account.active ?? true });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const parents = accounts.filter((a) => a.id !== account.id && a.type === f.type && a.active);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { code: f.code, name: f.name, type: f.type, parent_id: f.parent_id || (isNew ? undefined : null), allow_manual: f.allow_manual, is_postable: f.is_postable, ...(isNew ? {} : { active: f.active }) };
      if (isNew) await api("/accounting/accounts", { body }); else await api(`/accounting/accounts/${account.id}`, { method: "PATCH", body });
      onSaved(isNew ? `Account ${f.code} added` : `Account ${f.code} saved`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete account ${account.code} ${account.name}?`)) return;
    setBusy(true); setErr(null);
    try { await api(`/accounting/accounts/${account.id}`, { method: "DELETE" }); onSaved(`Account ${account.code} deleted`); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={isNew ? "Add account" : `Edit account ${account.code}`} footer={<>
      {!isNew && <Button variant="ghost" className="mr-auto text-red-700" disabled={busy} onClick={remove}>Delete</Button>}
      <Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.code || f.name.trim().length < 2} onClick={save}>{isNew ? "Add account" : "Save"}</Button>
    </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" required hint={used ? "Has entries — the code is fixed" : "e.g. 6055"}>{(id, d) => <Input id={id} aria-describedby={d} className="font-mono" value={f.code} disabled={used} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
        <Field label="Type" required>{(id) => <Select id={id} value={f.type} disabled={used} onChange={(e) => setF({ ...f, type: e.target.value, parent_id: "" })}>{["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>}</Field>
        <Field label="Name" required className="sm:col-span-2">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Under (parent account)" className="sm:col-span-2">{(id) => <Select id={id} value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}><option value="">— None —</option>{parents.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</Select>}</Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={!f.is_postable} onChange={(e) => setF({ ...f, is_postable: !e.target.checked })} /> Header account (groups other accounts; takes no entries)</label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.allow_manual} disabled={!f.is_postable} onChange={(e) => setF({ ...f, allow_manual: e.target.checked })} /> Allow manual journals (untick for accounts only the system should post to)</label>
        {!isNew && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
        <p className="text-xs text-slate-500 sm:col-span-2">Accounts used by posting rules, financial accounts, expense categories or tax rates cannot be deleted or deactivated; accounts with entries keep their code and type.</p>
        <div className="sm:col-span-2"><ErrorText error={err} /></div>
      </div>
    </Modal>
  );
}

function Periods() {
  const { can } = useSession();
  const toast = useToast();
  const q = useApi<any[]>("/accounting/periods");
  const [closing, setClosing] = useState<any>(null);
  const [reopening, setReopening] = useState<any>(null);
  return (
    <Card padded={false} title="Fiscal periods (monthly)">
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} columns={[
        { key: "name", header: "Period" }, { key: "start", header: "From", render: (p) => date(p.start_date) }, { key: "end", header: "To", render: (p) => date(p.end_date) },
        { key: "status", header: "Status", render: (p) => <Status value={p.status} /> }, { key: "closed_at", header: "Closed", render: (p) => dateTime(p.closed_at) },
        { key: "a", header: "", align: "right", render: (p) => can("accounting.periods") && (p.status === "OPEN" ? <Button size="sm" variant="secondary" onClick={() => setClosing(p)}>Close period</Button> : <Button size="sm" variant="secondary" onClick={() => setReopening(p)}>Request reopen</Button>) },
      ]} />
      <ConfirmDialog open={!!closing} title={`Close ${closing?.name}`} message="No further postings will be accepted in this period (including stock documents). Reopening requires approval." onClose={() => setClosing(null)} onConfirm={async () => { await api(`/accounting/periods/${closing.id}/close`, { method: "POST" }); toast("Period closed"); q.refetch(); }} />
      <ConfirmDialog open={!!reopening} requireReason title={`Request reopening ${reopening?.name}`} message="An approver must approve this request." onClose={() => setReopening(null)} onConfirm={async (reason) => { await api(`/accounting/periods/${reopening.id}/reopen-request`, { body: { reason } }); toast("Reopen request sent for approval"); }} />
    </Card>
  );
}
