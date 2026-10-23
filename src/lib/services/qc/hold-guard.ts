// QC station W3 — the ONE guard every path that consumes roasted coffee calls (owner decision 5:
// «A held batch cannot be shipped and cannot be issued to normal production»). A held batch (status
// "QC Hold", «محجوزة») is refused by:
//   · packing — POST/GET /api/roasting-batches/[id]/pack (preview and commit, the ERP and the W4
//     station, which calls the same route), /pack-sku and /package (legacy adapters);
//   · picking and handing off — the W4 lot match, picks and handoffs (lots packed from a held batch);
//   · delivering — POST /api/deliveries (lots packed from a held batch);
//   · reserving finished stock — the shelf / unit reservation candidates exclude such lots;
//   · normal production — attaching the batch to a production order, blending it (except by an
//     APPROVED blend disposition — the recipe), deleting / cancelling it (a disposition decides it).
// Statuses alone already keep a held batch off most of these lists; this guard makes the refusal
// explicit, coded (BATCH_QC_HOLD) and identical everywhere, and covers lots packed from it.
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { QC_HOLD_STATUS } from "@/lib/qc/spec";

type Db = PrismaClient | Prisma.TransactionClient;

export { QC_HOLD_STATUS };
export type HeldUse = "pack" | "pick" | "deliver" | "reserve" | "production" | "blend" | "delete";

const USE_AR: Record<HeldUse, string> = {
  pack: "لا تُعبّأ", pick: "لا تُجهّز للطلب", deliver: "لا تُشحن", reserve: "لا تُحجز لطلب", production: "لا تُصرف للإنتاج",
  blend: "لا تُخلط إلا بوصفة معتمدة", delete: "لا تُحذف؛ يُقرَّر التصرف فيها في الجودة",
};
const USE_EN: Record<HeldUse, string> = {
  pack: "it cannot be packed", pick: "it cannot be picked for an order", deliver: "it cannot be shipped", reserve: "it cannot be reserved for an order",
  production: "it cannot be issued to production", blend: "it is blended only by an approved recipe", delete: "it cannot be deleted; QC decides its disposition",
};

export const isHeldStatus = (status: string | null | undefined) => status === QC_HOLD_STATUS;

/** The refusal of one use of a held batch (thrown as a domain refusal: handleDomainError maps it). */
export function heldRefusal(batchNumber: string, use: HeldUse) {
  return {
    _appCode: 409,
    code: "BATCH_QC_HOLD",
    message: `الدفعة ${batchNumber} محجوزة بقرار الجودة: ${USE_AR[use]} حتى يُقرَّر التصرف فيها.`,
    errorEn: `Batch ${batchNumber} is on QC hold: ${USE_EN[use]} until its disposition is decided.`,
  };
}

/** Refuse when any of these batches is held. */
export function assertNotHeldRows(rows: { batchNumber: string; status: string }[], use: HeldUse): void {
  const held = rows.find((r) => isHeldStatus(r.status));
  if (held) throw heldRefusal(held.batchNumber, use);
}

export async function assertBatchesNotHeld(db: Db, batchIds: (string | null | undefined)[], use: HeldUse): Promise<void> {
  const ids = [...new Set(batchIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rows = await db.roastingBatch.findMany({ where: { id: { in: ids }, status: QC_HOLD_STATUS }, select: { batchNumber: true, status: true }, take: 1 });
  assertNotHeldRows(rows, use);
}

/**
 * Lots packed from a held batch (the legacy 1:1 roastingBatchId, the unit-tracked packedFromBatchId,
 * or any PackagingSource roast of the lot). In practice a held batch has no lots — it was held before
 * release — so this is the backstop for any path that would ship or pick one.
 */
export async function heldLotIds(db: Db, lotIds: (string | null | undefined)[]): Promise<Map<string, string>> {
  const ids = [...new Set(lotIds.filter((x): x is string => !!x))];
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const lots = await db.finishedGoodsLot.findMany({
    where: {
      id: { in: ids },
      OR: [
        { roastingBatch: { status: QC_HOLD_STATUS } },
        { packedFromBatch: { status: QC_HOLD_STATUS } },
        { sources: { some: { roastingBatch: { status: QC_HOLD_STATUS } } } },
      ],
    },
    select: { id: true, batchNumber: true },
  });
  for (const l of lots) out.set(l.id, l.batchNumber);
  return out;
}

export async function assertLotsNotHeld(db: Db, lotIds: (string | null | undefined)[], use: HeldUse): Promise<void> {
  const held = await heldLotIds(db, lotIds);
  const first = held.values().next();
  if (!first.done) throw heldRefusal(first.value, use);
}

/** Prisma filter: finished-goods lots NOT packed from a held batch (for candidate / availability reads). */
export const LOT_NOT_HELD: Prisma.FinishedGoodsLotWhereInput = {
  NOT: {
    OR: [
      { roastingBatch: { status: QC_HOLD_STATUS } },
      { packedFromBatch: { status: QC_HOLD_STATUS } },
    ],
  },
};
