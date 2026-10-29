"use client";

// «تفاصيل المورد» (Qoyod parity — QOYOD-REF §2.2): one supplier on one page — the key facts, Qoyod's five tiles
// (الرصيد الختامي · إجمالي المستحق · متأخرة · عدد الفواتير · مجموع مبالغ كل الفواتير) and the tabs الفواتير ·
// الإشعارات والمطالبات · السندات · كشف الحساب. Read-only and built from the APIs that already exist, each with its own gate:
//   GET /api/purchases/suppliers            the supplier row and its open balance (AP read gate)
//   GET /api/purchases/invoices?supplierId  its purchase invoices (AP read gate)
//   GET /api/purchases/claims?supplierId    its claims and credit notes (AP read gate)
//   GET /api/accounting/ap/payments?supplierId   its payment vouchers (AP read gate)
//   GET /api/accounting/ap/statement?supplierId  its statement from the books (the accounting module only)
// Nothing here writes; the actions link to the screens that already do them.
import Link from "next/link";
import { use, useMemo, useState } from "react";
import { OpsLoading, OpsRoot, PageHeader, Notice } from "@/components/ops/ui";
import { Section, ListFooter, ListPageSize, usePaging, useTerm } from "@/components/chrome";
import { hasModuleAccess } from "@/lib/auth-shared";
import { useUser } from "../../../user-context";
import { money, todayRiyadh, useApi, useLang } from "../../../accounting/_ui/shell";
import "@/components/ops/stock.css";
import "../../../accounting/_ui/accounting.css";
import "../../_parts/purchases.css";
import { PI_STATUS, type InvoiceListRow } from "../../_parts/invoices";
import type { SupplierRow } from "../../_parts/suppliers";
import type { Claim } from "../../_parts/claims";

type Payment = { id: string; number: string; paymentDate: string; amount: string; method: string; reference: string | null; status: string; journalEntryId: string | null; invoices: string[]; allocated?: string };
type Statement = { supplier: { name: string }; from: string; to: string; opening: string; closing: string; lines: { entryId: string; date: string; ref: string; description: string | null; debit: string; credit: string; balance: string }[] };
type Tab = "invoices" | "claims" | "payments" | "statement";
const METHOD: Record<string, [string, string]> = { BANK_TRANSFER: ["تحويل بنكي", "Bank transfer"], CASH: ["نقدًا", "Cash"], CHEQUE: ["شيك", "Cheque"] };
const cents = (v: string | number | null | undefined) => Math.round(Number(v ?? 0) * 100);

export default function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { L } = useLang();
  const t = useTerm();
  const user = useUser();
  const books = !!user && hasModuleAccess(user.permissions, "accounting");
  const [tab, setTab] = useState<Tab>("invoices");
  const sups = useApi<{ rows: SupplierRow[] }>("/api/purchases/suppliers");
  const inv = useApi<{ rows: InvoiceListRow[] }>(`/api/purchases/invoices?supplierId=${encodeURIComponent(id)}`);
  const claims = useApi<{ rows: Claim[] }>(tab === "claims" ? `/api/purchases/claims?supplierId=${encodeURIComponent(id)}` : null);
  const pays = useApi<Payment[]>(tab === "payments" ? `/api/accounting/ap/payments?supplierId=${encodeURIComponent(id)}` : null);
  const st = useApi<Statement>(tab === "statement" && books ? `/api/accounting/ap/statement?supplierId=${encodeURIComponent(id)}&to=${todayRiyadh()}` : null);
  const s = sups.data?.rows.find((r) => r.id === id) ?? null;
  const rows = useMemo(() => inv.data?.rows ?? [], [inv.data]);
  const tiles = useMemo(() => {
    const today = todayRiyadh();
    const live = rows.filter((r) => r.status === "POSTED");
    const open = live.reduce((a, r) => a + cents(r.outstanding), 0);
    const overdue = live.filter((r) => r.dueDate < today).reduce((a, r) => a + cents(r.outstanding), 0);
    const all = rows.filter((r) => r.status !== "CANCELLED");
    return { open, overdue, count: all.length, sum: all.reduce((a, r) => a + cents(r.grossTotal), 0) };
  }, [rows]);
  const { pageRows, pager } = usePaging(rows);
  const status = (r: InvoiceListRow) => {
    if (r.overdueDays > 0) return <span className="hr-dot tone-danger"><span>{L(`متأخرة ${r.overdueDays} يومًا`, `${r.overdueDays} days overdue`)}</span></span>;
    const e = PI_STATUS[r.status];
    return <span className={`hr-dot tone-${e?.[2] ?? "neutral"}`}><span>{e ? L(e[0], e[1]) : r.status}</span></span>;
  };
  if (sups.error && !sups.data) return <OpsRoot className="acct pur-root"><div className="hr-page"><Notice tone="danger">{sups.error}</Notice></div></OpsRoot>;
  const tabs: [Tab, string][] = [["invoices", L("الفواتير", "Invoices")], ["claims", L("الإشعارات والمطالبات", "Notes & claims")], ["payments", t("supplierPayments")], ...(books ? [["statement", L("كشف الحساب", "Statement")] as [Tab, string]] : [])];
  return (
    <OpsRoot className="acct pur-root">
      <div className="hr-page" data-testid="supplier-page">
        <p className="acct-hint"><Link href="/dashboard/purchases?tab=suppliers">→ {L("المشتريات · الموردين", "Purchases · suppliers")}</Link></p>
        <PageHeader title={L("تفاصيل المورد", "Supplier details")}
          actions={<span className="acct-actions">
            <Link className="hr-btn is-primary" href="/dashboard/purchases/invoices/new" data-testid="supplier-new-invoice">+ {L("فاتورة مشتريات", "Purchase invoice")}</Link>
            {books ? <Link className="hr-btn" href={`/dashboard/accounting/ap?view=payments&pay=${encodeURIComponent(id)}`} data-testid="supplier-pay">{L("تسجيل سداد", "Record a payment")}</Link> : null}
          </span>}>
          <span className="acct-meta">{L("ريال سعودي · شامل الضريبة", "SAR · VAT inclusive")}</span>
        </PageHeader>
        {!sups.data ? <OpsLoading /> : !s ? <Notice tone="warning">{L("لم يُعثر على المورد.", "Supplier not found.")}</Notice> : (
          <>
            <section className="acct-card" data-testid="supplier-facts">
              <dl className="pur-kv" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px 24px", margin: 0 }}>
                <div><dt className="hr-caption">{L("الاسم", "Name")}</dt><dd className="strong" style={{ margin: 0 }} data-testid="supplier-name">{s.name}</dd></div>
                <div><dt className="hr-caption">{L("الرقم الضريبي", "VAT number")}</dt><dd style={{ margin: 0 }}>{s.vatNumber ? <bdi className="acct-code">{s.vatNumber}</bdi> : <span className="acct-bad">{L("لا رقم ضريبي — أضفه من «تعديل»", "No VAT number — add it under «Edit»")}</span>}</dd></div>
                <div><dt className="hr-caption">{L("شروط الدفع", "Payment terms")}</dt><dd style={{ margin: 0 }}>{L(`${s.paymentTermsDays ?? 30} يومًا`, `${s.paymentTermsDays ?? 30} days`)}</dd></div>
                <div><dt className="hr-caption">{L("التواصل", "Contact")}</dt><dd style={{ margin: 0 }}>{s.contact ? <bdi dir="ltr">{s.contact}</bdi> : "—"}</dd></div>
                <div><dt className="hr-caption">{L("الحالة", "Status")}</dt><dd style={{ margin: 0 }}><span className="hr-dot tone-success"><span>{L("نشط", "Active")}</span></span></dd></div>
              </dl>
            </section>
            <div className="acct-metrics" data-testid="supplier-tiles">
              <div className="acct-metric"><span className="k">{L("الرصيد الختامي", "Closing balance")}</span><span className="v" data-testid="supplier-tile-balance">{money(s.openBalance ?? 0)}</span><span className="s">{L("بعد الإشعارات الدائنة", "after credit notes")}</span></div>
              <div className="acct-metric"><span className="k">{L("إجمالي المستحق", "Total due")}</span><span className="v">{inv.data ? money(tiles.open / 100) : "…"}</span><span className="s">{L("فواتير معتمدة غير مسددة", "approved, unpaid")}</span></div>
              <div className="acct-metric"><span className="k">{L("متأخرة", "Overdue")}</span><span className={`v${tiles.overdue ? " is-bad" : ""}`}>{inv.data ? money(tiles.overdue / 100) : "…"}</span><span className="s">{L("تجاوزت تاريخ الاستحقاق", "past the due date")}</span></div>
              <div className="acct-metric"><span className="k">{L("عدد الفواتير", "Invoices")}</span><span className="v">{inv.data ? tiles.count : "…"}</span><span className="s">{L("بلا الملغاة", "cancelled excluded")}</span></div>
              <div className="acct-metric"><span className="k">{L("مجموع مبالغ كل الفواتير", "All invoices total")}</span><span className="v">{inv.data ? money(tiles.sum / 100) : "…"}</span><span className="s">{L("ريال سعودي", "SAR")}</span></div>
            </div>
            <nav className="hr-tabs is-underline" aria-label={L("أقسام المورد", "Supplier sections")} role="tablist">
              {tabs.map(([k, label]) => <button key={k} type="button" role="tab" className="hr-tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`supplier-tab-${k}`}>{label}</button>)}
            </nav>
            {tab === "invoices" ? (
              <Section title={L("الفواتير", "Invoices")} testId="supplier-invoices">
                {inv.error && !inv.data ? <Notice tone="danger">{inv.error}</Notice> : !inv.data ? <OpsLoading /> : (
                  <>
                    <ListPageSize {...pager} />
                    <div className="hr-tablewrap">
                      <table className="hr-table is-dense is-mrow" data-testid="supplier-invoices-table">
                        <thead><tr><th>{t("colRef")}</th><th className="hr-hide-compact">{L("فاتورة المورد", "Supplier ref")}</th><th>{L("تاريخ الإصدار", "Issued")}</th><th className="hr-hide-compact">{t("colDue")}</th><th className="num">{L("القيمة الاجمالية", "Total")}</th><th className="num">{L("الرصيد", "Balance")}</th><th>{t("colStatus")}</th><th className="hr-hide-compact">{t("colOptions")}</th></tr></thead>
                        <tbody>
                          {pageRows.map((r) => (
                            <tr key={r.id} className={r.status === "CANCELLED" ? "is-muted" : undefined}>
                              <td className="m-title"><Link className="acct-code" href={`/dashboard/purchases/invoices/${r.id}`}>{r.number}</Link><span className="hr-msub"><span className="hr-num">{r.invoiceDate}</span> · {money(r.grossTotal)}</span></td>
                              <td className="hr-hide-compact"><bdi className="acct-code">{r.supplierRef}</bdi></td>
                              <td className="hr-num">{r.invoiceDate}</td><td className="hr-num hr-hide-compact">{r.dueDate}</td>
                              <td className="num hr-num m-end">{money(r.grossTotal)}</td>
                              <td className="num hr-num">{r.status === "POSTED" ? money(r.outstanding) : "—"}</td>
                              <td>{status(r)}</td>
                              <td className="hr-hide-compact"><Link className="hr-btn is-sm is-ghost" href={`/dashboard/purchases/invoices/${r.id}`} aria-label={L(`عرض ${r.number}`, `View ${r.number}`)}>{t("rowView")}</Link></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ListFooter {...pager} noun={L("فاتورة", "invoices")} emptyText={L("لا توجد أي فواتير لهذا المورد", "No invoices for this supplier")} />
                  </>
                )}
              </Section>
            ) : null}
            {tab === "claims" ? (
              <Section title={L("الإشعارات والمطالبات", "Notes & claims")} testId="supplier-claims">
                {claims.error && !claims.data ? <Notice tone="danger">{claims.error}</Notice> : !claims.data ? <OpsLoading /> : !claims.data.rows.length ? <p className="acct-hint">{L("لا توجد أي مطالبات لهذا المورد.", "No claims for this supplier.")}</p> : (
                  <div className="hr-tablewrap">
                    <table className="hr-table is-dense">
                      <thead><tr><th>{L("الفاتورة الأصلية", "Original invoice")}</th><th>{L("البند", "Line")}</th><th className="num">{L("قيمة المطالبة", "Claim")}</th><th className="num">{L("المتبقي", "Open")}</th><th>{t("colStatus")}</th></tr></thead>
                      <tbody>
                        {claims.data.rows.map((c) => (
                          <tr key={c.id}>
                            <td><Link className="acct-code" href={`/dashboard/purchases/invoices/${c.invoice.id}`}>{c.invoice.number}</Link></td>
                            <td>{c.line.description}</td>
                            <td className="num hr-num">{money(Number(c.net) + Number(c.vat))}</td>
                            <td className="num hr-num">{money(c.openGross)}</td>
                            <td><span className={`hr-dot tone-${c.status === "OPEN" ? "warning" : c.status === "SETTLED" ? "success" : "cancelled"}`}><span>{c.status === "OPEN" ? L("مفتوحة", "Open") : c.status === "SETTLED" ? L("مسوّاة", "Settled") : L("ملغاة", "Void")}</span></span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="acct-hint"><Link href={`/dashboard/purchases?tab=claims&supplier=${encodeURIComponent(id)}`}>{L("فتح «مطالبات الموردين» لهذا المورد", "Open «Supplier claims» for this supplier")}</Link></p>
              </Section>
            ) : null}
            {tab === "payments" ? (
              <Section title={t("supplierPayments")} testId="supplier-payments">
                {pays.error && !pays.data ? <Notice tone="danger">{pays.error}</Notice> : !pays.data ? <OpsLoading /> : !pays.data.length ? <p className="acct-hint">{L("لا توجد أي سندات لهذا المورد.", "No vouchers for this supplier.")}</p> : (
                  <div className="hr-tablewrap">
                    <table className="hr-table is-dense">
                      <thead><tr><th>{t("colRef")}</th><th>{L("التاريخ", "Date")}</th><th className="hr-hide-compact">{L("طريقة الدفع", "Payment method")}</th><th className="hr-hide-compact">{L("الفواتير", "Invoices")}</th><th className="num">{L("المبلغ", "Amount")}</th><th>{t("colStatus")}</th></tr></thead>
                      <tbody>
                        {pays.data.map((p) => (
                          <tr key={p.id} className={p.status === "VOIDED" ? "is-muted" : undefined}>
                            <td>{p.journalEntryId ? <Link className="acct-code" href={`/dashboard/accounting/journals/${p.journalEntryId}`}>{p.number}</Link> : <span className="acct-code">{p.number}</span>}</td>
                            <td className="hr-num">{p.paymentDate}</td>
                            <td className="hr-hide-compact">{L(METHOD[p.method]?.[0] ?? p.method, METHOD[p.method]?.[1] ?? p.method)}{p.reference ? ` · ${p.reference}` : ""}</td>
                            <td className="hr-hide-compact acct-code">{p.invoices.join(" ، ")}</td>
                            <td className="num hr-num">{money(p.amount)}</td>
                            <td>{p.status === "VOIDED" ? <span className="hr-dot tone-cancelled"><span>{L("ملغى", "Voided")}</span></span> : <span className="hr-dot tone-success"><span>{L("مستعمل", "Used")}</span></span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            ) : null}
            {tab === "statement" && books ? (
              <Section title={L("كشف حساب", "Statement")} testId="supplier-statement">
                {st.error && !st.data ? <Notice tone="danger">{st.error}</Notice> : !st.data ? <OpsLoading /> : (
                  <div className="hr-tablewrap">
                    <table className="hr-table is-dense">
                      <thead><tr><th>{L("التاريخ", "Date")}</th><th>{L("المستند", "Document")}</th><th className="hr-hide-compact">{L("البيان", "Description")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th><th className="num">{L("الرصيد", "Balance")}</th></tr></thead>
                      <tbody>
                        <tr className="is-header"><td className="hr-num">{st.data.from}</td><td /><td className="hr-hide-compact">{L("رصيد أول المدة", "Opening balance")}</td><td /><td /><td className="num hr-num">{money(st.data.opening)}</td></tr>
                        {st.data.lines.map((l, i) => <tr key={i}><td className="hr-num">{l.date}</td><td><Link className="acct-code" href={`/dashboard/accounting/journals/${l.entryId}`}>{l.ref}</Link></td><td className="hr-hide-compact">{l.description}</td><td className="num hr-num">{money(l.debit, true)}</td><td className="num hr-num">{money(l.credit, true)}</td><td className="num hr-num">{money(l.balance)}</td></tr>)}
                        <tr className="is-total"><td className="hr-num">{st.data.to}</td><td /><td className="hr-hide-compact">{L("الرصيد الختامي", "Closing balance")}</td><td /><td /><td className="num hr-num">{money(st.data.closing)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="acct-hint">{L("الكشف من القيود المرحّلة على حساب الذمم الدائنة لهذا المورد؛ قبل تفعيل المحاسبة لا قيود.", "From the posted entries on the AP account for this supplier; before accounting is activated there are none.")} <Link href={`/dashboard/accounting/ap?view=aging&supplierId=${encodeURIComponent(id)}`}>{L("أعمار الدائنين", "AP aging")}</Link></p>
              </Section>
            ) : null}
          </>
        )}
      </div>
    </OpsRoot>
  );
}
