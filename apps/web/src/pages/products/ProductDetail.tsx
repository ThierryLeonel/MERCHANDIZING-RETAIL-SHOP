import { ImagePlus, Package } from "lucide-react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorState, ErrorText, Field, Input, Modal, PageHeader, Spinner, Status, useToast } from "../../components/ui";
import { api, getAccessToken } from "../../lib/api";
import { humanize, money, qty } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export function ProductImage({ attachmentId, className = "h-24 w-24" }: { attachmentId: string | null; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!attachmentId) return;
    let revoked: string | null = null;
    fetch(`/api/v1/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } }).then(async (r) => { if (r.ok) { revoked = URL.createObjectURL(await r.blob()); setUrl(revoked); } });
    return () => { if (revoked) URL.revokeObjectURL(revoked); };
  }, [attachmentId]);
  return url ? <img src={url} alt="" className={`${className} rounded-md object-cover`} /> : <div className={`${className} flex items-center justify-center rounded-md bg-slate-100 text-slate-400`} aria-hidden><Package className="h-8 w-8" /></div>;
}

export default function ProductDetail() {
  const { id } = useParams();
  const { can, me } = useSession();
  const toast = useToast();
  const { data: p, isLoading, error, refetch } = useApi<any>(`/products/${id}`);
  const [editing, setEditing] = useState<any>(null);
  const [discontinue, setDiscontinue] = useState(false);
  const [uploadErr, setUploadErr] = useState<unknown>(null);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const branchName = (bid: string) => me?.branches.find((b) => b.id === bid)?.code ?? "Other branch";
  const upload = async (f: File) => {
    setUploadErr(null);
    const fd = new FormData(); fd.append("file", f);
    try { await api(`/attachments?owner_type=product&owner_id=${p.id}`, { body: fd }); toast("Image uploaded"); refetch(); } catch (e) { setUploadErr(e); }
  };
  return (
    <div className="space-y-5">
      <PageHeader title={p.name} subtitle={<>{p.code} · {humanize(p.product_type)} · base unit {p.base_unit_code} · <Status value={p.status} /></>} actions={can("products.manage") && p.status === "ACTIVE" && <Button variant="secondary" onClick={() => setDiscontinue(true)}>Discontinue</Button>} />
      <div className="grid gap-5 lg:grid-cols-[220px_1fr]">
        <Card>
          <ProductImage attachmentId={p.image_attachment_id} className="h-44 w-full" />
          {can("products.manage") && (
            <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 p-2 text-sm text-slate-600 hover:bg-slate-50">
              <ImagePlus className="h-4 w-4" /> Upload image<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </label>
          )}
          <ErrorText error={uploadErr} />
          <dl className="mt-4 space-y-1 text-sm">
            {p.track_batches && <div><Badge tone="blue">Batch{p.track_expiry ? " + expiry" : ""} tracked</Badge></div>}
            {p.track_serials && <div><Badge tone="violet">Serial tracked</Badge>{p.warranty_months && <span className="ml-1 text-xs text-slate-500">{p.warranty_months}-month warranty</span>}</div>}
          </dl>
        </Card>
        <Card title="Variants (SKUs)" padded={false}>
          <DataTable rows={p.variants} columns={[
            { key: "sku", header: "SKU", render: (v: any) => <div><div className="font-medium">{v.sku}</div><div className="text-xs text-slate-500">{v.name}</div>{v.attributes.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{v.attributes.map((a: any) => <Badge key={a.attribute}>{a.attribute}: {a.value}</Badge>)}</div>}</div> },
            { key: "price", header: "Prices", align: "right", render: (v: any) => <div className="text-xs"><div className="text-sm font-medium">{money(v.retail_price)}</div>{v.wholesale_price && <div>Wholesale {money(v.wholesale_price)}</div>}{v.min_price && <div className="text-amber-700">Min {money(v.min_price)}</div>}</div> },
            { key: "codes", header: "Barcodes / packaging", render: (v: any) => <div className="space-y-0.5 text-xs">{v.barcodes.map((b: any) => <div key={b.id} className="font-mono">{b.code}{Number(b.quantity) !== 1 && ` (= ${qty(b.quantity)} ${p.base_unit_code})`}</div>)}{v.unit_conversions.map((c: any) => <div key={c.id}>1 {c.unit_code} = {qty(c.factor)} {p.base_unit_code}{c.is_sellable ? " · sellable" : ""}</div>)}</div> },
            { key: "stock", header: "On hand by branch", render: (v: any) => <div className="text-xs">{v.stock.length ? v.stock.map((s: any) => <div key={s.branch_id}>{branchName(s.branch_id)}: <span className="num">{qty(s.on_hand)}</span></div>) : "—"}</div> },
            ...(p.can_view_cost ? [{ key: "cost", header: "Avg cost", align: "right" as const, render: (v: any) => <div className="text-xs">{v.costs.map((c: any) => <div key={c.branch_id}>{branchName(c.branch_id)}: {money(c.average_cost)}</div>)}</div> }] : []),
            { key: "reorder", header: "Reorder at", align: "right", render: (v: any) => qty(v.reorder_point) },
            { key: "a", header: "", align: "right", render: (v: any) => can("products.manage") && <Button size="sm" variant="secondary" onClick={() => setEditing(v)}>Edit</Button> },
          ]} />
        </Card>
      </div>
      {editing && <VariantEdit variant={editing} canPrice={can("prices.manage")} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refetch(); toast("Variant updated"); }} />}
      <ConfirmDialog open={discontinue} danger requireReason title="Discontinue product" message="Discontinued products cannot be sold or purchased. History is preserved." onClose={() => setDiscontinue(false)} onConfirm={async () => { await api(`/products/${p.id}`, { method: "PATCH", body: { status: "DISCONTINUED" } }); refetch(); }} />
    </div>
  );
}

function VariantEdit({ variant, canPrice, onClose, onSaved }: { variant: any; canPrice: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: variant.name, retail_price: variant.retail_price, wholesale_price: variant.wholesale_price ?? "", min_price: variant.min_price ?? "", reorder_point: variant.reorder_point, reorder_qty: variant.reorder_qty, is_shortcut: variant.is_shortcut });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    const body: any = { name: f.name, reorder_point: String(f.reorder_point), reorder_qty: String(f.reorder_qty), is_shortcut: f.is_shortcut };
    if (canPrice) Object.assign(body, { retail_price: String(f.retail_price), ...(f.wholesale_price ? { wholesale_price: String(f.wholesale_price) } : {}), ...(f.min_price ? { min_price: String(f.min_price) } : {}) });
    try { await api(`/variants/${variant.id}`, { method: "PATCH", body }); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  return (
    <Modal open onClose={onClose} title={`Edit ${variant.sku}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">{(id) => <Input id={id} value={f.name} onChange={set("name")} />}</Field>
        <Field label="Retail price" hint={canPrice ? undefined : "Requires prices.manage"}>{(id, d) => <Input id={id} aria-describedby={d} disabled={!canPrice} value={f.retail_price} onChange={set("retail_price")} />}</Field>
        <Field label="Wholesale price">{(id) => <Input id={id} disabled={!canPrice} value={f.wholesale_price} onChange={set("wholesale_price")} />}</Field>
        <Field label="Minimum price" hint="Selling below needs approval">{(id, d) => <Input id={id} aria-describedby={d} disabled={!canPrice} value={f.min_price} onChange={set("min_price")} />}</Field>
        <Field label="Reorder point">{(id) => <Input id={id} value={f.reorder_point} onChange={set("reorder_point")} />}</Field>
        <Field label="Reorder quantity">{(id) => <Input id={id} value={f.reorder_qty} onChange={set("reorder_qty")} />}</Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_shortcut} onChange={set("is_shortcut")} /> Show as POS shortcut</label>
      </div>
      <p className="mt-3 text-xs text-slate-500">Price changes are audited. Use price lists for branch prices and scheduled (effective-dated) changes. Past sales keep the price used at the time.</p>
      <ErrorText error={err} />
    </Modal>
  );
}
