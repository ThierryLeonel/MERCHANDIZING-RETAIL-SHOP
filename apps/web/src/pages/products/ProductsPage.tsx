import { FolderTree, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Badge, Button, Card, DataTable, PageHeader, Pagination, SearchInput, Select, Status } from "../../components/ui";
import { humanize, money } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function ProductsPage() {
  const { can } = useSession();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [category, setCategory] = useState(params.get("category_id") ?? "");
  const [status, setStatus] = useState("ACTIVE");
  const ref = useApi<any>("/catalogue/reference");
  const list = useList<any>("/products", { category_id: category, status }, { sort: "name", order: "asc" });
  return (
    <div>
      <PageHeader title="Products" subtitle="Catalogue of products and sellable variants (SKUs)" actions={<><Link to="/products/setup"><Button variant="secondary" icon={<FolderTree className="h-4 w-4" />}>Categories & units</Button></Link>{can("products.manage") && <Link to="/products/new"><Button icon={<Plus className="h-4 w-4" />}>New product</Button></Link>}</>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3">
          <SearchInput value={list.search} onChange={list.setSearch} placeholder="Search name, code, SKU or barcode" />
          <Select aria-label="Category" className="w-52" value={category} onChange={(e) => { setCategory(e.target.value); list.setPage(1); }}><option value="">All categories</option>{ref.data?.categories.map((c: any) => <option key={c.id} value={c.id}>{c.parent_id ? `${ref.data.categories.find((x: any) => x.id === c.parent_id)?.name ?? ""} › ` : ""}{c.name}</option>)}</Select>
          <Select aria-label="Status" className="w-40" value={status} onChange={(e) => { setStatus(e.target.value); list.setPage(1); }}><option value="ACTIVE">Active</option><option value="DISCONTINUED">Discontinued</option><option value="">All</option></Select>
        </div>
        <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} onRetry={list.refetch} sort={list.sort} onSort={list.onSort} onRowClick={(p) => nav(`/products/${p.id}`)} columns={[
          { key: "name", header: "Product", sortable: true, render: (p) => <div><div className="font-medium">{p.name}</div><div className="text-xs text-slate-500">{p.code}</div></div> },
          { key: "type", header: "Type", render: (p) => <div className="flex flex-wrap gap-1"><Badge tone={p.product_type === "NON_STOCK" ? "violet" : p.product_type === "BULK" ? "blue" : "slate"}>{p.product_type === "BULK" ? "Bulk / loose" : humanize(p.product_type)}</Badge>{p.negotiable_price && <Badge tone="amber">Bargain</Badge>}</div> },
          { key: "category", header: "Category", render: (p) => p.category_name ?? "—" },
          { key: "brand", header: "Brand", render: (p) => p.brand_name ?? "—" },
          { key: "skus", header: "SKUs", align: "right", render: (p) => p.variants.length },
          { key: "price", header: "Retail price", align: "right", render: (p) => { const prices = p.variants.map((v: any) => Number(v.retail_price)); const min = Math.min(...prices), max = Math.max(...prices); return min === max ? money(min) : `${money(min)} – ${money(max)}`; } },
          { key: "status", header: "Status", render: (p) => <Status value={p.status} /> },
        ]} />
        {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
      </Card>
    </div>
  );
}
