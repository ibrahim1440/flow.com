import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { forbidden, requireAuth } from "@/lib/auth-server";
import { canCreateInvoices, canIssueInvoices, canSellAssets } from "@/lib/services/invoicing/access";
import { invError } from "@/lib/services/invoicing/refusals";
import { assetSaleTax } from "@/lib/services/invoicing/asset-sale";


/**
 * GET /api/sales/invoices/fixed-assets?q= — «بيع أصل ثابت», the line picker (BATCH 22 WP-F): ACTIVE / FULLY_DEPRECIATED assets
 * with no live disposal and no other open sale line (a draft, or an issued uncredited invoice), with the default tax
 * category. Who: accounting › fixed_assets with sales › invoices_create or invoices_issue (the line is accountant-only).
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;
  if (!canSellAssets(user.permissions) || !(canCreateInvoices(user.permissions) || canIssueInvoices(user.permissions))) return forbidden();
  try {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim().slice(0, 80);
    const rows = await prisma.fixedAsset.findMany({
      where: {
        status: { in: ["ACTIVE", "FULLY_DEPRECIATED"] }, disposals: { none: { status: "POSTED" } },
        ...(q ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }, { nameEn: { contains: q, mode: "insensitive" } }] } : {}),
      },
      orderBy: { code: "asc" }, take: 50,
      select: { id: true, code: true, nameAr: true, nameEn: true, cost: true, accumulatedDepreciation: true, branchId: true,
        category: { select: { code: true, nameAr: true, nameEn: true } },
        saleLines: { where: { kind: "FIXED_ASSET_SALE", invoice: { status: { in: ["DRAFT", "ISSUED"] } } }, select: { invoice: { select: { status: true } }, noteLines: { select: { invoice: { select: { kind: true, status: true } } } } } } },
    });
    const items = rows.filter((a) => !a.saleLines.some((l) => l.invoice.status === "DRAFT" || !l.noteLines.some((n) => n.invoice.kind === "CREDIT_NOTE" && n.invoice.status === "ISSUED"))).map((a) => {
      return {
        id: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, category: a.category, branchId: a.branchId,
        netBookValue: a.cost.minus(a.accumulatedDepreciation).toFixed(2),
        tax: assetSaleTax(a.category),
      };
    });
    return NextResponse.json({ items });
  } catch (err) {
    return invError(err);
  }
}
