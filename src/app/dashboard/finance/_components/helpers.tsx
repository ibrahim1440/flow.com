"use client";

import { useL } from "./ui";

export type OverviewAlert = { kind: string; severity: "high" | "medium" | "low"; message: string; data?: Record<string, unknown> };

const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (month: string, lang: string) => (lang === "ar" ? MONTHS_AR : MONTHS_EN)[Number(month.slice(5, 7)) - 1];
export const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

export function useAlertText() {
  const { L, money, pct, name } = useL();
  return (a: OverviewAlert) => {
    const d = (a.data ?? {}) as Record<string, never>;
    switch (a.kind) {
      case "UNFUNDED_OBLIGATION": return [L(`${d.description} — ${money(d.unfunded)} ر.س غير ممول`, `${d.description} — SAR ${money(d.unfunded)} unfunded`), L(`يستحق ${d.dueDate} · ${Number(d.days) < 0 ? "متأخر" : `بعد ${d.days} أيام`}`, `Due ${d.dueDate} · ${Number(d.days) < 0 ? "overdue" : `in ${d.days} days`}`)];
      case "CASH_SHORTFALL": return [L(`يتحول النقد المتوقع إلى سالب في الأسبوع ${d.week} (${d.start})`, `Projected cash turns negative in week ${d.week} (${d.start})`), L("التوقع النقدي", "Cash forecast")];
      case "CASH_SHORTFALL_CONSERVATIVE": return [L(`في السيناريو المتحفظ يتحول النقد إلى سالب في الأسبوع ${d.week}`, `In the conservative scenario cash turns negative in week ${d.week}`), L("التوقع النقدي", "Cash forecast")];
      case "UNCLASSIFIED": return [L(`${d.count} سطر بنكي بانتظار المراجعة والتصنيف`, `${d.count} bank lines awaiting review and classification`), L("المعاملات والتسوية", "Transactions & Reconciliation")];
      case "RECONCILIATION_OVERDUE": return [L(`${d.code} — ${name({ nameAr: d.nameAr, nameEn: d.nameEn })}: ${d.last ? `آخر تسوية ${d.last}` : "لم تتم تسويته مطلقاً"}`, `${d.code} — ${name({ nameAr: d.nameAr, nameEn: d.nameEn })}: ${d.last ? `last reconciled ${d.last}` : "never reconciled"}`), L("التسوية متأخرة", "Reconciliation overdue")];
      case "OVER_ALLOCATED": return [L(`التخصيصات تتجاوز النقد المؤهل بمبلغ ${money(d.over)} ر.س`, `Allocations exceed eligible cash by SAR ${money(d.over)}`), L("تخصيص النقد", "Cash Allocation")];
      case "COLLECTION_REVERSED": return [L(`تحصيل مبيعات مرتبط بإيصال عُكس في المبيعات (${money(d.amount)} ر.س) — راجع الإيصال`, `A linked sales collection was reversed in Sales (SAR ${money(d.amount)}) — review the receipt`), L("المعاملات والتسوية", "Transactions & Reconciliation")];
      case "NEGATIVE_CATEGORY": return [L(`${d.count} فئة برصيد سالب بعد عكس إيصال — صُرفت الأموال مسبقاً`, `${d.count} categories are negative after a reversal — funds were already spent`), L("تخصيص النقد", "Cash Allocation")];
      case "BUDGET_VARIANCE": {
        const nm = name({ nameAr: d.nameAr, nameEn: d.nameEn });
        const st = d.state === "OVERRUN" ? L("تجاوز", "overrun") : d.state === "SHORTFALL" ? L("نقص", "shortfall") : L("انحراف", "variance");
        return [L(`${nm}: ${st} ${money(Math.abs(Number(d.variance)))} ر.س حتى تاريخه (${pct(d.percentBp)})`, `${nm}: ${st} SAR ${money(Math.abs(Number(d.variance)))} to date (${pct(d.percentBp)})`), L("الميزانية الشهرية", "Monthly Budget")];
      }
      default: return [a.message, ""];
    }
  };
}

