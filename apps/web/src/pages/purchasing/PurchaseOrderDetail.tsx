import { useState } from "react";
import { Link, useParams } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorState, ErrorText, Input, Modal, PageHeader, Spinner, Status, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { date, dateTime, humanize, money, qty } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function PurchaseOrderDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const { data: po, isLoading, error, refetch } = useApi<any>(`/purchase-orders/${id}`);
  const [receiving, setReceiving] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "close" | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const submit = async () => { setErr(null); try { const r = await api(`/purchase-orders/${id}/submit`, { body: {} }); toast(r.status === "APPROVED" ? "Submitted and auto-approved (below threshold)" : "Submitted for approval"); refetch(); } catch (e) { setErr(e); } };
  return (
    <div className="space-y-5">
      <PageHeader title={`Purchase order ${po.number}`} subtitle={<>{po.supplier?.name} · ordered {date(po.order_date)}{po.expected_date && ` · expected ${date(po.expected_date)}`} · {humanize(po.payment_type)} purchase</>} actions={<>
        <Status value={po.status} />
        {po.status === "DRAFT" && can("purchasing.manage") && <Button onClick={submit}>Submit</Button>}
        {["APPROVED", "PARTIALLY_RECEIVED"].includes(po.status) && can("purchasing.receive") && <Button onClick={() => setReceiving(true)}>Receive goods</Button>}
        {["DRAFT", "SUBMITTED", "APPROVED"].includes(po.status) && po.receipt_status === "NOT_RECEIVED" && can("purchasing.manage") && <Button variant="secondary" onClick={() => setConfirm("cancel")}>Cancel</Button>}
        {["PARTIALLY_RECEIVED", "FULLY_RECEIVED"].includes(po.status) && can("purchasing.manage") && <Button variant="secondary" onClick={() => setConfirm("close")}>Close order</Button>}
      </>} />
      {po.approval && <div className="rounded-md bg-slate-100 p-3 text-sm">Approval {po.approval.number}: <Status value={po.approval.status} /> {po.approval.status === "PENDING" && <Link to="/approvals" className="ml-2 text-brand-700 hover:underline">Open approvals</Link>}</div>}
      <ErrorText error={err} />
      <Card title="Lines" padded={false}>
        <DataTable rows={po.lines} columns={[
          { key: "sku", header: "SKU", render: (l: any) => <div><div className="font-medium">{l.sku}</div><div className="text-xs text-slate-500">{l.variant_name}</div></div> },
          { key: "q", header: "Ordered", align: "right", render: (l: any) => <div>{qty(l.quantity)} {l.unit_code}<div className="text-xs text-slate-500">= {qty(l.quantity_base)} base</div></div> },
          { key: "c", header: "Unit cost", align: "right", render: (l: any) => money(l.unit_cost) },
          { key: "t", header: "Line total", align: "right", render: (l: any) => money(l.line_subtotal) },
          { key: "r", header: "Received (base)", align: "right", render: (l: any) => qty(l.received_base) },
          { key: "i", header: "Invoiced (base)", align: "right", render: (l: any) => qty(l.invoiced_base) },
        ]} />
        <div className="flex justify-end gap-6 border-t border-slate-200 px-4 py-3 text-sm"><span>Subtotal <strong className="num">{money(po.subtotal)}</strong></span><span>Tax <strong className="num">{money(po.tax_total)}</strong></span><span>Total <strong className="num">{money(po.total)}</strong></span></div>
      </Card>
      <Card title="Receipts" padded={false}>
        <DataTable rows={po.receipts} empty={<p className="p-6 text-center text-sm text-slate-500">Nothing received yet.</p>} columns={[
          { key: "number", header: "Receipt" }, { key: "received_at", header: "Received", render: (r: any) => dateTime(r.received_at) },
          { key: "supplier_reference", header: "Delivery note" }, { key: "total_value", header: "Value", align: "right", render: (r: any) => money(r.total_value) }, { key: "status", header: "Status", render: (r: any) => <Status value={r.status} /> },
        ]} />
      </Card>
      {receiving && <ReceiveModal po={po} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); refetch(); toast("Goods received and posted"); }} />}
      <ConfirmDialog open={!!confirm} requireReason danger={confirm === "cancel"} title={confirm === "cancel" ? "Cancel purchase order" : "Close purchase order"} message={confirm === "close" ? "Remaining unreceived quantities will not be delivered." : "The order will be cancelled."} onClose={() => setConfirm(null)} onConfirm={async (reason) => { await api(`/purchase-orders/${id}/${confirm}`, { body: { reason } }); refetch(); }} />
    </div>
  );
}

function ReceiveModal({ po, onClose, onDone }: { po: any; onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, any>>(Object.fromEntries(po.lines.map((l: any) => [l.id, { qty_accepted: String(Math.max(0, Number(l.remaining_base) / Number(l.unit_factor))), qty_damaged: "0", qty_rejected: "0", batch_number: "", expiry_date: "", serials: "" }])));
  const [ref, setRef] = useState("");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const set = (id: string, k: string, v: string) => setRows({ ...rows, [id]: { ...rows[id], [k]: v } });
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api("/goods-receipts", { idempotent: true, body: { branch_id: po.branch_id, purchase_order_id: po.id, supplier_reference: ref || undefined, lines: po.lines.map((l: any) => {
        const r = rows[l.id];
        return { purchase_order_line_id: l.id, variant_id: l.variant_id, qty_accepted: r.qty_accepted || "0", qty_damaged: r.qty_damaged || "0", qty_rejected: r.qty_rejected || "0", batch_number: r.batch_number || undefined, expiry_date: r.expiry_date || undefined, serial_numbers: r.serials ? r.serials.split(/[\s,]+/).filter(Boolean) : undefined };
      }).filter((x: any) => Number(x.qty_accepted) + Number(x.qty_damaged) + Number(x.qty_rejected) > 0) } });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Receive against ${po.number}`} size="xl" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={submit}>Post receipt</Button></>}>
      <div className="space-y-3">
        <div className="max-w-xs"><Input aria-label="Supplier delivery note reference" placeholder="Supplier delivery note no." value={ref} onChange={(e) => setRef(e.target.value)} /></div>
        <p className="text-xs text-slate-500">Quantities are in the purchase unit. Accepted goods go to the receiving location; damaged goods to the Damaged location (valued, pending claim); rejected goods are not taken into stock.</p>
        {po.lines.map((l: any) => (
          <div key={l.id} className="rounded-md border border-slate-200 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm"><strong>{l.sku}</strong><span className="text-slate-500">{l.variant_name}</span><Badge>{l.unit_code} ×{qty(l.unit_factor)}</Badge><span className="text-xs text-slate-500">remaining {qty(Number(l.remaining_base) / Number(l.unit_factor))} {l.unit_code}</span></div>
            <div className="grid gap-2 sm:grid-cols-6">
              {(["qty_accepted", "qty_damaged", "qty_rejected"] as const).map((k) => <label key={k} className="text-xs text-slate-600">{humanize(k.replace("qty_", ""))}<Input className="mt-1 h-8" value={rows[l.id][k]} onChange={(e) => set(l.id, k, e.target.value)} /></label>)}
              {l.tracking?.track_batches && <label className="text-xs text-slate-600">Batch no.<Input className="mt-1 h-8" value={rows[l.id].batch_number} onChange={(e) => set(l.id, "batch_number", e.target.value)} /></label>}
              {l.tracking?.track_expiry && <label className="text-xs text-slate-600">Expiry<Input type="date" className="mt-1 h-8" value={rows[l.id].expiry_date} onChange={(e) => set(l.id, "expiry_date", e.target.value)} /></label>}
              {l.tracking?.track_serials && <label className="text-xs text-slate-600 sm:col-span-3">Serial numbers (space or comma separated)<Input className="mt-1 h-8" value={rows[l.id].serials} onChange={(e) => set(l.id, "serials", e.target.value)} /></label>}
            </div>
          </div>
        ))}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
