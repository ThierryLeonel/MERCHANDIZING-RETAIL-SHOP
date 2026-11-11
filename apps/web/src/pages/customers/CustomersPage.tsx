import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, DataTable, ErrorText, Field, Input, Modal, PageHeader, Pagination, SearchInput, Select, Tabs } from "../../components/ui";
import { api } from "../../lib/api";
import { money } from "../../lib/format";
import { useApi, useList } from "../../lib/hooks";
import { useSession } from "../../lib/session";

export default function CustomersPage() {
  const { can } = useSession();
  const nav = useNavigate();
  const [tab, setTab] = useState("list");
  const list = useList<any>("/customers", {}, { sort: "name", order: "asc" });
  const ageing = useApi<any>(tab === "ageing" ? "/customers/ageing" : null);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Customers" subtitle="Walk-in sales need no customer. Credit accounts have limits and terms." actions={can("customers.manage") && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>New customer</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ key: "list", label: "Customers" }, { key: "ageing", label: "Receivables ageing" }]} />
      {tab === "list" ? (
        <Card padded={false}>
          <div className="border-b border-slate-200 p-3"><SearchInput value={list.search} onChange={list.setSearch} placeholder="Name, phone or code" /></div>
          <DataTable rows={list.data?.items} loading={list.isLoading} error={list.error} sort={list.sort} onSort={list.onSort} onRowClick={(c) => nav(`/customers/${c.id}`)} columns={[
            { key: "code", header: "Code", sortable: true }, { key: "name", header: "Name", sortable: true }, { key: "phone", header: "Phone" },
            { key: "credit", header: "Credit", render: (c) => (c.credit_status === "ACTIVE" ? <Badge tone="blue">Limit {money(c.credit_limit)}</Badge> : c.credit_status === "ON_HOLD" ? <Badge tone="amber">On hold</Badge> : "—") },
          ]} />
          {list.data && <Pagination page={list.page} pageSize={list.pageSize} total={list.data.total} onPage={list.setPage} />}
        </Card>
      ) : (
        <Card padded={false} title={`Receivables ageing as of ${ageing.data?.as_of ?? ""} (by due date)`}>
          <DataTable rowKey="customer_id" rows={ageing.data?.rows} loading={ageing.isLoading} error={ageing.error} onRowClick={(r) => nav(`/customers/${r.customer_id}`)} columns={[
            { key: "name", header: "Customer" }, ...["current", "d1_30", "d31_60", "d61_90", "d90_plus", "total"].map((k) => ({ key: k, header: k === "current" ? "Current" : k === "total" ? "Total" : k.replace("d", "").replace("_", "–").replace("plus", "+") + " days", align: "right" as const, render: (r: any) => money(r[k]) })),
          ]} />
        </Card>
      )}
      {open && <CustomerForm onClose={() => setOpen(false)} onDone={(c) => { setOpen(false); nav(`/customers/${c.id}`); }} />}
    </div>
  );
}

export function CustomerForm({ customer, onClose, onDone }: { customer?: any; onClose: () => void; onDone: (c: any) => void }) {
  const { can } = useSession();
  const groups = useApi<any[]>("/customers/groups");
  const [f, setF] = useState({ name: customer?.name ?? "", phone: customer?.phone ?? "", email: customer?.email ?? "", address: customer?.address ?? "", customer_group_id: customer?.customer_group_id ?? "", credit_status: customer?.credit_status ?? "NONE", credit_limit: customer?.credit_limit ?? "0", payment_terms_days: String(customer?.payment_terms_days ?? 0) });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr(null);
    const body: any = { name: f.name, phone: f.phone || undefined, email: f.email || undefined, address: f.address || undefined, customer_group_id: f.customer_group_id || undefined };
    if (can("customers.credit")) Object.assign(body, { credit_status: f.credit_status, credit_limit: f.credit_limit || "0", payment_terms_days: Number(f.payment_terms_days || 0) });
    try { onDone(await api(customer ? `/customers/${customer.id}` : "/customers", { method: customer ? "PATCH" : "POST", body })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={customer ? `Edit ${customer.name}` : "New customer"} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={f.name.trim().length < 2} onClick={save}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required className="sm:col-span-2">{(id) => <Input id={id} value={f.name} onChange={set("name")} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={f.phone} onChange={set("phone")} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" value={f.email} onChange={set("email")} />}</Field>
        <Field label="Address" className="sm:col-span-2">{(id) => <Input id={id} value={f.address} onChange={set("address")} />}</Field>
        <Field label="Group (price list)">{(id) => <Select id={id} value={f.customer_group_id} onChange={set("customer_group_id")}><option value="">—</option>{groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}</Field>
        {can("customers.credit") && <>
          <Field label="Credit account">{(id) => <Select id={id} value={f.credit_status} onChange={set("credit_status")}><option value="NONE">No credit</option><option value="ACTIVE">Active</option><option value="ON_HOLD">On hold</option></Select>}</Field>
          <Field label="Credit limit">{(id) => <Input id={id} value={f.credit_limit} onChange={set("credit_limit")} />}</Field>
          <Field label="Payment terms (days)">{(id) => <Input id={id} value={f.payment_terms_days} onChange={set("payment_terms_days")} />}</Field>
        </>}
      </div>
      <ErrorText error={err} />
    </Modal>
  );
}
