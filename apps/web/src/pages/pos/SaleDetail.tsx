import { Ban, Printer, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Badge, Button, Card, DataTable, ErrorState, ErrorText, Field, Input, Modal, Money, PageHeader, Select, Spinner, Status, Textarea, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { printReceipt } from "../../components/print";
import { dateTime, humanize, money, qty } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Receipt } from "./Receipt";

export default function SaleDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const { data: s, isLoading, error, refetch } = useApi<any>(`/sales/${id}`);
  const [voiding, setVoiding] = useState<null | "void" | "reenter">(null);
  const navigate = useNavigate();
  const toast = useToast();
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  return (
    <div className="space-y-5">
      <PageHeader title={`Sale ${s.number}`} subtitle={<>{dateTime(s.completed_at ?? s.created_at)} · {s.branch?.name} · cashier {s.cashier_name} · <Status value={s.status} />{s.voided_at && <> · <Badge tone="red">Voided</Badge></>}</>} actions={<>
        {can("transactions.void") && s.status === "COMPLETED" && !s.voided_at && <>
          <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setVoiding("reenter")} title="Void this sale and open its items in the POS to ring them up correctly">Void & re-enter</Button>
          <Button variant="danger" icon={<Ban className="h-4 w-4" />} onClick={() => setVoiding("void")}>Void sale</Button>
        </>}
        {s.journal_entry_id && can("accounting.view") && <Link to={`/accounting/journals/${s.journal_entry_id}`}><Button variant="secondary">View journal</Button></Link>}
        <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => printReceipt()}>Reprint receipt</Button>
      </>} />
      {s.voided_at && (
        <div role="status" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <b>Voided</b> on {dateTime(s.voided_at)}{s.voided_by_name && <> by {s.voided_by_name}</>} — {s.void_reason}. The items went back into stock and the money was refunded through a reversing return; this record is kept for the audit trail.
        </div>
      )}
      {voiding && <VoidSaleModal sale={s} reenter={voiding === "reenter"} onClose={() => setVoiding(null)} onDone={() => {
        const reenter = voiding === "reenter";
        setVoiding(null); toast(`Sale ${s.number} voided`);
        if (reenter) {
          // Hand the original items to the POS so they can be rung up again correctly.
          const cart = s.lines.map((l: any, i: number) => {
            const base = Number(l.unit_factor) !== 1;
            const overridden = l.price_source === "NEGOTIATED" || l.price_source === "MANUAL_OVERRIDE";
            return { key: `re-${i}-${l.variant_id}`, variant_id: l.variant_id, sku: l.sku, name: l.description, quantity: String(base ? l.quantity_base : l.quantity), unit_code: base ? "base unit" : l.unit_code, available: null,
              negotiable: l.price_source === "NEGOTIATED", ...(overridden && !base ? { override_price: String(l.unit_price) } : {}) };
          });
          sessionStorage.setItem("pos.reenter", JSON.stringify({ cart, customer: s.customer ?? null, from: s.number }));
          navigate("/pos");
        } else refetch();
      }} />}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card title="Lines" padded={false}>
            <DataTable rows={s.lines} columns={[
              { key: "d", header: "Item", render: (l: any) => <div><div className="font-medium">{l.description}</div><div className="text-xs text-slate-500">{l.sku} · {l.price_source.replace(/_/g, " ").toLowerCase()}{l.discount_reason && ` · discount: ${l.discount_reason}`}</div></div> },
              { key: "q", header: "Qty", align: "right", render: (l: any) => `${qty(l.quantity)} ${l.unit_code}` },
              { key: "p", header: "Unit price", align: "right", render: (l: any) => money(l.unit_price) },
              { key: "disc", header: "Discount", align: "right", render: (l: any) => (Number(l.discount_amount) ? money(l.discount_amount) : "—") },
              { key: "tax", header: "Tax", align: "right", render: (l: any) => money(l.tax_amount) },
              { key: "t", header: "Total", align: "right", render: (l: any) => <strong>{money(l.line_total)}</strong> },
              ...(can("products.view_cost") ? [{ key: "c", header: "Cost", align: "right" as const, render: (l: any) => money(l.cost_amount) }] : []),
              { key: "r", header: "Returned", align: "right", render: (l: any) => qty(l.qty_returned_base) },
            ]} />
          </Card>
          <Card title="Payments" padded={false}>
            <DataTable rows={s.payments} columns={[
              { key: "m", header: "Method", render: (p: any) => humanize(p.method) },
              { key: "a", header: "Amount retained", align: "right", render: (p: any) => money(p.amount) },
              { key: "t", header: "Tendered / change", align: "right", render: (p: any) => (p.amount_tendered ? `${money(p.amount_tendered)} / ${money(p.change_given)}` : "—") },
              { key: "s", header: "Status", render: (p: any) => <Status value={p.status} /> },
              { key: "r", header: "Reference / confirmation", render: (p: any) => <span className="text-xs">{p.provider_reference ?? "—"} {p.confirmation_mode && `(${p.confirmation_mode.toLowerCase()})`}</span> },
            ]} />
          </Card>
          {s.returns.length > 0 && <Card title="Returns">{s.returns.map((r: any) => <div key={r.id} className="flex justify-between text-sm"><span>{r.number} · {dateTime(r.created_at)}</span><Money value={r.refund_total} /></div>)}</Card>}
        </div>
        <Card title="Receipt"><Receipt sale={s} /></Card>
      </div>
    </div>
  );
}

/** Administrator void: everything not yet returned goes back into stock and the money is refunded / credited. */
function VoidSaleModal({ sale, reenter, onClose, onDone }: { sale: any; reenter: boolean; onClose: () => void; onDone: () => void }) {
  const accounts = useApi<any[]>("/financial-accounts/options");
  const current = useApi<any>("/cashier-sessions/current");
  const refundable = sale.lines.reduce((a: number, l: any) => a + Number(l.returnable_base), 0) > 0;
  const outstanding = Number(sale.credit_amount) - Number(sale.credit_settled);
  const hasTill = !!current.data?.id;
  const defaultMethod = sale.customer && outstanding > 0 ? "CUSTOMER_CREDIT" : hasTill ? "CASH_TILL" : "CASH_ACCOUNT";
  const [method, setMethod] = useState<string>("");
  const m = method || defaultMethod;
  const [accountId, setAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const cashAccounts = (accounts.data ?? []).filter((a) => a.kind === "SAFE" || a.kind === "PETTY_CASH");
  const otherAccounts = (accounts.data ?? []).filter((a) => a.kind !== "TILL");
  const needsAccount = m === "CASH_ACCOUNT" || m === "MOBILE_MONEY" || m === "BANK_TRANSFER" || m === "CARD";
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api(`/sales/${sale.id}/void`, { body: {
        reason, restock,
        refund_method: m === "CASH_TILL" || m === "CASH_ACCOUNT" ? "CASH" : m,
        ...(m === "CASH_TILL" ? { register_id: current.data.register_id } : {}),
        ...(needsAccount ? { financial_account_id: accountId } : {}),
        ...(reference ? { reference } : {}),
      } });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`${reenter ? "Void & re-enter" : "Void"} sale ${sale.number}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3 || (refundable && needsAccount && !accountId)} onClick={submit}>{reenter ? "Void and open in POS" : "Void sale"}</Button></>}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-700">Total <b>{money(sale.total)}</b>. Voiding puts the items back into stock and refunds the money with a reversing entry. The sale stays on record, marked voided{reenter ? "; its items then open in the POS so you can ring them up correctly" : ""}.</p>
        <Field label="Reason" required hint="Recorded in the audit log">{(id, d) => <Textarea id={id} aria-describedby={d} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong quantity entered, sold to the wrong customer" />}</Field>
        {refundable ? <>
          <Field label="Refund the money">{(id) => (
            <Select id={id} value={m} onChange={(e) => setMethod(e.target.value)}>
              {hasTill && <option value="CASH_TILL">Cash from my till ({current.data.register_name ?? "open session"})</option>}
              <option value="CASH_ACCOUNT">Cash from the safe / petty cash</option>
              <option value="MOBILE_MONEY">Mobile money</option>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CARD">Card</option>
              {sale.customer && <option value="CUSTOMER_CREDIT">Customer account ({sale.customer.name}) — reduces what they owe, then store credit</option>}
            </Select>
          )}</Field>
          {needsAccount && <Field label="Paid from account" required>{(id) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Choose…</option>{(m === "CASH_ACCOUNT" ? cashAccounts : otherAccounts).map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</Select>}</Field>}
          {needsAccount && m !== "CASH_ACCOUNT" && <Field label="Transaction reference (optional)">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put the items back into sellable stock (untick if the goods left the shop and are lost)</label>
        </> : <p className="text-slate-500">Everything on this sale was already returned — the void just records it.</p>}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
