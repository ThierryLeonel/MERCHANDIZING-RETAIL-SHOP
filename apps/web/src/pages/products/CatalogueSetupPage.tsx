import { ArrowLeft, Plus } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router";
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Modal, PageHeader, Select, Tabs, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

type Kind = "categories" | "departments" | "brands" | "units";
const LABEL: Record<Kind, string> = { categories: "category", departments: "department", brands: "brand", units: "unit" };

/** Categories (with sub-categories), departments, brands and units of measure. */
export default function CatalogueSetupPage() {
  const [tab, setTab] = useState<Kind>("categories");
  return (
    <div>
      <PageHeader title="Catalogue setup" subtitle="Stock categories, departments, brands and units used to organise products"
        actions={<Link to="/products"><Button variant="secondary" icon={<ArrowLeft className="h-4 w-4" />}>Products</Button></Link>} />
      <Tabs value={tab} onChange={(k) => setTab(k as Kind)} tabs={[{ key: "categories", label: "Categories" }, { key: "departments", label: "Departments" }, { key: "brands", label: "Brands" }, { key: "units", label: "Units" }]} />
      <div className="mt-4">{tab === "categories" ? <Categories /> : <SimpleList kind={tab} />}</div>
    </div>
  );
}

/** Orders categories as a tree (parents followed by their children) with a depth for indentation. */
function treeOrder(cats: any[]) {
  const out: (any & { depth: number })[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const c of cats.filter((x) => (x.parent_id ?? null) === parentId)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id); out.push({ ...c, depth }); walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const c of cats) if (!seen.has(c.id)) out.push({ ...c, depth: 0 }); // orphans (parent removed)
  return out;
}

function Categories() {
  const { can } = useSession();
  const toast = useToast();
  const list = useApi<any[]>("/catalogue/categories");
  const ref = useApi<any>("/catalogue/reference");
  const rows = useMemo(() => treeOrder(list.data ?? []), [list.data]);
  const [f, setF] = useState({ name: "", parent_id: "", department_id: "" });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [editing, setEditing] = useState<any>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api("/catalogue/categories", { body: { name: f.name, parent_id: f.parent_id || undefined, department_id: f.department_id || undefined } });
      toast(`Category “${f.name}” added`); setF({ ...f, name: "" }); list.refetch();
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {can("products.manage") && (
        <Card title="Add a category">
          <form onSubmit={add} className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
            <Field label="Name" required>{(id) => <Input id={id} required value={f.name} placeholder="e.g. Rice & grains" onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
            <Field label="Inside category" hint="Leave empty for a top-level category">{(id, d) => <Select id={id} aria-describedby={d} value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}><option value="">— Top level —</option>{rows.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth)}{c.name}</option>)}</Select>}</Field>
            <Field label="Department">{(id) => <Select id={id} value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}><option value="">—</option>{ref.data?.departments.filter((d: any) => d.active).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
            <Button type="submit" loading={busy} icon={<Plus className="h-4 w-4" />}>Add</Button>
          </form>
          <ErrorText error={err} />
        </Card>
      )}
      <Card padded={false}>
        <DataTable rows={rows} loading={list.isLoading} error={list.error} onRetry={list.refetch} empty="No categories yet — add your first one above." columns={[
          { key: "name", header: "Category", render: (c) => <div style={{ paddingLeft: c.depth * 20 }} className="flex items-center gap-2">{c.depth > 0 && <span className="text-slate-300" aria-hidden>└</span>}<span className="font-medium">{c.name}</span></div> },
          { key: "code", header: "Code", render: (c) => <span className="font-mono text-xs text-slate-500">{c.code}</span> },
          { key: "dept", header: "Department", render: (c) => c.department_name ?? "—" },
          { key: "count", header: "Products", align: "right", render: (c) => <Link className="text-brand-700 hover:underline" to={`/products?category_id=${c.id}`}>{c.product_count}</Link> },
          { key: "status", header: "Status", render: (c) => c.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge> },
          { key: "a", header: "", align: "right", render: (c) => can("products.manage") && <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>Edit</Button> },
        ]} />
      </Card>
      {editing && <CategoryEdit cat={editing} all={rows} departments={ref.data?.departments ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.refetch(); toast("Category updated"); }} />}
    </div>
  );
}

function CategoryEdit({ cat, all, departments, onClose, onSaved }: { cat: any; all: any[]; departments: any[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: cat.name, parent_id: cat.parent_id ?? "", department_id: cat.department_id ?? "", active: cat.active });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  // A category cannot move under itself or its own sub-categories.
  const blocked = useMemo(() => {
    const ids = new Set<string>([cat.id]);
    let grew = true;
    while (grew) { grew = false; for (const c of all) if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) { ids.add(c.id); grew = true; } }
    return ids;
  }, [all, cat.id]);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api(`/catalogue/categories/${cat.id}`, { method: "PATCH", body: { name: f.name, parent_id: f.parent_id || null, department_id: f.department_id || null, active: f.active } }); onSaved(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Edit category — ${cat.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-3">
        <Field label="Name" required>{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="Inside category">{(id) => <Select id={id} value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}><option value="">— Top level —</option>{all.filter((c) => !blocked.has(c.id)).map((c) => <option key={c.id} value={c.id}>{"  ".repeat(c.depth)}{c.name}</option>)}</Select>}</Field>
        <Field label="Department">{(id) => <Select id={id} value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })}><option value="">—</option>{departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (inactive categories are hidden when creating products; existing products keep them)</label>
        {cat.product_count > 0 && <p className="text-xs text-slate-500">{cat.product_count} product(s) use this category.</p>}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function SimpleList({ kind }: { kind: Exclude<Kind, "categories"> }) {
  const { can } = useSession();
  const toast = useToast();
  const ref = useApi<any>("/catalogue/reference");
  const rows: any[] = ref.data?.[kind] ?? [];
  const [name, setName] = useState(""); const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const [editing, setEditing] = useState<any>(null);
  const hasStatus = kind !== "units";
  const add = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api(`/catalogue/${kind}`, { body: { name, code: kind === "units" && code ? code : undefined } }); toast(`${name} added`); setName(""); setCode(""); ref.refetch(); }
    catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-4">
      {can("products.manage") && (
        <Card title={`Add a ${LABEL[kind]}`}>
          <form onSubmit={add} className="flex flex-wrap items-end gap-3">
            <Field label="Name" required className="min-w-[240px] flex-1">{(id) => <Input id={id} required value={name} placeholder={kind === "units" ? "e.g. Kilogram, Bale, Heap, Bucket" : undefined} onChange={(e) => setName(e.target.value)} />}</Field>
            {kind === "units" && <Field label="Short code" hint="Shown on receipts, e.g. KG">{(id, d) => <Input id={id} aria-describedby={d} className="w-32 uppercase" maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} />}</Field>}
            <Button type="submit" loading={busy} icon={<Plus className="h-4 w-4" />}>Add</Button>
          </form>
          <ErrorText error={err} />
          {kind === "units" && <p className="mt-2 text-xs text-slate-500">Use units such as kilogram, litre, bale or heap for bulk / loose goods, and packaging units (carton, bag) to buy a lot and sell it by the piece.</p>}
        </Card>
      )}
      <Card padded={false}>
        <DataTable rows={rows} loading={ref.isLoading} error={ref.error} onRetry={ref.refetch} columns={[
          { key: "name", header: "Name", render: (r) => <span className="font-medium">{r.name}</span> },
          ...(kind !== "brands" ? [{ key: "code", header: "Code", render: (r: any) => <span className="font-mono text-xs text-slate-500">{r.code}</span> }] : []),
          ...(hasStatus ? [{ key: "status", header: "Status", render: (r: any) => r.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge> }] : []),
          { key: "a", header: "", align: "right", render: (r) => can("products.manage") && <Button size="sm" variant="secondary" onClick={() => setEditing(r)}>Edit</Button> },
        ]} />
      </Card>
      {editing && <RefEdit kind={kind} row={editing} hasStatus={hasStatus} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); ref.refetch(); toast("Saved"); }} />}
    </div>
  );
}

function RefEdit({ kind, row, hasStatus, onClose, onSaved }: { kind: Kind; row: any; hasStatus: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(row.name); const [active, setActive] = useState(row.active ?? true);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api(`/catalogue/${kind}/${row.id}`, { method: "PATCH", body: { name, ...(hasStatus ? { active } : {}) } }); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${LABEL[kind]} — ${row.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-3">
        <Field label="Name" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        {hasStatus && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
