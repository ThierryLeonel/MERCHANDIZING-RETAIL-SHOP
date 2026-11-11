import { useState } from "react";
import { useNavigate } from "react-router";
import { Button, Card, DataTable, ErrorText, Field, Input, PageHeader, Select, Textarea, useToast } from "../../components/ui";
import { api, qs } from "../../lib/api";
import { money, qty, sumStrings, today } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function PurchaseOrderForm() {
  const { branchId, me } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const ref = useApi<any>("/catalogue/reference");
  const [branch, setBranch] = useState(branchId ?? "");
  const [supplier, setSupplier] = useState(""); const [expected, setExpected] = useState(""); const [payType, setPayType] = useState("CREDIT"); const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<{ v: any; unit_id: string; quantity: string; unit_cost: string }[]>([]);
  const [s, setS] = useState("");
  const res = useApi<any[]>(s.length >= 2 ? `/catalogue/sellables${qs({ branch_id: branch, search: s })}` : null, [s, branch]);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const units = ref.data?.units ?? [];
  const total = sumStrings(lines.map((l) => (Number(l.quantity || 0) * Number(l.unit_cost || 0)).toString()), 2);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const po = await api("/purchase-orders", { body: { branch_id: branch, supplier_id: supplier, expected_date: expected || undefined, payment_type: payType, notes: notes || undefined, lines: lines.map((l) => ({ variant_id: l.v.variant_id, unit_id: l.unit_id || undefined, quantity: l.quantity, unit_cost: l.unit_cost })) } });
      toast(`${po.number} created as draft`); nav(`/purchasing/orders/${po.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-5">
      <PageHeader title="New purchase order" actions={<><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button><Button loading={busy} disabled={!supplier || !lines.length} onClick={submit}>Save draft</Button></>} />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Deliver to branch">{(id) => <Select id={id} value={branch} onChange={(e) => setBranch(e.target.value)}>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}</Select>}</Field>
          <Field label="Supplier" required>{(id) => <Select id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">Select…</option>{ref.data?.suppliers.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}</Field>
          <Field label="Expected delivery">{(id) => <Input id={id} type="date" min={today()} value={expected} onChange={(e) => setExpected(e.target.value)} />}</Field>
          <Field label="Payment">{(id) => <Select id={id} value={payType} onChange={(e) => setPayType(e.target.value)}><option value="CREDIT">On credit</option><option value="CASH">Cash purchase</option></Select>}</Field>
          <Field label="Notes" className="md:col-span-4">{(id) => <Textarea id={id} rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        </div>
      </Card>
      <Card title="Lines" padded={false}>
        <div className="relative border-b border-slate-200 p-3">
          <Input aria-label="Add product" placeholder="Search product to add…" value={s} onChange={(e) => setS(e.target.value)} />
          {res.data && s.length >= 2 && (
            <ul className="absolute z-10 mt-1 max-h-56 w-[calc(100%-1.5rem)] overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
              {res.data.filter((r) => r.product_type !== "NON_STOCK").map((r) => <li key={r.variant_id}><button className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { setLines([...lines, { v: r, unit_id: "", quantity: "1", unit_cost: "" }]); setS(""); }}>{r.sku} — {r.name}</button></li>)}
            </ul>
          )}
        </div>
        <DataTable rows={lines.map((l, i) => ({ ...l, id: i }))} empty={<p className="p-6 text-center text-sm text-slate-500">Add products above.</p>} columns={[
          { key: "sku", header: "SKU", render: (l: any) => <div><div className="font-medium">{l.v.sku}</div><div className="text-xs text-slate-500">{l.v.name}</div></div> },
          { key: "unit", header: "Purchase unit", render: (l: any) => <Select aria-label="Unit" className="h-8 w-40" value={l.unit_id} onChange={(e) => setLines(lines.map((x, j) => (j === l.id ? { ...x, unit_id: e.target.value } : x)))}><option value="">{l.v.base_unit_code} (base)</option>{l.v.sell_units?.map((u: any) => <option key={u.unit_id} value={u.unit_id}>{u.unit_code} = {qty(u.factor)} {l.v.base_unit_code}</option>)}{units.filter((u: any) => !l.v.sell_units?.some((su: any) => su.unit_id === u.id) && u.code !== l.v.base_unit_code).length === 0 ? null : null}</Select> },
          { key: "q", header: "Quantity", render: (l: any) => <Input aria-label="Quantity" className="h-8 w-24" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === l.id ? { ...x, quantity: e.target.value } : x)))} /> },
          { key: "c", header: "Unit cost (excl. tax)", render: (l: any) => <Input aria-label="Unit cost" className="h-8 w-32" value={l.unit_cost} onChange={(e) => setLines(lines.map((x, j) => (j === l.id ? { ...x, unit_cost: e.target.value } : x)))} /> },
          { key: "t", header: "Line total", align: "right", render: (l: any) => money(Number(l.quantity || 0) * Number(l.unit_cost || 0)) },
          { key: "x", header: "", render: (l: any) => <Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== l.id))}>Remove</Button> },
        ]} />
        <div className="flex justify-end border-t border-slate-200 px-4 py-3 text-sm">Estimated total (excl. tax): <strong className="num ml-2">{money(total)}</strong></div>
      </Card>
      <ErrorText error={err} />
    </div>
  );
}
