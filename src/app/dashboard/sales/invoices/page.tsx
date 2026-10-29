"use client";

// «فواتير المبيعات» and «الإشعارات الدائنة والمدينة» (Figma ZT-10 / ZT-11): segments (all · drafts · issued ·
// unpaid / overdue), filters (status, family, period, text), the payment state of each issued invoice. The ZATCA
// column reads «المرحلة 2 لاحقًا» until A4. A rep sees the invoices of the customers they own (the API decides).
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { DOC_STATUS, DocNo, FAMILY, InvShell, KIND, PAY_STATUS, Tag, money, useApi, useLang } from "./_ui/inv";
import { DateRange, FilterCard, Section, ListFooter, ListPageSize, useFilters, useTerm } from "@/components/chrome";
import { moneyMinus, useAccountantView } from "../../accounting/_ui/qoyod-pages";
import { D21Dialog } from "@/components/ui/Dialog";
import { useRouter } from "next/navigation";

type Row = {
  id: string; kind: string; family: string; status: string; number: string | null; customerId: string; customerName: string; orderId: string | null; orderNumber: number | null;
  issueDate: string | null; dueDate: string | null; grandTotal: string; taxTotal: string; createdAt: string; original: { id: string; number: string | null } | null;
  open: string | null; payment: "PAID" | "PARTIAL" | "UNPAID" | null; overdue: boolean; source: string;
};
type List = { items: Row[]; total: number; take: number; skip: number; byStatus: Record<string, number>; can: { create: boolean; view: boolean } };
type Search = { tab?: string; orderId?: string; customerId?: string };
const NO_SEARCH: Promise<Search> = Promise.resolve({});
/** Qoyod's payment-state words for an issued invoice (QOYOD-REF §1.5; «معلقة» for unpaid is to confirm — Questions §4). */
const Q_PAY: Record<string, [string, string, "warning" | "info" | "success"]> = {
  UNPAID: ["معلقة", "Pending", "warning"], PARTIAL: ["مدفوعة جزئياً", "Partly paid", "info"], PAID: ["دفعت", "Paid", "success"],
};

export default function InvoicesPage({ searchParams = NO_SEARCH }: { searchParams?: Promise<Search> }) {
  const sp = use(searchParams);
  const notes = sp.tab === "notes";
  const { L } = useLang();
  // Qoyod parity (accountant workspace only): the filter card, Qoyod's column order and words, the dark title bar and
  // the pager; everyone else keeps this page as it was. Same API, same query parameters.
  const accountant = useAccountantView();
  const qoyod = accountant && !notes;
  // «+ إنشاء إشعار دائن» (accountant workspace, notes tab): pick the issued invoice first, then its credit-note form.
  const [picker, setPicker] = useState(false);
  const [pq, setPq] = useState("");
  const pick = useApi<List>(picker ? `/api/sales/invoices?status=ISSUED&take=10&skip=0${pq.trim() ? `&q=${encodeURIComponent(pq.trim())}` : ""}` : null);
  const router = useRouter();
  const t = useTerm();
  const [status, setStatus] = useState("");
  const [family, setFamily] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [skip, setSkip] = useState(0);
  const f = useFilters({ from: "", to: "", status: "", family: "", customerId: "", q: "" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(15);
  const custs = useApi<{ items: { id: string; name: string; nameAr: string | null }[] }>(qoyod ? "/api/sales/invoices/customers?q=" : null);
  const url = useMemo(() => {
    const v = qoyod ? f.applied : { status, family, from, to, q, customerId: "" };
    const p = new URLSearchParams(qoyod ? { take: String(size), skip: String((page - 1) * size) } : { take: "50", skip: String(skip) });
    if (notes) p.set("tab", "notes");
    if (v.status) p.set("status", v.status);
    if (v.family) p.set("family", v.family);
    if (v.from) p.set("from", v.from);
    if (v.to) p.set("to", v.to);
    if (v.q.trim()) p.set("q", v.q.trim());
    if (sp.orderId) p.set("orderId", sp.orderId);
    if (v.customerId || sp.customerId) p.set("customerId", v.customerId || sp.customerId!);
    return `/api/sales/invoices?${p}`;
  }, [qoyod, f.applied, page, size, notes, status, family, from, to, q, skip, sp.orderId, sp.customerId]);
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
      actions={accountant && notes ? <button type="button" className="hr-btn is-primary" onClick={() => setPicker(true)} data-testid="new-credit-note-pick">+ {L("إنشاء إشعار دائن", "Create a credit note")}</button> : d?.can.create && !notes ? <Link className="hr-btn is-primary" href="/dashboard/sales/invoices/new" data-testid="new-invoice">{qoyod ? `+ ${t("listCreate")}` : L("فاتورة مبيعات", "Sales invoice")}</Link> : undefined}>
      {notes ? <p className="acct-hint">{L("يُنشأ الإشعار الدائن أو المدين من صفحة الفاتورة الأصلية: «إصدار إشعار دائن».", "A credit or debit note is created from its original invoice: «Issue a credit note».")}</p> : null}
      {qoyod ? (
        <FilterCard onApply={() => { f.apply(); setPage(1); }} onReset={() => { f.reset(); setPage(1); }} busy={list.loading}>
          <DateRange from={f.draft.from} to={f.draft.to} onChange={(r) => f.setDraft({ ...f.draft, ...r })} />
          <div className="qc-field"><span className="qc-label">{t("colStatus")}</span>
            <Select value={f.draft.status} onChange={(e) => f.set("status", e.target.value)} aria-label={t("colStatus")} data-testid="qf-status">
              <option value="">{L("الكل", "All")}</option>
              <option value="DRAFT">{L("مسودات", "Drafts")}</option>
              <option value="ISSUED">{L("صادرة", "Issued")}</option>
              <option value="CANCELLED">{L("ملغاة", "Cancelled")}</option>
            </Select></div>
          <div className="qc-field"><span className="qc-label">{t("colCustomer")}</span>
            <Select value={f.draft.customerId} onChange={(e) => f.set("customerId", e.target.value)} aria-label={t("colCustomer")} data-testid="qf-customer">
              <option value="">{L("الكل", "All")}</option>
              {(custs.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{L(c.nameAr || c.name, c.name)}</option>)}
            </Select></div>
          <div className="qc-field"><span className="qc-label">{L("النوع", "Type")}</span>
            <Select value={f.draft.family} onChange={(e) => f.set("family", e.target.value)} aria-label={L("النوع", "Type")}>
              <option value="">{L("الكل", "All")}</option>
              <option value="STANDARD">{L("ضريبية", "Standard")}</option>
              <option value="SIMPLIFIED">{L("مبسطة", "Simplified")}</option>
            </Select></div>
          <div className="qc-field"><span className="qc-label">{L("بحث", "Search")}</span>
            <input className="hr-input" value={f.draft.q} onChange={(e) => f.set("q", e.target.value)} placeholder={L("رقم الفاتورة أو العميل", "Invoice number or customer")} data-testid="invoice-search" /></div>
        </FilterCard>
      ) : <>
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
      </>}
      {list.error ? <p role="alert" className="hr-err">{list.error}</p> : null}
      {!d ? <OpsLoading /> : d.items.length === 0 ? <p className="acct-hint" data-testid="invoices-empty">{notes ? L("لا إشعارات بعد.", "No notes yet.") : L("لا فواتير تطابق البحث.", "No invoice matches.")}</p> : qoyod ? (
        // Qoyod's order: المرجع · العميل · التاريخ · تاريخ الاستحقاق · الإجمالي · المدفوع · المتبقي · الحالة · الخيارات.
        // QOYOD-REF §1.5: المرجع · اسم العميل · تاريخ الإصدار · تاريخ الاستحقاق · القيمة الاجمالية · الرصيد · الحالة · الخيارات.
        // «الرصيد» is the open amount (total − receipts and credit notes applied); only an issued invoice has one.
        <Section title={t("salesInvoices")} testId="invoices-section">
        <ListPageSize pageSize={size} onPageSize={setSize} onPage={setPage} />
        <div className="hr-tablewrap">
          <table className="hr-table is-dense is-mrow" data-testid="invoices-table" data-layout="qoyod">
            <thead><tr>
              <th>{t("colRef")}</th><th>{t("colCustomer")}</th><th className="inv-hide-m">{t("colIssued")}</th><th className="inv-hide-m">{t("colDue")}</th>
              <th className="num">{t("colGrand")}</th><th className="num inv-hide-m" title={L("المتبقي على الفاتورة", "What is left to pay")}>{t("colBalance")}</th>
              <th>{t("colStatus")}</th><th className="inv-hide-m">{t("colOptions")}</th>
            </tr></thead>
            <tbody>
              {d.items.map((r) => (
                <tr key={r.id} data-testid={`invoice-row-${r.number ?? r.id}`}>
                  <td className="m-title"><Link href={`/dashboard/sales/invoices/${r.id}`}><DocNo n={r.number} draftLabel={L("مسودة", "Draft")} /></Link>
                    <span className="inv-sub">{L(KIND[r.kind]?.[r.family]?.[0] ?? r.kind, KIND[r.kind]?.[r.family]?.[1] ?? r.kind)}</span>
                    <span className="hr-msub">{r.customerName} · {money(r.grandTotal)}</span></td>
                  <td><bdi>{r.customerName}</bdi>{r.orderNumber ? <span className="inv-sub">{L("طلب", "Order")} <bdi className="hr-num">#{r.orderNumber}</bdi></span> : null}</td>
                  <td className="hr-num inv-hide-m">{r.issueDate ?? "—"}</td>
                  <td className={`hr-num inv-hide-m${r.overdue ? " inv-late" : ""}`}>{r.dueDate ?? "—"}</td>
                  <td className="num hr-num m-end">{money(r.grandTotal)}</td>
                  <td className="num hr-num inv-hide-m" title={r.open !== null ? L(`المدفوع ${money(moneyMinus(r.grandTotal, r.open))}`, `Paid ${money(moneyMinus(r.grandTotal, r.open))}`) : undefined}>{r.open !== null ? money(r.open) : "—"}</td>
                  <td>{r.status !== "ISSUED" || !r.payment ? <Tag map={DOC_STATUS} value={r.status} /> : r.overdue ? <span className="hr-dot tone-danger"><span>{L("متأخرة", "Overdue")}</span></span> : <Tag map={Q_PAY} value={r.payment} />}</td>
                  <td className="inv-hide-m"><span className="acct-actions">
                    <Link className="hr-btn is-sm is-ghost" href={`/dashboard/sales/invoices/${r.id}`} title={t("rowView")} aria-label={L(`عرض ${r.number ?? "المسودة"}`, `View ${r.number ?? "the draft"}`)}>👁</Link>
                    {r.status === "ISSUED" ? <Link className="hr-btn is-sm is-ghost" href={`/dashboard/sales/invoices/${r.id}/print`} title={L("طباعة / PDF", "Print / PDF")} aria-label={L(`طباعة ${r.number}`, `Print ${r.number}`)} data-testid={`inv-print-${r.number}`}>🖨</Link> : null}
                  </span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ListFooter page={page} pageSize={size} total={d.total} onPage={setPage} onPageSize={setSize} noun={L("فاتورة مبيعات", "invoices")} />
        </Section>
      ) : (
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
      {!qoyod && d && d.total > d.take ? (
        <div className="hr-tablefoot">
          <span className="hr-caption">{L(`${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} من ${d.total}`, `${d.skip + 1}–${Math.min(d.skip + d.take, d.total)} of ${d.total}`)}</span>
          <span className="acct-actions">
            <button type="button" className="hr-btn is-sm" disabled={d.skip === 0} onClick={() => setSkip(Math.max(0, d.skip - d.take))}>{L("السابق", "Previous")}</button>
            <button type="button" className="hr-btn is-sm" disabled={d.skip + d.take >= d.total} onClick={() => setSkip(d.skip + d.take)}>{L("التالي", "Next")}</button>
          </span>
        </div>
      ) : null}
      {picker ? (
        <D21Dialog lang={L("ar", "en") === "en" ? "en" : "ar"} title={L("اختر الفاتورة الأصلية", "Pick the original invoice")} onClose={() => setPicker(false)} testId="credit-note-picker"
          actions={<button type="button" className="hr-btn" onClick={() => setPicker(false)}>{L("إلغاء", "Cancel")}</button>}>
          <label className="hr-field"><span className="hr-label">{L("رقم الفاتورة أو العميل", "Invoice number or customer")}</span>
            <input className="hr-input" autoFocus value={pq} onChange={(e) => setPq(e.target.value)} data-testid="credit-note-picker-search" /></label>
          {!pick.data ? <OpsLoading /> : !pick.data.items.filter((r) => r.kind === "INVOICE").length ? <p className="acct-hint">{L("لا توجد فواتير صادرة تطابق البحث.", "No issued invoice matches.")}</p> : (
            <ul className="ops-list" data-testid="credit-note-picker-list">
              {pick.data.items.filter((r) => r.kind === "INVOICE").map((r) => (
                <li key={r.id}><button type="button" className="hr-btn is-ghost" onClick={() => router.push(`/dashboard/sales/invoices/${r.id}/credit-note`)} data-testid={`pick-${r.number}`}>
                  <DocNo n={r.number} /> · <bdi>{r.customerName}</bdi> · <span className="hr-num">{r.issueDate}</span> · <span className="hr-num">{money(r.grandTotal)}</span>
                </button></li>
              ))}
            </ul>
          )}
          <p className="acct-hint">{L("تُنقل بنود الفاتورة إلى الإشعار؛ تختار ما يُرجع وسبب الإصدار.", "The invoice's lines carry over to the note; you choose what is returned and the reason.")}</p>
        </D21Dialog>
      ) : null}
    </InvShell>
  );
}
