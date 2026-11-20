import { CheckCircle2, Download, FileSpreadsheet, Sparkles, Upload } from "lucide-react";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Badge, Button, Card, DataTable, ErrorText, Field, PageHeader, Select, Tabs, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { downloadXlsx, readRows, SheetRow } from "../../lib/spreadsheet";
import { SAMPLE_CUSTOMERS, SAMPLE_SUPPLIERS } from "./sample-contacts";

type Kind = "products" | "stock" | "customers" | "suppliers";
interface RowResult { row: number; action: "create" | "update" | "skip"; label: string; errors: string[]; warnings: string[] }
interface ImportResult { dry_run: boolean; ok: boolean; created: number; updated: number; skipped: number; errors: number; rows: RowResult[]; opening_stock?: { number: string; lines: number; total: string } | null }

const TEMPLATES: Record<Kind, { columns: string[]; help: [string, string][] }> = {
  products: {
    columns: ["SKU", "Name", "Category", "Brand", "Unit", "Type", "Selling price", "Minimum price", "Wholesale price", "Bargain", "Barcode", "Reorder point", "Quantity", "Unit cost"],
    help: [
      ["SKU", "Your product code. Leave empty for new products to generate one from the name. Existing products are matched by SKU (or barcode, or exact name) and updated."],
      ["Name", "Required for new products."],
      ["Category", "Use > for sub-categories, e.g. Food staples > Rice & grains. Missing categories are created."],
      ["Brand", "Optional. Missing brands are created."],
      ["Unit", "Unit the item is counted and sold in: PCS, KG, L, M, BAG, BALE, HEAP… Missing units are created. Cannot be changed later by import."],
      ["Type", "standard (default), bulk (sold by quantity or weight, fractions allowed) or service (no stock)."],
      ["Selling price", "Price per unit. Leave empty to fill in later — the product cannot be sold until it has a price."],
      ["Minimum price", "Lowest allowed price. Required when Bargain is yes."],
      ["Wholesale price", "Optional."],
      ["Bargain", "yes / no — cashiers may bargain down to the minimum price, never below."],
      ["Barcode", "Optional. Must not belong to another product."],
      ["Reorder point", "Stock level that triggers a reorder suggestion."],
      ["Quantity", "Optional opening stock — only used if you choose a branch when importing."],
      ["Unit cost", "Purchase cost per unit for the opening stock (required with a quantity)."],
    ],
  },
  stock: {
    columns: ["SKU", "Barcode", "Name", "Quantity", "Unit cost", "Batch", "Expiry"],
    help: [
      ["SKU / Barcode / Name", "Identify the product by one of these (the exact name works if it is unique)."],
      ["Quantity", "Quantity to add to stock at the chosen branch (in the product's unit). It is ADDED to any stock already there."],
      ["Unit cost", "Purchase cost per unit — it values the stock in the accounts (Dr Inventory / Cr Opening balance equity)."],
      ["Batch", "Required only for batch-tracked products."],
      ["Expiry", "Optional, YYYY-MM-DD or DD/MM/YYYY."],
    ],
  },
  suppliers: {
    columns: ["Code", "Name", "Contact", "Phone", "Email", "Address", "Tax ID", "Payment terms (days)"],
    help: [
      ["Code", "Short supplier code. Leave empty to generate one from the name. Existing suppliers are matched by code, then by exact name, and updated."],
      ["Name", "Required for new suppliers."],
      ["Contact", "Person you deal with."],
      ["Tax ID", "Supplier's taxpayer number (NIU), if known."],
      ["Payment terms (days)", "0 = pay on delivery."],
    ],
  },
  customers: {
    columns: ["Name", "Phone", "Email", "Address", "Group", "Credit limit", "Payment terms (days)"],
    help: [
      ["Name", "Required for new customers."],
      ["Phone", "Existing customers are matched by phone number (then by exact name when there is no phone) and updated."],
      ["Group", "Must be an existing customer group (e.g. Retail, Resellers)."],
      ["Credit limit", "Optional. A limit above zero allows credit sales up to that amount."],
      ["Payment terms (days)", "Optional number of days to pay."],
    ],
  },
};

export default function ImportPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { key: "products", label: "Products & categories", hidden: !can("products.manage") },
    { key: "stock", label: "Opening stock", hidden: !can("inventory.opening") },
    { key: "customers", label: "Customers", hidden: !can("customers.manage") },
    { key: "suppliers", label: "Suppliers", hidden: !can("suppliers.manage") },
  ];
  const first = (tabs.find((t) => !t.hidden)?.key ?? "products") as Kind;
  const kind = ((params.get("type") as Kind) && !tabs.find((t) => t.key === params.get("type"))?.hidden ? params.get("type") : first) as Kind;
  return (
    <div>
      <PageHeader title="Import & export" subtitle="Bring in products, opening stock and customers from Excel or CSV — or download what you have, edit it and import it back" />
      <Tabs value={kind} onChange={(k) => setParams({ type: k })} tabs={tabs} />
      <div className="mt-4"><ImportPanel key={kind} kind={kind} /></div>
    </div>
  );
}

function ImportPanel({ kind }: { kind: Kind }) {
  const { me, branchId } = useSession();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<{ name: string; rows: SheetRow[] } | null>(null);
  const [branch, setBranch] = useState(kind === "stock" ? branchId ?? "" : "");
  const [plan, setPlan] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const stockBranches = me?.branches ?? [];
  const hasQty = kind === "products" && !!source?.rows.some((r) => Object.keys(r).some((k) => /^(quantity|qty|quantit|stock)/i.test(k) && r[k]));

  const body = (dry: boolean) => ({ rows: source!.rows, dry_run: dry, ...((kind === "products" || kind === "stock") && branch ? { branch_id: branch } : {}) });
  const check = async () => {
    if (!source) return;
    if (kind === "stock" && !branch) { setPlan(null); return; }
    setBusy("check"); setErr(null); setDone(null);
    try { setPlan(await api<ImportResult>(`/imports/${kind}`, { body: body(true) })); } catch (e) { setErr(e); setPlan(null); } finally { setBusy(null); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void check(); }, [source, branch]);

  const run = async () => {
    setBusy("import"); setErr(null);
    try {
      const r = await api<ImportResult>(`/imports/${kind}`, { body: body(false) });
      setDone(r); setPlan(null); setSource(null);
      toast(`Imported: ${r.created} new, ${r.updated} updated${r.opening_stock ? ` — opening stock ${r.opening_stock.number}` : ""}`);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = "";
    if (!f) return;
    setErr(null); setDone(null); setPlan(null);
    try {
      const rows = await readRows(f);
      if (!rows.length) throw new Error("The file has no data rows under the header row.");
      setSource({ name: f.name, rows });
    } catch (e2) { setErr(e2); setSource(null); }
  };
  const download = async (what: "template" | "current") => {
    setBusy(what); setErr(null);
    try {
      const t = TEMPLATES[kind];
      if (what === "template") await downloadXlsx(`${kind}-template.xlsx`, t.columns, [], t.help);
      else {
        const rows = await api<Record<string, string>[]>(`/imports/${kind}/export`);
        await downloadXlsx(`${kind}-${new Date().toISOString().slice(0, 10)}.xlsx`, rows.length ? Object.keys(rows[0]) : t.columns, rows, kind === "products" ? t.help : undefined);
      }
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };

  const shown = useMemo(() => (plan?.rows ?? []).filter((r) => r.action !== "skip" && (!onlyProblems || r.errors.length || r.warnings.length)), [plan, onlyProblems]);
  const label = kind === "products" ? "products" : kind === "stock" ? "stock lines" : kind;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Get a spreadsheet">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={busy === "template"} onClick={() => download("template")}>Blank template</Button>
            {kind !== "stock" && <Button variant="secondary" icon={<FileSpreadsheet className="h-4 w-4" />} loading={busy === "current"} onClick={() => download("current")}>Download current {kind}</Button>}
          </div>
          <p className="mt-3 text-sm text-slate-600">
            {kind === "products" && "Fill in the template, or download your current products, change names, prices or categories in Excel and import the file back — rows are matched by SKU, so they update instead of duplicating."}
            {kind === "stock" && "List each product with the quantity you have and what it cost you. Use this once when you start, to load the stock already on your shelves."}
            {kind === "customers" && "Fill in the template or download your current customer list, edit it in Excel and import it back — customers are matched by phone number."}
            {kind === "suppliers" && "Fill in the template or download your current suppliers, edit them in Excel and import the file back — suppliers are matched by code (or exact name)."}
          </p>
          {(kind === "customers" || kind === "suppliers") && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-center gap-2 font-medium text-emerald-900"><Sparkles className="h-4 w-4" /> Sample {kind}</div>
              <p className="mt-1 text-sm text-emerald-900">{kind === "customers" ? SAMPLE_CUSTOMERS.length : SAMPLE_SUPPLIERS.length} example {kind} marked “(sample)”, without phone numbers. Load them, then rename them into real contacts or delete them — unused contacts can be deleted any time.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => { setDone(null); setSource({ name: `Sample ${kind}`, rows: kind === "customers" ? SAMPLE_CUSTOMERS : SAMPLE_SUPPLIERS }); }}>Use the sample {kind}</Button>
              </div>
            </div>
          )}
          {kind === "products" && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
              <div className="flex items-center gap-2 font-medium text-emerald-900"><Sparkles className="h-4 w-4" /> Your stock list is built in</div>
              <p className="mt-1 text-sm text-emerald-900">The shop's 599 products in 13 categories are already in the catalogue. Set their buying and selling prices and post the counted quantities on <Link className="font-medium underline" to="/starting-stock">Starting stock</Link>; manage categories (and re-add deleted items) in <Link className="font-medium underline" to="/products/setup">Catalogue setup</Link>. Use this page for products that are not in the list, or to update many at once in Excel.</p>
            </div>
          )}
        </Card>
        <Card title="2. Choose the file and check it">
          <input ref={fileRef} type="file" accept=".xlsx,.csv,.txt" className="hidden" onChange={onFile} aria-label="Spreadsheet file" />
          <Button icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Choose Excel or CSV file…</Button>
          {source && <p className="mt-2 text-sm text-slate-700"><b>{source.name}</b> — {source.rows.length} row(s)</p>}
          {(kind === "products" || kind === "stock") && (
            <Field label={kind === "stock" ? "Branch receiving the stock" : "Opening stock branch (optional)"} hint={kind === "products" ? (hasQty ? "Your file has quantities: choose a branch to load them as opening stock, or leave empty to ignore them" : "Only needed if your file has Quantity and Unit cost columns") : "Quantities are added to this branch's main sales floor"} className="mt-3 max-w-sm">
              {(id, d) => <Select id={id} aria-describedby={d} value={branch} onChange={(e) => setBranch(e.target.value)}>
                <option value="">{kind === "stock" ? "Choose a branch…" : "— Don't import stock —"}</option>
                {stockBranches.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}
              </Select>}
            </Field>
          )}
          <p className="mt-3 text-xs text-slate-500">Nothing is saved until you press Import. If any row has a problem, nothing is imported — fix the file and choose it again.</p>
        </Card>
      </div>
      <ErrorText error={err} />

      {busy === "check" && <p className="text-sm text-slate-500">Checking the file…</p>}
      {plan && (
        <Card title="3. Review and import" actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only rows with problems</label>}>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="green">{plan.rows.filter((r) => r.action === "create" && !r.errors.length).length} new</Badge>
            <Badge tone="blue">{plan.rows.filter((r) => r.action === "update" && !r.errors.length).length} to update</Badge>
            {plan.errors > 0 && <Badge tone="red">{plan.errors} with errors</Badge>}
            {plan.rows.some((r) => r.warnings.length) && <Badge tone="amber">{plan.rows.filter((r) => r.warnings.length).length} with warnings</Badge>}
            <div className="ml-auto">
              <Button disabled={!plan.ok || busy != null} loading={busy === "import"} onClick={run} icon={<CheckCircle2 className="h-4 w-4" />}>
                {plan.ok ? `Import ${plan.rows.filter((r) => r.action !== "skip").length} ${label}` : "Fix the errors to import"}
              </Button>
            </div>
          </div>
          <DataTable rows={shown} empty="No rows to show" columns={[
            { key: "row", header: "Row", render: (r) => <span className="text-slate-500">{r.row}</span> },
            { key: "label", header: "Item", render: (r) => <span className="font-medium">{r.label || "—"}</span> },
            { key: "action", header: "Action", render: (r) => r.errors.length ? <Badge tone="red">Error</Badge> : r.action === "create" ? <Badge tone="green">New</Badge> : <Badge tone="blue">Update</Badge> },
            { key: "notes", header: "Notes", render: (r) => <div className="space-y-0.5 text-sm">{r.errors.map((m, i) => <div key={i} className="text-red-700">{m}</div>)}{r.warnings.map((m, i) => <div key={`w${i}`} className="text-amber-700">{m}</div>)}</div> },
          ]} />
        </Card>
      )}

      {done && (
        <Card>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-6 w-6 text-emerald-600" />
            <div className="text-sm">
              <div className="text-base font-semibold">Import complete</div>
              <p>{done.created} new and {done.updated} updated {label}.{done.opening_stock && <> Opening stock document <b>{done.opening_stock.number}</b>: {done.opening_stock.lines} line(s), value {Number(done.opening_stock.total).toLocaleString()}.</>}</p>
              <p className="mt-1">
                {kind === "products" && <Link className="text-brand-700 hover:underline" to="/products">Go to Products</Link>}
                {kind === "stock" && <Link className="text-brand-700 hover:underline" to="/inventory">Go to Inventory</Link>}
                {kind === "customers" && <Link className="text-brand-700 hover:underline" to="/customers">Go to Customers</Link>}
                {kind === "suppliers" && <Link className="text-brand-700 hover:underline" to="/purchasing?tab=suppliers">Go to Suppliers</Link>}
              </p>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
