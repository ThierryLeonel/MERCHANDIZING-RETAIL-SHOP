import { AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Inbox, Loader2, X } from "lucide-react";
import { ButtonHTMLAttributes, createContext, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { humanize, money } from "../lib/format";
import { t } from "../i18n";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------------------------------------------------------------- buttons
type Variant = "primary" | "secondary" | "danger" | "ghost";
const variants: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 disabled:bg-brand-700/50",
  secondary: "bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50",
  ghost: "text-slate-700 hover:bg-slate-100 disabled:text-slate-400",
};
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }>(
  ({ variant = "primary", size = "md", loading, icon, className, children, disabled, ...rest }, ref) => (
    <button ref={ref} disabled={disabled || loading} className={cx("inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed", size === "sm" ? "h-8 px-3 text-sm" : size === "lg" ? "h-12 px-5 text-base" : "h-10 px-4 text-sm", variants[variant], className)} {...rest}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  ),
);

// ----------------------------------------------------------------- inputs
const inputCls = "block w-full rounded-md border border-slate-300 bg-white px-3 text-sm shadow-xs placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 disabled:bg-slate-100 aria-[invalid=true]:border-red-500";
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cx(inputCls, "h-10", className)} {...p} />);
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cx(inputCls, "py-2", className)} {...p} />);
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => <select ref={ref} className={cx(inputCls, "h-10 pr-8", className)} {...p}>{children}</select>);

/** Label + control + hint/error, wired with ids for accessibility. */
export function Field({ label, error, hint, children, required, className }: { label: string; error?: string | null; hint?: string; children: (id: string, describedBy?: string) => ReactNode; required?: boolean; className?: string }) {
  const id = useId();
  const descId = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">{label}{required && <span className="text-red-600" aria-hidden> *</span>}</label>
      {children(id, descId)}
      {error ? <p id={descId} className="mt-1 text-xs text-red-600">{error}</p> : hint ? <p id={descId} className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ layout
export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx("rounded-lg border border-slate-200 bg-white shadow-xs", className)}>
      {(title || actions) && <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3"><h2 className="text-sm font-semibold text-slate-800">{title}</h2><div className="flex items-center gap-2">{actions}</div></header>}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div><h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>{subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}</div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" | "ok" }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx("num mt-1 text-2xl font-semibold", tone === "warn" ? "text-amber-700" : "text-slate-900")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

const tones: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20", amber: "bg-amber-50 text-amber-800 ring-amber-600/20", red: "bg-red-50 text-red-700 ring-red-600/20",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20", slate: "bg-slate-100 text-slate-700 ring-slate-500/20", violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
};
const statusTone: Record<string, string> = {
  COMPLETED: "green", POSTED: "green", APPROVED: "green", CONFIRMED: "green", RECEIVED: "green", CLOSED: "slate", ACTIVE: "green", OPEN: "blue",
  FULLY_RECEIVED: "green", PARTIALLY_RECEIVED: "amber", DISPATCHED: "violet", PENDING: "amber", PENDING_PAYMENT: "amber", SUBMITTED: "amber", COUNTING: "blue",
  DRAFT: "slate", CANCELLED: "slate", REJECTED: "red", FAILED: "red", REVERSED: "slate", DISCONTINUED: "slate", CONSUMED: "slate", DISABLED: "red", ON_HOLD: "amber",
};
export function Badge({ children, tone = "slate" }: { children: ReactNode; tone?: keyof typeof tones }) {
  return <span className={cx("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone])}>{children}</span>;
}
export const Status = ({ value }: { value: string }) => <Badge tone={(statusTone[value] as any) ?? "slate"}>{humanize(value)}</Badge>;
export const Money = ({ value, className }: { value: string | number | null | undefined; className?: string }) => <span className={cx("num whitespace-nowrap", className)}>{money(value)}</span>;

// ------------------------------------------------------------------ states
export const Spinner = ({ label = t("common.loading") }: { label?: string }) => (
  <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" aria-hidden />{label}</div>
);
export function EmptyState({ title = t("common.empty"), children }: { title?: string; children?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-slate-500"><Inbox className="h-8 w-8 text-slate-300" aria-hidden /><div className="font-medium text-slate-700">{title}</div>{children}</div>;
}
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as ApiError;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="flex-1"><div className="font-medium">{e?.message ?? t("common.error")}</div>{e?.requestId && <div className="text-xs text-red-700/80">Reference: {e.requestId}</div>}</div>
      {onRetry && <Button size="sm" variant="secondary" onClick={onRetry}>{t("common.retry")}</Button>}
    </div>
  );
}
export const ErrorText = ({ error }: { error: unknown }) => (error ? <p role="alert" className="text-sm text-red-600">{(error as Error).message}</p> : null);

// ------------------------------------------------------------------- table
export interface Column<T> { key: string; header: ReactNode; render?: (row: T) => ReactNode; sortable?: boolean; align?: "right" | "left" | "center"; className?: string }
export function DataTable<T extends Record<string, any>>({ columns, rows, loading, error, onRetry, sort, onSort, empty, rowKey = "id", onRowClick, footer }: {
  columns: Column<T>[]; rows: T[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void; sort?: { key: string; order: "asc" | "desc" }; onSort?: (key: string) => void;
  empty?: ReactNode; rowKey?: string; onRowClick?: (row: T) => void; footer?: ReactNode;
}) {
  if (error) return <div className="p-4"><ErrorState error={error} onRetry={onRetry} /></div>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
          <tr>{columns.map((c) => (
            <th key={c.key} scope="col" className={cx("whitespace-nowrap px-4 py-2.5", c.align === "right" && "text-right", c.className)} aria-sort={sort?.key === c.key ? (sort.order === "asc" ? "ascending" : "descending") : undefined}>
              {c.sortable && onSort ? <button className="inline-flex items-center gap-1 hover:text-slate-800" onClick={() => onSort(c.key)}>{c.header}{sort?.key === c.key && (sort.order === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}</button> : c.header}
            </th>
          ))}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {loading && !rows ? <tr><td colSpan={columns.length}><Spinner /></td></tr>
            : !rows?.length ? <tr><td colSpan={columns.length}>{empty ?? <EmptyState />}</td></tr>
            : rows.map((r, i) => (
              <tr key={r[rowKey] ?? i} className={cx("hover:bg-slate-50", onRowClick && "cursor-pointer")} onClick={onRowClick ? () => onRowClick(r) : undefined} tabIndex={onRowClick ? 0 : undefined} onKeyDown={onRowClick ? (e) => e.key === "Enter" && onRowClick(r) : undefined}>
                {columns.map((c) => <td key={c.key} className={cx("px-4 py-2.5 align-middle", c.align === "right" && "num text-right", c.className)}>{c.render ? c.render(r) : r[c.key]}</td>)}
              </tr>
            ))}
        </tbody>
        {footer}
      </table>
    </div>
  );
}
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between border-t border-slate-200 px-4 py-2.5 text-sm text-slate-600">
      <span>{total === 0 ? "No results" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}</span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="px-2">Page {page} of {pages}</span>
        <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </nav>
  );
}
export function SearchInput({ value, onChange, placeholder = t("common.search"), className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => { const h = setTimeout(() => v !== value && onChange(v), 300); return () => clearTimeout(h); }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Input type="search" aria-label={placeholder} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} className={cx("max-w-xs", className)} />;
}

// ------------------------------------------------------------------- modal
export function Modal({ open, onClose, title, children, footer, size = "md" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input,select,textarea,button:not([aria-label='Close'])");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("a,button,input,select,textarea,[tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled"));
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 no-print" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className={cx("flex max-h-[90vh] w-full flex-col rounded-lg bg-white shadow-xl", size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-3xl" : size === "xl" ? "max-w-5xl" : "max-w-lg")}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose}><X className="h-5 w-5" /></button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation with mandatory reason capture for sensitive actions. */
export function ConfirmDialog({ open, title, message, confirmLabel = t("common.confirm"), requireReason, onConfirm, onClose, danger }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; requireReason?: boolean; onConfirm: (reason: string) => Promise<unknown> | void; onClose: () => void; danger?: boolean }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (open) { setReason(""); setErr(null); } }, [open]);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await onConfirm(reason); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={<><Button variant="secondary" onClick={onClose}>{t("common.cancel")}</Button><Button variant={danger ? "danger" : "primary"} loading={busy} disabled={requireReason && reason.trim().length < 3} onClick={go}>{confirmLabel}</Button></>}>
      <div className="space-y-3 text-sm text-slate-700">
        <div>{message}</div>
        {requireReason && <Field label="Reason" required hint="Recorded in the audit log">{(id, d) => <Textarea id={id} aria-describedby={d} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------- tabs
export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string; hidden?: boolean }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.filter((x) => !x.hidden).map((tab) => (
        <button key={tab.key} role="tab" aria-selected={value === tab.key} onClick={() => onChange(tab.key)} className={cx("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", value === tab.key ? "border-brand-700 text-brand-800" : "border-transparent text-slate-500 hover:text-slate-800")}>{tab.label}</button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; message: string; tone: "ok" | "error" }
const ToastCtx = createContext<(m: string, tone?: "ok" | "error") => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, message, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2 no-print">
        {items.map((i) => (
          <div key={i.id} className={cx("pointer-events-auto flex items-center gap-2 rounded-md px-4 py-2.5 text-sm text-white shadow-lg", i.tone === "ok" ? "bg-slate-900" : "bg-red-600")}>
            {i.tone === "ok" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{i.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
