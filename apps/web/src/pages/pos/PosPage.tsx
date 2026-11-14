import { Banknote, CreditCard, HandCoins, Minus, Pause, Percent, Play, Plus, Printer, RotateCcw, ScanLine, Search, Smartphone, Trash2, User, Wallet, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useApprovalFlow } from "../../components/approval";
import { Badge, Button, Card, cx, ErrorState, ErrorText, Field, Input, Modal, Money, Select, Spinner, Status, Textarea, useToast } from "../../components/ui";
import { api, ApiError, newIdempotencyKey, qs } from "../../lib/api";
import { humanize, money, qty, sumStrings } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";
import { Receipt } from "./Receipt";

interface CartLine {
  key: string; variant_id: string; sku: string; name: string; quantity: string; unit_id?: string; unit_code: string;
  discount_amount?: string; discount_reason?: string; approval_request_id?: string; serial_number_id?: string; serial?: string; available: string | null;
  /** Agreed (bargained) or overridden unit price; the server re-validates it against the minimum price. */
  override_price?: string; negotiable?: boolean; bulk?: boolean;
}
interface Tender { method: string; amount: string; amount_tendered?: string; reference?: string; payer_phone?: string; approval_request_id?: string }

export default function PosPage() {
  const { branchId, me } = useSession();
  const current = useApi<any>("/cashier-sessions/current");
  if (current.isLoading) return <Spinner />;
  if (current.error) return <ErrorState error={current.error} onRetry={current.refetch} />;
  if (!current.data) return <OpenSession onOpened={() => current.refetch()} />;
  const session = current.data.session;
  if (session.branch_id !== branchId) {
    const b = me?.branches.find((x) => x.id === session.branch_id);
    return <Card title="Session at another branch"><p className="text-sm">Your open session {session.number} is at {b?.name ?? "another branch"}. Switch the branch selector to {b?.code} to continue selling.</p></Card>;
  }
  return <Terminal sessionInfo={current.data} reloadSession={() => current.refetch()} />;
}

function OpenSession({ onOpened }: { onOpened: () => void }) {
  const { branchId, can } = useSession();
  const regs = useApi<any[]>(branchId ? `/registers?branch_id=${branchId}` : null, [branchId]);
  const [registerId, setRegisterId] = useState("");
  const [float, setFloat] = useState("0");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const open = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api("/cashier-sessions", { body: { register_id: registerId, opening_float: float || "0" }, idempotent: true }); onOpened(); } catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  if (!can("sessions.open")) return <Card title="Point of Sale"><p className="text-sm">You do not have permission to open a cashier session.</p></Card>;
  return (
    <div className="mx-auto max-w-md">
      <Card title="Open a cashier session">
        <form onSubmit={open} className="space-y-4">
          <p className="text-sm text-slate-600">Count the opening float handed to you from the safe. It is recorded as a transfer from the branch safe to this till.</p>
          <Field label="Register" required>{(id) => (
            <Select id={id} required value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
              <option value="">Select a register…</option>
              {regs.data?.map((r) => <option key={r.id} value={r.id} disabled={!!r.open_session}>{r.code} — {r.name}{r.open_session ? ` (in use: ${r.open_session.number})` : ""}</option>)}
            </Select>
          )}</Field>
          <Field label="Opening float (cash counted)">{(id) => <Input id={id} inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} />}</Field>
          <ErrorText error={err} />
          <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!registerId}>Open session</Button>
        </form>
      </Card>
    </div>
  );
}

function Terminal({ sessionInfo, reloadSession }: { sessionInfo: any; reloadSession: () => void }) {
  const { branchId, can } = useSession();
  const toast = useToast();
  const session = sessionInfo.session;
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [scan, setScan] = useState("");
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [quote, setQuote] = useState<any>(null);
  const [quoteErr, setQuoteErr] = useState<unknown>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [discountFor, setDiscountFor] = useState<CartLine | null>(null);
  const [priceFor, setPriceFor] = useState<{ line: CartLine; index: number } | null>(null);
  const [serialFor, setSerialFor] = useState<any>(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);
  const shortcuts = useApi<any[]>(`/catalogue/sellables${qs({ branch_id: branchId, shortcuts: "true" })}`, [branchId]);
  const results = useApi<any[]>(search.length >= 2 ? `/catalogue/sellables${qs({ branch_id: branchId, search })}` : null, [branchId, search]);

  const addItem = useCallback((item: any, opts: { unit?: { unit_id: string | null; unit_code: string | null; factor: string }; serial?: { id: string; serial: string } } = {}) => {
    if (item.track_serials && !opts.serial) { setSerialFor(item); return; }
    setScanErr(null);
    setCart((c) => {
      const unitId = opts.unit?.unit_id ?? undefined;
      const existing = !item.track_serials && c.find((l) => l.variant_id === item.variant_id && l.unit_id === unitId && !l.discount_amount && !l.override_price);
      if (existing) return c.map((l) => (l === existing ? { ...l, quantity: String(Number(l.quantity) + 1) } : l));
      return [...c, { key: crypto.randomUUID(), variant_id: item.variant_id, sku: item.sku, name: item.name, quantity: "1", unit_id: unitId, unit_code: opts.unit?.unit_code ?? item.base_unit_code, available: item.available, serial_number_id: opts.serial?.id, serial: opts.serial?.serial, negotiable: !!item.negotiable_price, bulk: item.product_type === "BULK" }];
    });
    setTimeout(() => scanRef.current?.focus(), 0);
  }, []);

  const onScan = async (e: FormEvent) => {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan("");
    try {
      const item = await api<any>(`/catalogue/lookup${qs({ code, branch_id: branchId })}`);
      addItem(item, { unit: item.scanned.unit_id ? item.scanned : undefined });
    } catch (err) { setScanErr((err as Error).message); }
  };

  // Server-side pricing: every cart change is re-quoted by the backend.
  const quoteBody = useMemo(() => ({ branch_id: branchId, register_id: session.register_id, customer_id: customer?.id, lines: cart.map((l) => ({ variant_id: l.variant_id, quantity: l.quantity, unit_id: l.unit_id, discount_amount: l.discount_amount, discount_reason: l.discount_reason, approval_request_id: l.approval_request_id, serial_number_id: l.serial_number_id, override_price: l.override_price })) }), [cart, customer, branchId, session.register_id]);
  // The quote shown must match the current cart before payment can start (no stale totals).
  const [quotedBody, setQuotedBody] = useState<unknown>(null);
  const quoteCurrent = quotedBody === quoteBody;
  useEffect(() => {
    if (!cart.length) { setQuote(null); setQuoteErr(null); setQuotedBody(null); return; }
    const ctrl = new AbortController();
    const h = setTimeout(() => api("/sales/quote", { body: quoteBody, signal: ctrl.signal }).then((q) => { setQuote(q); setQuoteErr(null); setQuotedBody(quoteBody); }).catch((e) => { if (e.name !== "AbortError") { setQuoteErr(e); setQuotedBody(quoteBody); } }), 200);
    return () => { clearTimeout(h); ctrl.abort(); };
  }, [quoteBody, cart.length]);

  const setQty = (key: string, q: string) => setCart((c) => c.map((l) => (l.key === key ? { ...l, quantity: q } : l)));
  const remove = (key: string) => setCart((c) => c.filter((l) => l.key !== key));
  const clear = () => { setCart([]); setCustomer(null); setQuote(null); };

  const hold = async () => {
    const label = customer?.name ?? `Cart ${new Date().toLocaleTimeString()}`;
    await api("/held-carts", { body: { branch_id: branchId, register_id: session.register_id, label, customer_id: customer?.id, payload: { cart, customer } } });
    toast(`Cart held: ${label}`); clear();
  };

  useEffect(() => { scanRef.current?.focus(); }, []);
  const quoteLine = (i: number) => quote?.lines?.[i];

  return (
    <div className="grid h-full gap-4 lg:grid-cols-[1fr_420px]">
      {/* ------------------------------------------------ left: catalogue */}
      <div className="flex min-h-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={onScan} className="relative flex-1 min-w-[240px]">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input ref={scanRef} aria-label="Scan barcode or enter SKU" placeholder="Scan barcode or type SKU, then Enter" className="h-12 pl-10 text-base" value={scan} onChange={(e) => setScan(e.target.value)} />
          </form>
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input aria-label="Search products" placeholder="Search products…" className="h-12 pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {scanErr && <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{scanErr}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
            {(search.length >= 2 ? results.data : shortcuts.data)?.map((p) => (
              <button key={p.variant_id} onClick={() => addItem(p)} className="flex min-h-24 flex-col justify-between rounded-lg border border-slate-200 bg-white p-3 text-left shadow-xs hover:border-brand-600 hover:shadow-sm active:scale-[.99]">
                <div className="line-clamp-2 text-sm font-medium">{p.name}</div>
                {(p.negotiable_price || p.product_type === "BULK") && <div className="mt-1 flex gap-1">{p.product_type === "BULK" && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-800">per {p.base_unit_code}</span>}{p.negotiable_price && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">Bargain</span>}</div>}
                <div className="mt-2 flex items-end justify-between gap-2">
                  <span className="num text-sm font-semibold text-brand-800">{money(p.unit_price)}</span>
                  {p.available !== null && <span className={cx("text-xs", Number(p.available) <= 0 ? "text-red-600" : "text-slate-500")}>{qty(p.available)} left</span>}
                </div>
                {p.sell_units?.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{p.sell_units.map((u: any) => <span key={u.unit_id} role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); addItem(p, { unit: u }); }} onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), addItem(p, { unit: u }))} className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-700 hover:bg-brand-100">+{u.unit_code} ({qty(u.factor)})</span>)}</div>}
              </button>
            ))}
          </div>
          {search.length >= 2 && results.data?.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No products match “{search}”.</p>}
          {search.length < 2 && !shortcuts.data?.length && <p className="py-6 text-center text-sm text-slate-500">Scan a barcode or search to add items. Mark products as shortcuts to show them here.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 text-sm">
          <Badge tone="blue">Session {session.number}</Badge>
          <span className="text-slate-500">Expected cash <Money value={sessionInfo.expected_cash} /> · {sessionInfo.sales_count} sales</span>
          <div className="ml-auto flex gap-2">
            {can("pos.return") && <Link to="/pos/returns"><Button variant="secondary" size="sm" icon={<RotateCcw className="h-4 w-4" />}>Returns</Button></Link>}
            <Button variant="secondary" size="sm" icon={<Wallet className="h-4 w-4" />} onClick={() => setSessionOpen(true)}>Cash & close</Button>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------- right: cart */}
      <Card className="flex min-h-0 flex-col" padded={false} title={<span className="flex items-center gap-2">Cart {cart.length > 0 && <Badge>{cart.length}</Badge>}</span>}
        actions={<>
          {can("pos.hold") && <Button size="sm" variant="ghost" icon={<Play className="h-4 w-4" />} onClick={() => setHeldOpen(true)}>Recall</Button>}
          {can("pos.hold") && <Button size="sm" variant="ghost" icon={<Pause className="h-4 w-4" />} disabled={!cart.length} onClick={hold}>Hold</Button>}
          <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={!cart.length} onClick={clear} aria-label="Clear cart" />
        </>}>
        <button onClick={() => setCustomerOpen(true)} className="flex w-full items-center gap-2 border-b border-slate-200 px-4 py-2.5 text-left text-sm hover:bg-slate-50">
          <User className="h-4 w-4 text-slate-400" />{customer ? <span><strong>{customer.name}</strong> {customer.phone && <span className="text-slate-500">· {customer.phone}</span>}</span> : <span className="text-slate-500">Walk-in customer (tap to select)</span>}
          {customer && <X className="ml-auto h-4 w-4 text-slate-400" onClick={(e) => { e.stopPropagation(); setCustomer(null); }} aria-label="Remove customer" />}
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!cart.length ? <p className="p-8 text-center text-sm text-slate-500">Cart is empty</p> : (
            <ul className="divide-y divide-slate-100">
              {cart.map((l, i) => {
                const q = quoteLine(i);
                return (
                  <li key={l.key} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0"><div className="truncate text-sm font-medium">{l.name}</div><div className="text-xs text-slate-500">{l.sku}{l.serial && ` · SN ${l.serial}`} · {q && l.override_price && q.list_price !== q.unit_price && <span className="mr-1 line-through">{money(q.list_price)}</span>}{q ? money(q.unit_price) : "…"}/{l.unit_code}{l.override_price && l.negotiable && <span className="ml-1 text-amber-700">agreed</span>}</div></div>
                      <div className="num text-right text-sm font-semibold">{q ? money(q.line_total) : "…"}</div>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <Button size="sm" variant="secondary" aria-label="Decrease" disabled={!!l.serial_number_id || Number(l.quantity) <= 1} onClick={() => setQty(l.key, String(Number(l.quantity) - 1))}><Minus className="h-3.5 w-3.5" /></Button>
                      <Input aria-label={`Quantity for ${l.name}`} className="h-8 w-16 text-center" inputMode="decimal" disabled={!!l.serial_number_id} value={l.quantity} onChange={(e) => setQty(l.key, e.target.value)} />
                      <Button size="sm" variant="secondary" aria-label="Increase" disabled={!!l.serial_number_id} onClick={() => setQty(l.key, String(Number(l.quantity) + 1))}><Plus className="h-3.5 w-3.5" /></Button>
                      {(l.negotiable || can("pos.price_override")) && <Button size="sm" variant={l.negotiable && !l.override_price ? "secondary" : "ghost"} icon={<HandCoins className="h-3.5 w-3.5" />} onClick={() => setPriceFor({ line: l, index: i })}>{l.override_price ? money(l.override_price, { symbol: false }) : l.negotiable ? "Bargain" : "Price"}</Button>}
                      {can("pos.discount") && !l.negotiable && <Button size="sm" variant="ghost" icon={<Percent className="h-3.5 w-3.5" />} onClick={() => setDiscountFor(l)}>{l.discount_amount ? `-${money(l.discount_amount, { symbol: false })}` : "Discount"}</Button>}
                      <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Remove ${l.name}`} onClick={() => remove(l.key)}><X className="h-4 w-4" /></Button>
                    </div>
                    {q?.needs_approval && <div className="mt-1 text-xs text-amber-700">Needs {humanize(q.needs_approval).toLowerCase()} approval at payment</div>}
                    {l.available !== null && Number(l.quantity) > Number(l.available) && <div className="mt-1 text-xs text-red-600">Only {qty(l.available)} available</div>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="space-y-1 border-t border-slate-200 px-4 py-3 text-sm">
          {quoteErr ? <ErrorText error={quoteErr} /> : null}
          <Line label="Subtotal" value={quote?.gross_amount} />
          {Number(quote?.discount_total) > 0 && <Line label="Discounts" value={`-${quote.discount_total}`} />}
          <Line label="Tax" value={quote?.tax_total} />
          <div className="flex items-baseline justify-between pt-1 text-lg font-semibold"><span>Total</span><Money value={quote?.total ?? "0"} /></div>
          <Button size="lg" className="mt-2 w-full" disabled={!cart.length || !quote || !!quoteErr || !quoteCurrent} onClick={() => setPayOpen(true)} icon={<Banknote className="h-5 w-5" />}>{quote && !quoteCurrent && !quoteErr ? "Updating total…" : `Pay ${quote ? money(quote.total) : ""}`}</Button>
        </div>
      </Card>

      {payOpen && quote && <PaymentModal quote={quote} body={quoteBody} customer={customer} onClose={() => setPayOpen(false)} onApprovedLine={(idx, id) => setCart((c) => c.map((l, i) => (i === idx ? { ...l, approval_request_id: id } : l)))}
        onDone={(sale) => { setPayOpen(false); setResult(sale); clear(); reloadSession(); }} />}
      {result && <SaleResult sale={result} onClose={() => { setResult(null); reloadSession(); scanRef.current?.focus(); }} onUpdate={setResult} />}
      {discountFor && <DiscountModal line={discountFor} onClose={() => setDiscountFor(null)} onSave={(d) => { setCart((c) => c.map((l) => (l.key === discountFor.key ? { ...l, ...d, approval_request_id: undefined } : l))); setDiscountFor(null); }} />}
      {priceFor && <PriceModal line={priceFor.line} quoteLine={quoteLine(priceFor.index)} canOverride={can("pos.price_override")} onClose={() => setPriceFor(null)}
        onSave={(price) => { setCart((c) => c.map((l) => (l.key === priceFor.line.key ? { ...l, override_price: price, approval_request_id: undefined } : l))); setPriceFor(null); setTimeout(() => scanRef.current?.focus(), 0); }} />}
      {serialFor && <SerialModal item={serialFor} branchId={branchId!} taken={cart.map((l) => l.serial_number_id).filter(Boolean) as string[]} onClose={() => setSerialFor(null)} onPick={(s) => { addItem(serialFor, { serial: s }); setSerialFor(null); }} />}
      {customerOpen && <CustomerPicker onClose={() => setCustomerOpen(false)} onPick={(c) => { setCustomer(c); setCustomerOpen(false); }} />}
      {heldOpen && <HeldCarts branchId={branchId!} onClose={() => setHeldOpen(false)} onRecall={(h) => { setCart(h.payload.cart ?? []); setCustomer(h.payload.customer ?? null); setHeldOpen(false); toast("Cart recalled — prices re-calculated"); }} />}
      {sessionOpen && <SessionModal sessionInfo={sessionInfo} onClose={() => setSessionOpen(false)} onChanged={() => { setSessionOpen(false); reloadSession(); }} />}
    </div>
  );
}
const Line = ({ label, value }: { label: string; value?: string }) => <div className="flex justify-between text-slate-600"><span>{label}</span><Money value={value ?? "0"} /></div>;

// ------------------------------------------------------------------ payment
function PaymentModal({ quote, body, customer, onClose, onDone, onApprovedLine }: { quote: any; body: any; customer: any; onClose: () => void; onDone: (sale: any) => void; onApprovedLine: (index: number, id: string) => void }) {
  const { can, branchId, me } = useSession();
  const decimals = me?.business.currency_decimals ?? 0;
  const [tenders, setTenders] = useState<Tender[]>([{ method: "CASH", amount: quote.total, amount_tendered: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const keyRef = useRef(newIdempotencyKey()); // reused on retry → never a duplicate sale
  const approvals = useApprovalFlow();
  const linesRef = useRef(body.lines);
  const paid = sumStrings(tenders.map((t) => t.amount), decimals);
  const remaining = sumStrings([quote.total, `-${paid}`], decimals);
  const cash = tenders.find((t) => t.method === "CASH");
  const change = cash && cash.amount_tendered ? sumStrings([cash.amount_tendered, `-${cash.amount}`], decimals) : "0";
  const update = (i: number, patch: Partial<Tender>) => setTenders((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const addTender = (method: string) => setTenders((ts) => [...ts, { method, amount: Number(remaining) > 0 ? remaining : "0" }]);
  const methods = [
    { m: "CASH", label: "Cash", icon: Banknote }, { m: "MOBILE_MONEY", label: "Mobile money", icon: Smartphone }, { m: "CARD", label: "Card", icon: CreditCard },
    { m: "BANK_TRANSFER", label: "Bank transfer", icon: Wallet }, ...(customer && can("pos.credit_sale") ? [{ m: "CUSTOMER_CREDIT", label: "On account", icon: User }] : []),
  ];
  const submit = async () => {
    setBusy(true); setErr(null);
    const attempt = (approvalId?: string, kind?: string, lineIndex?: number): Promise<any> => {
      let lines = linesRef.current;
      let payments = tenders.filter((t) => Number(t.amount) > 0).map((t) => ({ ...t, amount_tendered: t.method === "CASH" ? (t.amount_tendered || t.amount) : undefined, reference: t.reference?.trim() || undefined }));
      if (approvalId && kind === "line" && lineIndex !== undefined) { lines = lines.map((l: any, i: number) => (i === lineIndex ? { ...l, approval_request_id: approvalId } : l)); linesRef.current = lines; onApprovedLine(lineIndex, approvalId); keyRef.current = newIdempotencyKey(); }
      if (approvalId && kind === "credit") { payments = payments.map((p) => (p.method === "CUSTOMER_CREDIT" ? { ...p, approval_request_id: approvalId } : p)); keyRef.current = newIdempotencyKey(); }
      return api("/sales/checkout", { body: { ...body, lines, payments }, idempotent: keyRef.current }).catch((e: ApiError) => {
        if (e.code === "APPROVAL_REQUIRED") {
          const k = e.details?.approval_type === "CUSTOMER_CREDIT" ? "credit" : "line";
          return approvals.run(async (id) => { if (!id) throw e; return attempt(id, k, e.details?.line_index); });
        }
        throw e;
      });
    };
    try { const sale = await attempt(); if (sale) onDone(sale); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Payment — ${money(quote.total)}`} size="lg" footer={<><Button variant="secondary" onClick={onClose}>Back</Button><Button size="lg" loading={busy} disabled={remaining !== "0"} onClick={submit}>Complete sale</Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">{methods.map(({ m, label, icon: Icon }) => <Button key={m} variant="secondary" icon={<Icon className="h-4 w-4" />} onClick={() => addTender(m)}>{label}</Button>)}</div>
        <div className="space-y-3">
          {tenders.map((t, i) => (
            <div key={i} className="grid items-end gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-[150px_1fr_1fr_auto]">
              <div className="text-sm font-medium">{humanize(t.method)}</div>
              <Field label="Amount">{(id) => <Input id={id} inputMode="decimal" value={t.amount} onChange={(e) => update(i, { amount: e.target.value })} />}</Field>
              {t.method === "CASH" ? (
                <Field label="Cash tendered" hint="Leave blank for exact cash">{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={t.amount_tendered ?? ""} onChange={(e) => update(i, { amount_tendered: e.target.value })} />}</Field>
              ) : t.method === "CUSTOMER_CREDIT" ? <div className="text-xs text-slate-500">Charged to {customer?.name}'s account (credit limit enforced)</div>
                : (
                  <div className="space-y-2">
                    {t.method === "MOBILE_MONEY" && <Field label="Payer phone">{(id) => <Input id={id} inputMode="tel" value={t.payer_phone ?? ""} onChange={(e) => update(i, { payer_phone: e.target.value })} />}</Field>}
                    {can("pos.confirm_payment") ? <Field label="Confirmed reference" hint="Enter only after verifying funds received">{(id, d) => <Input id={id} aria-describedby={d} value={t.reference ?? ""} onChange={(e) => update(i, { reference: e.target.value })} />}</Field>
                      : <p className="text-xs text-slate-500">Will stay pending until confirmed by the provider or an authorised user.</p>}
                  </div>
                )}
              <Button variant="ghost" aria-label="Remove tender" onClick={() => setTenders((ts) => ts.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3 rounded-md bg-slate-50 p-3 text-sm">
          <div><div className="text-slate-500">Total</div><div className="num text-lg font-semibold">{money(quote.total)}</div></div>
          <div><div className="text-slate-500">Remaining</div><div className={cx("num text-lg font-semibold", remaining !== "0" && "text-red-600")}>{money(remaining)}</div></div>
          <div><div className="text-slate-500">Change due</div><div className="num text-lg font-semibold text-emerald-700">{money(Number(change) > 0 ? change : "0")}</div></div>
        </div>
        <ErrorText error={err} />
        {approvals.dialog(branchId)}
      </div>
    </Modal>
  );
}

/** Completed sale → receipt; pending electronic payment → status, simulator, manual confirmation. */
function SaleResult({ sale, onClose, onUpdate }: { sale: any; onClose: () => void; onUpdate: (s: any) => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [ref, setRef] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const pending = sale.status === "PENDING_PAYMENT";
  useEffect(() => {
    if (!pending) return;
    const h = setInterval(() => api(`/sales/${sale.id}`).then(onUpdate).catch(() => {}), 2500);
    return () => clearInterval(h);
  }, [pending, sale.id, onUpdate]);
  const act = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); onUpdate(await api(`/sales/${sale.id}`)); } catch (e) { setErr(e); } };
  if (!pending) {
    return (
      <Modal open onClose={onClose} title={sale.status === "COMPLETED" ? `Sale ${sale.number} completed` : `Sale ${sale.number}`} footer={<><Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print receipt</Button><Button onClick={onClose}>New sale</Button></>}>
        {Number(sale.change_given) > 0 && <div className="mb-3 rounded-md bg-emerald-50 p-3 text-center text-emerald-800">Change due: <strong className="num text-xl">{money(sale.change_given)}</strong></div>}
        <div className="rounded border border-slate-200"><Receipt sale={sale} /></div>
      </Modal>
    );
  }
  const failed = sale.payments.filter((p: any) => p.status === "FAILED");
  return (
    <Modal open onClose={onClose} title={`Awaiting payment — ${sale.number}`} size="lg" footer={<Button variant="secondary" onClick={onClose}>Close (sale stays pending)</Button>}>
      <div className="space-y-3 text-sm">
        <p>Stock is reserved while the payment is confirmed. The sale completes automatically once all payments are confirmed.</p>
        {sale.payments.map((p: any) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 p-3">
            <div className="w-36 font-medium">{humanize(p.method)}</div><Money value={p.amount} /><Status value={p.status} />
            {p.failure_reason && <span className="text-xs text-red-600">{p.failure_reason}</span>}
            {p.status === "PENDING" && (
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {sale.simulator && p.attempts?.find((a: any) => a.status === "PENDING") && (
                  <span className="flex items-center gap-1 rounded border border-dashed border-violet-400 px-2 py-1">
                    <Badge tone="violet">DEV SIMULATOR</Badge>
                    <Button size="sm" variant="ghost" onClick={() => act(() => api(`/payments/simulator/${p.attempts.find((a: any) => a.status === "PENDING").request_reference}/approve`, { body: {} }))}>Approve</Button>
                    <Button size="sm" variant="ghost" onClick={() => act(() => api(`/payments/simulator/${p.attempts.find((a: any) => a.status === "PENDING").request_reference}/decline`, { body: {} }))}>Decline</Button>
                  </span>
                )}
                {can("pos.confirm_payment") && <><Input aria-label="Payment reference" placeholder="Verified reference" className="h-8 w-40" value={ref} onChange={(e) => setRef(e.target.value)} /><Button size="sm" disabled={ref.trim().length < 3} onClick={() => act(() => api(`/payments/${p.id}/confirm`, { body: { reference: ref } }).then(() => toast("Payment confirmed")))}>Confirm</Button></>}
              </div>
            )}
          </div>
        ))}
        {failed.length > 0 && (
          <div className="flex flex-wrap gap-2 rounded-md bg-amber-50 p-3">
            <span className="w-full text-amber-900">A payment failed or timed out. Take the outstanding amount another way, or cancel the sale.</span>
            <Button size="sm" onClick={() => act(() => api(`/sales/${sale.id}/payments`, { body: { method: "CASH", amount: failed.reduce((a: number, p: any) => a + Number(p.amount), 0).toString() }, idempotent: true }))}>Take cash instead</Button>
            <Button size="sm" variant="danger" onClick={() => act(() => api(`/sales/${sale.id}/cancel`, { body: { reason: "Payment failed" } }))}>Cancel sale</Button>
          </div>
        )}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

function DiscountModal({ line, onClose, onSave }: { line: CartLine; onClose: () => void; onSave: (d: { discount_amount?: string; discount_reason?: string }) => void }) {
  const [amount, setAmount] = useState(line.discount_amount ?? "");
  const [reason, setReason] = useState(line.discount_reason ?? "");
  return (
    <Modal open onClose={onClose} title={`Discount — ${line.name}`} size="sm" footer={<><Button variant="secondary" onClick={() => onSave({ discount_amount: undefined, discount_reason: undefined })}>Remove</Button><Button disabled={!amount || reason.trim().length < 2} onClick={() => onSave({ discount_amount: amount, discount_reason: reason })}>Apply</Button></>}>
      <div className="space-y-3">
        <Field label="Discount amount (line total)" hint="Discounts above your limit or below the minimum price need approval">{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Reason" required>{(id) => <Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Modal>
  );
}

/**
 * Agreed price for a line. Negotiable items: any cashier, floor = minimum price (hard).
 * Other items: users with pos.price_override; below-minimum prices need approval at payment.
 * The agreed amount can be typed per unit or as a total for the quantity (bulk goods).
 */
function PriceModal({ line, quoteLine, canOverride, onClose, onSave }: { line: CartLine; quoteLine: any; canOverride: boolean; onClose: () => void; onSave: (price: string | undefined) => void }) {
  const { me } = useSession();
  const decimals = Math.max(me?.business.currency_decimals ?? 0, 0);
  const asking = quoteLine?.list_price ?? quoteLine?.unit_price;
  const min = quoteLine?.min_price ? Number(quoteLine.min_price) : null;
  const quantity = Number(line.quantity) || 0;
  const [mode, setMode] = useState<"unit" | "total">("unit");
  const [value, setValue] = useState(line.override_price ?? "");
  const n = Number(value);
  const unit = !value || !Number.isFinite(n) || n <= 0 ? null : mode === "unit" ? n : quantity > 0 ? Math.round((n / quantity) * 100) / 100 : null;
  const below = unit != null && min != null && unit < min;
  const blocked = below && (line.negotiable || !canOverride);
  const fmt = (x: number) => x.toFixed(2).replace(/\.?0+$/, "");
  return (
    <Modal open onClose={onClose} title={`${line.negotiable ? "Agreed price" : "Override price"} — ${line.name}`} size="sm"
      footer={<>{line.override_price && <Button variant="secondary" onClick={() => onSave(undefined)}>Use asking price</Button>}<Button disabled={unit == null || blocked} onClick={() => unit != null && onSave(fmt(unit))}>Apply</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (unit != null && !blocked) onSave(fmt(unit)); }}>
        <div className="grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 text-sm">
          <div><div className="text-slate-500">Asking price</div><div className="num font-semibold">{asking ? money(asking) : "…"}<span className="text-xs font-normal text-slate-500">/{line.unit_code}</span></div></div>
          <div><div className="text-slate-500">Lowest allowed</div><div className="num font-semibold text-amber-700">{min != null ? money(min) : "—"}<span className="text-xs font-normal text-slate-500">/{line.unit_code}</span></div></div>
        </div>
        {quantity !== 1 && (
          <div className="flex gap-1 text-sm" role="radiogroup" aria-label="Enter price as">
            <Button type="button" size="sm" variant={mode === "unit" ? "primary" : "secondary"} onClick={() => setMode("unit")}>Per {line.unit_code}</Button>
            <Button type="button" size="sm" variant={mode === "total" ? "primary" : "secondary"} onClick={() => setMode("total")}>Total for {qty(line.quantity)} {line.unit_code}</Button>
          </div>
        )}
        <Field label={mode === "unit" ? `Agreed price per ${line.unit_code}` : `Agreed total for ${qty(line.quantity)} ${line.unit_code}`}>{(id) => <Input id={id} autoFocus inputMode="decimal" className="h-12 text-lg" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        {unit != null && mode === "total" && <p className="text-xs text-slate-500">= {money(fmt(unit))} per {line.unit_code}{decimals === 0 ? " (line total is rounded to the currency)" : ""}</p>}
        {unit != null && mode === "unit" && quantity !== 1 && <p className="text-xs text-slate-500">Line total ≈ {money(fmt(unit * quantity))}</p>}
        {blocked && <p role="alert" className="text-sm text-red-600">Below the minimum price of {money(min!)} — this price cannot be accepted.</p>}
        {below && !blocked && <p className="text-sm text-amber-700">Below the minimum price — a manager must approve at payment.</p>}
      </form>
    </Modal>
  );
}

function SerialModal({ item, branchId, taken, onClose, onPick }: { item: any; branchId: string; taken: string[]; onClose: () => void; onPick: (s: { id: string; serial: string }) => void }) {
  const serials = useApi<any[]>(`/catalogue/serials${qs({ variant_id: item.variant_id, branch_id: branchId })}`);
  const [filter, setFilter] = useState("");
  const list = serials.data?.filter((s) => !taken.includes(s.id) && s.serial.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Modal open onClose={onClose} title={`Select serial — ${item.name}`}>
      <Input autoFocus aria-label="Scan or filter serial" placeholder="Scan or type serial number" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === "Enter" && list?.length === 1 && onPick(list[0])} />
      {serials.isLoading ? <Spinner /> : !list?.length ? <p className="py-6 text-center text-sm text-slate-500">No serials in stock at this branch.</p> : (
        <ul className="mt-3 max-h-72 divide-y divide-slate-100 overflow-y-auto">{list.map((s) => <li key={s.id}><button className="w-full px-2 py-2 text-left font-mono text-sm hover:bg-slate-50" onClick={() => onPick(s)}>{s.serial}</button></li>)}</ul>
      )}
    </Modal>
  );
}

function CustomerPicker({ onClose, onPick }: { onClose: () => void; onPick: (c: any) => void }) {
  const { can } = useSession();
  const [search, setSearch] = useState("");
  const list = useApi<any>(`/customers${qs({ search, pageSize: 10 })}`, [search]);
  const [name, setName] = useState(""); const [phone, setPhone] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const create = async () => { setErr(null); try { onPick(await api("/customers", { body: { name, phone: phone || undefined } })); } catch (e) { setErr(e); } };
  return (
    <Modal open onClose={onClose} title="Select customer">
      <Input autoFocus aria-label="Search customers" placeholder="Name, phone or code" value={search} onChange={(e) => setSearch(e.target.value)} />
      <ul className="mt-2 max-h-60 divide-y divide-slate-100 overflow-y-auto">
        {list.data?.items.map((c: any) => <li key={c.id}><button className="flex w-full justify-between px-2 py-2 text-left text-sm hover:bg-slate-50" onClick={() => onPick(c)}><span>{c.name} <span className="text-slate-500">{c.phone}</span></span>{c.credit_status === "ACTIVE" && <Badge tone="blue">Credit</Badge>}</button></li>)}
      </ul>
      {can("customers.manage") && (
        <div className="mt-4 space-y-2 border-t border-slate-200 pt-3">
          <div className="text-sm font-medium">Quick add (optional details)</div>
          <div className="grid grid-cols-2 gap-2"><Input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /><Input aria-label="Phone" placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <ErrorText error={err} />
          <Button size="sm" disabled={name.trim().length < 2} onClick={create}>Add customer</Button>
        </div>
      )}
    </Modal>
  );
}

function HeldCarts({ branchId, onClose, onRecall }: { branchId: string; onClose: () => void; onRecall: (h: any) => void }) {
  const held = useApi<any[]>(`/held-carts?branch_id=${branchId}`);
  return (
    <Modal open onClose={onClose} title="Held carts" footer={<p className="mr-auto text-xs text-slate-500">Held carts do not reserve stock; prices are re-calculated on recall.</p>}>
      {held.isLoading ? <Spinner /> : !held.data?.length ? <p className="py-6 text-center text-sm text-slate-500">No held carts.</p> : (
        <ul className="divide-y divide-slate-100">{held.data.map((h) => (
          <li key={h.id} className="flex items-center justify-between py-2 text-sm"><span><strong>{h.label}</strong> · {h.payload.cart?.length ?? 0} lines</span><Button size="sm" onClick={async () => onRecall(await api(`/held-carts/${h.id}`, { method: "DELETE" }))}>Recall</Button></li>
        ))}</ul>
      )}
    </Modal>
  );
}

function SessionModal({ sessionInfo, onClose, onChanged }: { sessionInfo: any; onClose: () => void; onChanged: () => void }) {
  const { can, branchId } = useSession();
  const toast = useToast();
  const s = sessionInfo.session;
  const [dropAmount, setDropAmount] = useState(""); const [dropReason, setDropReason] = useState("Cash drop to safe");
  const [counted, setCounted] = useState(""); const [varianceReason, setVarianceReason] = useState("");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const approvals = useApprovalFlow();
  const variance = counted ? Number(counted) - Number(sessionInfo.expected_cash) : 0;
  const drop = async () => { setErr(null); setBusy(true); try { await api(`/cashier-sessions/${s.id}/movements`, { body: { kind: "CASH_DROP", amount: dropAmount, reason: dropReason }, idempotent: true }); toast("Cash drop recorded"); onChanged(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const close = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await approvals.run((approvalId) => api(`/cashier-sessions/${s.id}/close`, { body: { counted_cash: counted, variance_reason: varianceReason || undefined, approval_request_id: approvalId }, idempotent: true }), varianceReason);
      if (r) { toast(`Session ${s.number} closed`); onChanged(); }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Session ${s.number}`} size="lg">
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-1 text-sm">
          <h3 className="mb-2 font-semibold">Cash summary</h3>
          {[["Opening float", sessionInfo.opening_float], ["Cash sales (retained)", sessionInfo.cash_sales], ["Cash refunds", `-${sessionInfo.cash_refunds}`], ["Cash drops", `-${sessionInfo.cash_drops}`], ["Paid-outs", `-${sessionInfo.paid_outs}`]].map(([l, v]) => <div key={l} className="flex justify-between"><span className="text-slate-600">{l}</span><Money value={v} /></div>)}
          <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Expected in drawer</span><Money value={sessionInfo.expected_cash} /></div>
          <h3 className="mb-1 mt-4 font-semibold">Collections by method</h3>
          {sessionInfo.collections_by_method.map((c: any) => <div key={c.method} className="flex justify-between"><span className="text-slate-600">{humanize(c.method)} ({c.count})</span><Money value={c.amount} /></div>)}
        </div>
        <div className="space-y-5">
          {can("sessions.cash_drop") && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <h3 className="text-sm font-semibold">Cash drop to safe</h3>
              <div className="grid grid-cols-2 gap-2"><Input aria-label="Drop amount" placeholder="Amount" inputMode="decimal" value={dropAmount} onChange={(e) => setDropAmount(e.target.value)} /><Input aria-label="Drop reason" value={dropReason} onChange={(e) => setDropReason(e.target.value)} /></div>
              <Button size="sm" variant="secondary" disabled={!dropAmount} loading={busy} onClick={drop}>Record drop</Button>
            </div>
          )}
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <h3 className="text-sm font-semibold">Count and close</h3>
            <Field label="Counted cash in drawer">{(id) => <Input id={id} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} />}</Field>
            {counted && <div className={cx("text-sm", variance === 0 ? "text-emerald-700" : "text-amber-700")}>Variance: <strong className="num">{money(variance)}</strong></div>}
            {counted && variance !== 0 && <Field label="Variance explanation" required>{(id) => <Textarea id={id} rows={2} value={varianceReason} onChange={(e) => setVarianceReason(e.target.value)} />}</Field>}
            <Button variant="danger" disabled={!counted || (variance !== 0 && varianceReason.trim().length < 3)} loading={busy} onClick={close}>Close session</Button>
            <p className="text-xs text-slate-500">Counted cash is transferred to the branch safe. Large variances require approval.</p>
          </div>
          <ErrorText error={err} />
        </div>
      </div>
      {approvals.dialog(branchId)}
    </Modal>
  );
}
