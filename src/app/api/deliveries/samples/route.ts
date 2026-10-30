import { NextResponse } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { requireModule } from "@/lib/auth-server";
import { hasSubPrivilege, type Permissions } from "@/lib/auth-shared";
import { handleDomainError } from "@/lib/api-error";
import { availableUnitsBySku, packSizeLabel } from "@/lib/services/finished-products";
import { pendingSamples } from "@/lib/services/sales/sample-issue";

/**
 * GET /api/deliveries/samples — the dispatch screen's «عيّنات للصرف» queue (docs/sales/SAMPLES_INVENTORY.md).
 *
 * The stock samples reps have requested from their deals and nobody has issued yet (REQUESTED, PREPARING), oldest
 * first, each with the free units of its SKU at the production site — the same «free to promise» figure the issue
 * draws on (units reserved for orders and lots on QC hold excluded), so the dispatcher sees before pressing «صرف»
 * whether it can be covered. Advisory: the issue re-plans under the lot locks.
 *
 * Read gate: the dispatch module, like GET /api/deliveries. Every request is shown (the department serves every
 * rep), with the customer's name and the rep's — no contact detail, no deal value (owner policy F4). The cost is
 * not in this list at all; the issue's answer carries it only to holders of inventory › valuation.
 */
export async function GET() {
  const { user, error } = await requireModule("dispatch");
  if (error) return error;
  try {
    const rows = await pendingSamples(prisma);
    const skuIds = [...new Set(rows.map((r) => r.productSku?.id).filter((x): x is string => !!x))];
    const free = await prisma.$transaction((tx) => availableUnitsBySku(tx, skuIds, "promise"));
    return NextResponse.json({
      samples: rows.map((r) => ({
        id: r.id,
        status: r.status,
        units: Number(r.quantity),
        description: r.description,
        requestedAt: r.createdAt,
        sku: r.productSku ? { id: r.productSku.id, skuCode: r.productSku.skuCode, name: r.productSku.name, nameAr: r.productSku.nameAr, pack: packSizeLabel(r.productSku.weightGrams) } : null,
        customer: r.opportunity.customer ? { name: r.opportunity.customer.name, nameAr: r.opportunity.customer.nameAr } : null,
        rep: r.opportunity.owner?.name ?? null,
        freeUnits: r.productSku ? free.get(r.productSku.id)?.unitsFree ?? 0 : 0,
      })),
      can: { issue: hasSubPrivilege(user.permissions as Permissions, "dispatch", "mark_delivered") },
    });
  } catch (err) {
    return handleDomainError(err);
  }
}
