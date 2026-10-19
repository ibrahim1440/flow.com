import { NextResponse } from "next/server";
import { requireModule } from "@/lib/auth-server";
import { handlePrismaError } from "@/lib/api-error";
import { finishedOverview, greenOverview, packagingOverview } from "@/lib/services/inventory-overview";

/**
 * GET /api/inventory/overview?section=green|packaging|finished — the derived inventory figures
 * (roast rate and coverage, packaging usage and packs coverable, units per SKU and unpacked roasted
 * coffee). Read-only, inventory module. Formulas: src/lib/inventory/metrics.ts.
 */
export async function GET(request: Request) {
  const { error } = await requireModule("inventory");
  if (error) return error;
  const section = new URL(request.url).searchParams.get("section");
  try {
    if (section === "green") return NextResponse.json(await greenOverview());
    if (section === "packaging") return NextResponse.json(await packagingOverview());
    if (section === "finished") return NextResponse.json(await finishedOverview());
    return NextResponse.json({ error: "section must be green, packaging or finished." }, { status: 400 });
  } catch (err) {
    return handlePrismaError(err);
  }
}
