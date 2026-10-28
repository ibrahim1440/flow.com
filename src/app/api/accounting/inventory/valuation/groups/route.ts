import { NextResponse } from "@/lib/api-response";
import { acctError, qp } from "@/lib/accounting/http";
import { requireCostRead, csvResponse } from "@/lib/accounting/ops/http";
import { valuationReport } from "@/lib/accounting/ops/valuation-report";
import { Decimal } from "@/lib/accounting/money";
import { hasModuleAccess } from "@/lib/auth-shared";

/**
 * «تقييم المخزون» by category and location (unified inventory phase 4). ?category=<root or sub id>&location=<id>.
 * CSV: one row per holder and location (the location value is an ESTIMATE: site qty × the company's average cost),
 * plus an UNALLOCATED row for what no site holds — so the rows add up to the company value. inventory › valuation or
 * the accounting module; the general-ledger comparison (balances, differences) for the accounting module only.
 */
export async function GET(request: Request) {
  const { user, error } = await requireCostRead();
  if (error) return error;
  try {
    // The general-ledger side only for the accounting module (inventory › valuation sees the cost ledger, as before).
    const r = await valuationReport({ category: qp(request, "category"), location: qp(request, "location"), withGl: hasModuleAccess(user.permissions, "accounting") });
    if (qp(request, "format") === "csv") {
      const cat = new Map(r.categoryOptions.map((c) => [c.id, c]));
      const loc = new Map(r.locations.map((l) => [l.id, l]));
      const out: (string | number | null)[][] = [];
      for (const x of r.rows) {
        const root = cat.get(x.rootId)?.nameAr ?? null, sub = x.rootId === x.categoryId ? null : x.categoryName;
        const base = [x.account?.code ?? null, x.account?.name ?? null, x.role, root, sub, x.kind, x.label, x.sub, x.unit];
        const sites = r.filters.location ? x.sites.filter((s) => s.locationId === r.filters.location) : x.sites;
        for (const s of sites) out.push([...base, loc.get(s.locationId)?.code ?? s.locationId, loc.get(s.locationId)?.nameAr ?? null, "SITE_ESTIMATE", s.qty, x.avgCost, s.value]);
        if (!r.filters.location) {
          const rest = new Decimal(x.value).minus(x.sites.reduce((a, s) => a.plus(s.value), new Decimal(0)));
          if (!rest.isZero()) out.push([...base, null, null, "UNALLOCATED", null, x.avgCost, rest.toFixed(2)]);
        }
      }
      return csvResponse(`inventory-valuation-${r.asOf}${r.filters.location ? `-${loc.get(r.filters.location)?.code ?? "site"}` : ""}`,
        ["account_code", "account", "inventory_role", "category", "sub_category", "kind", "item", "reference", "unit", "location_code", "location", "basis", "qty_at_location", "avg_cost", "value"], out);
    }
    return NextResponse.json(r);
  } catch (err) {
    return acctError(err);
  }
}
