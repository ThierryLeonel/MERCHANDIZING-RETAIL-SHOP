import { Plus } from "lucide-react";
import { useState } from "react";
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, SearchInput, Select, Status, Tabs, Textarea, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { dateTime, humanize, money } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function AdminPage() {
  const { can } = useSession();
  const [tab, setTab] = useState(can("admin.settings") ? "settings" : can("admin.users") ? "users" : "audit");
  return (
    <div>
      <PageHeader title="Administration" subtitle="Technical administration does not confer financial approval authority." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: "settings", label: "Business settings", hidden: !can("admin.settings") }, { key: "branches", label: "Branches & registers", hidden: !can("admin.settings") },
        { key: "users", label: "Users", hidden: !can("admin.users") }, { key: "roles", label: "Roles & permissions", hidden: !can("admin.users") },
        { key: "taxes", label: "Tax rates", hidden: !can("admin.settings") }, { key: "policies", label: "Approval policies", hidden: !can("approvals.view") },
        { key: "audit", label: "Audit log", hidden: !can("admin.audit") },
      ]} />
      {tab === "settings" && <Settings />}
      {tab === "branches" && <Branches />}
      {tab === "users" && <Users />}
      {tab === "roles" && <Roles />}
      {tab === "taxes" && <Taxes />}
      {tab === "policies" && <Policies />}
      {tab === "audit" && <Audit />}
    </div>
  );
}

function Settings() {
  const toast = useToast();
  const { reload } = useSession();
  const q = useApi<any>("/admin/settings");
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  if (q.data && !f) setF({ name: q.data.name, legal_name: q.data.legal_name ?? "", tax_id: q.data.tax_id ?? "", phone: q.data.phone ?? "", address: q.data.address ?? "", receipt_footer: q.data.receipt_footer ?? "", prices_include_tax: q.data.prices_include_tax, ...q.data.policies });
  if (!f) return null;
  const save = async () => {
    setErr(null);
    try {
      await api("/admin/settings", { method: "PATCH", body: { name: f.name, legal_name: f.legal_name || undefined, tax_id: f.tax_id || undefined, phone: f.phone || undefined, address: f.address || undefined, receipt_footer: f.receipt_footer, prices_include_tax: f.prices_include_tax, settings: { over_receipt_tolerance_percent: Number(f.over_receipt_tolerance_percent), return_window_days: Number(f.return_window_days), default_payment_terms_days: Number(f.default_payment_terms_days) } } });
      toast("Settings saved"); reload();
    } catch (e) { setErr(e); }
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return (
    <Card title="Business settings" actions={<Button size="sm" onClick={save}>Save</Button>}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Trading name">{(id) => <Input id={id} value={f.name} onChange={set("name")} />}</Field>
        <Field label="Legal name">{(id) => <Input id={id} value={f.legal_name} onChange={set("legal_name")} />}</Field>
        <Field label="Taxpayer ID">{(id) => <Input id={id} value={f.tax_id} onChange={set("tax_id")} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={f.phone} onChange={set("phone")} />}</Field>
        <Field label="Address" className="md:col-span-2">{(id) => <Input id={id} value={f.address} onChange={set("address")} />}</Field>
        <Field label="Receipt footer" className="md:col-span-3">{(id) => <Textarea id={id} rows={2} value={f.receipt_footer} onChange={set("receipt_footer")} />}</Field>
        <Field label="Over-receipt tolerance (%)">{(id) => <Input id={id} value={f.over_receipt_tolerance_percent} onChange={set("over_receipt_tolerance_percent")} />}</Field>
        <Field label="Return window (days)">{(id) => <Input id={id} value={f.return_window_days} onChange={set("return_window_days")} />}</Field>
        <Field label="Default customer terms (days)">{(id) => <Input id={id} value={f.default_payment_terms_days} onChange={set("default_payment_terms_days")} />}</Field>
        <label className="flex items-center gap-2 text-sm md:col-span-3"><input type="checkbox" checked={f.prices_include_tax} onChange={set("prices_include_tax")} /> Shelf prices include tax (financial setting — Owner/Accountant only)</label>
      </div>
      <dl className="mt-4 grid gap-2 text-sm text-slate-600 md:grid-cols-3">
        <div>Currency: <strong>{q.data.currency_code}</strong> ({q.data.currency_decimals} decimals)</div><div>Timezone: <strong>{q.data.timezone}</strong></div><div>Costing: <strong>weighted average per branch</strong></div>
      </dl>
      <ErrorText error={err} />
    </Card>
  );
}

function Branches() {
  const toast = useToast();
  const q = useApi<any[]>("/admin/branches");
  const regs = useApi<any[]>("/admin/registers");
  const [open, setOpen] = useState<"branch" | "register" | null>(null);
  const [f, setF] = useState<any>({ code: "", name: "", kind: "STORE", branch_id: "" });
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try { await api(open === "branch" ? "/admin/branches" : "/admin/registers", { body: open === "branch" ? { code: f.code, name: f.name, kind: f.kind } : { branch_id: f.branch_id, code: f.code, name: f.name } }); toast("Saved"); setOpen(null); q.refetch(); regs.refetch(); }
    catch (e) { setErr(e); }
  };
  return (
    <div className="space-y-5">
      <Card title="Branches and locations" padded={false} actions={<><Button size="sm" variant="secondary" onClick={() => setOpen("register")}>New register</Button><Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen("branch")}>New branch</Button></>}>
        <DataTable rows={q.data} loading={q.isLoading} columns={[
          { key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "kind", header: "Type", render: (b) => <Badge>{humanize(b.kind)}</Badge> },
          { key: "locations", header: "Locations", render: (b) => <div className="flex flex-wrap gap-1">{b.locations.map((l: any) => <Badge key={l.id} tone={l.is_sellable ? "green" : "amber"}>{l.code}{l.is_default ? " (default)" : ""}</Badge>)}</div> },
          { key: "registers", header: "Registers", render: (b) => regs.data?.filter((r) => r.branch_id === b.id).map((r) => r.code).join(", ") || "—" },
        ]} />
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open === "branch" ? "New branch" : "New register"} footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button onClick={save}>Create</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {open === "register" && <Field label="Branch" className="sm:col-span-2">{(id) => <Select id={id} value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })}><option value="">Select…</option>{q.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>}
          <Field label="Code">{(id) => <Input id={id} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />}</Field>
          <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          {open === "branch" && <Field label="Type">{(id) => <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="STORE">Store</option><option value="WAREHOUSE">Warehouse</option></Select>}</Field>}
        </div>
        <p className="mt-2 text-xs text-slate-500">{open === "branch" ? "Standard locations (sales floor/store, back store, quarantine, damaged) and a safe account are created automatically." : "A dedicated till account and ledger sub-account are created for the register."}</p>
        <ErrorText error={err} />
      </Modal>
    </div>
  );
}

function Users() {
  const toast = useToast();
  const { me } = useSession();
  const list = useList<any>("/admin/users", {}, { sort: "full_name", order: "asc" });
  const roles = useApi<any>("/admin/roles");
  const [editing, setEditing] = useState<any>(null);
  const [f, setF] = useState<any>({});
  const [err, setErr] = useState<unknown>(null);
  const openNew = () => { setF({ email: "", full_name: "", password: "", roles: [], branch_ids: [], all_branches: false }); setEditing("new"); setErr(null); };
  const openEdit = (u: any) => { setF({ full_name: u.full_name, roles: u.roles, branch_ids: u.branch_ids, all_branches: u.all_branches, status: u.status, reset_password: "" }); setEditing(u); setErr(null); };
  const save = async () => {
    setErr(null);
    try {
      if (editing === "new") await api("/admin/users", { body: f });
      else await api(`/admin/users/${editing.id}`, { method: "PATCH", body: { ...f, reset_password: f.reset_password || undefined } });
      toast("User saved"); setEditing(null); list.refetch();
    } catch (e) { setErr(e); }
  };
  const toggle = (k: "roles" | "branch_ids", v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x: string) => x !== v) : [...f[k], v] });
  return (
    <Card padded={false} title="Users" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={openNew}>New user</Button>}>
      <div className="border-b border-slate-200 p-3"><SearchInput value={list.search} onChange={list.setSearch} /></div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRowClick={openEdit} columns={[
        { key: "full_name", header: "Name", render: (u) => <div><div className="font-medium">{u.full_name}</div><div className="text-xs text-slate-500">{u.email}</div></div> },
        { key: "roles", header: "Roles", render: (u) => <div className="flex flex-wrap gap-1">{u.roles.map((r: string) => <Badge key={r}>{humanize(r)}</Badge>)}</div> },
        { key: "branches", header: "Branches", render: (u) => (u.all_branches ? "All" : u.branch_ids.map((b: string) => me?.branches.find((x) => x.id === b)?.code ?? "…").join(", ")) },
        { key: "last_login_at", header: "Last sign-in", render: (u) => dateTime(u.last_login_at) }, { key: "status", header: "Status", render: (u) => <Status value={u.status} /> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? "New user" : `Edit ${editing?.email}`} size="lg" footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          {editing === "new" && <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}</Field>}
          <Field label="Full name">{(id) => <Input id={id} value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />}</Field>
          {editing === "new" ? <Field label="Temporary password" hint="User must change it at first sign-in">{(id, d) => <Input id={id} aria-describedby={d} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
            : <><Field label="Reset password (optional)">{(id) => <Input id={id} type="password" value={f.reset_password} onChange={(e) => setF({ ...f, reset_password: e.target.value })} />}</Field><Field label="Status">{(id) => <Select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></Select>}</Field></>}
          <fieldset className="sm:col-span-2"><legend className="mb-1 text-sm font-medium">Roles</legend><div className="flex flex-wrap gap-3">{roles.data?.roles.map((r: any) => <label key={r.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.roles?.includes(r.code)} onChange={() => toggle("roles", r.code)} />{r.name}</label>)}</div></fieldset>
          <fieldset className="sm:col-span-2"><legend className="mb-1 text-sm font-medium">Branch access</legend>
            <label className="mb-1 flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.all_branches} onChange={(e) => setF({ ...f, all_branches: e.target.checked })} />All branches</label>
            {!f.all_branches && <div className="flex flex-wrap gap-3">{me?.branches.map((b) => <label key={b.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={f.branch_ids?.includes(b.id)} onChange={() => toggle("branch_ids", b.id)} />{b.code}</label>)}</div>}
          </fieldset>
        </div>
        <p className="mt-2 text-xs text-slate-500">You can only grant roles whose permissions you hold. Changing roles, passwords or status signs the user out everywhere.</p>
        <ErrorText error={err} />
      </Modal>
    </Card>
  );
}

function Roles() {
  const { can } = useSession();
  const toast = useToast();
  const q = useApi<any>("/admin/roles");
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  if (!q.data) return null;
  const modules = [...new Set(q.data.catalogue.map((p: any) => p.module))] as string[];
  const has = (r: any, code: string) => (edits[r.id] ?? r.permissions).includes(code);
  const toggle = (r: any, code: string) => { const cur = edits[r.id] ?? r.permissions; setEdits({ ...edits, [r.id]: cur.includes(code) ? cur.filter((c: string) => c !== code) : [...cur, code] }); };
  const save = async (r: any) => { try { await api(`/admin/roles/${r.id}/permissions`, { method: "PUT", body: { permissions: edits[r.id] } }); toast(`${r.name} updated`); const n = { ...edits }; delete n[r.id]; setEdits(n); q.refetch(); } catch (e) { toast((e as Error).message, "error"); } };
  return (
    <Card padded={false} title="Role and permission matrix" actions={<span className="text-xs text-slate-500">Enforced on the server for every request. ★ = sensitive</span>}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 bg-slate-50"><tr><th className="px-3 py-2 text-left">Permission</th>{q.data.roles.map((r: any) => <th key={r.id} className="px-2 py-2 text-center">{r.name}{edits[r.id] && can("admin.roles") && <div><Button size="sm" className="mt-1 h-6 px-2 text-[11px]" onClick={() => save(r)}>Save</Button></div>}</th>)}</tr></thead>
          <tbody>
            {modules.map((m) => [
              <tr key={m} className="bg-slate-100"><td colSpan={q.data.roles.length + 1} className="px-3 py-1 font-semibold uppercase tracking-wide text-slate-600">{m}</td></tr>,
              ...q.data.catalogue.filter((p: any) => p.module === m).map((p: any) => (
                <tr key={p.code} className="border-t border-slate-100">
                  <td className="px-3 py-1.5"><div className="font-mono">{p.code}{p.sensitive && " ★"}</div><div className="text-slate-500">{p.description}</div></td>
                  {q.data.roles.map((r: any) => <td key={r.id} className="text-center"><input type="checkbox" aria-label={`${r.name}: ${p.code}`} checked={has(r, p.code)} disabled={!can("admin.roles") || r.code === "OWNER"} onChange={() => toggle(r, p.code)} /></td>)}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Taxes() {
  const { can } = useSession();
  const q = useApi<any[]>("/admin/tax-rates");
  const [f, setF] = useState({ code: "", name: "", rate_percent: "" });
  const [err, setErr] = useState<unknown>(null);
  const add = async () => { setErr(null); try { await api("/admin/tax-rates", { body: f }); setF({ code: "", name: "", rate_percent: "" }); q.refetch(); } catch (e) { setErr(e); } };
  return (
    <Card title="Tax rates" padded={false}>
      <p className="px-4 pt-3 text-sm text-amber-800">Configure rates from current official guidance. The system does not ship statutory rates and makes no claim of tax compliance.</p>
      <DataTable rows={q.data} columns={[{ key: "code", header: "Code" }, { key: "name", header: "Name" }, { key: "rate_percent", header: "Rate %", align: "right" }, { key: "active", header: "Active", render: (t) => (t.active ? "Yes" : "No") }]} />
      {can("accounting.periods") && <div className="flex flex-wrap items-end gap-2 border-t border-slate-200 p-3"><Input aria-label="Code" placeholder="Code" className="w-28" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /><Input aria-label="Name" placeholder="Name" className="w-64" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /><Input aria-label="Rate" placeholder="Rate %" className="w-24" value={f.rate_percent} onChange={(e) => setF({ ...f, rate_percent: e.target.value })} /><Button size="sm" onClick={add}>Add rate</Button><ErrorText error={err} /></div>}
    </Card>
  );
}

function Policies() {
  const { can } = useSession();
  const toast = useToast();
  const q = useApi<any[]>("/admin/approval-policies");
  const editable = can("admin.settings") && can("accounting.periods");
  const update = async (p: any, patch: any) => { try { await api(`/admin/approval-policies/${p.id}`, { method: "PATCH", body: patch }); toast("Policy updated"); q.refetch(); } catch (e) { toast((e as Error).message, "error"); } };
  return (
    <Card title="Approval policies" padded={false} actions={!editable && <span className="text-xs text-slate-500">Read-only (Owner can edit)</span>}>
      <DataTable rows={q.data} columns={[
        { key: "request_type", header: "Request", render: (p) => <div><div className="font-medium">{humanize(p.request_type)}</div><div className="text-xs text-slate-500">{p.description}</div></div> },
        { key: "threshold", header: "Threshold", render: (p) => editable ? <Input aria-label="Threshold" className="h-8 w-32" defaultValue={p.threshold_amount ?? p.threshold_percent ?? ""} placeholder="Always" onBlur={(e) => { const v = e.target.value; if (v !== String(p.threshold_amount ?? p.threshold_percent ?? "")) update(p, p.threshold_percent != null ? { threshold_percent: v || null } : { threshold_amount: v || null }); }} /> : p.threshold_amount != null ? money(p.threshold_amount) : p.threshold_percent != null ? `${p.threshold_percent}%` : "Always" },
        { key: "approver_permission", header: "Approver permission", render: (p) => <code className="text-xs">{p.approver_permission}</code> },
        { key: "enabled", header: "Enabled", render: (p) => <input type="checkbox" aria-label="Enabled" checked={p.enabled} disabled={!editable} onChange={(e) => update(p, { enabled: e.target.checked })} /> },
        { key: "self", header: "Self-approval", render: (p) => (p.allow_self_approval ? <Badge tone="amber">Allowed</Badge> : "Blocked") },
      ]} />
    </Card>
  );
}

function Audit() {
  const [search, setSearch] = useState("");
  const q = useApi<any[]>(`/reports/audit?from=2000-01-01&to=2100-01-01&search=${encodeURIComponent(search)}`, [search]);
  return (
    <Card padded={false} title="Audit log (latest 200)">
      <div className="border-b border-slate-200 p-3"><SearchInput value={search} onChange={setSearch} placeholder="Search action or summary" /></div>
      <DataTable rows={q.data} loading={q.isLoading} error={q.error} columns={[{ key: "created_at", header: "When", render: (a) => dateTime(a.created_at) }, { key: "actor_name", header: "User" }, { key: "action", header: "Action", render: (a) => <code className="text-xs">{a.action}</code> }, { key: "summary", header: "Summary" }, { key: "ip_address", header: "IP" }]} />
    </Card>
  );
}
