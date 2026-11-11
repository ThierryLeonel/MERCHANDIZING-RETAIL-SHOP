import { FormEvent, useState } from "react";
import { Link } from "react-router";
import { useApprovalFlow } from "../../components/approval";
import { Button, Card, DataTable, ErrorText, Field, Input, PageHeader, Select, Status, Textarea, useToast } from "../../components/ui";
import { api, newIdempotencyKey } from "../../lib/api";
import { dateTime, humanize, money, qty } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

const CONDITIONS = ["SELLABLE", "QUARANTINED", "DAMAGED", "SUPPLIER_RETURN_PENDING", "NON_RESTOCKABLE"];

export default function ReturnsPage() {
  const { branchId, can } = useSession();
  const toast = useToast();
  const [number, setNumber] = useState("");
  const [sale, setSale] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [lines, setLines] = useState<Record<string, { quantity: string; condition: string; notes: string }>>({});
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState("CASH");
  const [accountId, setAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);
  const approvals = useApprovalFlow();
  const patchLine = (id: string, patch: Partial<{ quantity: string; condition: string; notes: string }>) => setLines((ls) => ({ ...ls, [id]: { ...(ls[id] ?? { quantity: "", condition: "SELLABLE", notes: "" }), ...patch } }));
  const accounts = useApi<any[]>("/financial-accounts/options");
  const current = useApi<any>("/cashier-sessions/current");
  const find = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setSale(null); setDone(null);
    try { const s = await api(`/sales/lookup/${encodeURIComponent(number.trim())}`); setSale(s); setLines({}); } catch (e2) { setErr(e2); }
  };
  const submit = async () => {
    setBusy(true); setErr(null);
    const key = newIdempotencyKey();
    try {
      const r = await approvals.run((approvalId) => api("/returns", { idempotent: approvalId ? newIdempotencyKey() : key, body: {
        sale_id: sale.id, register_id: method === "CASH" ? current.data?.session.register_id : undefined, reason, refund_method: method,
        financial_account_id: method !== "CASH" && method !== "CUSTOMER_CREDIT" ? accountId : undefined, reference: reference || undefined, approval_request_id: approvalId,
        lines: Object.entries(lines).filter(([, v]) => Number(v.quantity) > 0).map(([id, v]) => ({ sale_line_id: id, quantity: v.quantity, condition: v.condition, inspection_notes: v.notes || undefined })),
      } }), reason);
      if (r) { setDone(r); toast(`Return ${r.number} recorded`); setSale(null); setNumber(""); }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (!can("pos.return")) return <Card><p className="text-sm">You do not have permission to process returns.</p></Card>;
  const selected = Object.values(lines).some((l) => Number(l.quantity) > 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Returns & exchanges" subtitle="Returns reference the original sale. Refunds use the original amounts; stock is restocked at original cost. For an exchange, process the return, then ring up the new sale." actions={<Link to="/pos"><Button variant="secondary">Back to POS</Button></Link>} />
      <Card>
        <form onSubmit={find} className="flex flex-wrap items-end gap-2">
          <Field label="Receipt number" className="w-72">{(id) => <Input id={id} placeholder="e.g. S-DLA1-000012" value={number} onChange={(e) => setNumber(e.target.value)} />}</Field>
          <Button type="submit">Find sale</Button>
        </form>
        <div className="mt-2"><ErrorText error={err} /></div>
        {done && <p className="mt-3 rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">Return {done.number} recorded — refund {money(done.refund_total)} via {humanize(done.refund_method)}.</p>}
      </Card>
      {sale && (
        <Card title={<>Sale {sale.number} · {dateTime(sale.completed_at)} · <Status value={sale.status} /></>}>
          <DataTable rows={sale.lines} columns={[
            { key: "d", header: "Item", render: (l: any) => <div><div className="font-medium">{l.description}</div><div className="text-xs text-slate-500">{l.sku} · sold {qty(l.quantity_base)} · returnable {qty(l.returnable_base)}</div></div> },
            { key: "p", header: "Paid", align: "right", render: (l: any) => money(l.line_total) },
            { key: "q", header: "Return qty", render: (l: any) => <Input aria-label={`Return quantity for ${l.description}`} className="h-8 w-20" inputMode="decimal" disabled={Number(l.returnable_base) <= 0} value={lines[l.id]?.quantity ?? ""} onChange={(e) => patchLine(l.id, { quantity: e.target.value })} /> },
            { key: "c", header: "Condition", render: (l: any) => <Select aria-label="Condition" className="h-8 w-48" value={lines[l.id]?.condition ?? "SELLABLE"} onChange={(e) => patchLine(l.id, { condition: e.target.value })}>{CONDITIONS.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</Select> },
            { key: "n", header: "Inspection notes", render: (l: any) => <Input aria-label="Inspection notes" className="h-8" value={lines[l.id]?.notes ?? ""} onChange={(e) => patchLine(l.id, { notes: e.target.value })} /> },
          ]} />
          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <Field label="Return reason" required className="md:col-span-2">{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            <Field label="Refund method">{(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH" disabled={!current.data}>Cash from my till{!current.data ? " (no open session)" : ""}</option>
                <option value="MOBILE_MONEY">Mobile money</option><option value="BANK_TRANSFER">Bank transfer</option><option value="CARD">Card reversal</option>
                {sale.customer && <option value="CUSTOMER_CREDIT">Customer account / store credit</option>}
              </Select>
            )}</Field>
            {method !== "CASH" && method !== "CUSTOMER_CREDIT" && (
              <div className="space-y-2">
                <Field label="Paid from">{(id) => <Select id={id} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Select…</option>{accounts.data?.filter((a) => a.kind !== "TILL").map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
                <Field label="Refund reference">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end"><Button loading={busy} disabled={!selected || reason.trim().length < 3} onClick={submit}>Process return</Button></div>
          {approvals.dialog(branchId)}
        </Card>
      )}
    </div>
  );
}
