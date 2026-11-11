import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, qs } from "./api";

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  return useQuery<T>({ queryKey: [path, ...deps], queryFn: () => api<T>(path!), enabled: !!path, placeholderData: keepPreviousData });
}
/** Paged list state (search, sort, page) bound to an API path. */
export function useList<T = any>(base: string | null, extra: Record<string, unknown> = {}, defaults: { sort?: string; order?: "asc" | "desc"; pageSize?: number; search?: string } = {}) {
  const [page, setPage] = useState(1);
  const [search, setSearchState] = useState(defaults.search ?? "");
  const [sort, setSort] = useState<{ key: string; order: "asc" | "desc" }>({ key: defaults.sort ?? "", order: defaults.order ?? "desc" });
  const pageSize = defaults.pageSize ?? 25;
  const path = base ? `${base}${qs({ page, pageSize, search, sort: sort.key || undefined, order: sort.order, ...extra })}` : null;
  const q = useApi<{ items: T[]; total: number; page: number; pageSize: number }>(path);
  return {
    ...q, page, setPage, search, pageSize, sort,
    setSearch: (s: string) => { setSearchState(s); setPage(1); },
    onSort: (key: string) => setSort((s) => ({ key, order: s.key === key && s.order === "asc" ? "desc" : "asc" })),
  };
}
export function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}
export { useMutation };
