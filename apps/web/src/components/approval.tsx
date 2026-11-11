import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { humanize, money } from "../lib/format";
import { Button, ErrorText, Field, Input, Modal, Tabs, Textarea } from "./ui";

/**
 * Handles APPROVAL_REQUIRED responses. Either an approver signs in on this
 * screen (single-use supervisor override) or the request is sent to the
 * Approvals queue and the user continues once it is approved.
 */
export function ApprovalDialog({ error, branchId, defaultReason, onApproved, onClose }: { error: ApiError | null; branchId: string | null; defaultReason?: string; onApproved: (approvalId: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState("here");
  const [reason, setReason] = useState(defaultReason ?? "");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [number, setNumber] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (error) { setReason(defaultReason ?? ""); setRequestId(null); setNumber(null); setErr(null); setPassword(""); } }, [error, defaultReason]);
  if (!error) return null;
  const type = error.details?.approval_type as string;
  const amount = error.details?.amount as string | undefined;

  const ensureRequest = async () => {
    if (requestId) return requestId;
    const r = await api<{ id: string; number: string }>("/approvals", { body: { type, reason, amount: amount ? String(Math.abs(Number(amount))) : undefined, branch_id: branchId ?? undefined, payload: error.details } });
    setRequestId(r.id); setNumber(r.number);
    return r.id;
  };
  const approveHere = async () => {
    setBusy(true); setErr(null);
    try { const id = await ensureRequest(); await api(`/approvals/${id}/override`, { body: { email, password, note: reason } }); onApproved(id); }
    catch (e) { setErr(e); } finally { setBusy(false); setPassword(""); }
  };
  const send = async () => {
    setBusy(true); setErr(null);
    try { await ensureRequest(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const check = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ status: string }>(`/approvals/${requestId}`);
      if (r.status === "APPROVED") onApproved(requestId!);
      else setErr(new Error(`Request is ${r.status.toLowerCase()}`));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Approval required: ${humanize(type ?? "")}`} footer={
      mode === "here" ? <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={<ShieldCheck className="h-4 w-4" />} loading={busy} disabled={reason.trim().length < 3 || !email || !password} onClick={approveHere}>Approve and continue</Button></>
        : requestId ? <><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy} onClick={check}>Check status and continue</Button></>
        : <><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={reason.trim().length < 3} onClick={send}>Send request</Button></>
    }>
      <div className="space-y-4 text-sm">
        <p className="rounded-md bg-amber-50 p-3 text-amber-900">{error.message}{amount && <> — amount <strong className="num">{money(Math.abs(Number(amount)))}</strong></>}</p>
        <Field label="Reason" required hint="Recorded with the approval and in the audit log">{(id, d) => <Textarea id={id} aria-describedby={d} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Tabs value={mode} onChange={setMode} tabs={[{ key: "here", label: "Approver is here" }, { key: "queue", label: "Send to approvals queue" }]} />
        {mode === "here" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <p className="sm:col-span-2 text-slate-600">An authorised approver (not you) signs in below. Their credentials are used once and are not stored on this device.</p>
            <Field label="Approver email">{(id) => <Input id={id} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label="Approver password">{(id) => <Input id={id} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          </div>
        ) : requestId ? (
          <p className="text-slate-700">Request <strong>{number}</strong> was sent. Ask an approver to approve it under <em>Approvals</em>, then continue.</p>
        ) : <p className="text-slate-600">The request is added to the Approvals queue for users with the right authority.</p>}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}

/** Runs an action; if the server requires approval, shows the dialog and retries with the approval id. */
export function useApprovalFlow() {
  const [pending, setPending] = useState<{ error: ApiError; retry: (approvalId: string) => Promise<unknown>; reason?: string } | null>(null);
  const run = async <T,>(action: (approvalId?: string) => Promise<T>, reason?: string): Promise<T | undefined> => {
    try { return await action(); }
    catch (e) {
      if (e instanceof ApiError && e.code === "APPROVAL_REQUIRED") {
        return new Promise<T | undefined>((resolve, reject) => setPending({ error: e, reason, retry: async (id) => { try { resolve(await action(id)); } catch (er) { reject(er); } } }));
      }
      throw e;
    }
  };
  const dialog = (branchId: string | null) => pending && (
    <ApprovalDialog error={pending.error} branchId={branchId} defaultReason={pending.reason} onClose={() => setPending(null)} onApproved={async (id) => { const p = pending; setPending(null); await p.retry(id); }} />
  );
  return { run, dialog };
}
