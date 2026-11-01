"use client";

// «العملاء» in «واجهة المحاسب» (owner decision, 1 Nov 2026): every customer from the accounting side — the particulars a
// tax invoice carries, the balance, what is overdue, the credit limit and the rep (read only) — without the customers
// module. Per row: «كشف الحساب», «عرض سعر» (a quotation with no deal), «فاتورة». The accountant adds a customer and
// corrects its invoice particulars; deals, activities, notes and the rep stay Sales'. Every rule is the API's.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Dialog } from "@/components/hr/ui";
import { AcctShell, Msg, money, useApi, useLang, useWrite } from "../_ui/shell";

type Row = {
  id: string; name: string; nameAr: string | null; vatNumber: string | null; commercialRegNo: string | null; city: string | null; address: string | null;
  phone: string | null; email: string | null; creditLimit: string | null; paymentTermsDays: number | null; repName: string | null; balance: string; overdue: string;
};
type Form = { name: string; nameAr: string; vatNumber: string; commercialRegNo: string; city: string; address: string; phone: string; email: string };
const blank: Form = { name: "", nameAr: "", vatNumber: "", commercialRegNo: "", city: "", address: "", phone: "", email: "" };

export default function AccountingCustomersPage() {
  return <Suspense fallback={null}><CustomersPage /></Suspense>;
}

function CustomersPage() {
  const { L } = useLang();
  const router = useRouter();
  const [q, setQ] = useState("");
  const api = useApi<{ rows: Row[]; can: { write: boolean } }>(`/api/accounting/customers?q=${encodeURIComponent(q)}`);
  const w = useWrite();
  const [edit, setEdit] = useState<{ id: string | null; form: Form } | null>(null);
  const rows = useMemo(() => api.data?.rows ?? [], [api.data]);
  const can = api.data?.can.write ?? false;
  // «+» of the sidebar (?new=1): the new-customer form, once the page knows the viewer may write.
  const sp = useSearchParams();
  const wantsNew = sp.get("new") === "1";
  useEffect(() => {
    if (wantsNew && can) { router.replace("/dashboard/accounting/customers"); Promise.resolve().then(() => setEdit({ id: null, form: blank })); }
  }, [wantsNew, can, router]);

  const save = async () => {
    if (!edit) return;
    const r = edit.id
      ? await w.run("save", `/api/accounting/customers/${edit.id}`, "PATCH", edit.form, L("حُفظت بيانات العميل.", "Saved."))
      : await w.run("save", "/api/accounting/customers", "POST", edit.form, L("أُضيف العميل.", "Customer added."));
    if (r) { setEdit(null); api.reload(); }
  };
  const quote = async (c: Row) => {
    const r = await w.run<{ quote: { id: string } }>(`q-${c.id}`, "/api/sales/quotes", "POST", { customerId: c.id, lines: [] });
    if (r) router.push(`/dashboard/accounting/quotes/${r.quote.id}`);
  };
  const f = (k: keyof Form, ar: string, en: string, ltr = false) => (
    <label className="hr-field" key={k}><span className="hr-label">{L(ar, en)}</span>
      <input className="hr-input" dir={ltr ? "ltr" : undefined} value={edit?.form[k] ?? ""} onChange={(e) => edit && setEdit({ ...edit, form: { ...edit.form, [k]: e.target.value } })} data-testid={`acust-${k}`} /></label>
  );

  return (
    <AcctShell title={L("العملاء", "Customers")} actions={can ? <button type="button" className="hr-btn is-primary" onClick={() => setEdit({ id: null, form: blank })} data-testid="acust-new">{L("+ عميل جديد", "+ New customer")}</button> : null}>
      <Msg error={w.error ?? api.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      <div className="acct-row">
        <label className="hr-field acct-grow"><span className="hr-label">{L("بحث بالاسم أو الرقم الضريبي أو الجوال", "Search by name, VAT or phone")}</span>
          <input className="hr-input" value={q} onChange={(e) => setQ(e.target.value)} data-testid="acust-search" /></label>
      </div>
      {!api.data ? <OpsLoading /> : rows.length === 0 ? <p className="acct-hint">{L("لا عملاء.", "No customers.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense" data-testid="acust-table">
            <thead><tr>
              <th>{L("العميل", "Customer")}</th><th>{L("الرقم الضريبي", "VAT")}</th><th>{L("السجل التجاري", "CR")}</th><th>{L("المدينة", "City")}</th><th>{L("الجوال", "Phone")}</th>
              <th className="num">{L("الرصيد", "Balance")}</th><th className="num">{L("المتأخر", "Overdue")}</th><th className="num">{L("حد الائتمان", "Credit limit")}</th><th>{L("المندوب", "Rep")}</th><th />
            </tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id}>
                <td><bdi>{c.nameAr || c.name}</bdi>{c.nameAr && c.nameAr !== c.name ? <span className="acct-hint"> · <bdi dir="ltr">{c.name}</bdi></span> : null}</td>
                <td className="acct-code"><bdi dir="ltr">{c.vatNumber ?? "—"}</bdi></td><td className="acct-code"><bdi dir="ltr">{c.commercialRegNo ?? "—"}</bdi></td>
                <td>{c.city ?? "—"}</td><td><bdi dir="ltr">{c.phone ?? "—"}</bdi></td>
                <td className="num">{money(c.balance)}</td><td className="num">{Number(c.overdue) > 0 ? <b>{money(c.overdue)}</b> : money(c.overdue, true) || "—"}</td>
                <td className="num">{c.creditLimit ? money(c.creditLimit) : "—"}</td><td>{c.repName ?? <span className="acct-hint">{L("بدون مندوب", "No rep")}</span>}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <Link className="hr-btn is-sm" href={`/dashboard/sales/receivables/${c.id}`}>{L("كشف الحساب", "Statement")}</Link>{" "}
                  <button type="button" className="hr-btn is-sm" disabled={!!w.busy} onClick={() => quote(c)} data-testid={`acust-quote-${c.id}`}>{L("عرض سعر", "Quotation")}</button>{" "}
                  <Link className="hr-btn is-sm" href={`/dashboard/sales/invoices/new?q=${encodeURIComponent(c.nameAr || c.name)}`}>{L("فاتورة", "Invoice")}</Link>{" "}
                  {can ? <button type="button" className="hr-btn is-sm" onClick={() => setEdit({ id: c.id, form: { name: c.name, nameAr: c.nameAr ?? "", vatNumber: c.vatNumber ?? "", commercialRegNo: c.commercialRegNo ?? "", city: c.city ?? "", address: c.address ?? "", phone: c.phone ?? "", email: c.email ?? "" } })} data-testid={`acust-edit-${c.id}`}>{L("تعديل", "Edit")}</button> : null}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {edit ? (
        <Dialog open onClose={() => setEdit(null)} title={edit.id ? L("بيانات العميل للفواتير", "Invoice particulars") : L("عميل جديد", "New customer")}
          sub={L("البيانات اللي تطلع على الفاتورة الضريبية. الصفقات والمندوب من المبيعات.", "What the tax invoice carries. Deals and the rep stay with Sales.")}
          actions={<><button type="button" className="hr-btn" onClick={() => setEdit(null)}>{L("تراجع", "Back")}</button><button type="button" className="hr-btn is-primary" disabled={!!w.busy} onClick={save} data-testid="acust-save">{L("حفظ", "Save")}</button></>}>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {f("name", "الاسم (كما في السجل)", "Name", false)}{f("nameAr", "الاسم بالعربي", "Arabic name")}
            {f("vatNumber", "الرقم الضريبي", "VAT number", true)}{f("commercialRegNo", "السجل التجاري", "CR number", true)}
            {f("city", "المدينة", "City")}{f("address", "العنوان", "Address")}
            {f("phone", "الجوال", "Phone", true)}{f("email", "الإيميل", "E-mail", true)}
          </div>
        </Dialog>
      ) : null}
    </AcctShell>
  );
}
