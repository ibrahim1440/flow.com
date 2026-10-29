"use client";

// «تقارير الأصول الثابتة» — the register as of a day, the year's depreciation schedule (recorded vs projected), and
// the roll-forward with its tie-out to the general ledger. Every figure comes from the sub-ledger (the API).
import { useState } from "react";
import { OpsLoading } from "@/components/ops/ui";
import { Section } from "@/components/chrome";
import { Msg, money, todayRiyadh, useApi, useLang } from "../../_ui/shell";
import { Money, Tag, FA_STATUS, nameOf, MONTHS_AR, MONTHS_EN } from "./fa";

type Reg = { asOf: string; rows: { id: string; code: string; nameAr: string; nameEn: string | null; category: { nameAr: string; nameEn: string | null }; branch: { nameAr: string | null; nameEn: string } | null; inServiceDate: string | null; cost: string; accumulated: string; netBookValue: string; status: string }[];
  byCategory: { categoryId: string; nameAr: string; nameEn: string | null; count: number; cost: string; accumulated: string; netBookValue: string }[]; totals: { count: number; cost: string; accumulated: string; netBookValue: string };
  zakat: { deductibleNetBookValue: string; notDeductibleNetBookValue: string; notDeductibleCount: number; label: { ar: string; en: string }; note: { ar: string; en: string } } };
type Sched = { year: number; rows: { id: string; code: string; nameAr: string; nameEn: string | null; months: string[]; projected: boolean[]; total: string }[]; monthTotals: string[]; total: string };
type B = Record<"opening" | "additions" | "carriedIn" | "disposals" | "depreciation" | "closing", string>;
type Roll = { from: string; to: string; rows: { categoryId: string; nameAr: string; nameEn: string | null; cost: B; accumulated: B; netBookValue: { opening: string; closing: string } }[];
  totals: { cost: B; accumulated: B; netBookValue: { opening: string; closing: string } }; tieOut: { accountId: string; code: string; name: string; slot: string; register: string; gl: string; difference: string; notInBooks: string; unexplained: string; status: string }[]; tiesToGl: boolean };

const TIE: Record<string, [string, string, string]> = { MATCHED: ["مطابق", "Matched", "success"], EXPLAINED: ["مفسَّر (غير مرحّل بعد)", "Explained (not in the books yet)", "warning"], UNEXPLAINED: ["فرق غير مفسَّر", "Unexplained", "danger"] };

export function Reports() {
  const { L, ar } = useLang();
  const [tab, setTab] = useState<"register" | "schedule" | "rollforward">("register");
  const today = todayRiyadh();
  const [asOf, setAsOf] = useState(today);
  const [year, setYear] = useState(today.slice(0, 4));
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const q = tab === "register" ? `report=register&asOf=${asOf}` : tab === "schedule" ? `report=schedule&year=${year}` : `report=rollforward&from=${from}&to=${to}`;
  const r = useApi<Reg | Sched | Roll>(`/api/accounting/fixed-assets/reports?${q}`);
  const reg = r.data as Reg, sch = r.data as Sched, rol = r.data as Roll;
  return (
    <>
      <div className="acct-row">
        <div className="acct-seg" role="group" aria-label={L("التقرير", "Report")}>
          {([["register", "سجل الأصول", "Register"], ["schedule", "جدول الإهلاك", "Depreciation schedule"], ["rollforward", "حركة الأصول والمطابقة", "Roll-forward & tie-out"]] as const).map(([k, a, e]) =>
            <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)} data-testid={`farep-${k}`}>{L(a, e)}</button>)}
        </div>
        {tab === "register" ? <label className="hr-field"><span className="hr-label">{L("كما في", "As of")}</span><input type="date" className="hr-input" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label> : null}
        {tab === "schedule" ? <label className="hr-field"><span className="hr-label">{L("السنة", "Year")}</span><input className="hr-input" dir="ltr" inputMode="numeric" style={{ width: 90 }} value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label> : null}
        {tab === "rollforward" ? <><label className="hr-field"><span className="hr-label">{L("من", "From")}</span><input type="date" className="hr-input" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="hr-field"><span className="hr-label">{L("إلى", "To")}</span><input type="date" className="hr-input" value={to} onChange={(e) => setTo(e.target.value)} /></label></> : null}
        <a className="hr-btn" href={`/api/accounting/fixed-assets/reports?${q}&format=csv`}>{L("تصدير CSV", "Export CSV")}</a>
      </div>
      <Msg error={r.error} />
      {!r.data || r.loading ? <OpsLoading /> : tab === "register" ? ((d: Reg) => (
        <>
          <Section title={L(`سجل الأصول الثابتة كما في ${d.asOf}`, `Fixed-asset register as of ${d.asOf}`)} className="is-flush" testId="farep-register">
            <div className="hr-tablewrap"><table className="hr-table is-dense">
              <thead><tr><th>{L("الرمز", "Code")}</th><th>{L("الاسم", "Name")}</th><th className="acct-hide-m">{L("التصنيف", "Category")}</th><th className="acct-hide-m">{L("بدء الاستخدام", "In service")}</th><th className="num">{L("التكلفة", "Cost")}</th><th className="num">{L("مجمع الإهلاك", "Accumulated")}</th><th className="num">{L("صافي القيمة", "NBV")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
              <tbody>
                {d.rows.length === 0 ? <tr><td colSpan={8} className="acct-hint">{L("لا أصول في السجل في هذا التاريخ.", "No assets in the register on this day.")}</td></tr> : d.rows.map((x) => (
                  <tr key={x.id}><td className="acct-code">{x.code}</td><td>{ar ? x.nameAr : x.nameEn || x.nameAr}</td><td className="acct-hide-m">{nameOf(x.category, ar)}</td><td className="acct-hide-m"><bdi>{x.inServiceDate}</bdi></td>
                    <td className="num"><Money v={x.cost} /></td><td className="num"><Money v={x.accumulated} /></td><td className="num"><Money v={x.netBookValue} strong /></td><td><Tag map={FA_STATUS} value={x.status} /></td></tr>
                ))}
                {d.byCategory.map((c) => <tr key={c.categoryId} className="is-sub"><td colSpan={4}>{nameOf(c, ar)} ({c.count})</td><td className="num"><Money v={c.cost} /></td><td className="num"><Money v={c.accumulated} /></td><td className="num"><Money v={c.netBookValue} /></td><td /></tr>)}
                <tr className="is-total"><td colSpan={4}>{L("الإجمالي (الأصول القائمة)", "Total (assets held)")}</td><td className="num"><Money v={d.totals.cost} /></td><td className="num"><Money v={d.totals.accumulated} /></td><td className="num"><Money v={d.totals.netBookValue} strong /></td><td /></tr>
              </tbody>
            </table></div>
          </Section>
          <div className="fa-zakat" data-testid="farep-zakat">
            <div><span>{L("صافي القيمة الدفترية المحسومة من وعاء الزكاة (تقدير)", "Net book value deducted from the Zakat base (indicative)")}</span> <strong className="hr-num"><bdi>{money(d.zakat.deductibleNetBookValue)}</bdi></strong> {L("ر.س", "SAR")}</div>
            {d.zakat.notDeductibleCount ? <div><span>{L(`غير مخصوم من وعاء الزكاة (${d.zakat.notDeductibleCount} أصل)`, `Not deducted from the Zakat base (${d.zakat.notDeductibleCount} assets)`)}</span> <strong className="hr-num"><bdi>{money(d.zakat.notDeductibleNetBookValue)}</bdi></strong> {L("ر.س", "SAR")}</div> : null}
            <div className="acct-warn" data-testid="farep-zakat-label">{L(d.zakat.label.ar, d.zakat.label.en)}</div>
          </div>
        </>
      ))(reg) : tab === "schedule" ? ((d: Sched) => (
        <Section title={L(`جدول الإهلاك ${d.year}`, `Depreciation schedule ${d.year}`)} className="is-flush" testId="farep-schedule">
          <div className="hr-tablewrap"><table className="hr-table is-dense fa-sched">
            <thead><tr><th>{L("الأصل", "Asset")}</th>{MONTHS_AR.map((m, i) => <th key={i} className="num">{L(m, MONTHS_EN[i].slice(0, 3))}</th>)}<th className="num">{L("الإجمالي", "Total")}</th></tr></thead>
            <tbody>
              {d.rows.length === 0 ? <tr><td colSpan={14} className="acct-hint">{L("لا إهلاك لهذه السنة.", "No depreciation this year.")}</td></tr> : d.rows.map((x) => (
                <tr key={x.id}><td><span className="acct-code">{x.code}</span> {ar ? x.nameAr : x.nameEn || x.nameAr}</td>{x.months.map((v, i) => <td key={i} className={`num${x.projected[i] ? " is-proj" : ""}`} title={x.projected[i] ? L("متوقع (لم يُرحَّل)", "Projected (not run)") : undefined}>{Number(v) ? money(v) : ""}</td>)}<td className="num"><Money v={x.total} strong /></td></tr>
              ))}
              <tr className="is-total"><td>{L("الإجمالي", "Total")}</td>{d.monthTotals.map((v, i) => <td key={i} className="num">{Number(v) ? money(v) : ""}</td>)}<td className="num"><Money v={d.total} strong /></td></tr>
            </tbody>
          </table></div>
          <p className="acct-hint" style={{ padding: "8px 16px" }}>{L("المائل: متوقع لم يُرحَّل بعد (يُحسب يوميًا من تاريخ بدء الاستخدام).", "Italic: projected, not run yet (daily pro-rata from the in-service date).")}</p>
        </Section>
      ))(sch) : ((d: Roll) => (
        <>
          <Section title={L(`حركة الأصول الثابتة ${d.from} — ${d.to}`, `Fixed-asset roll-forward ${d.from} — ${d.to}`)} className="is-flush" testId="farep-rollforward">
            <div className="hr-tablewrap"><table className="hr-table is-dense">
              <thead><tr><th>{L("التصنيف", "Category")}</th><th className="num">{L("التكلفة أول المدة", "Cost, opening")}</th><th className="num">{L("الإضافات", "Additions")}</th><th className="num">{L("المرحّل عند البدء", "Carried in")}</th><th className="num">{L("الاستبعادات", "Disposals")}</th><th className="num">{L("التكلفة آخر المدة", "Cost, closing")}</th>
                <th className="num">{L("المجمع أول المدة", "Accum., opening")}</th><th className="num">{L("إهلاك الفترة", "Depreciation")}</th><th className="num">{L("مجمع المستبعد", "On disposals")}</th><th className="num">{L("المجمع آخر المدة", "Accum., closing")}</th><th className="num">{L("صافي القيمة آخر المدة", "NBV, closing")}</th></tr></thead>
              <tbody>
                {[...d.rows.map((x) => ({ key: x.categoryId, label: nameOf(x, ar), c: x.cost, a: x.accumulated, n: x.netBookValue, total: false })), { key: "t", label: L("الإجمالي", "Total"), c: d.totals.cost, a: d.totals.accumulated, n: d.totals.netBookValue, total: true }].map((x) => (
                  <tr key={x.key} className={x.total ? "is-total" : undefined}><td>{x.label}</td>
                    <td className="num"><Money v={x.c.opening} /></td><td className="num"><Money v={x.c.additions} /></td><td className="num"><Money v={x.c.carriedIn} /></td><td className="num"><Money v={x.c.disposals} /></td><td className="num"><Money v={x.c.closing} strong /></td>
                    <td className="num"><Money v={x.a.opening} /></td><td className="num"><Money v={x.a.depreciation} /></td><td className="num"><Money v={x.a.disposals} /></td><td className="num"><Money v={x.a.closing} strong /></td><td className="num"><Money v={x.n.closing} strong /></td></tr>
                ))}
              </tbody>
            </table></div>
          </Section>
          <Section title={L("المطابقة مع دفتر الأستاذ", "Tie-out to the general ledger")} tone="mid" className="is-flush" testId="farep-tieout"
            actions={<Tag map={TIE} value={d.tiesToGl ? (d.tieOut.every((t) => t.status === "MATCHED") ? "MATCHED" : "EXPLAINED") : "UNEXPLAINED"} />}>
            <div className="hr-tablewrap"><table className="hr-table is-dense">
              <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{L("السجل", "Register")}</th><th className="num">{L("دفتر الأستاذ", "Ledger")}</th><th className="num">{L("الفرق", "Difference")}</th><th className="num acct-hide-m">{L("غير مرحّل بعد", "Not in the books yet")}</th><th>{L("الحالة", "Status")}</th></tr></thead>
              <tbody>{d.tieOut.map((t) => <tr key={t.accountId}><td><span className="acct-code">{t.code}</span> {t.name}</td><td className="num"><Money v={t.register} /></td><td className="num"><Money v={t.gl} /></td><td className="num"><Money v={t.difference} /></td><td className="num acct-hide-m"><Money v={t.notInBooks} /></td><td><Tag map={TIE} value={t.status} /></td></tr>)}</tbody>
            </table></div>
          </Section>
        </>
      ))(rol)}
    </>
  );
}
