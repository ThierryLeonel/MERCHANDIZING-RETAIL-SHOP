import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { PermissionCode } from "@retail/api-contracts";
import { api, refresh, setAccessToken } from "./api";
import { setBusinessFormat } from "./format";
import { setLocale } from "../i18n";

export interface Me {
  user: { id: string; email: string; full_name: string; roles: string[]; default_branch_id: string | null };
  permissions: string[];
  branches: { id: string; code: string; name: string; kind: string }[];
  business: { id: string; name: string; currency_code: string; currency_decimals: number; timezone: string; locale: string; prices_include_tax: boolean; receipt_footer: string | null; phone: string | null; address: string | null; tax_id: string | null; is_demo: boolean };
}
interface Ctx {
  me: Me | null; loading: boolean; branchId: string | null; setBranchId: (id: string) => void;
  can: (p: PermissionCode) => boolean; login: (email: string, password: string) => Promise<{ must_change_password: boolean }>; logout: () => Promise<void>; reload: () => Promise<void>;
}
const SessionCtx = createContext<Ctx>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [branchId, setBranchIdState] = useState<string | null>(() => sessionStorage.getItem("branchId"));

  const load = useCallback(async () => {
    try {
      const m = await api<Me>("/auth/me");
      setMe(m);
      setBusinessFormat(m.business);
      setLocale(m.business.locale);
      const valid = m.branches.find((b) => b.id === branchId) ? branchId : (m.user.default_branch_id && m.branches.find((b) => b.id === m.user.default_branch_id) ? m.user.default_branch_id : m.branches[0]?.id ?? null);
      setBranchIdState(valid);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    // try a silent refresh on first load (refresh cookie)
    refresh() // shared, de-duplicated refresh (StrictMode / concurrent callers)
      .then(async (ok) => { if (ok) await load(); else setLoading(false); })
      .catch(() => setLoading(false));
    const onExpired = () => setMe(null);
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<Ctx>(() => ({
    me, loading, branchId,
    setBranchId: (id) => { sessionStorage.setItem("branchId", id); setBranchIdState(id); },
    can: (p) => !!me?.permissions.includes(p),
    login: async (email, password) => {
      const r = await api<{ access_token: string; must_change_password: boolean }>("/auth/login", { body: { email, password } });
      setAccessToken(r.access_token);
      await load();
      return r;
    },
    logout: async () => { try { await api("/auth/logout", { method: "POST" }); } finally { setAccessToken(null); setMe(null); } },
    reload: load,
  }), [me, loading, branchId, load]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
export const useSession = () => useContext(SessionCtx);
