import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Button, ErrorText, Input, Textarea } from "./ui";

export interface DeclStatus {
  required: boolean; business_date: string;
  opening: { declared_at: string; total: string } | null; closing: { declared_at: string; total: string } | null;
  missed_closing_yesterday: boolean;
  accounts: { id: string; code: string; name: string; kind: string; branch_id: string | null }[];
}
const KIND: Record<string, string> = { TILL: "Till (cash drawer)", SAFE: "Safe", PETTY_CASH: "Petty cash", MOBILE_MONEY: "Mobile money", BANK: "Bank" };

export function useDayDeclaration() {
  const { branchId, me } = useSession();
  return useApi<DeclStatus>(me && branchId ? `/declarations/me?branch_id=${branchId}` : null, [], { staleTime: 0 });
}

/**
 * Start / end of day declaration. Blind: the person types what they hold; the system balance is not shown.
 * Rendered as a full-screen sheet that cannot be dismissed when the declaration is mandatory.
 */
export function DeclarationSheet({ kind, status, onDone, onCancel, onSignOut, signingOut }: { kind: "OPENING" | "CLOSING"; status: DeclStatus; onDone: () => void; onCancel?: () => void; onSignOut?: () => void; signingOut?: boolean }) {
  const { branchId, me } = useSession();
  const qc = useQueryClient();
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const branch = me?.branches.find((b) => b.id === branchId);
  const filled = Object.values(amounts).filter((v) => v.trim() !== "").length;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await api("/declarations", { body: { kind, branch_id: branchId, note: note || undefined, lines: status.accounts.filter((a) => (amounts[a.id] ?? "").trim() !== "").map((a) => ({ financial_account_id: a.id, amount: amounts[a.id].replace(/\s/g, "").replace(",", ".") })) } });
      await qc.invalidateQueries({ queryKey: [`/declarations/me?branch_id=${branchId}`] });
      onDone();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };

  return (
    <div className="anim-fade fixed inset-0 z-[70] flex items-end justify-center bg-slate-900/50 backdrop-blur-[2px] sm:items-center sm:p-4 no-print">
      <div role="dialog" aria-modal="true" aria-labelledby="decl-title" className="anim-pop flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl">
        <header className="border-b border-slate-200 px-4 py-3 sm:px-5">
          <h2 id="decl-title" className="text-base font-semibold">{kind === "OPENING" ? "Start of day — opening balances" : "End of day — closing balances"}</h2>
          {signingOut && <p className="mt-1 text-sm font-medium text-amber-700">Declare your closing balances before signing out.</p>}
          <p className="mt-0.5 text-sm text-slate-500">{status.business_date} · {branch?.name}. Count and enter the money you hold in each account you are responsible for{kind === "OPENING" ? " as you start" : " as you finish"}. Leave accounts you do not hold empty; enter 0 if one is empty.</p>
        </header>
        <div className="space-y-3 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
          {kind === "OPENING" && status.missed_closing_yesterday && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Yesterday's closing balances were not declared. Your manager will see this.</p>}
          {status.accounts.map((a, i) => (
            <label key={a.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-800">{a.name}</span><span className="block text-xs text-slate-500">{KIND[a.kind] ?? a.kind}{a.branch_id ? "" : " · all branches"}</span></span>
              <Input ref={i === 0 ? first : undefined} inputMode="decimal" placeholder="XAF" aria-label={`${kind === "OPENING" ? "Opening" : "Closing"} balance of ${a.name}`} className="w-full sm:w-40" value={amounts[a.id] ?? ""} onChange={(e) => setAmounts((p) => ({ ...p, [a.id]: e.target.value }))} />
            </label>
          ))}
          <label className="block"><span className="text-sm font-medium text-slate-700">Note (optional)</span><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything your manager should know" /></label>
          <ErrorText error={err} />
          <p className="text-xs text-slate-500">Declarations cannot be changed afterwards. Your manager compares them with the system balances.</p>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
          <div>{onSignOut && <Button variant="ghost" icon={<LogOut className="h-4 w-4" />} onClick={onSignOut}>Sign out</Button>}</div>
          <div className="flex flex-wrap gap-2">
            {onCancel && <Button variant="secondary" onClick={onCancel}>{signingOut ? "Back" : "Not now"}</Button>}
            <Button loading={busy} disabled={!filled} onClick={submit}>{kind === "OPENING" ? "Declare and start" : signingOut ? "Declare and sign out" : "Declare closing balances"}</Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
