import { dateTime, humanize, money, qty } from "../../lib/format";
import { useSession } from "../../lib/session";

/** 80 mm thermal-style receipt; printed via window.print() (print CSS isolates .print-area). */
export function Receipt({ sale }: { sale: any }) {
  const { me } = useSession();
  const b = me?.business;
  return (
    <div className="print-area mx-auto w-[300px] bg-white p-3 font-mono text-[12px] leading-snug text-black">
      <div className="text-center">
        <div className="text-[14px] font-bold">{b?.name}</div>
        {sale.branch && <div>{sale.branch.name}</div>}
        {b?.address && <div>{b.address}</div>}
        {b?.phone && <div>Tel: {b.phone}</div>}
        {b?.tax_id && <div>Tax ID: {b.tax_id}</div>}
      </div>
      <div className="my-2 border-t border-dashed border-black" />
      <div className="flex justify-between"><span>Receipt</span><span>{sale.number}</span></div>
      <div className="flex justify-between"><span>Date</span><span>{dateTime(sale.completed_at ?? sale.created_at)}</span></div>
      <div className="flex justify-between"><span>Cashier</span><span>{sale.cashier_name}</span></div>
      {sale.customer && <div className="flex justify-between"><span>Customer</span><span>{sale.customer.name}</span></div>}
      <div className="my-2 border-t border-dashed border-black" />
      {sale.lines.map((l: any) => (
        <div key={l.id} className="mb-1">
          <div>{l.description}</div>
          <div className="flex justify-between"><span>{qty(l.quantity)} {l.unit_code} × {money(l.unit_price, { symbol: false })}</span><span>{money(l.gross_amount, { symbol: false })}</span></div>
          {Number(l.discount_amount) > 0 && <div className="flex justify-between"><span>  Discount</span><span>-{money(l.discount_amount, { symbol: false })}</span></div>}
        </div>
      ))}
      <div className="my-2 border-t border-dashed border-black" />
      <Row label={b?.prices_include_tax ? "Total (tax incl.)" : "Subtotal (excl. tax)"} value={b?.prices_include_tax ? sale.total : sale.net_amount} />
      {Number(sale.tax_total) > 0 && <Row label={b?.prices_include_tax ? "Of which tax" : "Tax"} value={sale.tax_total} />}
      <Row label="TOTAL" value={sale.total} bold />
      <div className="my-2 border-t border-dashed border-black" />
      {sale.payments.filter((p: any) => p.status === "CONFIRMED").map((p: any) => (
        <div key={p.id}>
          <Row label={humanize(p.method)} value={p.amount_tendered ?? p.amount} />
          {p.provider_reference && p.method !== "CASH" && <div className="text-[11px]">  Ref: {p.provider_reference}</div>}
        </div>
      ))}
      {Number(sale.credit_amount) > 0 && <Row label="On account" value={sale.credit_amount} />}
      {Number(sale.change_given) > 0 && <Row label="Change" value={sale.change_given} />}
      <div className="my-2 border-t border-dashed border-black" />
      <div className="text-center">{b?.receipt_footer}</div>
      {b?.is_demo && <div className="mt-1 text-center font-bold">*** DEMO — NOT A VALID RECEIPT ***</div>}
    </div>
  );
}
const Row = ({ label, value, bold }: { label: string; value: string; bold?: boolean }) => (
  <div className={`flex justify-between ${bold ? "text-[14px] font-bold" : ""}`}><span>{label}</span><span>{money(value, { symbol: false })}</span></div>
);
