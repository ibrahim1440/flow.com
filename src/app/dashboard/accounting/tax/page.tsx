"use client";

// «الضريبة» — the quarterly VAT return (Figma ACC «الضريبة» tab; council 07): the ZATCA return boxes built from the
// issued tax documents (A2) and the posted supplier invoices (A3), reconciled to the VAT accounts of the ledger and to
// the e-invoicing states (A4). A working paper for the accountant: the box rules are checked against current ZATCA
// guidance before filing. Quarter in the URL; CSV export; print through the document module.
import Link from "next/link";
import { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsLoading } from "@/components/ops/ui";
import { Select } from "@/components/ui/Select";
import { AcctShell, money, todayRiyadh, useApi, useLang, type Setup } from "../_ui/shell";

type Box = { box: number | null; key: string; ar: string; en: string; amount: string; adjustment: string; vat: string; note: { ar: string; en: string } | null };
type Bucket = { count: number; vat: string };
type Vat = {
  year: number; quarter: number; from: string; to: string; dueDate: string; sales: Box[]; purchases: Box[];
  summary: { totalVatDue: string; corrections: string; creditCarriedForward: string; netVatDue: string; outOfScopeSales: string };
  reconciliation: {
    output: { documents: string; postedDocuments: string; unposted: Bucket; glFromDocuments: string; glOther: string; difference: string; matched: boolean };
    input: { documents: string; postedDocuments: string; unposted: Bucket; noSupplierVatNumber?: Bucket; glFromDocuments: string; glOther: string; difference: string; matched: boolean };
    zatca: { accepted: Bucket; pending: Bucket; rejected: Bucket; notEInvoiced: Bucket; returnVsAccepted: string };
  };
  counts: { salesDocuments: number; purchaseInvoices: number }; disclaimer: { ar: string; en: string };
};

function Boxes({ title, rows, testId }: { title: string; rows: Box[]; testId: string }) {
  const { L } = useLang();
  return (
    <div className="hr-tablewrap">
      <table className="hr-table is-dense" data-testid={testId}>
        <thead><tr><th>{L("الخانة", "Box")}</th><th>{title}</th><th className="num">{L("المبلغ", "Amount")}</th><th className="num acct-hide-m">{L("التعديلات", "Adjustments")}</th><th className="num">{L("الضريبة", "VAT")}</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key} className={b.box === 6 || b.box === 12 ? "is-total" : ""} data-box={b.box ?? "wp"}>
              <td className="hr-num">{b.box ?? "—"}</td>
              <td>{L(b.ar, b.en)}{b.note ? <span className="acct-th-sub">{L(b.note.ar, b.note.en)}</span> : null}</td>
              <td className="num hr-num">{money(b.amount)}</td><td className="num hr-num acct-hide-m">{money(b.adjustment)}</td><td className="num hr-num">{money(b.vat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tax() {
  const { L } = useLang();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const t = todayRiyadh();
  const year = sp.get("year") ?? t.slice(0, 4);
  const q = sp.get("q") ?? String(Math.floor((Number(t.slice(5, 7)) - 1) / 3) + 1);
  const go = (patch: Record<string, string>) => { const p = new URLSearchParams(sp.toString()); for (const [k, v] of Object.entries(patch)) p.set(k, v); router.replace(`${path}?${p}`); };
  const setup = useApi<Setup>("/api/accounting/setup");
  const r = useApi<Vat>(`/api/accounting/vat-return?year=${year}&q=${q}`);
  const d = r.data;
  const rec = d?.reconciliation;
  return (
    <AcctShell setup={setup.data} actions={<span className="acct-actions">
      <Link className="hr-btn" href={`/dashboard/accounting/reports/print?report=vat&year=${year}&q=${q}`} data-testid="vat-print">{L("طباعة / PDF", "Print / PDF")}</Link>
      <a className="hr-btn" href={`/api/accounting/vat-return?year=${year}&q=${q}&format=csv`} data-testid="vat-csv">{L("تصدير CSV", "Export CSV")}</a>
    </span>}>
      <div className="acct-row">
        <label className="hr-field"><span className="hr-label">{L("السنة", "Year")}</span><input className="hr-input" dir="ltr" inputMode="numeric" value={year} onChange={(e) => /^\d{4}$/.test(e.target.value) && go({ year: e.target.value })} data-testid="vat-year" /></label>
        <label className="hr-field"><span className="hr-label">{L("الربع (الإقرار ربع سنوي)", "Quarter (quarterly return)")}</span>
          <Select value={q} onChange={(e) => go({ q: e.target.value })} data-testid="vat-quarter">
            {[1, 2, 3, 4].map((n) => <option key={n} value={String(n)}>{`Q${n}`}</option>)}
          </Select></label>
      </div>
      {r.error ? <p role="alert" className="hr-err">{r.error}</p> : !d || !rec ? <OpsLoading /> : (
        <>
          <div className="acct-metrics" data-testid="vat-metrics">
            <div className="acct-metric"><span className="k">{L("ضريبة المبيعات", "Output VAT")}</span><span className="v">{money(d.sales.find((b) => b.box === 6)?.vat)}</span><span className="s">{L(`${d.counts.salesDocuments} مستند`, `${d.counts.salesDocuments} documents`)}</span></div>
            <div className="acct-metric"><span className="k">{L("ضريبة المشتريات", "Input VAT")}</span><span className="v">{money(d.purchases.find((b) => b.box === 12)?.vat)}</span><span className="s">{L(`${d.counts.purchaseInvoices} فاتورة مورد`, `${d.counts.purchaseInvoices} supplier invoices`)}</span></div>
            <div className="acct-metric"><span className="k">{L("صافي الضريبة المستحقة (خانة 16)", "Net VAT due (box 16)")}</span><span className={`v${Number(d.summary.netVatDue) < 0 ? " is-bad" : ""}`} data-testid="vat-net">{money(d.summary.netVatDue)}</span><span className="s">{L(`آخر موعد للتقديم والسداد ${d.dueDate}`, `File and pay by ${d.dueDate}`)}</span></div>
            <div className="acct-metric"><span className="k">{L("المطابقة مع الأستاذ", "Reconciled to the GL")}</span><span className={`v ${rec.output.matched && rec.input.matched ? "acct-good" : "acct-bad"}`} data-testid="vat-recon">{rec.output.matched && rec.input.matched ? L("مطابق", "Matched") : L("فرق", "Difference")}</span><span className="s hr-num">{d.from} – {d.to}</span></div>
          </div>
          <div className="acct-banner-note" role="note"><p className="acct-hint">{L(d.disclaimer.ar, d.disclaimer.en)}</p></div>
          <Boxes title={L("المبيعات", "Sales")} rows={d.sales} testId="vat-sales" />
          <Boxes title={L("المشتريات", "Purchases")} rows={d.purchases} testId="vat-purchases" />
          <div className="hr-tablewrap">
            <table className="hr-table is-dense" data-testid="vat-summary">
              <tbody>
                <tr><td className="hr-num">13</td><td>{L("إجمالي ضريبة القيمة المضافة المستحقة عن الفترة", "Total VAT due for the period")}</td><td className="num hr-num">{money(d.summary.totalVatDue)}</td></tr>
                <tr><td className="hr-num">14</td><td>{L("تصحيحات من فترات سابقة (لا يلتقطها النظام بعد)", "Corrections from previous periods (not captured yet)")}</td><td className="num hr-num">{money(d.summary.corrections)}</td></tr>
                <tr><td className="hr-num">15</td><td>{L("رصيد دائن مرحّل من فترات سابقة (لا يلتقطه النظام بعد)", "VAT credit carried forward (not captured yet)")}</td><td className="num hr-num">{money(d.summary.creditCarriedForward)}</td></tr>
                <tr className="is-total is-grand"><td className="hr-num">16</td><td>{L("صافي الضريبة المستحقة", "Net VAT due")}</td><td className="num hr-num">{money(d.summary.netVatDue)}</td></tr>
              </tbody>
            </table>
          </div>
          <section className="acct-card" data-testid="vat-reconciliation">
            <h2>{L("المطابقة: الإقرار ↔ الأستاذ العام ↔ الهيئة", "Reconciliation: return ↔ general ledger ↔ ZATCA")}</h2>
            <div className="hr-tablewrap">
              <table className="hr-table is-dense">
                <thead><tr><th /><th className="num">{L("المستندات المرحّلة", "Posted documents")}</th><th className="num">{L("الأستاذ من المستندات", "GL from documents")}</th><th className="num">{L("الفرق", "Difference")}</th><th className="num acct-hide-m">{L("غير مرحّلة", "Not posted")}</th><th className="num acct-hide-m">{L("قيود أخرى على الحساب", "Other GL entries")}</th></tr></thead>
                <tbody>
                  {(["output", "input"] as const).map((k) => (
                    <tr key={k} data-testid={`vat-recon-${k}`}>
                      <td>{k === "output" ? L("ضريبة المخرجات", "VAT output") : L("ضريبة المدخلات", "VAT input")}</td>
                      <td className="num hr-num">{money(rec[k].postedDocuments)}</td><td className="num hr-num">{money(rec[k].glFromDocuments)}</td>
                      <td className={`num hr-num ${rec[k].matched ? "acct-good" : "acct-bad"}`}>{money(rec[k].difference)}</td>
                      <td className="num hr-num acct-hide-m">{rec[k].unposted.count} · {money(rec[k].unposted.vat)}</td><td className="num hr-num acct-hide-m">{money(rec[k].glOther)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <dl className="acct-kv-grid" data-testid="vat-zatca">
              <div><dt>{L("معتمدة / مُبلّغ عنها لدى الهيئة", "Cleared / reported by ZATCA")}</dt><dd className="hr-num">{rec.zatca.accepted.count} · {money(rec.zatca.accepted.vat)}</dd></div>
              <div><dt>{L("بانتظار الإرسال أو متعثرة", "Pending or failed")}</dt><dd className="hr-num">{rec.zatca.pending.count} · {money(rec.zatca.pending.vat)}</dd></div>
              <div><dt>{L("مرفوضة", "Rejected")}</dt><dd className="hr-num">{rec.zatca.rejected.count} · {money(rec.zatca.rejected.vat)}</dd></div>
              <div><dt>{L("لم تُرسل للهيئة (الربط غير مفعّل)", "Not e-invoiced (integration off)")}</dt><dd className="hr-num">{rec.zatca.notEInvoiced.count} · {money(rec.zatca.notEInvoiced.vat)}</dd></div>
              <div><dt>{L("ضريبة الإقرار − ضريبة المعتمد لدى الهيئة", "Return VAT − ZATCA-accepted VAT")}</dt><dd className="hr-num">{money(rec.zatca.returnVsAccepted)}</dd></div>
              {rec.input.noSupplierVatNumber && rec.input.noSupplierVatNumber.count ? <div data-testid="vat-no-supplier-vat"><dt className="acct-warn">{L("ضريبة مدخلات من موردين بلا رقم ضريبي (استردادها معرّض للرفض)", "Input VAT from suppliers with no VAT number (claim at risk)")}</dt><dd className="hr-num acct-warn">{rec.input.noSupplierVatNumber.count} · {money(rec.input.noSupplierVatNumber.vat)}</dd></div> : null}
            </dl>
            <p className="acct-hint">{L("المستندات قبل تاريخ بدء المحاسبة لا تُرحَّل (تدخل في الأرصدة الافتتاحية)، و«قيود أخرى» تشمل قيود التسوية اليدوية وسداد الضريبة.", "Documents before the go-live date post nothing (they belong to the opening balances); «other GL entries» are manual adjustments and VAT settlements.")}</p>
          </section>
        </>
      )}
    </AcctShell>
  );
}

export default function TaxPage() {
  return <Suspense fallback={<OpsLoading />}><Tax /></Suspense>;
}
