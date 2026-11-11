import { FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { t } from "../i18n";
import { useSession } from "../lib/session";

export function LoginPage() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation() as any;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await login(email, password);
      navigate(r.must_change_password ? "/account?change=1" : (location.state?.from ?? "/"), { replace: true });
    } catch (err) { setError(err); } finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="login-title">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-700 font-bold text-white">RS</div>
          <div><h1 id="login-title" className="text-lg font-semibold">Retail Suite</h1><p className="text-sm text-slate-500">{t("auth.signin")} to continue</p></div>
        </div>
        <Field label={t("auth.email")}>{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label={t("auth.password")}>{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <ErrorText error={error} />
        <Button type="submit" className="w-full" loading={busy}>{t("auth.signin")}</Button>
        <p className="text-center text-xs text-slate-500">Internet connection required. Sessions expire automatically.</p>
      </form>
    </div>
  );
}
