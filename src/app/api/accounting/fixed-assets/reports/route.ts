import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireFaRead } from "@/lib/accounting/fixed-assets/http";
import { csvResponse } from "@/lib/accounting/ops/http";
import { parseBusinessDay, riyadhDay, dayText } from "@/lib/accounting/dates";
import { register, depreciationSchedule, rollForward } from "@/lib/accounting/fixed-assets/reports";

const d = (v: string | null, fallback: Date) => { try { return v ? parseBusinessDay(v) : fallback; } catch { return fallback; } };

/**
 * «تقارير الأصول الثابتة» — ?report=register (&asOf) | schedule (&year) | rollforward (&from&to); &format=csv for a download.
 */
export async function GET(request: Request) {
  const { error } = await requireFaRead();
  if (error) return error;
  try {
    const kind = qp(request, "report") ?? "register";
    const csv = qp(request, "format") === "csv";
    const today = riyadhDay();
    if (kind === "schedule") {
      const y = Number(qp(request, "year")) || today.getUTCFullYear();
      const r = await depreciationSchedule(y);
      if (csv) return csvResponse(`fixed-assets-schedule-${y}`, ["code", "name", "category", ...Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`), "total"], r.rows.map((x) => [x.code, x.nameAr, x.category.nameAr, ...x.months, x.total]));
      return NextResponse.json(r);
    }
    if (kind === "rollforward") {
      const to = d(qp(request, "to"), today), from = d(qp(request, "from"), new Date(Date.UTC(to.getUTCFullYear(), 0, 1)));
      const r = await rollForward(from, to);
      if (csv) return csvResponse(`fixed-assets-rollforward-${dayText(from)}-${dayText(to)}`, ["category", "cost_opening", "cost_additions", "cost_carried_in", "cost_disposals", "cost_closing", "accum_opening", "accum_depreciation", "accum_carried_in", "accum_disposals", "accum_closing", "nbv_opening", "nbv_closing"],
        r.rows.map((x) => [x.nameAr, x.cost.opening, x.cost.additions, x.cost.carriedIn, x.cost.disposals, x.cost.closing, x.accumulated.opening, x.accumulated.depreciation, x.accumulated.carriedIn, x.accumulated.disposals, x.accumulated.closing, x.netBookValue.opening, x.netBookValue.closing]));
      return NextResponse.json(r);
    }
    const asOf = d(qp(request, "asOf"), today);
    const r = await register(asOf);
    if (csv) return csvResponse(`fixed-assets-register-${dayText(asOf)}`, ["code", "name", "category", "branch", "in_service", "life_months", "method", "cost", "accumulated", "net_book_value", "status"], r.rows.map((x) => [x.code, x.nameAr, x.category.nameAr, x.branch?.nameAr ?? x.branch?.nameEn ?? "", x.inServiceDate, x.usefulLifeMonths, x.method, x.cost, x.accumulated, x.netBookValue, x.status]));
    return NextResponse.json(r);
  } catch (err) {
    return acctError(err);
  }
}
