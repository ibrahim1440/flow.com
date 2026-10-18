/**
 * Server-side data resolution for printed labels. Every printed value comes from an ERP record
 * read here (A-5, B-7); nothing is accepted from the client except references.
 */
import { prisma } from "@/lib/db";
import { getCuppingSettings } from "@/lib/cupping/close-policy";
import { isoDay } from "../bidi";
import { cupResult, type ScoreIn } from "../cupping";
import type { CupData, LabelData, OriginData, Trace } from "../content";
import type { AttributeKey } from "../templates";

export class PrintRefusal extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

import { itemRef, type CupItemIn, type ItemIn, type OriginItemIn } from "../items";
export { itemRef, type CupItemIn, type ItemIn, type OriginItemIn };

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** Parses untrusted job items. Copies are validated by the layout engine. */
export function parseItems(raw: unknown, template: "COFFEE_ORIGIN" | "CUPPING_RESULTS"): ItemIn[] {
  if (!Array.isArray(raw)) throw new PrintRefusal(400, "ITEMS_REQUIRED", "items must be an array.");
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const copies = typeof o.copies === "number" ? o.copies : 1;
    if (template === "COFFEE_ORIGIN") {
      const productId = str(o.productId);
      if (!productId) throw new PrintRefusal(400, "ITEM_INVALID", `items[${i}].productId is required.`);
      return { kind: "product", productId, batchId: str(o.batchId), lotId: str(o.lotId), copies };
    }
    const sessionId = str(o.sessionId);
    if (!sessionId) throw new PrintRefusal(400, "ITEM_INVALID", `items[${i}].sessionId is required.`);
    return { kind: "cup", sessionId, cupId: str(o.cupId), copies };
  });
}


const NO_TRACE: Trace = { roastDate: null, batchNumber: null, lotRef: null };

async function resolveOrigin(items: OriginItemIn[]): Promise<OriginData[]> {
  const ids = [...new Set(items.map((i) => i.productId))];
  const products = await prisma.coffeeProduct.findMany({ where: { id: { in: ids } } });
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: OriginData[] = [];
  for (const it of items) {
    const p = byId.get(it.productId);
    if (!p) throw new PrintRefusal(404, "PRODUCT_NOT_FOUND", "A selected coffee no longer exists.", { productId: it.productId });
    let trace: Trace = NO_TRACE;
    if (it.lotId) {
      // B-7: only a lot of THIS coffee.
      const lot = await prisma.finishedGoodsLot.findFirst({
        where: { id: it.lotId, productId: p.id },
        include: { productSku: { select: { skuCode: true } }, packedFromBatch: { select: { id: true, date: true } }, roastingBatch: { select: { id: true, date: true } } },
      });
      if (!lot) throw new PrintRefusal(400, "LOT_NOT_RELATED", "The selected lot does not belong to this coffee.", { productId: p.id });
      const roast = lot.packedFromBatch ?? lot.roastingBatch;
      if (it.batchId && roast && roast.id !== it.batchId) throw new PrintRefusal(400, "LOT_BATCH_MISMATCH", "The selected lot was not packed from the selected batch.");
      trace = {
        roastDate: roast ? isoDay(roast.date) : null,
        batchNumber: lot.batchNumber || null,
        lotRef: [lot.productSku?.skuCode, isoDay(lot.createdAt)].filter(Boolean).join(" · ") || null,
      };
    } else if (it.batchId) {
      const b = await prisma.roastingBatch.findFirst({ where: { id: it.batchId, productId: p.id, status: { not: "Cancelled" } }, select: { batchNumber: true, date: true } });
      if (!b) throw new PrintRefusal(400, "BATCH_NOT_RELATED", "The selected batch does not belong to this coffee.", { productId: p.id });
      trace = { roastDate: isoDay(b.date), batchNumber: b.batchNumber || null, lotRef: null };
    }
    out.push({
      kind: "origin", ref: itemRef(it), productId: p.id,
      name: { en: p.productNameEn, ar: p.productNameAr },
      country: { en: p.countryEn, ar: p.countryAr }, region: { en: p.regionEn, ar: p.regionAr },
      variety: { en: p.varietyEn, ar: p.varietyAr }, process: { en: p.processEn, ar: p.processAr },
      altitude: p.altitude, cupNotes: { en: p.cupNotesEn, ar: p.cupNotesAr }, roastPath: { en: p.roastPathEn, ar: p.roastPathAr },
      trace,
    });
  }
  return out;
}

const BATCH_SELECT = {
  id: true, batchNumber: true, date: true,
  product: { select: { productNameEn: true, productNameAr: true } },
  greenBean: { select: { beanType: true, beanTypeAr: true } },
  orderItem: { select: { beanTypeName: true } },
} as const;

type BatchRow = { batchNumber: string; date: Date; product: { productNameEn: string; productNameAr: string | null } | null; greenBean: { beanType: string; beanTypeAr: string | null } | null; orderItem: { beanTypeName: string } | null } | null;

function batchName(b: BatchRow) {
  if (b?.product) return { en: b.product.productNameEn, ar: b.product.productNameAr };
  if (b?.greenBean) return { en: b.greenBean.beanType, ar: b.greenBean.beanTypeAr };
  if (b?.orderItem) return { en: b.orderItem.beanTypeName, ar: null };
  return { en: null, ar: null };
}

async function loadSession(id: string) {
  return prisma.cuppingSession.findUnique({
    where: { id },
    include: {
      batch: { select: BATCH_SELECT },
      greenBean: { select: { beanType: true, beanTypeAr: true } },
      sessionBatches: { orderBy: { order: "asc" }, include: { batch: { select: BATCH_SELECT } } },
      scores: { include: { employee: { select: { name: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
}

function toScoreIn(s: NonNullable<Awaited<ReturnType<typeof loadSession>>>["scores"][number]): ScoreIn {
  const attrs = {
    fragranceAroma: s.fragranceAroma, flavor: s.flavor, aftertaste: s.aftertaste, acidity: s.acidity, body: s.body,
    balance: s.balance, overall: s.overall, sweetness: s.sweetness, uniformity: s.uniformity, cleanCup: s.cleanCup,
  } satisfies Record<AttributeKey, number>;
  return {
    id: s.id, employeeId: s.employeeId, scorerName: s.employee?.name ?? s.externalName ?? null, sessionBatchId: s.sessionBatchId,
    finalScore: s.finalScore, attrs, notes: s.notes, descriptors: s.flavorDescriptors,
  };
}

async function resolveCups(items: CupItemIn[], named: boolean): Promise<CupData[]> {
  const settings = await getCuppingSettings();
  const cache = new Map<string, Awaited<ReturnType<typeof loadSession>>>();
  const out: CupData[] = [];
  for (const it of items) {
    if (!cache.has(it.sessionId)) cache.set(it.sessionId, await loadSession(it.sessionId));
    const s = cache.get(it.sessionId);
    if (!s) throw new PrintRefusal(404, "SESSION_NOT_FOUND", "A selected cupping session no longer exists.", { sessionId: it.sessionId });
    const cupIds = s.sessionBatches.map((b) => b.id);
    let cupNo: number | null = null;
    let name: { en: string | null; ar: string | null };
    let external = false;
    let batch: BatchRow = null;
    if (cupIds.length > 0) {
      const idx = s.sessionBatches.findIndex((b) => b.id === it.cupId);
      if (idx < 0) throw new PrintRefusal(400, "CUP_NOT_IN_SESSION", "The cup does not belong to this session.");
      const sb = s.sessionBatches[idx];
      cupNo = idx + 1;
      external = sb.isExternalSample;
      batch = sb.batch;
      name = external ? { en: sb.externalSampleName, ar: sb.externalSampleName } : batchName(sb.batch);
    } else {
      if (it.cupId) throw new PrintRefusal(400, "CUP_NOT_IN_SESSION", "This session has no cups.");
      batch = s.batch;
      name = s.batch ? batchName(s.batch) : s.greenBean ? { en: s.greenBean.beanType, ar: s.greenBean.beanTypeAr } : { en: s.name, ar: s.name };
    }
    // Owner decision 2.2: guest evaluations never reach a label — not in averages, notes or the
    // payload. Decision 2.1: scorer names leave the server only for an authorized named job.
    const scores = s.scores.filter((x) => x.employeeId !== null).map(toScoreIn).map((x) => (named ? x : { ...x, scorerName: null }));
    const result = cupResult({ status: s.status, closeKind: s.closeKind, minScorersAtClose: s.minScorersAtClose, scorersAtClose: s.scorersAtClose, cupIds }, scores, cupIds.length ? it.cupId : null, settings.minScorers);
    out.push({
      kind: "cup", ref: itemRef(it), sessionId: s.id, cupId: it.cupId, cupNo, name, external,
      session: { name: s.name, date: isoDay(s.date) },
      result,
      trace: batch ? { roastDate: isoDay(batch.date), batchNumber: batch.batchNumber || null, lotRef: null } : NO_TRACE,
    });
  }
  return out;
}

export async function resolveItems(template: "COFFEE_ORIGIN" | "CUPPING_RESULTS", items: ItemIn[], named = false): Promise<LabelData[]> {
  return template === "COFFEE_ORIGIN"
    ? resolveOrigin(items.filter((i): i is OriginItemIn => i.kind === "product"))
    : resolveCups(items.filter((i): i is CupItemIn => i.kind === "cup"), named);
}

/** B-7 selector: batches and lots of ONE coffee only, newest first, optionally filtered. */
export async function relatedRecords(productId: string, q: string | null) {
  const product = await prisma.coffeeProduct.findUnique({ where: { id: productId }, select: { id: true } });
  if (!product) throw new PrintRefusal(404, "PRODUCT_NOT_FOUND", "Coffee not found.");
  const contains = q ? { contains: q, mode: "insensitive" as const } : undefined;
  const [batches, lots] = await Promise.all([
    prisma.roastingBatch.findMany({
      where: { productId, status: { not: "Cancelled" }, ...(contains ? { batchNumber: contains } : {}) },
      select: { id: true, batchNumber: true, date: true, status: true },
      orderBy: { date: "desc" }, take: 50,
    }),
    prisma.finishedGoodsLot.findMany({
      where: { productId, ...(contains ? { batchNumber: contains } : {}) },
      select: { id: true, batchNumber: true, createdAt: true, productSku: { select: { skuCode: true } }, packedFromBatchId: true, roastingBatchId: true, packedFromBatch: { select: { date: true } }, roastingBatch: { select: { date: true } } },
      orderBy: { createdAt: "desc" }, take: 50,
    }),
  ]);
  return {
    batches: batches.map((b) => ({ id: b.id, batchNumber: b.batchNumber, roastDate: isoDay(b.date), status: b.status })),
    lots: lots.map((l) => ({
      id: l.id, batchNumber: l.batchNumber, packedDate: isoDay(l.createdAt), skuCode: l.productSku?.skuCode ?? null,
      batchId: l.packedFromBatchId ?? l.roastingBatchId, roastDate: isoDay((l.packedFromBatch ?? l.roastingBatch)?.date ?? null),
    })),
  };
}

/** The job cap (administrator setting, default 200). */
export async function getPrintSettings() {
  return prisma.printSettings.upsert({ where: { id: "singleton" }, create: { id: "singleton", maxLabelsPerJob: 200 }, update: {} });
}
