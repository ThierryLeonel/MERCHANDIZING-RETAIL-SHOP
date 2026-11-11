import { FormEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { Button, Card, DataTable, ErrorText, Field, Input, PageHeader, useToast } from "../components/ui";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";

export default function AccountPage() {
  const { me } = useSession();
  const [params] = useSearchParams();
  const toast = useToast();
  const sessions = useApi<any[]>("/auth/sessions");
  const [cur, setCur] = useState(""); const [next, setNext] = useState(""); const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const change = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (next !== confirm) return setErr(new Error("New passwords do not match"));
    setBusy(true);
    try { await api("/auth/change-password", { body: { current_password: cur, new_password: next } }); toast("Password changed; other sessions were signed out"); setCur(""); setNext(""); setConfirm(""); sessions.refetch(); }
    catch (e2) { setErr(e2); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-5">
      <PageHeader title="My account" subtitle={me?.user.email} />
      {params.get("change") && <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Please set a new password before continuing.</div>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Change password">
          <form onSubmit={change} className="space-y-3">
            <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />}</Field>
            <Field label="New password" hint="At least 10 characters with letters and numbers">{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} />}</Field>
            <Field label="Confirm new password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}</Field>
            <ErrorText error={err} />
            <Button type="submit" loading={busy}>Change password</Button>
          </form>
        </Card>
        <Card title="Active sessions" padded={false}>
          <DataTable rows={sessions.data} loading={sessions.isLoading} error={sessions.error} columns={[
            { key: "device", header: "Device", render: (s) => <span className="text-xs">{s.user_agent?.slice(0, 50) ?? "Unknown"}{s.current && <strong className="ml-1 text-brand-700">(this device)</strong>}</span> },
            { key: "last", header: "Last used", render: (s) => dateTime(s.last_used_at) },
            { key: "a", header: "", align: "right", render: (s) => !s.current && <Button size="sm" variant="secondary" onClick={async () => { await api(`/auth/sessions/${s.id}/revoke`, { method: "POST" }); sessions.refetch(); }}>Revoke</Button> },
          ]} />
        </Card>
      </div>
    </div>
  );
}
