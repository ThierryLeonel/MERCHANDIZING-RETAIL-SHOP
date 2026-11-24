import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";
import { PrintButton, PrintSheet } from "../../components/print";
import { Badge, Card, ErrorText, Input, Kpi, PageHeader, Select, Spinner } from "../../components/ui";
import { money } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

interface Decl { declared_at: string; branch: string | null; note: string | null; total: string; system_total: string; variance: string; lines: { account: string; kind: string | null; declared: string; system: string; variance: string }[] }
interface Row { user_id: string; name: string; roles: string[]; required: boolean; opening: Decl | null; closing: Decl | null }
interface Report { date: string; required_roles: string[]; rows: Row[]; summary: { people: number; opened: number; closed: number; missing_opening: number; missing_closing: number } }

const time = (s: string) => new Date(s).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Douala" }).format(new Date());

function Variance({ v }: { v: string }) {
  const n = Number(v);
  if (!n) return <Badge tone="green">Matches</Badge>;
  return <Badge tone={n < 0 ? "red" : "amber"}>{n > 0 ? "+" : ""}{money(v)}</Badge>;
}

function Cell({ d, label }: { d: Decl | null; label: string }) {
  if (!d) return <Badge tone="red">Not declared</Badge>;
  return <div className="space-y-0.5"><div className="num font-medium">{money(d.total)}</div><div className="text-xs text-slate-500">{time(d.declared_at)}{d.branch ? ` · ${d.branch}` : ""}</div><Variance v={d.variance} /><span className="sr-only">{label}</span></div>;
}

/** Who declared their opening and closing balances on a day, compared with the system balances. */
export default function DeclarationsPage() {
  const { me } = useSession();
  const [date, setDate] = useState(today());
  const [branch, setBranch] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = useApi<Report>(`/declarations?date=${date}${branch ? `&branch_id=${branch}` : ""}`, [], { staleTime: 0 });
  const r = q.data;

  return (
    <div>
      <PageHeader title="Daily declarations" subtitle="Opening and closing balances declared by staff each day, compared with the system balances at that moment."
        actions={<PrintButton target="declarations-print" />} />
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block"><span className="text-sm font-medium text-slate-700">Day</span><Input type="date" className="w-44" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
          <label className="block"><span className="text-sm font-medium text-slate-700">Branch</span>
            <Select className="w-56" value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">All my branches</option>{me?.branches.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.name}</option>)}</Select>
          </label>
          {r && <p className="text-sm text-slate-500">Required for: {r.required_roles.map((x) => x.replace(/_/g, " ").toLowerCase()).join(", ") || "nobody"} (Administration → Business settings)</p>}
        </div>
      </Card>
      <ErrorText error={q.error} />
      {!r ? <Spinner /> : (
        <PrintSheet id="declarations-print" title="Daily declarations" subtitle={date}><div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="Staff required" value={String(r.summary.people)} />
            <Kpi label="Opened the day" value={`${r.summary.opened}`} />
            <Kpi label="Missing opening" value={String(r.summary.missing_opening)} tone={r.summary.missing_opening ? "warn" : "ok"} />
            <Kpi label="Missing closing" value={String(r.summary.missing_closing)} tone={r.summary.missing_closing ? "warn" : "ok"} />
          </div>
          <Card padded={false}>
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr><th className="w-8 px-3 py-2.5" /><th className="px-3 py-2.5 sm:px-4">Person</th><th className="px-3 py-2.5 sm:px-4">Opening</th><th className="px-3 py-2.5 sm:px-4">Closing</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {!r.rows.length && <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">Nobody is required to declare and nobody declared on this day.</td></tr>}
                  {r.rows.map((row) => (
                    <Fragment key={row.user_id}>
                      <tr className="align-top transition-colors hover:bg-slate-50">
                        <td className="px-3 py-3">{(row.opening || row.closing) && <button aria-label={`Details for ${row.name}`} className="rounded p-0.5 text-slate-500 hover:bg-slate-100" onClick={() => setOpen((o) => ({ ...o, [row.user_id]: !o[row.user_id] }))}>{open[row.user_id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>}</td>
                        <td className="px-3 py-3 sm:px-4"><div className="font-medium text-slate-900">{row.name}</div><div className="text-xs text-slate-500">{row.roles.join(", ")}{!row.required && " · not required"}</div></td>
                        <td className="px-3 py-3 sm:px-4"><Cell d={row.opening} label="opening" /></td>
                        <td className="px-3 py-3 sm:px-4"><Cell d={row.closing} label="closing" /></td>
                      </tr>
                      {open[row.user_id] && (
                        <tr className="bg-slate-50/60"><td />
                          <td colSpan={3} className="px-3 pb-4 sm:px-4">
                            {(["opening", "closing"] as const).map((k) => row[k] && (
                              <div key={k} className="mt-2">
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{k}{row[k]!.note ? ` — “${row[k]!.note}”` : ""}</div>
                                <table className="w-full text-sm"><thead className="text-left text-xs text-slate-500"><tr><th className="py-1 pr-3">Account</th><th className="py-1 pr-3 text-right">Declared</th><th className="py-1 pr-3 text-right">System</th><th className="py-1 text-right">Difference</th></tr></thead>
                                  <tbody>{row[k]!.lines.map((l) => <tr key={l.account}><td className="py-1 pr-3">{l.account}</td><td className="num py-1 pr-3 text-right">{money(l.declared)}</td><td className="num py-1 pr-3 text-right">{money(l.system)}</td><td className="py-1 text-right"><Variance v={l.variance} /></td></tr>)}</tbody>
                                </table>
                              </div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="text-xs text-slate-500">“System” is the account's book balance when the person declared. Declarations are blind — staff do not see the system balance — and cannot be changed. A shared account (a safe or wallet) is declared by each person who holds part of it, so compare per person with care.</p>
        </div></PrintSheet>
      )}
    </div>
  );
}
