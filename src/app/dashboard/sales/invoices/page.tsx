"use client";

// «فواتير المبيعات» and «الإشعارات الدائنة والمدينة» (Figma ZT-10 / ZT-11): segments (all · drafts · issued ·
// unpaid / overdue), filters (status, family, period, text), the payment state of each issued invoice. The ZATCA
// column reads «المرحلة 2 لاحقًا» until A4. A rep sees the invoices of the customers they own (the API decides).
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { DOC_STATUS, DocNo, FAMILY, InvShell, KIND, PAY_STATUS, Tag, money, useApi, useLang } from "./_ui/inv";

type Row = {
  id: string; kind: string; family: string; status: string; number: string | null; customerId: string; customerName: string; orderId: string | null; orderNumber: number | null;
  issueDate: string | null; dueDate: string | null; grandTotal: string; taxTotal: string; createdAt: string; original: { id: string; number: string | null } | null;
  open: string | null; payment: "PAID" | "PARTIAL" | "UNPAID" | null; overdue: boolean; source: string;
};
type List = { items: Row[]; total: number; take: number; skip: number; byStatus: Record<string, number>; can: { create: boolean; view: boolean } };
type Search = { tab?: string; orderId?: string; customerId?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});

export default function InvoicesPage({ searchParams = NO_SEARCH }: { searchParams?: Promise<Search> }) {
  const sp = use(searchParams);
  const notes = sp.tab === "notes";
  const { L } = useLang();
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [skip, setSkip] = useState(0);
  const url = useMemo(() => {
    const p = new URLSearchParams({ take: "50", skip: String(skip) });
    if (notes) p.set("tab", "notes");
    if (status) p.set("status", status);
    if (family) p.set("family", family);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (q.trim()) p.set("q", q.trim());
    if (sp.orderId) p.set("orderId", sp.orderId);
    if (sp.customerId) p.set("customerId", sp.customerId);
    return `/api/sales/invoices?${p}`;
  }, [notes, status, family, from, to, q, skip, sp.orderId, sp.customerId]);
  const list = useApi<List>(url);
  const d = list.data;
  const all = Object.values(d?.byStatus ?? {}).reduce((a, b) => a + b, 0);
  const seg = (k: string, ar: string, en: string, n?: number) => (
    <button type="button" aria-pressed={status === k} onClick={() => { setStatus(k); setSkip(0); }} data-testid={`seg-${k || "all"}`}>
      {L(ar, en)}{n !== undefined ? <span className="hr-count">{n}</span> : null}
    </button>
  );
  return (
    <InvShell tab={sp.tab ?? null} testId={notes ? "notes-page" : "invoices-page"}
      meta={<span className="acct-meta"><span>{L(`${all} مستند`, `${all} documents`)}</span><span aria-hidden="true">·</span><span>{L("ريال سعودي", "SAR")}</span><span aria-hidden="true">·</span><span>{L("شامل الضريبة", "VAT inclusive")}</span></span>}
      actions={d?.can.create && !notes ? <Link className="hr-btn is-primary" href="/dashboard/sales/invoices/new" data-testid="new-invoice">{L("فاتورة مبيعات", "Sales invoice")}</Link> : undefined}>
      {notes ? <p className="acct-hint">{L("يُنشأ الإشعار الدائن أو المدين من صفحة الفاتورة الأصلية: «إصدار إشعار دائن».", "A credit or debit note is created from its original invoice: «Issue a credit note».")}</p> : null}
      <div className="acct-row">
        <div className="inv-seg" role="group" aria-label={L("الحالة", "Status")}>
          {seg("", "الكل", "All", all)}
          {seg("DRAFT", "مسودات", "Drafts", d?.byStatus.DRAFT ?? 0)}
          {seg("ISSUED", "صادرة", "Issued", d?.byStatus.ISSUED ?? 0)}
          {seg("CANCELLED", "ملغاة", "Cancelled", d?.byStatus.CANCELLED ?? 0)}
        </div>
      </div>
      <div className="acct-row">
        <label className="hr-field acct-grow"><span className="hr-label">{L("بحث", "Search")}</span>
          <input className="hr-input" value={q} onChange={(e) => { setQ(e.target.value); setSkip(0); }} placeholder={L("رقم الفاتورة أو العميل", "Invoice number or customer")} data-testid="invoice-search" /></label>
        <label className="hr-field"><span className="hr-label">{L("النوع", "Type")}</span>
          <Select value={family} onChange={(e) => { setFamily(e.target.value); setSkip(0); }} placeholder={L("الكل", "All")}>
            <option value="">{L("الكل", "All")}</option>
            <option value="STANDARD">{L("ضريبية", "Standard")}</option>
            <option value="SIMPLIFIED">{L("مبسطة", "Simplified")}</option>
          </Select></label>
        <label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={from} onChange={(e) => { setFrom(e.target.value); setSkip(0); }} /></label>
        <label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={to} onChange={(e) => { setTo(e.target.value); setSkip(0); }} /></label>
      </div>
      {list.error ? <p role="alert" className="hr-err">{list.error}</p> : null}
      {!d ? <OpsLoading /> : d.items.length === 0 ? <p className="acct-hint" data-testid="invoices-empty">{notes ? L("لا إشعارات بعد.", "No notes yet.") : L("لا فواتير تطابق البحث.", "No invoice matches.")}</p> : (
        <div className="hr-tablewrap">
          <table className="hr-table is-dense is-mrow" data-testid="invoices-table">
            <thead><tr>
              <th>{notes ? L("الإشعار", "Note") : L("الفاتورة", "Invoice")}</th><th>{L("العميل", "Customer")}</th><th className="inv-hide-m">{L("النوع", "Type")}</th>
              <th>{L("الإصدار", "Issued")}</th><th className="num">{L("الإجمالي", "Total")}</th><th>{L("المستند", "Document")}</th>
              {!notes ? <th>{L("السداد", "Payment")}</th> : <th>{L("الفاتورة الأصلية", "Original")}</th>}
              <th className="inv-hide-m">{L("الفوترة الإلكترونية", "E-invoicing")}</th>
            </tr></thead>
            <tbody>
              {d.items.map((r) => (
                <tr key={r.id} data-testid={`invoice-row-${r.number ?? r.id}`}>
                  <td className="m-title"><Link href={`/dashboard/sales/invoices/${r.id}`}><DocNo n={r.number} draftLabel={L("مسودة", "Draft")} /></Link>
                    <span className="hr-msub">{r.customerName} · {money(r.grandTotal)}</span></td>
                  <td><bdi>{r.customerName}</bdi>{r.orderNumber ? <span className="inv-sub">{L("طلب", "Order")} <bdi className="hr-num">#{r.orderNumber}</bdi></span> : null}</td>
                  <td className="inv-hide-m">{L(KIND[r.kind]?.[r.family]?.[0] ?? r.kind, KIND[r.kind]?.[r.family]?.[1] ?? r.kind)}<span className="inv-sub">{L(FAMILY[r.family][0], FAMILY[r.family][1])}</span></td>
                  <td className="hr-num">{r.issueDate ?? "—"}</td>
                  <td className="num hr-num m-end">{money(r.grandTotal)}</td>
                  <td><Tag map={DOC_STATUS} value={r.status} /></td>
                  {!notes ? (
                    <td>{r.payment ? <><Tag map={PAY_STATUS} value={r.payment} />{r.overdue ? <span className="inv-sub inv-late">{L("متأخرة", "Overdue")} · {r.dueDate}</span> : r.dueDate && r.payment !== "PAID" ? <span className="inv-sub">{L("تستحق", "Due")} {r.dueDate}</span> : null}</> : <span className="hr-muted">{L("لا تُحصَّل قبل الإصدار", "Not collectable before issue")}</span>}</td>
                  ) : (
                    <td>{r.original ? <Link href={`/dashboard/sales/invoices/${r.original.id}`}><DocNo n={r.original.number} /></Link> : "—"}</td>
                  )}
                  <td className="inv-hide-m"><span className="inv-chip">{r.status === "ISSUED" ? L("غير مُرسلة · المرحلة 2 لاحقًا", "Not sent · Phase 2 later") : L("لم تصدر بعد", "Not issued yet")}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d && d.total > d.take ? (
        <div className="hr-tablefoot">
          <span className="hr-caption">{L(`${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} من ${d.total}`, `${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} of ${d.total}`)}</span>
          <span className="acct-actions">
            <button type="button" className="hr-btn is-sm" disabled={d.skip === 0} onClick={() => setSkip(Math.max(0, d.skip - d.take))}>{L("السابق", "Previous")}</button>
            <button type="button" className="hr-btn is-sm" disabled={d.skip + d.take >= d.total} onClick={() => setSkip(d.skip + d.take)}>{L("التالي", "Next")}</button>
          </span>
        </div>
      ) : null}
    </InvShell>
  );
}
