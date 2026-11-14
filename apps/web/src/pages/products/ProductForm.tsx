import { Plus, Trash2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, Textarea, useToast } from "../../components/ui";
import { useSession } from "../../lib/session";
import { api } from "../../lib/api";
import { humanize } from "../../lib/format";
import { useApi } from "../../lib/hooks";

const TYPES = [
  ["STANDARD", "Standard stocked product (one SKU)"], ["VARIANT", "Product with variants (size, colour, volume…)"],
  ["BULK", "Bulk / loose goods — stocked and sold by quantity or weight, not item by item"], ["PREPACKED_SET", "Prepacked set stocked as one item"],
  ["NON_STOCK", "Non-stock item or service"], ["VIRTUAL_BUNDLE", "Virtual bundle — Phase 3 (not yet available)"], ["ASSEMBLED_KIT", "Assembled kit — Phase 3 (not yet available)"],
];
interface V { sku: string; name: string; retail_price: string; wholesale_price: string; min_price: string; barcode: string; reorder_point: string; attribute_value_ids: string[]; carton_unit_id: string; carton_factor: string }
const blank = (): V => ({ sku: "", name: "", retail_price: "", wholesale_price: "", min_price: "", barcode: "", reorder_point: "0", attribute_value_ids: [], carton_unit_id: "", carton_factor: "" });

export default function ProductForm() {
  const ref = useApi<any>("/catalogue/reference");
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const canPrice = can("prices.manage");
  const [f, setF] = useState({ code: "", name: "", description: "", product_type: "STANDARD", department_id: "", category_id: "", brand_id: "", base_unit_id: "", tax_rate_id: "", track_batches: false, track_expiry: false, track_serials: false, warranty_months: "", negotiable_price: false });
  const [newCat, setNewCat] = useState(false);
  const [variants, setVariants] = useState<V[]>([blank()]);
  const [err, setErr] = useState<any>(null); const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const setV = (i: number, k: keyof V, v: any) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const units = ref.data?.units ?? [];
  const baseUnit = f.base_unit_id || units.find((u: any) => u.code === "PCS")?.id || "";
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const p = await api("/products", { body: {
        code: f.code, name: f.name, description: f.description || undefined, product_type: f.product_type, department_id: f.department_id || undefined, category_id: f.category_id || undefined,
        brand_id: f.brand_id || undefined, base_unit_id: baseUnit, tax_rate_id: f.tax_rate_id || undefined, track_batches: f.track_batches || f.track_expiry, track_expiry: f.track_expiry, track_serials: f.track_serials,
        warranty_months: f.warranty_months ? Number(f.warranty_months) : undefined, negotiable_price: f.negotiable_price || undefined,
        variants: variants.map((v) => ({
          sku: v.sku, name: v.name || f.name, retail_price: v.retail_price, wholesale_price: v.wholesale_price || undefined, min_price: v.min_price || undefined, reorder_point: v.reorder_point || "0",
          attribute_value_ids: v.attribute_value_ids.length ? v.attribute_value_ids : undefined, barcodes: v.barcode ? [{ code: v.barcode }] : undefined,
          conversions: v.carton_unit_id && v.carton_factor ? [{ unit_id: v.carton_unit_id, factor: v.carton_factor, is_purchase_default: true, is_sellable: true }] : undefined,
        })),
      } });
      toast("Product created"); nav(`/products/${p.id}`);
    } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  const multi = f.product_type === "VARIANT";
  return (
    <>
    <form onSubmit={submit} className="space-y-5">
      <PageHeader title="New product" actions={<><Button type="button" variant="secondary" onClick={() => nav(-1)}>Cancel</Button><Button type="submit" loading={busy}>Create product</Button></>} />
      <Card title="Product">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Product code" required>{(id) => <Input id={id} required value={f.code} onChange={set("code")} />}</Field>
          <Field label="Name" required className="md:col-span-2">{(id) => <Input id={id} required value={f.name} onChange={set("name")} />}</Field>
          <Field label="Type" className="md:col-span-3" hint="Each type has different stock behaviour">{(id, d) => <Select id={id} aria-describedby={d} value={f.product_type} onChange={(e) => {
            const t = e.target.value;
            const kg = units.find((u: any) => u.code === "KG")?.id;
            setF({ ...f, product_type: t, ...(t === "BULK" ? { negotiable_price: canPrice ? true : f.negotiable_price, track_serials: false, base_unit_id: f.base_unit_id || kg || "" } : {}) });
            if (t !== "VARIANT") setVariants((v) => v.slice(0, 1));
          }}>{TYPES.map(([v, l]) => <option key={v} value={v} disabled={v === "VIRTUAL_BUNDLE" || v === "ASSEMBLED_KIT"}>{l}</option>)}</Select>}</Field>
          <Field label="Department">{(id) => <Select id={id} value={f.department_id} onChange={set("department_id")}><option value="">—</option>{ref.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
          <Field label="Category">{(id) => (
            <div className="flex gap-1.5">
              <Select id={id} value={f.category_id} onChange={set("category_id")}><option value="">—</option>{ref.data?.categories.filter((c: any) => c.active && (!f.department_id || !c.department_id || c.department_id === f.department_id)).map((c: any) => <option key={c.id} value={c.id}>{c.parent_id ? `${ref.data.categories.find((x: any) => x.id === c.parent_id)?.name ?? ""} › ` : ""}{c.name}</option>)}</Select>
              <Button type="button" variant="secondary" aria-label="New category" title="New category" onClick={() => setNewCat(true)}><Plus className="h-4 w-4" /></Button>
            </div>
          )}</Field>
          <Field label="Brand">{(id) => <Select id={id} value={f.brand_id} onChange={set("brand_id")}><option value="">—</option>{ref.data?.brands.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>
          <Field label="Base (stock) unit" hint={f.product_type === "BULK" ? "The unit you count and sell in, e.g. kg, litre, heap" : undefined}>{(id) => <Select id={id} value={baseUnit} onChange={set("base_unit_id")}>{units.map((u: any) => <option key={u.id} value={u.id}>{u.name} ({u.code})</option>)}</Select>}</Field>
          <Field label="Tax rate">{(id) => <Select id={id} value={f.tax_rate_id} onChange={set("tax_rate_id")}><option value="">None</option>{ref.data?.tax_rates.filter((t: any) => t.active).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
          <Field label="Warranty (months)">{(id) => <Input id={id} inputMode="numeric" value={f.warranty_months} onChange={set("warranty_months")} />}</Field>
          <div className="flex flex-wrap gap-4 text-sm md:col-span-3">
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.track_batches} onChange={set("track_batches")} disabled={f.product_type === "NON_STOCK"} /> Track batches</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.track_expiry} onChange={set("track_expiry")} disabled={f.product_type === "NON_STOCK"} /> Track expiry dates</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={f.track_serials} onChange={set("track_serials")} disabled={f.product_type === "NON_STOCK" || f.product_type === "BULK"} /> Track serial numbers</label>
            <label className="flex items-center gap-2" title={canPrice ? undefined : "Requires prices.manage"}><input type="checkbox" checked={f.negotiable_price} onChange={set("negotiable_price")} disabled={!canPrice} /> Price can be bargained at the till (never below the minimum price)</label>
          </div>
          {f.product_type === "BULK" && <p className="rounded-md bg-sky-50 p-2 text-xs text-sky-800 md:col-span-3">Bulk goods are counted in the base unit (fractions allowed, e.g. 2.5 kg). To buy a whole lot and sell it by the piece or kilo, add a packaging unit below (e.g. 1 bale = 120 pieces) and receive purchases in that unit.</p>}
          <Field label="Description" className="md:col-span-3">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={set("description")} />}</Field>
        </div>
      </Card>
      <Card title={multi ? "Variants" : "SKU"} actions={multi && <Button type="button" size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setVariants([...variants, blank()])}>Add variant</Button>}>
        <div className="space-y-4">
          {variants.map((v, i) => (
            <div key={i} className="grid gap-3 rounded-md border border-slate-200 p-3 md:grid-cols-6">
              <Field label="SKU" required>{(id) => <Input id={id} required value={v.sku} onChange={(e) => setV(i, "sku", e.target.value)} />}</Field>
              <Field label="Variant name" className="md:col-span-2">{(id) => <Input id={id} placeholder={f.name} value={v.name} onChange={(e) => setV(i, "name", e.target.value)} />}</Field>
              <Field label={f.negotiable_price ? "Asking price" : "Retail price"} required>{(id) => <Input id={id} required inputMode="decimal" value={v.retail_price} onChange={(e) => setV(i, "retail_price", e.target.value)} />}</Field>
              <Field label="Minimum price" required={f.negotiable_price} hint={f.negotiable_price ? "Lowest bargained price" : undefined}>{(id, d) => <Input id={id} aria-describedby={d} required={f.negotiable_price} disabled={!canPrice} inputMode="decimal" value={v.min_price} onChange={(e) => setV(i, "min_price", e.target.value)} />}</Field>
              <Field label="Barcode">{(id) => <Input id={id} value={v.barcode} onChange={(e) => setV(i, "barcode", e.target.value)} />}</Field>
              <Field label="Wholesale price">{(id) => <Input id={id} inputMode="decimal" value={v.wholesale_price} onChange={(e) => setV(i, "wholesale_price", e.target.value)} />}</Field>
              <Field label="Reorder point">{(id) => <Input id={id} inputMode="decimal" value={v.reorder_point} onChange={(e) => setV(i, "reorder_point", e.target.value)} />}</Field>
              <Field label="Packaging unit">{(id) => <Select id={id} value={v.carton_unit_id} onChange={(e) => setV(i, "carton_unit_id", e.target.value)}><option value="">None</option>{units.filter((u: any) => u.id !== baseUnit).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}</Field>
              <Field label="Base units per package" hint="e.g. carton of 24">{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" disabled={!v.carton_unit_id} value={v.carton_factor} onChange={(e) => setV(i, "carton_factor", e.target.value)} />}</Field>
              {multi && ref.data?.attributes.map((a: any) => (
                <Field key={a.id} label={a.name}>{(id) => <Select id={id} value={v.attribute_value_ids.find((x) => a.values.some((av: any) => av.id === x)) ?? ""} onChange={(e) => setV(i, "attribute_value_ids", [...v.attribute_value_ids.filter((x) => !a.values.some((av: any) => av.id === x)), ...(e.target.value ? [e.target.value] : [])])}><option value="">—</option>{a.values.map((av: any) => <option key={av.id} value={av.id}>{av.value}</option>)}</Select>}</Field>
              ))}
              {multi && variants.length > 1 && <div className="flex items-end"><Button type="button" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setVariants(variants.filter((_, j) => j !== i))}>Remove</Button></div>}
            </div>
          ))}
        </div>
      </Card>
      {err && <Card><ErrorText error={err} />{err.details && <ul className="mt-1 list-disc pl-5 text-xs text-red-600">{(Array.isArray(err.details) ? err.details : []).map((d: string) => <li key={d}>{humanize(d)}</li>)}</ul>}</Card>}
    </form>
      {newCat && <NewCategory parents={ref.data?.categories ?? []} departmentId={f.department_id} onClose={() => setNewCat(false)} onCreated={async (id) => { await ref.refetch(); setF((x) => ({ ...x, category_id: id })); setNewCat(false); toast("Category added"); }} />}
    </>
  );
}

function NewCategory({ parents, departmentId, onClose, onCreated }: { parents: any[]; departmentId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState(""); const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { const c = await api<any>("/catalogue/categories", { body: { name, parent_id: parentId || undefined, department_id: departmentId || undefined } }); onCreated(c.id); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New category" footer={<><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="button" loading={busy} disabled={!name.trim()} onClick={save}>Add category</Button></>}>
      <div className="grid gap-3">
        <Field label="Name" required>{(id) => <Input id={id} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Inside category">{(id) => <Select id={id} value={parentId} onChange={(e) => setParentId(e.target.value)}><option value="">— Top level —</option>{parents.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
