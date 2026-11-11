import { useState } from "react";
import { Badge, Button, Card, ConfirmDialog, DataTable, PageHeader, Pagination, Select, Status, useToast } from "../components/ui";
import { api } from "../lib/api";
import { dateTime, humanize, money } from "../lib/format";
import { useList } from "../lib/hooks";

export default function ApprovalsPage() {
  const [status, setStatus] = useState("PENDING");
  const list = useList<any>("/approvals", { status });
  const toast = useToast();
  const [deciding, setDeciding] = useState<{ row: any; decision: "APPROVE" | "REJECT" } | null>(null);
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Requests are decided by users holding the matching approval permission. You cannot approve your own requests." actions={
        <Select aria-label="Status filter" className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); list.setPage(1); }}>
          {["PENDING", "APPROVED", "REJECTED", "CONSUMED", "CANCELLED", ""].map((s) => <option key={s} value={s}>{s ? humanize(s) : "All"}</option>)}
        </Select>} />
      <Card padded={false}>
        <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRetry={list.refetch} columns={[
          { key: "number", header: "Request", render: (r) => <div><div className="font-medium">{r.number}</div><div className="text-xs text-slate-500">{dateTime(r.created_at)}</div></div> },
          { key: "type", header: "Type", render: (r) => <Badge tone="violet">{humanize(r.request_type)}</Badge> },
          { key: "reason", header: "Reason", render: (r) => <div className="max-w-sm"><div>{r.reason}</div><div className="text-xs text-slate-500">by {r.requested_by_name}</div></div> },
          { key: "amount", header: "Amount", align: "right", render: (r) => (r.amount ? money(r.amount) : "—") },
          { key: "status", header: "Status", render: (r) => <div><Status value={r.status} />{r.decided_by_name && <div className="mt-1 text-xs text-slate-500">{r.decided_by_name}{r.decision_note ? `: ${r.decision_note}` : ""}</div>}</div> },
          { key: "actions", header: "", align: "right", render: (r) => r.can_decide && (
            <div className="flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={() => setDeciding({ row: r, decision: "REJECT" })}>Reject</Button><Button size="sm" onClick={() => setDeciding({ row: r, decision: "APPROVE" })}>Approve</Button></div>
          ) },
        ]} />
        {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      </Card>
      <ConfirmDialog open={!!deciding} danger={deciding?.decision === "REJECT"} requireReason={deciding?.decision === "REJECT"} title={`${deciding?.decision === "APPROVE" ? "Approve" : "Reject"} ${deciding?.row.number}`}
        message={<>{humanize(deciding?.row.request_type ?? "")}: {deciding?.row.reason}{deciding?.row.amount && <> — {money(deciding.row.amount)}</>}</>}
        onClose={() => setDeciding(null)} onConfirm={async (note) => { await api(`/approvals/${deciding!.row.id}/decide`, { body: { decision: deciding!.decision, note: note || undefined } }); toast(`Request ${deciding!.decision === "APPROVE" ? "approved" : "rejected"}`); list.refetch(); }} />
    </div>
  );
}
