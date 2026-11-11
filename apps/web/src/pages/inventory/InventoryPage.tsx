import { Plus } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useApprovalFlow } from "../../components/approval";
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, SearchInput, Select, Status, Tabs, Textarea, useToast } from "../../components/ui";
import { api, qs } from "../../lib/api";
import { date, dateTime, humanize, money, qty } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function InventoryPage() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get("low") ? "reorder" : "stock");
  return (
    <div>
      <PageHeader title="Inventory" subtitle="Stock is tracked per variant, location and batch. Quantities are in base units." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: "stock", label: "Stock levels" }, { key: "movements", label: "Movements" }, { key: "reorder", label: "Reorder" }, { key: "transfers", label: "Transfers" },
        { key: "counts", label: "Counts" }, { key: "adjustments", label: "Adjustments" }, { key: "expiry", label: "Expiry" },
      ]} />
      {tab === "stock" && <StockTab initialSearch={params.get("search") ?? ""} />}
      {tab === "movements" && <MovementsTab />}
      {tab === "reorder" && <ReorderTab />}
      {tab === "transfers" && <TransfersTab />}
      {tab === "counts" && <CountsTab />}
      {tab === "adjustments" && <AdjustmentsTab />}
      {tab === "expiry" && <ExpiryTab />}
    </div>
  );
}

function StockTab({ initialSearch }: { initialSearch: string }) {
  const { branchId, can } = useSession();
  const [lowOnly, setLowOnly] = useState(false);
  const list = useList<any>(branchId ? "/inventory/balances" : null, { branch_id: branchId, low_only: lowOnly ? "true" : undefined }, { pageSize: 50, search: initialSearch });
  const showCost = can("products.view_cost");
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-3">
        <SearchInput value={list.search} onChange={list.setSearch} placeholder="Search SKU or name" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={lowOnly} onChange={(e) => { setLowOnly(e.target.checked); list.setPage(1); }} /> Low stock only</label>
      </div>
      <DataTable rowKey="variant_id" rows={list.data?.items} loading={list.isLoading} error={list.error} onRetry={list.refetch} columns={[
        { key: "sku", header: "SKU", render: (r) => <div><div className="font-medium">{r.sku}</div><div className="text-xs text-slate-500">{r.name}</div></div> },
        { key: "category_name", header: "Category" },
        { key: "on_hand", header: "On hand", align: "right", render: (r) => qty(r.on_hand) },
        { key: "reserved", header: "Reserved", align: "right", render: (r) => qty(r.reserved) },
        { key: "quarantined", header: "Quarantine/damaged", align: "right", render: (r) => (Number(r.quarantined) ? <span className="text-amber-700">{qty(r.quarantined)}</span> : "0") },
        { key: "available", header: "Available", align: "right", render: (r) => <span className={r.low ? "font-semibold text-red-600" : "font-semibold"}>{qty(r.available)}</span> },
        { key: "in_transit", header: "In transit", align: "right", render: (r) => qty(r.in_transit) },
        { key: "reorder_point", header: "Reorder at", align: "right", render: (r) => qty(r.reorder_point) },
        ...(showCost ? [{ key: "average_cost", header: "Avg cost", align: "right" as const, render: (r: any) => money(r.average_cost) }, { key: "stock_value", header: "Value", align: "right" as const, render: (r: any) => money(r.stock_value) }] : []),
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
    </Card>
  );
}

function MovementsTab() {
  const { branchId, can } = useSession();
  const [type, setType] = useState("");
  const list = useList<any>("/inventory/movements", { branch_id: branchId, movement_type: type }, { pageSize: 50 });
  return (
    <Card padded={false}>
      <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
        <SearchInput value={list.search} onChange={list.setSearch} placeholder="Document number" />
        <Select aria-label="Movement type" className="w-56" value={type} onChange={(e) => setType(e.target.value)}><option value="">All movement types</option>{["OPENING_BALANCE", "PURCHASE_RECEIPT", "SALE", "CUSTOMER_RETURN", "TRANSFER_OUT", "TRANSFER_IN", "COUNT_ADJUSTMENT", "ADJUSTMENT", "DAMAGE", "EXPIRY", "RELOCATION"].map((t) => <option key={t} value={t}>{humanize(t)}</option>)}</Select>
      </div>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} columns={[
        { key: "occurred_at", header: "When", render: (m) => dateTime(m.occurred_at) },
        { key: "type", header: "Type", render: (m) => <Badge>{humanize(m.movement_type)}</Badge> },
        { key: "doc", header: "Document", render: (m) => m.document_number ?? "—" },
        { key: "sku", header: "SKU", render: (m) => <div><div className="font-medium">{m.sku}</div><div className="text-xs text-slate-500">{m.location}{m.batch && ` · batch ${m.batch.batch_number}`}</div></div> },
        { key: "quantity", header: "Qty", align: "right", render: (m) => <span className={Number(m.quantity) < 0 ? "text-red-600" : "text-emerald-700"}>{Number(m.quantity) > 0 ? "+" : ""}{qty(m.quantity)}</span> },
        ...(can("products.view_cost") ? [{ key: "value", header: "Value", align: "right" as const, render: (m: any) => money(m.value) }, { key: "unit_cost", header: "Unit cost", align: "right" as const, render: (m: any) => money(m.unit_cost) }] : []),
        { key: "reason", header: "Reason", render: (m) => <span className="text-xs">{m.reason ?? ""}</span> },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
    </Card>
  );
}

function ReorderTab() {
  const { branchId } = useSession();
  const q = useApi<any[]>(branchId ? `/inventory/reorder-suggestions?branch_id=${branchId}` : null, [branchId]);
  return (
    <Card title="Reorder suggestions" padded={false} actions={<span className="text-xs text-slate-500">Available ≤ reorder point. Suggested = reorder quantity (or 2× reorder point minus available and in transit).</span>}>
      <DataTable rowKey="variant_id" rows={q.data} loading={q.isLoading} error={q.error} empty={<p className="p-8 text-center text-sm text-slate-500">No items at or below their reorder point.</p>} columns={[
        { key: "sku", header: "SKU", render: (r) => <div><div className="font-medium">{r.sku}</div><div className="text-xs text-slate-500">{r.name}</div></div> },
        { key: "available", header: "Available", align: "right", render: (r) => qty(r.available) },
        { key: "in_transit", header: "In transit", align: "right", render: (r) => qty(r.in_transit) },
        { key: "reorder_point", header: "Reorder point", align: "right", render: (r) => qty(r.reorder_point) },
        { key: "suggested_qty", header: "Suggested", align: "right", render: (r) => <strong>{qty(r.suggested_qty)}</strong> },
        { key: "preferred_supplier_name", header: "Preferred supplier", render: (r) => r.preferred_supplier_name ?? "—" },
      ]} />
    </Card>
  );
}

function TransfersTab() {
  const { can, me } = useSession();
  const toast = useToast();
  const list = useList<any>("/inventory/transfers");
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<any>(null);
  const branch = (id: string) => me?.branches.find((b) => b.id === id)?.code ?? "—";
  const act = async (path: string, body: any = {}) => { try { await api(path, { body, idempotent: true }); toast("Transfer updated"); list.refetch(); } catch (e) { toast((e as Error).message, "error"); } };
  return (
    <Card padded={false} title="Stock transfers" actions={can("inventory.transfer") && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New transfer</Button>}>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} columns={[
        { key: "number", header: "Transfer", render: (t) => <div><div className="font-medium">{t.number}</div><div className="text-xs text-slate-500">{dateTime(t.created_at)}</div></div> },
        { key: "route", header: "Route", render: (t) => `${branch(t.from_branch_id)} → ${branch(t.to_branch_id)}` },
        { key: "lines", header: "Items", render: (t) => <div className="text-xs">{t.lines.map((l: any) => <div key={l.id}>{l.sku}: {qty(l.qty_requested)} req · {qty(l.qty_dispatched)} sent · {qty(l.qty_received)} recv{Number(l.qty_short) > 0 && <span className="text-red-600"> · {qty(l.qty_short)} short</span>}</div>)}</div> },
        { key: "status", header: "Status", render: (t) => <Status value={t.status} /> },
        { key: "a", header: "", align: "right", render: (t) => can("inventory.transfer") && (
          <div className="flex justify-end gap-2">
            {t.status === "DRAFT" && <Button size="sm" variant="secondary" onClick={() => act(`/inventory/transfers/${t.id}/approve`)}>Approve</Button>}
            {t.status === "APPROVED" && <Button size="sm" onClick={() => act(`/inventory/transfers/${t.id}/dispatch`)}>Dispatch</Button>}
            {["DISPATCHED", "PARTIALLY_RECEIVED"].includes(t.status) && <Button size="sm" onClick={() => setReceiving(t)}>Receive</Button>}
          </div>
        ) },
      ]} />
      {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      {creating && <NewTransfer onClose={() => setCreating(false)} onDone={() => { setCreating(false); list.refetch(); }} />}
      {receiving && <ReceiveTransfer transfer={receiving} onClose={() => setReceiving(null)} onDone={() => { setReceiving(null); list.refetch(); }} />}
    </Card>
  );
}

function VariantPicker({ onPick, branchId }: { onPick: (v: any) => void; branchId: string }) {
  const [s, setS] = useState("");
  const res = useApi<any[]>(s.length >= 2 ? `/catalogue/sellables${qs({ branch_id: branchId, search: s })}` : null, [s]);
  return (
    <div className="relative">
      <Input aria-label="Find product" placeholder="Search product to add…" value={s} onChange={(e) => setS(e.target.value)} />
      {res.data && s.length >= 2 && (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {res.data.filter((r) => r.product_type !== "NON_STOCK").map((r) => <li key={r.variant_id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50" onClick={() => { onPick(r); setS(""); }}>{r.sku} — {r.name} <span className="text-slate-500">({qty(r.available)} avail.)</span></button></li>)}
        </ul>
      )}
    </div>
  );
}

function NewTransfer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { me, branchId } = useSession();
  const locs = useApi<any[]>("/inventory/locations");
  const [fromBranch, setFromBranch] = useState(branchId ?? "");
  const [toBranch, setToBranch] = useState("");
  const [lines, setLines] = useState<{ v: any; quantity: string }[]>([]);
  const [notes, setNotes] = useState("");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const defLoc = (b: string) => locs.data?.find((l) => l.branch_id === b && l.is_default)?.id;
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api("/inventory/transfers", { body: { from_branch_id: fromBranch, from_location_id: defLoc(fromBranch), to_branch_id: toBranch, to_location_id: defLoc(toBranch), notes: notes || undefined, lines: lines.map((l) => ({ variant_id: l.v.variant_id, quantity: l.quantity })) } }); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New stock transfer" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!toBranch || !lines.length} onClick={submit}>Create draft</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From branch">{(id) => <Select id={id} value={fromBranch} onChange={(e) => setFromBranch(e.target.value)}>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}</Select>}</Field>
          <Field label="To branch">{(id) => <Select id={id} value={toBranch} onChange={(e) => setToBranch(e.target.value)}><option value="">Select…</option>{locs.data && [...new Set(locs.data.map((l) => l.branch_id))].filter((b) => b !== fromBranch).map((b) => <option key={b} value={b}>{me?.branches.find((x) => x.id === b)?.name ?? b}</option>)}</Select>}</Field>
        </div>
        <VariantPicker branchId={fromBranch} onPick={(v) => setLines([...lines, { v, quantity: "1" }])} />
        {lines.map((l, i) => <div key={i} className="flex items-center gap-2 text-sm"><span className="flex-1">{l.v.sku} — {l.v.name}</span><Input aria-label="Quantity" className="h-8 w-24" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} /><Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button></div>)}
        <Field label="Notes">{(id) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function ReceiveTransfer({ transfer, onClose, onDone }: { transfer: any; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, { recv: string; short: string; note: string }>>(Object.fromEntries(transfer.lines.map((l: any) => [l.id, { recv: String(l.in_transit), short: "0", note: "" }])));
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (close: boolean) => {
    setBusy(true); setErr(null);
    try { await api(`/inventory/transfers/${transfer.id}/receive`, { idempotent: true, body: { close, lines: Object.entries(rows).map(([line_id, r]) => ({ line_id, qty_received: r.recv || "0", qty_short: r.short || "0", note: r.note || undefined })) } }); onDone(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Receive ${transfer.number}`} size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="secondary" loading={busy} onClick={() => submit(false)}>Receive (keep open)</Button><Button loading={busy} onClick={() => submit(true)}>Receive and close</Button></>}>
      <p className="mb-3 text-sm text-slate-600">Enter what arrived. Leave the remainder in transit for a later delivery, or record it as short (written off as a loss) with an explanation.</p>
      {transfer.lines.map((l: any) => (
        <div key={l.id} className="mb-2 grid items-end gap-2 sm:grid-cols-[1fr_100px_100px_1fr]">
          <div className="text-sm"><div className="font-medium">{l.sku}</div><div className="text-xs text-slate-500">{qty(l.in_transit)} in transit</div></div>
          <Field label="Received">{(id) => <Input id={id} value={rows[l.id].recv} onChange={(e) => setRows({ ...rows, [l.id]: { ...rows[l.id], recv: e.target.value } })} />}</Field>
          <Field label="Short">{(id) => <Input id={id} value={rows[l.id].short} onChange={(e) => setRows({ ...rows, [l.id]: { ...rows[l.id], short: e.target.value } })} />}</Field>
          <Field label="Discrepancy note">{(id) => <Input id={id} value={rows[l.id].note} onChange={(e) => setRows({ ...rows, [l.id]: { ...rows[l.id], note: e.target.value } })} />}</Field>
        </div>
      ))}
      <ErrorText error={err} />
    </Modal>
  );
}

function CountsTab() {
  const { can, branchId } = useSession();
  const toast = useToast();
  const list = useList<any>("/inventory/counts");
  const locs = useApi<any[]>(branchId ? `/inventory/locations?branch_id=${branchId}` : null, [branchId]);
  const [open, setOpen] = useState<string | null>(null);
  const [loc, setLoc] = useState("");
  const start = async () => { try { const c = await api("/inventory/counts", { body: { branch_id: branchId, location_id: loc } }); setOpen(c.id); list.refetch(); } catch (e) { toast((e as Error).message, "error"); } };
  return (
    <Card padded={false} title="Physical counts" actions={can("inventory.count") && <div className="flex gap-2"><Select aria-label="Location" className="h-8 w-48" value={loc} onChange={(e) => setLoc(e.target.value)}><option value="">Location…</option>{locs.data?.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}</Select><Button size="sm" disabled={!loc} onClick={start}>Start count</Button></div>}>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRowClick={(c) => setOpen(c.id)} columns={[
        { key: "number", header: "Count" }, { key: "created_at", header: "Started", render: (c) => dateTime(c.created_at) }, { key: "status", header: "Status", render: (c) => <Status value={c.status} /> },
      ]} />
      {open && <CountSheet id={open} onClose={() => { setOpen(null); list.refetch(); }} />}
    </Card>
  );
}

function CountSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const c = useApi<any>(`/inventory/counts/${id}`);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [blind, setBlind] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const run = async (fn: () => Promise<any>, msg: string) => { setErr(null); try { await fn(); toast(msg); c.refetch(); } catch (e) { setErr(e); } };
  if (!c.data) return null;
  const editable = c.data.status === "COUNTING";
  return (
    <Modal open onClose={onClose} title={`Count ${c.data.number}`} size="lg" footer={<>
      {editable && <Button variant="secondary" onClick={() => run(() => api(`/inventory/counts/${id}/lines`, { body: { counts: Object.entries(counts).map(([variant_id, counted_qty]) => ({ variant_id, counted_qty })) } }), "Counts saved")}>Save counts</Button>}
      {editable && <Button onClick={() => run(() => api(`/inventory/counts/${id}/submit`, { method: "POST" }), "Count submitted")}>Submit</Button>}
      {c.data.status === "APPROVED" && can("inventory.count") && <Button onClick={() => run(() => api(`/inventory/counts/${id}/post`, { method: "POST", idempotent: true }), "Count posted")}>Post variances</Button>}
    </>}>
      <div className="mb-3 flex items-center justify-between text-sm"><Status value={c.data.status} />{editable && <label className="flex items-center gap-2"><input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> Blind count (hide system quantity)</label>}</div>
      {c.data.status === "SUBMITTED" && <p className="mb-3 rounded-md bg-amber-50 p-2 text-sm text-amber-900">Variances exceed the approval threshold. An approver must approve the request under Approvals before posting.</p>}
      <DataTable rowKey="variant_id" rows={c.data.lines} columns={[
        { key: "sku", header: "SKU", render: (l: any) => <div><div className="font-medium">{l.sku}</div><div className="text-xs text-slate-500">{l.variant_name}</div></div> },
        ...(!editable || !blind ? [{ key: "system_qty", header: "System", align: "right" as const, render: (l: any) => qty(l.system_qty) }] : []),
        { key: "counted", header: "Counted", align: "right", render: (l: any) => editable ? <Input aria-label={`Counted ${l.sku}`} className="ml-auto h-8 w-24 text-right" value={counts[l.variant_id] ?? l.counted_qty ?? ""} onChange={(e) => setCounts({ ...counts, [l.variant_id]: e.target.value })} /> : qty(l.counted_qty) },
        ...(!editable ? [{ key: "variance_qty", header: "Variance", align: "right" as const, render: (l: any) => <span className={Number(l.variance_qty) ? "text-amber-700" : ""}>{qty(l.variance_qty)}</span> }, ...(l0(c.data) ? [{ key: "variance_value", header: "Value", align: "right" as const, render: (l: any) => money(l.variance_value) }] : [])] : []),
      ]} />
      <ErrorText error={err} />
    </Modal>
  );
}
const l0 = (c: any) => c.lines.some((l: any) => l.variance_value !== undefined);

function AdjustmentsTab() {
  const { can, branchId } = useSession();
  const list = useList<any>("/inventory/adjustments");
  const [open, setOpen] = useState(false);
  return (
    <Card padded={false} title="Adjustments and write-offs" actions={can("inventory.adjust") && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>New adjustment</Button>}>
      <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} columns={[
        { key: "number", header: "Number" }, { key: "created_at", header: "Date", render: (a) => dateTime(a.created_at) }, { key: "reason_code", header: "Type", render: (a) => <Badge>{humanize(a.reason_code)}</Badge> },
        { key: "reason", header: "Reason" }, { key: "lines", header: "Lines", align: "right", render: (a) => a.lines.length },
        ...(can("products.view_cost") ? [{ key: "total_value", header: "Net value", align: "right" as const, render: (a: any) => money(a.total_value) }] : []),
        { key: "status", header: "Status", render: (a) => <Status value={a.status} /> },
      ]} />
      {open && <AdjustmentForm branchId={branchId!} onClose={() => setOpen(false)} onDone={() => { setOpen(false); list.refetch(); }} />}
    </Card>
  );
}

function AdjustmentForm({ branchId, onClose, onDone }: { branchId: string; onClose: () => void; onDone: () => void }) {
  const locs = useApi<any[]>(`/inventory/locations?branch_id=${branchId}`);
  const [code, setCode] = useState("DAMAGE"); const [reason, setReason] = useState("");
  const [lines, setLines] = useState<{ v: any; location_id: string; quantity: string }[]>([]);
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const approvals = useApprovalFlow();
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await approvals.run((approvalId) => api("/inventory/adjustments", { idempotent: true, body: { branch_id: branchId, reason_code: code, reason, approval_request_id: approvalId, lines: lines.map((l) => ({ variant_id: l.v.variant_id, location_id: l.location_id, quantity: l.quantity })) } }), reason);
      if (r) onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Stock adjustment" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!lines.length || reason.trim().length < 3} onClick={submit}>Post adjustment</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Type">{(id) => <Select id={id} value={code} onChange={(e) => setCode(e.target.value)}>{["DAMAGE", "EXPIRY", "LOSS", "FOUND", "CORRECTION"].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select>}</Field>
          <Field label="Reason" required>{(id) => <Textarea id={id} rows={1} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
        <VariantPicker branchId={branchId} onPick={(v) => setLines([...lines, { v, location_id: locs.data?.find((l) => l.is_default)?.id ?? "", quantity: code === "FOUND" ? "1" : "-1" }])} />
        {lines.map((l, i) => (
          <div key={i} className="grid items-center gap-2 text-sm sm:grid-cols-[1fr_180px_100px_auto]">
            <span>{l.v.sku} — {l.v.name}</span>
            <Select aria-label="Location" className="h-8" value={l.location_id} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, location_id: e.target.value } : x)))}>{locs.data?.map((loc) => <option key={loc.id} value={loc.id}>{loc.code}</option>)}</Select>
            <Input aria-label="Quantity (negative removes)" className="h-8" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Button size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <p className="text-xs text-slate-500">Negative quantities remove stock at average cost; positive (found) stock enters at the current average cost. Adjustments above the value threshold need approval.</p>
        <ErrorText error={err} />
      </div>
      {approvals.dialog(branchId)}
    </Modal>
  );
}

function ExpiryTab() {
  const { branchId } = useSession();
  const [days, setDays] = useState("60");
  const q = useApi<any[]>(branchId ? `/inventory/expiring${qs({ branch_id: branchId, days })}` : null, [branchId, days]);
  return (
    <Card padded={false} title="Expiring and expired batches" actions={<Select aria-label="Horizon" className="h-8 w-36" value={days} onChange={(e) => setDays(e.target.value)}>{["30", "60", "90", "180"].map((d) => <option key={d} value={d}>Next {d} days</option>)}</Select>}>
      <DataTable rowKey="batch_id" rows={q.data} loading={q.isLoading} error={q.error} columns={[
        { key: "sku", header: "SKU", render: (r) => <div><div className="font-medium">{r.sku}</div><div className="text-xs text-slate-500">{r.name}</div></div> },
        { key: "batch_number", header: "Batch" }, { key: "location", header: "Location" },
        { key: "expiry_date", header: "Expiry", render: (r) => date(r.expiry_date) },
        { key: "days_to_expiry", header: "Days left", align: "right", render: (r) => <span className={r.days_to_expiry < 0 ? "font-semibold text-red-600" : r.days_to_expiry <= 30 ? "text-amber-700" : ""}>{r.days_to_expiry < 0 ? "Expired" : r.days_to_expiry}</span> },
        { key: "qty_on_hand", header: "On hand", align: "right", render: (r) => qty(r.qty_on_hand) },
      ]} />
      <p className="p-3 text-xs text-slate-500">Expired batches are excluded from POS picking automatically (FEFO). Write them off from the Adjustments tab with type “Expiry”.</p>
    </Card>
  );
}
