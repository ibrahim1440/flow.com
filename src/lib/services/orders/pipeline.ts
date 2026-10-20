import { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient;

/**
 * The orders board's pipeline (production simplification, Phase B — the prototype's «الطلبات»).
 *
 * Every order gets a stage on the four-step bar roast → QC → pack → delivery, computed from what
 * is physically true right now — nothing here is stored or typed by anybody:
 *
 *   line stage 4 «مكتمل»            delivered everything it ordered
 *              3 «جاهز للتسليم»     delivered + reserved covers it
 *              2 «بانتظار التعبئة»  a passed batch of its coffee still holds at least one package
 *              1 «في الجودة»        a batch of its coffee is waiting for QC
 *              0 «بانتظار التحميص»  otherwise
 *
 * The order's stage is its least advanced line; its label adds «جاهز جزئيًا» when some units are
 * already reserved and «سُلّم جزئيًا» once something has left. Cancelled and rejected orders have
 * no pipeline. Two queries for the whole list (reservations, live batches by coffee).
 */

export type PipelineKey =
  | "roast" | "qc" | "pack" | "ready" | "restReady" | "partReady" | "done";

export type OrderPipeline = {
  /** 0 roast · 1 QC · 2 pack · 3 deliver · 4 done */
  stage: number;
  key: PipelineKey;
  partDelivered: boolean;
  lines: { orderItemId: string; stage: number; reservedUnits: number | null }[];
};

type PipelineOrder = {
  id: string;
  status: string;
  items: {
    id: string;
    quantityUnits: number | null;
    deliveredUnits: number;
    quantityKg: number;
    deliveredQty: number;
    productId: string | null;
    productSku?: { productId: string; weightGrams: number } | null;
  }[];
};

const NO_PIPELINE = new Set(["Cancelled", "Rejected"]);

export async function orderPipelines(db: Db, orders: PipelineOrder[]): Promise<Map<string, OrderPipeline>> {
  const out = new Map<string, OrderPipeline>();
  const live = orders.filter((o) => !NO_PIPELINE.has(o.status));
  const lineIds = live.flatMap((o) => o.items.map((i) => i.id));
  if (lineIds.length === 0) return out;

  const reserved = await db.stockAllocation.groupBy({
    by: ["orderItemId"],
    where: { orderItemId: { in: lineIds }, status: "RESERVED" },
    _sum: { quantityUnits: true, quantityKg: true },
  });
  const resBy = new Map(reserved.map((r) => [r.orderItemId, { units: r._sum.quantityUnits ?? 0, kg: r._sum.quantityKg ?? 0 }]));

  const batches = await db.roastingBatch.findMany({
    where: { status: { in: ["Pending QC", "Passed", "Partially Packaged"] } },
    select: {
      status: true, roastedAvailableKg: true, productId: true,
      orderItem: { select: { productSku: { select: { productId: true } }, productId: true } },
      productionOrder: { select: { productSku: { select: { productId: true } } } },
    },
  });
  const inQc = new Set<string>();
  const packableKg = new Map<string, number>();
  for (const b of batches) {
    const pid = b.productId ?? b.orderItem?.productSku?.productId ?? b.orderItem?.productId ?? b.productionOrder?.productSku?.productId ?? null;
    if (!pid) continue;
    if (b.status === "Pending QC") inQc.add(pid);
    else packableKg.set(pid, Math.max(packableKg.get(pid) ?? 0, b.roastedAvailableKg ?? 0));
  }

  for (const o of live) {
    let anyReserved = false, anyDelivered = false, allCovered = true;
    const lines: OrderPipeline["lines"] = [];
    for (const i of o.items) {
      const r = resBy.get(i.id) ?? { units: 0, kg: 0 };
      const units = i.quantityUnits !== null;
      const qty = units ? i.quantityUnits! : i.quantityKg;
      const del = units ? i.deliveredUnits : i.deliveredQty;
      const res = units ? r.units : r.kg;
      if (res > 0) anyReserved = true;
      if (del > 0) anyDelivered = true;
      const eps = units ? 0 : 0.0005;
      let stage: number;
      if (del + eps >= qty) stage = 4;
      else if (del + res + eps >= qty) stage = 3;
      else {
        allCovered = false;
        const pid = i.productSku?.productId ?? i.productId;
        const unitKg = i.productSku ? i.productSku.weightGrams / 1000 : 0.001;
        if (pid && (packableKg.get(pid) ?? 0) + 1e-9 >= unitKg) stage = 2;
        else if (pid && inQc.has(pid)) stage = 1;
        else stage = 0;
      }
      lines.push({ orderItemId: i.id, stage, reservedUnits: units ? r.units : null });
    }
    const stage = lines.length ? Math.min(...lines.map((l) => l.stage)) : 0;
    let key: PipelineKey;
    if (o.status === "Completed" || stage === 4) key = "done";
    else if (allCovered) key = anyDelivered ? "restReady" : "ready";
    else if (anyReserved) key = "partReady";
    else key = (["roast", "qc", "pack", "ready"] as const)[Math.min(stage, 3)];
    out.set(o.id, {
      stage: o.status === "Completed" ? 4 : allCovered && stage < 4 ? 3 : stage,
      key,
      partDelivered: anyDelivered && key !== "done" && key !== "restReady",
      lines,
    });
  }
  return out;
}
