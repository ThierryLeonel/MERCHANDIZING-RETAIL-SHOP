import { Save } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Badge, Button, Card, DataTable, ErrorText, Input, PageHeader, Pagination, SearchInput, Select, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { money } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

interface Row { variant_id: string; sku: string; name: string; retail_price: string; min_price: string | null; category: string | null; category_active: boolean | null; unit: string; suggested_qty: string | null }
type Edit = { quantity?: string; unit_cost?: string; retail_price?: string };

const PAGE = 50;
const num = (s?: string | null) => (s == null || s.trim() === "" ? null : Number(s.replace(/\s/g, "").replace(",", ".")));
const clean = (s?: string) => (s == null || s.trim() === "" ? null : s.replace(/\s/g, "").replace(",", "."));

/**
 * Starting stock: enter what is on the shelves with its buying price (and the selling price),
 * then post it as opening stock. The built-in catalogue pre-fills the counted quantities.
 */
export default function StartingStockPage() {
  const { branchId, me, can } = useSession();
  const toast = useToast();
  const q = useApi<Row[]>(branchId ? `/inventory/starting-stock?branch_id=${branchId}` : null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [show, setShow] = useState<"counted" | "all" | "restock">("counted");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const branch = me?.branches.find((b) => b.id === branchId);
  const canPrice = can("prices.manage");

  const rows = useMemo(() => q.data ?? [], [q.data]);
  const qtyOf = (r: Row) => edits[r.variant_id]?.quantity ?? r.suggested_qty ?? "";
  const categories = useMemo(() => [...new Set(rows.map((r) => r.category ?? "—"))].sort(), [rows]);
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      const qty = num(qtyOf(r));
      if (show === "counted" && !(qty && qty > 0)) return false;
      if (show === "restock" && qty && qty > 0) return false;
      if (category && (r.category ?? "—") !== category) return false;
      return !s || r.name.toLowerCase().includes(s) || r.sku.toLowerCase().includes(s);
    });
  }, [rows, edits, search, category, show]); // eslint-disable-line react-hooks/exhaustive-deps
  const pageRows = filtered.slice((page - 1) * PAGE, page * PAGE);

  // what Save will send
  const plan = useMemo(() => {
    const lines: { variant_id: string; quantity?: string; unit_cost?: string; retail_price?: string }[] = [];
    let value = 0, needCost = 0;
    for (const r of rows) {
      const e = edits[r.variant_id] ?? {};
      const qty = num(qtyOf(r)), cost = num(e.unit_cost), price = num(e.retail_price);
      const stock = qty != null && qty > 0 && cost != null && cost >= 0;
      if (qty && qty > 0 && cost == null) needCost++;
      if (stock || (price != null && canPrice)) {
        lines.push({ variant_id: r.variant_id, ...(stock ? { quantity: clean(qtyOf(r))!, unit_cost: clean(e.unit_cost)! } : {}), ...(price != null && canPrice ? { retail_price: clean(e.retail_price)! } : {}) });
        if (stock) value += qty! * cost!;
      }
    }
    return { lines, value, needCost, stocked: lines.filter((l) => l.quantity).length, priced: lines.filter((l) => l.retail_price).length };
  }, [rows, edits, canPrice]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (id: string, k: keyof Edit, v: string) => setEdits((p) => ({ ...p, [id]: { ...p[id], [k]: v } }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ opening_stock: { number: string; lines: number; total: string } | null; prices_set: number; location: string }>("/inventory/starting-stock", { body: { branch_id: branchId, lines: plan.lines } });
      toast([r.opening_stock && `${r.opening_stock.lines} products stocked (${r.opening_stock.number}, value ${money(r.opening_stock.total)})`, r.prices_set && `${r.prices_set} selling prices set`].filter(Boolean).join(" · ") || "Saved");
      const sent = new Set(plan.lines.map((l) => l.variant_id));
      setEdits((p) => Object.fromEntries(Object.entries(p).filter(([id]) => !sent.has(id))));
      await q.refetch();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div>
      <PageHeader title="Starting stock" subtitle={`What is on the shelves at ${branch?.name ?? "this branch"} when you start. Enter the buying price of each counted product (it values the stock) and its selling price, then save.`}
        actions={<Link to="/products/setup" className="text-sm font-medium text-brand-700 hover:underline">Categories & built-in catalogue</Link>} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div><span className="text-slate-500">Ready to stock:</span> <strong>{plan.stocked}</strong> products, value <strong className="num">{money(plan.value)}</strong></div>
          {canPrice && <div><span className="text-slate-500">Selling prices to set:</span> <strong>{plan.priced}</strong></div>}
          {plan.needCost > 0 && <div className="text-amber-700">{plan.needCost} counted products still need a buying price</div>}
          <div className="ml-auto"><Button icon={<Save className="h-4 w-4" />} loading={busy} disabled={!plan.lines.length} onClick={save}>Save starting stock</Button></div>
        </div>
        <ErrorText error={err} />
        <p className="mt-2 text-xs text-slate-500">Saved products leave this list (they now have stock); later changes go through purchases, counts and adjustments. Products with no quantity can still get a selling price here.</p>
      </Card>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-3">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search products" />
          <Select aria-label="Category" className="w-full sm:w-56" value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }}>
            <option value="">All categories</option>{categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Select aria-label="Show" className="w-full sm:w-56" value={show} onChange={(e) => { setShow(e.target.value as any); setPage(1); }}>
            <option value="counted">Counted products (quantity &gt; 0)</option>
            <option value="restock">To restock (no quantity)</option>
            <option value="all">All products not yet stocked</option>
          </Select>
          <span className="text-sm text-slate-500">{filtered.length} products</span>
        </div>
        <DataTable rowKey="variant_id" rows={pageRows} loading={q.isLoading} error={q.error} onRetry={q.refetch}
          empty={show === "counted" ? "No counted products waiting — everything counted is stocked. Choose “All products” to stock others." : "No products here."}
          columns={[
            { key: "name", header: "Product", render: (r: Row) => <div className="min-w-[12rem]"><div className="font-medium text-slate-900">{r.name}</div><div className="text-xs text-slate-500">{r.sku} · {r.category ?? "No category"}{r.category_active === false && <> · <Badge>Category inactive</Badge></>}</div></div> },
            { key: "unit", header: "Unit", render: (r: Row) => r.unit },
            { key: "qty", header: "Quantity", render: (r: Row) => <Input aria-label={`Quantity of ${r.name}`} inputMode="decimal" className="h-9 w-24" value={qtyOf(r)} onChange={(e) => set(r.variant_id, "quantity", e.target.value)} /> },
            { key: "cost", header: "Buying price (each)", render: (r: Row) => <Input aria-label={`Buying price of ${r.name}`} inputMode="decimal" className="h-9 w-32" placeholder="XAF" value={edits[r.variant_id]?.unit_cost ?? ""} onChange={(e) => set(r.variant_id, "unit_cost", e.target.value)} aria-invalid={!!(num(qtyOf(r)) && edits[r.variant_id]?.unit_cost === "")} /> },
            { key: "price", header: "Selling price", render: (r: Row) => canPrice
              ? <div className="flex items-center gap-2"><Input aria-label={`Selling price of ${r.name}`} inputMode="decimal" className="h-9 w-32" placeholder={Number(r.retail_price) > 0 ? String(Number(r.retail_price)) : "XAF"} value={edits[r.variant_id]?.retail_price ?? ""} onChange={(e) => set(r.variant_id, "retail_price", e.target.value)} />{Number(r.retail_price) <= 0 && !edits[r.variant_id]?.retail_price && <Badge tone="amber">Not set</Badge>}</div>
              : (Number(r.retail_price) > 0 ? money(r.retail_price) : <Badge tone="amber">Not set</Badge>) },
            { key: "value", header: "Value", align: "right", render: (r: Row) => { const v = (num(qtyOf(r)) ?? 0) * (num(edits[r.variant_id]?.unit_cost) ?? 0); return v ? money(v) : "—"; } },
          ]} />
        <Pagination page={page} pageSize={PAGE} total={filtered.length} onPage={setPage} />
      </Card>
    </div>
  );
}
