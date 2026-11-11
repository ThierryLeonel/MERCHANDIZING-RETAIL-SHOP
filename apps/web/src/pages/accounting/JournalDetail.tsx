import { useState } from "react";
import { Link, useParams } from "react-router";
import { Badge, Button, Card, ConfirmDialog, DataTable, ErrorState, PageHeader, Spinner, Status, useToast } from "../../components/ui";
import { api } from "../../lib/api";
import { date, dateTime, humanize, money } from "../../lib/format";
import { useApi } from "../../lib/hooks";
import { useSession } from "../../lib/session";

const SOURCE_LINKS: Record<string, (id: string) => string> = { sale: (id) => `/sales/${id}` };

export default function JournalDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const { data: j, isLoading, error, refetch } = useApi<any>(`/accounting/journals/${id}`);
  const [reversing, setReversing] = useState(false);
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const link = SOURCE_LINKS[j.source_type]?.(j.source_id);
  return (
    <div className="space-y-5">
      <PageHeader title={`Journal ${j.number}`} subtitle={<>{date(j.entry_date)} · posted {dateTime(j.posted_at)} · <Badge>{humanize(j.source_type)}</Badge> {j.source_number && (link ? <Link className="text-brand-700 hover:underline" to={link}>{j.source_number}</Link> : j.source_number)} · <Status value={j.status} /></>}
        actions={j.is_manual && j.status === "POSTED" && can("accounting.journal") && <Button variant="secondary" onClick={() => setReversing(true)}>Reverse</Button>} />
      <Card title={j.description} padded={false}>
        <DataTable rows={j.lines} columns={[
          { key: "account", header: "Account", render: (l: any) => `${l.account_code} ${l.account_name}` }, { key: "memo", header: "Memo" },
          { key: "debit", header: "Debit", align: "right", render: (l: any) => (Number(l.debit) ? money(l.debit) : "") }, { key: "credit", header: "Credit", align: "right", render: (l: any) => (Number(l.credit) ? money(l.credit) : "") },
        ]} footer={<tfoot className="border-t-2 border-slate-300 font-semibold"><tr><td className="px-4 py-2" colSpan={2}>Totals</td><td className="num px-4 py-2 text-right">{money(j.total_debit)}</td><td className="num px-4 py-2 text-right">{money(j.total_credit)}</td></tr></tfoot>} />
      </Card>
      {j.reversal_of_id && <p className="text-sm">Reverses <Link className="text-brand-700 hover:underline" to={`/accounting/journals/${j.reversal_of_id}`}>original entry</Link>.</p>}
      {j.reversed_by_id && <p className="text-sm">Reversed by <Link className="text-brand-700 hover:underline" to={`/accounting/journals/${j.reversed_by_id}`}>reversal entry</Link>.</p>}
      <ConfirmDialog open={reversing} danger requireReason title="Reverse journal" message="A mirror-image entry will be posted today. The original stays visible." onClose={() => setReversing(false)} onConfirm={async (reason) => { await api(`/accounting/journals/${id}/reverse`, { body: { reason } }); toast("Reversal posted"); refetch(); }} />
    </div>
  );
}
